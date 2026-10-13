import { test } from "node:test";
import assert from "node:assert/strict";
import { RunInputChannel, RunInputLedger } from "../lib/run-input.mjs";
import { attachFacts } from "./helpers/plugin-facts.mjs";

function session() {
  const events = [];
  return attachFacts({ id: "s1", events, snapshotEvents: () => events, append(type, data) {
    const event = { type, data, seq: events.length };
    events.push(event);
    return event;
  } });
}

test("流按顺序交付，关闭唤醒读者并拒绝后续投递", async () => {
  const stream = new RunInputChannel();
  const iterator = stream[Symbol.asyncIterator]();
  const first = iterator.next();
  stream.push({ uuid: "u1" });
  stream.push({ uuid: "u2" });
  assert.equal((await first).value.uuid, "u1");
  assert.equal((await iterator.next()).value.uuid, "u2");
  const waiting = iterator.next();
  stream.close();
  assert.deepEqual(await waiting, { done: true, value: undefined });
  assert.throws(() => stream.push({ uuid: "u3" }), /closed/);
});

test("close 丢弃尚未读取的输入，所有等待者退出且幂等", async () => {
  const stream = new RunInputChannel();
  stream.push({ uuid: "u1" });
  stream.close();
  stream.close();
  assert.deepEqual(await stream[Symbol.asyncIterator]().next(), { done: true, value: undefined });
  const other = new RunInputChannel();
  const a = other[Symbol.asyncIterator]().next();
  const b = other[Symbol.asyncIterator]().next();
  other.close();
  assert.equal((await a).done, true);
  assert.equal((await b).done, true);
});

test("正常 EOF 排空缓冲输入，区别于取消时 close 丢弃", async () => {
  const stream = new RunInputChannel();
  stream.push({ uuid: "u1" });
  stream.push({ uuid: "u2" });
  stream.end();
  const received = [];
  for await (const value of stream) received.push(value.uuid);
  assert.deepEqual(received, ["u1", "u2"]);
  assert.throws(() => stream.push({ uuid: "late" }), /closed/);
});

test("未提交的 reservation 可以退回，提交后的未知消息不得自动重投", () => {
  const s = session();
  const ledger = new RunInputLedger(s, "epoch-1");
  ledger.record("u1", "reserved");
  ledger.record("u1", "pending");
  assert.deepEqual(ledger.pending(), ["u1"]);
  ledger.record("u1", "reserved");
  ledger.record("u1", "submitted");
  ledger.record("u1", "uncertain", { reason: "transport closed before receipt" });
  const restored = new RunInputLedger(s, "epoch-2");
  assert.equal(restored.stateOf("u1"), "uncertain");
  assert.deepEqual(restored.pending(), []);
  assert.throws(() => restored.record("u1", "pending"), /transition/);
  restored.record("u1", "observed");
  const count = s.factEvents().length;
  restored.record("u1", "observed");
  assert.equal(s.factEvents().length, count, "相同终态不重复写日志");
});

test("恢复时旧 submitted 变为 uncertain，旧 reserved 是可恢复待办", () => {
  const s = session();
  const ledger = new RunInputLedger(s, "epoch-1");
  ledger.record("u1", "reserved");
  ledger.record("u1", "submitted");
  ledger.record("u2", "reserved");
  const restored = new RunInputLedger(s, "epoch-2");
  assert.equal(restored.stateOf("u1"), "uncertain");
  assert.equal(restored.stateOf("u2"), "pending");
  assert.deepEqual(restored.pending(), ["u2"]);
});

test("append 被拒不更新内存，身份/状态字段不能被 detail 覆写", () => {
  const s = session();
  const ledger = new RunInputLedger(s, "epoch-1");
  ledger.record("u1", "reserved", { messageId: "forged", epoch: "forged", state: "observed" });
  assert.equal(s.factEvents()[0].data.messageId, "u1");
  assert.equal(s.factEvents()[0].data.epoch, "epoch-1");
  assert.equal(s.factEvents()[0].data.state, "reserved");
  s.rejectFact = () => { throw new Error("write rejected"); };
  assert.throws(() => ledger.record("u1", "submitted"), /write rejected/);
  assert.equal(ledger.stateOf("u1"), "reserved");
  assert.throws(() => ledger.record("", "reserved"), /id/);
  assert.throws(() => ledger.record("u2", "arbitrary"), /state/);
});
