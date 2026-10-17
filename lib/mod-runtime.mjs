// normal query 的固定控制面；方法自身校验输入与主/子归属，不暴露任意宿主调用。
import { z } from "zod";
import { makeCanUseTool, readOnlyDenial } from "./approval.mjs";
import { readPermission, permissionStrategy } from "./permission.mjs";
import { readSessionEvents } from "./session-events.mjs";
import { pluginFacts } from "./plugin-facts.mjs";
import { createNativeMetadata, CONTEXT_SCHEMA, COMMAND_SNAPSHOT_SCHEMA, OBSERVATION_SCHEMA } from "./native-metadata.mjs";
import { DEFAULT_DSH_TOOL_NAMES } from "./dsh-tools-bridge.mjs";

const id = z.string().min(1).max(256);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const callSchema = z.strictObject({ toolName: id, callId: id, input: z.record(z.string(), z.unknown()), planText: z.string().max(65536).optional(), planFilePath: z.string().max(4096).optional() });
const SCHEMAS = {
  runtime_policy: z.strictObject({}),
  runtime_step: z.strictObject({ turnId: id, index: count, model: id, messageCount: count,
    effort: z.union([z.enum(["low", "medium", "high", "xhigh", "max"]), z.number().finite()]).optional() }),
  runtime_tool: callSchema,
  runtime_check: z.strictObject({ toolName: id }),
  runtime_tool_result: z.strictObject({ toolName: id, callId: id, ok: z.boolean(), isReadOnly: z.boolean().optional() }),
  runtime_context: z.strictObject({ snapshot: CONTEXT_SCHEMA }),
  runtime_catalog: z.strictObject({ snapshot: COMMAND_SNAPSHOT_SCHEMA }),
  runtime_observe: OBSERVATION_SCHEMA,
  runtime_dsh: z.strictObject({ name: z.enum(DEFAULT_DSH_TOOL_NAMES), callId: id, args: z.record(z.string(), z.unknown()) }),
};
const CHILD_METHODS = new Set(["runtime_tool", "runtime_check", "runtime_tool_result", "runtime_observe"]);
const PLAN_TOOLS = new Set(["EnterPlanMode", "ExitPlanMode"]);
const denied = (reason) => ({ decision: "deny", reason });

export function createModRuntime({ ctx, agent, session, signal, epoch, toolGate, planBridge, setMode, routeStep, config = {}, abort, initialMode, allowBypass = false, subagents, dshModTransport = false, getDshTools }) {
  let active = true;
  const metadata = createNativeMetadata({ session, epoch, subagents });
  const modeFor = (plan) => plan.active ? "plan" : allowBypass && permissionStrategy(readPermission(readSessionEvents(session))) === "bypass" ? "bypassPermissions" : "default";
  let currentMode = initialMode ?? modeFor(planBridge.read());
  const live = () => {
    const registry = ctx?.get?.("agents");
    return active && !signal?.aborted && agent.status === "running" && (!registry || registry.get(agent.id) === agent);
  };
  const syncMode = async (plan = planBridge.read()) => {
    const mode = modeFor(plan);
    if (mode !== currentMode) { await setMode(mode); currentMode = mode; }
  };
  const approve = makeCanUseTool(ctx, { cwd: session.header?.cwd, session, agent, toolGate, planBridge, isLive: live, readOnlyBash: config.readOnlyBash, allowedToolNames: [] });
  const has = method => Object.hasOwn(SCHEMAS, method) && (method !== "runtime_dsh" || dshModTransport);
  const dshDefinitions = () => {
    if (!dshModTransport || !live()) return [];
    const definitions = getDshTools?.()?.definitions?.() ?? [];
    if (!Array.isArray(definitions) || definitions.length > 4 || new Set(definitions.map(x => x.name)).size !== definitions.length
      || definitions.some(x => !DEFAULT_DSH_TOOL_NAMES.includes(x.name))
      || Buffer.byteLength(JSON.stringify(definitions), "utf8") > 256 * 1024) throw new Error("invalid audited DSH tool catalog");
    return definitions;
  };
  const parse = (method, params) => {
    if (!has(method)) throw new Error("unknown runtime method");
    return SCHEMAS[method].parse(params);
  };
  return {
    capabilities: { policy: true, step: true, tools: true, observations: true, context: true, catalog: true, dshTools: dshModTransport },
    has,
    isLive: live,
    dshDefinitions,
    allowsChild: (method) => CHILD_METHODS.has(method),
    parse,
    async syncMode() {
      try { if (!live()) throw new Error("runtime is closed"); await syncMode(); }
      catch (error) { abort?.(); throw error; }
    },
    timeoutMs: (method) => ["runtime_tool", "runtime_dsh"].includes(method) ? 300000 : 5000,
    async invoke(method, input, { callerAgentId = null, signal: requestSignal } = {}) {
      if (!live() || callerAgentId !== null && !CHILD_METHODS.has(method)) throw new Error("runtime caller is not live or has no control authority");
      const params = parse(method, input);
      const combined = requestSignal && signal ? AbortSignal.any([requestSignal, signal]) : requestSignal ?? signal;
      const execute = async () => {
        if (method === "runtime_context") { metadata.context(params.snapshot); return {}; }
        if (method === "runtime_dsh") {
          const bridge = getDshTools?.();
          return bridge ? await bridge.execute(params.name, params.args, { signal: combined, _meta: { "claudecode/toolUseId": params.callId } })
            : { content: [{ type: "text", text: "DSH tool bridge is unavailable" }], isError: true };
        }
        if (method === "runtime_catalog") { metadata.catalog(params.snapshot); return {}; }
        if (method === "runtime_observe") { metadata.observe(params, { callerAgentId }); return {}; }
        if (method === "runtime_policy") {
          const plan = planBridge.read();
          return { active: plan.active, text: plan.text };
        }
        if (method === "runtime_step") {
          const plan = planBridge.commitBoundary();
          await syncMode(plan);
          const routing = await routeStep(params);
          pluginFacts(session).append("claude-code/step-control", { epoch, state: "prepared", turnId: params.turnId, index: params.index,
            model: routing.model ?? params.model, planActive: plan.active, ...(routing.effort === undefined ? {} : { effort: routing.effort }) });
          return { planActive: plan.active, routing, ...(dshModTransport ? { tools: dshDefinitions() } : {}) };
        }
        if (method === "runtime_check") {
          const reason = readOnlyDenial(params.toolName, { ...readPermission(readSessionEvents(session)), readOnlyBash: config.readOnlyBash });
          return reason ? denied(reason) : { decision: "abstain" };
        }
        if (method === "runtime_tool_result") {
          toolGate.observe({ ...params, callerAgentId });
          if (callerAgentId === null && PLAN_TOOLS.has(params.toolName)) planBridge.settle(params.toolName, params.callId, params.ok);
          return {};
        }
        if (method === "runtime_tool") {
          if (callerAgentId !== null && PLAN_TOOLS.has(params.toolName)) return denied("Native plan transitions require the main agent.");
          const call = { toolName: params.toolName, input: params.input, callId: params.callId, callerAgentId, signal: combined };
          const prepared = await toolGate.prepare(call);
          if (prepared.denial) return denied(prepared.denial);
          if (callerAgentId === null && params.planFilePath !== undefined) planBridge.rememberPath(params.planFilePath);
          const planDenied = planBridge.guard(params.toolName, prepared.updatedInput ?? params.input, callerAgentId);
          if (planDenied) return denied(planDenied);
          if (["deny", "cancel"].includes(prepared.gate.kind)) return denied(prepared.gate.reason ?? "Host tool gate refused this call.");
          if (PLAN_TOOLS.has(params.toolName)) return planBridge.prepare(params.toolName, params.callId, params.planText, combined);
          if (prepared.gate.kind === "ask") {
            const decision = await approve(params.toolName, prepared.updatedInput ?? params.input, { signal: combined, toolUseID: params.callId });
            if (decision.behavior !== "allow") return denied(decision.message);
            toolGate.approveOnce(call);
          }
          return { decision: "allow", ...(prepared.updatedInput === undefined ? {} : { updatedInput: prepared.updatedInput }) };
        }
        throw new Error("unknown runtime method");
      };
      try {
        const result = await execute();
        if (!live() || combined?.aborted) throw new Error("runtime caller lost its live query");
        return result;
      } catch (error) {
        if (["runtime_step", "runtime_policy"].includes(method)) abort?.();
        throw error;
      }
    },
    updateSkills(skills) {
      if (!live()) throw new Error("runtime catalog is closed");
      metadata.skills(skills);
    },
    invalidateSkills() {
      if (!live()) throw new Error("runtime catalog is closed");
      metadata.invalidateSkills();
    },
    afterMessage() { if (live()) metadata.afterMessage(); },
    close() { active = false; metadata.close(); planBridge.close?.(); toolGate.close?.(); },
  };
}
