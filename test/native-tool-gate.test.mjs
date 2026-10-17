import { test } from "node:test";
import assert from "node:assert/strict";
import { attachFacts } from "./helpers/plugin-facts.mjs";
const load = () => import("../lib/native-tool-gate.mjs");
function fixture(listener = () => ({ kind: "allow" })) {
  const events = [];
  const session = attachFacts({ id: "gate-session", snapshotEvents: () => events });
  let calls = 0;
  const ctx = { waterfall: async (...args) => { calls += 1; const exec = args.find(x => x?.arguments); return listener(exec); } };
  const agent = { id: "a1", session };
  return { ctx, agent, session, events, get calls() { return calls; } };
}
const input = { toolName: "Write", input: { file_path: "/w/file", content: "old" }, callId: "t1", callerAgentId: null };

test("同一次调用两入口只派发一次 gate，可信参数改写保留", async () => {
  const { createNativeToolGate } = await load(); const world = fixture(exec => { exec.arguments.content = "rewritten"; return { kind: "allow" }; });
  const gate = createNativeToolGate({ ...world, config: {}, epoch: "e1" });
  const prepared = await gate.prepare(input);
  assert.equal(prepared.gate.kind, "allow");
  assert.equal(prepared.updatedInput.content, "rewritten");
  assert.equal(input.input.content, "old");
  assert.equal((await gate.forPermission({ ...input, input: prepared.updatedInput })).kind, "allow");
  assert.equal(world.calls, 1);
  assert.equal((await gate.forPermission({ ...input, input: { ...input.input, content: "forged" } })).kind, "deny");
});

test("双入口 JSON 键序不同仍是同一调用，真实值不同不能混同", async () => {
  const { createNativeToolGate } = await load(); const w = fixture();
  const gate = createNativeToolGate({ ...w, config: {}, epoch: "e1" });
  const original = { ...input, input: { file_path: "/w/file", content: "body", metadata: { a: 1, b: [2, 3] } } };
  await gate.prepare(original);
  assert.equal((await gate.forPermission({ ...original, input: { metadata: { b: [2, 3], a: 1 }, content: "body", file_path: "/w/file" } })).kind, "allow");
  assert.equal(w.calls, 1);
  assert.equal((await gate.forPermission({ ...original, input: { content: "different", file_path: "/w/file", metadata: { a: 1, b: [2, 3] } } })).kind, "deny");
});

test("没有 Mod 归属证据的 SDK 回调拒绝，不冒充主代理派发", async () => {
  const { createNativeToolGate } = await load(); const w = fixture();
  const gate = createNativeToolGate({ ...w, config: {}, epoch: "e1" });
  assert.equal((await gate.forPermission(input)).kind, "deny");
  assert.equal((await gate.forPermission({ ...input, callId: undefined })).kind, "deny");
  assert.equal(w.calls, 0);
  await gate.prepare({ ...input, callerAgentId: "child" });
  assert.equal((await gate.forPermission(input)).kind, "allow");
  assert.equal(w.calls, 0, "later proven child identity must never borrow parent pre-execute");
});

test("child 不借父 scope，readonly 与坏重写失败关闭", async () => {
  const { createNativeToolGate } = await load(); const world = fixture();
  world.events.push({ type: "sandbox/mode", data: { mode: "read-only" } });
  const gate = createNativeToolGate({ ...world, config: {}, epoch: "e1" });
  assert.equal((await gate.prepare({ ...input, callerAgentId: "child" })).denial.includes("read-only"), true);
  assert.equal(world.calls, 0);
  const invalid = fixture(exec => { exec.arguments.agentId = "other"; return { kind: "allow" }; });
  const other = createNativeToolGate({ ...invalid, config: {}, epoch: "e1" });
  assert.equal((await other.prepare(input)).gate.kind, "deny");
});

test("gate 关闭后旧权限回调不能沿用许可", async () => {
  const { createNativeToolGate } = await load(); const world = fixture();
  const gate = createNativeToolGate({ ...world, config: {}, epoch: "e1" });
  await gate.prepare(input);
  gate.approveOnce(input);
  gate.close();
  assert.equal((await gate.forPermission(input)).kind, "deny");
});

test("host ask 的许可只对同 ID/参数有效，后续 readonly 仍拒绝", async () => {
  const { createNativeToolGate } = await load(); const world = fixture(() => ({ kind: "ask", reason: "review" }));
  const gate = createNativeToolGate({ ...world, config: {}, epoch: "e1" });
  await gate.prepare(input);
  gate.approveOnce(input);
  assert.equal((await gate.forPermission(input)).approvedOnce, true);
  world.events.push({ type: "sandbox/mode", data: { mode: "read-only" } });
  assert.match((await gate.prepare(input)).denial, /read-only/);
  assert.equal(world.calls, 1);
});
