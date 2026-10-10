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
