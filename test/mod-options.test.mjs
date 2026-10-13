import { test, mock } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { RunInputChannel } from "../lib/run-input.mjs";
import { attachFacts } from "./helpers/plugin-facts.mjs";
let commandError;
let commandGate;
const commands = [];
mock.module("node:child_process", { namedExports: { ...childProcess, execFile: (file, args, options, callback) => {
  commands.push({ file, args, options });
  let finished = false;
  const done = (error) => {
    if (finished) return;
    finished = true;
    options.signal?.removeEventListener("abort", aborted);
    callback(error, "Validation passed; 3 pass\n0 fail", "");
  };
  const aborted = () => done(new Error("probe canceled"));
  options.signal?.addEventListener("abort", aborted, { once: true });
  if (options.signal?.aborted) queueMicrotask(aborted);
  else if (commandGate) void commandGate.promise.then(() => done(commandError));
  else queueMicrotask(() => done(commandError));
  return { kill() {} };
} } });
const { buildModOptions, probeModSupport, MOD_PATH } = await import("../lib/mod-options.mjs");
const queries = [];
let handshake = true;
let captureFailure = false;
mock.module("@anthropic-ai/claude-agent-sdk", { namedExports: {
  createSdkMcpServer: (options) => options,
  tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
  query: ({ prompt, options }) => {
    const output = new RunInputChannel();
    const record = { options, input: [], closes: 0 };
    queries.push(record);
    void (async () => {
      const descriptor = options.env.DSH_CLAUDE_BRIDGE ? JSON.parse(options.env.DSH_CLAUDE_BRIDGE) : undefined;
      const call = (method, params, requestId) => fetch(descriptor.url, { method: "POST",
        headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
        body: JSON.stringify({ sessionId: descriptor.sessionId, agentId: descriptor.agentId, epoch: descriptor.epoch,
          callerAgentId: null, claudeSessionId: "c1", requestId, method, params }),
      });
      if (descriptor && handshake) {
        await call("handshake", { protocol: 1 }, "bind");
        await call("handshake", { protocol: 1, ready: true }, "ready");
      }
      for await (const input of prompt) {
        record.input.push(input);
        if (descriptor && handshake) await call("prompt_snapshot", { model: "model", sections: [{ id: "system", text: "observed", scope: "shared" }] }, "snapshot");
        if (captureFailure) {
          const notice = { type: "system", subtype: "ui_log", plugin: "dsh-bridge", session_id: "c1",
            text: "dsh-bridge: prompt capture disabled (snapshot unavailable)." };
          output.push({ ...notice, plugin: "other-plugin" });
          output.push({ ...notice, session_id: "other-session" });
          output.push(notice);
          output.push(notice);
        }
        output.push({ type: "result", subtype: "success", result: "done", user_message_uuid: input.uuid });
        output.end();
        return;
      }
    })().catch(() => output.close());
    return { [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](), interrupt: async () => undefined,
      close: () => { record.closes += 1; output.close(); } };
  },
} });
const { runClaudeCode } = await import("../lib/claude-run.mjs");
function runOptions(config) {
  const agent = { id: "a1", status: "running" };
  const events = [];
  const session = attachFacts({ id: "s1", snapshotEvents: () => events, append(type, data, options) {
    const event = { type, data, ...options, seq: events.length }; events.push(event); return event;
  } });
  return { ctx: { get: (name) => name === "goals" ? { get: () => undefined } : undefined,
    agents: { get: () => agent }, logger: { warn() {} } }, session, agent, config, turn: 1,
    turnContext: () => ({ hasHumanMessage: true }), signal: new AbortController().signal,
    executable: "runtime-cli", env: { EXISTING: "yes" }, cwd: "/w", prompt: "u1",
    initialMessages: [{ id: "u1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "u1" }] }],
  };
}

test("引擎默认启用按能力的捕获且 goal 默认 MCP，部分配置保留默认值", async () => {
  const { claudeCodeEngine } = await import("../index.mjs");
  const ctx = new Context();
  const session = attachFacts({ id: "s1", header: { cwd: "/w" }, snapshotEvents: () => [] });
  const agent = claudeCodeEngine.makeAgent(ctx, "s1", {}, session, { traceSubagents: false,
    mods: { handshakeTimeoutMs: 25 }, goal: { defaultMaxGoalRounds: 64 } });
  try {
    assert.equal(agent.config.mods.enabled, true);
    assert.equal(agent.config.mods.handshakeTimeoutMs, 25);
    assert.equal(agent.config.goal.transport, "mcp");
    assert.equal(agent.config.goal.blockedAfterConsecutiveRounds, 3);
  } finally { await agent.dispose(); }
});

test("包发布包含 mod 文件", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(manifest.files.includes("mods"));
});

test("默认 MCP；mod 只追加到子进程且保留已有环境/插件", () => {
  const env = { PATH: "path", CLAUDE_CODE_PLUGIN_DIRS: "other-dir" };
  const plugin = { type: "local", path: "/existing" };
  const bridge = { url: "http://127.0.0.1:1/bridge", token: "secret", sessionId: "s1", agentId: "a1", epoch: "e1" };
  const result = buildModOptions({ config: { mods: { enabled: true }, plugins: [plugin] }, env, bridge, supported: true });
  assert.equal(result.goalTransport, "mcp");
  assert.deepEqual(result.sdkOptions.plugins, [plugin, { type: "local", path: MOD_PATH }]);
  assert.equal(result.sdkOptions.env.CLAUDE_CODE_PLUGIN_DIRS, "other-dir");
  assert.deepEqual(JSON.parse(result.sdkOptions.env.DSH_CLAUDE_BRIDGE), bridge);
  assert.equal(env.DSH_CLAUDE_BRIDGE, undefined);
});

test("goal adapter 单选；disabled / 老 CLI 都回 MCP，不加载 mod", () => {
  for (const transport of ["mod", "auto"]) {
    const config = { mods: { enabled: true }, goal: { transport } };
    assert.equal(buildModOptions({ config, supported: true, env: {}, bridge: {} }).goalTransport, "mod");
    const unsupported = buildModOptions({ config, supported: false, env: {} });
    assert.equal(unsupported.goalTransport, "mcp");
    assert.equal(unsupported.sdkOptions.plugins, undefined);
    assert.equal(unsupported.sdkOptions.env.DSH_CLAUDE_BRIDGE, undefined);
    assert.equal(buildModOptions({ config: { ...config, mods: { enabled: false } }, supported: true, env: {} }).goalTransport, "mcp");
  }
  assert.throws(() => buildModOptions({ config: { goal: { transport: "invalid" } }, env: {} }), /transport/);
});

test("capability 用所选 executable 的 validate/test 证明，不按版本猜；失败显式不支持", async () => {
  commands.length = 0;
  commandError = undefined;
  assert.equal((await probeModSupport({ executable: "selected-cli", env: { EXISTING: "yes" } })).supported, true);
  assert.deepEqual(commands.map((entry) => entry.args.slice(0, 2)), [["plugin", "validate"], ["plugin", "test"]]);
  assert.ok(commands.every((entry) => entry.file === "selected-cli"));
  assert.equal(commands[0].options.env.EXISTING, "yes");
  assert.equal(commands[0].options.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  commandError = new Error("unknown plugin command test");
  const result = await probeModSupport({ executable: "older-cli", env: {} });
  assert.equal(result.supported, false);
  assert.match(result.reason, /unknown plugin command/);
  commandError = undefined;
});

test("取消的能力检查不永久毒化同一 executable 的缓存", async () => {
  const abort = new AbortController();
  commandError = new Error("probe aborted");
  abort.abort();
  assert.equal((await probeModSupport({ executable: "cancelled-cli", env: {}, signal: abort.signal })).supported, false);
  commandError = undefined;
  assert.equal((await probeModSupport({ executable: "cancelled-cli", env: {} })).supported, true);
});

test("共享探测取消首个调用者不会使仍活跃的调用者降级", async () => {
  const abort = new AbortController();
  const gate = Promise.withResolvers();
  commandGate = gate;
  const a = probeModSupport({ executable: "shared-owner", env: {}, signal: abort.signal });
  const b = probeModSupport({ executable: "shared-owner", env: {} });
  try {
    abort.abort();
    gate.resolve();
    assert.equal((await a).supported, false);
    assert.equal((await b).supported, true);
  } finally { gate.resolve(); commandGate = undefined; await Promise.all([a, b]); }
});

test("共享探测的后加入调用者取消后立即返回，不等待首个探测", async () => {
  const abort = new AbortController();
  const gate = Promise.withResolvers();
  commandGate = gate;
  const a = probeModSupport({ executable: "shared-subscriber", env: {} });
  const b = probeModSupport({ executable: "shared-subscriber", env: {}, signal: abort.signal });
  try {
    abort.abort();
    const beforeRelease = await Promise.race([
      b.then((result) => ({ finished: true, supported: result.supported })),
      new Promise((resolve) => setImmediate(() => resolve({ finished: false }))),
    ]);
    assert.deepEqual(beforeRelease, { finished: true, supported: false });
    gate.resolve();
    assert.equal((await a).supported, true);
  } finally { gate.resolve(); commandGate = undefined; await Promise.all([a, b]); }
});

test("真实 runner 单选 mod goal，握手后记录 observed-compose，不写原生 system", async () => {
  queries.length = 0;
  const options = runOptions({ mods: { enabled: true }, goal: { transport: "mod" } });
  const result = await runClaudeCode(options);
  assert.equal(result.stopReason, "completed");
  assert.equal(queries.length, 1);
  assert.equal(queries[0].options.mcpServers, undefined);
  assert.ok(queries[0].options.plugins.some((plugin) => plugin.path === MOD_PATH));
  const approve = queries[0].options.canUseTool;
  assert.equal((await approve("mcp__dsh-bridge__get_goal", {})).behavior, "allow");
  assert.equal((await approve("mcp__goal__get_goal", {})).behavior, "deny");
  assert.equal((await approve("mcp__dsh-bridge__arbitrary", {})).behavior, "deny");
  assert.equal(options.env.DSH_CLAUDE_BRIDGE, undefined);
  const events = options.session.factEvents();
  assert.ok(events.some((event) => event.type === "claude-code/prompt-snapshot" && event.data.source === "observed-compose"));
  assert.ok(!events.some((event) => event.type === "system/message"));
});

test("捕获失效通知更新当前查询状态并脱敏告警，不打断主循环", async () => {
  captureFailure = true;
  queries.length = 0;
  const warnings = [];
  try {
    const options = runOptions({ mods: { enabled: true }, goal: { transport: "mod" } });
    options.ctx.logger = { warn: (text) => warnings.push(text) };
    assert.equal((await runClaudeCode(options)).stopReason, "completed");
    const disabled = options.session.factEvents().filter((event) => event.type === "claude-code/mod-status" && event.data.state === "capture-disabled");
    assert.equal(disabled.length, 1);
    assert.equal(disabled[0].data.capture, false);
    assert.equal(disabled[0].data.goalTransport, "mod");
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0], "dsh-claude-code: prompt capture disabled (snapshot unavailable); goal adapter unchanged");
    assert.equal(queries.length, 1);
    assert.equal(queries[0].input.length, 1);
  } finally { captureFailure = false; }
});

test("mod 启动握手失败时未发送输入便关闭，新的查询只用 MCP", async () => {
  queries.length = 0;
  handshake = false;
  try {
    const options = runOptions({ mods: { enabled: true, handshakeTimeoutMs: 20 }, goal: { transport: "mod" } });
    assert.equal((await runClaudeCode(options)).stopReason, "completed");
    assert.equal(queries.length, 2);
    assert.equal(queries[0].input.length, 0);
    assert.ok(queries[0].closes > 0);
    assert.equal(queries[1].input.length, 1);
    assert.ok(queries[1].options.mcpServers.goal);
    assert.equal(queries[1].options.plugins, undefined);
    assert.equal(queries[1].options.env.DSH_CLAUDE_BRIDGE, undefined);
  } finally { handshake = true; }
});

test("mod 不支持时状态仅保存在独立台账", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-mod-facts-"));
  const previous = process.env.DSH_CLAUDE_CODE_STORE;
  process.env.DSH_CLAUDE_CODE_STORE = root;
  commandError = new Error("unsupported plugin command");
  try {
    const options = runOptions({ mods: { enabled: true } });
    options.executable = "unsupported-status-cli";
    assert.equal((await runClaudeCode(options)).stopReason, "completed");
    assert.ok(options.session.snapshotEvents().every((event) => !event.type.startsWith("claude-code/")));
    assert.equal(options.session.factEvents().find((event) => event.type === "claude-code/mod-status").data.state, "unsupported");
  } finally {
    commandError = undefined;
    if (previous === undefined) delete process.env.DSH_CLAUDE_CODE_STORE; else process.env.DSH_CLAUDE_CODE_STORE = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

