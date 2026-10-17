// 显式手动运行的零推理探针：临时 profile + 本地拒绝型 API + 截断 compact summarizer。
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveClaude } from "../lib/auth.mjs";
import { createNativeOperation } from "../lib/native-operation.mjs";
import { createModHost } from "../lib/mod-host.mjs";
import { MOD_PATH } from "../lib/mod-options.mjs";

const requestedCommand = process.argv[2];
if (requestedCommand !== undefined && !["status", "cost"].includes(requestedCommand)) throw new Error("probe accepts only status or cost");
const root = await mkdtemp(join(process.cwd(), ".dsh-diag", "native-startup-"));
const plugin = join(root, "fixture-plugin");
const cwd = join(root, "workspace");
await Promise.all([mkdir(join(plugin, ".claude-plugin"), { recursive: true }), mkdir(join(plugin, "hooks"), { recursive: true }), mkdir(cwd), mkdir(join(root, "profile"))]);
await writeFile(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "native-startup-probe", version: "0.1.0" }));
await writeFile(join(plugin, "hooks", "hooks.json"), JSON.stringify({ modules: ["./probe.mjs"] }));
await writeFile(join(plugin, "hooks", "probe.mjs"), `
async function report($, data) {
  await $.http.fetch(await $.env.get("DSH_PROBE_URL"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
}
export function register(on) {
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    if (await $.env.get("DSH_PROBE_MODE") === "seed") {
      await report($, { event: "seed-start", sessionId: await $.session.id() });
    } else if (await $.env.get("DSH_PROBE_MODE") === "diagnostic") {
      $.clock.after(1, async () => {
        const count = (await $.session.messages()).length;
        try {
          const value = await $.command.run({ command: "compact" });
          await report($, { event: "diagnostic", count, value });
        } catch (error) { await report($, { event: "diagnostic", count, error: String(error.message) }); }
      });
    }
    return result;
  });
  on("session.compact", async ($, e) => {
    await report($, { event: "compact", sessionId: await $.session.id(), trigger: e.trigger, count: e.messages.length,
      hasFixture: e.messages.some(m => m.text.includes("DSH OFFLINE COMPACT FIXTURE")) });
    return { skip: "offline probe blocks summarizer" };
  });
  on("turn.step", async function* ($, e) {
    await report($, { event: await $.env.get("DSH_PROBE_MODE") === "seed" ? "fixture-step" : "forbidden-model-step" });
    yield { kind: "text", index: 0, text: "Offline fixture answer" };
    yield { kind: "stop", stopReason: "end_turn", usage: null };
    return { turnId: e.turnId, index: e.index, answer: "Offline fixture answer", toolUses: [], stopReason: "end_turn", usage: null };
  });
  on("model.complete", () => ({ deny: "offline probe forbids model calls" }));
}
`);

let apiRequests = 0;
const reports = [];
let seed;
const seeded = Promise.withResolvers();
const compacted = Promise.withResolvers();
const diagnostic = Promise.withResolvers();
const api = createServer(async (req, res) => {
  if (req.url === "/probe" && req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    reports.push(data);
    res.writeHead(200, { "content-type": "application/json" }); res.end("{}");
    if (data.event === "seed") { seed = data; seeded.resolve(data); }
    if (data.event === "compact") compacted.resolve(data);
    if (data.event === "diagnostic") diagnostic.resolve(data);
  } else { apiRequests += 1; res.writeHead(403); res.end("offline probe forbids API traffic"); }
});
await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${api.address().port}`;
const resolved = await resolveClaude({ ctx: { get() {} }, config: {} });
const env = Object.fromEntries(Object.entries(resolved.env).filter(([key]) => !/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR|DSH_CLAUDE_BRIDGE)/.test(key)));
for (const key of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR)/.test(key)) env[key] = "";
Object.assign(env, { ANTHROPIC_API_KEY: "offline-probe-not-a-secret", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "", ANTHROPIC_BASE_URL: base,
  CLAUDE_CONFIG_DIR: join(root, "profile"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DSH_PROBE_URL: `${base}/probe`, NO_COLOR: "1" });
const errors = [];
async function start(extra, until) {
  const end = Promise.withResolvers();
  const input = { async *[Symbol.asyncIterator]() {
    if (extra.env.DSH_PROBE_MODE === "seed") yield { type: "user", session_id: "", parent_tool_use_id: null,
      message: { role: "user", content: "DSH OFFLINE COMPACT FIXTURE" } };
    await end.promise;
  } };
  const abort = new AbortController();
  const stderr = [];
  const q = query({ prompt: input, options: { cwd, pathToClaudeCodeExecutable: resolved.executable,
    env: { ...env, ...extra.env }, settingSources: [], strictMcpConfig: true, mcpServers: {},
    plugins: [...(extra.plugins ?? []), { type: "local", path: plugin }],
    persistSession: true, abortController: abort, stderr: (line) => stderr.push(line), ...extra.options } });
  const read = (async () => {
    try {
      for await (const message of q) {
        if (extra.env.DSH_PROBE_MODE === "seed" && message.type === "result") {
          seed = { event: "seed", sessionId: message.session_id, count: 1 };
          reports.push(seed); seeded.resolve(seed);
        }
      }
    } catch (error) { errors.push(String(error.message)); }
  })();
  let timeout;
  try {
    await Promise.race([until, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("startup probe timed out")), 20000); })]);
  } finally {
    clearTimeout(timeout);
    end.resolve();
    let closeTimer;
    try { await Promise.race([read, new Promise((resolve) => { closeTimer = setTimeout(() => { abort.abort(); q.close(); resolve(); }, 3000); })]); }
    finally { clearTimeout(closeTimer); q.close(); await read; await writeFile(join(root, `${extra.env.DSH_PROBE_MODE}-stderr.log`), stderr.join("\n")); }
  }
}
let host;
let result;
try {
  await start({ env: { DSH_PROBE_MODE: "seed" }, options: { sessionId: randomUUID() } }, seeded.promise);
  if (!seed?.sessionId || seed.count < 1) throw new Error("fixture was not stored");
  const operation = createNativeOperation({ id: randomUUID(), action: requestedCommand ? "command" : "compact", params: requestedCommand ? { command: requestedCommand } : {}, claudeSessionId: seed.sessionId,
    record: (data) => reports.push({ event: "operation", ...data }) });
  host = await createModHost({ session: { id: "offline-probe" }, agent: { id: "offline-agent", status: "idle" }, epoch: "offline-epoch",
    maintenance: { operation, isLive: () => true } });
  await start({ env: { DSH_PROBE_MODE: "resume", DSH_CLAUDE_BRIDGE: JSON.stringify({ url: host.url, token: host.token,
    sessionId: "offline-probe", agentId: "offline-agent", epoch: "offline-epoch" }),
    DSH_CLAUDE_COMPACT_OBSERVER: JSON.stringify({ url: host.url, token: host.observerToken,
      sessionId: "offline-probe", agentId: "offline-agent", epoch: "offline-epoch", operationId: operation.id }) },
    plugins: [{ type: "local", path: MOD_PATH }, { type: "local", path: join(MOD_PATH, "..", "dsh-compact-observer") }],
    options: { resume: seed.sessionId } }, operation.result);
  const observed = reports.find((report) => report.event === "compact");
  const outcome = await operation.result;
  const valid = requestedCommand ? outcome.status === "succeeded"
    : observed?.hasFixture && observed.sessionId === seed.sessionId && outcome.status === "skipped";
  if (!valid || apiRequests !== 0 || reports.some((report) => report.event === "forbidden-model-step")) {
    result = { supported: false, command: requestedCommand, apiRequests, reports, errors, outcome };
    process.exitCode = 1;
  } else result = { supported: true, ...(requestedCommand ? { command: requestedCommand } : {}), apiRequests, observed, outcome, errors };
} catch (error) {
  if (!requestedCommand && seed?.sessionId) {
    try { await start({ env: { DSH_PROBE_MODE: "diagnostic" }, options: { resume: seed.sessionId } }, diagnostic.promise); }
    catch (diagnosticError) { errors.push(String(diagnosticError.message)); }
  }
  result = { supported: false, apiRequests, reports, errors, reason: String(error.message) }; process.exitCode = 1;
}
finally { await host?.close(); await new Promise((resolve) => api.close(resolve)); }
await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ root, ...result }, null, 2));
