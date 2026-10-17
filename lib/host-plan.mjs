// 只桥接 Plan 的公开选择、真实审阅与真实 CLI step 边界，不接通整个 pre-step。
import path from "node:path";
const MUTATORS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const scopedPlans = new WeakMap();
export function bindHostPlanService(agent, service) {
  if (!agent || typeof agent !== "object" || typeof service?.get !== "function" || typeof service?.set !== "function") throw new TypeError("Plan bridge requires an agent scope and service");
  if (scopedPlans.has(agent)) throw new Error("Plan service is already bound in this agent scope");
  scopedPlans.set(agent, service);
  return () => { if (scopedPlans.get(agent) === service) scopedPlans.delete(agent); };
}
function resolvePlanService(ctx, agent) {
  return scopedPlans.get(agent) ?? agent?.ctx?.get?.("planMode") ?? ctx?.get?.("planMode");
}
const DEFAULT_POLICY = "You are in plan mode. Explore with non-mutating tools and prepare a complete plan. Use ExitPlanMode to request explicit plan review. Conversational agreement is not approval; remain in plan mode if review is unavailable or declined.";
const deny = (reason) => ({ decision: "deny", reason });
const permissionDeny = () => ({ behavior: "deny", message: "DSH native plan transition requires a current, main-query plan review through the Mod bridge; use /plan if unavailable." });
function eventsOf(session) {
  if (typeof session?.snapshotEvents !== "function") return [];
  const events = session.snapshotEvents();
  if (!Array.isArray(events)) throw new Error("Plan state is unreadable");
  return events;
}
function fingerprint(session) { return JSON.stringify(eventsOf(session).filter(x => x.type === "plan/mode").map(x => [x.seq, x.data?.active])); }

export function readHostPlan({ ctx, agent, session = agent?.session }) {
  const service = resolvePlanService(ctx, agent);
  let state;
  if (service !== undefined) {
    if (typeof service.get !== "function") throw new Error("Plan service is unreadable");
    state = service.get(agent);
    if (typeof state?.active !== "boolean" || (state.pending !== undefined && typeof state.pending !== "boolean")) throw new Error("Plan state is unreadable");
  } else {
    let active = false;
    for (const event of eventsOf(session)) if (event.type === "plan/mode" && typeof event.data?.active === "boolean") active = event.data.active;
    state = { active };
  }
  const active = state.pending ?? state.active;
  const configured = typeof service?.section === "string" && service.section.trim() && service.section.length <= 32768
    && !service.section.includes("{{") ? service.section : DEFAULT_POLICY;
  const text = active ? configured.replace(/\bexit_plan_mode\b/g, "ExitPlanMode").replace(/\bask_user_question\b/g, "AskUserQuestion")
    .replace(/\btodo_write\b/g, "task-list tools") : "";
  return { available: service !== undefined, active, loggedActive: state.active,
    ...(state.pending === undefined ? {} : { pending: state.pending }), text };
}

export function createPlanBridge({ ctx, agent, session = agent?.session, signal }) {
  const receipts = new Map();
  let closed = false;
  let planFile;
  const fileKey = (value) => {
    const resolved = path.resolve(session.header?.cwd ?? process.cwd(), value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const read = () => readHostPlan({ ctx, agent, session });
  const valid = (entry) => !closed && entry && !entry.settled && !signal?.aborted && !entry.reviewSignal?.aborted && resolvePlanService(ctx, agent) === entry.service
    && fingerprint(session) === entry.fingerprint && (entry.tool === "EnterPlanMode" || read().active);
  return {
    read,
    rememberPath(value) {
      if (closed || typeof value !== "string" || value.length > 4096 || value.includes("\0") || !path.isAbsolute(value)) throw new Error("Invalid native plan path");
      planFile = fileKey(value);
    },
    guard(tool, input, callerAgentId = null) {
      if (!MUTATORS.has(tool)) return undefined;
      try {
        if (closed) return "The plan bridge is closed.";
        if (!read().loggedActive) return undefined;
        if (callerAgentId === null && ["Write", "Edit"].includes(tool) && planFile && typeof input?.file_path === "string"
          && fileKey(input.file_path) === planFile) return undefined;
        return "Stay in plan mode: only the main loop's native plan file may be modified.";
      } catch { return "Plan state is unavailable; file mutation is denied."; }
    },
    async prepare(tool, callId, planText, requestSignal) {
      const reviewSignal = requestSignal && signal ? AbortSignal.any([requestSignal, signal]) : requestSignal ?? signal;
      if (closed || !["EnterPlanMode", "ExitPlanMode"].includes(tool) || typeof callId !== "string" || !callId || callId.length > 256 || reviewSignal?.aborted) return deny("Invalid native plan transition.");
      try {
        const state = read();
        const service = resolvePlanService(ctx, agent);
        if (!state.available || typeof service?.set !== "function") return deny("DSH plan-mode service is unavailable.");
        const previous = receipts.get(callId);
        if (previous) return previous.tool === tool && previous.planText === planText && valid(previous)
          ? { decision: "allow" } : deny("Plan transition identity or state changed.");
        if (receipts.size >= 4096) return deny("Plan transition budget exhausted.");
        if (tool === "ExitPlanMode" && (!state.active || typeof planText !== "string" || planText.length > 65536 || !/^#\s+\S/.test(planText.trim()))) {
          return deny("Plan review requires the current complete markdown plan while DSH plan mode is active.");
        }
        const entry = { tool, planText, service, fingerprint: fingerprint(session), settled: false, reviewSignal };
        if (tool === "ExitPlanMode") {
          const questions = ctx.get("userQuestions");
          if (typeof questions?.ask !== "function") return deny("No plan-review channel is available; stay in plan mode.");
          const answer = await questions.ask({ agent, ...(reviewSignal ? { signal: reviewSignal } : {}), questions: [{ id: "claude-plan-review", header: "Plan review",
            question: "Approve this plan and leave plan mode?", detail: planText,
            options: [{ label: "Approve plan", description: "Implement from the next step." }, { label: "Keep planning", description: "Keep planning and revise." }],
            intent: { kind: "plan-review", approve: "Approve plan", callId } }] });
          const matches = answer?.answers?.filter(item => item.id === "claude-plan-review") ?? [];
          const item = matches.length === 1 ? matches[0] : undefined;
          if (item?.selected?.length !== 1 || item.selected[0] !== "Approve plan" || item.custom !== undefined) return deny("The user did not approve the plan; remain in plan mode.");
        }
        if (!valid(entry)) return deny("The plan state changed during review; present the plan again.");
        receipts.set(callId, entry);
        return { decision: "allow" };
      } catch { return deny("Plan review is unavailable; remain in plan mode."); }
    },
    permission(tool, callId) {
      try {
        const entry = receipts.get(callId);
        return entry?.tool === tool && valid(entry) ? { behavior: "allow" } : permissionDeny();
      } catch { return permissionDeny(); }
    },
    settle(tool, callId, ok) {
      const entry = receipts.get(callId);
      if (!entry || entry.tool !== tool || entry.settled) return;
      if (!ok) { receipts.delete(callId); return; }
      if (!valid(entry)) throw new Error("Plan transition lost its approval identity");
      entry.service.set(agent, tool === "EnterPlanMode");
      entry.settled = true;
    },
    close() { closed = true; receipts.clear(); },
    commitBoundary() {
      if (closed || signal?.aborted) throw new Error("Plan boundary cancelled");
      const state = read();
      // 这是真实用户已选定、到本次 CLI step 才生效的状态；不调用私有 onBoundary。
      if (state.pending !== undefined && state.pending !== state.loggedActive) session.append("plan/mode", { active: state.pending });
      return read();
    },
  };
}
