// lib/goal-bridge.mjs — 把 goal 领域的模型工具桥接进 Claude Code（进程内 MCP server）。
//
// goal 服务（ctx.goals）、round driver、`/goal` 命令都在 host 平面；Claude Code 走 SDK 自带
// 工具系统，看不到 DSH 的 agent-scope 工具（dsh-tool-goal 的 get_goal/create_goal/update_goal）。
// 这里用 createSdkMcpServer 在同一进程暴露这三个工具，后端直接调 ctx.goals。
//
// 语义与权限刻意对齐 @deepseek-ai/dsh-tool-goal，但**不**复用它导出的 authority 模块（未导出，
// 且依赖 sessionProjections 的 turnBoundary 投影——本插件的引擎未必产出该投影）。改用 agent
// 自己记录的当前回合上下文（ClaudeCodeAgent.currentTurnContext()）。
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";

export const GOAL_SERVER_NAME = "goal";
export const GOAL_TOOL_PREFIX = `mcp__${GOAL_SERVER_NAME}__`;

const UPDATE_ACTIONS = ["edit", "pause", "resume", "complete", "blocked"];

const GET_DESCRIPTION = "Read the current session goal, including the id and revision that update_goal requires.";
const CREATE_DESCRIPTION =
  'Create a persisted goal that keeps this session working across automatic continuation rounds. Use it when the direct human request is a long-running objective, even if the user did not say "goal"; not for single-turn work.';
const UPDATE_DESCRIPTION = "Update the current goal.";

/** 严格 schema 的空串 / 零值视为「未提供」（与 dsh-tool-goal 同款）。 */
function hasText(value) {
  return value !== undefined && value !== "";
}
function hasRoundCap(value) {
  return value !== undefined && value !== 0;
}

/** 配置归一化（apply 被直接调用、绕过 Loader 时仍校验）。 */
export function resolveGoalConfig(config = {}) {
  const blockedAfter = config.blockedAfterConsecutiveRounds ?? 3;
  if (!Number.isSafeInteger(blockedAfter) || blockedAfter < 1) {
    throw new TypeError("blockedAfterConsecutiveRounds must be a positive safe integer");
  }
  const out = { blockedAfterConsecutiveRounds: blockedAfter };
  if (config.defaultMaxGoalRounds !== undefined) {
    if (!Number.isSafeInteger(config.defaultMaxGoalRounds) || config.defaultMaxGoalRounds < 1) {
      throw new TypeError("defaultMaxGoalRounds must be a positive safe integer");
    }
    out.defaultMaxGoalRounds = config.defaultMaxGoalRounds;
  }
  return out;
}

/** 与 dsh-tool-goal 相同的紧凑模型结果；activation 是实时观察值，绝不作为回放依据。 */
export function goalValue(goal) {
  if (goal === undefined) return { goal: null };
  return {
    goal: {
      id: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      roundsStarted: goal.roundsStarted,
      maxGoalRounds: goal.maxGoalRounds,
      ...(goal.blockedReason === undefined
        ? {}
        : { blockedReason: { code: goal.blockedReason.code, message: goal.blockedReason.message } }),
    },
    activation: goal.activation,
  };
}

/** 策略提示文本（含阻塞阈值），语义与 dsh-tool-goal 一致。 */
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

/** 成功结果：紧凑 JSON 文本。 */
function ok(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}
/** 失败结果：可读文本；绝不外抛，避免打断 Claude 回合。 */
function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}
/** 调用者归属由构造时绑定的 agent 决定，不用 ALS 的 currentInitiator（未必传播进 SDK 派发）。 */
function assertCaller(ctx, agent) {
  if (agent === undefined) throw new Error("goal tools require a calling agent");
  if (ctx.agents.get(agent.id) !== agent) throw new Error("goal tools require the exact live calling agent");
  if (agent.status !== "running") throw new Error("goal tools require the calling agent to be running");
}
/** 一次工具调用共用的解析：活的调用者 + 当前回合上下文。 */
function resolveExecution(ctx, agent, turnContext) {
  assertCaller(ctx, agent);
  const turn = typeof turnContext === "function" ? turnContext() : turnContext;
  if (turn === undefined || turn === null) throw new Error("goal tools require an open model turn");
  return { agent, turn };
}

/**
 * 构造进程内 goal MCP server；无 goals 服务时返回 undefined（调用方据此不挂载）。
 * @param {object} args
 * @param {object} args.ctx 宿主上下文
 * @param {object} args.agent 当前 ClaudeCodeAgent（goal 归属）
 * @param {() => {hasHumanMessage:boolean, goalSource?:object}} args.turnContext 当前回合上下文访问器
 * @param {object} [args.config] 引擎的 goal 配置
 */
export function buildGoalServer({ ctx, agent, turnContext, config } = {}) {
  const goals = ctx.get?.("goals");
  if (goals === undefined) return undefined;
  const resolved = resolveGoalConfig(config);

  const tools = [
    tool("get_goal", GET_DESCRIPTION, {}, async () => {
      try {
        const ex = resolveExecution(ctx, agent, turnContext);
        return ok(goalValue(goals.get(ex.agent)));
      } catch (error) {
        return fail(error);
      }
    }),
    tool(
      "create_goal",
      CREATE_DESCRIPTION,
      { objective: z.string(), max_goal_rounds: z.number().int().positive().optional() },
      async (args) => {
        try {
          const ex = resolveExecution(ctx, agent, turnContext);
          if (ex.turn.hasHumanMessage !== true) {
            throw new Error("create_goal requires a direct human turn on a top-level agent");
          }
          const maxGoalRounds = args.max_goal_rounds ?? resolved.defaultMaxGoalRounds;
          const goal = goals.create(ex.agent, {
            objective: args.objective,
            ...(maxGoalRounds === undefined ? {} : { maxGoalRounds }),
          });
          return ok(goalValue(goal));
        } catch (error) {
          return fail(error);
        }
      },
    ),
  ];

  return createSdkMcpServer({ name: GOAL_SERVER_NAME, version: "1.0.0", tools });
}
