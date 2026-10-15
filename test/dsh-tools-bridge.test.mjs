// test/dsh-tools-bridge.test.mjs — DSH 工具按精确白名单桥给 Claude。
import { test, mock } from "node:test";
import assert from "node:assert/strict";

let captured = [];
mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    query: () => (async function* empty() {})(),
    tool: (name, description, inputSchema, handler) => ({ name, description, inputSchema, handler }),
    createSdkMcpServer: (options) => { captured = options.tools ?? []; return { name: options.name, tools: captured }; },
  },
});
const { selectBridgedTools, mapToolResult, buildDshToolsServer, DSH_TOOL_SERVER_NAME } = await import("../lib/dsh-tools-bridge.mjs");

// ctx.tools.schemas(agent) 的真实形态：defineTool 已把方言转成标准 JSON Schema。
const HOST_SCHEMAS = [
  { name: "present", description: "Declare deliverables", parameters: { type: "object", properties: { files: { type: "array" } }, required: ["files"] } },
  { name: "job_list", description: "List jobs", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "job_kill", description: "Kill a job", parameters: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] } },
  { name: "job_output", description: "Read job output", parameters: { type: "object", properties: {} } },
  // Claude 自带对等物的那些：不该被桥过去（下面用默认白名单断言），且这里给一条来验证过滤。
  { name: "bash", description: "Run a command", parameters: { type: "object", properties: {} } },
  { name: "skill", description: "Load a skill", parameters: { type: "object", properties: {} } },
];

test("白名单精确匹配：只挑点名的工具，未知名字静默忽略", () => {
  assert.deepEqual(selectBridgedTools(HOST_SCHEMAS, ["present", "nope"]).map((t) => t.name), ["present"]);
  assert.deepEqual(selectBridgedTools(HOST_SCHEMAS, []), []);
  // 不放行整段前缀，也不做「全部可见工具」放行。
  assert.deepEqual(selectBridgedTools(HOST_SCHEMAS, ["job_"]).map((t) => t.name), []);
});

test("schema 原样取自宿主，不做二次转换", () => {
  const [present] = selectBridgedTools(HOST_SCHEMAS, ["present"]);
  assert.deepEqual(present.inputSchema, HOST_SCHEMAS[0].parameters);
  assert.equal(present.inputSchema, HOST_SCHEMAS[0].parameters, "必须是同一个对象，避免悄悄改写");
  // 没有 parameters 的 schema 不参与（拿不到可呈现的入参表）。
  assert.deepEqual(selectBridgedTools([{ name: "present" }], ["present"]), []);
});

test("注册的 server 只含默认白名单里的工具，且不含 Claude 已有的对等工具", () => {
  const ctx = { tools: { schemas: () => HOST_SCHEMAS, execute: async () => ({ content: [] }) } };
  const built = buildDshToolsServer({ ctx, agent: { id: "a1" } });
  assert.equal(built.server.name, DSH_TOOL_SERVER_NAME);
  assert.deepEqual(built.names, ["present", "job_list", "job_kill", "job_output"]);
  assert.equal(captured.some((t) => t.name === "bash" || t.name === "skill"), false);
});

test("调用走宿主的执行管线，参数与归属原样传递", async () => {
  const calls = [];
  const agent = { id: "a1", status: "running" };
  const ctx = {
    agents: { get: () => agent },
    tools: {
      schemas: () => HOST_SCHEMAS,
      execute: async (exec) => { calls.push(exec); return { content: [{ type: "text", text: "done" }], isError: false }; },
    },
  };
  const built = buildDshToolsServer({ ctx, agent, names: ["job_kill"] });
  built.observe({ type: "assistant", parent_tool_use_id: null, message: { content: [
    { type: "tool_use", id: "cli-job-kill", name: "mcp__dsh__job_kill" },
  ] } }, { isMain: true });
  const result = await captured[0].handler({ job_id: "j1" }, { _meta: { "claudecode/toolUseId": "cli-job-kill" } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "job_kill");
  assert.equal(calls[0].agent, agent, "必须带上归属，DSH 的权限/CAS 靠它定位");
  assert.deepEqual(calls[0].arguments, { job_id: "j1" });
  assert.deepEqual(result, { content: [{ type: "text", text: "done" }], isError: false });
});

test("宿主工具报错时结果标 isError；空 content 也给出可渲染的块", async () => {
  const agent = { id: "a1", status: "running" };
  const ctx = { agents: { get: () => agent }, tools: { schemas: () => HOST_SCHEMAS, execute: async () => ({ content: [{ type: "text", text: "boom" }], isError: true }) } };
  const built = buildDshToolsServer({ ctx, agent, names: ["present"] });
  built.observe({ type: "assistant", parent_tool_use_id: null, message: { content: [
    { type: "tool_use", id: "cli-present", name: "mcp__dsh__present" },
  ] } }, { isMain: true });
  assert.deepEqual(await captured[0].handler({ files: [] }, { _meta: { "claudecode/toolUseId": "cli-present" } }), { content: [{ type: "text", text: "boom" }], isError: true });
  assert.deepEqual(mapToolResult({ content: [] }), { content: [{ type: "text", text: "" }], isError: false });
});

test("没有可桥工具时不注册 server（不空转）；宿主缺 tools 服务时同样静默", () => {
  assert.equal(buildDshToolsServer({ ctx: { tools: { schemas: () => HOST_SCHEMAS } }, agent: { id: "a1" }, names: [] }), undefined);
  assert.equal(buildDshToolsServer({ ctx: { tools: { schemas: () => [] } }, agent: { id: "a1" } }), undefined);
  assert.equal(buildDshToolsServer({ ctx: {}, agent: { id: "a1" } }), undefined);
  assert.equal(buildDshToolsServer({ ctx: { tools: { schemas: () => { throw new Error("no scope"); } } }, agent: { id: "a1" } }), undefined);
});

test("宿主服务经 ctx.get('tools') 取得（真实访问形态），ctx.tools 只作兜底", () => {
  // 实测踩过：插件的 loopCtx 不把 tools 暴露成直接属性，直接 `ctx.tools?.schemas` 读不到任何工具，
  // server 静默不注册（header 里连一个 mcp__dsh__* 都没有）。
  const registry = { schemas: () => HOST_SCHEMAS, execute: async () => ({ content: [] }) };
  const viaGet = { get: (key) => (key === "tools" ? registry : undefined) };
  assert.deepEqual(buildDshToolsServer({ ctx: viaGet, agent: { id: "a1" } }).names, ["present", "job_list", "job_kill", "job_output"]);

  const throwing = { get: () => { throw new Error("no such service"); }, tools: registry };
  assert.deepEqual(buildDshToolsServer({ ctx: throwing, agent: { id: "a1" } }).names, ["present", "job_list", "job_kill", "job_output"]);
});
