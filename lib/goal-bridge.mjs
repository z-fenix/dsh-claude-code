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
