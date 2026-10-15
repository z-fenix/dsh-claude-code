import { test } from "node:test";
import assert from "node:assert/strict";
import * as input from "../lib/run-input.mjs";
import { DshInbox } from "../lib/inbox.mjs";
import { attachFacts } from "./helpers/plugin-facts.mjs";

const message = { id: "u1", role: "user", source: { kind: "user" },
  content: [{ type: "text", text: "same input" }] };
function fixture(events = [], records = []) {
  return attachFacts({ id: "registration-unit", header: { cwd: "/w" },
    append(type, data) {
      const event = { seq: events.length, time: Date.now(), type, data: structuredClone(data) };
      events.push(event); return event;
    }, snapshotEvents: () => [...events] }, records);
}
function reserve(session, epoch = "old", value = message) {
  new input.RunInputLedger(session, epoch).record(value.id, "reserved", {
    message: value, queue: "next-turn", position: 0, querying: true,
  });
}
function register(session, value = message) {
  assert.equal(typeof input.registerInputMessage, "function");
  return input.registerInputMessage(session, value);
}
// Appending instead of checking complete evidence duplicates model-visible input.
test("registered 不是 submitted，重新登记返回唯一原事件", () => {
  const session = fixture(); reserve(session);
  const first = register(session);
  const second = register(session);
  assert.equal(second.seq, first.seq);
  assert.equal(session.snapshotEvents().filter((e) => e.type === "user/message").length, 1);
  assert.equal(new input.RunInputLedger(session, "old").stateOf(message.id), "reserved");
});
test("新 epoch 锚点跨过原事件仍保留早期登记证明", () => {
  const session = fixture(); reserve(session);
  const first = register(session);
  reserve(session, "new");
  assert.equal(register(session).seq, first.seq);
  assert.equal(session.snapshotEvents().filter((e) => e.type === "user/message").length, 1);
});
test("native append 后下一次 sidecar 拒写仍可发现原登记", () => {
  const session = fixture(); reserve(session);
  const first = register(session);
  session.rejectFact = () => { throw new Error("disk rejected"); };
  assert.throws(() => new input.RunInputLedger(session, "old").submitBatch(["u1"], {}), /disk rejected/);
  assert.equal(typeof input.inspectInputRegistration, "function");
  assert.equal(input.inspectInputRegistration(session, message).event.seq, first.seq);
  assert.equal(new input.RunInputLedger(session, "old").stateOf(message.id), "reserved");
});
for (const kind of ["duplicate", "payload", "source", "missing-anchor"]) {
  test(`登记证据 ${kind} fail closed`, () => {
    const session = fixture();
    if (kind !== "missing-anchor") reserve(session);
    session.append("user/message", message);
    if (kind === "duplicate") session.append("user/message", message);
    const candidate = kind === "payload" ? { ...message, content: [{ type: "text", text: "changed" }] }
      : kind === "source" ? { ...message, source: { kind: "system" } } : message;
    const before = session.snapshotEvents().length;
    assert.equal(typeof input.registerInputMessage, "function");
    assert.throws(() => register(session, candidate), /input-registration/);
    assert.equal(session.snapshotEvents().length, before);
  });
}
test("读取错误不被当成未登记", () => {
  const session = fixture(); reserve(session);
  session.snapshotEvents = () => { throw new Error("unreadable native log"); };
  assert.equal(typeof input.registerInputMessage, "function");
  assert.throws(() => register(session), /unreadable native log/);
});
test("同 id 的冲突 reservation 即使有匹配早期证明也拒绝", () => {
  const session = fixture(); reserve(session);
  session.append("user/message", message);
  reserve(session, "new", { ...message, source: { kind: "system" } });
  assert.equal(typeof input.registerInputMessage, "function");
  assert.throws(() => register(session), /conflicting/);
  assert.equal(session.snapshotEvents().filter(e => e.type === "user/message").length, 1);
});
test("只有登记后的 reservation 不证明旧 native event", () => {
  const session = fixture();
  session.append("user/message", message);
  reserve(session);
  assert.equal(typeof input.registerInputMessage, "function");
  assert.throws(() => register(session), /unproven/);
});
test("重建时篡改 anchorHash 被底层拒绝", () => {
  const session = fixture(); reserve(session);
  session.append("user/message", message);
  const records = structuredClone(session.factRecords);
  records[0].anchorHash = "bad";
  assert.throws(() => fixture(session.snapshotEvents(), records), /anchor/);
});
test("无原事件返回 unregistered 且不写副作用", () => {
  const session = fixture(); reserve(session);
  assert.equal(typeof input.inspectInputRegistration, "function");
  assert.deepEqual(input.inspectInputRegistration(session, message), { kind: "unregistered" });
  assert.equal(session.snapshotEvents().length, 0);
});
test("空 id 不能静默作为新消息登记", () => {
  const session = fixture();
  assert.equal(typeof input.registerInputMessage, "function");
  assert.throws(() => register(session, { ...message, id: " " }), /message id/);
  assert.equal(session.snapshotEvents().length, 0);
});
for (const state of ["reserved", "submitted", "uncertain"]) {
  test(`登记后的 ${state} 恢复仍以提交事实而非 native event 判定`, () => {
    const session = fixture();
    const inbox = new DshInbox(session, { emit() {} });
    inbox.enqueue("next-step", message, true);
    const ledger = new input.RunInputLedger(session, "old");
    ledger.record(message.id, "reserved", { message, ...inbox.placement(message) });
    inbox.consume([message], 1);
    register(session);
    if (state !== "reserved") ledger.submitBatch([message.id], { sdkUuid: message.id });
    if (state === "uncertain") ledger.record(message.id, "uncertain");
    const restored = new DshInbox(session, { emit() {} });
    assert.equal(restored.hasPending, state === "reserved");
    if (state === "reserved") {
      assert.equal(restored.nextStep[0].id, "u1");
      assert.equal(restored.steers.has("u1"), true);
      assert.deepEqual(restored.placement(restored.nextStep[0]), { queue: "next-step", position: 0, querying: true });
    }
  });
}
