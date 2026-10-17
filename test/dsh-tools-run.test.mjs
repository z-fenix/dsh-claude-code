import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { attachFacts } from "./helpers/plugin-facts.mjs";

let options;
let duringQuery;
mock.module("@anthropic-ai/claude-agent-sdk", { namedExports: {
  tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
  createSdkMcpServer: (server) => server,
  query: (request) => {
    options = request.options;
    return (async function* () {
      for await (const input of request.prompt) {
        if (duringQuery) yield* duringQuery();
        yield { type: "result", subtype: "success", result: "done", user_message_uuid: input.uuid };
        return;
      }
    })();
  },
} });
const { runClaudeCode } = await import("../lib/claude-run.mjs");

function fixture() {
  const agent = { id: "bridge-run", status: "running" };
  const events = [];
  const session = attachFacts({ id: "bridge-run-session", snapshotEvents: () => events,
    append(type, data, opts) { const e = { type, data, ...opts, seq: events.length }; events.push(e); return e; } });
  agent.session = session;
  return { ctx: { agents: { get: () => agent }, get: (name) => name === "tools" ? {
    schemas: () => [{ name: "job_list", parameters: { type: "object", properties: {} } }],
    execute: async () => ({ content: [{ type: "text", text: "jobs" }] }),
  } : undefined }, session, agent, config: { goal: { enabled: false }, mods: { enabled: false }, dshTools: { enabled: true } },
  signal: new AbortController().signal, turn: 1, prompt: "run", executable: "never-spawn", env: {}, cwd: "/fixture" };
}

test("runner 只为成功写入主轨迹的 tool/call 放行父 scope，禁用子代理投影也不放行 child", async (t) => {
  const args = fixture();
  const calls = [];
  args.ctx.get = name => name === "tools" ? {
    schemas: () => [{ name: "job_list", parameters: { type: "object", properties: {} } }],
    execute: async exec => { calls.push(exec); return { content: [] }; },
  } : undefined;
  args.config.subagents = { enabled: false };
  let mainResult, childResult;
  duringQuery = async function* () {
    const handler = options.mcpServers.dsh.tools[0].handler;
    yield { type: "assistant", parent_tool_use_id: null, message: {
      id: "main-message", role: "assistant", content: [{ type: "tool_use", id: "main-list", name: "mcp__dsh__job_list", input: {} }],
    } };
    mainResult = await handler({}, { _meta: { "claudecode/toolUseId": "main-list" } });
    yield { type: "assistant", parent_tool_use_id: "agent-call", message: {
      id: "child-message", role: "assistant", content: [{ type: "tool_use", id: "child-list", name: "mcp__dsh__job_list", input: {} }],
    } };
    childResult = await handler({}, { _meta: { "claudecode/toolUseId": "child-list" } });
  };
  t.after(() => { duringQuery = undefined; });
  const result = await runClaudeCode(args);
  assert.equal(result.stopReason, "completed");
  assert.equal(mainResult.isError, false);
  assert.equal(childResult.isError, true);
  assert.deepEqual(calls.map(exec => exec.callId), ["main-list"]);
});

test("查询结束后，即使 agent 仍显示 running，旧桥也不能执行", async () => {
  const result = await runClaudeCode(fixture());
  assert.equal(result.stopReason, "completed");
  const handler = options.mcpServers.dsh.tools[0].handler;
  assert.equal((await handler({}, { _meta: { "claudecode/toolUseId": "late-call" } })).isError, true);
});

test("runner 收尾等待已取消的宿主工具静默，再返回给 agent", async (t) => {
  const args = fixture();
  const started = Promise.withResolvers();
  let quiet = false; let pending;
  args.ctx.get = name => name === "tools" ? {
    schemas: () => [{ name: "job_list", parameters: { type: "object", properties: {} } }],
    execute: async exec => {
      started.resolve();
      await new Promise(resolve => exec.signal.addEventListener("abort", () => setTimeout(resolve, 20), { once: true }));
      quiet = true;
      return { content: [{ type: "text", text: "cancelled" }], isError: true };
    },
  } : undefined;
  duringQuery = async function* () {
    yield { type: "assistant", parent_tool_use_id: null, message: { id: "in-flight", role: "assistant",
      content: [{ type: "tool_use", id: "live-list", name: "mcp__dsh__job_list", input: {} }] } };
    pending = options.mcpServers.dsh.tools[0].handler({}, { _meta: { "claudecode/toolUseId": "live-list" } });
    await started.promise;
  };
  t.after(async () => { duringQuery = undefined; await pending; });
  await runClaudeCode(args);
  assert.equal(quiet, true);
});

test("非法桥配置以回合错误结束并清理 abort 监听器", async () => {
  const args = fixture();
  args.config.dshTools.names = "present";
  const result = await runClaudeCode(args);
  assert.equal(result.stopReason, "error");
  assert.equal(getEventListeners(args.signal, "abort").length, 0);
});

test("关闭桥时不注册 MCP server；仅精确放行本轮注册的工具", async () => {
  const args = fixture();
  args.config.dshTools.enabled = false;
  await runClaudeCode(args);
  assert.equal(options.mcpServers, undefined);
  args.config.dshTools.enabled = true;
  await runClaudeCode(args);
  assert.deepEqual(Object.keys(options.mcpServers), ["dsh"]);
  assert.equal((await options.canUseTool("mcp__dsh__job_list", {})).behavior, "allow");
  assert.equal((await options.canUseTool("mcp__dsh__job_kill", {})).behavior, "deny");
  assert.equal((await options.canUseTool("mcp__dsh__job_list_extra", {})).behavior, "deny");
});
