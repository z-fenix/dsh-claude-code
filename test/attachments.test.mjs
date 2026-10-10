// test/attachments.test.mjs — 带图片的用户消息必须真的把图片交给 Claude。
//
// 真实故障（2026-10-10）：本插件自己拼提示词时只取 text 块，图片被静默丢弃 —— 模型看不到图，
// 却照常回答（用户看到的现象是「带图片的消息没把图片传给大模型」）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, promptImageRefs, requestImageTarget, textOf } from "../lib/attachments.mjs";

const IMAGE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 假宿主上下文：只提供 attachments 服务。 */
function fakeCtx({ data = IMAGE_BYTES, mediaType = "image/png", fail = null, service = true } = {}) {
  const calls = [];
  const attachments = {
    async readImageRequest(ref, target, signal) {
      calls.push({ ref, target, signal });
      if (fail !== null) throw new Error(fail);
      return { data, mediaType };
    },
  };
  return { ctx: { get: (name) => (name === "attachments" && service ? attachments : undefined) }, calls };
}

const imageBlock = (id = "sha256:abc", extra = {}) => ({
  type: "image",
  attachment: { attachmentId: id, mediaType: "image/png", width: 1010, height: 846, name: "image.png", ...extra },
});
const userMessage = (content) => ({ role: "user", source: { kind: "user" }, content });

/** 把 prompt 收敛成 SDK 消息数组（字符串路径返回 []）。 */
async function drain(prompt) {
  if (typeof prompt === "string") return [];
  const out = [];
  for await (const message of prompt) out.push(message);
  return out;
}

test("纯文本回合仍走字符串路径（不切 streaming input）", async () => {
  const { ctx, calls } = fakeCtx();
  const messages = [userMessage([{ type: "text", text: "写个用例" }])];
  const built = await buildPrompt(ctx, messages, undefined);
  assert.equal(typeof built.prompt, "string");
  assert.equal(built.prompt, "写个用例");
  assert.equal(built.images, 0);
  assert.equal(calls.length, 0, "没有图片时不该碰附件服务");
});

test("带图片的回合把图片投影成 Claude 的 image 块", async () => {
  const { ctx, calls } = fakeCtx();
  const messages = [userMessage([{ type: "text", text: "按图片模板生成测试用例" }, imageBlock()])];
  const built = await buildPrompt(ctx, messages, undefined);
  assert.equal(built.images, 1);
  assert.equal(built.dropped, 0);

  const [message] = await drain(built.prompt);
  assert.equal(message.type, "user");
  assert.equal(message.message.role, "user");
  assert.equal(message.parent_tool_use_id, null);

  const [text, image] = message.message.content;
  assert.deepEqual(text, { type: "text", text: "按图片模板生成测试用例" });
  assert.equal(image.type, "image");
  assert.equal(image.source.type, "base64");
  assert.equal(image.source.media_type, "image/png");
  assert.equal(Buffer.from(image.source.data, "base64").toString("hex"), IMAGE_BYTES.toString("hex"), "base64 必须还原成原始字节");

  assert.equal(calls.length, 1, "每张图投影一次");
  // 契约：width / height / maxBytes 三个整数（宿主 validateTarget 的硬要求）
  assert.deepEqual(calls[0].target, { width: 1010, height: 846, maxBytes: 1048576 });
  assert.equal(calls[0].ref.attachmentId, "sha256:abc");
});

test("目标尺寸按宿主的像素预算算：超预算才缩，缺尺寸用兜底长边", () => {
  const withinBudget = { attachmentId: "sha256:a", mediaType: "image/png", width: 1010, height: 846 };
  assert.deepEqual(requestImageTarget(withinBudget), { width: 1010, height: 846, maxBytes: 1048576 });

  const tooBig = { attachmentId: "sha256:b", mediaType: "image/png", width: 4000, height: 4000 };
  const scaled = requestImageTarget(tooBig);
  assert.deepEqual(scaled, { width: 2048, height: 2048, maxBytes: 1048576 });
  assert.ok(scaled.width * scaled.height <= 4194304, "缩放后必须落在像素预算内");

  const noDims = { attachmentId: "sha256:c", mediaType: "image/png" };
  assert.deepEqual(requestImageTarget(noDims), { width: 2048, height: 2048, maxBytes: 1048576 });
});

test("文本拼接与旧实现逐字一致；文本为空时不产出空 text 块", async () => {
  const { ctx } = fakeCtx();
  const multi = [userMessage([{ type: "text", text: "第一行" }]), userMessage([{ type: "text", text: "第二行" }])];
  assert.equal((await buildPrompt(ctx, multi, undefined)).prompt, "第一行\n第二行");
  assert.equal(textOf(multi[0]), "第一行");

  const onlyImage = await buildPrompt(ctx, [userMessage([imageBlock()])], undefined);
  const [message] = await drain(onlyImage.prompt);
  assert.deepEqual(message.message.content.map((block) => block.type), ["image"]);
});

test("已被投影替换（offloaded）的图片按宿主规则跳过", async () => {
  const { ctx, calls } = fakeCtx();
  const messages = [
    userMessage([{ type: "text", text: "看这张" }, { ...imageBlock("sha256:old"), offloaded: true }]),
  ];
  const built = await buildPrompt(ctx, messages, undefined);
  assert.equal(built.images, 0);
  assert.equal(calls.length, 0);
  assert.equal(typeof built.prompt, "string", "没有可投影的图 → 回到字符串路径");
});

test("读不到图片时补文字占位，不静默丢（部署没有附件服务）", async () => {
  const { ctx } = fakeCtx({ service: false });
  const built = await buildPrompt(ctx, [userMessage([imageBlock("sha256:abc")])], undefined);
  assert.equal(built.images, 0);
  assert.equal(built.dropped, 1);
  const [message] = await drain(built.prompt);
  assert.equal(message.message.content[0].type, "text");
  assert.match(message.message.content[0].text, /no attachment service/);
});

test("投影失败时把原因写进占位并计数", async () => {
  const { ctx } = fakeCtx({ fail: "ATTACHMENT_PROJECTION_UNSUPPORTED" });
  const built = await buildPrompt(ctx, [userMessage([{ type: "text", text: "看图" }, imageBlock()])], undefined);
  assert.equal(built.dropped, 1);
  const [message] = await drain(built.prompt);
  const types = message.message.content.map((block) => block.type);
  assert.deepEqual(types, ["text", "text"], "文本块 + 失败占位");
  assert.match(message.message.content[1].text, /ATTACHMENT_PROJECTION_UNSUPPORTED/);
});

test("多消息多图：顺序保持出现次序，取消信号透传给附件服务", async () => {
  const { ctx, calls } = fakeCtx({ mediaType: "image/jpeg" });
  const signal = new AbortController().signal;
  const messages = [
    userMessage([{ type: "text", text: "A" }, imageBlock("sha256:one")]),
    userMessage([imageBlock("sha256:two")]),
  ];
  const built = await buildPrompt(ctx, messages, signal);
  assert.equal(built.images, 2);
  assert.deepEqual(calls.map((call) => call.ref.attachmentId), ["sha256:one", "sha256:two"]);
  assert.equal(calls[0].signal, signal);
  const [message] = await drain(built.prompt);
  assert.equal(message.message.content[1].source.media_type, "image/jpeg");
});

test("promptImageRefs 跳过没有附件引用的图片块", () => {
  assert.equal(promptImageRefs([userMessage([{ type: "image" }, { type: "image", attachment: {} }])]).length, 0);
  assert.equal(promptImageRefs([userMessage([imageBlock("sha256:x")])]).length, 1);
});
