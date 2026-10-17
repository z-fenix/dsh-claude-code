import { test } from "node:test";
import assert from "node:assert/strict";
const load = () => import("../lib/dsh-tools-bridge.mjs");
const definition = (required = ["path"]) => ({ name: "present", description: "Present files", parameters: {
  type: "object", additionalProperties: false, properties: { path: { type: "string" }, label: { type: "string" } }, required,
} });
function world() {
  let definitions = [];
  const executed = [];
  const agent = { id: "a1", status: "running" };
  let registered = agent;
  const registry = { wireSchemas: () => ({ schemas: definitions }), execute: async exec => {
    executed.push(exec); return { content: [{ type: "text", text: "delivered" }], isError: false };
  } };
  const ctx = { get: name => name === "tools" ? registry : name === "agents" ? { get: () => registered } : undefined };
  return { ctx, agent, registry, executed, show: values => { definitions = values; }, replaceAgent() { registered = { ...agent }; } };
}
const extra = id => ({ _meta: { "claudecode/toolUseId": id } });
const announce = (bridge, id, main = true) => bridge.observe({ type: "assistant", parent_tool_use_id: main ? null : "parent-tool",
  message: { content: [{ type: "tool_use", id, name: "mcp__dsh-bridge__present", input: {} }] } }, { isMain: main });

test("Mod bridge 可从空目录动态新增/更新，只执行当前完整 schema", async () => {
  const { buildDshToolBridge, DSH_MOD_TOOL_PREFIX } = await load(); const w = world();
  const bridge = buildDshToolBridge({ ...w, names: ["present"], toolPrefix: DSH_MOD_TOOL_PREFIX });
  try {
    assert.deepEqual(bridge.definitions(), []);
    w.show([definition()]);
    assert.deepEqual(bridge.names, ["present"]);
    announce(bridge, "c1");
    assert.equal((await bridge.execute("present", { path: "a.txt" }, extra("c1"))).isError, false);
    assert.equal(w.executed[0].callId, "c1");
    assert.equal(w.executed[0].agent, w.agent);
    w.show([definition(["path", "label"])]);
    announce(bridge, "c2");
    assert.equal((await bridge.execute("present", { path: "b.txt" }, extra("c2"))).isError, true);
    assert.equal(w.executed.length, 1);
    assert.equal((await bridge.execute("present", { path: "b.txt", label: "new schema" }, extra("c2"))).isError, false);
    w.show([]);
    assert.equal((await bridge.execute("present", { path: "a.txt" }, extra("c1"))).isError, true);
    assert.deepEqual(bridge.names, []);
    assert.equal(w.executed.length, 2);
  } finally { await bridge.close(); }
});

test("未审计名、child、冲突 ID 和旧 agent 均不能执行父工具", async () => {
  const { buildDshToolBridge, DSH_MOD_TOOL_PREFIX } = await load(); const w = world(); w.show([definition()]);
  const bridge = buildDshToolBridge({ ...w, names: ["present"], toolPrefix: DSH_MOD_TOOL_PREFIX });
  try {
    assert.equal((await bridge.execute("bash", {}, extra("bad"))).isError, true);
    assert.equal((await bridge.execute("present", { path: "a" }, {})).isError, true);
    announce(bridge, "child", false); announce(bridge, "child", true);
    assert.equal((await bridge.execute("present", { path: "a" }, extra("child"))).isError, true);
    announce(bridge, "main"); w.replaceAgent();
    assert.equal((await bridge.execute("present", { path: "a" }, extra("main"))).isError, true);
    assert.equal(w.executed.length, 0);
  } finally { await bridge.close(); }
});

test("查询 close 取消并等待已进入的宿主执行，旧调用失效", async () => {
  const { buildDshToolBridge, DSH_MOD_TOOL_PREFIX } = await load(); const w = world(); w.show([definition()]);
  const started = Promise.withResolvers(); let executionSignal;
  w.registry.execute = async exec => {
    executionSignal = exec.signal; started.resolve();
    await new Promise(resolve => exec.signal.addEventListener("abort", resolve, { once: true }));
    return { content: [{ type: "text", text: "cancelled" }], isError: true };
  };
  const bridge = buildDshToolBridge({ ...w, names: ["present"], toolPrefix: DSH_MOD_TOOL_PREFIX });
  announce(bridge, "main");
  const pending = bridge.execute("present", { path: "a" }, extra("main"));
  await started.promise;
  await bridge.close();
  assert.equal(executionSignal.aborted, true);
  assert.equal((await pending).isError, true);
  assert.equal((await bridge.execute("present", { path: "a" }, extra("main"))).isError, true);
});
