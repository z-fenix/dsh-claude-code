// test/goal-run.test.mjs — runClaudeCode 对 goal 桥接的 options 组装。
import { test, mock } from "node:test";
import assert from "node:assert/strict";

let capturedOptions = [];
mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    query: ({ options }) => { capturedOptions.push(options); return (async function* empty() {})(); },
    createSdkMcpServer: (opts) => opts,
    tool: (name, description, inputSchema, handler) => ({ name, description, inputSchema, handler }),
  },
});
const { runClaudeCode } = await import("../lib/claude-run.mjs");

const ev = (type, data) => ({ type, data, seq: 0 });
const session = {
  id: "s1", append() {}, requestContext: () => undefined, requestHeader: () => undefined,
  snapshotEvents: () => [ev("sandbox/mode", { mode: "workspace-write" }), ev("approval/policy", { policy: "ask" })],
};
const goalStub = { get: () => undefined };
const ctxWithGoals = { get: (k) => (k === "goals" ? goalStub : undefined), logger: { warn() {}, info() {} } };
const ctxNoGoals = { get: () => undefined, logger: { warn() {}, info() {} } };
const base = {
  session, agent: { id: "a1", status: "running" }, turn: 1, prompt: "hi",
  signal: new AbortController().signal, cwd: "/w", executable: "claude", env: {},
  turnContext: () => ({ hasHumanMessage: true }),
};

test("goal 开启且有 goals 服务 → options 含 mcpServers.goal 与 systemPrompt.append", async () => {
  capturedOptions = [];
  await runClaudeCode({ ctx: ctxWithGoals, config: {}, ...base });
  const options = capturedOptions[0];
  assert.equal(options.mcpServers.goal.name, "goal");
  assert.equal(options.mcpServers.goal.tools.length, 3);
  assert.equal(options.systemPrompt.type, "preset");
  assert.match(options.systemPrompt.append, /consecutive goal rounds/);
});

test("goal.enabled=false → 不挂 mcpServers / systemPrompt", async () => {
  capturedOptions = [];
  await runClaudeCode({ ctx: ctxWithGoals, config: { goal: { enabled: false } }, ...base });
  assert.equal(capturedOptions[0].mcpServers, undefined);
  assert.equal(capturedOptions[0].systemPrompt, undefined);
});

test("无 goals 服务 → 不挂 mcpServers / systemPrompt", async () => {
  capturedOptions = [];
  await runClaudeCode({ ctx: ctxNoGoals, config: {}, ...base });
  assert.equal(capturedOptions[0].mcpServers, undefined);
  assert.equal(capturedOptions[0].systemPrompt, undefined);
});
