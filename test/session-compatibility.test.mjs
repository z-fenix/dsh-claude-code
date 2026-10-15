import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Session, KNOWN_SESSION_EVENT_TYPES } from "@deepseek-ai/dsh-session";
import { DshInbox } from "../lib/inbox.mjs";
import { pluginFacts, bindPluginFacts, PluginFacts } from "../lib/plugin-facts.mjs";
import { ClaudeRunControl } from "../lib/run-control.mjs";
import { RunInputLedger, registerInputMessage } from "../lib/run-input.mjs";
import { assessGoalAdmission } from "../lib/goal-domain.mjs";
import { attachFacts } from "./helpers/plugin-facts.mjs";
import { ClaudeRunTracer } from "../lib/claude-run.mjs";
import { expandAssistantStream } from "@deepseek-ai/dsh-llm";
import { assertSessionRelations } from "./helpers/session-relations.mjs";

for (const ending of ["eof", "error", "cancel"]) {
  test(`真实 Session 保留 ${ending} 的 stream-only 前缀并可重建`, async () => {
    const session = Session.create(`stream-prefix-${ending}`);
    const frames = [];
    session.append("turn/start", { turn: 1 });
    const sink = {
      sessionId: session.id,
      append: (...args) => session.append(...args),
      requestHeader: () => session.requestHeader(),
      requestContext: () => session.requestContext(),
    };
    const tracer = new ClaudeRunTracer(sink, 1, { emitStream: (frame) => frames.push(frame) });
    tracer.handleMessage({ type: "stream_event", event: {
      type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "synthetic prefix" },
    } });
    if (ending === "error") tracer.handleMessage({ type: "result", subtype: "error_during_execution" });
    tracer.finish();
    assert.equal(tracer.logIntact, true);
    const reason = ending === "cancel" ? { kind: "aborted", reason: { kind: "user" } }
      : { kind: "error", error: { code: "SYNTHETIC", message: ending } };
    session.append("turn/end", { turn: 1, reason });
    const events = session.snapshotEvents();
    assert.deepEqual(events.filter((event) => !KNOWN_SESSION_EVENT_TYPES.has(event.type)), []);
    await assertSessionRelations(session);
    const reopened = Session.create(session.id, events, session.header);
    await assertSessionRelations(reopened);
    const messages = reopened.snapshotEvents().filter((event) => event.type === "assistant/message");
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].data.message.content, [{ type: "text", text: "synthetic prefix" }]);
    assert.equal(messages[0].data.usage, undefined);
    assert.deepEqual(reopened.deriveMessages().map((message) => message.content), [[{ type: "text", text: "synthetic prefix" }]]);
    assert.deepEqual(expandAssistantStream(messages[0].data.stream).map((value) => value.chunk), [
      { type: "text-delta", index: 0, text: "synthetic prefix" },
    ]);
    assert.equal(events.filter((event) => event.type === "user/message").length, 0);
    assert.equal(events.filter((event) => event.type === "goal/change").length, 0);
    assert.deepEqual(frames.filter((frame) => frame.type === "end").map((frame) => frame.outcome), [
      { kind: "committed", eventType: "assistant/message", seq: messages[0].seq },
    ]);
    const invalidStep = events.map((event) => event.type === "assistant/message"
      ? { ...event, data: { ...event.data, step: 2 } } : event);
    await assert.rejects(assertSessionRelations({ snapshotEvents: () => invalidStep }), /assistant\/message names/);
    assert.throws(() => expandAssistantStream([{ type: "text-chunks", index: -1, time0: 1, dt: [], texts: ["bad"] }]), /index/);
  });
}

for (const ending of ["cancel", "error"]) {
  test(`真实 Session 重建保留部分 thinking envelope 后的 ${ending} 文本`, async () => {
    const session = Session.create(`partial-envelope-${ending}`);
    const frames = [];
    session.append("turn/start", { turn: 1 });
    const tracer = new ClaudeRunTracer({
      sessionId: session.id,
      append: (...args) => session.append(...args),
    }, 1, { emitStream: (frame) => frames.push(frame) });
    for (const message of [
      { type: "stream_event", event: { type: "content_block_delta", index: 0,
        delta: { type: "thinking_delta", thinking: "synthetic reasoning" } } },
      { type: "assistant", message: { id: "partial", content: [{ type: "thinking", thinking: "synthetic reasoning" }] } },
      { type: "stream_event", event: { type: "content_block_delta", index: 1,
        delta: { type: "text_delta", text: "synthetic interrupted answer" } } },
    ]) tracer.handleMessage(message);
    if (ending === "error") tracer.handleMessage({ type: "result", subtype: "error_during_execution",
      usage: { input_tokens: 99, output_tokens: 20 } });
    tracer.finish();
    tracer.finish();
    assert.equal(tracer.logIntact, true);
    const reason = ending === "cancel" ? { kind: "aborted", reason: { kind: "user" } }
      : { kind: "error", error: { code: "SYNTHETIC", message: "interrupted" } };
    session.append("turn/end", { turn: 1, reason });
    const events = session.snapshotEvents();
    await assertSessionRelations(session);
    const reopened = Session.create(session.id, events, session.header);
    await assertSessionRelations(reopened);
    const messages = reopened.snapshotEvents().filter((event) => event.type === "assistant/message");
    assert.equal(messages.length, 1);
    const expected = [
      { type: "reasoning", text: "synthetic reasoning" }, { type: "text", text: "synthetic interrupted answer" },
    ];
    assert.deepEqual(messages[0].data.message.content, expected);
    assert.deepEqual(reopened.deriveMessages().map((message) => message.content), [expected]);
    assert.deepEqual(expandAssistantStream(messages[0].data.stream).map((value) => value.chunk), [
      { type: "reasoning-delta", index: 0, text: "synthetic reasoning" },
      { type: "text-delta", index: 1, text: "synthetic interrupted answer" },
    ]);
    assert.equal(messages[0].data.usage, undefined);
    assert.deepEqual(frames.filter((frame) => frame.type === "end").map((frame) => frame.outcome), [
      { kind: "committed", eventType: "assistant/message", seq: messages[0].seq },
    ]);
    assert.equal(events.filter((event) => event.type === "step/end").length, 1);
    for (const type of ["tool/call", "user/message", "goal/change"]) assert.equal(events.filter((event) => event.type === type).length, 0);
    assert.deepEqual(events.at(-1).data.reason, reason);
  });
}

for (const withRedactedStart of [true, false]) {
  test(`真实 Session 取消后保留 redacted_thinking 之后的观察文本，start=${withRedactedStart}`, async () => {
    const session = Session.create(`redacted-thinking-cancel-${withRedactedStart}`);
    const frames = [];
    session.append("turn/start", { turn: 1 });
    const tracer = new ClaudeRunTracer({
      sessionId: session.id,
      append: (...args) => session.append(...args),
    }, 1, { emitStream: (frame) => frames.push(frame) });
    const redacted = { type: "redacted_thinking", data: "SYNTHETIC-ENCRYPTED" };
    for (const message of [
      ...(withRedactedStart ? [{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: redacted } }] : []),
      { type: "stream_event", event: { type: "content_block_delta", index: 1,
        delta: { type: "text_delta", text: "synthetic visible answer" } } },
      { type: "assistant", message: { id: "redacted", content: [redacted] } },
    ]) tracer.handleMessage(message);
    tracer.finish();
    tracer.finish();
    assert.equal(tracer.logIntact, true);
    session.append("turn/end", { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } });
    const events = session.snapshotEvents();
    assert.deepEqual(events.filter((event) => !KNOWN_SESSION_EVENT_TYPES.has(event.type)), []);
    await assertSessionRelations(session);
    const reopened = Session.create(session.id, events, session.header);
    await assertSessionRelations(reopened);
    const messages = reopened.snapshotEvents().filter((event) => event.type === "assistant/message");
    assert.equal(messages.length, 1);
    const expected = [{ type: "text", text: "synthetic visible answer" }];
    assert.deepEqual(messages[0].data.message.content, expected);
    assert.deepEqual(reopened.deriveMessages().map((message) => message.content), [expected]);
    assert.deepEqual(expandAssistantStream(messages[0].data.stream).map((value) => value.chunk), [
      { type: "text-delta", index: 1, text: "synthetic visible answer" },
    ]);
    assert.equal(messages[0].data.usage, undefined);
    assert.equal(JSON.stringify(events).includes("SYNTHETIC-ENCRYPTED"), false, "redacted 密文不进日志");
    assert.deepEqual(frames.filter((frame) => frame.type === "end").map((frame) => frame.outcome), [
      { kind: "committed", eventType: "assistant/message", seq: messages[0].seq },
    ]);
    assert.equal(events.filter((event) => event.type === "step/end").length, 1);
    for (const type of ["tool/call", "user/message", "goal/change"]) assert.equal(events.filter((event) => event.type === type).length, 0);
  });
}

for (const reasoningFirst of [true, false]) {
  test(`同 index 的 text/reasoning 冲突不生成错归类的 Session 正文，reasoningFirst=${reasoningFirst}`, async () => {
    const session = Session.create(`stream-kind-conflict-${reasoningFirst}`);
    const frames = [];
    session.append("turn/start", { turn: 1 });
    const tracer = new ClaudeRunTracer({
      sessionId: session.id,
      append: (...args) => session.append(...args),
    }, 1, { emitStream: (frame) => frames.push(frame) });
    const deltas = [
      { type: "thinking_delta", thinking: "reason" },
      { type: "text_delta", text: "VISIBLE ANSWER" },
    ];
    if (!reasoningFirst) deltas.reverse();
    for (const delta of deltas) tracer.handleMessage({ type: "stream_event", event: {
      type: "content_block_delta", index: 0, delta,
    } });
    tracer.finish();
    tracer.finish();
    assert.equal(tracer.logIntact, true);
    assert.deepEqual(session.snapshotEvents().map((event) => event.type), ["turn/start", "step/start", "step/end"]);
    assert.deepEqual(frames.filter((frame) => frame.type === "end").map((frame) => frame.outcome), [{ kind: "abandoned" }]);
    session.append("turn/end", { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } });
    await assertSessionRelations(session);
    const reopened = Session.create(session.id, session.snapshotEvents(), session.header);
    await assertSessionRelations(reopened);
    assert.deepEqual(reopened.deriveMessages(), []);
  });
}

test("真实 Session 的 stream-only 混合工具 attempt 不伪造助手或工具事件", async () => {
  const session = Session.create("stream-prefix-mixed");
  session.append("turn/start", { turn: 1 });
  const tracer = new ClaudeRunTracer({
    sessionId: session.id,
    append: (...args) => session.append(...args),
  }, 1);
  for (const event of [
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "before tool" } },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t", name: "Read" } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } },
  ]) tracer.handleMessage({ type: "stream_event", event });
  tracer.finish();
  assert.equal(tracer.logIntact, true);
  session.append("turn/end", { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } });
  assert.deepEqual(session.snapshotEvents().map((event) => event.type), ["turn/start", "step/start", "step/end", "turn/end"]);
  await assertSessionRelations(session);
  const reopened = Session.create(session.id, session.snapshotEvents(), session.header);
  await assertSessionRelations(reopened);
  assert.deepEqual(reopened.deriveMessages(), []);
});

function writeArtifact(name, session, expectedRounds, expectedUserIds) {
  if (!process.env.DSH_GOAL_ARTIFACT_DIR) return;
  const root = fileURLToPath(new URL("../.superpowers/sdd/2026-10-14-goal-admission-guard/native", import.meta.url));
  assert.equal(resolve(process.env.DSH_GOAL_ARTIFACT_DIR), resolve(root), "synthetic artifact directory whitelist");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, `goal-admission-${name}.json`), JSON.stringify({
    header: session.header, events: session.snapshotEvents(), expectedRounds, expectedUserIds,
  }, null, 2));
}

// direct append 替换注册 helper 会让真实重建后同 id 出现两条 user/message。
test("真实 Session 重建跨 epoch 复用登记，不把 reserved 冒充 submitted", () => {
  const first = attachFacts(Session.create("goal-admission-registration-recovery"));
  let reopened;
  try {
    const inbox = new DshInbox(first, { emit() {} });
    const human = { id: "human", role: "user", source: { kind: "user" },
      content: [{ type: "text", text: "synthetic recovery" }] };
    inbox.enqueue("next-turn", human, true);
    new RunInputLedger(first, "old").record(human.id, "reserved", {
      message: human, queue: "next-turn", position: 0, querying: true,
    });
    inbox.consume([human], 1);
    first.append("turn/start", { turn: 1 });
    registerInputMessage(first, human);
    first.append("turn/end", { turn: 1, reason: { kind: "error", error: { code: "SYNTHETIC", message: "before submit" } } });
    const events = first.snapshotEvents();
    const records = structuredClone(first.factRecords);
    first.facts.close();
    reopened = attachFacts(Session.create(first.id, events, first.header), records);
    const restored = new DshInbox(reopened, { emit() {} });
    const recovered = restored.nextTurn[0];
    assert.deepEqual(recovered, human);
    new RunInputLedger(reopened, "new").record(human.id, "reserved", {
      message: recovered, queue: "next-turn", position: 0, querying: true,
    });
    restored.consume([recovered], 2);
    reopened.append("turn/start", { turn: 2 });
    registerInputMessage(reopened, recovered);
    reopened.append("turn/end", { turn: 2, reason: { kind: "error", error: { code: "SYNTHETIC", message: "fixture end" } } });
    assert.equal(reopened.snapshotEvents().filter((event) => event.type === "user/message").length, 1);
    assert.equal(new RunInputLedger(reopened, "new").stateOf(human.id), "reserved");
    writeArtifact("registration-recovery", reopened, 0, ["human"]);
  } finally { first.facts.close(); reopened?.facts.close(); }
});

for (const allowed of [true, false]) {
  test(`真实 Session 自动 goal round ${allowed ? "1 准入" : "0 拒绝且无原生登记"}`, () => {
    const session = attachFacts(Session.create(`goal-admission-${allowed ? "allowed" : "rejected"}`));
    try {
      session.append("goal/change", {
        kind: "goal/change", version: 1, operation: "create",
        goal: { id: "g1", revision: 1, objective: "synthetic admission", phase: "active", maxGoalRounds: 3 },
        roundsStarted: 0, createdAt: 100, updatedAt: 100,
      });
      const inbox = new DshInbox(session, { emit() {} });
      const automatic = { id: "g-auto", role: "user", source: { kind: "goal", goalId: "g1", revision: 1, round: allowed ? 1 : 0 },
        content: [{ type: "text", text: "synthetic automatic input" }] };
      inbox.enqueue("next-turn", automatic, true);
      const decision = assessGoalAdmission({ messages: [automatic], isLive: () => true,
        readGoal: () => ({ id: "g1", revision: 1, phase: "active", activation: "armed", roundsStarted: 0, maxGoalRounds: 3 }) });
      assert.equal(decision.kind, allowed ? "allow" : "reject");
      if (allowed) {
        new RunInputLedger(session, "allowed").record(automatic.id, "reserved", {
          message: automatic, queue: "next-turn", position: 0, querying: true,
        });
        inbox.consume([automatic], 1);
        session.append("turn/start", { turn: 1 });
        registerInputMessage(session, automatic);
        session.append("turn/end", { turn: 1, reason: { kind: "error", error: { code: "SYNTHETIC", message: "fixture end" } } });
      } else {
        assert.equal(inbox.remove(automatic.id, automatic), true);
      }
      assert.deepEqual(session.snapshotEvents().filter((event) => !KNOWN_SESSION_EVENT_TYPES.has(event.type)), []);
      assert.deepEqual(session.snapshotEvents().filter((event) => event.type === "user/message").map((event) => event.data.id), allowed ? ["g-auto"] : []);
      writeArtifact(allowed ? "allowed" : "rejected", session, allowed ? 1 : 0, allowed ? ["g-auto"] : []);
    } finally { session.facts.close(); }
  });
}


// 防止真实 append 接受、重启却拒绝的私有事件重新进入原生日志。
test("真实 Session 的输入意图不污染原生日志，重建仍保留 steer", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-facts-restart-"));
  const previous = process.env.DSH_CLAUDE_CODE_STORE;
  process.env.DSH_CLAUDE_CODE_STORE = root;
  const first = Session.create("s-restart");
  try {
    const inbox = new DshInbox(first, { emit() {} });
    inbox.enqueue("next-step", { id: "steer-1", role: "user", content: [{ type: "text", text: "change direction" }] }, true);
    const events = first.snapshotEvents();
    assert.deepEqual(events.filter((event) => !KNOWN_SESSION_EVENT_TYPES.has(event.type)), []);
    pluginFacts(first).close();
    const reopened = Session.create(first.id, events, first.header);
    const restored = new DshInbox(reopened, { emit() {} });
    assert.deepEqual(restored.nextStep.map((message) => message.id), ["steer-1"]);
    assert.equal(restored.steers.has("steer-1"), true);
    pluginFacts(reopened).close();
  } finally {
    pluginFacts(first).close();
    if (previous === undefined) delete process.env.DSH_CLAUDE_CODE_STORE;
    else process.env.DSH_CLAUDE_CODE_STORE = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("回显和打断回执只进插件台账，不进入真实 Session", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-receipts-"));
  const session = Session.create("s-receipts");
  const facts = bindPluginFacts(session, new PluginFacts(session, { root }));
  try {
    const control = new ClaudeRunControl({ ctx: {}, session, epoch: "e1", signal: new AbortController().signal, abort() {} });
    const messages = [{ id: "u1", role: "user", content: [{ type: "text", text: "hello" }] }];
    control.start({ interrupt: async () => ({ still_queued: ["u1"] }), close() {} }, await control.prepareInitial("hello", messages));
    control.handleMessage({ type: "user", isReplay: true, uuid: "u1" });
    await control.interrupt();
    assert.deepEqual(session.snapshotEvents().filter((event) => !KNOWN_SESSION_EVENT_TYPES.has(event.type)), []);
    assert.deepEqual(facts.events().filter((event) => event.type === "claude-code/input-receipt").map((event) => event.data.kind), ["acknowledged", "interrupt"]);
  } finally { facts.close(); rmSync(root, { recursive: true, force: true }); }
});
