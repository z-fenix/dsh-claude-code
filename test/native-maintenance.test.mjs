import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { RunInputChannel } from "../lib/run-input.mjs";
import { attachFacts } from "./helpers/plugin-facts.mjs";

let mode = "success";
let queried;
let claimed;
mock.module("../lib/mod-options.mjs", { namedExports: {
  MOD_PATH: "/bundled/driver", COMPACT_OBSERVER_PATH: "/bundled/observer",
  probeModSupport: async () => ({ supported: true }),
  buildModOptions: ({ env, bridge }) => ({ enabled: true, sdkOptions: {
    env: { ...env, DSH_CLAUDE_BRIDGE: JSON.stringify(bridge) }, plugins: [{ type: "local", path: "/bundled/driver" }],
  } }),
} });
mock.module("@anthropic-ai/claude-agent-sdk", { namedExports: {
  createSdkMcpServer: (x) => x, tool: (...args) => args,
  query: ({ prompt, options }) => {
    const output = new RunInputChannel();
    queried = { options, inputs: [], closed: false, url: JSON.parse(options.env.DSH_CLAUDE_BRIDGE).url };
    const descriptor = JSON.parse(options.env.DSH_CLAUDE_BRIDGE);
    const observer = JSON.parse(options.env.DSH_CLAUDE_COMPACT_OBSERVER);
    let seq = 0;
    const send = async (method, params = {}, token = descriptor.token) => {
      const response = await fetch(descriptor.url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ ...descriptor, url: undefined, token: undefined, callerAgentId: null,
          claudeSessionId: mode === "wrong-session" ? "other" : "c1", requestId: `r${++seq}`, method, params }) });
      if (!response.ok) throw new Error(`RPC ${response.status}`);
      return (await response.json()).value;
    };
    void (async () => {
      if (mode === "early-exit") { output.end(); return; }
      const hello = await send("handshake", { protocol: 1 });
      await send("handshake", { protocol: 1, ready: true });
      const operationId = hello.maintenance.operationId;
      await send("maintenance_claim", { operationId });
      claimed?.resolve();
      if (mode === "hold") return;
      output.push({ type: "system", subtype: "status", status: "compacting" });
      const result = { status: "succeeded", messageCount: 1, tokensBefore: 100, tokensAfter: 30 };
      await send("maintenance_observe", { operationId, result }, observer.token);
      await send("maintenance_complete", { operationId, result });
      for await (const input of prompt) queried.inputs.push(input);
      output.end();
    })().catch(() => output.end());
    return { [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](), close() { queried.closed = true; output.close(); } };
  },
} });
const load = () => import("../lib/native-maintenance.mjs");
function fixture(config = {}) {
  const session = attachFacts({ id: "s1", header: { cwd: "/workspace" }, snapshotEvents: () => [] });
  const abort = new AbortController();
  const agent = { id: "a1", status: "idle" };
  return { ctx: { get() {} }, agent, session, executable: "cli", env: { EXISTING: "yes" }, claudeSessionId: "c1",
    commandId: "cmd1", action: "compact", params: {}, signal: abort.signal, abort, isLive: () => true,
    config: { mods: { enabled: true, maintenanceTimeoutMs: 1000 }, ...config } };
}

test("原生维护准确 resume，零用户输入且结果/关闭/审计齐备", async () => {
  mode = "success";
  const { runNativeMaintenance } = await load();
  const options = fixture();
  const result = await runNativeMaintenance(options);
  assert.equal(result.status, "succeeded");
  assert.equal(queried.options.resume, "c1");
  assert.deepEqual(queried.inputs, []);
  assert.equal(queried.closed, true);
  assert.equal(queried.options.tools.length, 0);
  assert.ok(queried.options.plugins.some((x) => x.path === "/bundled/observer"));
  assert.equal(options.env.DSH_CLAUDE_BRIDGE, undefined);
  assert.deepEqual(options.session.snapshotEvents(), []);
  assert.deepEqual(options.session.factRecords.filter((x) => x.type === "claude-code/native-operation").map((x) => x.data.state),
    ["pending", "claimed", "observed", "succeeded"]);
  await assert.rejects(fetch(queried.url));
});

for (const failure of ["early-exit", "wrong-session"]) {
  test(`${failure} 不能在没有原生完成凭据时成功`, async () => {
    mode = failure;
    const { runNativeMaintenance } = await load();
    const options = fixture();
    await assert.rejects(runNativeMaintenance(options), (error) => error.code === "failed");
    assert.equal(queried.closed, true);
    assert.equal(options.session.factRecords.at(-1).data.state, "failed");
    await assert.rejects(fetch(queried.url));
  });
}

test("领取后的取消先关闭查询/桥，结果保持 uncertain 且不重投", async () => {
  mode = "hold"; claimed = Promise.withResolvers();
  const { runNativeMaintenance } = await load();
  const options = fixture();
  const result = runNativeMaintenance(options);
  const rejection = assert.rejects(result, (error) => error.code === "cancelled" && error.uncertain === true);
  await claimed.promise;
  options.abort.abort();
  await rejection;
  assert.equal(queried.closed, true);
  assert.equal(options.session.factRecords.at(-1).data.state, "uncertain");
  await assert.rejects(fetch(queried.url));
  claimed = undefined;
});

test("维护总超时不会遗留活查询", async () => {
  mode = "hold";
  const { runNativeMaintenance } = await load();
  const options = fixture({ mods: { enabled: true, maintenanceTimeoutMs: 60 } });
  await assert.rejects(runNativeMaintenance(options), (error) => error.code === "timeout");
  assert.equal(queried.closed, true);
  await assert.rejects(fetch(queried.url));
});

test("原生观察审计失败不能虚报成功或暴露异常详情", async () => {
  mode = "success";
  const { runNativeMaintenance } = await load();
  const options = fixture();
  options.session.rejectFact = (record) => { if (record.data.state === "observed") throw new Error("sensitive disk failure"); };
  await assert.rejects(runNativeMaintenance(options), (error) => error.uncertain === true && !error.message.includes("sensitive"));
  assert.equal(queried.closed, true);
});

test("关闭 Mods 或缺少明确 Claude session 时不启动 SDK", async () => {
  const { runNativeMaintenance } = await load();
  for (const options of [fixture({ mods: { enabled: false } }), { ...fixture(), claudeSessionId: undefined }]) {
    queried = undefined;
    await assert.rejects(runNativeMaintenance(options));
    assert.equal(queried, undefined);
  }
});
