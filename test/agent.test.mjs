// test/agent.test.mjs — ClaudeCodeAgent.drive() 的回合收尾契约。
//
// 宿主的 dsh-workspace-changes 记录器靠 `agent/turn-stopping` 在轮内记录改动文件：
// 原生 dsh-agent-loop 在 append `turn/end` **之前** serial 派发该事件（见 dsh-agent-loop
// lib/index.js 的 runTurn），记录器因此在轮内完成记录并 append `workspace/changes`，
// 客户端的改动文件卡片随收尾消息一起渲染。
// 本插件自己驱动回合，必须遵守同一契约：turn-stopping 先于 turn/end。否则记录器退回
// turn/end 兜底路径，`workspace/changes` 落在 turn/end 之后，卡片要等下一轮 turn/start
// 才渲染（实测表现：每轮结束后的文件变更延迟到下一次发消息才显示）。
import { test, mock } from "node:test";
import assert from "node:assert/strict";

// --- 模块 mock：drive() 的两个外部依赖，避免拉起真实 claude CLI 与宿主服务 ---
let runCalls = [];
let runResult = {
  output: [{ type: "text", text: "ok" }],
  stopReason: "completed",
  claudeSessionId: "claude-1",
  logIntact: true,
};
const realClaudeRun = await import("../lib/claude-run.mjs");
mock.module("../lib/claude-run.mjs", {
  namedExports: {
    // subagents.mjs 还从该模块取这三个导出，必须原样带上；
    // 不能整包 spread —— 对自身命名空间做 mock 会递归爆栈。
    ClaudeRunTracer: realClaudeRun.ClaudeRunTracer,
    SUBAGENT_TOOL_NAMES: realClaudeRun.SUBAGENT_TOOL_NAMES,
    PROVIDER: realClaudeRun.PROVIDER,
    runClaudeCode: async (options) => {
      runCalls.push({ ...options, turnContextSnapshot: typeof options.turnContext === "function" ? options.turnContext() : undefined });
      return { ...runResult };
    },
  },
});
mock.module("../lib/auth.mjs", {
  namedExports: {
    resolveClaude: async () => ({ executable: "fake-claude", env: {} }),
  },
});

const { ClaudeCodeAgent } = await import("../lib/agent.mjs");
import { Context } from "@deepseek-ai/cordis";

/**
 * 假会话：记录 append 次序（timeline 与 dispatch 共用，用于断言先后关系）。
 * @param {string[]} timeline 共享的次序记录
 */
function fakeSession(timeline) {
  const events = [];
  return {
    id: "s1",
    header: { cwd: "D:/tmp/workspace" },
    events,
    append(type, data, opts) {
      const event = { type, data, opts, seq: events.length, time: Date.now() };
      events.push(event);
      timeline.push(`session:${type}`);
      return event;
    },
    snapshotEvents: () => [...events],
    requestHeader: () => undefined,
    requestContext: () => undefined,
  };
}

/** 假 dispatch：serial/emit 都记进 timeline。 */
function fakeDispatch(timeline) {
  return {
    emit() {},
    serial: async (name, payload) => {
      timeline.push(`dispatch:${name}`);
      return undefined;
    },
    waterfall: () => undefined,
  };
}

/** 驱动一个完整回合；返回 { session, timeline, agent }。 */
async function driveOneTurn(message = { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "hi" }] }) {
  const timeline = [];
  const session = fakeSession(timeline);
  const ctx = new Context();
  ctx.provide("agents", { withInitiator: async (_agent, fn) => fn() });
  const agent = new ClaudeCodeAgent(ctx, "agent-1", {}, session, { traceSubagents: false });
  agent.dispatch = fakeDispatch(timeline);
  agent.inbox = {
    nextTurn: [message],
    // 真实 DshInbox.claim 会把队列取空；假件必须同样如此，否则 drive() 死循环。
    claim: (_target, _turn) => {
      agent.inbox.nextTurn = [];
      return [message];
    },
  };
  agent.wakeDriver();
  await agent.whenIdle();
  return { session, timeline, agent };
}

test("回合正常收尾时，turn-stopping 先于 turn/end 派发（宿主轮内记录契约）", async () => {
  const { session, timeline } = await driveOneTurn();
  assert.equal(runCalls.length, 1, "runClaudeCode 应被调用一次");
  const types = session.events.map((event) => event.type);
  assert.ok(types.includes("turn/start"), "应有 turn/start");
  assert.ok(types.includes("turn/end"), "应有 turn/end");
  assert.equal(session.events.find((event) => event.type === "turn/end")?.data.turn, 1);

  const stoppingIndex = timeline.indexOf("dispatch:agent/turn-stopping");
  const turnEndIndex = timeline.indexOf("session:turn/end");
  assert.notEqual(stoppingIndex, -1, "必须 serial 派发 agent/turn-stopping（宿主记录器在轮内记录的唯一入口）");
  assert.ok(stoppingIndex < turnEndIndex, `agent/turn-stopping（位置 ${stoppingIndex}）必须先于 turn/end（位置 ${turnEndIndex}）落盘`);
});

test("logIntact=false 时回合不补 turn/end，也不派发 turn-stopping", async () => {
  runResult = { output: [], stopReason: "completed", claudeSessionId: "claude-1", logIntact: false };
  try {
    const { session, timeline } = await driveOneTurn();
    const types = session.events.map((event) => event.type);
    assert.ok(types.includes("turn/start"));
    assert.ok(!types.includes("turn/end"), "logIntact=false 时不得补 turn/end");
    assert.equal(timeline.indexOf("dispatch:agent/turn-stopping"), -1, "turn 未闭合时不应派发 turn-stopping");
  } finally {
    runResult = { output: [{ type: "text", text: "ok" }], stopReason: "completed", claudeSessionId: "claude-1", logIntact: true };
  }
});

test("currentTurnContext：人类消息回合 → hasHumanMessage 为真、无 goalSource；回合后清空", async () => {
  const { agent } = await driveOneTurn({ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "hi" }] });
  const snapshot = runCalls.at(-1).turnContextSnapshot;
  assert.deepEqual(snapshot, { hasHumanMessage: true, goalSource: undefined });
  assert.deepEqual(agent.currentTurnContext(), { hasHumanMessage: false, goalSource: undefined }, "回合结束后必须清空");
});

test("currentTurnContext：goal round → 捕获 goalSource、hasHumanMessage 为假", async () => {
  const source = { kind: "goal", goalId: "g1", revision: 1, round: 1 };
  const { agent } = await driveOneTurn({ role: "user", source, content: [{ type: "text", text: "<goal_round>…" }] });
  const snapshot = runCalls.at(-1).turnContextSnapshot;
  assert.equal(snapshot.hasHumanMessage, false);
  assert.deepEqual(snapshot.goalSource, source);
  assert.deepEqual(agent.currentTurnContext(), { hasHumanMessage: false, goalSource: undefined });
});
