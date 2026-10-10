// test/session-format.test.mjs — 锁住 DSH v4 会话格式的三条硬约束（违反任一条，整条会话
// 会被 DSH 判损坏：历史加载失败 / resume failed … is corrupt，会话永久打不开）。
//
// 约束出处（宿主 app.asar 内 @deepseek-ai/dsh-session-format-v3-to-v4 的 Relationships 校验）：
//   ① 每个 tool/call 必须先被同 step 的 assistant/message 里的 tool-call 块「广告」过，
//      且 id / name / arguments 三者完全一致；
//   ② step/end（以及 turn/end）之前不能留下没有结果的 tool/call；
//   ③ 日志不能停在「开着的 step」；turn 停在开着是允许的。
// 另有一条写入闸门规则：tool/result 是 surface-eligible 事件，append 必须带 surfaceOp 标记。
//
// 这些断言来自真实事故（2026-10-10）：一次审批被取消 → 合成结果 append 被拒 → 回合收尾
// 状态机错位，两份会话日志因此永久损坏。
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeRunTracer } from "../lib/claude-run.mjs";

/** 假会话：记录 append，返回自增 seq；可选地在指定事件类型上拒绝写入。 */
function fakeSink({ reject = () => false } = {}) {
  const events = [];
  return {
    sessionId: "session-test",
    events,
    append(type, data, opts) {
      if (reject(type)) throw new Error(`write rejected: ${type}`);
      const event = { type, data, opts: opts ?? {}, seq: events.length };
      events.push(event);
      return event;
    },
    requestHeader: () => undefined,
    requestContext: () => undefined,
  };
}

const toolUse = (id, name, input = {}) => ({ type: "assistant", message: { model: "m", content: [{ type: "tool_use", id, name, input }] } });
const toolResult = (id, text = "ok") => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
const result = () => ({ type: "result", subtype: "success", result: "done", usage: { input_tokens: 1, output_tokens: 1 } });

/** 折叠出每个 step 里的调用/结果，并核对三条约束。 */
function audit(events) {
  const advertised = new Map(); // callId -> { name, arguments }
  const open = new Map(); // callId -> step
  const steps = new Set();
  let step = null;
  for (const event of events) {
    if (event.type === "assistant/message") {
      for (const block of event.data.message.content ?? []) {
        if (block?.type !== "tool-call") continue;
        assert.ok(!advertised.has(block.id), `重复广告 ${block.id}`);
        advertised.set(block.id, { name: block.name, arguments: block.arguments });
      }
    } else if (event.type === "step/start") {
      step = event.data.step;
      steps.add(step);
      assert.ok(!events.slice(0, event.seq + 1).some((e) => e.type === "step/start" && e.data.step === step && e.seq !== event.seq), "step 号不得复用");
    } else if (event.type === "step/end") {
      assert.equal(open.size, 0, `step/end 留下未决调用：${[...open.keys()].join(",")}`);
      step = null;
    } else if (event.type === "tool/call") {
      const ad = advertised.get(event.data.callId);
      assert.ok(ad, `① tool/call ${event.data.callId} 没有被 assistant/message 广告过`);
      assert.equal(ad.name, event.data.name, "① 广告的 name 与 tool/call 不一致");
      assert.equal(ad.arguments, event.data.arguments, "① 广告的 arguments 与 tool/call 不一致");
      open.set(event.data.callId, event.data.step);
    } else if (event.type === "tool/result") {
      const callId = event.data.message.toolCallId;
      assert.ok(open.has(callId), `② tool/result ${callId} 没有对应的（未决）tool/call`);
      assert.ok(event.opts.surfaceOp, `写入闸门：tool/result 必须带 surfaceOp 标记`);
      open.delete(callId);
    }
  }
  assert.equal(open.size, 0, `③ 日志结束时仍有未决调用：${[...open.keys()].join(",")}`);
  assert.equal(step, null, "③ 日志结束时 step 还开着");
  return { steps, advertised };
}

test("同一步里的第二条助手消息另起一步，不留未广告的 tool/call", () => {
  const sink = fakeSink();
  const tracer = new ClaudeRunTracer(sink, 1, {});
  tracer.handleMessage({ type: "system", subtype: "init", model: "m", tools: ["Skill", "Read"] });
  // 一条助手消息带一个工具调用，结果回来后**同一步里又来了第二条**助手消息 ——
  // 旧实现里第二条消息落不了盘、它的 tool/call 却发出，日志因此违规。
  tracer.handleMessage(toolUse("call_a", "Skill", { skill: "x" }));
  tracer.handleMessage(toolResult("call_a"));
  tracer.handleMessage(toolUse("call_b", "Read", { file_path: "x" }));
  tracer.handleMessage(toolResult("call_b"));
  tracer.handleMessage(result());
  tracer.finish();

  const { steps, advertised } = audit(sink.events);
  assert.equal(advertised.size, 2, "两个调用都必须被广告");
  assert.equal(steps.size, 2, "两条助手消息各占一步");
  assert.equal(tracer.step, 2);
  assert.equal(tracer.logIntact, true);
});

test("合成结果被写入口拒绝时：step 仍然关掉，且标记日志不完整（上层据此不补 turn/end）", () => {
  const sink = fakeSink({ reject: (type) => type === "tool/result" });
  const tracer = new ClaudeRunTracer(sink, 1, {});
  tracer.handleMessage({ type: "system", subtype: "init", model: "m", tools: ["Bash"] });
  tracer.handleMessage(toolUse("call_x", "Bash", { command: "ls" }));
  tracer.handleMessage(result());
  tracer.finish();

  const types = sink.events.map((event) => event.type);
  assert.ok(types.includes("step/start"), "step 开过");
  assert.equal(types.at(-1), "step/end", "补写失败也必须把关 step 的 step/end 写下去");
  assert.equal(tracer.logIntact, false, "写入口拒绝过 append → 日志不完整");
});

test("正常一轮：tool/result 带 surfaceOp，且结果与调用配对", () => {
  const sink = fakeSink();
  const tracer = new ClaudeRunTracer(sink, 1, {});
  tracer.handleMessage({ type: "system", subtype: "init", model: "m", tools: ["Bash"] });
  tracer.handleMessage(toolUse("call_ok", "Bash", { command: "ls" }));
  tracer.handleMessage(toolResult("call_ok", "file.txt"));
  tracer.handleMessage(result());
  tracer.finish();

  audit(sink.events);
  const call = sink.events.find((event) => event.type === "tool/result");
  assert.equal(call.opts.surfaceOp, "append");
  assert.deepEqual(call.opts.sourceEventSeqs, [sink.events.find((event) => event.type === "tool/call").seq]);
  assert.equal(tracer.logIntact, true);
});
