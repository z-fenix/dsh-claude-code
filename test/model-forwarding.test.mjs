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

// 宿主在创建 agent 时把模型路由随 agentOptions 传下来（dsh-api-session-controller 的
// agentOptions()，取 agentDefaultModel 的进程默认值 → agent.options）。会话内没选过模型
// （没有 model/selection 事件，真正切换才写）时，这个值就是前端选择器显示的那个；
// 插件若只认会话事件，SDK 收不到模型，CLI 就用自己的默认模型计费，出现「选择器显示 A、
// 实际按 B 计费」（隔离环境实测：界面 deepseek-flash，request/header 记为
// ccs-claude-openai--gpt-6.1-sol[1m]）。
test("会话内没选过模型 → 用宿主解析给 agent 的模型，前端选择与实际请求一致", async () => {
  capturedOptions = [];
  await run([ev("sandbox/mode", { mode: "workspace-write" })],
    { agent: { id: "a1", status: "running", options: { provider: "local", model: "ccs-claude-deepseek--deepseek-flash" } } });
  assert.equal(capturedOptions[0].model, "ccs-claude-deepseek--deepseek-flash");
});

test("会话里选过模型时仍以会话选择为准（覆盖宿主的默认路由）", async () => {
  capturedOptions = [];
  await run([ev("model/selection", { provider: "local", model: "m-session", reasoningEffort: "max" })],
    { agent: { id: "a1", status: "running", options: { provider: "local", model: "m-default" } } });
  assert.equal(capturedOptions[0].model, "m-session");
  assert.equal(capturedOptions[0].effort, "max");
});

test("宿主的模型不是非空字符串时不透传（不给 CLI 发空串/类型错误）", async () => {
  for (const model of [undefined, "", 42, { name: "m" }]) {
    capturedOptions = [];
    await run([ev("sandbox/mode", { mode: "workspace-write" })],
      { agent: { id: "a1", status: "running", options: { provider: "local", model } } });
    assert.equal(capturedOptions[0].model, undefined, `model=${JSON.stringify(model)} 不应透传`);
  }
});
