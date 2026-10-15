# Interrupted Stream Durability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Native is the preserved execution preference; implementation starts only after the user reviews this written plan.

**Goal:** 保存缺少完整 assistant envelope 的纯文本/reasoning 安全前缀，使查询收尾后可从原生轨迹重放，并让每个已开启 attempt 恰好终结一次。

**Architecture:** 扩展现有 StreamAttempt 的终态和前缀资格；在 ClaudeRunTracer 丢弃 attempt 前统一收尾。完整 envelope 仍优先，工具/空/无效流只 abandon，不借持久化授予成功、usage、消费或 goal 权威。

**Tech Stack:** ESM JavaScript；Node ^22.19.0 || >=24.0.0；node:test；现有 @anthropic-ai/claude-agent-sdk 0.3.220 与 @deepseek-ai/dsh-llm、dsh-session 0.2.0-rc.2；不新增依赖。

**Spec:** docs/superpowers/specs/2026-10-14-interrupted-stream-durability-design.md

## Global Constraints

- 不修改 DSH app.asar，不安装全局 Claude 插件，不自动 commit/push，不运行未经批准的收费推理。
- 普通 followup 排队；steer 在安全边界插入；inject 不自己启动新的人类回合；显式 cancel 停止当前生成，keepInbox 保留待办。
- mod 未支持时保留 MCP；同一查询不重复暴露 goal 工具。
- 系统提示词快照不冒充最终全文，不向 request/header 写 system。
- 子代理继续保持 one-shot；不伪造用量，不重写历史标题。
- 保留当前 dirty main 工作区及既有桥接/goal guard 改动；不 reset、stash、自动 stage 或创建 worktree。
- 不读写正式业务日志、正式 profile、认证信息或宿主 archive；不修复历史事件，包括正式 event 9934。
- 使用现有 Node/依赖版本，不新增产品依赖。本次无需改 SDK 接口或加载 mod。
- 离线测试成功不等于真实 Claude、宿主生命周期或 UI 验收成功。

## Review Focus

1. message_stop 后完整 envelope 才到达：不能提前保存前缀，造成正文重复或吞掉完整 content/usage（Task 1）。
2. 工具片段因非法 index/id 被累积器拒绝：不能只看 assembled blocks 而把剩余文本当纯文本保存（Task 1）。
3. 完整 envelope 的 append 已失败：随后 finish/result 不能再次提交 stream 前缀或生成未广告的工具调用（Task 1）。
4. result 关闭前缀 step 后，后台续跑仍有新响应：后续响应不能被 ended 标志吞掉；各 attempt 终帧和正文不重复（Task 1）。
5. 合成 Session 重建只校验局部事件而不检查关系/stream：必须分别运行公开 session invariant companion 与 expandAssistantStream，并用坏 step/坏 stream 负控验证校验确实生效（Task 2）。

---

## Workspace 与执行规则

保留原工作区，HEAD 基线为 19b8f019b84c84341646e46685e24c31df75f8af；执行前重新核对。之前 goal guard 的 405/405 是历史证据，不替代本项目 fresh baseline。

本计划专属证据目录：`.superpowers/sdd/2026-10-14-interrupted-stream-durability/`。账本首行：

```text
# SDD ledger — plan: docs/superpowers/plans/2026-10-14-interrupted-stream-durability.md
```

执行开始时保存 tracked baseline diff、fresh `pnpm test` 输出和当前 status；另保留本计划开始前相关 untracked spec 的内容，不宣称 tracked diff 能恢复所有先前 untracked 字节。不要访问/修改已完成 goal 项目的专属账本。

无提交授权；任务的 commit 步骤用明确的 uncommitted completion ledger 代替，记录测试命令和结果。scratch 留存，不自动删除。最终 reviewer 必须看本项目 baseline 与 LIVE diff，不能把空 HEAD..HEAD 当审查范围。

## 文件职责

| 文件 | 职责 |
|---|---|
| `lib/claude-run.mjs` | 最小扩展私有 StreamAttempt 终态和 tracer step 关闭兜底，不改变 runner SDK/输入/goal 接口 |
| `test/claude-run.test.mjs` | 生产 tracer 的正文/stream/终帧/失败行为回归；复用现有 fakeSink，不只测 mock 次数 |
| `test/session-compatibility.test.mjs` | 生产 tracer + 真实 npm Session 合成日志重建/stream 验证 |
| `test/helpers/session-relations.mjs` | 只在测试中适配已安装公开 session invariant companion；不创建第二份产品关系校验器 |
| `docs/reference/event-mapping.md` | 前缀结算、abandoned 范围、committed 语义与验证边界 |

### Task 1: 统一结算纯文本前缀与 attempt 终态

**Files:**
- Modify: `lib/claude-run.mjs`（StreamAttempt；ClaudeRunTracer.#onStreamEvent/#closeStep）
- Test: `test/claude-run.test.mjs`

**Interfaces:**
- Consumes: `BlockAssembler.interruptedBlocks(): ContentBlock[]`，已安装依赖提供只含非空 text/reasoning 的安全前缀；`AssistantStreamAccumulator.snapshot()`；现有 sink.append 返回 `{seq}`。
- Produces: 不增加公开产品 API；私有 StreamAttempt `get terminal(): boolean`、`excludePrefix(): void`、`interruptedBlocks(): ContentBlock[]`、`abandon(): void`；现有 `settle(blocks)` 保持原返回 seq/undefined 和抛出写入异常的语义。
- Task 2 只使用现有公开 `new ClaudeRunTracer(sink, turn, {emitStream})`、`handleMessage(message)`、`finish()`、`logIntact`。

- [x] **Step 1: 添加并运行前缀与幂等失败测试**

在现有 fakeSink 后添加本文件局部工具函数和测试。移除下述预期正文/终帧断言会削弱测试；真实生产变化“删掉 closeStep 的前缀结算”必须使测试失败。

```js
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
```

Run: `node --test --experimental-test-module-mocks test/claude-run.test.mjs`
Expected: 新测试在 `messages.length === 1` 失败，实际 0；保留命令完整输出。只有按预期缺失产品行为的 RED 才进入实现，不把 import/fixture 错误当 RED。

- [x] **Step 2: 添加资格/失败/边界测试，再次运行 RED**

继续复用 `streamEvent` 和现有 fakeSink。下列参数化测试代码覆盖 empty/whitespace、工具 start-only、无 start 的 JSON delta、非法工具 index，以及未知 image block。每个情形要求实际正文/工具事件为空且 end 唯一。

```js
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
```

继续添加以下完整测试；已有行为的直接 GREEN 记录为 characterization，不声称新 RED。

```js
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
```

Run: `node --test --experimental-test-module-mocks test/claude-run.test.mjs test/session-format.test.mjs`
Expected: 新资格终帧/前缀失败测试 RED；现有完整响应、失败路径 characterization 与格式测试按真实结果记录，不要求故意让既有行为变 RED。

- [x] **Step 3: 最小实现**

只修改 tracer 模块；不要重构 query/输入/goal。

在 StreamAttempt 中加入资格和 terminal getter；在 `push(chunk)` 的 try 前发现 tool-call-delta 即排除前缀，catch 时也排除，以防非法分片继续进入安全前缀 stream。

```js
#prefixEligible = true;

get terminal() {
  return this.#terminal;
}

excludePrefix() {
  this.#prefixEligible = false;
}

interruptedBlocks() {
  return this.#prefixEligible ? this.#assembler.interruptedBlocks() : [];
}

abandon() {
  if (this.#terminal) return;
  this.#terminal = true;
  this.#emit({
    type: "end",
    attemptId: this.attemptId,
    revision: ++this.#revision,
    index: this.#index,
    outcome: { kind: "abandoned" },
  });
}
```

将 `settle()` 的 catch 内重复的 abandoned 逻辑替换为 `this.abandon(); throw error;`。正常 committed 逻辑不变；不新增完整块 live emission。

```js
// push(chunk) 入口、累积器之前
if (chunk.type === "tool-call-delta") this.excludePrefix();
// 既有 push catch 的第一行
this.excludePrefix();
```

在 `#onStreamEvent` 的 `content_block_start`，保留 `#ensureAttemptForNewMessage()`，之后排除非 text/thinking 开始的块；工具仍走原 pushToolCallDelta 路径。

```js
if (block?.type !== "text" && block?.type !== "thinking") this.#attempt.excludePrefix();
```

在 `#closeStep()` 通过原有 `#stepOpen` 检查后、置 null/关闭状态前加入收尾。完整 pending 仍由既有调用点结算；terminal 防止正常完整消息或写失败再次提交。保留后面的工具收尾和 step/end 双 try/catch。

```js
try {
  if (this.#attempt && !this.#attempt.terminal) {
    const blocks = this.#attempt.interruptedBlocks();
    if (blocks.length > 0) this.#attempt.settle(blocks);
    else this.#attempt.abandon();
  }
} catch {
  this.#logIntact = false;
}
```

实现时依据失败测试检查资格是否足够；不能通过过滤工具块扩大范围。`interruptedBlocks` 非空文本条件来自现有依赖，不复制 assembler。

- [x] **Step 4: targeted 与完整 GREEN**

Run: `node --test --experimental-test-module-mocks test/claude-run.test.mjs test/session-format.test.mjs`
Expected: 全通过；检查正常工具/用量/后台续跑未变。

Run: `pnpm test`
Expected: 所有测试通过；输出既有 Node experimental warning 时如实记录，不称为无 warning。如失败，按根因修复或账本记录外部失败，不隐去任何 failing test。

Run: `node --check lib/claude-run.mjs; node --check test/claude-run.test.mjs; git diff --check`
Expected: 均 exit 0；语法不称为 IDE build。

- [x] **Step 5: 记录任务完成，不提交**

记录该 task 的 RED/GREEN/full suite 命令、结果、所有 Ruling 和 uncommitted 状态到本计划 ledger。不执行 git add/commit/push，不删除 scratch。

### Task 2: 真实 Session 重放、关系负控与文档

**Files:**
- Create: `test/helpers/session-relations.mjs`
- Modify: `test/session-compatibility.test.mjs`
- Modify: `docs/reference/event-mapping.md`

**Interfaces:**
- Consumes: Task 1 的现有公开 tracer；Session.create/snapshotEvents/header/surface；公开 `@deepseek-ai/dsh-session/invariant.apply(ctx)`；公开 `@deepseek-ai/dsh-llm.expandAssistantStream(stream)`。
- Produces: test-only `assertSessionRelations(session): Promise<void>`，把已安装 companion 的 fail callback 转成 Error；不给产品导出，不模拟新 session validator。验证仅限 npm Session 的事件/surface、companion turn/step 关系、stream 结构，不声称安装版完整 v4 storage 校验。

- [x] **Step 1: 先写 helper 行为测试并看到预期 RED**

在 session-compatibility 文件添加 import；helper 缺失时先不要直接 import 缺失文件造成 module 错误，使用现有 Node test 内 dynamic import 的捕获结果断言 API 存在，先观测预期 API assertion RED：

```js
test("公开 session companion 关系检查入口存在", async () => {
  const helper = await import("./helpers/session-relations.mjs").catch(() => ({}));
  assert.equal(typeof helper.assertSessionRelations, "function");
});
```

Run: `node --test --experimental-test-module-mocks test/session-compatibility.test.mjs`
Expected: 上述 typeof assertion 的 undefined !== function；既有五个 tests 保持行为。仅该最小测试捕获缺失 helper；之后改用 static import，避免把其它 import 错误吞掉。

- [x] **Step 2: 最小测试 helper 实现**

创建 helper，完整代码：

```js
import { apply } from "@deepseek-ai/dsh-session/invariant";

export async function assertSessionRelations(session) {
  const listeners = new Map();
  const ctx = {
    sessions: { list: () => [session] },
    on(name, callback) { listeners.set(name, callback); },
    invariants: {
      register(_name, install) {
        return install(ctx, (message) => { throw new Error(`session relations: ${message}`); });
      },
    },
  };
  await apply(ctx);
}
```

此 helper 驱动生产 companion 的 seed validation，不连接 Cordis 服务、不打开 store、不把 ctx 测试接缝引入产品。

- [x] **Step 3: 真实 Session 测试与校验负控**

Task 1 功能已 GREEN；本步骤对前缀本身是直接 GREEN 跨层验收，不虚构新产品 RED。对 helper 的关系负控，删除 helper 对 `apply(ctx)` 的调用必须使负控失败。

添加 static imports：

```js
import { ClaudeRunTracer } from "../lib/claude-run.mjs";
import { expandAssistantStream } from "@deepseek-ai/dsh-llm";
import { assertSessionRelations } from "./helpers/session-relations.mjs";
```

追加完整 integration 测试，消息正文仅合成值，Session detached 不访问用户 storage：

```js
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
```

`cancel` fixture 使用已核对公开 TurnEndReasonMap 的 `{kind:"aborted", reason:{kind:"user"}}`，只验证 tracer 共用收尾与合成回合原因，不调用 SDK interrupt，不冒充真实取消链路验收。

在上面的 integration 测试 `messages[0].data.usage` 断言之后添加 surface 重放断言，读取现有公开 `deriveMessages()`：

```js
assert.deepEqual(reopened.deriveMessages().map((message) => message.content), [[{ type: "text", text: "synthetic prefix" }]]);
```

另添加工具混合流的真实 Session 验收：

```js
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
```

不创建用户默认 private facts，也不复用 goal artifact whitelist。

Run: `node --test --experimental-test-module-mocks test/session-compatibility.test.mjs test/claude-run.test.mjs test/session-format.test.mjs`
Expected: 全通过；负控必须分别拒绝坏 step 和坏 compact stream。

- [x] **Step 4: 文档同步并完整验证**

在 event-mapping 的 SDK 映射表 text/thinking 行和实时帧约束附近添加以下具体说明，不改 goal/input/system 既有边界：

```markdown
缺少完整 assistant envelope 时，查询/step 收尾仍可保存只有 text/reasoning 的非空安全前缀。
这是实际观察内容，不是完整成功响应；`end.outcome.kind = committed` 仅证明消息已落盘。
前缀不补推完整 live chunk，不推算 usage，也不分配 result 总用量。只有实际已记录的
message_delta 用量随前缀保留。空、无效或含工具/其它内容块的 stream-only attempt 只
发 abandoned 终帧，不生成助手消息或工具调用。正常完整 envelope 的结算、工具和用量
优先级不变；本次不覆盖 retry/supersede 和缺 envelope 的多响应边界重构。
```

Run: `pnpm test`
Expected: 全部通过，完整输出保存到本计划目录。

Run: `node --check lib/claude-run.mjs; node --check test/claude-run.test.mjs; node --check test/session-compatibility.test.mjs; node --check test/helpers/session-relations.mjs; git diff --check`
Expected: exit 0。不运行 app.asar/Electron、GUI、Claude CLI 或收费推理；不称为 IDE build。

- [x] **Step 5: 完成与独立审查交接，不提交**

记录 Task 2 的 helper RED/GREEN、跨层直接 GREEN、负控和全套结果。生成 fresh reviewer package，列出 spec/plan/本项目 ledger、baseline 和 LIVE touched files，注明已有 bridge/goal guard 工作不重审。

最终 fresh-context 独立审查使用显式 most-capable 可用模型；只读审查本项目，包括 Review Focus。允许受控离线 tests，禁止正式日志/auth/goals API/archive/model/CLI/GUI，不派其它 reviewer。

Critical/Important 按真实用户影响评级，在主会话做一轮 RED→GREEN 修复并运行完整 suite；Minor 记录而不扩 scope。不二次派 reviewer。最终报告明确验证层、排除项、全部 Ruling 和 deferred minors。不 stage/commit/push，不自动删除证据目录。

## 自检与完成状态

- spec 的前缀/双关闭边界/完整 envelope 优先/终帧/资格/故障覆盖在 Task 1。
- 真实 Session 重建、公开关系与 stream 独立验证及负控、文档在 Task 2。
- 私有标准 fence、历史修复、真实模型验收、usage 估算、工具片段恢复全部排除。
- 新增接口仅 StreamAttempt 私有方法和一个 test-only helper；签名一致，无未定义产品函数。
- 测试代码中 existing fakeSink/streamEvent/tracer 属 Task 1 明确入口；Task 2 独立列出 imports/helper。
- 2026-10-15：用户已批准本计划；Native 两项实施、一次 fresh-context 独立审查及一轮 Important RED→GREEN 修复完成。未提交，证据保留在本项目 ledger；真实模型/桌面验收仍排除。
