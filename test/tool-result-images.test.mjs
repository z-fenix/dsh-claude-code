// test/tool-result-images.test.mjs — 工具结果里的图片块不再被静默丢弃。
//
// 两条链路要一起测：
//  1. 预处理：`prepareToolResultImages` 把 Claude 的内联 base64 图片交给宿主的附件库，
//     按块对象身份登记结果（成功是 `{type:"image", attachment}`，失败是带原因的**文字占位**）。
//  2. 映射：`mapClaudeBlock(block, true)` 取用登记结果；没登记过也必须留占位而不是返回 null
//     （返回 null 就等于静默丢图：模型描述的图片在界面上不存在，用户无从知道少了什么）。
import { test } from "node:test";
import assert from "node:assert/strict";

import { ClaudeRunTracer, mapClaudeBlock, mapClaudeToolResultContent } from "../lib/claude-run.mjs";
import { prepareToolResultImages, preparedImageBlock, isPreparedImageBlock } from "../lib/tool-result-images.mjs";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");

/** 一条 SDK user 消息，里面的 tool_result 携带给定的图片块。 */
function toolResultMessage(imageBlocks, toolUseId = "t1") {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: imageBlocks }] },
  };
}

const base64Image = (mediaType = "image/png", data = PNG) => ({ type: "image", source: { type: "base64", media_type: mediaType, data } });

/** 记录调用、返回可预测引用的假附件服务。 */
function fakeAttachments({ fail } = {}) {
  const calls = [];
  return {
    calls,
    async saveImages(inputs) {
      calls.push(inputs);
      if (fail) throw fail;
      return inputs.map((input, i) => ({
        attachmentId: `sha256:${"0".repeat(8)}${i}`,
        mediaType: input.mediaType,
        width: 1,
        height: 1,
        bytes: input.data.byteLength,
      }));
    },
  };
}

const textOf = (block) => block.text;

test("内联 base64 图片存进附件库，映射成持久引用块", async () => {
  const attachments = fakeAttachments();
  const message = toolResultMessage([{ type: "text", text: "here" }, base64Image()]);
  const seen = await prepareToolResultImages(attachments, message);
  assert.equal(seen, 1);
  assert.equal(attachments.calls.length, 1);
  assert.deepEqual(attachments.calls[0].map((i) => i.mediaType), ["image/png"]);
  assert.deepEqual(attachments.calls[0][0].data, Buffer.from(PNG, "base64"));

  const content = mapClaudeToolResultContent(message.message.content[0].content);
  assert.deepEqual(content[0], { type: "text", text: "here" });
  assert.equal(content[1].type, "image");
  assert.equal(content[1].attachment.mediaType, "image/png");
  assert.equal(content[1].attachment.bytes, Buffer.from(PNG, "base64").byteLength);
  assert.equal("data" in content[1], false, "事件里只留引用，不留 base64");
});

test("一条回执里的多张图按顺序各自落盘，引用顺序与出现顺序一致", async () => {
  const attachments = fakeAttachments();
  const message = toolResultMessage([base64Image("image/png"), base64Image("image/jpeg")]);
  assert.equal(await prepareToolResultImages(attachments, message), 2);
  assert.deepEqual(attachments.calls.map((c) => c[0].mediaType), ["image/png", "image/jpeg"], "逐张提交（批次 1）");
  const content = mapClaudeToolResultContent(message.message.content[0].content);
  assert.deepEqual(content.map((b) => b.attachment.mediaType), ["image/png", "image/jpeg"]);
});

test("同一条消息重复预处理不会重复落盘", async () => {
  const attachments = fakeAttachments();
  const message = toolResultMessage([base64Image()]);
  await prepareToolResultImages(attachments, message);
  const again = await prepareToolResultImages(attachments, message);
  assert.equal(again, 1, "仍然报告看到 1 张（块数不变）");
  assert.equal(attachments.calls.length, 1, "但只写了一次");
});

test("URL 形式的图片写成占位并说明原因，不落盘", async () => {
  const attachments = fakeAttachments();
  const block = { type: "image", source: { type: "url", url: "https://example.invalid/a.png" } };
  await prepareToolResultImages(attachments, toolResultMessage([block]));
  assert.equal(attachments.calls.length, 0);
  const [mapped] = mapClaudeToolResultContent([block]);
  assert.equal(mapped.type, "text");
  assert.match(textOf(mapped), /could not be kept: only inline base64/);
});

test("没有附件服务时降级为占位，不抛也不丢", async () => {
  const block = base64Image();
  assert.equal(await prepareToolResultImages(undefined, toolResultMessage([block])), 1);
  const [mapped] = mapClaudeToolResultContent([block]);
  assert.equal(mapped.type, "text");
  assert.match(textOf(mapped), /no attachment service/);
});

test("落盘失败只降级这一张，同一条回执里别的图照常保留", async () => {
  const attachments = {
    calls: 0,
    async saveImages(inputs) {
      this.calls += 1;
      if (this.calls === 1) throw new Error("IMAGE_TOO_LARGE");
      return [{ attachmentId: "sha256:ok", mediaType: inputs[0].mediaType, width: 1, height: 1, bytes: inputs[0].data.byteLength }];
    },
  };
  const tooBig = base64Image();
  const fine = base64Image("image/jpeg");
  await prepareToolResultImages(attachments, toolResultMessage([tooBig, fine]));
  const content = mapClaudeToolResultContent([tooBig, fine]);
  assert.equal(content[0].type, "text");
  assert.match(textOf(content[0]), /IMAGE_TOO_LARGE/, "失败原因要写在占位里，便于排查");
  assert.equal(content[1].type, "image", "一张超限不该连累同一批里的其它图片");
});

test("不支持的形状（未知 media_type / 空数据 / 非对象）一律占位", async () => {
  const attachments = fakeAttachments();
  const unknown = base64Image("image/svg+xml");
  const empty = base64Image("image/png", "");
  const notAnObject = "not-a-block";
  await prepareToolResultImages(attachments, toolResultMessage([unknown, empty]));
  assert.equal(attachments.calls.length, 0);
  assert.match(textOf(mapClaudeToolResultContent([unknown])[0]), /unsupported image block shape/);
  assert.match(textOf(mapClaudeToolResultContent([empty])[0]), /unsupported image block shape/);
  // 连 source 都没有的对象也不能让预处理抛出去。
  const noSource = { type: "image" };
  await prepareToolResultImages(attachments, toolResultMessage([noSource, notAnObject]));
  assert.match(textOf(mapClaudeToolResultContent([noSource])[0]), /unsupported image block shape/);
});

test("没有图片的消息零成本返回，不登记任何块", async () => {
  const attachments = fakeAttachments();
  for (const message of [
    undefined, null, {}, { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
    toolResultMessage([{ type: "text", text: "no image here" }]),
    { type: "user", message: { content: "plain string" } },
  ]) {
    assert.equal(await prepareToolResultImages(attachments, message), 0, JSON.stringify(message));
  }
  assert.equal(attachments.calls.length, 0);
});

test("助手消息里的图片块仍是未识别块（不改变 unmapped 判定）", () => {
  const block = base64Image();
  assert.equal(isPreparedImageBlock(block), false);
  assert.equal(mapClaudeBlock(block), null, "不传 toolResult 时不认图片");
  assert.equal(mapClaudeBlock(block, false), null);
  // 工具结果方向即使没被预处理过也要留占位，绝不静默丢。
  assert.equal(preparedImageBlock(block), undefined);
  const [mapped] = mapClaudeToolResultContent([block]);
  assert.match(textOf(mapped), /was not preserved/);
});

test("真实 tracer：工具结果里的图片以附件引用落进 tool/result 事件", async () => {
  const events = [];
  const sink = {
    sessionId: "s1",
    append(type, data, opts) { const event = { type, data, opts, seq: events.length }; events.push(event); return event; },
    requestHeader: () => undefined,
    requestContext: () => undefined,
  };
  const tracer = new ClaudeRunTracer(sink, 1);
  tracer.handleMessage({ type: "assistant", message: { id: "m1", role: "assistant",
    source: { kind: "model", provider: "claude-code", model: "claude-x" },
    content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "shot.png" } }] } });

  const attachments = fakeAttachments();
  const message = toolResultMessage([base64Image()]);
  await prepareToolResultImages(attachments, message);
  tracer.handleMessage(message);
  tracer.finish();

  const result = events.find((event) => event.type === "tool/result");
  assert.ok(result, "回执要落成 tool/result 事件");
  const content = result.data.message.content;
  assert.equal(content.length, 1);
  assert.equal(content[0].type, "image");
  assert.equal(content[0].attachment.attachmentId.startsWith("sha256:"), true);
  assert.equal(events.some((event) => JSON.stringify(event).includes(PNG)), false, "事件日志里不出现内联 base64");
});
