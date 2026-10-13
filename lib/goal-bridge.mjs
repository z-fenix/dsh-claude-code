// SDK MCP 适配器；权限、CAS 与目标业务只在共享 domain 中实现。
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { buildGoalHandlers, goalToolDefinitions, goalToolShapes } from "./goal-domain.mjs";
export { goalValue, resolveGoalConfig, goalGuidance } from "./goal-domain.mjs";

export const GOAL_SERVER_NAME = "goal";
export const GOAL_TOOL_PREFIX = `mcp__${GOAL_SERVER_NAME}__`;

export function buildGoalServer(options = {}) {
  const handlers = buildGoalHandlers(options);
  if (handlers === undefined) return undefined;
  const shapes = goalToolShapes();
  const tools = goalToolDefinitions().map(({ name, description }) => tool(name, description, shapes[name], handlers[name]));
  return createSdkMcpServer({ name: GOAL_SERVER_NAME, version: "1.0.0", tools });
}
