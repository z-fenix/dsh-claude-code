import { test } from "node:test";
import assert from "node:assert/strict";
import { makeCanUseTool } from "../lib/approval.mjs";
import { createNativeToolGate } from "../lib/native-tool-gate.mjs";
import { attachFacts } from "./helpers/plugin-facts.mjs";
function fixture(mode = "workspace-write", policy = "ask") {
  const events = [{ type: "sandbox/mode", data: { mode } }, { type: "approval/policy", data: { policy } }];
  const session = attachFacts({ id: "approval-runtime", snapshotEvents: () => events });
  const agent = { id: "a1", session };
  let gates = 0; let asks = 0;
  const ctx = { get: (name) => name === "approval" ? { request: async () => { asks += 1; return "allowed-once"; } } : undefined,
    waterfall: async () => { gates += 1; return { kind: "ask", reason: "host review" }; } };
  return { ctx, agent, session, events, get gates() { return gates; }, get asks() { return asks; } };
}

test("Full access 的 native plan 工具没有可信桥时也不能自动批准", async () => {
  const world = fixture("danger-full-access");
  const canUse = makeCanUseTool(world.ctx, { ...world, cwd: "/w" });
  for (const tool of ["EnterPlanMode", "ExitPlanMode"]) assert.equal((await canUse(tool, {}, { toolUseID: "t1" })).behavior, "deny");
  assert.equal(world.asks, 0);
});

test("Full access 仍不能绕过已生效的 Plan 文件限制", async () => {
  const world = fixture("danger-full-access");
  const canUse = makeCanUseTool(world.ctx, { ...world, cwd: "/w", planBridge: { guard: () => "Stay in plan mode." } });
  assert.equal((await canUse("Write", { file_path: "/w/source.js" })).behavior, "deny");
});

test("native plan 许可来自对应 review，不经过普通 approval", async () => {
  const world = fixture("danger-full-access");
  const canUse = makeCanUseTool(world.ctx, { ...world, cwd: "/w", planBridge: { permission: (tool, id) =>
    tool === "ExitPlanMode" && id === "reviewed" ? { behavior: "allow" } : { behavior: "deny", message: "not reviewed" } } });
  assert.equal((await canUse("ExitPlanMode", {}, { toolUseID: "reviewed" })).behavior, "allow");
  assert.equal((await canUse("ExitPlanMode", {}, { toolUseID: "other" })).behavior, "deny");
  assert.equal(world.asks, 0);
});

test("Mod 与 canUseTool 共享 host ask，只问一次且不能绕过后续 readonly", async () => {
  const world = fixture("danger-full-access");
  const gate = createNativeToolGate({ ...world, config: {}, epoch: "e1" });
  const call = { toolName: "Write", input: { file_path: "/w/file", content: "body" }, callId: "t1", callerAgentId: null };
  await gate.prepare(call);
  const canUse = makeCanUseTool(world.ctx, { ...world, cwd: "/w", toolGate: gate });
  assert.equal((await canUse("Write", call.input, { toolUseID: "t1" })).behavior, "allow");
  gate.approveOnce(call);
  assert.equal((await canUse("Write", call.input, { toolUseID: "t1" })).behavior, "allow");
  assert.equal(world.gates, 1);
  assert.equal(world.asks, 1);
  world.events.push({ type: "sandbox/mode", data: { mode: "read-only" } });
  assert.equal((await canUse("Write", call.input, { toolUseID: "t1" })).behavior, "deny");
});

test("MCP 不重复进原生 gate，关闭查询后的工具和提问都被拒绝", async () => {
  const world = fixture("danger-full-access");
  let live = true, gates = 0, questions = 0;
  const originalGet = world.ctx.get;
  world.ctx.get = name => name === "userQuestions" ? { ask: async () => { questions += 1; return { answers: [] }; } } : originalGet(name);
  const canUse = makeCanUseTool(world.ctx, { ...world, cwd: "/w", isLive: () => live,
    allowedToolNames: ["mcp__dsh-bridge__present"], toolGate: { forPermission: async () => { gates += 1; return { kind: "allow" }; } } });
  assert.equal((await canUse("mcp__dsh-bridge__present", {}, { toolUseID: "t1" })).behavior, "allow");
  assert.equal(gates, 0);
  live = false;
  assert.equal((await canUse("mcp__dsh-bridge__present", {})).behavior, "deny");
  await canUse("AskUserQuestion", { questions: [{ question: "Choose?", options: [{ label: "Yes" }, { label: "No" }] }] });
  assert.equal(questions, 0);
});

test("审批等待中切成 readonly 或丢失查询所有权，不沿用旧允许", async () => {
  for (const changed of ["readonly", "owner"]) {
    const world = fixture(); let live = true;
    const asked = Promise.withResolvers(), answer = Promise.withResolvers();
    world.ctx.get = name => name === "approval" ? { request: async () => { asked.resolve(); return answer.promise; } } : undefined;
    const canUse = makeCanUseTool(world.ctx, { ...world, cwd: "/w", isLive: () => live });
    const pending = canUse("Write", { file_path: "/outside/file", content: "body" }, { toolUseID: "t1" });
    await asked.promise;
    if (changed === "readonly") world.events.push({ type: "sandbox/mode", data: { mode: "read-only" } });
    else live = false;
    answer.resolve("allowed-once");
    assert.equal((await pending).behavior, "deny", changed);
  }
});

test("动态工具自动许可只来自实时精确可见集合", async () => {
  const world = fixture("read-only", "never");
  let names = [];
  const canUse = makeCanUseTool(world.ctx, { ...world, cwd: "/w", allowedToolNames: () => names });
  assert.equal((await canUse("mcp__dsh-bridge__present", {})).behavior, "deny");
  names = ["mcp__dsh-bridge__present"];
  assert.equal((await canUse("mcp__dsh-bridge__present", {})).behavior, "allow");
  assert.equal((await canUse("mcp__dsh-bridge__arbitrary", {})).behavior, "deny");
  names = [];
  assert.equal((await canUse("mcp__dsh-bridge__present", {})).behavior, "deny");
});
