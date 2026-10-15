// test/agent.test.mjs — ClaudeCodeAgent.drive() 的回合收尾契约。
//
// 宿主的 dsh-workspace-changes 记录器靠 `agent/turn-stopping` 在轮内记录改动文件：
// 原生 dsh-agent-loop 在 append `turn/end` **之前** serial 派发该事件（见 dsh-agent-loop
// lib/index.js 的 runTurn），记录器因此在轮内完成记录并 append `workspace/changes`，
// 客户端的改动文件卡片随收尾消息一起渲染。
// 本插件自己驱动回合，必须遵守同一契约：turn-stopping 先于 turn/end。否则记录器退回
// turn/end 兜底路径，`workspace/changes` 落在 turn/end 之后，卡片要等下一轮 turn/start
// 才渲染（实测表现：每轮结束后的文件变更延迟到下一次发消息才显示）。
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { RunInputLedger } from "../lib/run-input.mjs";
import { attachFacts } from "./helpers/plugin-facts.mjs";
import { wireGoalFixture } from "./helpers/goal-fixture.mjs";
let resolveHook;
beforeEach(() => {
  runCalls = [];
  runResult = { output: [{ type: "text", text: "ok" }], stopReason: "completed", logIntact: true };
  resolveHook = undefined;
});

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
      if (runResult.initialSubmitted !== false) {
        const ids = options.initialMessages.filter((message) => typeof message.id === "string").map((message) => message.id);
        if (ids.length) new RunInputLedger(options.session, options.inputEpoch).submitBatch(ids, { sdkUuid: ids.at(-1), shouldQuery: true });
      }
      return { ...runResult, initialSubmitted: runResult.initialSubmitted ?? true };
    },
  },
});
mock.module("../lib/auth.mjs", {
  namedExports: {
    resolveClaude: async (options) => { await resolveHook?.(options); return { executable: "fake-claude", env: {} }; },
  },
});

const { ClaudeCodeAgent } = await import("../lib/agent.mjs");
import { Context } from "@deepseek-ai/cordis";

/**
 * 假会话：记录 append 次序（timeline 与 dispatch 共用，用于断言先后关系）。
 * @param {string[]} timeline 共享的次序记录
 */
function fakeSession(timeline, onNativeEvent = () => {}) {
  const events = [];
  return attachFacts({
    id: "s1",
    header: { cwd: "D:/tmp/workspace" },
    events,
    append(type, data, opts) {
      const event = { type, data, opts, seq: events.length, time: Date.now() };
      events.push(event);
      timeline.push(`session:${type}`);
      onNativeEvent(event);
      return event;
    },
    snapshotEvents: () => [...events],
    requestHeader: () => undefined,
    requestContext: () => undefined,
  });
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
async function driveOneTurn(message = { id: "human", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "hi" }] }) {
  return driveBatch([{ target: "next-turn", message, querying: true }]);
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

test("日志拒写后停止整个驱动，后续 followup 留在 inbox", async () => {
  const timeline = [];
  const session = fakeSession(timeline);
  const ctx = new Context();
  ctx.provide("agents", { withInitiator: async (_agent, fn) => fn() });
  const agent = new ClaudeCodeAgent(ctx, "agent-1", {}, session, { traceSubagents: false });
  agent.dispatch = fakeDispatch(timeline);
  const before = runCalls.length;
  runResult = { output: [], stopReason: "error", logIntact: false };
  try {
    for (const id of ["first", "pending"]) agent.inbox.append("next-turn", { id, role: "user", source: { kind: "user" }, content: [{ type: "text", text: id }] });
    agent.wakeDriver();
    await agent.whenIdle();
    assert.equal(runCalls.length - before, 1);
    assert.deepEqual(agent.inbox.nextTurn.map((message) => message.id), ["pending"]);
  } finally {
    runResult = { output: [{ type: "text", text: "ok" }], stopReason: "completed", claudeSessionId: "claude-1", logIntact: true };
    await agent.dispose();
  }
});

test("currentTurnContext：人类消息回合 → hasHumanMessage 为真、无 goalSource；回合后清空", async () => {
  const { agent } = await driveOneTurn({ id: "human", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "hi" }] });
  const snapshot = runCalls.at(-1).turnContextSnapshot;
  assert.deepEqual(snapshot, { hasHumanMessage: true, goalSource: undefined });
  assert.deepEqual(agent.currentTurnContext(), { hasHumanMessage: false, goalSource: undefined }, "回合结束后必须清空");
});

test("currentTurnContext：goal round → 捕获 goalSource、hasHumanMessage 为假", async () => {
  const source = { kind: "goal", goalId: "g1", revision: 1, round: 1 };
  // 与 drive() 实际 append 的必须是同一个对象：既用于 claim，也用于下面的逐位断言。
  const claimedMessage = { id: "g-auto", role: "user", source, content: [{ type: "text", text: "<goal_round>…" }] };
  const { session, agent } = await driveOneTurn(claimedMessage);
  const snapshot = runCalls.at(-1).turnContextSnapshot;
  assert.equal(snapshot.hasHumanMessage, false);
  assert.deepEqual(snapshot.goalSource, source);
  assert.deepEqual(agent.currentTurnContext(), { hasHumanMessage: false, goalSource: undefined });
  // §5：转发路径不改写消息 —— user/message 事件与 claim 的消息逐位一致（含 source）。
  const forwarded = session.events.find((event) => event.type === "user/message");
  assert.ok(forwarded, "应有 user/message");
  assert.deepEqual(forwarded.data, claimedMessage);
});

const automatic = { id: "g-auto", role: "user", source: { kind: "goal", goalId: "g1", revision: 1, round: 1 },
  content: [{ type: "text", text: "OLD-GOAL" }] };
const human = { id: "human", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "HUMAN" }] };
const injected = { id: "context", role: "user", source: { kind: "system" }, content: [{ type: "text", text: "CONTEXT" }] };
const entry = (message, target = "next-turn", querying = true) => ({ message, target, querying });
const countNative = (session, id) => session.events.filter(e => e.type === "user/message" && e.data.id === id).length;
async function driveBatch(entries, { view, attachments, onNativeEvent, onClaim, onCreated } = {}) {
  const timeline = [];
  const ctx = new Context();
  let agent;
  const goal = wireGoalFixture(ctx, () => agent);
  if (view !== undefined) goal.view = structuredClone(view);
  if (attachments) ctx.provide("attachments", attachments);
  const session = fakeSession(timeline, (event) => {
    goal.onNativeEvent(event);
    onNativeEvent?.(event, { goal, agent });
  });
  agent = new ClaudeCodeAgent(ctx, "agent-1", {}, session, { traceSubagents: false });
  Object.assign(agent.dispatch, fakeDispatch(timeline));
  agent.dispatch.emit = (name, payload) => {
    timeline.push(`dispatch:${name}`);
    if (name === "agent/inbox/claimed") onClaim?.(payload, { goal, agent });
  };
  for (const item of entries) agent.inbox.enqueue(item.target, item.message, item.querying);
  onCreated?.({ goal, agent, session });
  agent.wakeDriver();
  await agent.whenIdle();
  return { session, timeline, agent, goal };
}

// A missing gate would register stale goals or submit their old prepared prompt.
test("旧 revision 混合批只准备 querying human", async () => {
  const { session, goal } = await driveBatch([entry(human, "next-step"), entry(automatic)], {
    view: { id: "g1", revision: 2, phase: "active", activation: "armed", roundsStarted: 0, maxGoalRounds: 3 },
  });
  assert.equal(countNative(session, automatic.id), 0);
  assert.equal(runCalls.length, 1);
  assert.deepEqual(runCalls[0].initialMessages, [human]);
  assert.equal(runCalls[0].prompt.includes("OLD-GOAL"), false);
  assert.equal(goal.view.roundsStarted, 0);
});
test("合法 goal 只登记一次且计数仅在 native admission 推进", async () => {
  const { session, goal } = await driveBatch([entry(automatic)]);
  assert.equal(countNative(session, automatic.id), 1);
  assert.equal(runCalls.length, 1);
  assert.equal(goal.view.roundsStarted, 1);
});
for (const waitAt of ["resolve", "image"]) {
  for (const mutation of ["edit", "pause", "disarm", "remove", "replace", "steer"]) {
    test(`${waitAt} 等待期间 ${mutation} 不沿用旧准备结果`, async () => {
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      const created = Promise.withResolvers();
      const image = { type: "image", attachment: { attachmentId: "image", width: 1, height: 1 } };
      const message = waitAt === "image" ? { ...automatic, content: [...automatic.content, image] } : automatic;
      const wait = async () => { entered.resolve(); await release.promise; };
      if (waitAt === "resolve") resolveHook = wait;
      const running = driveBatch([entry(message)], {
        onCreated: created.resolve,
        attachments: waitAt === "image" ? { async readImageRequest() { await wait(); return { data: new Uint8Array([1]), mediaType: "image/png" }; } } : undefined,
      });
      try {
        const { goal, agent } = await created.promise;
        await entered.promise;
        if (mutation === "edit") goal.view.revision += 1;
        if (mutation === "pause") goal.view.phase = "paused";
        if (mutation === "disarm") goal.view.activation = "disarmed";
        if (mutation === "remove") agent.inbox.remove(message.id);
        if (mutation === "replace") agent.inbox.replace(message.id, { ...human, id: message.id });
        if (mutation === "steer") agent.inbox.enqueue("next-step", human, true);
        release.resolve();
        const { session } = await running;
        if (["edit", "pause", "disarm", "remove"].includes(mutation)) {
          assert.equal(countNative(session, message.id), 0);
          assert.equal(runCalls.length, 0);
          assert.equal(goal.view.roundsStarted, 0);
        } else if (mutation === "replace") {
          assert.equal(runCalls.length, 1);
          assert.equal(runCalls[0].prompt, "HUMAN");
          assert.equal(goal.view.roundsStarted, 0);
        } else {
          assert.equal(runCalls.length, 2);
          assert.deepEqual(runCalls.map(c => c.initialMessages.map(m => m.id)), [[message.id], [human.id]]);
        }
      } finally { release.resolve(); resolveHook = undefined; await running; }
    });
  }
}
for (const stage of ["claim", "turn/start", "human-user-message"]) {
  test(`同步 ${stage} 失效保留人类登记且不启动旧批`, async () => {
    const change = ({ goal }) => { goal.view.revision = 2; };
    const { agent, session, goal, timeline } = await driveBatch([entry(human, "next-step"), entry(automatic)], {
      onClaim: stage === "claim" ? (_payload, state) => change(state) : undefined,
      onNativeEvent: (event, state) => {
        if (stage === "turn/start" && event.type === "turn/start") change(state);
        if (stage === "human-user-message" && event.type === "user/message" && event.data.id === human.id) change(state);
      },
    });
    assert.equal(runCalls.length, 0);
    assert.equal(countNative(session, automatic.id), 0);
    assert.equal(countNative(session, human.id), 1);
    assert.equal(goal.view.roundsStarted, 0);
    assert.equal(session.events.find(e => e.type === "turn/end").data.reason.error.code, "GOAL_INPUT_REJECTED");
    assert.ok(timeline.indexOf("dispatch:agent/turn-stopping") < timeline.indexOf("session:turn/end"));
    agent.wakeDriver();
    await agent.whenIdle();
    assert.equal(runCalls.length, 1);
    assert.equal(countNative(session, human.id), 1);
  });
}
test("claim 同步 abort 不登记自动项并保留 reservation", async () => {
  const { agent, session } = await driveBatch([entry(automatic)], {
    onClaim: (_payload, { agent }) => agent.cancel({ kind: "user" }, { keepInbox: true }),
  });
  assert.equal(countNative(session, automatic.id), 0);
  assert.equal(runCalls.length, 0);
  assert.equal(agent.inbox.nextTurn.length, 1);
});
test("多条自动 goal 全拒绝而 human 来源内容保持", async () => {
  const { session, goal } = await driveBatch([entry(automatic, "next-step"), entry({ ...automatic, id: "g2" }, "next-step"), entry(human)]);
  assert.equal(countNative(session, automatic.id), 0);
  assert.equal(countNative(session, "g2"), 0);
  assert.equal(runCalls.length, 1);
  assert.deepEqual(runCalls[0].initialMessages, [human]);
  assert.equal(goal.view.roundsStarted, 0);
});
test("拒绝 goal 后纯 inject 保持 pending 且不查询", async () => {
  const { agent, session } = await driveBatch([entry(injected, "next-step", false), entry({ ...automatic, source: { ...automatic.source, round: 0 } })]);
  assert.equal(runCalls.length, 0);
  assert.equal(countNative(session, automatic.id), 0);
  assert.deepEqual(agent.inbox.nextStep, [injected]);
  assert.equal(agent.steers.has(injected.id), false);
});
test("goal 读取失败暂挂但队列后面的 human 可以完成", async () => {
  const { agent, goal, session, timeline } = await driveBatch([entry(automatic), entry(human)], {
    onCreated: ({ goal }) => { goal.error = new Error("private objective must not leak"); },
  });
  assert.equal(countNative(session, automatic.id), 0);
  assert.equal(countNative(session, human.id), 1);
  assert.equal(runCalls.length, 1);
  assert.equal(goal.reads, 1);
  assert.equal(agent.inbox.nextTurn[0].id, automatic.id);
  assert.equal(timeline.includes("dispatch:agent/error"), false);
});
test("失败 hold + keepInbox/wakeRequested 收尾不自唤醒，inject 不重评估", async () => {
  const { agent, goal } = await driveBatch([entry(automatic)], {
    onCreated: ({ goal, agent }) => {
      goal.error = new Error("projection failed");
      agent.dispatch.emit = (name) => {
        if (name === "agent/status" && agent.status === "running") {
          agent.phase.keepInbox = true;
          agent.phase.wakeRequested = true;
        }
      };
    },
  });
  assert.equal(goal.reads, 1);
  assert.equal(runCalls.length, 0);
  agent.inject(injected);
  await agent.whenIdle();
  assert.equal(goal.reads, 1);
  assert.equal(agent.status, "idle");
});
test("维护 wakeRequested 不重试暂挂 goal，querying system 可绕过", async () => {
  const { agent, goal } = await driveBatch([entry(automatic)], { onCreated: ({ goal }) => { goal.error = new Error("projection failed"); } });
  const reads = goal.reads;
  await agent.runMaintenance(async () => { agent.phase.wakeRequested = true; });
  assert.equal(goal.reads, reads);
  agent.followup(injected);
  await agent.whenIdle();
  assert.equal(runCalls.length, 1);
  assert.deepEqual(runCalls[0].initialMessages, [injected]);
  assert.equal(goal.reads, reads + 1);
});
test("同 id replacement 不继承旧 hold", async () => {
  const { agent, goal } = await driveBatch([entry(automatic)], { onCreated: ({ goal }) => { goal.error = new Error("projection failed"); } });
  const replacement = { ...human, id: automatic.id };
  agent.inbox.replace(automatic.id, replacement);
  agent.wakeDriver();
  await agent.whenIdle();
  assert.equal(runCalls.length, 1);
  assert.deepEqual(runCalls[0].initialMessages, [replacement]);
  assert.equal(goal.reads, 1);
});
for (const failAt of ["reserved", "native", "turn-end"]) {
  test(`${failAt} 拒写不查询或自动重启且不丢待办`, async () => {
    const { agent, session } = await driveBatch([entry(human, "next-step"), entry(automatic)], {
      onCreated: ({ agent, session }) => {
        if (failAt === "reserved") session.rejectFact = record => { if (record.data.state === "reserved") throw new Error("ledger write failed"); };
        if (failAt !== "reserved") {
          const append = session.append.bind(session);
          session.append = (type, data, opts) => {
            if ((failAt === "native" && type === "user/message") || (failAt === "turn-end" && type === "turn/end")) throw new Error("native write failed");
            return append(type, data, opts);
          };
        }
        if (failAt === "turn-end") agent.dispatch.emit = (name) => { if (name === "agent/inbox/claimed") agent.loopCtx.goals.get = () => ({ id: "g1", revision: 2, phase: "active", activation: "armed", roundsStarted: 0, maxGoalRounds: 3 }); };
      },
    });
    assert.equal(runCalls.length, 0);
    assert.equal(countNative(session, automatic.id), 0);
    assert.equal(agent.status, "idle");
    assert.ok(agent.inbox.hasPending);
  });
}
