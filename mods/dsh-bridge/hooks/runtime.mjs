import { callHost, blockControl } from "./rpc.mjs";
import { validateToolRewrite } from "./rewrite.mjs";
import { observeStep, registerMetadata } from "./metadata.mjs";
import { refreshDshTools, registerDshTools } from "./dsh-tools.mjs";
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const ENVELOPE = new Set(["tool", "tool_use_id", "agentId", "consent", "requestMeta"]);
function enabled(state, capability) { return state.bridge && state.capabilities?.[capability] === true; }
function routingInput(input, routing) {
  if (!routing || typeof routing !== "object" || Object.keys(routing).some(key => !["model", "effort", "clearEffort"].includes(key))) throw new Error("invalid step routing");
  if (routing.model !== undefined && (typeof routing.model !== "string" || !routing.model || routing.model.length > 256)) throw new Error("invalid model");
  if (routing.effort !== undefined && !EFFORTS.has(routing.effort)) throw new Error("invalid effort");
  if (routing.clearEffort !== undefined && typeof routing.clearEffort !== "boolean" || routing.clearEffort && routing.effort !== undefined) throw new Error("invalid effort reset");
  const next = { ...input };
  if (routing.clearEffort) delete next.effort;
  if (routing.model !== undefined) next.model = routing.model;
  if (routing.effort !== undefined) next.effort = routing.effort;
  return next;
}
async function appendPlanPolicy($, state, result) {
  if (!enabled(state, "policy") || result.text === null) return result;
  try {
    const policy = await callHost($, state, "runtime_policy", {});
    if (typeof policy.active !== "boolean" || typeof policy.text !== "string" || policy.text.length > 32768) throw new Error("invalid plan policy");
    return policy.active && policy.text ? { text: `${result.text}\n\nDSH plan policy:\n${policy.text}` } : result;
  } catch { blockControl($, state); return result; }
}
export function registerRuntime(on, state) {
  on("prompt.attachment", async ($, e, next) => {
    if (enabled(state, "tools") && e.agentId === undefined && e.origin.kind === "engine"
      && ["plan_mode", "plan_mode_reentry"].includes(e.type) && typeof e.detail?.planFilePath === "string") {
      state.planFilePath = e.detail.planFilePath;
    }
    const result = await next(e);
    if (enabled(state, "policy") && e.agentId === undefined && e.origin.kind === "engine" && e.type === "plan_mode") {
      return appendPlanPolicy($, state, result);
    }
    return result;
  });

  on("turn.step", async function* ($, e, next) {
    if (!enabled(state, "step") || e.agentId !== undefined) {
      const result = yield* next(e);
      await observeStep($, state, e, result);
      return result;
    }
    let input;
    try {
      if (state.blocked) throw new Error("runtime blocked");
      const prepared = await callHost($, state, "runtime_step", { turnId: e.turnId, index: e.index, model: e.model,
        messageCount: e.messageCount, ...(e.effort === undefined ? {} : { effort: e.effort }) });
      input = routingInput(e, prepared.routing);
      if (state.capabilities?.dshTools === true) await refreshDshTools($, state, prepared.tools);
    } catch {
      blockControl($, state);
      return { turnId: e.turnId, index: e.index, answer: "", toolUses: [], stopReason: null, usage: null };
    }
    const result = yield* next(input);
    await observeStep($, state, input, result);
    return result;
  });

  on("tool.check", async ($, e, next) => {
    if (!enabled(state, "tools") || e.tool.startsWith("mcp__")) return next(e);
    try {
      if (state.blocked) throw new Error("runtime blocked");
      const result = await callHost($, state, "runtime_check", { toolName: e.tool }, e.agentId ?? null);
      if (result.decision === "deny") return { decision: "deny", reason: result.reason ?? "DSH policy denied this tool." };
      if (result.decision !== "abstain") throw new Error("invalid policy decision");
      return next(e);
    } catch { return { decision: "deny", reason: "DSH runtime policy bridge unavailable." }; }
  }).catch(() => ({ decision: "deny", reason: "DSH runtime policy bridge failed closed." }));

  on("tool.call", async ($, e, next) => {
    if (!enabled(state, "tools") || e.tool.startsWith("mcp__")) return next(e);
    if (state.blocked) return { deny: "DSH runtime bridge is blocked." };
    const args = Object.fromEntries(Object.entries(e).filter(([key]) => !ENVELOPE.has(key)));
    let planText;
    try {
      if (e.tool === "ExitPlanMode") {
        if (e.agentId !== undefined || !state.planFilePath) return { deny: "DSH plan review requires the main loop's native plan file." };
        planText = await $.fs.read(state.planFilePath);
        if (planText.length > 65536 || !/^#\s+\S/.test(planText.trim())) return { deny: "DSH plan review requires the complete markdown plan." };
      }
      const prepared = await callHost($, state, "runtime_tool", { toolName: e.tool, callId: e.tool_use_id, input: args,
        ...(planText === undefined ? {} : { planText }),
        ...(e.agentId !== undefined || !state.planFilePath ? {} : { planFilePath: state.planFilePath }) }, e.agentId ?? null);
      if (prepared.decision !== "allow") return { deny: prepared.reason ?? "DSH native tool gate denied this call." };
      if (planText !== undefined && await $.fs.read(state.planFilePath) !== planText) {
        await callHost($, state, "runtime_tool_result", { toolName: e.tool, callId: e.tool_use_id, ok: false });
        return { deny: "The native plan changed during review; present it again." };
      }
      const input = prepared.updatedInput === undefined ? e : { ...e, ...validateToolRewrite(e.tool, args, prepared.updatedInput) };
      const result = await next(input);
      try {
        await callHost($, state, "runtime_tool_result", { toolName: e.tool, callId: e.tool_use_id,
          ok: result.deny === undefined && result.isError !== true, ...(result.isReadOnly === true ? { isReadOnly: true } : {}) }, e.agentId ?? null);
      } catch { blockControl($, state); }
      return result;
    } catch {
      if (next.called) return next(e);
      return { deny: "DSH native tool bridge unavailable; call denied." };
    }
  }).catch(($, e, next) => next.called ? next(e) : { deny: "DSH native tool bridge failed closed." });
  registerMetadata(on, state);
  registerDshTools(on, state);
}
