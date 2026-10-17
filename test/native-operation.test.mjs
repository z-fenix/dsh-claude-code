import { test } from "node:test";
import assert from "node:assert/strict";
const { createNativeOperation } = await import("../lib/native-operation.mjs");

const make = async (options = {}) => {
  const records = [];
  const operation = createNativeOperation({ id: "op1", action: "compact", params: {}, claudeSessionId: "c1",
    record: (data) => records.push(data), ...options });
  return { operation, records };
};

test("维护许可只领取一次，完成后重放不重复写入", async () => {
  const { operation, records } = await make();
  assert.deepEqual(operation.claim(), { execute: true, action: "compact", params: {} });
  assert.equal(operation.claim().execute, false);
  const outcome = { status: "succeeded", messageCount: 1, tokensBefore: 100, tokensAfter: 30 };
  assert.throws(() => operation.complete(outcome), /observation|receipt/);
  operation.observe(outcome);
  operation.complete(outcome);
  operation.complete(outcome);
  assert.deepEqual(await operation.result, outcome);
  assert.deepEqual(records.map((record) => record.state), ["pending", "claimed", "observed", "succeeded"]);
  assert.equal(operation.claim().execute, false);
  assert.throws(() => operation.complete({ ...outcome, tokensAfter: 31 }), /settled|different/);
});

test("领取后结果丢失是 uncertain，不允许重新领取", async () => {
  const { operation, records } = await make();
  operation.claim();
  operation.fail("query ended");
  assert.equal((await operation.result).status, "uncertain");
  assert.equal(operation.claim().execute, false);
  assert.deepEqual(records.map((record) => record.state), ["pending", "claimed", "uncertain"]);
});

test("未执行的失败与原生 skip 不冒充成功", async () => {
  const first = await make();
  first.operation.fail("not supported");
  assert.equal((await first.operation.result).status, "failed");
  const second = await make();
  second.operation.claim();
  second.operation.observe({ status: "skipped", reason: "native compact skipped" });
  second.operation.complete({ status: "skipped", reason: "native compact skipped" });
  assert.equal((await second.operation.result).status, "skipped");
});

test("审计写失败不会发出执行许可或成功确认", async () => {
  let fail = false;
  const { operation } = await make({ record: () => { if (fail) throw new Error("disk failure"); } });
  fail = true;
  assert.throws(() => operation.claim(), /disk failure/);
  assert.equal(operation.claimed, false);
  fail = false;
  operation.claim();
  operation.observe({ status: "succeeded", messageCount: 1 });
  fail = true;
  assert.throws(() => operation.complete({ status: "succeeded", messageCount: 1 }), /disk failure/);
  fail = false;
  operation.fail("completion not confirmed");
  assert.equal((await operation.result).status, "uncertain");
});

test("command 操作只接受固定只读命令并携带文本结果", async () => {
  const { operation, records } = await make({ action: "command", params: { command: "cost" } });
  assert.deepEqual(operation.claim(), { execute: true, action: "command", params: { command: "cost" } });
  operation.complete({ status: "succeeded", text: "$0.12 spent" });
  assert.deepEqual(await operation.result, { status: "succeeded", text: "$0.12 spent" });
  assert.deepEqual(records.map((record) => record.state), ["pending", "claimed", "succeeded"]);
  assert.equal(JSON.stringify(records).includes("$0.12 spent"), false, "human command output must not be duplicated in the private audit");
  assert.equal(records.at(-1).result.textLength, 11);
  assert.equal(records.at(-1).result.textHash.length, 64);
  assert.equal(records.at(-1).command, "cost");
  const failed = await make({ action: "command", params: { command: "status" } });
  failed.operation.claim(); failed.operation.complete({ status: "failed", reason: "native command failed" });
  assert.equal(failed.operation.claimed, true, "settling an executed failure must not erase the claim");
  assert.throws(() => createNativeOperation({ id: "op1", action: "command", params: { command: "rm" }, claudeSessionId: "c1", record() {} }));
  assert.throws(() => createNativeOperation({ id: "op1", action: "other", params: {}, claudeSessionId: "c1", record() {} }));
  const limited = await make({ action: "command", params: { command: "cost" } });
  limited.operation.claim();
  assert.throws(() => limited.operation.complete({ status: "succeeded", text: "x".repeat(9000) }));
  assert.throws(() => limited.operation.complete({ status: "succeeded", text: "ok", secret: "leak" }));
});

test("操作结果严格限形，不接受正文、非有限统计或未领取完成", async () => {
  const { operation } = await make();
  assert.throws(() => operation.complete({ status: "succeeded", messageCount: 1 }), /claimed|started/);
  operation.claim();
  for (const result of [
    { status: "succeeded", messageCount: 0 },
    { status: "succeeded", messageCount: 1, tokensAfter: -1 },
    { status: "succeeded", messageCount: 1, tokensBefore: Infinity },
    { status: "succeeded", messageCount: 1, summary: "private transcript" },
    { status: "skipped" },
  ]) assert.throws(() => operation.complete(result));
  operation.observe({ status: "succeeded", messageCount: 1 });
  assert.throws(() => operation.complete({ status: "succeeded", messageCount: 2 }), /observation|receipt/);
  operation.complete({ status: "succeeded", messageCount: 1 });
  assert.deepEqual(await operation.result, { status: "succeeded", messageCount: 1 });
});
