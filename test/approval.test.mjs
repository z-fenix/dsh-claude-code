// test/approval.test.mjs — canUseTool 的 AskUserQuestion 桥接契约。
//
// 回归护栏：AskUserQuestion 是「向用户提问」这一交互本身，不是受权限门控的动作。
// 曾经这两个缺陷都会让问题到不了用户面前：
//   1. danger-full-access（bypass）短路排在 AskUserQuestion 分支之前 → 返回 allow，
//      CLI 把 allow 读成「用户已批准这次提问」，于是不弹窗，工具在零答案下返回
//      「The user did not answer the questions.」。
//   2. 回合起点即 Full access 时 runClaudeCode 干脆不挂 canUseTool，CLI 于是把
//      AskUserQuestion 从工具表里摘掉（"disabled for this session"）。
import { test, mock } from "node:test";
import assert from "node:assert/strict";

// --- 模块 mock：捕获 runClaudeCode 交给 SDK query 的 options（不拉起真实 claude CLI）---
let capturedOptions = [];
mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    query: ({ options }) => {
      capturedOptions.push(options);
      return (async function* empty() {})();
    },
  },
});

const { makeCanUseTool } = await import("../lib/approval.mjs");
const { runClaudeCode } = await import("../lib/claude-run.mjs");

const ev = (type, data) => ({ type, data, seq: 0 });
const sessionWith = (events) => ({ snapshotEvents: () => events });

/** 一个会把 ask 记下来的 userQuestions 替身。 */
function fakeQuestions(answer) {
  const calls = [];
  return {
    calls,
    service: {
      ask: async (request) => {
        calls.push(request);
        return answer ?? { answers: [{ id: "goal 来源", selected: ["A"] }] };
      },
    },
  };
}

const baseCtx = (userQuestions) => ({ get: (key) => (key === "userQuestions" ? userQuestions : undefined) });

test("danger-full-access 下 AskUserQuestion 仍走选择题桥，不被 bypass 短路成 allow", async () => {
  const questions = fakeQuestions();
  const canUseTool = makeCanUseTool(baseCtx(questions.service), {
    cwd: "/w",
    session: sessionWith([ev("sandbox/mode", { mode: "danger-full-access" }), ev("approval/policy", { policy: "ask" })]),
    agent: { id: "a1" },
  });

  const result = await canUseTool("AskUserQuestion", {
    questions: [{ question: "这个 goal 由谁来设定？", header: "goal 来源", options: [{ label: "A" }, { label: "B" }] }],
  });

  assert.equal(questions.calls.length, 1, "必须把问题送到 DSH 选择题 UI");
  assert.notEqual(result.behavior, "allow", "绝不能返回 allow —— 那会被 CLI 读成用户已批准，弹窗被吞");
  assert.equal(result.behavior, "deny");
  assert.match(result.message, /goal 来源/, "答案要经 deny message 回到 Claude");
});

test("danger-full-access 下其余工具仍被 bypass 放行", async () => {
  const canUseTool = makeCanUseTool(baseCtx(undefined), {
    cwd: "/w",
    session: sessionWith([ev("sandbox/mode", { mode: "danger-full-access" })]),
    agent: { id: "a1" },
  });
  assert.deepEqual(await canUseTool("Bash", { command: "rm -rf /" }), { behavior: "allow" });
});

test("danger-full-access 下缺 userQuestions 提供者时明确拒绝（而不是静默放行）", async () => {
  const canUseTool = makeCanUseTool(baseCtx(undefined), {
    cwd: "/w",
    session: sessionWith([ev("sandbox/mode", { mode: "danger-full-access" })]),
    agent: { id: "a1" },
  });
  const result = await canUseTool("AskUserQuestion", { questions: [{ question: "Q?", header: "h" }] });
  assert.equal(result.behavior, "deny");
  assert.match(result.message, /user-questions/);
});

test("回合起点即 danger-full-access 时，仍然把 canUseTool 交给 SDK（AskUserQuestion 才在工具表里）", async () => {
  capturedOptions = [];
  const session = {
    id: "s1",
    append() {},
    requestContext: () => undefined,
    requestHeader: () => undefined,
    snapshotEvents: () => [ev("sandbox/mode", { mode: "danger-full-access" }), ev("approval/policy", { policy: "ask" })],
  };
  await runClaudeCode({
    ctx: { get: () => undefined, logger: { warn: () => {}, info: () => {} } },
    config: {},
    session,
    agent: { id: "a1" },
    turn: 1,
    prompt: "hi",
    signal: new AbortController().signal,
    cwd: "/w",
    executable: "claude",
    env: {},
  });

  assert.equal(capturedOptions.length, 1);
  const options = capturedOptions[0];
  assert.equal(options.permissionMode, "bypassPermissions", "Full access 仍要跳过 Claude 的权限/沙箱判定");
  assert.equal(typeof options.canUseTool, "function", "必须挂 canUseTool，否则 CLI 会让 AskUserQuestion 整个缺席");
});

test("非 bypass 策略下同样把 canUseTool 交给 SDK", async () => {
  capturedOptions = [];
  const session = {
    id: "s2",
    append() {},
    requestContext: () => undefined,
    requestHeader: () => undefined,
    snapshotEvents: () => [ev("sandbox/mode", { mode: "workspace-write" }), ev("approval/policy", { policy: "ask" })],
  };
  await runClaudeCode({
    ctx: { get: () => undefined, logger: { warn: () => {}, info: () => {} } },
    config: {},
    session,
    agent: { id: "a1" },
    turn: 1,
    prompt: "hi",
    signal: new AbortController().signal,
    cwd: "/w",
    executable: "claude",
    env: {},
  });
  assert.equal(capturedOptions.length, 1);
  assert.equal(typeof capturedOptions[0].canUseTool, "function");
  assert.equal(capturedOptions[0].permissionMode, undefined);
});
