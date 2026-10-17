import { test } from "node:test";
import assert from "node:assert/strict";
import { createModHost } from "../lib/mod-host.mjs";
import { createNativeOperation } from "../lib/native-operation.mjs";

async function setup(options = {}) {
  const session = { id: "s1" };
  const agent = { id: "a1", status: "running" };
  const host = await createModHost({ session, agent, epoch: "e1", ...options });
  let counter = 0;
  const envelope = (method, params = {}, extra = {}) => ({ sessionId: "s1", agentId: "a1", epoch: "e1",
    callerAgentId: null, claudeSessionId: "c1", requestId: `r${++counter}`, method, params, ...extra });
  const send = (body, token = host.token, headers = {}) => fetch(host.url, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const hello = await send(envelope("handshake", { protocol: 1 }));
  try { assert.equal(hello.status, 200); }
  catch (error) { await host.close(); throw error; }
  return { host, session, agent, envelope, send };
}

test("桥只监听 loopback；错误令牌、身份、子代理、未知方法 fail closed", async () => {
  const fixture = await setup();
  const { host, agent, envelope, send } = fixture;
  try {
    assert.equal(new URL(host.url).hostname, "127.0.0.1");
    assert.equal((await send(envelope("get_goal"), "wrong")).status, 401);
    for (const extra of [{ sessionId: "other" }, { agentId: "other" }, { epoch: "old" }, { callerAgentId: "child" }, { claudeSessionId: "other" }]) {
      assert.equal((await send(envelope("get_goal", {}, extra))).status, 403);
    }
    assert.equal((await send(envelope("arbitrary-host-call"))).status, 404);
    assert.equal((await send(envelope("get_goal"), host.token, { origin: "https://evil.example" })).status, 403);
    agent.status = "idle";
    assert.equal((await send(envelope("handshake", { protocol: 1 }))).status, 403);
  } finally { await host.close(); }
});

test("handshake bind 不等于工具加载成功；ready 必须显式确认", async () => {
  const { host, envelope, send } = await setup({ goalHandlers: { get_goal: async () => ({ content: [] }) } });
  try {
    let ready = false;
    host.ready.then(() => { ready = true; });
    await Promise.resolve();
    assert.equal(ready, false);
    const response = await send(envelope("handshake", { protocol: 1, ready: true }));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).value.tools.map((tool) => tool.name), ["get_goal"]);
    assert.equal((await host.ready).claudeSessionId, "c1");
  } finally { await host.close(); }
});

test("重放与并发同 requestId 只调用一次，改参数复用 id 被拒", async () => {
  let calls = 0;
  const fixture = await setup({ goalHandlers: { get_goal: async () => { calls += 1; return { content: [{ type: "text", text: "goal" }] }; } } });
  const { host, send, envelope } = fixture;
  try {
    const request = envelope("get_goal");
    const responses = await Promise.all([send(request), send(request)]);
    assert.equal(responses[0].status, 200);
    assert.deepEqual(await responses[0].json(), await responses[1].json());
    assert.equal(calls, 1);
    assert.equal((await send({ ...request, method: "update_goal" })).status, 409);
    assert.equal(calls, 1);
  } finally { await host.close(); }
});

test("请求字节/JSON/字段预算受限，prompt 只接受真实 sections", async () => {
  let snapshots = 0;
  const fixture = await setup({ onPrompt: () => { snapshots += 1; return { digest: "snapshot" }; } });
  const { host, send, envelope } = fixture;
  try {
    assert.equal((await send("{" )).status, 400);
    assert.equal((await send(" ".repeat(600000))).status, 413);
    assert.equal((await send(envelope("prompt_snapshot", { sections: [{ id: "system", text: "real", scope: "shared" }], model: "model" }))).status, 200);
    assert.equal(snapshots, 1);
    for (const params of [{ text: "guessed" }, { sections: [{ id: "system", text: 42, scope: "shared" }] }, { sections: [], complete: true }]) {
      assert.equal((await send(envelope("prompt_snapshot", params))).status, 400);
    }
    assert.equal(snapshots, 1);
  } finally { await host.close(); }
});

test("方法超时留有缓存失败，不重复执行；close / abort 回收服务器", async () => {
  let calls = 0;
  const abort = new AbortController();
  const fixture = await setup({ signal: abort.signal, requestTimeoutMs: 30,
    goalHandlers: { get_goal: () => { calls += 1; return new Promise(() => {}); } } });
  const { host, envelope, send } = fixture;
  const request = envelope("get_goal");
  assert.equal((await send(request)).status, 408);
  assert.equal((await send(request)).status, 408);
  assert.equal(calls, 1);
  abort.abort();
  await host.close();
  await assert.rejects(send(envelope("get_goal")));
});

test("没有 prompt 记录器时不声称支持 capture，也不回答快照成功", async () => {
  const { host, envelope, send } = await setup();
  try {
    const response = await send(envelope("handshake", { protocol: 1 }));
    assert.equal((await response.json()).value.capture, false);
    assert.equal((await send(envelope("prompt_snapshot", { sections: [] }))).status, 404);
  } finally { await host.close(); }
});

test("prompt 持久化失败不回答成功", async () => {
  const { host, envelope, send } = await setup({ onPrompt: () => { throw new Error("write rejected"); } });
  try {
    assert.equal((await send(envelope("prompt_snapshot", { sections: [] }))).status, 500);
  } finally { await host.close(); }
});

test("维护模式用精确租约准入 idle，且不广告或执行 goal/prompt 方法", async () => {
  let live = true;
  let goalCalls = 0;
  const operation = createNativeOperation({ id: "op1", action: "compact", claudeSessionId: "c1", record() {} });
  const { host, envelope, send } = await setup({ agent: { id: "a1", status: "idle" },
    maintenance: { operation, isLive: () => live },
    goalHandlers: { get_goal: () => { goalCalls += 1; } }, onPrompt: () => {} });
  try {
    const hello = (await (await send(envelope("handshake", { protocol: 1, ready: true }))).json()).value;
    assert.deepEqual(hello.tools, []);
    assert.equal(hello.capture, false);
    assert.deepEqual(hello.maintenance, { operationId: "op1", action: "compact", params: {} });
    assert.equal((await host.ready).claudeSessionId, "c1");
    for (const method of ["get_goal", "prompt_snapshot"]) assert.equal((await send(envelope(method))).status, 404);
    assert.equal(goalCalls, 0);
    assert.equal((await send(envelope("maintenance_claim", { operationId: "wrong" }))).status, 403);
    assert.equal((await send(envelope("maintenance_claim", { operationId: "op1", arbitrary: true }))).status, 400);
    assert.equal((await send(envelope("maintenance_claim", { operationId: "op1" }, { claudeSessionId: "other" }))).status, 403);
    const claimRequest = envelope("maintenance_claim", { operationId: "op1" });
    const claim = await send(claimRequest);
    assert.equal((await claim.json()).value.execute, true);
    const replay = await send(claimRequest);
    assert.equal((await replay.json()).value.execute, false, "cached execution permit must not be delivered twice");
    const duplicate = await send(envelope("maintenance_claim", { operationId: "op1" }));
    assert.equal((await duplicate.json()).value.execute, false);
    const result = { status: "succeeded", messageCount: 1, tokensBefore: 100 };
    assert.equal((await send(envelope("maintenance_complete", { operationId: "op1", result }))).status, 500);
    assert.equal((await send(envelope("maintenance_observe", { operationId: "op1", result }))).status, 403);
    assert.equal((await send(envelope("maintenance_observe", { operationId: "op1", result }), host.observerToken)).status, 200);
    assert.equal((await send(envelope("maintenance_claim", { operationId: "op1" }), host.observerToken)).status, 403);
    const receipt = await send(envelope("maintenance_result", { operationId: "op1" }));
    assert.deepEqual((await receipt.json()).value, result);
    assert.equal((await send(envelope("maintenance_complete", { operationId: "op1", result }))).status, 200);
    assert.deepEqual(await operation.result, result);
    live = false;
    assert.equal((await send(envelope("handshake", { protocol: 1 }))).status, 403);
  } finally { await host.close(); }
});

test("normal runtime 只广告显式能力，child 仅能调用精确允许方法", async () => {
  const calls = [];
  const runtime = { capabilities: { tools: true }, dshDefinitions: () => [], has: (method) => ["runtime_step", "runtime_check"].includes(method),
    allowsChild: (method) => method === "runtime_check", parse: (_method, params) => {
      if (Object.keys(params).length) throw new Error("extra input"); return params;
    }, invoke: async (method, _params, origin) => { calls.push({ method, ...origin }); return { decision: "abstain" }; } };
  const { host, envelope, send } = await setup({ runtime });
  try {
    const hello = (await (await send(envelope("handshake", { protocol: 1 }))).json()).value;
    assert.deepEqual(hello.runtime, { tools: true });
    assert.deepEqual(hello.dshTools, []);
    assert.equal((await send(envelope("runtime_check", {}, { callerAgentId: "child" }))).status, 200);
    assert.equal(calls[0].callerAgentId, "child");
    assert.equal((await send(envelope("runtime_step", {}, { callerAgentId: "child" }))).status, 403);
    assert.equal((await send(envelope("get_goal", {}, { callerAgentId: "child" }))).status, 403);
    assert.equal((await send(envelope("runtime_step", { source: "forged" }))).status, 400);
    assert.equal((await send(envelope("runtime_unknown"))).status, 404);
  } finally { await host.close(); }
});

test("human runtime RPC 使用独立等待预算，不被短 body 超时截断", async () => {
  const runtime = { capabilities: { tools: true }, has: method => method === "runtime_tool", allowsChild: () => false,
    parse: (_m, params) => params, timeoutMs: () => 200,
    invoke: async () => { await new Promise(resolve => setTimeout(resolve, 45)); return { decision: "allow" }; } };
  const { host, envelope, send } = await setup({ runtime, requestTimeoutMs: 25 });
  try { assert.equal((await send(envelope("runtime_tool"))).status, 200); }
  finally { await host.close(); }
});

test("普通桥不接受维护请求，维护桥拒绝初始 Claude session 不匹配", async () => {
  const normal = await setup();
  try { assert.equal((await normal.send(normal.envelope("maintenance_claim", { operationId: "op1" }))).status, 404); }
  finally { await normal.host.close(); }
  const operation = createNativeOperation({ id: "op1", action: "compact", claudeSessionId: "expected", record() {} });
  const host = await createModHost({ session: { id: "s1" }, agent: { id: "a1", status: "running" }, epoch: "e1",
    maintenance: { operation, isLive: () => true } });
  try {
    const response = await fetch(host.url, { method: "POST", headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", agentId: "a1", epoch: "e1", callerAgentId: null, claudeSessionId: "wrong",
        requestId: "r1", method: "handshake", params: { protocol: 1 } }) });
    assert.equal(response.status, 403);
  } finally { await host.close(); }
});
