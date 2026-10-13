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
    // goal-bridge 顶层 `import { createSdkMcpServer, tool }`；二者只在 buildGoalServer 内被调用，
    // 本文件不触达，因此给惰性占位即可（缺了会在模块链接期直接 SyntaxError）。
    createSdkMcpServer: () => ({}),
    tool: () => ({}),
  },
});

const { makeCanUseTool } = await import("../lib/approval.mjs");
const { runClaudeCode } = await import("../lib/claude-run.mjs");
const { GOAL_TOOL_PREFIX } = await import("../lib/goal-bridge.mjs");

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

test("read-only + never 不因 blockedPath 在工作区内而放行写入", async () => {
  const canUseTool = makeCanUseTool(baseCtx(undefined), {
    cwd: "/w",
    session: sessionWith([ev("sandbox/mode", { mode: "read-only" }), ev("approval/policy", { policy: "never" })]),
    agent: { id: "a1" },
  });
  const result = await canUseTool("Write", { file_path: "/w/a.txt", content: "x" }, { blockedPath: "/w/a.txt" });
  assert.equal(result.behavior, "deny");
});

test("read-only + ask 的工作区写入被直接拒绝，不给「批准一次就放行」的口子", async () => {
  const requests = [];
  const canUseTool = makeCanUseTool({ get: (key) => key === "approval" ? {
    request: async (request) => { requests.push(request); return "allowed-once"; },
  } : undefined }, {
    cwd: "/w",
    session: sessionWith([ev("sandbox/mode", { mode: "read-only" }), ev("approval/policy", { policy: "ask" })]),
    agent: { id: "a1" },
  });
  const result = await canUseTool("Write", { file_path: "/w/a.txt" }, { blockedPath: "/w/a.txt" });
  assert.equal(result.behavior, "deny");
  // standard 会话在 read-only 下无论怎么批准都改不了文件（DSH 文件沙箱的 writableRoots 为空），
  // 所以这里也不该把决定权交给一次审批。
  assert.equal(requests.length, 0);
  assert.match(result.message, /read-only/);
});

test("workspace-write 的区内路径可放行，切成 read-only 后下一调用立即拒绝", async () => {
  const events = [ev("sandbox/mode", { mode: "workspace-write" }), ev("approval/policy", { policy: "never" })];
  const canUseTool = makeCanUseTool(baseCtx(undefined), { cwd: "/w", session: sessionWith(events), agent: { id: "a1" } });
  assert.deepEqual(await canUseTool("Write", {}, { blockedPath: "/w/a.txt" }), { behavior: "allow" });
  assert.equal((await canUseTool("Write", {}, { blockedPath: "/elsewhere/a.txt" })).behavior, "deny");
  events.push(ev("sandbox/mode", { mode: "read-only" }));
  assert.equal((await canUseTool("Write", {}, { blockedPath: "/w/a.txt" })).behavior, "deny");
});

test("没有 mode 时不把工作区路径当作写入许可", async () => {
  const canUseTool = makeCanUseTool(baseCtx(undefined), {
    cwd: "/w", session: sessionWith([ev("approval/policy", { policy: "never" })]), agent: { id: "a1" },
  });
  assert.equal((await canUseTool("Write", {}, { blockedPath: "/w/a.txt" })).behavior, "deny");
});

test("goal 桥接工具在 no-prompt（never）下仍放行，且早于策略短路", async () => {
  const canUseTool = makeCanUseTool(baseCtx(undefined), {
    cwd: "/w",
    session: sessionWith([ev("sandbox/mode", { mode: "workspace-write" }), ev("approval/policy", { policy: "never" })]),
    agent: { id: "a1" },
  });
  // 放行工具名直接取自 goal-bridge 的常量（而非字面量），server 改名时这里同步生效。
  assert.deepEqual(await canUseTool(GOAL_TOOL_PREFIX + "get_goal", {}), { behavior: "allow" });
  assert.deepEqual(await canUseTool(GOAL_TOOL_PREFIX + "create_goal", { objective: "x" }), { behavior: "allow" });
  assert.deepEqual(await canUseTool(GOAL_TOOL_PREFIX + "update_goal", { action: "complete" }), { behavior: "allow" });
  // 只放行精确的三个工具名：goal server 下的其它工具名不享受自动放行，落到策略 → no-prompt 下拒绝。
  assert.equal((await canUseTool(GOAL_TOOL_PREFIX + "unknown", {})).behavior, "deny");
  // 非 goal 的 MCP 工具不受此放行影响
  assert.equal((await canUseTool("mcp__other__x", {})).behavior, "deny");
});

// --- read-only 文件沙箱对齐（第二期） ---
// standard 会话由 DSH 的文件沙箱兜底：read-only 下任何写操作都改不了文件（dsh-fs-sandbox 的
// writableRoots 为空）。Claude Code 模式的文件工具是 CLI 自带的，**不经过** DSH 的 fs/sandbox，
// 所以插件必须自己把这条限制落到 canUseTool 上；能力不足（Bash 无法静态判定是否写文件）时
// 只能拒绝或保留审批，不能声称与 standard 等价的 OS 沙箱。

test("read-only：工作区内的写工具被拒绝，不因路径落在工作区而放行", async () => {
  const canUseTool = makeCanUseTool(baseCtx(undefined), {
    cwd: "/w",
    session: sessionWith([ev("sandbox/mode", { mode: "read-only" }), ev("approval/policy", { policy: "ask" })]),
    agent: { id: "a1" },
  });
  const result = await canUseTool("Write", { file_path: "/w/a.txt" }, { blockedPath: "/w/a.txt" });
  assert.equal(result.behavior, "deny");
  assert.match(result.message, /read-only/);
  assert.match(result.message, /workspace-write|full access/);
});

test("read-only：一次审批不能把写限制变成可写（不弹审批）", async () => {
  const approvals = [];
  const ctx = { get: (key) => (key === "approval"
    ? { request: async (request) => { approvals.push(request); return "allowed-once"; } }
    : undefined) };
  const canUseTool = makeCanUseTool(ctx, {
    cwd: "/w",
    session: sessionWith([ev("sandbox/mode", { mode: "read-only" })]),
    agent: { id: "a1" },
  });
  const result = await canUseTool("Edit", { file_path: "/w/a.txt" });
  assert.equal(result.behavior, "deny");
  assert.equal(approvals.length, 0, "read-only 的写限制不能被批准一次就绕过");
});

test("read-only：Bash 仍走审批 seam（命令是否写文件无法静态判定）", async () => {
  const approvals = [];
  const ctx = { get: (key) => (key === "approval"
    ? { request: async (request) => { approvals.push(request); return "allowed-once"; } }
    : undefined) };
  const canUseTool = makeCanUseTool(ctx, {
    cwd: "/w",
    session: sessionWith([ev("sandbox/mode", { mode: "read-only" })]),
    agent: { id: "a1" },
  });
  const result = await canUseTool("Bash", { command: "echo hi" });
  assert.equal(approvals.length, 1);
  assert.equal(result.behavior, "allow");
});

test("workspace-write：工作区内写仍直接放行（既有行为不变）", async () => {
  const canUseTool = makeCanUseTool(baseCtx(undefined), {
    cwd: "/w",
    session: sessionWith([ev("sandbox/mode", { mode: "workspace-write" })]),
    agent: { id: "a1" },
  });
  assert.deepEqual(await canUseTool("Write", { file_path: "/w/a.txt" }, { blockedPath: "/w/a.txt" }), { behavior: "allow" });
});
