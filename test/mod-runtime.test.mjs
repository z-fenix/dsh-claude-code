import { test } from "node:test";
import assert from "node:assert/strict";
import { attachFacts } from "./helpers/plugin-facts.mjs";
import { createPlanBridge } from "../lib/host-plan.mjs";
import { createNativeToolGate } from "../lib/native-tool-gate.mjs";
const load = () => import("../lib/mod-runtime.mjs");
function world() {
  const events = [];
  let active = false, pending;
  const session = attachFacts({ id: "runtime-session", header: { cwd: "/w" }, snapshotEvents: () => events,
    append(type, data) { events.push({ type, data, seq: events.length }); if(type === "plan/mode") active = data.active; } });
  const service = { section: "Plan with exit_plan_mode.", get: () => ({ active, ...(pending === undefined ? {} : { pending }) }), set(_a, value) { pending = value; return "queued"; } };
  const agent = { id: "a1", status: "running", session };
  const ctx = { get: (name) => name === "planMode" ? service : name === "agents" ? { get: () => agent } : undefined };
  const abort = new AbortController(); const modes = [];
  return { ctx, agent, session, signal: abort.signal, epoch: "e1", abort: () => abort.abort(), modes,
    planBridge: createPlanBridge({ ctx, agent, session, signal: abort.signal }),
    toolGate: createNativeToolGate({ ctx, agent, session, signal: abort.signal, config: {}, epoch: "e1" }),
    routeStep: async () => ({ model: "chosen", effort: "high" }), setMode: async mode => modes.push(mode),
    pending: (value) => { pending = value; }, events };
}
const step = { turnId: "turn1", index: 0, model: "initial", messageCount: 1 };

test("runtime 主步提交待选 Plan 并同步 mode 与路由，策略只返回白名单段落", async () => {
  const { createModRuntime } = await load(); const w = world(); const runtime = createModRuntime(w);
  w.pending(true);
  const result = await runtime.invoke("runtime_step", runtime.parse("runtime_step", step), { callerAgentId: null });
  assert.equal(result.planActive, true);
  assert.deepEqual(result.routing, { model: "chosen", effort: "high" });
  assert.deepEqual(w.modes, ["plan"]);
  assert.deepEqual(w.events.map(x => x.type), ["plan/mode"]);
  assert.match((await runtime.invoke("runtime_policy", {}, { callerAgentId: null })).text, /ExitPlanMode/);
  assert.equal(w.session.factRecords.at(-1).type, "claude-code/step-control");
});

test("投递前可同步 native mode，真实 step 才提交 pending 且不重复 setter", async () => {
  const { createModRuntime } = await load(); const w = world(); const runtime = createModRuntime(w);
  w.pending(true);
  await runtime.syncMode();
  assert.deepEqual(w.events, []);
  assert.deepEqual(w.modes, ["plan"]);
  await runtime.invoke("runtime_step", step, { callerAgentId: null });
  assert.deepEqual(w.modes, ["plan"]);
  assert.equal(w.events[0].type, "plan/mode");
});

test("动态 DSH runtime 只在单选 Mod transport 时提供，仍绑定真实调用 ID", async () => {
  const { createModRuntime } = await load(); const w = world();
  const definitions = [{ name: "present", description: "Present", inputSchema: { type: "object", properties: { path: { type: "string" } } } }];
  const calls = [];
  const bridge = { definitions: () => definitions, execute: async (...args) => { calls.push(args); return { content: [{ type: "text", text: "done" }], isError: false }; } };
  const runtime = createModRuntime({ ...w, dshModTransport: true, getDshTools: () => bridge });
  assert.deepEqual(runtime.dshDefinitions(), definitions);
  assert.deepEqual((await runtime.invoke("runtime_step", step, { callerAgentId: null })).tools, definitions);
  const request = new AbortController();
  assert.equal((await runtime.invoke("runtime_dsh", { name: "present", callId: "real-call", args: { path: "a" } }, { callerAgentId: null, signal: request.signal })).isError, false);
  assert.equal(calls[0][2]._meta["claudecode/toolUseId"], "real-call");
  request.abort(); assert.equal(calls[0][2].signal.aborted, true);
  await assert.rejects(runtime.invoke("runtime_dsh", { name: "present", callId: "child", args: {} }, { callerAgentId: "child" }));
  assert.throws(() => runtime.parse("runtime_dsh", { name: "bash", callId: "call", args: {} }));
  assert.equal(createModRuntime(world()).has("runtime_dsh"), false);
});

test("runtime 元数据能力有严格来源，child 只观察不读父 context", async () => {
  const { createModRuntime } = await load(); const w = world(); const runtime = createModRuntime(w);
  assert.equal(runtime.capabilities.context, true);
  const snapshot = { window: 200000, tokens: 12, estimated: true, detail: "summary", truncated: false };
  await runtime.invoke("runtime_context", { snapshot }, { callerAgentId: null });
  await assert.rejects(runtime.invoke("runtime_context", { snapshot }, { callerAgentId: "child" }));
  assert.throws(() => runtime.parse("runtime_catalog", { snapshot: { commands: [], skills: [{ name: "forged" }], truncated: false } }));
  runtime.updateSkills([{ name: "real-skill", description: "skill", argumentHint: "" }]);
  assert.equal(w.session.factRecords.at(-1).data.snapshot.skillsSource, "sdk-reload-skills");
  await runtime.invoke("runtime_observe", { kind: "complete", turnId: "child-turn", reason: "answer", isAborted: false, durationMs: 1 }, { callerAgentId: "child" });
  assert.equal(w.session.factRecords.at(-1).data.attribution, "unresolved");
});

test("runtime 方法、参数、child 控制与过期实例全部失败关闭", async () => {
  const { createModRuntime } = await load(); const w = world(); const runtime = createModRuntime(w);
  assert.equal(runtime.has("arbitrary"), false);
  assert.throws(() => runtime.parse("runtime_step", { ...step, systemPrompt: "forged" }));
  await assert.rejects(runtime.invoke("runtime_step", step, { callerAgentId: "child" }));
  runtime.close();
  await assert.rejects(runtime.invoke("runtime_policy", {}, { callerAgentId: null }));
});

test("readonly 检查只追加拒绝，child 不能做父 Plan 审批", async () => {
  const { createModRuntime } = await load(); const w = world(); const runtime = createModRuntime(w);
  w.events.push({ type: "sandbox/mode", data: { mode: "read-only" } });
  assert.equal((await runtime.invoke("runtime_check", { toolName: "PowerShell" }, { callerAgentId: "child" })).decision, "deny");
  assert.equal((await runtime.invoke("runtime_check", { toolName: "Read" }, { callerAgentId: null })).decision, "abstain");
  const result = await runtime.invoke("runtime_tool", { toolName: "ExitPlanMode", callId: "t1", input: {}, planText: "# Plan" }, { callerAgentId: "child" });
  assert.equal(result.decision, "deny");
});

test("异步 step 控制期间 agent 被替换，不能发出旧 owner 的请求", async () => {
  const { createModRuntime } = await load(); const w = world();
  let current = w.agent; const originalGet = w.ctx.get;
  w.ctx.get = name => name === "agents" ? { get: () => current } : originalGet(name);
  const runtime = createModRuntime({ ...w, routeStep: async () => { current = { ...w.agent }; return { model: "chosen" }; } });
  await assert.rejects(runtime.invoke("runtime_step", step, { callerAgentId: null }));
  assert.equal(w.signal.aborted, true);
});

test("计费控制失败中止本查询，不让旧模型静默执行", async () => {
  const { createModRuntime } = await load(); const w = world();
  const runtime = createModRuntime({ ...w, routeStep: async () => { throw new Error("route unavailable"); } });
  await assert.rejects(runtime.invoke("runtime_step", step, { callerAgentId: null }));
  assert.equal(w.signal.aborted, true);
});
