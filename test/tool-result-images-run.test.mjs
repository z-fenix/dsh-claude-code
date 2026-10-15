// test/tool-result-images-run.test.mjs — 真实运行循环里的图片接线。
//
// 单元层（test/tool-result-images.test.mjs）已经证明「预处理 → 映射」是对的；这里只回答两个
// 只有整条循环才能回答的问题：
//  1. SDK 的 user 消息到达时，附件库确实被调用了，且图片以**引用**落进 tool/result 事件；
//  2. 没有附件服务（`ctx.get("attachments")` 抛）时回合照常走完，只是降级成文字占位。
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DSH_CLAUDE_CODE_STORE = mkdtempSync(join(tmpdir(), "dsh-cc-img-run-"));

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");

let scripted = [];
mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    query: () => (async function* replay() { for (const message of scripted) yield message; })(),
    createSdkMcpServer: (options) => options,
    tool: () => ({}),
  },
});

const { runClaudeCode } = await import("../lib/claude-run.mjs");

const toolCallFor = () => ({ type: "assistant", message: { id: "m1", role: "assistant",
  source: { kind: "model", provider: "claude-code", model: "claude-x" },
  content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "shot.png" } }] } });
const toolResultFor = () => ({ type: "user", message: { id: "u1", role: "user", content: [{ type: "tool_result",
  tool_use_id: "t1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] }] } });
const success = { type: "result", subtype: "success", result: "done" };

/** 最小的会话 sink：记录事件即可（与 lib 的适配面一致）。 */
function recordingSession(id) {
  const events = [];
  return { id, sessionId: id, header: { cwd: process.cwd(), createdAt: 1 }, events,
    append(type, data, opts) { const event = { type, data, opts, seq: events.length }; events.push(event); return event; },
    snapshotEvents: () => events, requestContext: () => undefined, requestHeader: () => undefined };
}

async function run({ session, get }) {
  // 每条回合都用**新造的块对象**：缓存按对象身份命中，复用同一个对象会让第二条用例
  // 直接拿到上一条已经落好的引用（这正是缓存该有的行为，只是不该被测试共享夹具撞上）。
  scripted = [toolCallFor(), toolResultFor(), success];
  return runClaudeCode({
    ctx: { get, logger: { warn() {}, info() {} } },
    config: {}, session, agent: { id: "a1", status: "running" },
    turn: 1, prompt: "read the screenshot", signal: new AbortController().signal,
    cwd: process.cwd(), executable: "claude", env: {},
  });
}

const imageCalls = () => {
  const calls = [];
  return { calls, async saveImages(inputs) {
    calls.push(inputs);
    return inputs.map((input) => ({ attachmentId: "sha256:deadbeef", mediaType: input.mediaType,
      width: 1, height: 1, bytes: input.data.byteLength }));
  } };
};

test("运行循环把工具结果里的图片落成附件引用，日志里不出现内联 base64", async () => {
  const attachments = imageCalls();
  const session = recordingSession("run-image");
  await run({ session, get: (name) => (name === "attachments" ? attachments : undefined) });

  assert.equal(attachments.calls.length, 1, "回执到达时就要把字节交给宿主附件库");
  const result = session.events.find((event) => event.type === "tool/result");
  assert.ok(result, "回执要落成 tool/result 事件");
  assert.equal(result.data.message.content[0].type, "image");
  assert.equal(result.data.message.content[0].attachment.attachmentId, "sha256:deadbeef");
  assert.equal(JSON.stringify(session.events).includes(PNG), false, "会话日志里不留 base64");
});

test("取不到附件服务也不中断回合：图片降级成文字占位", async () => {
  const session = recordingSession("run-no-attachments");
  const result = await run({ session, get: (name) => {
    if (name === "attachments") throw new Error('cannot get property "attachments" without inject');
    return undefined;
  } });

  assert.equal(result.stopReason !== undefined, true, "回合要正常收尾");
  const toolResultEvent = session.events.find((event) => event.type === "tool/result");
  assert.ok(toolResultEvent);
  assert.deepEqual(toolResultEvent.data.message.content, [
    { type: "text", text: "[an image returned by a tool could not be kept: this deployment has no attachment service]" },
  ], "降级也要说清楚，不能静默丢");
});
