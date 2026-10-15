// test/fork-inheritance.test.mjs — DSH 的 fork 会话要继承父的 Claude 模型历史。
//
// 机制（已实测）：`resume: <父 Claude 会话 id>` + `forkSession: true` 让 CLI 把父转录**分叉**到
// 一个新会话 id —— 历史继承、原会话不被续写。DSH 建 fork 时给的是
// `meta: { cwd, parentSession, isSeeded: true }`，子代理则是 `origin: "subagent"`。
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DSH_CLAUDE_CODE_STORE = mkdtempSync(join(tmpdir(), "dsh-cc-fork-"));

let capturedOptions = [];
mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    query: ({ options }) => { capturedOptions.push(options); return (async function* empty() {})(); },
    createSdkMcpServer: (opts) => opts,
    tool: () => ({}),
  },
});
const { runClaudeCode } = await import("../lib/claude-run.mjs");
const { isForkedSession, forkResumeHint } = await import("../lib/fork.mjs");
const { PluginFacts } = await import("../lib/plugin-facts.mjs");
const { load: loadClaudeSessionId } = await import("../lib/store.mjs");

const ev = (type, data) => ({ type, data, seq: 0 });
let sessionSeq = 0;
const sessionWith = (events) => ({
  id: `f${++sessionSeq}`, append() {}, requestContext: () => undefined, requestHeader: () => undefined,
  snapshotEvents: () => events,
});
const ctx = { get: () => undefined, logger: { warn() {}, info() {} } };
const run = (extra = {}) => runClaudeCode({
  ctx, config: {}, session: sessionWith([]), agent: { id: "a1", status: "running" },
  turn: 1, prompt: "hi", signal: new AbortController().signal, cwd: "/w", executable: "claude", env: {}, ...extra,
});

test("recognises a forked session and not a subagent child", () => {
  assert.equal(isForkedSession({ isSeeded: true, parentSession: "session-p" }), true);
  assert.equal(isForkedSession({ isSeeded: true, parentSession: "session-p", origin: "subagent" }), false, "子代理不是 fork");
  assert.equal(isForkedSession({ parentSession: "session-p" }), false, "没有 isSeeded 就不是 fork");
  assert.equal(isForkedSession({ isSeeded: true }), false, "没有 parentSession 无从继承");
  assert.equal(isForkedSession(undefined), false);
});

test("分叉会话还没有自己的 Claude id 时，取父的并标记 fork", async () => {
  const stored = new Map([["session-p", "claude-parent"]]);
  const hint = await forkResumeHint({ sessionId: "session-c", header: { isSeeded: true, parentSession: "session-p" }, load: async (id) => stored.get(id) });
  assert.deepEqual(hint, { claudeSessionId: "claude-parent", fork: true });
});

test("分叉会话自己跑过之后就续接自己，不再重复分叉", async () => {
  const stored = new Map([["session-c", "claude-child"], ["session-p", "claude-parent"]]);
  const hint = await forkResumeHint({ sessionId: "session-c", header: { isSeeded: true, parentSession: "session-p" }, load: async (id) => stored.get(id) });
  assert.deepEqual(hint, { claudeSessionId: "claude-child", fork: false });
});

test("父会话没有 Claude id 时不做无根据的 resume（fork 仍可新建）", async () => {
  const hint = await forkResumeHint({ sessionId: "session-c", header: { isSeeded: true, parentSession: "session-p" }, load: async () => undefined });
  assert.equal(hint, undefined);
  assert.equal(await forkResumeHint({ sessionId: "s", header: { isSeeded: false }, load: async () => "x" }), undefined);
});

test("旁路表没记到父会话时，私有事实里的那份仍能让 fork 继承历史", async () => {
  // 端到端串起「两处记录 → 恢复优先级」：父的映射只存在于私有事实里
  // （旁路表漏写/被半截文件覆盖的真实形状），分叉仍要拿到父的 Claude id 并标记 fork。
  const root = process.env.DSH_CLAUDE_CODE_STORE;
  const events = [];
  const parent = { id: "session-p", header: { createdAt: 1, cwd: "/w" }, snapshotEvents: () => events };
  const facts = new PluginFacts(parent, { root });
  facts.append("claude-code/session", { claudeSessionId: "claude-parent" });
  facts.close();
  const hint = await forkResumeHint({
    sessionId: "session-c",
    header: { isSeeded: true, parentSession: "session-p" },
    load: loadClaudeSessionId,
  });
  assert.deepEqual(hint, { claudeSessionId: "claude-parent", fork: true });
});

test("fork 只与 resume 一起下发；没有父可续时不发 forkSession", async () => {
  capturedOptions = [];
  await run({ resumeSessionId: "claude-parent", forkSession: true });
  assert.equal(capturedOptions[0].resume, "claude-parent");
  assert.equal(capturedOptions[0].forkSession, true);

  capturedOptions = [];
  await run({ forkSession: true });
  assert.equal(capturedOptions[0].resume, undefined);
  assert.equal(capturedOptions[0].forkSession, undefined, "没有 resume 就没有可分叉的东西");

  capturedOptions = [];
  await run({ resumeSessionId: "claude-own" });
  assert.equal(capturedOptions[0].forkSession, undefined, "普通续接不能分叉");
});
