// 有界、无正文的原生观察；SDK 继续独占 transcript 和子会话创建。
import { z } from "zod";
import { pluginFacts } from "./plugin-facts.mjs";
const id = z.string().min(1).max(256);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const duration = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const name = id.refine(value => !/\s/.test(value) && !value.startsWith("/"), "invalid native command name");
const command = z.strictObject({ name, description: z.string().max(512), source: z.enum(["builtin", "plugin", "user", "mcp"]), plugin: id.optional() });
const skill = z.strictObject({ name, description: z.string().max(512), argumentHint: z.string().max(512), aliases: z.array(name).max(16).optional() });
export const COMMAND_SNAPSHOT_SCHEMA = z.strictObject({ commands: z.array(command).max(128), truncated: z.boolean() });
const CATALOG = z.strictObject({ commands: z.array(command).max(128).optional(), skills: z.array(skill).max(128).optional(), truncated: z.boolean(),
  skillsObserved: z.boolean().optional(), commandsSource: z.literal("mod-command-list").optional(), skillsSource: z.literal("sdk-reload-skills").optional() });
export const CONTEXT_SCHEMA = z.strictObject({ window: count.positive(), tokens: count.optional(), percent: z.number().finite().min(0).max(100).optional(),
  totalTokens: count.optional(), rawMaxTokens: count.positive().optional(), model: id.optional(),
  categories: z.array(z.strictObject({ name: z.string().min(1).max(128), tokens: count, kind: z.enum(["used", "free", "buffer", "deferred"]) })).max(32).optional(),
  estimated: z.literal(true), detail: z.literal("summary"), truncated: z.boolean() });
const usage = z.strictObject({ input_tokens: count.optional(), output_tokens: count.optional(), cache_creation_input_tokens: count.optional(), cache_read_input_tokens: count.optional() });
export const OBSERVATION_SCHEMA = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("spawn"), nativeAgentId: id, toolUseId: id.optional(), parentNativeAgentId: id.optional(), model: id,
    subagentType: z.string().max(128).optional(), workflow: z.boolean() }),
  z.strictObject({ kind: z.literal("step"), turnId: id, index: count, model: id, modelSource: z.enum(["response", "request"]),
    messageCount: count, appendCount: count, toolCount: count, stopReason: z.string().max(64).nullable(), usage: usage.optional() }),
  z.strictObject({ kind: z.literal("complete"), turnId: id, reason: z.enum(["answer", "aborted", "refusal", "error"]), isAborted: z.boolean(), durationMs: duration }),
  z.strictObject({ kind: z.literal("unavailable"), capability: z.enum(["context", "catalog", "usage"]) }),
]);
function bounded(schema, value, bytes) {
  const parsed = schema.parse(value);
  if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > bytes) throw new RangeError("native metadata exceeds byte budget");
  return parsed;
}
export const normalizeContext = value => bounded(CONTEXT_SCHEMA, value, 64 * 1024);
export const normalizeCatalog = value => bounded(CATALOG, value, 256 * 1024);

function projectSkills(values) {
  if (!Array.isArray(values)) throw new TypeError("SDK skills must be an array");
  let truncated = values.length > 128;
  const skills = [];
  const names = new Set();
  for (const value of values.slice(0, 128)) {
    if (!name.safeParse(value?.name).success || names.has(value.name)) { truncated = true; continue; }
    const description = typeof value.description === "string" ? value.description : "";
    const argumentHint = typeof value.argumentHint === "string" ? value.argumentHint : "";
    const aliases = Array.isArray(value.aliases) ? value.aliases.filter(x => name.safeParse(x).success).slice(0, 16) : undefined;
    if (description.length > 512 || argumentHint.length > 512 || value.aliases?.length > 16) truncated = true;
    const entry = { name: value.name, description: description.slice(0, 512), argumentHint: argumentHint.slice(0, 512), ...(aliases ? { aliases } : {}) };
    skills.push(entry); names.add(entry.name);
    if (Buffer.byteLength(JSON.stringify(skills), "utf8") > 96 * 1024) { skills.pop(); truncated = true; break; }
  }
  return { skills, truncated };
}

export function readNativeSnapshots(session) {
  const events = pluginFacts(session).events();
  const context = events.findLast(event => event.type === "claude-code/native-context")?.data?.snapshot;
  const catalog = events.findLast(event => event.type === "claude-code/native-catalog")?.data?.snapshot;
  return { ...(context ? { context: normalizeContext(context) } : {}), ...(catalog ? { catalog: normalizeCatalog(catalog) } : {}) };
}

export function createNativeMetadata({ session, epoch, subagents }) {
  let closed = false;
  let catalogState = { skillsObserved: false };
  let commandTruncated = false, skillTruncated = false;
  let lastCatalog, lastContext;
  const identities = new Map();
  const toolNatives = new Map();
  const record = (type, data) => {
    if (closed) throw new Error("native metadata observer is closed");
    return pluginFacts(session).append(type, { epoch, ...data });
  };
  const saveCatalog = () => {
    const snapshot = normalizeCatalog({ ...catalogState, truncated: commandTruncated || skillTruncated });
    const digest = JSON.stringify(snapshot);
    if (digest !== lastCatalog) { record("claude-code/native-catalog", { snapshot }); lastCatalog = digest; }
  };
  const saveIdentity = (info) => {
    let projectedSessionId = null;
    let attribution = info.conflicted ? "ambiguous" : "unresolved";
    if (!info.conflicted && !info.workflow && info.toolUseId) {
      const projected = subagents?.childSessionIdForToolUseId?.(info.toolUseId);
      if (typeof projected === "string" && projected && projected !== session.id) { projectedSessionId = projected; attribution = "projected"; }
    }
    info.projectedSessionId = projectedSessionId;
    const snapshot = { nativeAgentId: info.nativeAgentId, model: info.model, workflow: info.workflow,
      ...(info.toolUseId ? { toolUseId: info.toolUseId } : {}), ...(info.parentNativeAgentId ? { parentNativeAgentId: info.parentNativeAgentId } : {}),
      projectedSessionId, attribution };
    const digest = JSON.stringify(snapshot);
    if (digest !== info.last) { record("claude-code/agent-identity", snapshot); info.last = digest; }
  };
  const attributionFor = (callerAgentId) => {
    if (callerAgentId === null) return { projectedSessionId: session.id, attribution: "main" };
    const entries = [...identities.values()].filter(info => info.nativeAgentId === callerAgentId);
    const projected = new Set(entries.filter(info => !info.conflicted && info.projectedSessionId).map(info => info.projectedSessionId));
    if (entries.some(info => info.conflicted) || projected.size > 1) return { projectedSessionId: null, attribution: "ambiguous" };
    return projected.size === 1 ? { projectedSessionId: [...projected][0], attribution: "projected" } : { projectedSessionId: null, attribution: "unresolved" };
  };
  return {
    context(value) {
      const snapshot = normalizeContext(value); const digest = JSON.stringify(snapshot);
      if (digest !== lastContext) { record("claude-code/native-context", { source: "mod-summary", snapshot }); lastContext = digest; }
    },
    catalog(value) {
      if (closed) throw new Error("native metadata observer is closed");
      const snapshot = bounded(COMMAND_SNAPSHOT_SCHEMA, value, 128 * 1024);
      commandTruncated = snapshot.truncated;
      catalogState = { ...catalogState, commands: snapshot.commands, commandsSource: "mod-command-list" };
      saveCatalog();
    },
    skills(values) {
      if (closed) throw new Error("native metadata observer is closed");
      const snapshot = projectSkills(values); skillTruncated = snapshot.truncated;
      catalogState = { ...catalogState, skills: snapshot.skills, skillsObserved: true, skillsSource: "sdk-reload-skills" };
      saveCatalog();
    },
    invalidateSkills() {
      if (closed) throw new Error("native metadata observer is closed");
      const { skillsSource, ...kept } = catalogState;
      catalogState = { ...kept, skills: [], skillsObserved: false };
      skillTruncated = false;
      saveCatalog();
    },
    observe(value, { callerAgentId = null } = {}) {
      if (closed) throw new Error("native metadata observer is closed");
      const data = OBSERVATION_SCHEMA.parse(value);
      if (data.kind === "spawn") {
        if ((data.parentNativeAgentId ?? null) !== callerAgentId) throw new Error("native spawn parent identity mismatch");
        const key = `${data.nativeAgentId}\0${data.toolUseId ?? ""}`;
        if (!identities.has(key) && identities.size >= 4096) throw new RangeError("native identity budget exhausted");
        let info = identities.get(key);
        if (info && info.parentNativeAgentId !== data.parentNativeAgentId) info.conflicted = true;
        if (!info) { info = { ...data }; identities.set(key, info); }
        if (data.toolUseId) {
          const natives = toolNatives.get(data.toolUseId) ?? new Set(); natives.add(data.nativeAgentId); toolNatives.set(data.toolUseId, natives);
          if (natives.size > 1) for (const entry of identities.values()) if (entry.toolUseId === data.toolUseId) { entry.conflicted = true; saveIdentity(entry); }
        }
        saveIdentity(info);
      } else {
        record("claude-code/native-observation", { ...data, callerAgentId, ...attributionFor(callerAgentId) });
      }
    },
    afterMessage() {
      if (closed || typeof subagents?.childSessionIdForToolUseId !== "function") return;
      for (const info of identities.values()) if (info.toolUseId && !info.projectedSessionId && !info.conflicted && !info.workflow) saveIdentity(info);
    },
    close() { closed = true; identities.clear(); toolNatives.clear(); },
  };
}
