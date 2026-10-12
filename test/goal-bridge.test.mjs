// test/goal-bridge.test.mjs — goal 桥接工具的语义与权限契约（对照 @deepseek-ai/dsh-tool-goal）。
import { test, mock } from "node:test";
import assert from "node:assert/strict";

// --- 模块 mock：SDK 的构造器直通，便于直接拿到工具 handler ---
mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    createSdkMcpServer: (opts) => opts,
    tool: (name, description, inputSchema, handler) => ({ name, description, inputSchema, handler }),
  },
});

const { goalValue, resolveGoalConfig, goalGuidance, GOAL_TOOL_PREFIX } = await import("../lib/goal-bridge.mjs");

test("goalValue：无当前 goal → { goal: null }", () => {
  assert.deepEqual(goalValue(undefined), { goal: null });
});

test("goalValue：投影出 id/revision/objective/phase/轮数，blocked 带 reason", () => {
  const value = goalValue({
    id: "g1", revision: 2, objective: "do it", phase: "blocked",
    roundsStarted: 3, maxGoalRounds: 10, activation: "disarmed",
    blockedReason: { code: "model-reported", message: "no access" },
  });
  assert.deepEqual(value, {
    goal: {
      id: "g1", revision: 2, objective: "do it", phase: "blocked",
      roundsStarted: 3, maxGoalRounds: 10,
      blockedReason: { code: "model-reported", message: "no access" },
    },
    activation: "disarmed",
  });
});

test("resolveGoalConfig：默认阈值 3；非法阈值/上限抛 TypeError", () => {
  assert.deepEqual(resolveGoalConfig({}), { blockedAfterConsecutiveRounds: 3 });
  assert.deepEqual(resolveGoalConfig({ blockedAfterConsecutiveRounds: 5, defaultMaxGoalRounds: 64 }), {
    blockedAfterConsecutiveRounds: 5, defaultMaxGoalRounds: 64,
  });
  assert.throws(() => resolveGoalConfig({ blockedAfterConsecutiveRounds: 0 }), TypeError);
  assert.throws(() => resolveGoalConfig({ defaultMaxGoalRounds: 0 }), TypeError);
});

test("goalGuidance：把阈值插进策略文本", () => {
  assert.match(goalGuidance({ blockedAfterConsecutiveRounds: 7 }), /at least 7 consecutive goal rounds/);
});

test("GOAL_TOOL_PREFIX：canUseTool 放行前缀与 server 名一致", () => {
  assert.equal(GOAL_TOOL_PREFIX, "mcp__goal__");
});
