// test/inbox.test.mjs — 待办队列（DshInbox）行为：与 DSH 原生 inbox 语义一致。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DshInbox } from "../lib/inbox.mjs";
import { RunInputLedger } from "../lib/run-input.mjs";
import { attachFacts } from "./helpers/plugin-facts.mjs";

/** 假会话：只记录 append，返回自增 seq。 */
function fakeSession() {
  const events = [];
  return attachFacts({
    events,
    append(type, data, opts) {
      const event = { type, data, opts, seq: events.length };
      events.push(event);
      return event;
    },
    snapshotEvents: () => events,
  });
}

function fakeDispatch() {
  const seen = [];
  return { seen, emit: (name, payload) => seen.push({ name, payload }) };
}

const msg = (id, text = id) => ({ id, role: "user", content: [{ type: "text", text }] });

test("peek 不认领消息，消费快照不吃掉后来追加的输入", () => {
  const session = fakeSession();
  const dispatch = fakeDispatch();
  const inbox = new DshInbox(session, dispatch);
  inbox.append("next-step", msg("s1"));
  inbox.append("next-turn", msg("t1"));
  const before = session.events.length;
  const selected = inbox.peek("next-turn");
  assert.deepEqual(selected.map((item) => item.id), ["s1", "t1"]);
  assert.equal(session.events.length, before);
  inbox.append("next-step", msg("s2"));
  assert.deepEqual(inbox.consume(selected, 1).map((item) => item.id), ["s1", "t1"]);
  assert.deepEqual(inbox.nextStep.map((item) => item.id), ["s2"]);
  assert.equal(dispatch.seen.filter((item) => item.name === "agent/inbox/claimed").length, 2);
});

test("准备期间被编辑或删除的快照不能再消费旧内容", () => {
  const inbox = new DshInbox(fakeSession(), fakeDispatch());
  inbox.append("next-step", msg("s1"));
  inbox.append("next-turn", msg("t1"));
  const selected = inbox.peek("next-turn");
  inbox.replace("s1", msg("s1", "edited"));
  assert.deepEqual(inbox.consume(selected, 1), []);
  assert.equal(inbox.nextTurn.length, 1);
  const next = inbox.peek("next-turn");
  inbox.remove("t1");
  assert.deepEqual(inbox.consume(next, 1), []);
  assert.equal(inbox.nextStep[0].content[0].text, "edited");
});

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

test("exact remove 不删除同 id 的替代对象或写入 splice", () => {
  const session = fakeSession();
  const dispatch = fakeDispatch();
  const inbox = new DshInbox(session, dispatch);
  const oldMessage = msg("same", "old");
  const replacement = msg("same", "new");
  inbox.append("next-turn", oldMessage);
  inbox.replace("same", replacement);
  const before = session.snapshotEvents().length;
  const notifications = dispatch.seen.length;
  assert.equal(inbox.remove("same", oldMessage), false);
  assert.equal(inbox.nextTurn[0], replacement);
  assert.equal(session.snapshotEvents().length, before);
  assert.equal(dispatch.seen.length, notifications);
  assert.equal(inbox.remove("same", replacement), true);
  assert.equal(inbox.nextTurn.length, 0);
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

for (const operation of ["remove", "clear"]) {
  test(`${operation} 清理持久 steer 意图，旧 next-step 不猜测为 querying`, () => {
    const session = fakeSession();
    const inbox = new DshInbox(session, fakeDispatch());
    inbox.enqueue("next-step", msg("reused"), true);
    if (operation === "remove") inbox.remove("reused");
    else inbox.clear();
    inbox.append("next-step", msg("reused", "legacy inject"));
    const restored = new DshInbox(session, fakeDispatch());
    assert.equal(restored.steers.has("reused"), false);
  });
}

test("编辑保留 steer 意图但不会恢复旧 reservation 文本", () => {
  const session = fakeSession();
  const inbox = new DshInbox(session, fakeDispatch());
  const old = msg("edited");
  inbox.enqueue("next-step", old, true);
  new RunInputLedger(session, "e1").record(old.id, "reserved", { message: old, ...inbox.placement(old) });
  inbox.replace(old.id, msg("edited", "new"));
  const restored = new DshInbox(session, fakeDispatch());
  assert.equal(restored.nextStep[0].content[0].text, "new");
  assert.equal(restored.steers.has("edited"), true);
  restored.consume(restored.peek("next-step"), 1);
  assert.equal(new DshInbox(session, fakeDispatch()).hasPending, false);
});

test("提交边界后的整批输入不恢复，明确清空也不复活未提交 claim", () => {
  for (const submitted of [false, true]) {
    const session = fakeSession();
    const inbox = new DshInbox(session, fakeDispatch());
    const ledger = new RunInputLedger(session, "e1");
    const messages = [msg("a"), msg("b")];
    for (const message of messages) {
      inbox.enqueue("next-step", message, true);
      ledger.record(message.id, "reserved", { message, ...inbox.placement(message) });
    }
    inbox.consume(messages, 1);
    if (submitted) ledger.submitBatch(["a", "b"], { sdkUuid: "b", shouldQuery: true });
    else inbox.clear();
    assert.equal(new DshInbox(session, fakeDispatch()).hasPending, false);
    if (submitted) {
      const recovered = new RunInputLedger(session, "e2");
      assert.equal(recovered.stateOf("a"), "uncertain");
      assert.equal(recovered.stateOf("b"), "uncertain");
    }
  }
});
