// goal 的唯一宿主权威；MCP / mod 只适配同一组处理器，不自持另一份目标状态。
import { z } from "zod";
export { assessGoalAdmission, assessGoalDelivery } from "./goal-admission.mjs";

const UPDATE_ACTIONS = ["edit", "pause", "resume", "complete", "blocked"];
const roundCap = () => z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const DEFINITIONS = [
  { name: "get_goal", description: "Read the current session goal, including the id and revision that update_goal requires.", schema: z.strictObject({}) },
  { name: "create_goal", description: 'Create a persisted goal that keeps this session working across automatic continuation rounds. Use it when the direct human request is a long-running objective, even if the user did not say "goal"; not for single-turn work.',
    schema: z.strictObject({ objective: z.string(), max_goal_rounds: roundCap().optional() }) },
  { name: "update_goal", description: "Update the current goal.", schema: z.strictObject({
    goal_id: z.string(), revision: roundCap(), action: z.enum(UPDATE_ACTIONS),
    objective: z.string().optional(), max_goal_rounds: roundCap().optional(), blocked_reason: z.string().optional(),
  }) },
];

export function goalToolDefinitions() {
  return DEFINITIONS.map(({ name, description, schema }) => ({ name, description, inputSchema: z.toJSONSchema(schema) }));
}
export function goalToolShapes() {
  return Object.fromEntries(DEFINITIONS.map(({ name, schema }) => [name, schema.shape]));
}
function hasText(value) { return value !== undefined && value !== ""; }
function hasRoundCap(value) { return value !== undefined && value !== 0; }

export function resolveGoalConfig(config = {}) {
  const blockedAfter = config.blockedAfterConsecutiveRounds ?? 3;
  if (!Number.isSafeInteger(blockedAfter) || blockedAfter < 1) throw new TypeError("blockedAfterConsecutiveRounds must be a positive safe integer");
  const out = { blockedAfterConsecutiveRounds: blockedAfter };
  if (config.defaultMaxGoalRounds !== undefined) {
    if (!Number.isSafeInteger(config.defaultMaxGoalRounds) || config.defaultMaxGoalRounds < 1) throw new TypeError("defaultMaxGoalRounds must be a positive safe integer");
    out.defaultMaxGoalRounds = config.defaultMaxGoalRounds;
  }
  return out;
}

export function goalValue(goal) {
  if (goal === undefined) return { goal: null };
  return {
    goal: {
      id: goal.id, revision: goal.revision, objective: goal.objective, phase: goal.phase,
      roundsStarted: goal.roundsStarted, maxGoalRounds: goal.maxGoalRounds,
      ...(goal.blockedReason === undefined ? {} : { blockedReason: { code: goal.blockedReason.code, message: goal.blockedReason.message } }),
    },
    activation: goal.activation,
  };
}

export function goalGuidance({ blockedAfterConsecutiveRounds = 3 } = {}) {
  return (
    "create_goal may infer goal intent from a direct human request in any language. " +
    "After session resume or fork, an active goal is disarmed: when a human asks to continue or resume in any " +
    "wording or language, use update_goal action resume to rearm it. Mark complete only when the objective is " +
    `actually achieved. Mark blocked only after the same blocking condition persists for at least ${blockedAfterConsecutiveRounds} ` +
    "consecutive goal rounds, and report that concrete condition in blocked_reason; difficulty, uncertainty, or useful " +
    "remaining work is not blocked."
  );
}
function ok(value) { return { content: [{ type: "text", text: JSON.stringify(value) }] }; }
function fail(error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }; }

function assertCaller(ctx, agent) {
  if (agent === undefined) throw new Error("goal tools require a calling agent");
  if (ctx.agents.get(agent.id) !== agent) throw new Error("goal tools require the exact live calling agent");
  if (agent.status !== "running") throw new Error("goal tools require the calling agent to be running");
}
function goalRef(goalId, revision) {
  if (typeof goalId !== "string" || goalId.length === 0 || goalId !== goalId.trim() || !Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("goal_id must be non-empty and revision must be a positive safe integer");
  }
  return { id: goalId, revision };
}
function resolveExecution(ctx, agent, turnContext) {
  assertCaller(ctx, agent);
  const turn = typeof turnContext === "function" ? turnContext() : turnContext;
  if (turn === undefined || turn === null) throw new Error("goal tools require an open model turn");
  return { agent, turn };
}
function isMatchingGoalRound(turn, goal) {
  const source = turn?.goalSource;
  return source !== undefined && goal !== undefined && source.goalId === goal.id
    && source.revision === goal.revision && source.round === goal.roundsStarted;
}
function completionAuthority(turn, goal) {
  if (turn?.hasHumanMessage === true) return { kind: "direct-human" };
  if (isMatchingGoalRound(turn, goal)) return { kind: "goal-round", goal };
  throw new Error("complete and blocked require a direct human turn or the current goal round");
}

export function buildGoalHandlers({ ctx, agent, turnContext, config } = {}) {
  const goals = ctx.get?.("goals");
  if (goals === undefined) return undefined;
  const resolved = resolveGoalConfig(config);
  const operations = {
    get_goal: () => {
      const ex = resolveExecution(ctx, agent, turnContext);
      return ok(goalValue(goals.get(ex.agent)));
    },
    create_goal: (args) => {
      const ex = resolveExecution(ctx, agent, turnContext);
      if (ex.turn.hasHumanMessage !== true) throw new Error("create_goal requires a direct human turn on a top-level agent");
      const maxGoalRounds = args.max_goal_rounds ?? resolved.defaultMaxGoalRounds;
      return ok(goalValue(goals.create(ex.agent, {
        objective: args.objective, ...(maxGoalRounds === undefined ? {} : { maxGoalRounds }),
      })));
    },
    update_goal: (args) => {
      const ex = resolveExecution(ctx, agent, turnContext);
      const ref = goalRef(args.goal_id, args.revision);
      const goaled = () => {
        if (ex.turn.hasHumanMessage !== true) throw new Error("this goal operation requires a direct human turn on a top-level agent");
      };
      if (args.action === "edit") {
        goaled();
        if (hasText(args.blocked_reason)) throw new Error("blocked_reason is valid only with action blocked");
        return ok(goalValue(goals.edit(ex.agent, ref, {
          ...(hasText(args.objective) ? { objective: args.objective } : {}),
          ...(hasRoundCap(args.max_goal_rounds) ? { maxGoalRounds: args.max_goal_rounds } : {}),
        })));
      }
      if (args.action === "pause" || args.action === "resume") {
        goaled();
        if (hasText(args.objective) || hasRoundCap(args.max_goal_rounds) || hasText(args.blocked_reason)) {
          throw new Error("objective and max_goal_rounds are valid only with action edit; blocked_reason is valid only with action blocked");
        }
        const current = goals.get(ex.agent);
        if (args.action === "resume" && current?.id === ref.id && current.revision === ref.revision && current.phase === "paused") {
          throw new Error("the model cannot resume a paused goal; the user must resume it");
        }
        return ok(goalValue(args.action === "pause" ? goals.pause(ex.agent, ref) : goals.resume(ex.agent, ref)));
      }
      const authority = completionAuthority(ex.turn, goals.get(ex.agent));
      if (hasText(args.objective) || hasRoundCap(args.max_goal_rounds)) throw new Error("objective and max_goal_rounds are valid only with action edit");
      if (args.action === "complete" && hasText(args.blocked_reason)) throw new Error("blocked_reason is valid only with action blocked");
      if (args.action === "blocked" && (args.blocked_reason === undefined || args.blocked_reason.trim().length === 0)) throw new Error("blocked_reason is required with action blocked");
      if (args.action === "blocked" && authority.kind === "goal-round" && authority.goal.roundsStarted < resolved.blockedAfterConsecutiveRounds) {
        throw new Error(`blocked requires at least ${resolved.blockedAfterConsecutiveRounds} consecutive goal rounds; current round is ${authority.goal.roundsStarted}`);
      }
      return ok(goalValue(args.action === "complete" ? goals.complete(ex.agent, ref)
        : goals.block(ex.agent, ref, { code: "model-reported", message: args.blocked_reason })));
    },
  };
  return Object.fromEntries(DEFINITIONS.map(({ name, schema }) => [name, async (args = {}) => {
    try { return await operations[name](schema.parse(args)); }
    catch (error) { return fail(error); }
  }]));
}
