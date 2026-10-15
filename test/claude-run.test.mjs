// test/claude-run.test.mjs — SDK 消息 → DSH 会话事件的轨迹映射。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ClaudeRunTracer,
  mapClaudeBlock,
  mapToolInput,
  mapToolName,
  usageFromClaude,
  contextWindowOf,
  isZeroUsage,
  isSubagentMessage,
  compactObservation,
} from "../lib/claude-run.mjs";

/** 假会话 sink：记录事件、可回放 requestHeader / requestContext。 */
function fakeSink() {
  const events = [];
  return {
    sessionId: "s1",
    events,
    append(type, data, opts) {
      const event = { type, data, opts, seq: events.length };
      events.push(event);
      return event;
    },
    requestHeader: () => {
      for (let i = events.length - 1; i >= 0; i -= 1) {
        if (events[i].type === "request/header") return events[i].data.header;
      }
      return undefined;
    },
    requestContext: () => {
      for (let i = events.length - 1; i >= 0; i -= 1) {
        if (events[i].type === "request/context") return events[i].data;
      }
      return undefined;
    },
    types: () => events.map((event) => event.type),
  };
}

function streamEvent(tracer, event) {
  tracer.handleMessage({ type: "stream_event", event });
}

for (const ending of ["finish", "error-result", "success-result"]) {
  test(`无 envelope 的文本/reasoning 前缀在 ${ending} 后只保存一次`, () => {
    const sink = fakeSink();
    const frames = [];
    const tracer = new ClaudeRunTracer(sink, 7, { emitStream: (frame) => frames.push(frame) });
    streamEvent(tracer, { type: "content_block_delta", index: 0,
      delta: { type: "thinking_delta", thinking: "observed reasoning" } });
    streamEvent(tracer, { type: "content_block_delta", index: 1,
      delta: { type: "text_delta", text: "safe " } });
    streamEvent(tracer, { type: "content_block_delta", index: 1,
      delta: { type: "text_delta", text: "prefix" } });
    if (ending !== "finish") tracer.handleMessage({ type: "result",
      subtype: ending === "error-result" ? "error_during_execution" : "success",
      usage: { input_tokens: 91, output_tokens: 19 } });
    tracer.finish();
    tracer.finish();
    tracer.handleMessage({ type: "assistant", message: { content: [{ type: "text", text: "late" }] } });
    const messages = sink.events.filter((event) => event.type === "assistant/message");
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].data.message.content, [
      { type: "reasoning", text: "observed reasoning" },
      { type: "text", text: "safe prefix" },
    ]);
    assert.equal(messages[0].data.turn, 7);
    assert.equal(messages[0].data.step, 1);
    assert.equal(messages[0].opts.surfaceOp, "append");
    assert.equal(messages[0].data.usage, undefined, "result 总用量不分配给缺 envelope 的前缀");
    assert.equal(sink.events.filter((event) => event.type === "step/end").length, 1);
    const ends = frames.filter((frame) => frame.type === "end");
    assert.equal(ends.length, 1);
    assert.deepEqual(ends[0].outcome, { kind: "committed", eventType: "assistant/message", seq: messages[0].seq });
    assert.deepEqual(frames.filter((frame) => frame.chunk?.type === "text-delta").map((frame) => frame.chunk.text), ["safe ", "prefix"]);
    assert.equal(tracer.logIntact, true);
  });
}

function partialThinkingResponse(tracer, usage) {
  streamEvent(tracer, { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
  streamEvent(tracer, { type: "content_block_delta", index: 0,
    delta: { type: "thinking_delta", thinking: "streamed reasoning" } });
  tracer.handleMessage({ type: "assistant", message: {
    id: "partial-response", content: [{ type: "thinking", thinking: "authoritative reasoning" }],
    ...(usage === undefined ? {} : { usage }),
  } });
  streamEvent(tracer, { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
  streamEvent(tracer, { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "interrupted answer" } });
}

for (const ending of ["finish", "error-result", "success-result", "message-stop-finish", "next-response"]) {
  test(`部分 thinking envelope 在 ${ending} 保留权威块和缺 envelope 的文本尾部`, () => {
    const sink = fakeSink();
    const frames = [];
    const tracer = new ClaudeRunTracer(sink, 1, { emitStream: (frame) => frames.push(frame) });
    partialThinkingResponse(tracer);
    if (ending === "message-stop-finish") streamEvent(tracer, { type: "message_stop" });
    if (ending === "next-response") {
      streamEvent(tracer, { type: "message_start", message: { id: "next-response" } });
      tracer.handleMessage({ type: "assistant", message: { id: "next-response", content: [{ type: "text", text: "next" }] } });
    }
    if (ending.endsWith("-result")) tracer.handleMessage({ type: "result",
      subtype: ending === "error-result" ? "error_during_execution" : "success",
      usage: { input_tokens: 91, output_tokens: 19 } });
    tracer.finish();
    tracer.finish();
    const messages = sink.events.filter((event) => event.type === "assistant/message");
    assert.equal(messages.length, ending === "next-response" ? 2 : 1);
    assert.deepEqual(messages[0].data.message.content, [
      { type: "reasoning", text: "authoritative reasoning" },
      { type: "text", text: "interrupted answer" },
    ]);
    assert.equal(messages[0].data.usage, undefined, "部分响应不借用 result 总用量");
    assert.deepEqual(frames.filter((frame) => frame.attemptId === "s1:1.1" && frame.type === "end").map((frame) => frame.outcome), [
      { kind: "committed", eventType: "assistant/message", seq: messages[0].seq },
    ]);
    assert.deepEqual(frames.filter((frame) => frame.attemptId === "s1:1.1" && frame.chunk?.type === "text-delta").map((frame) => frame.chunk.text), ["interrupted answer"]);
    assert.equal(sink.events.filter((event) => event.type === "step/end").length, messages.length);
    assert.equal(sink.events.filter((event) => event.type === "tool/call").length, 0);
    if (ending === "next-response") assert.deepEqual(messages[1].data.message.content, [{ type: "text", text: "next" }]);
    assert.equal(tracer.logIntact, true);
  });
}

for (const usageSource of ["assistant", "message_delta"]) {
  test(`部分 envelope 保留实际 ${usageSource} 用量，不改为 result 总量`, () => {
    const sink = fakeSink();
    const tracer = new ClaudeRunTracer(sink, 1);
    const usage = { input_tokens: 11, output_tokens: 3 };
    partialThinkingResponse(tracer, usageSource === "assistant" ? usage : undefined);
    if (usageSource === "message_delta") streamEvent(tracer, { type: "message_delta", usage });
    tracer.handleMessage({ type: "result", subtype: "error_during_execution", usage: { input_tokens: 91, output_tokens: 19 } });
    tracer.finish();
    const message = sink.events.find((event) => event.type === "assistant/message");
    assert.deepEqual(message.data.message.content.at(-1), { type: "text", text: "interrupted answer" });
    assert.deepEqual(message.data.usage, { inputTokens: 11, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });
}

test("message_stop 不把部分 envelope 提前定稿，迟到文本 envelope 保持权威", () => {
  const sink = fakeSink();
  const frames = [];
  const tracer = new ClaudeRunTracer(sink, 1, { emitStream: (frame) => frames.push(frame) });
  partialThinkingResponse(tracer);
  streamEvent(tracer, { type: "message_stop" });
  assert.equal(sink.events.filter((event) => event.type === "assistant/message").length, 0);
  tracer.handleMessage({ type: "assistant", message: { id: "partial-response", content: [{ type: "text", text: "authoritative answer" }] } });
  tracer.handleMessage({ type: "result", subtype: "success", usage: { input_tokens: 17, output_tokens: 5 } });
  tracer.finish();
  const messages = sink.events.filter((event) => event.type === "assistant/message");
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].data.message.content, [
    { type: "reasoning", text: "authoritative reasoning" }, { type: "text", text: "authoritative answer" },
  ]);
  assert.deepEqual(messages[0].data.usage, { inputTokens: 17, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.equal(frames.filter((frame) => frame.type === "end").length, 1);
  assert.deepEqual(frames.filter((frame) => frame.chunk?.type === "text-delta").map((frame) => frame.chunk.text), ["interrupted answer"]);
});

test("空 reasoning 完成块不使后续文本前缀错位", () => {
  const sink = fakeSink();
  const tracer = new ClaudeRunTracer(sink, 1);
  streamEvent(tracer, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "" } });
  tracer.handleMessage({ type: "assistant", message: { id: "empty-thinking", content: [{ type: "thinking", thinking: "" }] } });
  streamEvent(tracer, { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "visible" } });
  tracer.finish();
  assert.deepEqual(sink.events.find((event) => event.type === "assistant/message").data.message.content, [
    { type: "reasoning", text: "" }, { type: "text", text: "visible" },
  ]);
});

for (const ending of ["finish", "result"]) {
  test(`signature-only 空 thinking envelope 后的文本在 ${ending} 仍保存`, () => {
    const sink = fakeSink();
    const frames = [];
    const tracer = new ClaudeRunTracer(sink, 1, { emitStream: (frame) => frames.push(frame) });
    streamEvent(tracer, { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    streamEvent(tracer, { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "opaque" } });
    tracer.handleMessage({ type: "assistant", message: { id: "signature-only", content: [{ type: "thinking", thinking: "", signature: "opaque" }] } });
    streamEvent(tracer, { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
    streamEvent(tracer, { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "VISIBLE ANSWER" } });
    if (ending === "result") tracer.handleMessage({ type: "result", subtype: "error_during_execution", usage: { input_tokens: 99, output_tokens: 20 } });
    tracer.finish();
    tracer.finish();
    const messages = sink.events.filter((event) => event.type === "assistant/message");
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].data.message.content, [
      { type: "reasoning", text: "" }, { type: "text", text: "VISIBLE ANSWER" },
    ]);
    assert.equal(messages[0].data.usage, undefined);
    assert.equal(frames.filter((frame) => frame.chunk?.type === "reasoning-delta").length, 0);
    assert.deepEqual(frames.filter((frame) => frame.chunk?.type === "text-delta").map((frame) => frame.chunk.text), ["VISIBLE ANSWER"]);
    assert.equal(frames.filter((frame) => frame.type === "end").length, 1);
    assert.equal(tracer.logIntact, true);
  });
}

for (const id of [undefined, ""]) {
  test(`无有效响应 id 的 envelope 不把下一条已完成文本补入前一条，id=${id}`, () => {
    const sink = fakeSink();
    const frames = [];
    const tracer = new ClaudeRunTracer(sink, 1, { emitStream: (frame) => frames.push(frame) });
    streamEvent(tracer, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reasoning" } });
    tracer.handleMessage({ type: "assistant", message: { ...(id === undefined ? {} : { id }), content: [{ type: "thinking", thinking: "reasoning" }] } });
    streamEvent(tracer, { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "VISIBLE ANSWER" } });
    tracer.handleMessage({ type: "assistant", message: { ...(id === undefined ? {} : { id }), content: [{ type: "text", text: "VISIBLE ANSWER" }] } });
    tracer.finish();
    tracer.finish();
    assert.deepEqual(sink.events.filter((event) => event.type === "assistant/message").map((event) => event.data.message.content), [
      [{ type: "reasoning", text: "reasoning" }], [{ type: "text", text: "VISIBLE ANSWER" }],
    ]);
    assert.deepEqual(sink.events.filter((event) => event.type === "step/end").map((event) => event.data.step), [1, 2]);
    assert.equal(frames.filter((frame) => frame.type === "end").length, 2);
    assert.equal(tracer.logIntact, true);
  });
}

for (const [label, tail] of [
  ["tool", { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "unadvertised", name: "Read" } }],
  ["image", { type: "content_block_start", index: 2, content_block: { type: "image" } }],
  ["invalid", { type: "content_block_delta", index: -1, delta: { type: "text_delta", text: "invalid" } }],
  ["kind-conflict", { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "conflict" } }],
]) {
  test(`部分 envelope 遇到 ${label} 不把混合流伪装成安全尾部`, () => {
    const sink = fakeSink();
    const tracer = new ClaudeRunTracer(sink, 1);
    partialThinkingResponse(tracer);
    streamEvent(tracer, tail);
    tracer.finish();
    assert.deepEqual(sink.events.find((event) => event.type === "assistant/message").data.message.content, [
      { type: "reasoning", text: "authoritative reasoning" },
    ]);
    assert.equal(sink.events.filter((event) => event.type === "tool/call").length, 0);
    assert.equal(tracer.logIntact, true);
  });
}

for (const [label, content] of [
  ["kind mismatch", [{ type: "text", text: "envelope text" }]],
  ["filtered block", [{ type: "thinking", thinking: "complete" }, { type: "image" }]],
]) {
  test(`部分 envelope 的 ${label} 不猜测尾部对应关系`, () => {
    const sink = fakeSink();
    const tracer = new ClaudeRunTracer(sink, 1);
    streamEvent(tracer, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "streamed" } });
    tracer.handleMessage({ type: "assistant", message: { id: "ambiguous", content } });
    streamEvent(tracer, { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "unmatched tail" } });
    tracer.finish();
    assert.deepEqual(sink.events.find((event) => event.type === "assistant/message").data.message.content,
      label === "kind mismatch" ? [{ type: "text", text: "envelope text" }] : [{ type: "reasoning", text: "complete" }]);
  });
}

// 实测端点会在中断响应里先发一个 redacted_thinking block（index 0），可见文本落在 index 1。
// 该块不能持久化，但它也不携带可对齐正文：把它当作「未知块」会永久关闭安全前缀，
// 收尾就写成空正文，界面已显示的文本在重放时消失。
for (const ending of ["finish", "error-result", "success-result"]) {
  test(`redacted_thinking envelope 不丢弃 index 1 的观察文本（${ending}）`, () => {
    const sink = fakeSink();
    const frames = [];
    const tracer = new ClaudeRunTracer(sink, 3, { emitStream: (frame) => frames.push(frame) });
    streamEvent(tracer, { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "VISIBLE " } });
    streamEvent(tracer, { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ANSWER" } });
    tracer.handleMessage({ type: "assistant", message: { id: "redacted-response",
      content: [{ type: "redacted_thinking", data: "ENCRYPTED-PAYLOAD" }] } });
    if (ending !== "finish") tracer.handleMessage({ type: "result",
      subtype: ending === "error-result" ? "error_during_execution" : "success",
      usage: { input_tokens: 91, output_tokens: 19 } });
    tracer.finish();
    tracer.finish();
    const messages = sink.events.filter((event) => event.type === "assistant/message");
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].data.message.content, [{ type: "text", text: "VISIBLE ANSWER" }]);
    assert.equal(messages[0].data.usage, undefined, "redacted envelope 不借用 result 总用量");
    assert.equal(sink.events.filter((event) => event.type === "step/end").length, 1);
    assert.deepEqual(frames.filter((frame) => frame.type === "end").map((frame) => frame.outcome), [
      { kind: "committed", eventType: "assistant/message", seq: messages[0].seq },
    ]);
    assert.equal(JSON.stringify(sink.events).includes("ENCRYPTED-PAYLOAD"), false, "redacted 正文不进日志");
    assert.equal(tracer.logIntact, true);
  });
}

test("redacted_thinking 的 start 占位但不关闭前缀，后续文本仍可收尾", () => {
  const sink = fakeSink();
  const frames = [];
  const tracer = new ClaudeRunTracer(sink, 1, { emitStream: (frame) => frames.push(frame) });
  streamEvent(tracer, { type: "content_block_start", index: 0,
    content_block: { type: "redacted_thinking", data: "ENCRYPTED-PAYLOAD" } });
  streamEvent(tracer, { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
  streamEvent(tracer, { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "visible" } });
  tracer.handleMessage({ type: "assistant", message: { id: "redacted-start",
    content: [{ type: "redacted_thinking", data: "ENCRYPTED-PAYLOAD" }] } });
  tracer.finish();
  const messages = sink.events.filter((event) => event.type === "assistant/message");
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].data.message.content, [{ type: "text", text: "visible" }]);
  assert.equal(JSON.stringify(sink.events).includes("ENCRYPTED-PAYLOAD"), false, "redacted 正文不进日志");
  assert.equal(tracer.logIntact, true);
});

test("真正的未知块仍然关闭安全前缀", () => {
  const sink = fakeSink();
  const tracer = new ClaudeRunTracer(sink, 1);
  streamEvent(tracer, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "unmapped" } });
  tracer.handleMessage({ type: "assistant", message: { id: "unknown-block",
    content: [{ type: "image", source: { type: "base64", data: "AAAA" } }] } });
  tracer.finish();
  const messages = sink.events.filter((event) => event.type === "assistant/message");
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].data.message.content, []);
  assert.equal(JSON.stringify(sink.events).includes("AAAA"), false);
  assert.equal(tracer.logIntact, true);
});

test("部分 envelope 尾部补存拒写后不重投且只 abandoned 一次", () => {
  const sink = fakeSink();
  const append = sink.append;
  const rejectedBodies = [];
  sink.append = (type, data, opts) => {
    if (type === "assistant/message") {
      rejectedBodies.push(data.message.content);
      throw new Error("partial envelope rejected");
    }
    return append(type, data, opts);
  };
  const frames = [];
  const tracer = new ClaudeRunTracer(sink, 1, { emitStream: (frame) => frames.push(frame) });
  partialThinkingResponse(tracer);
  tracer.finish();
  tracer.finish();
  assert.deepEqual(rejectedBodies, [[
    { type: "reasoning", text: "authoritative reasoning" }, { type: "text", text: "interrupted answer" },
  ]]);
  assert.deepEqual(frames.filter((frame) => frame.type === "end").map((frame) => frame.outcome), [{ kind: "abandoned" }]);
  assert.deepEqual(sink.types(), ["step/start", "step/end"]);
  assert.equal(tracer.logIntact, false);
});

const abandonedStreams = [
  ["empty", [{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }]],
  ["whitespace", [{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " \n" } }]],
  ["tool-start", [
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "before tool" } },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t", name: "Read" } },
  ]],
  ["json-only", [{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":' } }]],
  ["invalid-tool", [
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "safe text" } },
    { type: "content_block_start", index: -1, content_block: { type: "tool_use", id: "t", name: "Read" } },
  ]],
  ["image", [
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "not an image adapter" } },
    { type: "content_block_start", index: 1, content_block: { type: "image" } },
  ]],
];
for (const [label, events] of abandonedStreams) {
  test(`无 envelope 的 ${label} 流只 abandoned 不伪造消息`, () => {
    const sink = fakeSink();
    const frames = [];
    const tracer = new ClaudeRunTracer(sink, 1, { emitStream: (frame) => frames.push(frame) });
    for (const event of events) streamEvent(tracer, event);
    tracer.finish();
    tracer.finish();
    assert.deepEqual(sink.types(), ["step/start", "step/end"]);
    assert.deepEqual(frames.filter((frame) => frame.type === "end").map((frame) => frame.outcome), [{ kind: "abandoned" }]);
    assert.equal(tracer.logIntact, true);
  });
}

test("前缀 append 失败只 abandoned 一次且日志标记不完整", () => {
  const sink = fakeSink();
  const append = sink.append;
  let rejects = 0;
  sink.append = (type, data, opts) => {
    if (type === "assistant/message") { rejects += 1; throw new Error("prefix write rejected"); }
    return append(type, data, opts);
  };
  const frames = [];
  const tracer = new ClaudeRunTracer(sink, 1, { emitStream: (frame) => frames.push(frame) });
  streamEvent(tracer, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "prefix" } });
  tracer.finish();
  tracer.finish();
  assert.equal(rejects, 1);
  assert.deepEqual(sink.types(), ["step/start", "step/end"]);
  assert.deepEqual(frames.filter((frame) => frame.type === "end").map((frame) => frame.outcome), [{ kind: "abandoned" }]);
  assert.equal(tracer.logIntact, false);
});

test("完整工具 envelope 写失败后不重投前缀或广告工具", () => {
  const sink = fakeSink();
  const append = sink.append;
  let rejects = 0;
  sink.append = (type, data, opts) => {
    if (type === "assistant/message") { rejects += 1; throw new Error("envelope rejected"); }
    return append(type, data, opts);
  };
  const frames = [];
  const tracer = new ClaudeRunTracer(sink, 1, { emitStream: (frame) => frames.push(frame) });
  streamEvent(tracer, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "prefix" } });
  tracer.handleMessage({ type: "assistant", message: { content: [
    { type: "text", text: "complete" }, { type: "tool_use", id: "t", name: "Read", input: {} },
  ] } });
  tracer.finish();
  tracer.finish();
  assert.equal(rejects, 1);
  assert.deepEqual(sink.types(), ["step/start", "step/end"]);
  assert.deepEqual(frames.filter((frame) => frame.type === "end").map((frame) => frame.outcome), [{ kind: "abandoned" }]);
  assert.equal(tracer.logIntact, false);
});

for (const boundary of ["result", "message_stop"]) {
  test(`完整 envelope 经 ${boundary} 拒写时保留错误和不完整标志，finish 不重投`, () => {
    const sink = fakeSink();
    const append = sink.append;
    const rejection = new Error("pending envelope rejected");
    let rejects = 0;
    sink.append = (type, data, opts) => {
      if (type === "assistant/message") { rejects += 1; throw rejection; }
      return append(type, data, opts);
    };
    const frames = [];
    const tracer = new ClaudeRunTracer(sink, 1, { emitStream: (frame) => frames.push(frame) });
    streamEvent(tracer, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "prefix" } });
    tracer.handleMessage({ type: "assistant", message: { id: "response", content: [
      { type: "text", text: "complete" }, { type: "tool_use", id: "t", name: "Read", input: {} },
    ] } });
    const trigger = boundary === "result"
      ? { type: "result", subtype: "success" }
      : { type: "stream_event", event: { type: "message_stop" } };
    assert.throws(() => tracer.handleMessage(trigger), (error) => error === rejection);
    assert.equal(tracer.logIntact, false);
    tracer.finish();
    tracer.finish();
    assert.equal(tracer.logIntact, false);
    assert.equal(rejects, 1);
    assert.deepEqual(sink.types(), ["step/start", "step/end"]);
    assert.deepEqual(frames.filter((frame) => frame.type === "end").map((frame) => frame.outcome), [{ kind: "abandoned" }]);
  });
}

test("忽略的 signature/citation metadata 不排除同类型分片前缀", () => {
  const sink = fakeSink();
  const tracer = new ClaudeRunTracer(sink, 1);
  for (const [index, delta] of [
    [0, { type: "thinking_delta", thinking: "reason" }],
    [0, { type: "signature_delta", signature: "synthetic signature" }],
    [0, { type: "thinking_delta", thinking: "ing" }],
    [1, { type: "text_delta", text: "visible" }],
    [1, { type: "citations_delta", citation: { type: "synthetic" } }],
    [1, { type: "text_delta", text: " answer" }],
  ]) streamEvent(tracer, { type: "content_block_delta", index, delta });
  tracer.finish();
  assert.deepEqual(sink.events.filter((event) => event.type === "assistant/message").map((event) => event.data.message.content), [[
    { type: "reasoning", text: "reasoning" }, { type: "text", text: "visible answer" },
  ]]);
});

test("同 index 冲突只排除前缀，完整 envelope 正文仍保持权威", () => {
  const sink = fakeSink();
  const tracer = new ClaudeRunTracer(sink, 1);
  streamEvent(tracer, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "observed reasoning" } });
  streamEvent(tracer, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "observed text" } });
  tracer.handleMessage({ type: "assistant", message: { content: [{ type: "text", text: "authoritative envelope" }] } });
  tracer.finish();
  assert.deepEqual(sink.events.filter((event) => event.type === "assistant/message").map((event) => event.data.message.content), [[{ type: "text", text: "authoritative envelope" }]]);
  assert.equal(tracer.logIntact, true);
});

test("message_stop 不提前提交前缀，迟到 envelope 保持权威正文", () => {
  const sink = fakeSink();
  const frames = [];
  const tracer = new ClaudeRunTracer(sink, 1, { emitStream: (frame) => frames.push(frame) });
  streamEvent(tracer, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "live prefix" } });
  streamEvent(tracer, { type: "message_stop" });
  assert.equal(sink.types().includes("assistant/message"), false);
  tracer.handleMessage({ type: "assistant", message: { content: [{ type: "text", text: "complete envelope" }] } });
  tracer.finish();
  assert.deepEqual(sink.events.filter((event) => event.type === "assistant/message").map((event) => event.data.message.content), [[{ type: "text", text: "complete envelope" }]]);
  assert.deepEqual(frames.filter((frame) => frame.chunk?.type === "text-delta").map((frame) => frame.chunk.text), ["live prefix"]);
  assert.equal(frames.filter((frame) => frame.type === "end").length, 1);
});

for (const empty of [false, true]) {
  test(`message_delta 用量不制造 ${empty ? "空正文" : "成功响应"}`, () => {
    const sink = fakeSink();
    const frames = [];
    const tracer = new ClaudeRunTracer(sink, 1, { emitStream: (frame) => frames.push(frame) });
    streamEvent(tracer, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    if (!empty) streamEvent(tracer, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "observed" } });
    streamEvent(tracer, { type: "message_delta", usage: { input_tokens: 4, output_tokens: 2 } });
    tracer.finish();
    const messages = sink.events.filter((event) => event.type === "assistant/message");
    assert.equal(messages.length, empty ? 0 : 1);
    if (!empty) assert.deepEqual(messages[0].data.usage, { inputTokens: 4, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const ends = frames.filter((frame) => frame.type === "end");
    assert.equal(ends.length, 1);
    assert.equal(ends[0].outcome.kind, empty ? "abandoned" : "committed");
  });
}

for (const safeFirst of [false, true]) {
  test(`非法文本 index 排除前缀，safeFirst=${safeFirst}`, () => {
    const sink = fakeSink();
    const frames = [];
    const tracer = new ClaudeRunTracer(sink, 1, { emitStream: (frame) => frames.push(frame) });
    if (safeFirst) streamEvent(tracer, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "safe" } });
    streamEvent(tracer, { type: "content_block_delta", index: -1, delta: { type: "text_delta", text: "bad" } });
    tracer.finish();
    assert.deepEqual(sink.types(), ["step/start", "step/end"]);
    assert.deepEqual(frames.filter((frame) => frame.type === "end").map((frame) => frame.outcome), [{ kind: "abandoned" }]);
    assert.equal(tracer.logIntact, true);
  });
}

test("前缀 result 后后台新响应仍可完整落盘", () => {
  const sink = fakeSink();
  const frames = [];
  const tracer = new ClaudeRunTracer(sink, 1, { emitStream: (frame) => frames.push(frame) });
  streamEvent(tracer, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "prefix" } });
  tracer.handleMessage({ type: "result", subtype: "error_during_execution" });
  tracer.handleMessage({ type: "assistant", message: { content: [{ type: "text", text: "background response" }] } });
  tracer.handleMessage({ type: "result", subtype: "success" });
  tracer.finish();
  assert.deepEqual(sink.events.filter((event) => event.type === "assistant/message").map((event) => [event.data.step, event.data.message.content[0].text]), [[1, "prefix"], [2, "background response"]]);
  assert.deepEqual(frames.filter((frame) => frame.type === "end").map((frame) => [frame.attemptId, frame.outcome.kind]), [["s1:1.1", "committed"], ["s1:1.2", "committed"]]);
});

for (const [type, delta] of [["text", { type: "text_delta", text: "single" }], ["reasoning", { type: "thinking_delta", thinking: "single" }]]) {
  test(`只有 ${type} 的前缀也保存`, () => {
    const sink = fakeSink();
    const tracer = new ClaudeRunTracer(sink, 1);
    streamEvent(tracer, { type: "content_block_delta", index: 2, delta });
    tracer.finish();
    assert.deepEqual(sink.events.filter((event) => event.type === "assistant/message").map((event) => event.data.message.content), [[{ type, text: "single" }]]);
  });
}

test("未开启 attempt 的 finish 保持 no-op", () => {
  const sink = fakeSink();
  const frames = [];
  const tracer = new ClaudeRunTracer(sink, 1, { emitStream: (frame) => frames.push(frame) });
  tracer.finish();
  tracer.finish();
  assert.deepEqual(sink.events, []);
  assert.deepEqual(frames, []);
});

/** 一整套最小 Claude SDK 消息序列：init → 文本 → 用量 → 助手帧 → 工具结果 → result。 */
function sampleMessages() {
  return [
    { type: "system", subtype: "init", session_id: "claude-1", model: "claude-sonnet-4-5", tools: ["Bash", "Read"] },
    {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello " } },
    },
    {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } },
    },
    // message_delta 携带这条消息的权威用量，位置就在它的 assistant 帧之后、下一条之前。
    {
      type: "stream_event",
      event: { type: "message_delta", usage: { input_tokens: 120, output_tokens: 8, cache_read_input_tokens: 40 } },
    },
    {
      type: "assistant",
      message: {
        model: "claude-sonnet-4-5",
        content: [
          { type: "text", text: "hello world" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        ],
      },
    },
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "file.txt" }] },
    },
    {
      type: "result",
      subtype: "success",
      result: "done",
      usage: { input_tokens: 120, output_tokens: 8 },
      modelUsage: { "claude-sonnet-4-5": { contextWindow: 200000 } },
    },
  ];
}

test("完整一轮映射出 step / assistant / tool / 用量 / 请求头与上下文", () => {
  const sink = fakeSink();
  const frames = [];
  const tracer = new ClaudeRunTracer(sink, 1, { emitStream: (frame) => frames.push(frame) });
  for (const message of sampleMessages()) tracer.handleMessage(message);
  tracer.finish();

  const types = sink.types();
  // 最后一条助手消息延迟到 result 才结算：那时才能把用量与消息写在同一条事件上
  // （token-meter 只认 assistant/message 的 usage 字段与它内嵌的 stream）。
  assert.deepEqual(types, [
    "request/header",
    "step/start",
    "assistant/message",
    "tool/call",
    "tool/result",
    "request/context",
    "step/end",
  ]);

  const assistant = sink.events.find((event) => event.type === "assistant/message");
  assert.equal(assistant.data.turn, 1);
  assert.equal(assistant.data.step, 1);
  assert.equal(assistant.data.message.content[0].text, "hello world");
  // 工具名已映射成 DSH wire 名，工具调用块也一并改写
  assert.equal(assistant.data.message.content[1].name, "bash");
  assert.ok(Array.isArray(assistant.data.stream));
  assert.ok(assistant.data.stream.length > 0, "assistant/message 必须带 stream 记录");
  // 权威用量来自本步流里的 message_delta，并写进同一条 assistant/message
  assert.deepEqual(assistant.data.usage, {
    inputTokens: 120,
    outputTokens: 8,
    cacheReadTokens: 40,
    cacheWriteTokens: 0,
  });
  assert.equal(assistant.opts.surfaceOp, "append");

  const header = sink.events.find((event) => event.type === "request/header");
  assert.equal(header.data.reason, "initial");
  assert.equal(header.data.header.config.provider, "claude-code");
  assert.equal(header.data.header.config.model, "claude-sonnet-4-5");
  assert.deepEqual(header.data.header.tools.map((tool) => tool.name), ["bash", "read"]);
  assert.equal(header.data.header.system, undefined, "system 已移出 request/header（属于 system/message）");

  const context = sink.events.find((event) => event.type === "request/context");
  assert.deepEqual(context.data, { provider: "claude-code", model: "claude-sonnet-4-5", contextWindow: 200000 });

  const toolCall = sink.events.find((event) => event.type === "tool/call");
  assert.equal(toolCall.data.name, "bash");
  assert.equal(toolCall.data.arguments, JSON.stringify({ command: "ls" }));

  const toolResult = sink.events.find((event) => event.type === "tool/result");
  assert.equal(toolResult.data.message.isError, false);

  // 实时帧：start → 若干 chunk → end
  assert.equal(frames[0].type, "start");
  assert.equal(frames.at(-1).type, "end");
  assert.equal(frames.at(-1).outcome.kind, "committed");
  assert.ok(frames.some((frame) => frame.type === "chunk"
    && frame.chunk.type === "text-delta" && frame.chunk.text === "hello "));
});

test("非流式端点（没有 stream_event）时用整块补齐 stream", () => {
  const sink = fakeSink();
  const tracer = new ClaudeRunTracer(sink, 3);
  tracer.handleMessage({
    type: "assistant",
    message: { model: "m", content: [{ type: "text", text: "block only" }] },
  });
  tracer.finish();

  const assistant = sink.events.find((event) => event.type === "assistant/message");
  assert.equal(assistant.data.step, 1);
  assert.equal(assistant.data.message.content[0].text, "block only");
  assert.ok(assistant.data.stream.length > 0);
  assert.deepEqual(sink.types(), ["step/start", "assistant/message", "step/end"]);
});

test("多条 Claude 助手消息 = 同一 turn 内多个 step", () => {
  const sink = fakeSink();
  const tracer = new ClaudeRunTracer(sink, 5);
  tracer.handleMessage({ type: "assistant", message: { content: [{ type: "text", text: "one" }] } });
  tracer.handleMessage({ type: "assistant", message: { content: [{ type: "text", text: "two" }] } });
  tracer.finish();

  const types = sink.types();
  assert.deepEqual(types, [
    "step/start", "assistant/message",
    "step/end", "step/start", "assistant/message",
    "step/end",
  ]);
  const assistant = sink.events.filter((event) => event.type === "assistant/message");
  assert.deepEqual(assistant.map((event) => event.data.step), [1, 2]);
  assert.ok(assistant.every((event) => event.data.turn === 5));
});

test("同一 API 响应的多个 assistant 分块保留并行工具的真实结果", () => {
  const sink = fakeSink();
  const tracer = new ClaudeRunTracer(sink, 1);
  for (const [id, name] of [["r1", "Read"], ["r2", "Read"], ["r3", "Read"], ["g1", "Grep"]]) {
    tracer.handleMessage({ type: "assistant", uuid: `assistant-${id}`, parent_tool_use_id: null,
      message: { id: "response-1", content: [{ type: "tool_use", id, name, input: {} }],
        usage: { input_tokens: 10, output_tokens: 20 } } });
  }
  for (const id of ["r2", "r1", "g1", "r3"]) {
    tracer.handleMessage({ type: "user", parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: id, content: `actual-${id}` }] } });
  }
  tracer.handleMessage({ type: "result", subtype: "success", result: "done" });
  tracer.finish();

  const results = sink.events.filter((event) => event.type === "tool/result");
  assert.deepEqual(results.map((event) => [event.data.message.toolCallId, event.data.message.content[0].text]),
    [["r2", "actual-r2"], ["r1", "actual-r1"], ["g1", "actual-g1"], ["r3", "actual-r3"]]);
  assert.ok(results.every((event) => event.data.message.isError === false));
  assert.deepEqual(sink.events.filter((event) => event.type === "step/start").map((event) => event.data.step), [1]);
  const assistants = sink.events.filter((event) => event.type === "assistant/message");
  assert.equal(assistants.length, 1);
  assert.deepEqual(assistants[0].data.message.content.map((block) => block.id), ["r1", "r2", "r3", "g1"]);
  assert.equal(assistants[0].data.usage.inputTokens, 10);
});

test("同一响应工具结果早于后续 assistant 分块时不提前关闭 step", () => {
  const sink = fakeSink();
  const tracer = new ClaudeRunTracer(sink, 1);
  const assistant = (id) => ({ type: "assistant", uuid: `assistant-${id}`,
    message: { id: "response-1", content: [{ type: "tool_use", id, name: "Read", input: {} }] } });
  const result = (id) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: `actual-${id}` }] } });
  tracer.handleMessage(assistant("r1"));
  tracer.handleMessage(result("r1"));
  tracer.handleMessage(assistant("r2"));
  tracer.handleMessage(assistant("r3"));
  tracer.handleMessage(result("r3"));
  tracer.handleMessage(result("r2"));
  tracer.finish();

  const results = sink.events.filter((event) => event.type === "tool/result");
  assert.deepEqual(results.map((event) => event.data.message.content[0].text), ["actual-r1", "actual-r3", "actual-r2"]);
  assert.ok(results.every((event) => event.data.message.isError === false));
  assert.equal(sink.events.filter((event) => event.type === "step/start").length, 1);
});

test("流式响应分块聚合且 message_start 隔离下一响应的 stream", () => {
  const sink = fakeSink();
  const frames = [];
  const tracer = new ClaudeRunTracer(sink, 1, { emitStream: (frame) => frames.push(frame) });
  tracer.handleMessage({ type: "stream_event", event: { type: "message_start", message: { id: "response-1" } } });
  for (const [index, id] of [[0, "r1"], [1, "r2"]]) {
    tracer.handleMessage({ type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "tool_use", id, name: "Read" } } });
    tracer.handleMessage({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: '{"file_path":"a.md"}' } } });
    tracer.handleMessage({ type: "assistant", message: { id: "response-1", content: [{ type: "tool_use", id, name: "Read", input: { file_path: "a.md" } }] } });
  }
  tracer.handleMessage({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "r1", content: "actual-r1" }] } });
  tracer.handleMessage({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "r2", content: "actual-r2" }] } });
  // 无 message_stop 的 emitter 仍有下一响应的 message_start，不可把新 stream 喂进旧 attempt。
  tracer.handleMessage({ type: "stream_event", event: { type: "message_start", message: { id: "response-2" } } });
  tracer.handleMessage({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
  tracer.handleMessage({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } } });
  tracer.handleMessage({ type: "assistant", message: { id: "response-2", content: [{ type: "text", text: "done" }] } });
  tracer.finish();

  const assistants = sink.events.filter((event) => event.type === "assistant/message");
  assert.equal(assistants.length, 2);
  assert.deepEqual(assistants[0].data.message.content.map((block) => block.id), ["r1", "r2"]);
  assert.ok(assistants[0].data.stream.every((item) => item.type !== "text-chunks"));
  assert.deepEqual(assistants[1].data.message.content, [{ type: "text", text: "done" }]);
  assert.equal(frames.filter((frame) => frame.chunk?.type === "text-delta").length, 1);
  assert.equal(sink.events.filter((event) => event.type === "tool/result" && event.data.message.isError).length, 0);
});

test("不同响应的 message_start 在新分片进入前结算旧 attempt", () => {
  const sink = fakeSink();
  const frames = [];
  const tracer = new ClaudeRunTracer(sink, 1, { emitStream: (frame) => frames.push(frame) });
  for (const [id, text] of [["response-1", "first"], ["response-2", "second"]]) {
    tracer.handleMessage({ type: "stream_event", event: { type: "message_start", message: { id } } });
    tracer.handleMessage({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    tracer.handleMessage({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
    tracer.handleMessage({ type: "assistant", message: { id, content: [{ type: "text", text }] } });
  }
  tracer.finish();
  const assistants = sink.events.filter((event) => event.type === "assistant/message");
  assert.deepEqual(assistants.map((event) => event.data.message.content[0].text), ["first", "second"]);
  assert.deepEqual(assistants.map((event) => event.data.stream.filter((item) => item.type === "text-chunks").flatMap((item) => item.texts)), [["first"], ["second"]]);
  assert.deepEqual(frames.filter((frame) => frame.chunk?.type === "text-delta").map((frame) => [frame.attemptId, frame.chunk.text]), [["s1:1.1", "first"], ["s1:1.2", "second"]]);
});

test("未知工具回执不结算正在组装的响应", () => {
  const sink = fakeSink();
  const tracer = new ClaudeRunTracer(sink, 1);
  tracer.handleMessage({ type: "assistant", message: { id: "response-1", content: [{ type: "tool_use", id: "r1", name: "Read", input: {} }] } });
  tracer.handleMessage({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "unknown", content: "unrelated" }] } });
  tracer.handleMessage({ type: "assistant", message: { id: "response-1", content: [{ type: "tool_use", id: "r2", name: "Read", input: {} }] } });
  tracer.handleMessage({ type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "r1", content: "actual-r1" },
    { type: "tool_result", tool_use_id: "r2", content: "actual-r2" },
  ] } });
  tracer.finish();
  const results = sink.events.filter((event) => event.type === "tool/result");
  assert.deepEqual(results.map((event) => event.data.message.content[0].text), ["actual-r1", "actual-r2"]);
  assert.equal(sink.events.filter((event) => event.type === "step/start").length, 1);
});

test("AskUserQuestion 的 deny 结果不标记为错误", () => {
  const sink = fakeSink();
  const tracer = new ClaudeRunTracer(sink, 1);
  tracer.handleMessage({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: {} }] },
  });
  tracer.handleMessage({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "q1", is_error: true, content: "A: yes" }] },
  });
  tracer.finish();

  const toolResult = sink.events.find((event) => event.type === "tool/result");
  assert.equal(toolResult.data.message.isError, false);
  assert.equal(toolResult.data.message.content[0].text, "A: yes");
});

test("缺少 modelUsage 与配置时用配置的 contextWindow 兜底", () => {
  const sink = fakeSink();
  const tracer = new ClaudeRunTracer(sink, 1, { contextWindow: 1000000 });
  tracer.handleMessage({ type: "system", subtype: "init", session_id: "c", model: "m" });
  tracer.handleMessage({ type: "result", subtype: "success", result: "ok" });
  tracer.finish();

  const context = sink.events.find((event) => event.type === "request/context");
  assert.equal(context.data.contextWindow, 1000000);
});

test("流里没有用量时用 result.usage 兜底写进 assistant/message", () => {
  const sink = fakeSink();
  const tracer = new ClaudeRunTracer(sink, 2);
  // 只有非流式的 assistant 帧（没有 message_delta），用量只能来自 result。
  tracer.handleMessage({ type: "assistant", message: { content: [{ type: "text", text: "no stream usage" }] } });
  tracer.handleMessage({
    type: "result",
    subtype: "success",
    result: "ok",
    usage: { input_tokens: 77, output_tokens: 5, cache_read_input_tokens: 3 },
  });
  tracer.finish();

  const assistant = sink.events.find((event) => event.type === "assistant/message");
  assert.deepEqual(assistant.data.usage, {
    inputTokens: 77,
    outputTokens: 5,
    cacheReadTokens: 3,
    cacheWriteTokens: 0,
  });
});

test("request/header 未变化时不重复写", () => {
  const sink = fakeSink();
  const tracer = new ClaudeRunTracer(sink, 1);
  tracer.handleMessage({ type: "system", subtype: "init", session_id: "c", model: "m", tools: ["Read"] });
  tracer.handleMessage({ type: "system", subtype: "init", session_id: "c", model: "m", tools: ["Read"] });
  assert.equal(sink.types().filter((type) => type === "request/header").length, 1);
});

test("工具名 / 入参映射", () => {
  assert.equal(mapToolName("Bash"), "bash");
  // Windows 上本机 CLI 报的是 `PowerShell`（工具表里没有 Bash）；入参形状与 Bash 相同，
  // 映射到同一个 wire 名，界面才会用命令卡片渲染而不是落进通用卡片。
  assert.equal(mapToolName("PowerShell"), "bash");
  assert.equal(mapToolName("WebFetch"), "web_fetch");
  assert.equal(mapToolName("Agent"), "subagent");
  assert.equal(mapToolName("Unknown"), "Unknown");
  assert.deepEqual(mapToolInput("Skill", { command: "office-docx" }), { name: "office-docx" });
  assert.deepEqual(mapToolInput("Bash", { command: "ls" }), { command: "ls" });
});

test("内容块映射：text / thinking / tool_use，其余忽略", () => {
  assert.deepEqual(mapClaudeBlock({ type: "text", text: "x" }), { type: "text", text: "x" });
  assert.deepEqual(mapClaudeBlock({ type: "thinking", thinking: "why" }), { type: "reasoning", text: "why" });
  assert.deepEqual(mapClaudeBlock({ type: "tool_use", id: "i", name: "Bash", input: { command: "ls" } }), {
    type: "tool-call",
    id: "i",
    name: "bash",
    arguments: JSON.stringify({ command: "ls" }),
  });
  assert.equal(mapClaudeBlock({ type: "image" }), null);
  assert.equal(mapClaudeBlock(null), null);
});

test("用量换算与空用量判定", () => {
  assert.deepEqual(usageFromClaude({ input_tokens: 1, output_tokens: 2 }), {
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.equal(usageFromClaude(null), null);
  assert.equal(isZeroUsage(null), true);
  assert.equal(isZeroUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), true);
  assert.equal(isZeroUsage({ inputTokens: 1, outputTokens: 0 }), false);
});

test("上下文窗口提取顺序：主键 → canonicalModel → 任意正数", () => {
  assert.equal(contextWindowOf({ m: { contextWindow: 100 } }, "m"), 100);
  assert.equal(contextWindowOf({ other: { canonicalModel: "m", contextWindow: 200 } }, "m"), 200);
  assert.equal(contextWindowOf({ a: { contextWindow: 0 }, b: { contextWindow: 300 } }, "missing"), 300);
  assert.equal(contextWindowOf({ a: { contextWindow: 0 } }, "m"), undefined);
  assert.equal(contextWindowOf(undefined, "m"), undefined);
});

test("子代理消息识别", () => {
  assert.equal(isSubagentMessage({ type: "system", subtype: "task_started" }), true);
  assert.equal(isSubagentMessage({ type: "system", subtype: "task_notification" }), true);
  assert.equal(isSubagentMessage({ type: "system", subtype: "init" }), false);
  assert.equal(isSubagentMessage({ type: "assistant", parent_tool_use_id: "t1" }), true);
  assert.equal(isSubagentMessage({ type: "assistant" }), false);
  assert.equal(isSubagentMessage(null), false);
});

// 回归护栏（实测故障：后台子代理跑完后主循环「续跑」，整段轨迹被丢弃、界面上什么都不显示）：
//   SDK 的 query() 流在后台子代理完成时会**接着产出**——先补一条 system/init，再把通知唤醒
//   出来的助手消息逐条发下来，最后以第二条 result 收尾。而一条 result 只代表 CLI 的**一个
//   回合**结束，不代表整个 run 结束（实测：第一条 result 之后还有 12 条消息、第 2 条 result）。
// 因此 result 只能收掉当前 step，不能把 tracer 关掉。
test("第一条 result 之后的后台续跑仍写进同一个 turn 的新 step", () => {
  const sink = fakeSink();
  const tracer = new ClaudeRunTracer(sink, 7);
  const modelUsage = { "claude-sonnet-4-5": { contextWindow: 200000 } };
  tracer.handleMessage({ type: "system", subtype: "init", session_id: "claude-1", model: "claude-sonnet-4-5", tools: ["Bash"] });
  tracer.handleMessage({
    type: "assistant",
    message: { id: "m1", content: [{ type: "text", text: "All 8 generators are running in parallel." }] },
  });
  tracer.handleMessage({ type: "result", subtype: "success", result: "第一回合结束", modelUsage });
  // ── 后台子代理完成，通知唤醒主循环：SDK 继续在同一个流上产出 ──
  tracer.handleMessage({ type: "system", subtype: "init", session_id: "claude-1", model: "claude-sonnet-4-5", tools: ["Bash"] });
  tracer.handleMessage({
    type: "assistant",
    message: { id: "m2", content: [{ type: "text", text: "Agent 1 done — 92 cases." }] },
  });
  tracer.handleMessage({ type: "result", subtype: "success", result: "完成。全量需求测试用例工作台已生成并落盘。", modelUsage });
  tracer.finish();

  // 续跑只该多出 step，不该重复写 request/header 与 request/context
  assert.deepEqual(sink.types(), [
    "request/header",
    "step/start", "assistant/message", "request/context", "step/end",
    "step/start", "assistant/message", "step/end",
  ]);
  const assistant = sink.events.filter((event) => event.type === "assistant/message");
  assert.deepEqual(assistant.map((event) => event.data.message.content[0].text), [
    "All 8 generators are running in parallel.",
    "Agent 1 done — 92 cases.",
  ]);
  // 续跑是**同一个回合**的后续 step，不是新回合
  assert.deepEqual(assistant.map((event) => event.data.turn), [7, 7]);
  assert.deepEqual(assistant.map((event) => event.data.step), [1, 2]);
});

test("result 之后没有后续消息时收尾结果不变（不与 finish 重复写 step/end）", () => {
  const sink = fakeSink();
  const tracer = new ClaudeRunTracer(sink, 1);
  tracer.handleMessage({
    type: "assistant",
    message: { id: "m1", content: [{ type: "text", text: "only" }] },
  });
  tracer.handleMessage({ type: "result", subtype: "success", result: "ok" });
  tracer.finish();

  // result 收掉当步；finish() 不得再补一条 step/end
  assert.deepEqual(sink.types(), ["step/start", "assistant/message", "step/end"]);
});

// 回归护栏（实测故障：会话日志被判损坏、该会话永久打不开）：
//   SessionFormatError: step/end leaves unresolved tool call call_…
//   stored session "…" is corrupt
//
// 成因：CLI 启动失败 / 回合被取消时，Claude 已发出的 tool_use 永远等不到 tool_result，
// 而 #closeStep() 会照样写 step/end，于是日志里留下「有调用、没结果」的 step。
// DSH 的会话格式校验据此判定整条会话损坏——比少一条结果严重得多。
test("step 结束前必须给未决的 tool/call 补写 tool/result（否则会话日志被判损坏）", () => {
  const sink = fakeSink();
  const tracer = new ClaudeRunTracer(sink, 1);
  // assistant 发出一条 tool_use，随后**永远没有** tool_result（模拟 CLI 崩溃）
  tracer.handleMessage({
    type: "assistant",
    message: {
      id: "m1",
      content: [
        { type: "text", text: "调用工具" },
        { type: "tool_use", id: "call_x", name: "Read", input: { file_path: "a.md" } },
      ],
      usage: { input_tokens: 5, output_tokens: 5 },
    },
  });
  tracer.finish();

  const types = sink.types();
  const callCount = types.filter((t) => t === "tool/call").length;
  const resultCount = types.filter((t) => t === "tool/result").length;
  assert.equal(callCount, 1);
  assert.equal(resultCount, callCount, "每个 tool/call 都必须有配对的 tool/result");

  // 顺序也必须是 step/start → … → tool/call → tool/result → step/end
  const stepEndIndex = types.indexOf("step/end");
  const resultIndex = types.indexOf("tool/result");
  assert.ok(resultIndex >= 0 && resultIndex < stepEndIndex, "tool/result 必须写在 step/end 之前");

  // 合成结果要明确标成错误，便于排查
  const synthetic = sink.events.find((e) => e.type === "tool/result");
  assert.equal(synthetic.data.message.content[0].text.includes("did not report a result"), true);
  assert.equal(synthetic.data.step, 1);
});

test("已有结果的 tool/call 不会被重复补写", () => {
  const sink = fakeSink();
  const tracer = new ClaudeRunTracer(sink, 1);
  tracer.handleMessage({
    type: "assistant",
    message: {
      id: "m1",
      content: [{ type: "tool_use", id: "call_ok", name: "Bash", input: {} }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  tracer.handleMessage({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "call_ok", content: "done" }],
    },
  });
  tracer.finish();

  const types = sink.types();
  assert.equal(types.filter((t) => t === "tool/call").length, 1);
  assert.equal(types.filter((t) => t === "tool/result").length, 1, "已有结果时不得补写第二条");
  const only = sink.events.find((e) => e.type === "tool/result");
  assert.equal(only.data.message.content[0].text, "done");
});

// ---------------------------------------------------------------------------
// 原生任务列表 → todo/write 快照：DSH 的任务列表面板读会话日志里的 todo/write
// 事件（dsh-tool-todo 注册的 session projection）。Claude 引擎下任务工具在 CLI
// 本地执行、不经过 DSH 工具层，插件必须在流结算处把原生任务操作回放成快照事件。
// ---------------------------------------------------------------------------

test("TodoWrite 调用后紧随 tool/call 写 todo/write 快照（面板数据源）", () => {
  const sink = fakeSink();
  const tracer = new ClaudeRunTracer(sink, 1);
  tracer.handleMessage({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "tw1", name: "TodoWrite", input: { todos: [
      { content: " 解析需求 ", status: "in_progress" },
      { content: "提取接口", status: "pending" },
      { content: "", status: "pending" }, // 空内容 → 丢弃
      { content: "补测试", status: "bogus" }, // 非法状态 → 丢弃
      { content: "解析需求", status: "completed" }, // 重复内容 → 丢弃
    ] } }] },
  });
  tracer.handleMessage({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "tw1", content: "ok" }] },
  });
  tracer.finish();

  const types = sink.types();
  const todoIdx = types.indexOf("todo/write");
  assert.ok(types.includes("todo/write"), "必须写出 todo/write 事件");
  assert.ok(todoIdx > types.indexOf("tool/call"), "todo/write 必须在 tool/call 之后");
  assert.ok(todoIdx < types.indexOf("tool/result"), "todo/write 必须在 tool/result 之前");
  const todo = sink.events[todoIdx];
  // 面板投影整表替换、无校验：插件侧归一化后如实落盘（允许多个 in_progress）
  assert.deepEqual(todo.data, { todos: [
    { content: "解析需求", status: "in_progress" },
    { content: "提取接口", status: "pending" },
  ] });
});

test("TaskCreate / TaskUpdate 原生任务工具回放成任务表（回执绑定 id、补丁排队）", () => {
  const sink = fakeSink();
  const tracer = new ClaudeRunTracer(sink, 1);
  // 实测（claude 2.1.296 stream-json）：CLI 逐个执行任务工具，每次调用 → 独立回执，
  // 交错到达；TaskCreate 的入参只有 subject，真实 id 只在回执文本里。
  const step = (name, input, callId, resultText) => {
    tracer.handleMessage({ type: "assistant", message: { content: [
      { type: "tool_use", id: callId, name, input },
    ] } });
    tracer.handleMessage({ type: "user", message: { content: [
      { type: "tool_result", tool_use_id: callId, content: resultText },
    ] } });
  };
  step("TaskCreate", { subject: "alpha" }, "c1", "Task #1 created successfully: alpha");
  step("TaskCreate", { subject: "beta" }, "c2", "Task #2 created successfully: beta");
  step("TaskCreate", { subject: "gamma" }, "c3", "Task #3 created successfully: gamma");
  // TaskUpdate 按 CLI 任务系统的数字 id 引用
  step("TaskUpdate", { taskId: "2", status: "in_progress" }, "u1", "Updated task #2 status");
  step("TaskUpdate", { taskId: "1", status: "completed" }, "u2", "Updated task #1 status");
  tracer.finish();

  const todoWrites = sink.events.filter((event) => event.type === "todo/write");
  // 3 次创建 + 2 次状态变更，每次变更都写全量快照
  assert.equal(todoWrites.length, 5);
  assert.deepEqual(todoWrites.at(-1).data, { todos: [
    { content: "alpha", status: "completed" },
    { content: "beta", status: "in_progress" },
    { content: "gamma", status: "pending" },
  ] });
  // 快照必须落在它对应的 tool/call 之后、step/end 之前（回合内任何时刻面板都读到最新表）
  const types = sink.types();
  assert.ok(types.lastIndexOf("todo/write") < types.lastIndexOf("step/end"));
});

test("TodoWrite 入参缺 todos 数组时不写 todo/write（不落垃圾事件）", () => {
  const sink = fakeSink();
  const tracer = new ClaudeRunTracer(sink, 1);
  tracer.handleMessage({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "tw1", name: "TodoWrite", input: {} }] },
  });
  tracer.handleMessage({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "tw1", content: "ok" }] },
  });
  tracer.finish();

  assert.equal(sink.types().includes("todo/write"), false);
  assert.equal(sink.types().includes("tool/call"), true, "tool/call 卡片照常写");
});

// --- 结构化工具产物（SDK 的 tool_use_result → DSH 的 tool/result.data.meta） ---
// SDK 明确说 tool_use_result 是工具的完整 Output 对象（Agent/Task 甚至带 run totals），
// 应该从它渲染而不是去解析 tool_result 文本。原生循环把工具的 result.meta 写进
// `tool/result.data.meta`，本插件此前把它整块丢掉。
function toolRoundTrip(tracer, userId, usermessage) {
  tracer.handleMessage({ type: "system", subtype: "init", session_id: "c1", model: "m", tools: ["Read"] });
  tracer.handleMessage({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: userId, name: "Read", input: { file_path: "/w/a.txt" } }] } });
  tracer.handleMessage({ type: "user", ...usermessage });
  tracer.finish();
}

test("带 tool_use_result 的工具结果把结构化产物写进 data.meta", () => {
  const sink = fakeSink();
  const tracer = new ClaudeRunTracer(sink, 1);
  toolRoundTrip(tracer, "t1", {
    tool_use_result: { file: { filePath: "/w/a.txt", numLines: 2 } },
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a\nb" }] },
  });
  const result = sink.events.find((event) => event.type === "tool/result");
  assert.deepEqual(result.data.meta, { file: { filePath: "/w/a.txt", numLines: 2 } });
  assert.equal(result.data.message.content[0].text, "a\nb", "文本内容不受影响");
});

test("一条消息里多个工具结果时不猜 meta 归属", () => {
  const sink = fakeSink();
  const tracer = new ClaudeRunTracer(sink, 1);
  tracer.handleMessage({ type: "system", subtype: "init", session_id: "c1", model: "m", tools: ["Read"] });
  tracer.handleMessage({ type: "assistant", message: { id: "m1", content: [
    { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/w/a" } },
    { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/w/b" } },
  ] } });
  tracer.handleMessage({ type: "user", tool_use_result: { ambiguous: true }, message: { content: [
    { type: "tool_result", tool_use_id: "t1", content: "a" },
    { type: "tool_result", tool_use_id: "t2", content: "b" },
  ] } });
  tracer.finish();
  const results = sink.events.filter((event) => event.type === "tool/result");
  assert.equal(results.length, 2);
  assert.equal(results[0].data.meta, undefined);
  assert.equal(results[1].data.meta, undefined);
});

test("无法序列化或过大的 tool_use_result 不写 meta（不崩、不膨胀日志）", () => {
  const circular = { name: "root" };
  circular.self = circular;
  for (const [label, value] of [["circular", circular], ["huge", { blob: "x".repeat(200000) }]]) {
    const sink = fakeSink();
    const tracer = new ClaudeRunTracer(sink, 1);
    toolRoundTrip(tracer, "t1", {
      tool_use_result: value,
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    });
    const result = sink.events.find((event) => event.type === "tool/result");
    assert.equal(result.data.meta, undefined, `${label} 不写入 meta`);
    assert.equal(result.data.message.content[0].text, "ok", `${label} 仍保留文本结果`);
  }
});

// --- CLI 自己的上下文压缩：记成可审计事实 ---
// 原生事件里没有「压缩」这种类型（DSH 的 compaction 事件由 BasicCompactionEngine 按 checkpoint
// 契约写，插件伪造会破坏日志），所以只能记插件私有事实。CLI 会上报压缩边界，以及成功/失败，
// 失败时还带 compact_error —— 长会话在这里出问题时至少是看得见的。
test("compact_boundary 归一成可审计事实（含前后 token 与耗时）", () => {
  assert.deepEqual(
    compactObservation({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 180000, post_tokens: 12000, duration_ms: 4210 } }),
    { kind: "boundary", trigger: "auto", preTokens: 180000, postTokens: 12000, durationMs: 4210 },
  );
  assert.deepEqual(compactObservation({ type: "system", subtype: "compact_boundary" }), { kind: "boundary" });
});

test("压缩的开始与结果（含失败原因）各自成事实", () => {
  assert.deepEqual(compactObservation({ type: "system", subtype: "status", status: "compacting" }), { kind: "started" });
  assert.deepEqual(compactObservation({ type: "system", subtype: "status", status: null, compact_result: "success" }), { kind: "settled", result: "success" });
  assert.deepEqual(
    compactObservation({ type: "system", subtype: "status", status: null, compact_result: "failed", compact_error: "unrecognized_model" }),
    { kind: "settled", result: "failed", error: "unrecognized_model" },
  );
});

test("与压缩无关的系统消息不产生事实", () => {
  for (const message of [
    { type: "system", subtype: "status", status: "requesting" },
    { type: "system", subtype: "init", session_id: "c1" },
    { type: "assistant", message: {} },
    undefined,
  ]) assert.equal(compactObservation(message), undefined);
});
