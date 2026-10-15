// lib/tool-result-images.mjs — 把 Claude 工具结果里的图片块落成 DSH 的附件引用。
//
// 为什么需要它：Claude 的 `Read` 工具读图片时，回执是一条 `tool_result`，里面**内联 base64**
// 图片块。旧实现把这类块直接丢掉（`mapClaudeBlock` 只认 text / thinking / tool_use），用户看到
// 的是一句「我看到了这张图」的正文配一张不存在的图——模型描述了图，界面里没有图。
//
// 与输入方向（lib/attachments.mjs）对称：那边用 `readImageRequest` 把 DSH 附件投影成 Claude 的
// image 块，这边用 `saveImages` 把字节存回宿主的附件库，事件里只留一条**持久引用**
// （`{type:"image", attachment}`），不把 base64 塞进会话日志。
//
// 时序上的约束决定了这里的形状：DSH 的 tool/result 必须**按到达顺序**落盘，而附件写入是异步的。
// 所以不是让整条转写链路变异步，而是**在消息进入 tracer 之前**先把图片落盘、把结果按块对象身份
// 登记在一张 WeakMap 里；tracer 里同一条同步路径照旧查表取用（见 mapClaudeBlock 的 image 分支）。
import { Buffer } from "node:buffer";

/** Claude 图片块对象 → 已解析好的 DSH 内容块（成功是 image 块，失败是说明原因的文字块）。 */
const prepared = new WeakMap();

/** tracer 侧取值入口：没有登记过就返回 undefined（调用方自己决定怎么写占位）。 */
export function preparedImageBlock(block) {
  return block && typeof block === "object" ? prepared.get(block) : undefined;
}

/** 测试/诊断用：这条块是否已经被本模块处理过。 */
export function isPreparedImageBlock(block) {
  return prepared.has(block);
}

const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** 一条工具结果里所有待处理的图片块（按出现顺序，只认 tool_result 内的 image）。 */
function imageBlocksOf(message) {
  const content = message?.message?.content;
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const result of content) {
    if (result?.type !== "tool_result" || !Array.isArray(result.content)) continue;
    for (const block of result.content) if (block?.type === "image") blocks.push(block);
  }
  return blocks;
}

/**
 * 把**一个**受限形状的 Claude 图片块登记进 WeakMap。
 * 落盘失败/形状不支持时登记一条文字占位，绝不静默丢弃，也绝不让异常冒到回合上。
 */
async function prepareOne(attachments, block) {
  const source = block?.source;
  const fail = (reason) => prepared.set(block, {
    type: "text",
    text: `[an image returned by a tool could not be kept: ${reason}]`,
  });
  if (source?.type === "url") {
    return fail("only inline base64 images can be preserved, and this one is a URL reference");
  }
  if (source?.type !== "base64" || typeof source.data !== "string" || source.data === ""
    || typeof source.media_type !== "string" || !MEDIA_TYPES.has(source.media_type)) {
    return fail("unsupported image block shape");
  }
  if (!attachments || typeof attachments.saveImages !== "function") {
    return fail("this deployment has no attachment service");
  }
  try {
    const data = Buffer.from(source.data, "base64");
    if (data.byteLength === 0) return fail("empty image payload");
    // 逐张提交（批次大小 1）：一张超出宿主的单图上限时只降级这一张，
    // 不因为同一条回执里另一张太大而把整批都丢掉。
    const refs = await attachments.saveImages([{ data, mediaType: source.media_type }]);
    const ref = refs?.[0];
    if (!ref || typeof ref.attachmentId !== "string") return fail("the attachment store returned no reference");
    prepared.set(block, { type: "image", attachment: ref });
  } catch (error) {
    fail(String(error?.message ?? error));
  }
}

/**
 * 预处理一条 SDK `user` 消息里工具结果携带的图片。**在任何情况下都不抛**。
 *
 * 非工具结果消息、无图片的消息直接返回（不产生任何登记），所以可以无条件地逐条调用。
 * @param {object|undefined} attachments 宿主的 attachments 服务（`ctx.get("attachments")`）
 * @param {object} message SDK 消息
 * @returns {Promise<number>} 实际处理的图片块数（含降级为占位的）
 */
export async function prepareToolResultImages(attachments, message) {
  let blocks;
  try {
    blocks = imageBlocksOf(message);
  } catch {
    return 0;
  }
  for (const block of blocks) {
    if (prepared.has(block)) continue;
    try {
      await prepareOne(attachments, block);
    } catch (error) {
      // prepareOne 自己吞异常；这里只兜住「连登记都失败」的极端情况（例如 frozen 对象不可作 key 之类）。
      try { prepared.set(block, { type: "text", text: `[an image returned by a tool could not be kept: ${String(error?.message ?? error)}]` }); }
      catch { /* 无法登记就只能放弃这一张（tracer 侧会当作未识别块） */ }
    }
  }
  return blocks.length;
}
