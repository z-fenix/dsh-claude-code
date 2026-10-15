// test/host-tool-gate.test.mjs — 把 Claude 的文件工具派发进宿主 `tools/pre-execute` 的接线。
//
// 两个层面各测一半：
//   1. 派发本身的形状与决定映射（`dispatchHostToolGate`）——载荷字段是宿主监听器真正读的那些，
//      派发必须带 scope carrier（缺了宿主的 scope invariant 会直接失败）；
//   2. canUseTool 的决定映射——宿主说 deny/cancel 时拒绝，说 ask 时不许被自动放行短路。
import { test } from "node:test";
import assert from "node:assert/strict";
import { isScopeCarrier } from "@deepseek-ai/dsh-scope";
import { dispatchHostToolGate, FILE_TOOL_WIRE_NAMES } from "../lib/host-tool-gate.mjs";
import { mapToolName } from "../lib/claude-run.mjs";
import { makeCanUseTool } from "../lib/approval.mjs";

/** 本次调用的 agent 替身：记录器按 `exec.agent.session` 归位，所以带上 session。 */
const anAgent = () => ({ id: "a1", session: { header: { id: "s1", cwd: "/w" } } });

/**
 * 假的宿主 ctx：只实现 `waterfall`，语义与 Cordis 一致（监听器收到 payload 与 next）。
 * 记下每次派发的 (carrier, name, payload) 供断言。
 */
function hostCtx(listeners = []) {
  const calls = [];
  return {
    calls,
    waterfall(carrier, name, payload, terminate) {
      calls.push({ carrier, name, payload });
      const run = (index) => {
        if (index >= listeners.length) return Promise.resolve(terminate());
        return Promise.resolve(listeners[index](payload, () => run(index + 1)));
      };
      return run(0);
    },
  };
}

test("wire 名与渲染映射同值：改 TOOL_NAME_MAP 时这张表不会悄悄脱钩", () => {
  for (const [claudeName, wireName] of Object.entries(FILE_TOOL_WIRE_NAMES)) {
    assert.equal(mapToolName(claudeName), wireName, `${claudeName} → ${wireName}`);
  }
});

test("非文件工具不派发：宿主那条路上本来也不会有这次调用", async () => {
  const ctx = hostCtx([() => { throw new Error("不该被调用"); }]);
  assert.deepEqual(await dispatchHostToolGate(ctx, anAgent(), { toolName: "Bash", input: { command: "ls" } }), { kind: "allow" });
  assert.deepEqual(await dispatchHostToolGate(ctx, anAgent(), { toolName: "Read", input: { file_path: "/w/a.txt" } }), { kind: "allow" });
  assert.equal(ctx.calls.length, 0);
});

test("Write 按宿主的 wire 名与载荷形状派发，且带 scope carrier", async () => {
  const ctx = hostCtx();
  const agent = anAgent();
  const input = { file_path: "/w/a.txt", content: "x" };
  const gate = await dispatchHostToolGate(ctx, agent, { toolName: "Write", input, callId: "toolu_1" });

  assert.deepEqual(gate, { kind: "allow" }, "没有监听器表态时终止值是 allow");
  assert.equal(ctx.calls.length, 1);
  const call = ctx.calls[0];
  assert.equal(call.name, "tools/pre-execute");
  assert.equal(call.payload.name, "write", "记录器的 mutationPath 按 wire 名分派（write / edit / str_replace_editor）");
  assert.equal(call.payload.arguments, input, "入参原样传下去，记录器靠它取 file_path");
  assert.equal(call.payload.callId, "toolu_1", "钩子的 tool_use_id 取这个字段");
  assert.equal(call.payload.agent, agent, "记录器按 exec.agent.session 归位会话");
  assert.equal(isScopeCarrier(call.carrier), true, "缺 scope carrier 时宿主的 scope invariant 会直接失败");
});

test("Edit 派发成 edit；MultiEdit / NotebookEdit 也派发，但不伪造成记录器认得的形状", async () => {
  const cases = [
    ["Edit", { file_path: "/w/a.txt", old_string: "a", new_string: "b" }],
    // 记录器的 mutationPath 认不出这两个形状（它要求 edit 带 old_string + new_string、
    // write 带 content），所以它们不会产生「改动前捕获」。这里仍派发——其它监听器该看到
    // 「一个会改文件的工具要跑了」——但绝不改写参数去骗过记录器。
    ["MultiEdit", { file_path: "/w/a.txt", edits: [{ old_string: "a", new_string: "b" }] }],
    ["NotebookEdit", { notebook_path: "/w/a.ipynb", new_source: "x" }],
  ];
  for (const [toolName, input] of cases) {
    const ctx = hostCtx();
    await dispatchHostToolGate(ctx, anAgent(), { toolName, input, callId: "toolu_x" });
    assert.equal(ctx.calls.length, 1, `${toolName} 要派发`);
    assert.equal(ctx.calls[0].payload.name, "edit");
    assert.deepEqual(ctx.calls[0].payload.arguments, input, `${toolName} 的入参必须原样，不许伪造`);
  }
});

test("deny / cancel / ask 逐个原样带出，不吞不改成 allow", async () => {
  const decisions = [
    { kind: "deny", reason: "blocked by PreToolUse hook" },
    { kind: "cancel" },
    { kind: "ask", reason: "hook wants a human" },
  ];
  for (const decision of decisions) {
    const ctx = hostCtx([() => decision]);
    assert.deepEqual(await dispatchHostToolGate(ctx, anAgent(), { toolName: "Write", input: { file_path: "/w/a.txt", content: "" } }), decision);
  }
});

test("监听器返回 next() 时不表态：后面还有监听器就继续问，最后落到 allow", async () => {
  const ctx = hostCtx([
    (exec, next) => next(),
    (exec, next) => next(),
    () => ({ kind: "ask" }),
  ]);
  assert.deepEqual(await dispatchHostToolGate(ctx, anAgent(), { toolName: "Edit", input: { file_path: "/w/a.txt", old_string: "a", new_string: "b" } }),
    { kind: "ask" });
});

test("监听器抛错 fail-closed 成 deny（宿主自己也是这个语义）", async () => {
  const ctx = hostCtx([() => { throw new Error("hook blew up"); }]);
  const gate = await dispatchHostToolGate(ctx, anAgent(), { toolName: "Write", input: { file_path: "/w/a.txt", content: "" } });
  assert.equal(gate.kind, "deny");
  assert.match(gate.reason, /hook blew up/);
});

test("监听器没给出可用决定时同样不放行", async () => {
  for (const value of [undefined, null, "allow", {}, { kind: "maybe" }]) {
    const ctx = hostCtx([() => value]);
    const gate = await dispatchHostToolGate(ctx, anAgent(), { toolName: "Write", input: { file_path: "/w/a.txt", content: "" } });
    assert.equal(gate.kind, "deny", `${String(value)} 不该被当成放行`);
  }
});

test("没有派发器或没有 agent 时不派发也不抛错", async () => {
  const plain = { get: () => undefined };
  assert.deepEqual(await dispatchHostToolGate(plain, anAgent(), { toolName: "Write", input: {} }), { kind: "allow" });
  const ctx = hostCtx([() => { throw new Error("不该被调用"); }]);
  assert.deepEqual(await dispatchHostToolGate(ctx, undefined, { toolName: "Write", input: {} }), { kind: "allow" });
  assert.equal(ctx.calls.length, 0);
});

// --- canUseTool 的决定映射 ---

const ev = (type, data) => ({ type, data, seq: 0 });
const sessionWith = (events) => ({ snapshotEvents: () => events });
const workspaceWrite = () => sessionWith([ev("sandbox/mode", { mode: "workspace-write" }), ev("approval/policy", { policy: "ask" })]);
const dangerFull = () => sessionWith([ev("sandbox/mode", { mode: "danger-full-access" }), ev("approval/policy", { policy: "ask" })]);

/** 一个同时能当派发器、又能给 approval 服务的 ctx。 */
function gateCtx(listeners = [], outcomes = []) {
  const ctx = hostCtx(listeners);
  const requests = [];
  ctx.requests = requests;
  ctx.get = (key) => (key === "approval"
    ? { request: async (request) => { requests.push(request); return outcomes.shift() ?? "allowed-once"; } }
    : undefined);
  return ctx;
}

test("工作区内写仍直接放行：派发过了，但没有监听器反对", async () => {
  const ctx = gateCtx();
  const canUseTool = makeCanUseTool(ctx, { cwd: "/w", session: workspaceWrite(), agent: anAgent() });
  assert.deepEqual(await canUseTool("Write", { file_path: "/w/a.txt", content: "x" }, { blockedPath: "/w/a.txt" }), { behavior: "allow" });
  assert.equal(ctx.calls.length, 1, "放行之前必须已经派发过（记录器的改动前捕获就在这一刻排队）");
  assert.equal(ctx.requests.length, 0);
});

test("宿主 deny：按宿主的理由拒绝，且不弹审批", async () => {
  const ctx = gateCtx([() => ({ kind: "deny", reason: "PreToolUse hook blocked this edit" })]);
  const canUseTool = makeCanUseTool(ctx, { cwd: "/w", session: workspaceWrite(), agent: anAgent() });
  const result = await canUseTool("Edit", { file_path: "/w/a.txt", old_string: "a", new_string: "b" }, { blockedPath: "/w/a.txt" });
  assert.equal(result.behavior, "deny");
  assert.match(result.message, /PreToolUse hook blocked this edit/, "宿主的理由要带出来，否则用户不知道是谁拦的");
  assert.equal(ctx.requests.length, 0);
});

test("宿主 cancel：拒绝", async () => {
  const ctx = gateCtx([() => ({ kind: "cancel" })]);
  const canUseTool = makeCanUseTool(ctx, { cwd: "/w", session: workspaceWrite(), agent: anAgent() });
  const result = await canUseTool("Write", { file_path: "/w/a.txt", content: "x" }, { blockedPath: "/w/a.txt" });
  assert.equal(result.behavior, "deny");
  assert.match(result.message, /cancelled/);
});

test("宿主 ask：区内自动放行失效，落到 DSH 审批 seam，理由带出宿主的话", async () => {
  const ctx = gateCtx([() => ({ kind: "ask", reason: "hook wants a human" })]);
  const canUseTool = makeCanUseTool(ctx, { cwd: "/w", session: workspaceWrite(), agent: anAgent() });
  const result = await canUseTool("Write", { file_path: "/w/a.txt", content: "x" }, { blockedPath: "/w/a.txt" });
  assert.equal(result.behavior, "allow", "用户批准一次才放行");
  assert.equal(ctx.requests.length, 1, "ask 必须变成真正的一次提问，不能被区内自动放行吞掉");
  assert.equal(ctx.requests[0].toolName, "Write");
  assert.match(ctx.requests[0].reason, /hook wants a human/);

  // 用户拒绝时照旧拒绝。
  const refusing = gateCtx([() => ({ kind: "ask", reason: "hook wants a human" })], ["denied"]);
  const canUseTool2 = makeCanUseTool(refusing, { cwd: "/w", session: workspaceWrite(), agent: anAgent() });
  assert.equal((await canUseTool2("Write", { file_path: "/w/a.txt", content: "x" }, { blockedPath: "/w/a.txt" })).behavior, "deny");
});

test("宿主 ask 在 danger-full-access 下也要问一次（是监听器明确要求的）", async () => {
  const ctx = gateCtx([() => ({ kind: "ask", reason: "hook wants a human" })]);
  const canUseTool = makeCanUseTool(ctx, { cwd: "/w", session: dangerFull(), agent: anAgent() });
  assert.equal((await canUseTool("Write", { file_path: "/w/a.txt", content: "x" })).behavior, "allow");
  assert.equal(ctx.requests.length, 1);
});

test("宿主 deny 早于 danger-full-access 的 bypass 放行", async () => {
  const ctx = gateCtx([() => ({ kind: "deny", reason: "no edits here" })]);
  const canUseTool = makeCanUseTool(ctx, { cwd: "/w", session: dangerFull(), agent: anAgent() });
  const result = await canUseTool("Write", { file_path: "/w/a.txt", content: "x" });
  assert.equal(result.behavior, "deny");
  assert.match(result.message, /no edits here/);
});

test("宿主放行也不能让 read-only 的写限制松动（硬拒绝排在派发之后）", async () => {
  const ctx = gateCtx();
  const canUseTool = makeCanUseTool(ctx, {
    cwd: "/w",
    session: sessionWith([ev("sandbox/mode", { mode: "read-only" }), ev("approval/policy", { policy: "ask" })]),
    agent: anAgent(),
  });
  const result = await canUseTool("Write", { file_path: "/w/a.txt", content: "x" }, { blockedPath: "/w/a.txt" });
  assert.equal(result.behavior, "deny");
  assert.match(result.message, /read-only/);
  assert.equal(ctx.calls.length, 1, "派发过一次（宿主监听器看得到这次尝试），但决定权仍在插件的硬拒绝");
});

test("派发器抛错时整条调用 fail-closed（不放行任何写）", async () => {
  const ctx = gateCtx([() => { throw new Error("hook blew up"); }]);
  const canUseTool = makeCanUseTool(ctx, { cwd: "/w", session: workspaceWrite(), agent: anAgent() });
  const result = await canUseTool("Write", { file_path: "/w/a.txt", content: "x" }, { blockedPath: "/w/a.txt" });
  assert.equal(result.behavior, "deny");
  assert.match(result.message, /hook blew up/);
});
