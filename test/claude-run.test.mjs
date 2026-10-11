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
