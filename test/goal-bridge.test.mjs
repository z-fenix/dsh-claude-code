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

// ---------------------------------------------------------------------------
// buildGoalServer + get_goal
// ---------------------------------------------------------------------------
const { buildGoalServer } = await import("../lib/goal-bridge.mjs");

/** 一个记录调用的假 ctx：goals 服务 + 最小 agents 注册表。 */
function fakeCtx(goals, agent) {
  return {
    get: (key) => (key === "goals" ? goals : undefined),
    agents: {
      get: (id) => (id === agent.id ? agent : undefined),
      currentInitiator: () => agent,
    },
  };
}
const runningAgent = { id: "a1", status: "running" };
const toolOf = (server, name) => server.tools.find((t) => t.name === name);

test("无 goals 服务 → buildGoalServer 返回 undefined（功能静默缺席）", () => {
  const ctx = { get: () => undefined, agents: {} };
  assert.equal(buildGoalServer({ ctx, agent: runningAgent, turnContext: () => ({}), config: {} }), undefined);
});

test("get_goal：无当前 goal → { goal: null }", async () => {
  const goals = { get: () => undefined };
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: () => ({ hasHumanMessage: false }), config: {} });
  const result = await toolOf(server, "get_goal").handler({});
  assert.deepEqual(JSON.parse(result.content[0].text), { goal: null });
});

test("get_goal：有 goal → 返回投影与 activation", async () => {
  const goal = { id: "g1", revision: 1, objective: "x", phase: "active", roundsStarted: 0, maxGoalRounds: 8, activation: "armed" };
  const goals = { get: () => goal };
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: () => ({}), config: {} });
  const value = JSON.parse((await toolOf(server, "get_goal").handler({})).content[0].text);
  assert.equal(value.goal.id, "g1");
  assert.equal(value.activation, "armed");
});

test("get_goal：goals.get 抛异常 → isError，不外抛", async () => {
  const goals = { get: () => { throw new Error("boom"); } };
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: () => ({}), config: {} });
  const result = await toolOf(server, "get_goal").handler({});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /boom/);
});

// ---------------------------------------------------------------------------
// create_goal
// ---------------------------------------------------------------------------
test("create_goal：无人类直接回合 → 拒绝（isError）", async () => {
  const goals = { create: () => { throw new Error("should not be called"); } };
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: () => ({ hasHumanMessage: false }), config: {} });
  const result = await toolOf(server, "create_goal").handler({ objective: "x" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /direct human/);
});

test("create_goal：人类回合 → 调 goals.create，透传 objective", async () => {
  const calls = [];
  const goals = { create: (agent, request) => { calls.push([agent, request]); return { id: "g1", revision: 1, objective: request.objective, phase: "active", roundsStarted: 0, maxGoalRounds: 256, activation: "armed" }; } };
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: () => ({ hasHumanMessage: true }), config: {} });
  const value = JSON.parse((await toolOf(server, "create_goal").handler({ objective: "ship it" })).content[0].text);
  assert.deepEqual(calls[0][1], { objective: "ship it" });
  assert.equal(value.goal.id, "g1");
});

test("create_goal：未给 max_goal_rounds 时用配置的 defaultMaxGoalRounds 兜底", async () => {
  const calls = [];
  const goals = { create: (_a, request) => { calls.push(request); return { id: "g1", revision: 1, objective: request.objective, phase: "active", roundsStarted: 0, maxGoalRounds: request.maxGoalRounds, activation: "armed" }; } };
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: () => ({ hasHumanMessage: true }), config: { defaultMaxGoalRounds: 12 } });
  await toolOf(server, "create_goal").handler({ objective: "x" });
  assert.deepEqual(calls[0], { objective: "x", maxGoalRounds: 12 });
});

test("create_goal：显式 max_goal_rounds 覆盖默认", async () => {
  const calls = [];
  const goals = { create: (_a, request) => { calls.push(request); return { id: "g1", revision: 1, objective: request.objective, phase: "active", roundsStarted: 0, maxGoalRounds: request.maxGoalRounds, activation: "armed" }; } };
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: () => ({ hasHumanMessage: true }), config: { defaultMaxGoalRounds: 12 } });
  await toolOf(server, "create_goal").handler({ objective: "x", max_goal_rounds: 3 });
  assert.deepEqual(calls[0], { objective: "x", maxGoalRounds: 3 });
});
