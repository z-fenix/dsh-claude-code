// test/inbox.test.mjs — 待办队列（DshInbox）行为：与 DSH 原生 inbox 语义一致。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DshInbox } from "../lib/inbox.mjs";

/** 假会话：只记录 append，返回自增 seq。 */
function fakeSession() {
  const events = [];
  return {
    events,
    append(type, data, opts) {
      const event = { type, data, opts, seq: events.length };
      events.push(event);
      return event;
    },
    snapshotEvents: () => events,
  };
}

function fakeDispatch() {
  const seen = [];
  return { seen, emit: (name, payload) => seen.push({ name, payload }) };
}

const msg = (id, text = id) => ({ id, role: "user", content: [{ type: "text", text }] });

test("append 写入 agent/inbox/spliced 并发 inserted 通知", () => {
  const session = fakeSession();
  const dispatch = fakeDispatch();
  const inbox = new DshInbox(session, dispatch);

  inbox.append("next-turn", msg("m1"));

  assert.equal(session.events.length, 1);
  assert.equal(session.events[0].type, "agent/inbox/spliced");
  assert.deepEqual(session.events[0].data.target, "next-turn");
  assert.equal(session.events[0].data.start, 0);
  assert.equal(session.events[0].data.removedCount, undefined);
  assert.equal(inbox.nextTurn.length, 1);
  assert.equal(dispatch.seen.at(-1).name, "agent/inbox/inserted");
});

test("prepend 插到队首", () => {
  const inbox = new DshInbox(fakeSession(), fakeDispatch());
  inbox.append("next-step", msg("a"));
  inbox.append("next-step", msg("b"));
  inbox.prepend("next-step", msg("z"));
  assert.deepEqual(inbox.nextStep.map((m) => m.id), ["z", "a", "b"]);
});

test("claim('next-turn') 先清空 next-step 再取队首一条 turn", () => {
  const session = fakeSession();
  const dispatch = fakeDispatch();
  const inbox = new DshInbox(session, dispatch);
  inbox.append("next-turn", msg("turn-1"));
  inbox.append("next-turn", msg("turn-2"));
  inbox.append("next-step", msg("steer-1"));

  const claimed = inbox.claim("next-turn", 7);

  assert.deepEqual(claimed.map((m) => m.id), ["steer-1", "turn-1"]);
  assert.deepEqual(inbox.nextTurn.map((m) => m.id), ["turn-2"]);
  assert.equal(inbox.nextStep.length, 0);
  const names = dispatch.seen.map((entry) => entry.name);
  assert.equal(names.filter((name) => name === "agent/inbox/claimed").length, 2);
  assert.equal(dispatch.seen.find((entry) => entry.name === "agent/inbox/claimed").payload.turn, 7);
});

test("claim('next-step') 只清 next-step", () => {
  const inbox = new DshInbox(fakeSession(), fakeDispatch());
  inbox.append("next-turn", msg("turn-1"));
  inbox.append("next-step", msg("steer-1"));

  const claimed = inbox.claim("next-step", 1);

  assert.deepEqual(claimed.map((m) => m.id), ["steer-1"]);
  assert.deepEqual(inbox.nextTurn.map((m) => m.id), ["turn-1"]);
});

test("replace / remove 按 id 定位并返回是否命中", () => {
  const session = fakeSession();
  const inbox = new DshInbox(session, fakeDispatch());
  inbox.append("next-turn", msg("m1"));

  assert.equal(inbox.replace("m1", msg("m1", "updated")), true);
  assert.equal(inbox.nextTurn[0].content[0].text, "updated");
  assert.equal(inbox.replace("nope", msg("x")), false);

  assert.equal(inbox.remove("m1"), true);
  assert.equal(inbox.hasPending, false);
  assert.equal(inbox.remove("m1"), false);
});

test("clear 先清 next-step 再清 next-turn，并写 canceled 结果", () => {
  const session = fakeSession();
  const inbox = new DshInbox(session, fakeDispatch());
  inbox.append("next-turn", msg("t"));
  inbox.append("next-step", msg("s"));

  inbox.clear();

  assert.equal(inbox.hasPending, false);
  const splices = session.events.filter((event) => event.type === "agent/inbox/spliced").slice(-2);
  assert.equal(splices[0].data.target, "next-step");
  assert.equal(splices[1].data.target, "next-turn");
  assert.equal(splices[0].data.outcome, "canceled");
});

test("同一批 pending 里出现重复 message.id 时抛错", () => {
  const inbox = new DshInbox(fakeSession(), fakeDispatch());
  inbox.append("next-turn", msg("dup"));
  assert.throws(() => inbox.append("next-step", msg("dup")), /already pending/);
});

test("空操作不写日志", () => {
  const session = fakeSession();
  const inbox = new DshInbox(session, fakeDispatch());
  inbox.splice("next-turn", 0, 0, []);
  assert.equal(session.events.length, 0);
});

test("构造时从日志折叠出 pending 状态", () => {
  const session = fakeSession();
  const first = new DshInbox(session, fakeDispatch());
  first.append("next-turn", msg("m1"));
  first.append("next-step", msg("m2"));

  const restored = new DshInbox(session, fakeDispatch());

  assert.deepEqual(restored.nextTurn.map((m) => m.id), ["m1"]);
  assert.deepEqual(restored.nextStep.map((m) => m.id), ["m2"]);
});
