// 实际 CLI + SDK + 本地固定 Messages stub；没有外部模型凭据或推理服务。
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveClaude } from "../lib/auth.mjs";
import { runClaudeCode } from "../lib/claude-run.mjs";
import { readNativeSnapshots } from "../lib/native-metadata.mjs";
import { apply as applyCommands } from "../lib/command-native.mjs";
import { attachFacts } from "./helpers/plugin-facts.mjs";

const mode = process.argv[2] ?? "routing";
if (!["routing", "dynamic", "skill", "files"].includes(mode)) throw new Error("probe mode must be routing, dynamic, skill or files");
const root = await mkdtemp(join(process.cwd(), ".dsh-diag", "native-runtime-"));
const cwd = join(root, "workspace"), profile = join(root, "profile");
await Promise.all([mkdir(cwd), mkdir(profile)]);
await writeFile(join(cwd, "probe.txt"), "OFFLINE READ FIXTURE\n");
const skillPlugin = join(root, "skill-plugin");
if (mode === "skill") {
  await mkdir(join(skillPlugin, ".claude-plugin"), { recursive: true });
  await mkdir(join(skillPlugin, "skills", "offline-skill"), { recursive: true });
  await writeFile(join(skillPlugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "offline-skill-probe", version: "0.1.0" }));
  await writeFile(join(skillPlugin, "skills", "offline-skill", "SKILL.md"), "---\nname: offline-skill\ndescription: Offline user-invoked fixture\n---\nOFFLINE_SKILL_BODY\nArguments: $ARGUMENTS\nRead no files and execute no commands.\n");
}
const requests = [], executed = [], fileGates = [], approvals = [];
const fileTarget = join(root, "outside-workspace.txt");
let countTokenRequests = 0, toolSchemas = [], mainRequests = 0, revokedAttempt = false, revokedRejected = false;
const present = "mcp__dsh-bridge__present";
const presentDefinition = { name: "present", description: "Declare the offline fixture", parameters: {
  type: "object", additionalProperties: false, properties: { files: { type: "array", items: { type: "object", additionalProperties: false,
    properties: { path: { type: "string" } }, required: ["path"] } } }, required: ["files"],
} };
const api = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { response.writeHead(400); response.end(); return; }
  if (request.url?.startsWith("/v1/messages/count_tokens")) {
    countTokenRequests += 1; response.writeHead(200, { "content-type": "application/json" }); response.end('{"input_tokens":42}'); return;
  }
  if (!request.url?.startsWith("/v1/messages")) { response.writeHead(404); response.end("offline stub"); return; }
  const encoded = JSON.stringify(body);
  const offeredPresent = body.tools?.some(tool => tool.name === present) ?? false;
  requests.push({ model: body.model, effort: body.output_config?.effort, policy: encoded.includes("OFFLINE_PLAN_POLICY"),
    skillBody: encoded.includes("OFFLINE_SKILL_BODY"), skillArgs: encoded.includes("arg-line-1") && encoded.includes("arg-line-2"),
    offeredPresent, toolCount: body.tools?.length ?? 0 });
  let content = [{ type: "text", text: "OFFLINE RUNTIME RESPONSE" }];
  if (mode === "files" && body.tools?.length) {
    mainRequests += 1;
    if (mainRequests === 1) content = [{ type: "tool_use", id: "call-write", name: "Write", input: { content: "ORIGINAL", file_path: fileTarget } }];
    if (mainRequests === 2) content = [{ type: "tool_use", id: "call-edit", name: "Edit", input: { new_string: "CHANGED", old_string: "FILTERED", file_path: fileTarget } }];
  }
  if (mode === "dynamic" && body.tools?.length) {
    mainRequests += 1;
    if (!executed.length) {
      toolSchemas = [presentDefinition];
      if (offeredPresent) content = [{ type: "tool_use", id: "call-present", name: present, input: { files: [{ path: "probe.txt" }] } }];
      else if (mainRequests < 6) content = [{ type: "tool_use", id: `call-read-${mainRequests}`, name: "Read", input: { file_path: join(cwd, "probe.txt") } }];
    } else if (!revokedAttempt) {
      revokedAttempt = true;
      content = [{ type: "tool_use", id: "call-present-revoked", name: present, input: { files: [{ path: "probe.txt" }] } }];
    } else {
      revokedRejected = body.messages?.some(message => Array.isArray(message.content)
        && message.content.some(block => block.type === "tool_result" && block.tool_use_id === "call-present-revoked" && block.is_error === true)) ?? false;
    }
  }
  const stop = content.some(block => block.type === "tool_use") ? "tool_use" : "end_turn";
  const message = { id: `msg_${randomUUID().replaceAll("-", "")}`, type: "message", role: "assistant", model: body.model,
    content, stop_reason: stop, stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
  if (!body.stream) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(message)); return; }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const event = value => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  event({ type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } });
  for (const [index, block] of content.entries()) {
    if (block.type === "text") {
      event({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      event({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else {
      event({ type: "content_block_start", index, content_block: { ...block, input: {} } });
      event({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    }
    event({ type: "content_block_stop", index });
  }
  event({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 2 } });
  event({ type: "message_stop" }); response.end();
});
await new Promise(resolve => api.listen(0, "127.0.0.1", resolve));
const resolved = await resolveClaude({ ctx: { get() {} }, config: {} }); const env = { ...resolved.env };
for (const key of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR)/.test(key)) env[key] = "";
Object.assign(env, { ANTHROPIC_API_KEY: "offline-probe-not-a-secret", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "",
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.address().port}`, CLAUDE_CONFIG_DIR: profile,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "" });
const events = [{ seq: 0, time: 1, type: "sandbox/mode", data: { mode: "workspace-write" } }];
let header, context, pending, switched = false;
const session = attachFacts({ id: `session-${randomUUID()}`, header: { cwd }, snapshotEvents: () => events,
  requestHeader: () => header, requestContext: () => context,
  append(type, data, options) {
    const event = { seq: events.length, time: Date.now(), type, data, ...options }; events.push(event);
    if (type === "request/header") header = data.header;
    if (type === "request/context") context = data;
    return event;
  } }, [], record => {
  if (record.type === "claude-code/mod-status" && record.data.state === "ready" && !switched) {
    switched = true; pending = ["routing", "skill"].includes(mode);
    session.append("model/selection", { provider: "claude-code", model: "claude-opus-4-6", reasoningEffort: "low" });
  }
});
const config = { mods: { enabled: true, handshakeTimeoutMs: 15000, skills: { allowed: [] } }, goal: { enabled: false }, persistSession: false,
  ...(mode === "dynamic" ? { dshTools: { enabled: true, transport: "mod", names: ["present"] } } : {}),
  ...(mode === "skill" ? { plugins: [{ type: "local", path: skillPlugin }] } : {}) };
const queued = [];
const agent = { id: "runtime-probe-agent", status: "running", options: { model: "claude-sonnet-4-6" }, session, config,
  nativeSnapshots: () => readNativeSnapshots(session), followup: message => queued.push(message) };
const planMode = { section: "OFFLINE_PLAN_POLICY: stay in plan mode and call exit_plan_mode for review.",
  get: () => ({ active: events.filter(x => x.type === "plan/mode").at(-1)?.data.active ?? false, ...(pending === undefined ? {} : { pending }) }),
  set(_agent, value) { pending = value; return "queued"; } };
const registry = { wireSchemas: () => ({ schemas: toolSchemas }), execute: async exec => {
  executed.push({ callId: exec.callId, name: exec.name, agentId: exec.agent.id }); toolSchemas = [];
  return { content: [{ type: "text", text: "OFFLINE_PRESENTED" }], isError: false };
} };
const warnings = [];
const ctx = { get: name => name === "planMode" ? planMode : name === "agents" ? { get: () => agent } : name === "tools" ? registry
  : name === "approval" ? { request: async request => {
    if (mode !== "files" || !["Write", "Edit"].includes(request.toolName) || !request.reason?.includes(fileTarget)) return "denied";
    approvals.push(request.toolName); return "allowed-once";
  } } : undefined,
  waterfall: async (...args) => {
    const execution = args.find(value => value && typeof value === "object" && Object.hasOwn(value, "arguments"));
    if (!execution || execution.arguments.file_path !== fileTarget) return { kind: "deny", reason: "offline fixture path required" };
    fileGates.push({ callId: execution.callId, name: execution.name });
    if (execution.name === "write") execution.arguments.content = "FILTERED";
    return { kind: "allow" };
  },
  logger: { info() {}, warn: text => warnings.push(text) } };
const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 90000);
const run = (text, turn = 1, input) => runClaudeCode({ ctx, session, agent, executable: resolved.executable, env, cwd, config,
  turn, prompt: text, signal: abort.signal,
  initialMessages: [input ?? { id: randomUUID(), role: "user", source: { kind: "user" }, content: [{ type: "text", text }] }] });
let report; const cleanup = [];
try {
  let result = await run("OFFLINE RUNTIME PROBE");
  let skillQueued = false;
  if (mode === "skill") {
    const catalog = readNativeSnapshots(session).catalog;
    const skill = catalog?.skills?.find(entry => entry.name === "offline-skill" || entry.name.endsWith(":offline-skill"));
    if (!skill) throw new Error("fixture skill is not in the SDK skill catalog");
    config.mods.skills.allowed = [skill.name];
    const definitions = new Map();
    applyCommands({ get: name => name === "commands" ? { register: definition => { definitions.set(definition.name, definition); return () => {}; } } : ctx.get(name),
      effect(factory) { for (const dispose of factory()) cleanup.push(dispose); } });
    const response = await definitions.get("claude-skill").handler({ agent, rawInput: `${skill.name} arg-line-1\n  arg-line-2`,
      commandId: "offline-skill-command", signal: abort.signal, attachments: [] });
    if (response.kind !== "success" || queued.length !== 1) throw new Error("human skill command did not queue exactly one user input");
    skillQueued = true;
    result = await run(queued[0].content[0].text, 2, queued[0]);
  }
  const main = requests.filter(request => request.toolCount > 0);
  const controls = session.factRecords.filter(x => x.type === "claude-code/step-control").map(x => x.data);
  const snapshots = readNativeSnapshots(session);
  const unavailable = session.factRecords.filter(x => x.type === "claude-code/native-observation" && x.data.kind === "unavailable").map(x => x.data.capability);
  let ok = result.stopReason === "completed" && main.length >= 1 && main.every(x => x.model === "claude-opus-4-6" && x.effort === "low")
    && countTokenRequests === 0 && snapshots.context?.categories?.length > 0 && snapshots.catalog?.skillsObserved === true;
  if (mode === "routing") ok &&= main.some(x => x.policy) && controls.some(x => x.planActive);
  if (mode === "dynamic") ok &&= main.some(x => x.offeredPresent) && executed.length === 1 && executed[0].callId === "call-present" && revokedRejected;
  if (mode === "skill") ok &&= skillQueued && main.some(x => x.skillBody && x.skillArgs);
  let fileContent = null;
  if (mode === "files") {
    // 两处入口（Mod tool.check 与 SDK 权限）对同一 callId 只派发一次 host gate、只审批一次。
    const byCall = fileGates.reduce((all, gate) => all.set(gate.callId, (all.get(gate.callId) ?? 0) + 1), new Map());
    fileContent = await readFile(fileTarget, "utf8").catch(() => null);
    ok &&= byCall.size === 2 && [...byCall.values()].every(n => n === 1)
      && approvals.length === 2 && approvals[0] === "Write" && approvals[1] === "Edit" && fileContent === "CHANGED";
  }
  report = { supported: ok, mode, externalInference: false, requests, controls, countTokenRequests, executed, revokedRejected, skillQueued,
    ...(mode === "files" ? { fileGates, approvals, fileContent } : {}),
    context: snapshots.context, catalog: { commands: snapshots.catalog?.commands?.length, skills: snapshots.catalog?.skills?.length, skillsObserved: snapshots.catalog?.skillsObserved },
    unavailable, stopReason: result.stopReason, output: result.output, warningCount: warnings.length, nativeTypes: [...new Set(events.map(x => x.type))] };
  if (!ok) process.exitCode = 1;
} catch (error) { report = { supported: false, mode, externalInference: false, requests, error: String(error.message), warnings }; process.exitCode = 1; }
finally {
  clearTimeout(timer); abort.abort();
  for (const dispose of cleanup.toReversed()) await dispose();
  await new Promise(resolve => { api.close(resolve); api.closeAllConnections(); });
}
await writeFile(join(root, "result.json"), JSON.stringify(report, null, 2));
await writeFile(join(root, "warnings.log"), warnings.join("\n"));
console.log(JSON.stringify({ root, ...report }, null, 2));
