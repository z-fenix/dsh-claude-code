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
const { buildGoalHandlers, goalToolDefinitions } = await import("../lib/goal-domain.mjs");

/** 一个记录调用的假 ctx：goals 服务 + 最小 agents 注册表 + 会记录 append 的假 session。 */
function fakeCtx(goals, agent) {
  return {
    get: (key) => (key === "goals" ? goals : undefined),
    agents: {
      get: (id) => (id === agent.id ? agent : undefined),
      currentInitiator: () => agent,
    },
    // 桥接代码没有任何正当理由触碰 ctx.session；任何 append 都会被这条记录逮到。
    session: { appended: [], append(...args) { this.appended.push(args); } },
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

// ---------------------------------------------------------------------------
// update_goal：edit / pause / resume
// ---------------------------------------------------------------------------
/** 递增 revision 的假 goal 服务，够 edit/pause/resume 用。 */
function fakeGoals(initial) {
  const calls = [];
  let current = initial;
  const bump = (phase) => { current = { ...current, revision: current.revision + 1, phase }; return current; };
  return {
    calls,
    get: () => current,
    edit: (agent, ref, replacements) => { calls.push(["edit", ref, replacements]); return (current = { ...current, ...replacements, revision: current.revision + 1 }); },
    pause: (agent, ref) => { calls.push(["pause", ref]); return bump("paused"); },
    resume: (agent, ref) => { calls.push(["resume", ref]); return bump("active"); },
  };
}
const activeGoal = { id: "g1", revision: 2, objective: "x", phase: "active", roundsStarted: 0, maxGoalRounds: 8, activation: "armed" };
const humanTurn = () => ({ hasHumanMessage: true });

test("update_goal edit：人类回合 → 调 edit，替换 objective", async () => {
  const goals = fakeGoals(activeGoal);
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: humanTurn, config: {} });
  const value = JSON.parse((await toolOf(server, "update_goal").handler({ goal_id: "g1", revision: 2, action: "edit", objective: "new" })).content[0].text);
  assert.deepEqual(goals.calls[0], ["edit", { id: "g1", revision: 2 }, { objective: "new" }]);
  assert.equal(value.goal.objective, "new");
});

test("update_goal edit：无人类回合 → 拒绝", async () => {
  const goals = fakeGoals(activeGoal);
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: () => ({ hasHumanMessage: false }), config: {} });
  const result = await toolOf(server, "update_goal").handler({ goal_id: "g1", revision: 2, action: "edit", objective: "new" });
  assert.equal(result.isError, true);
  assert.equal(goals.calls.length, 0);
});

test("update_goal pause/resume：人类回合可用", async () => {
  // pause 与 resume 是两个独立场景：resume 用于 fork/恢复后对 active goal 的重新武装。
  // 对「已 paused 且 revision 命中」的 goal 调 resume 会被守卫拒绝（见下一条用例）。
  const paused = fakeGoals(activeGoal);
  const pauseServer = buildGoalServer({ ctx: fakeCtx(paused, runningAgent), agent: runningAgent, turnContext: humanTurn, config: {} });
  assert.equal(JSON.parse((await toolOf(pauseServer, "update_goal").handler({ goal_id: "g1", revision: 2, action: "pause" })).content[0].text).goal.phase, "paused");
  const resumed = fakeGoals(activeGoal);
  const resumeServer = buildGoalServer({ ctx: fakeCtx(resumed, runningAgent), agent: runningAgent, turnContext: humanTurn, config: {} });
  assert.equal(JSON.parse((await toolOf(resumeServer, "update_goal").handler({ goal_id: "g1", revision: 2, action: "resume" })).content[0].text).goal.phase, "active");
});

test("update_goal resume：目标是 paused 时拒绝（只能用户恢复）", async () => {
  const goals = fakeGoals({ ...activeGoal, phase: "paused" });
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: humanTurn, config: {} });
  const result = await toolOf(server, "update_goal").handler({ goal_id: "g1", revision: 2, action: "resume" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /cannot resume a paused goal/);
  assert.equal(goals.calls.length, 0);
});

test("update_goal：非法参数组合被拒（edit 带 blocked_reason / pause 带 objective）", async () => {
  const goals = fakeGoals(activeGoal);
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: humanTurn, config: {} });
  assert.equal((await toolOf(server, "update_goal").handler({ goal_id: "g1", revision: 2, action: "edit", objective: "n", blocked_reason: "r" })).isError, true);
  assert.equal((await toolOf(server, "update_goal").handler({ goal_id: "g1", revision: 2, action: "pause", objective: "n" })).isError, true);
  assert.equal(goals.calls.length, 0);
});

test("update_goal：goal_id/revision 非法 → 拒绝且不调服务", async () => {
  const goals = fakeGoals(activeGoal);
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: humanTurn, config: {} });
  assert.equal((await toolOf(server, "update_goal").handler({ goal_id: " ", revision: 2, action: "edit", objective: "n" })).isError, true);
  assert.equal((await toolOf(server, "update_goal").handler({ goal_id: "g1", revision: 0, action: "pause" })).isError, true);
  assert.equal(goals.calls.length, 0);
});

// ---------------------------------------------------------------------------
// update_goal：complete / blocked
// ---------------------------------------------------------------------------
/** 假 goal 服务补 complete/block。 */
function fakeGoals2(initial) {
  const calls = [];
  return {
    calls,
    get: () => initial,
    complete: (agent, ref) => { calls.push(["complete", ref]); return { ...initial, phase: "complete", revision: initial.revision + 1, activation: "disarmed" }; },
    block: (agent, ref, reason) => { calls.push(["block", ref, reason]); return { ...initial, phase: "blocked", revision: initial.revision + 1, activation: "disarmed", blockedReason: reason }; },
  };
}

test("complete：goal round 内允许（goalSource 与当前 goal 精确匹配）", async () => {
  const goal = { id: "g1", revision: 2, objective: "x", phase: "active", roundsStarted: 1, maxGoalRounds: 8, activation: "armed" };
  const goals = fakeGoals2(goal);
  const turn = () => ({ hasHumanMessage: false, goalSource: { kind: "goal", goalId: "g1", revision: 2, round: 1 } });
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: turn, config: {} });
  const value = JSON.parse((await toolOf(server, "update_goal").handler({ goal_id: "g1", revision: 2, action: "complete" })).content[0].text);
  assert.deepEqual(goals.calls[0], ["complete", { id: "g1", revision: 2 }]);
  assert.equal(value.goal.phase, "complete");
});

test("complete：既无人类回合也无匹配 goal round → 拒绝", async () => {
  const goal = { id: "g1", revision: 2, objective: "x", phase: "active", roundsStarted: 1, maxGoalRounds: 8, activation: "armed" };
  const goals = fakeGoals2(goal);
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: () => ({ hasHumanMessage: false, goalSource: { kind: "goal", goalId: "g1", revision: 2, round: 5 } }), config: {} });
  const result = await toolOf(server, "update_goal").handler({ goal_id: "g1", revision: 2, action: "complete" });
  assert.equal(result.isError, true);
  assert.equal(goals.calls.length, 0);
});

test("blocked：低于阈值拒绝，达到阈值通过并带 model-reported reason", async () => {
  const goal = { id: "g1", revision: 2, objective: "x", phase: "active", roundsStarted: 2, maxGoalRounds: 8, activation: "armed" };
  const goals = fakeGoals2(goal);
  const turn = () => ({ hasHumanMessage: false, goalSource: { kind: "goal", goalId: "g1", revision: 2, round: 2 } });
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: turn, config: { blockedAfterConsecutiveRounds: 3 } });
  const rejected = await toolOf(server, "update_goal").handler({ goal_id: "g1", revision: 2, action: "blocked", blocked_reason: "no access" });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /at least 3 consecutive goal rounds/);

  // 达到阈值：roundsStarted=3 的 goal
  goals.get = () => ({ ...goal, roundsStarted: 3 });
  const server2 = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: () => ({ hasHumanMessage: false, goalSource: { kind: "goal", goalId: "g1", revision: 2, round: 3 } }), config: { blockedAfterConsecutiveRounds: 3 } });
  const okValue = JSON.parse((await toolOf(server2, "update_goal").handler({ goal_id: "g1", revision: 2, action: "blocked", blocked_reason: "no access" })).content[0].text);
  assert.deepEqual(goals.calls.at(-1), ["block", { id: "g1", revision: 2 }, { code: "model-reported", message: "no access" }]);
  assert.equal(okValue.goal.phase, "blocked");
});

test("blocked：缺 blocked_reason / 仅空白 → 拒绝", async () => {
  const goal = { id: "g1", revision: 2, objective: "x", phase: "active", roundsStarted: 3, maxGoalRounds: 8, activation: "armed" };
  const goals = fakeGoals2(goal);
  const turn = () => ({ hasHumanMessage: false, goalSource: { kind: "goal", goalId: "g1", revision: 2, round: 3 } });
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: turn, config: { blockedAfterConsecutiveRounds: 3 } });
  assert.equal((await toolOf(server, "update_goal").handler({ goal_id: "g1", revision: 2, action: "blocked" })).isError, true);
  assert.equal((await toolOf(server, "update_goal").handler({ goal_id: "g1", revision: 2, action: "blocked", blocked_reason: "   " })).isError, true);
  assert.equal(goals.calls.length, 0);
});

test("complete 带 blocked_reason / complete 带 objective → 拒绝", async () => {
  const goal = { id: "g1", revision: 2, objective: "x", phase: "active", roundsStarted: 3, maxGoalRounds: 8, activation: "armed" };
  const goals = fakeGoals2(goal);
  const turn = () => ({ hasHumanMessage: true });
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: turn, config: {} });
  assert.equal((await toolOf(server, "update_goal").handler({ goal_id: "g1", revision: 2, action: "complete", blocked_reason: "r" })).isError, true);
  assert.equal((await toolOf(server, "update_goal").handler({ goal_id: "g1", revision: 2, action: "complete", objective: "n" })).isError, true);
  assert.equal(goals.calls.length, 0);
});

test("领域错误（revision 过期）→ isError，不外抛", async () => {
  const goals = { get: () => ({ id: "g1", revision: 9, objective: "x", phase: "active", roundsStarted: 3, maxGoalRounds: 8, activation: "armed" }), complete: () => { const e = new Error("goal complete does not preserve the current counters"); e.code = "GOAL_CONFLICT"; throw e; } };
  const server = buildGoalServer({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: () => ({ hasHumanMessage: true }), config: {} });
  const result = await toolOf(server, "update_goal").handler({ goal_id: "g1", revision: 2, action: "complete" });
  assert.equal(result.isError, true);
});

test("domain / MCP 在相同输入下返回相同结果，不接受自报人类权限", async () => {
  const goal = { id: "g1", revision: 2, objective: "x", phase: "active", roundsStarted: 3, maxGoalRounds: 8, activation: "armed" };
  const scenarios = [
    ["get_goal", {}, false],
    ["create_goal", { objective: "long task" }, true],
    ["create_goal", { objective: "long task" }, false],
    ["create_goal", { objective: "long task", hasHumanMessage: true }, false],
    ["update_goal", { goal_id: "g1", revision: 2, action: "complete" }, false],
    ["update_goal", { goal_id: "g1", revision: 1, action: "complete" }, true],
    ["update_goal", { goal_id: "g1", revision: 2, action: "blocked", blocked_reason: "no access" }, false],
    ["update_goal", { goal_id: "g1", revision: 2, action: "unknown" }, true],
  ];
  for (const [name, args, human] of scenarios) {
    const goals = { get: () => goal, create: () => goal,
      complete: (_agent, ref) => { if (ref.revision !== goal.revision) throw new Error("GOAL_CONFLICT"); return { ...goal, phase: "complete" }; },
      block: () => ({ ...goal, phase: "blocked" }),
    };
    const options = { ctx: fakeCtx(goals, runningAgent), agent: runningAgent,
      turnContext: () => ({ hasHumanMessage: human, goalSource: { goalId: "g1", revision: 2, round: 3 } }), config: {} };
    const domain = buildGoalHandlers(options);
    const mcp = buildGoalServer(options);
    assert.deepEqual(await domain[name](args), await toolOf(mcp, name).handler(args));
  }
  const handlers = buildGoalHandlers({ ctx: fakeCtx({ create: () => { throw new Error("must not create"); } }, runningAgent), agent: runningAgent,
    turnContext: () => ({ hasHumanMessage: false }), config: {} });
  assert.equal((await handlers.create_goal({ objective: "x", source: { kind: "user" } })).isError, true);
});

test("domain 入口要求精确 live running agent 与开放回合", async () => {
  let reads = 0;
  const agent = { id: "caller", status: "running" };
  const ctx = fakeCtx({ get: () => { reads += 1; return activeGoal; } }, agent);
  let turn = { hasHumanMessage: true };
  const handlers = buildGoalHandlers({ ctx, agent, turnContext: () => turn });
  ctx.agents.get = () => ({ ...agent });
  assert.equal((await handlers.get_goal({})).isError, true);
  ctx.agents.get = () => agent;
  agent.status = "idle";
  assert.equal((await handlers.get_goal({})).isError, true);
  agent.status = "running";
  turn = undefined;
  assert.equal((await handlers.get_goal({})).isError, true);
  assert.equal(reads, 0);
});

test("mod 工具定义提供严格 JSON schema，并拒绝错误类型/未知 action", async () => {
  const definitions = goalToolDefinitions();
  assert.deepEqual(definitions.map((definition) => definition.name), ["get_goal", "create_goal", "update_goal"]);
  for (const definition of definitions) {
    assert.equal(definition.inputSchema.type, "object");
    assert.equal(definition.inputSchema.additionalProperties, false);
  }
  assert.deepEqual(definitions[2].inputSchema.properties.action.enum, ["edit", "pause", "resume", "complete", "blocked"]);
  const goals = { get: () => activeGoal, create: () => { throw new Error("must not create"); }, block: () => { throw new Error("must not block"); } };
  const handlers = buildGoalHandlers({ ctx: fakeCtx(goals, runningAgent), agent: runningAgent, turnContext: humanTurn });
  for (const args of [{ objective: 42 }, { objective: "x", max_goal_rounds: 0 }, { objective: "x", max_goal_rounds: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal((await handlers.create_goal(args)).isError, true);
  }
  assert.equal((await handlers.update_goal({ goal_id: "g1", revision: 2, action: "invalid" })).isError, true);
});

// ---------------------------------------------------------------------------
// §5 不变量：桥接代码绝不自己 append 会话事件（所有变更都走注入的 goals 服务）
// ---------------------------------------------------------------------------
test("§5：三个工具都不直接写 session —— 每次 goal 变更只经 goals 服务", async () => {
  const goal = { id: "g1", revision: 1, objective: "x", phase: "active", roundsStarted: 0, maxGoalRounds: 8, activation: "armed" };
  const calls = [];
  const goals = {
    get: () => goal,
    create: (_agent, request) => { calls.push(["create", request]); return { ...goal, objective: request.objective }; },
    edit: (_agent, ref, replacements) => { calls.push(["edit", ref, replacements]); return { ...goal, ...replacements, revision: goal.revision + 1 }; },
  };
  const ctx = fakeCtx(goals, runningAgent);
  const server = buildGoalServer({ ctx, agent: runningAgent, turnContext: () => ({ hasHumanMessage: true }), config: {} });
  await toolOf(server, "get_goal").handler({});
  await toolOf(server, "create_goal").handler({ objective: "ship it" });
  await toolOf(server, "update_goal").handler({ goal_id: "g1", revision: 1, action: "edit", objective: "new" });
  assert.equal(calls.length, 2, "create_goal / update_goal 应各自落到 goals 服务");
  assert.equal(ctx.session.appended.length, 0, "桥接代码不得直接 append 会话事件（§5 不变量）");
});
