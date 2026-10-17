import { test } from "node:test";
import assert from "node:assert/strict";

async function fixture(compaction) {
  const { apply } = await import("../lib/command-compact.mjs");
  const definitions = [];
  const cleanup = [];
  const ctx = { get: (name) => name === "commands" ? { register(definition) { definitions.push(definition); return () => {}; } }
    : name === "compaction" ? compaction : undefined,
    effect(factory) { for (const dispose of factory()) cleanup.push(dispose); } };
  apply(ctx);
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0].name, "compact");
  return { handler: definitions[0].handler, dispose: async () => { for (const fn of cleanup.toReversed()) await fn(); } };
}
const invocation = (agent, rawInput = "") => ({ agent, rawInput, signal: new AbortController().signal, commandId: "cmd1" });

test("Claude compact 命令走原生维护且不伪造 summarySeq", async () => {
  let nativeCalls = 0;
  const { handler, dispose } = await fixture({ compactNow() { throw new Error("must not fall back"); } });
  try {
    const result = await handler(invocation({ compactNative: async (input) => {
      nativeCalls += 1; assert.equal(input.commandId, "cmd1");
      return { status: "succeeded", messageCount: 2, tokensBefore: 100, tokensAfter: 30 };
    } }));
    assert.equal(result.kind, "success");
    assert.match(result.text, /Claude/);
    assert.match(result.text, /100.*30/);
    assert.equal(result.sourceEventSeq, undefined);
    assert.equal(nativeCalls, 1);
  } finally { await dispose(); }
});

test("不支持的 Claude 维护不回退宿主摘要；参数错误不执行", async () => {
  let hostCalls = 0;
  const { handler, dispose } = await fixture({ compactNow() { hostCalls += 1; } });
  const agent = { compactNative: async () => { throw Object.assign(new Error("unsupported private details"), { code: "unsupported" }); } };
  try {
    assert.equal((await handler(invocation(agent, "unexpected"))).kind, "error");
    const result = await handler(invocation(agent));
    assert.equal(result.kind, "error");
    assert.match(result.text, /support|unavailable/i);
    assert.ok(!result.text.includes("private details"));
    assert.equal(hostCalls, 0);
  } finally { await dispose(); }
});

test("真正原生 agent 保留宿主 compact 语义", async () => {
  let call;
  const { handler, dispose } = await fixture({ compactNow: async (...args) => {
    call = args; return { shadowedSeqs: [2, 3], shadowedTokenCount: 80, summarySeq: 9 };
  } });
  const input = invocation({ id: "native-agent" });
  try {
    const result = await handler(input);
    assert.deepEqual(call, [input.agent, input.signal, "cmd1"]);
    assert.equal(result.kind, "success");
    assert.equal(result.sourceEventSeq, 9);
  } finally { await dispose(); }
});

test("skip 直说未压缩，uncertain 不当成功", async () => {
  const { handler, dispose } = await fixture();
  try {
    const skip = await handler(invocation({ compactNative: async () => ({ status: "skipped", reason: "no compactable history" }) }));
    assert.match(skip.text, /not compact|未压缩/i);
    assert.match(skip.text, /no compactable history/);
    const uncertain = await handler(invocation({ compactNative: async () => {
      throw Object.assign(new Error("secret"), { code: "timeout", uncertain: true });
    } }));
    assert.equal(uncertain.kind, "error");
    assert.match(uncertain.text, /may|可能/);
    assert.ok(!uncertain.text.includes("secret"));
  } finally { await dispose(); }
});

test("卸载等待已进入的命令静默", async () => {
  const gate = Promise.withResolvers();
  const { handler, dispose } = await fixture();
  const running = handler(invocation({ compactNative: () => gate.promise }));
  let drained = false;
  const drain = dispose().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  gate.resolve({ status: "skipped", reason: "native compact skipped" });
  await Promise.all([running, drain]);
  assert.equal(drained, true);
});
