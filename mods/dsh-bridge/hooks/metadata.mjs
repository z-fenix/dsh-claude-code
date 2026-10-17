// 非权威、无正文的 CLI 观察；失败只停观察，不重放模型、工具或 append。
import { callHost } from "./rpc.mjs";
const COUNTS = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];
function active(state, capability) { return state.bridge && state.capabilities?.[capability] === true && !state.observationFailed; }
function usageOf(usage) {
  if (!usage) return undefined;
  const value = {};
  for (const key of COUNTS) if (usage[key] !== undefined) {
    if (!Number.isSafeInteger(usage[key]) || usage[key] < 0) throw new Error("invalid usage counter");
    value[key] = usage[key];
  }
  return Object.keys(value).length ? value : undefined;
}
async function send($, state, method, params, callerAgentId = null) {
  if (!state.bridge || state.observationFailed) return false;
  try { await callHost($, state, method, params, callerAgentId); return true; }
  catch {
    state.observationFailed = true;
    try { $.ui.log("dsh-bridge: native observation disabled."); } catch {}
    return false;
  }
}
export async function captureCatalog($, state) {
  if (!active(state, "catalog")) return;
  try {
    const source = await $.command.list();
    let truncated = source.length > 128;
    const commands = [];
    for (const item of source.slice(0, 128)) {
      if (typeof item.name !== "string" || !item.name || item.name.length > 256 || !["builtin", "plugin", "user", "mcp"].includes(item.source)) { truncated = true; continue; }
      const description = typeof item.description === "string" ? item.description : "";
      if (description.length > 512) truncated = true;
      commands.push({ name: item.name, description: description.slice(0, 512), source: item.source,
        ...(typeof item.plugin === "string" && item.plugin.length <= 256 ? { plugin: item.plugin } : {}) });
    }
    const snapshot = { commands, truncated };
    const digest = JSON.stringify(snapshot);
    if (digest === state.lastCatalog) return;
    if (await send($, state, "runtime_catalog", { snapshot })) state.lastCatalog = digest;
  } catch { await send($, state, "runtime_observe", { kind: "unavailable", capability: "catalog" }); }
}
export async function captureContext($, state) {
  if (!active(state, "context") || state.contextUnavailable) return;
  try {
    const measured = await $.session.usage({ breakdown: "summary" });
    const context = measured.context;
    const breakdown = context.breakdown;
    let truncated = false;
    const snapshot = { window: context.window, ...(context.tokens === undefined ? {} : { tokens: context.tokens }),
      ...(context.percent === undefined ? {} : { percent: context.percent }), estimated: true, detail: "summary", truncated: false };
    if (breakdown) {
      if (typeof breakdown.model === "string" && breakdown.model.length <= 256) snapshot.model = breakdown.model;
      snapshot.totalTokens = breakdown.totalTokens;
      snapshot.rawMaxTokens = breakdown.rawMaxTokens;
      if (Array.isArray(breakdown.categories)) {
        truncated = breakdown.categories.length > 32;
        snapshot.categories = breakdown.categories.slice(0, 32).map(row => ({ name: row.name, tokens: row.tokens, kind: row.kind }));
      }
    }
    snapshot.truncated = truncated;
    await send($, state, "runtime_context", { snapshot });
  } catch {
    state.contextUnavailable = true;
    await send($, state, "runtime_observe", { kind: "unavailable", capability: "context" });
  }
}
export async function observeStep($, state, e, result) {
  if (!active(state, "observations")) return;
  try {
    const usage = usageOf(result.usage);
    const responseModel = result.usage?.model;
    await send($, state, "runtime_observe", { kind: "step", turnId: e.turnId, index: e.index,
      model: typeof responseModel === "string" ? responseModel : e.model, modelSource: typeof responseModel === "string" ? "response" : "request",
      messageCount: e.messageCount, appendCount: state.rows?.get(e.agentId) ?? 0, toolCount: result.toolUses.length,
      stopReason: result.stopReason, ...(usage ? { usage } : {}) }, e.agentId ?? null);
  } catch { await send($, state, "runtime_observe", { kind: "unavailable", capability: "usage" }, e.agentId ?? null); }
}
export function registerMetadata(on, state) {
  state.rows = new Map();
  on("session.append", async ($, e, next) => {
    const result = await next(e);
    if (active(state, "observations") && e.door !== "queue" && result.deny === undefined) {
      if (state.rows.size < 4096 || state.rows.has(e.agentId)) state.rows.set(e.agentId, (state.rows.get(e.agentId) ?? 0) + 1);
    }
    return result;
  });
  on("agent.spawn", async ($, e, next) => {
    const result = await next(e);
    if (active(state, "observations") && typeof result.agentId === "string") {
      await send($, state, "runtime_observe", { kind: "spawn", nativeAgentId: result.agentId, model: result.model,
        ...(typeof e.tool_use_id === "string" ? { toolUseId: e.tool_use_id } : {}),
        ...(typeof e.parentAgentId === "string" ? { parentNativeAgentId: e.parentAgentId } : {}),
        ...(typeof e.subagentType === "string" ? { subagentType: e.subagentType } : {}), workflow: e.workflow !== undefined }, e.parentAgentId ?? null);
    }
    return result;
  }).catch(($, e, next) => next(e));
  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (active(state, "observations")) {
      await send($, state, "runtime_observe", { kind: "complete", turnId: e.turnId, reason: e.reason,
        isAborted: e.isAborted, durationMs: e.durationMs }, e.agentId ?? null);
    }
    if (e.agentId === undefined) {
      await captureContext($, state);
      await captureCatalog($, state);
    }
    return result;
  }).catch(($, e, next) => next(e));
}
