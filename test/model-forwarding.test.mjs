// test/model-forwarding.test.mjs — 会话里选中的模型/推理档位必须真正生效。
//
// 背景：Claude Code 模式下模型来自 CLI 自己的配置（env / settings），DSH 前端选的模型
// 从来没有传到子进程，用户在会话里换模型等于没换。这里锁定「把 model/selection 透传给 SDK」。
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 私有事实库默认落在用户真实的 `~/.dsh/dsh-claude-code`；测试必须在 import 之前改写根目录，
// 否则会用 id "s1" 往真实库里写锚点，污染后续真实读写（见 goal-run.test.mjs 的同类修复）。
process.env.DSH_CLAUDE_CODE_STORE = mkdtempSync(join(tmpdir(), "dsh-cc-model-forward-"));

let capturedOptions = [];
mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    query: ({ options }) => { capturedOptions.push(options); return (async function* empty() {})(); },
    createSdkMcpServer: (opts) => opts,
    tool: (name, description, inputSchema, handler) => ({ name, description, inputSchema, handler }),
  },
});
const { runClaudeCode } = await import("../lib/claude-run.mjs");
const { foldModelSelection } = await import("../lib/session-events.mjs");

const ev = (type, data) => ({ type, data, seq: 0 });
let sessionSeq = 0;
// 私有事实库按 session id 落盘并校验锚点，所以每个用例必须用**不同的会话 id**：
// 同一个 id 配到不同事件上会被判成「session anchor does not match」。
const sessionWith = (events) => ({
  id: `s${++sessionSeq}`, append() {}, requestContext: () => undefined, requestHeader: () => undefined,
  snapshotEvents: () => events,
});
const ctx = { get: () => undefined, logger: { warn() {}, info() {} } };
const run = (events, extra = {}) => runClaudeCode({
  ctx, config: {}, session: sessionWith(events), agent: { id: "a1", status: "running" },
  turn: 1, prompt: "hi", signal: new AbortController().signal, cwd: "/w", executable: "claude", env: {}, ...extra,
});

test("foldModelSelection：最后一条 model/selection 生效，字段原样保留", () => {
  assert.equal(foldModelSelection([]), undefined);
  assert.deepEqual(
    foldModelSelection([
      ev("model/selection", { provider: "local", model: "old-model" }),
      ev("model/selection", { provider: "local", model: "ccs-claude-deepseek--deepseek-flash[1M]", reasoningEffort: "max" }),
    ]),
    { provider: "local", model: "ccs-claude-deepseek--deepseek-flash[1M]", reasoningEffort: "max" },
  );
});

test("会话选过模型 → 透传给 SDK，用户的模型选择真正生效", async () => {
  capturedOptions = [];
  await run([ev("model/selection", { provider: "local", model: "ccs-claude-deepseek--deepseek-flash[1M]", reasoningEffort: "max" })]);
  assert.equal(capturedOptions[0].model, "ccs-claude-deepseek--deepseek-flash[1M]");
  assert.equal(capturedOptions[0].effort, "max");
});

test("没选过模型 → 不写 model/effort，沿用 CLI 默认", async () => {
  capturedOptions = [];
  await run([ev("sandbox/mode", { mode: "workspace-write" })]);
  assert.equal(capturedOptions[0].model, undefined);
  assert.equal(capturedOptions[0].effort, undefined);
});

test("未知的 reasoningEffort 不透传（不猜 SDK 不认识的档位）", async () => {
  capturedOptions = [];
  await run([ev("model/selection", { provider: "local", model: "m", reasoningEffort: "turbo" })]);
  assert.equal(capturedOptions[0].model, "m");
  assert.equal(capturedOptions[0].effort, undefined);
});

test("空 model 的选择不采信（不把空串当模型名发给 CLI）", async () => {
  assert.equal(foldModelSelection([ev("model/selection", { provider: "local", model: "" })]), undefined);
  capturedOptions = [];
  await run([ev("model/selection", { provider: "local", model: "" })]);
  assert.equal(capturedOptions[0].model, undefined);
});
