import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { attachFacts } from "./helpers/plugin-facts.mjs";
import { RunInputLedger } from "../lib/run-input.mjs";

let nativeCalls = [];
let nativeGate;
let ordinaryCalls = 0;
class MaintenanceError extends Error { constructor(code) { super(code); this.code = code; } }
mock.module("../lib/native-maintenance.mjs", { namedExports: {
  NativeMaintenanceError: MaintenanceError,
  runNativeMaintenance: async (options) => {
    nativeCalls.push(options);
    nativeGate?.started.resolve();
    if (nativeGate) await nativeGate.done.promise;
    return { status: "succeeded", messageCount: 1 };
  },
} });
mock.module("../lib/auth.mjs", { namedExports: { resolveClaude: async () => ({ executable: "fake-cli", env: {} }), cannotSpawnDirectly: () => false } });
const original = await import("../lib/claude-run.mjs");
mock.module("../lib/claude-run.mjs", { namedExports: {
  PROVIDER: original.PROVIDER, SUBAGENT_TOOL_NAMES: original.SUBAGENT_TOOL_NAMES, ClaudeRunTracer: original.ClaudeRunTracer,
  runClaudeCode: async (options) => {
    ordinaryCalls += 1;
    const ids = options.initialMessages.map((x) => x.id);
    new RunInputLedger(options.session, options.inputEpoch).submitBatch(ids, { sdkUuid: ids.at(-1), shouldQuery: true });
    return { output: [], stopReason: "completed", logIntact: true, initialSubmitted: true, claudeSessionId: "c1" };
  },
} });
const { ClaudeCodeAgent } = await import("../lib/agent.mjs");
function fixture(config = {}) {
  nativeCalls = []; ordinaryCalls = 0; nativeGate = undefined;
  const events = [];
  const session = attachFacts({ id: "agent-maint", header: { cwd: "/w" }, snapshotEvents: () => [...events],
    append(type, data, options) { const event = { seq: events.length, time: Date.now(), type, data, ...options }; events.push(event); return event; } });
  const ctx = new Context();
  ctx.provide("agents", { withInitiator: async (_agent, fn) => fn() });
  const agent = new ClaudeCodeAgent(ctx, session.id, {}, session,
    { traceSubagents: false, persistSession: true, mods: { enabled: true }, ...config });
  return { agent, session, events };
}

test("compactNative 同步取得维护窗口，精确选择自己的 resume ID", async () => {
  const { agent, events } = fixture();
  agent.pendingResume = "c1";
  nativeGate = { started: Promise.withResolvers(), done: Promise.withResolvers() };
  try {
    const result = agent.compactNative({ commandId: "cmd" });
    assert.equal(agent.phase.kind, "maintenance");
    assert.throws(() => agent.compactNative({ commandId: "again" }), /active work/);
    assert.throws(() => agent.compactNative({ commandId: "busy-code" }), error => error.code === "busy");
    await nativeGate.started.promise;
    assert.equal(nativeCalls[0].claudeSessionId, "c1");
    assert.equal(nativeCalls[0].isLive(), true);
    assert.deepEqual(events, []);
    nativeGate.done.resolve();
    assert.equal((await result).status, "succeeded");
    assert.equal(agent.phase.kind, "idle");
    assert.equal(nativeCalls[0].isLive(), false);
  } finally { nativeGate.done.resolve(); await agent.dispose(); }
});

for (const scenario of ["no-history", "fork", "disabled"]) {
  test(`${scenario} 不压缩新会话或父会话`, async () => {
    const { agent } = fixture(scenario === "disabled" ? { persistSession: false } : {});
    if (scenario !== "no-history") agent.pendingResume = "parent";
    if (scenario === "fork") agent.forkOnResume = true;
    try {
      await assert.rejects(agent.compactNative({ commandId: "cmd" }));
      assert.equal(nativeCalls.length, 0);
      assert.equal(agent.phase.kind, "idle");
    } finally { await agent.dispose(); }
  });
}

test("nativeCommand 走同一维护窗口并只透传固定命令", async () => {
  const { agent } = fixture();
  agent.claudeSessionId = "c1";
  await agent.nativeCommand({ commandId: "cmd", command: "cost" });
  assert.equal(nativeCalls.length, 1);
  assert.equal(nativeCalls[0].action, "command");
  assert.deepEqual(nativeCalls[0].params, { command: "cost" });
  assert.equal(nativeCalls[0].claudeSessionId, "c1");
  assert.equal(agent.phase.kind, "idle");
  await agent.nativeCommand({ commandId: "cmd", command: "status" });
  assert.deepEqual(nativeCalls[1].params, { command: "status" });
  await agent.dispose();
});

test("nativeSnapshots 只读最近数据，dispose 后拒绝维护与新输入", async () => {
  const { agent, session } = fixture();
  session.facts.append("claude-code/native-context", { snapshot: { window: 200000, estimated: true, detail: "summary", truncated: false } });
  assert.equal(agent.nativeSnapshots().context.window, 200000);
  await agent.dispose();
  assert.equal(agent.disposed, true);
  assert.throws(() => agent.nativeSnapshots(), /disposed/);
  assert.throws(() => agent.compactNative(), /disposed/);
  assert.throws(() => agent.followup({ id: "late", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "late" }] }), /disposed/);
});

test("维护 dispose 保留已排队输入，但不得在释放时重新点亮普通循环", async () => {
  const { agent } = fixture(); agent.claudeSessionId = "c1";
  const statuses = [];
  agent.loopCtx.on("agent/status", ({ status }) => statuses.push(status));
  nativeGate = { started: Promise.withResolvers(), done: Promise.withResolvers() };
  const maintenance = agent.compactNative({ commandId: "cmd" });
  await nativeGate.started.promise;
  agent.followup({ id: "queued", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "queued" }] });
  const disposal = agent.dispose();
  nativeGate.done.resolve();
  await Promise.allSettled([maintenance, disposal]);
  assert.equal(statuses.includes("running"), false);
  assert.equal(agent.inbox.nextTurn.length, 1);
});

test("维护未静默前 followup 留在 inbox，完成后才进入普通循环", async () => {
  const { agent } = fixture();
  agent.claudeSessionId = "c1";
  nativeGate = { started: Promise.withResolvers(), done: Promise.withResolvers() };
  try {
    const result = agent.compactNative({ commandId: "cmd" });
    await nativeGate.started.promise;
    agent.followup({ id: "u1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "after compact" }] });
    assert.equal(ordinaryCalls, 0);
    assert.equal(agent.inbox.nextTurn.length, 1);
    nativeGate.done.resolve();
    await result;
    await agent.whenIdle();
    assert.equal(ordinaryCalls, 1);
  } finally { nativeGate.done.resolve(); await agent.dispose(); }
});
