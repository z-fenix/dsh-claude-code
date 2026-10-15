// 真实 SDK 注册与 MCP 调用：不能用直通 mock 掩盖 JSON Schema / Zod 的边界。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDshToolsServer } from "../lib/dsh-tools-bridge.mjs";

const schemas = [
  { name: "present", description: "Declare deliverables", parameters: {
    type: "object", additionalProperties: false,
    properties: { files: { type: "array", items: {
      type: "object", additionalProperties: false,
      properties: { path: { type: "string" }, description: { type: "string" } }, required: ["path"],
    } } }, required: ["files"],
  } },
  { name: "job_list", description: "List jobs", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "job_output", description: "Read output", parameters: {
    type: "object", additionalProperties: false,
    properties: { job_id: { type: "string" }, wait: { type: "boolean" }, timeout_ms: { type: "number" } }, required: ["job_id"],
  } },
  { name: "job_kill", description: "Kill job", parameters: {
    type: "object", additionalProperties: false,
    properties: { job_id: { type: "string" }, reason: { type: "string" } }, required: ["job_id"],
  } },
  { name: "bash", parameters: { type: "object", properties: {} } },
];

// 本机内存 transport 只搬 JSON-RPC 消息；注册、schema 投影、校验、执行都由真实 SDK 处理。
async function connect(server, t) {
  let nextId = 0;
  const pending = new Map();
  const transport = {
    async start() {},
    async close() {},
    async send(message) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    },
  };
  await server.connect(transport);
  t.after(() => server.close());
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    transport.onmessage({ jsonrpc: "2.0", id, method, params });
  });
  await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bridge-test", version: "1.0.0" } });
  transport.onmessage({ jsonrpc: "2.0", method: "notifications/initialized" });
  return request;
}

function build(execute) {
  const agent = { id: "sdk-agent", status: "running" };
  return buildDshToolsServer({ ctx: { tools: { schemas: () => schemas, execute }, agents: { get: () => agent } }, agent });
}

const callMeta = (id = "cli-call-1") => ({ "claudecode/toolUseId": id });
const assistantCall = (id, name, parent = null) => ({
  type: "assistant", parent_tool_use_id: parent,
  message: { content: [{ type: "tool_use", id, name: `mcp__dsh__${name}`, input: {} }] },
});
const observeMain = (built, id, name) => built.observe(assistantCall(id, name), { isMain: true });

test("子代理继承的工具不能以父 agent 的目录、会话和 jobs 归属执行", async (t) => {
  const calls = [];
  const built = build(async (exec) => { calls.push(exec); return { content: [] }; });
  const request = await connect(built.server.instance, t);
  for (const [id, parent, isMain] of [
    ["child-present", "agent-parent-call", false],
    ["misclassified-child", "agent-parent-call", true],
    ["unadmitted-main", null, false],
  ]) {
    built.observe(assistantCall(id, "present", parent), { isMain });
    const result = await request("tools/call", { name: "present", arguments: { files: [{ path: "report.txt" }] }, _meta: callMeta(id) });
    assert.equal(result.isError, true, id);
  }
  assert.equal(calls.length, 0, "不得将 child-only 或未入主轨迹的 callId 转交父 agent");
});

test("调用先于 assistant 事件到达时等待归属，不先执行宿主工具", async (t) => {
  const calls = [];
  const built = build(async (exec) => { calls.push(exec); return { content: [] }; });
  const request = await connect(built.server.instance, t);
  const pending = request("tools/call", { name: "job_list", arguments: {}, _meta: callMeta("early-main") });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 0);
  observeMain(built, "early-main", "job_list");
  assert.equal((await pending).isError, false);
  assert.equal(calls[0].callId, "early-main");
});

test("未知归属在关闭时失败；有主查询 ID 也不能替换工具名", async (t) => {
  const calls = [];
  const built = build(async (exec) => { calls.push(exec); return { content: [] }; });
  const request = await connect(built.server.instance, t);
  observeMain(built, "main-list", "job_list");
  const wrongName = await request("tools/call", { name: "job_kill", arguments: { job_id: "j1" }, _meta: callMeta("main-list") });
  assert.equal(wrongName.isError, true);
  const pending = request("tools/call", { name: "job_list", arguments: {}, _meta: callMeta("unknown") });
  await new Promise(resolve => setImmediate(resolve));
  built.close();
  assert.equal((await pending).isError, true);
  assert.equal(calls.length, 0);
});

test("未确认调用在有界超时后拒绝，不默认使用父 scope", async (t) => {
  const calls = [];
  const built = build(async exec => { calls.push(exec); return { content: [] }; });
  const request = await connect(built.server.instance, t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = request("tools/call", { name: "job_list", arguments: {}, _meta: callMeta("unconfirmed") });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(5001);
  assert.equal((await pending).isError, true);
  assert.equal(calls.length, 0);
});

test("归属等待被取消后即使主消息随后到达也不执行", async (t) => {
  const controller = new AbortController();
  const agent = { id: "waiting-agent", status: "running" };
  const calls = [];
  const built = buildDshToolsServer({ agent, signal: controller.signal, ctx: {
    agents: { get: () => agent }, tools: { schemas: () => schemas, execute: async exec => { calls.push(exec); return { content: [] }; } },
  } });
  const request = await connect(built.server.instance, t);
  const pending = request("tools/call", { name: "job_list", arguments: {}, _meta: callMeta("cancel-wait") });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  observeMain(built, "cancel-wait", "job_list");
  assert.equal((await pending).isError, true);
  assert.equal(calls.length, 0);
});

test("主调用等待期间 agent 被替换则拒绝执行", async (t) => {
  const agent = { id: "replaced-during-wait", status: "running" };
  let live = agent;
  const calls = [];
  const built = buildDshToolsServer({ agent, ctx: {
    agents: { get: () => live }, tools: { schemas: () => schemas, execute: async exec => { calls.push(exec); return { content: [] }; } },
  } });
  const request = await connect(built.server.instance, t);
  const pending = request("tools/call", { name: "job_list", arguments: {}, _meta: callMeta("replace-wait") });
  await new Promise(resolve => setImmediate(resolve));
  live = { ...agent };
  observeMain(built, "replace-wait", "job_list");
  assert.equal((await pending).isError, true);
  assert.equal(calls.length, 0);
});

test("宿主交付事件使用 CLI 的真实 tool-use id，而不是随机 ID", async (t) => {
  const calls = [];
  const built = build(async (exec) => { calls.push(exec); return { content: [] }; });
  const request = await connect(built.server.instance, t);
  observeMain(built, "call-present-1", "present");
  await request("tools/call", { name: "present", arguments: { files: [{ path: "report.txt" }] }, _meta: callMeta("call-present-1") });
  assert.equal(calls[0].callId, "call-present-1");
});

test("缺失调用身份、已取消或关闭的桥不执行宿主工具", async (t) => {
  const calls = [];
  const built = build(async (exec) => { calls.push(exec); return { content: [] }; });
  const request = await connect(built.server.instance, t);
  const missing = await request("tools/call", { name: "job_list", arguments: {} });
  assert.equal(missing.isError, true);
  built.close();
  const closed = await request("tools/call", { name: "job_list", arguments: {}, _meta: callMeta() });
  assert.equal(closed.isError, true);
  assert.equal(calls.length, 0);
});

test("已取消查询不执行宿主工具", async (t) => {
  const controller = new AbortController();
  const agent = { id: "cancelled", status: "running" };
  let calls = 0;
  const built = buildDshToolsServer({ ctx: { agents: { get: () => agent }, tools: {
    schemas: () => schemas, execute: async () => { calls++; return { content: [] }; },
  } }, agent, signal: controller.signal });
  const request = await connect(built.server.instance, t);
  controller.abort();
  const result = await request("tools/call", { name: "job_list", arguments: {}, _meta: callMeta() });
  assert.equal(result.isError, true);
  assert.equal(calls, 0);
});

test("工具桥不允许配置扩大到未审计的可见工具", () => {
  assert.throws(() => buildDshToolsServer({ ctx: { tools: { schemas: () => schemas } }, agent: { id: "a" }, names: ["bash"] }), /allowlist/);
  assert.throws(() => buildDshToolsServer({ names: "present" }), /array/);
});

test("PTC 折叠后的工具不被 MCP 重新开放", () => {
  const registry = { schemas: () => schemas, wireSchemas: () => ({ schemas: [{ name: "run_code", parameters: { type: "object", properties: {} } }] }) };
  assert.equal(buildDshToolsServer({ ctx: { tools: registry }, agent: { id: "ptc" } }), undefined);
});

test("注册后被替换的 agent 或被移除的工具都不能执行", async (t) => {
  const agent = { id: "live", status: "running" };
  let live = agent;
  let visible = schemas;
  const calls = [];
  const built = buildDshToolsServer({ ctx: { agents: { get: () => live }, tools: {
    schemas: () => visible, execute: async (exec) => { calls.push(exec); return { content: [] }; },
  } }, agent });
  const request = await connect(built.server.instance, t);
  live = { ...agent };
  assert.equal((await request("tools/call", { name: "job_list", arguments: {}, _meta: callMeta() })).isError, true);
  live = agent;
  visible = [];
  assert.equal((await request("tools/call", { name: "job_list", arguments: {}, _meta: callMeta() })).isError, true);
  assert.equal(calls.length, 0);
});

test("DSH 的 JSON Schema 能注册到真实 SDK 并呈现嵌套必填与可选参数", async (t) => {
  const built = build(async () => ({ content: [] }));
  const request = await connect(built.server.instance, t);
  const { tools } = await request("tools/list");
  assert.deepEqual(tools.map((tool) => tool.name), ["present", "job_list", "job_output", "job_kill"]);
  const present = tools.find((tool) => tool.name === "present").inputSchema;
  assert.deepEqual(present.required, ["files"]);
  assert.equal(present.additionalProperties, false);
  assert.equal(present.properties.files.type, "array");
  assert.deepEqual(present.properties.files.items.required, ["path"]);
  assert.equal(present.properties.files.items.additionalProperties, false);
  assert.equal(present.properties.files.items.properties.description.type, "string");
  const output = tools.find((tool) => tool.name === "job_output").inputSchema;
  assert.deepEqual(output.required, ["job_id"]);
  assert.equal(output.properties.wait.type, "boolean");
  assert.equal(output.properties.timeout_ms.type, "number");
});

test("真实 MCP 调用保留宿主参数与归属，无参工具仍可执行", async (t) => {
  const calls = [];
  const built = build(async (exec) => { calls.push(exec); return { content: [{ type: "text", text: "done" }] }; });
  const request = await connect(built.server.instance, t);
  observeMain(built, "cli-present", "present");
  observeMain(built, "cli-list", "job_list");
  const result = await request("tools/call", { name: "present", arguments: { files: [{ path: "report.txt", description: "Report" }] }, _meta: callMeta("cli-present") });
  assert.equal(result.isError, false);
  assert.deepEqual(result.content, [{ type: "text", text: "done" }]);
  assert.deepEqual(calls[0].arguments, { files: [{ path: "report.txt", description: "Report" }] });
  assert.equal(calls[0].agent.id, "sdk-agent");
  assert.equal(calls[0].name, "present");
  assert.equal(calls[0].callId, "cli-present");
  await request("tools/call", { name: "job_list", arguments: {}, _meta: callMeta("cli-list") });
  assert.deepEqual(calls[1].arguments, {});
  assert.equal(calls[1].name, "job_list");
});

test("MCP 校验拒绝缺失必填、错误类型与多余参数，不调用宿主工具", async (t) => {
  const calls = [];
  const built = build(async (exec) => { calls.push(exec); return { content: [] }; });
  const request = await connect(built.server.instance, t);
  for (const [name, args] of [
    ["present", { files: [{}] }],
    ["job_output", { job_id: "j1", wait: "yes" }],
    ["job_kill", {}],
    ["job_kill", { job_id: "j1", extra: true }],
  ]) {
    const result = await request("tools/call", { name, arguments: args, _meta: callMeta() });
    assert.equal(result.isError, true, `${name}: ${JSON.stringify(args)}`);
  }
  assert.equal(calls.length, 0);
});
