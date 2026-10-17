import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { RunInputChannel } from "../lib/run-input.mjs";
import { attachFacts } from "./helpers/plugin-facts.mjs";
const modOptions = await import("../lib/mod-options.mjs");
mock.module("../lib/mod-options.mjs", { namedExports: { ...modOptions, probeModSupport: async () => ({ supported: true }) } });
let record;
let onInput;
let useFile = false;
let noticePlugin;
let emitChildIdentity = false;
let runDsh = false;
mock.module("@anthropic-ai/claude-agent-sdk", { namedExports: {
  createSdkMcpServer: x => x, tool: (...args) => args,
  query: ({ prompt, options }) => {
    const output = new RunInputChannel();
    record = { options, modes: [], models: [], settings: [], input: [] };
    const q = { [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](), interrupt: async () => {}, close: () => output.close(),
      setPermissionMode: async value => record.modes.push(value), setModel: async value => record.models.push(value), applyFlagSettings: async value => record.settings.push(value),
      reloadSkills: async () => ({ skills: [{ name: "real-skill", description: "SDK skill", argumentHint: "<input>" }] }) };
    void (async () => {
      const bridge = JSON.parse(options.env.DSH_CLAUDE_BRIDGE); let sequence = 0;
      const send = async (method, params) => {
        const response = await fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
          body: JSON.stringify({ sessionId: bridge.sessionId, agentId: bridge.agentId, epoch: bridge.epoch,
            claudeSessionId: "c1", callerAgentId: null, requestId: `r${++sequence}`, method, params }) });
        if (!response.ok) throw new Error(`runtime RPC ${response.status}`);
        return (await response.json()).value;
      };
      record.hello = await send("handshake", { protocol: 1 });
      await send("handshake", { protocol: 1, ready: true });
      for await (const input of prompt) {
        record.input.push(input);
        onInput?.();
        record.policy = await send("runtime_policy", {});
        record.step = await send("runtime_step", { turnId: "turn1", index: 0, model: options.model ?? "initial", messageCount: 1 });
        if (useFile) {
          const args = { file_path: "/w/file", content: "body" };
          record.tool = await send("runtime_tool", { toolName: "Write", callId: "t1", input: args });
          record.permission = await options.canUseTool("Write", args, { toolUseID: "t1", blockedPath: "/w/file" });
          await send("runtime_tool_result", { toolName: "Write", callId: "t1", ok: true });
        }
        if (runDsh) {
          const args = { files: [{ path: "report.txt" }] };
          output.push({ type: "assistant", message: { id: "dsh-message", role: "assistant", model: "initial",
            content: [{ type: "tool_use", id: "dsh-call", name: "mcp__dsh-bridge__present", input: args }] } });
          record.dshPermission = await options.canUseTool("mcp__dsh-bridge__present", args, { toolUseID: "dsh-call" });
          record.dshResult = await send("runtime_dsh", { name: "present", callId: "dsh-call", args });
          output.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "dsh-call", content: record.dshResult.content }] } });
        }
        if (emitChildIdentity) {
          await send("runtime_observe", { kind: "spawn", nativeAgentId: "native-child", toolUseId: "call-child", model: "child-model", workflow: false });
          output.push({ type: "assistant", message: { id: "assistant-child", role: "assistant", model: "initial", usage: { input_tokens: 10, output_tokens: 2 },
            content: [{ type: "tool_use", id: "call-child", name: "Agent", input: { description: "identity" } }] } });
          output.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-child", content: "done" }] } });
        }
        if (noticePlugin) output.push({ type: "system", subtype: "ui_log", session_id: "c1", plugin: noticePlugin,
          text: "dsh-bridge: runtime control unavailable; request stopped." });
        output.push({ type: "result", subtype: "success", result: "done", user_message_uuid: input.uuid });
        output.end(); return;
      }
    })().catch(error => { record.error = error; output.close(); });
    return q;
  },
} });
const { runClaudeCode } = await import("../lib/claude-run.mjs");
function world(plan = false) {
  const events = [{ type: "sandbox/mode", data: { mode: "workspace-write" }, seq: 0, time: 1 }];
  if (plan) events.push({ type: "plan/mode", data: { active: true }, seq: 1, time: 2 });
  const session = attachFacts({ id: "runtime-run", header: { cwd: "/w" }, snapshotEvents: () => events,
    append(type, data, options) { const event = { type, data, seq: events.length, time: Date.now(), ...options }; events.push(event); return event; } });
  const agent = { id: "a1", status: "running", options: { model: "initial" }, session };
  let gates = 0;
  const planMode = { section: "Stay in plan mode; call exit_plan_mode.", get: () => ({ active: events.filter(x => x.type === "plan/mode").at(-1)?.data.active ?? false }), set() {} };
  const ctx = { get: name => name === "planMode" ? planMode : name === "agents" ? { get: () => agent } : undefined,
    waterfall: async () => { gates += 1; return { kind: "allow" }; }, logger: { warn() {} } };
  return { ctx, agent, session, events, get gates() { return gates; }, config: { mods: { enabled: true }, goal: { enabled: false } },
    signal: new AbortController().signal, executable: "runtime-cli", env: {}, cwd: "/w", turn: 1, prompt: "hi",
    initialMessages: [{ id: "u1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "hi" }] }] };
}

test("runner 挂接 runtime、逐步模型与共享 file gate，结束后旧许可失效", async () => {
  const w = world(); useFile = true;
  onInput = () => w.session.append("model/selection", { provider: "p", model: "chosen", reasoningEffort: "high" });
  try {
    const result = await runClaudeCode(w);
    assert.equal(record.error, undefined);
    assert.equal(result.stopReason, "completed");
    assert.equal(record.hello.runtime.step, true);
    assert.deepEqual(record.models, ["chosen"]);
    assert.deepEqual(record.settings, [{ effortLevel: "high" }]);
    assert.equal(record.step.routing.model, "chosen");
    assert.equal(record.permission.behavior, "allow");
    assert.equal(w.session.factRecords.findLast(x => x.type === "claude-code/native-catalog")?.data.snapshot.skillsSource, "sdk-reload-skills");
    assert.equal(w.gates, 1);
    assert.equal((await record.options.canUseTool("Write", {}, { toolUseID: "old" })).behavior, "deny");
  } finally { useFile = false; onInput = undefined; }
});

test("DSH Mod transport 从空 scope 动态开放已审计工具，不重复注册 MCP", async () => {
  const w = world(); useFile = false; runDsh = true;
  let schemas = []; const calls = [];
  const registry = { wireSchemas: () => ({ schemas }), execute: async exec => { calls.push(exec); return { content: [{ type: "text", text: "delivered" }], isError: false }; } };
  const originalGet = w.ctx.get;
  w.ctx.get = name => name === "tools" ? registry : originalGet(name);
  w.config.dshTools = { enabled: true, transport: "mod", names: ["present"] };
  onInput = () => { schemas = [{ name: "present", description: "Present", parameters: { type: "object", properties: { files: { type: "array", items: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }, required: ["files"] } }]; };
  try {
    const result = await runClaudeCode(w);
    assert.equal(record.error, undefined);
    assert.equal(result.stopReason, "completed");
    assert.equal(record.options.mcpServers, undefined);
    assert.deepEqual(record.hello.dshTools, []);
    assert.deepEqual(record.step.tools.map(x => x.name), ["present"]);
    assert.equal(record.dshPermission.behavior, "allow");
    assert.equal(record.dshResult.isError, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].callId, "dsh-call");
    assert.equal(calls[0].agent, w.agent);
  } finally { runDsh = false; onInput = undefined; }
});

test("提前到达的 native 子身份在 SDK 投影创建后补绑定", async () => {
  const w = world(); useFile = false; onInput = undefined; emitChildIdentity = true;
  const projected = new Map();
  w.subagents = { handleMessage: message => {
    if (message.type === "assistant") projected.set("call-child", "child-session");
    return false;
  }, childSessionIdForToolUseId: id => projected.get(id), finishRun() {} };
  try {
    assert.equal((await runClaudeCode(w)).stopReason, "completed");
    const identities = w.session.factRecords.filter(x => x.type === "claude-code/agent-identity");
    assert.equal(identities[0].data.projectedSessionId, null);
    assert.equal(identities.at(-1).data.projectedSessionId, "child-session");
    assert.equal(identities.length, 2);
  } finally { emitChildIdentity = false; }
});

test("可信 runtime 停止通知以可见错误结束，其他插件不能冒充", async () => {
  useFile = false; onInput = undefined;
  try {
    noticePlugin = "other-plugin";
    assert.equal((await runClaudeCode(world())).stopReason, "completed");
    noticePlugin = "dsh-bridge";
    const result = await runClaudeCode(world());
    assert.equal(result.stopReason, "error");
    assert.match(result.output[0].text, /runtime/i);
  } finally { noticePlugin = undefined; }
});

test("runner 的初始 native Plan 与 host policy 同步，不误广告宿主工具", async () => {
  const w = world(true); useFile = false; onInput = undefined;
  const result = await runClaudeCode(w);
  assert.equal(record.error, undefined);
  assert.equal(result.stopReason, "completed");
  assert.equal(record.options.permissionMode, "plan");
  assert.match(record.policy.text, /ExitPlanMode/);
  assert.ok(!record.policy.text.includes("exit_plan_mode"));
});
