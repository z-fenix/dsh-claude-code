// lib/attachments.mjs — 把 DSH 会话消息里的图片块投影成 Claude 侧可用的 image 内容块。
//
// 为什么需要它：本插件自己造提示词（见 lib/agent.mjs 的 drive()），必须把用户消息里的
// 图片一并交给 Claude。只拼文本的旧实现会把图片**静默丢掉**——模型看不到图，却照常回答，
// 用户看到的就是「带图片的消息没把图片传给大模型」。
//
// 取字节的入口是宿主的 attachments 服务（`ctx.get("attachments")`，即 @deepseek-ai/dsh-attachment）：
//   readImageRequest(ref, { maxPixels, maxBytes }, signal) → { data, mediaType }
// 与 DSH 自带模型路由（dsh-llm-pi-ai / dsh-llm-deepseek）用的是同一个投影口，所以缩放/压缩
// 策略由宿主决定，这里不自行裁图。默认策略照抄它们的 requestImagePolicy。
import { Buffer } from "node:buffer";

/** 与 dsh-llm-pi-ai 的默认 requestImagePolicy 一致。 */
const MAX_PIXELS = 4194304;
const MAX_BYTES = 1048576;
/** 引用里没带尺寸时的兜底长边（= @deepseek-ai/dsh-attachment 的 DEFAULT_MAX_IMAGE_DIMENSION）。 */
const MAX_DIMENSION = 8192;

/**
 * 按像素预算算目标尺寸——**逐字照搬**宿主自己的实现
 * （@deepseek-ai/dsh-attachment 的 requestImageDimensions），不自行发明缩放规则，
 * 否则同一张图会因为目标不同而每次重编码。
 * @returns {{width: number, height: number}}
 */
function requestImageDimensions(width, height, maxPixels) {
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
  if (scale === 1) return { width, height };
  let projectedWidth = Math.max(1, Math.floor(width * scale));
  let projectedHeight = Math.max(1, Math.round((projectedWidth * height) / width));
  while (projectedWidth * projectedHeight > maxPixels && projectedWidth > 1) {
    projectedWidth -= 1;
    projectedHeight = Math.max(1, Math.round((projectedWidth * height) / width));
  }
  return { width: projectedWidth, height: projectedHeight };
}

/**
 * 附件服务要的投影目标。
 *
 * 契约来自 @deepseek-ai/dsh-attachment-local 的 validateTarget：**width / height / maxBytes
 * 三个整数缺一不可**，只给 maxPixels 会被直接拒绝（那样图片仍传不过去）。
 * @param {object} ref 会话图片块里的 attachment 引用
 */
export function requestImageTarget(ref) {
  const width = Number.isSafeInteger(ref?.width) && ref.width > 0 ? ref.width : MAX_DIMENSION;
  const height = Number.isSafeInteger(ref?.height) && ref.height > 0 ? ref.height : MAX_DIMENSION;
  return { ...requestImageDimensions(width, height, MAX_PIXELS), maxBytes: MAX_BYTES };
}

/** 一条消息里的所有文本块拼成一段（与旧的 textOf 行为一致，保持文本侧零变化）。 */
export function textOf(message) {
  const texts = [];
  for (const block of message?.content ?? []) {
    if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
  }
  return texts.join("\n");
}

/**
 * 消息里需要投影的图片引用。
 *
 * `offloaded === true` 的图片表示它在 DSH 的上下文腾挪里已被替换掉，宿主自己也跳过
 * （dsh-llm-pi-ai 的 collectImageRefs 同样条件），这里照做。
 * @returns {{ ref: object, name: string|undefined }[]}
 */
export function promptImageRefs(messages) {
  const refs = [];
  for (const message of messages ?? []) {
    for (const block of message?.content ?? []) {
      if (block?.type !== "image") continue;
      if (block.offloaded === true) continue;
      const ref = block.attachment;
      if (!ref || typeof ref.attachmentId !== "string") continue;
      refs.push({ ref, name: typeof ref.name === "string" ? ref.name : undefined });
    }
  }
  return refs;
}

/**
 * 把图片引用投影成 Claude 的 image 内容块。
 *
 * 读不出来的图片不静默丢弃：补一条文字占位，让模型知道「这里本来有张图但拿不到」，
 * 而不是像旧实现那样当作纯文本请求发出去。
 * @param {object|undefined} attachments 宿主的 attachments 服务
 * @param {{ref: object, name?: string}[]} refs 待投影的引用
 * @param {AbortSignal} [signal] 回合取消信号
 * @returns {Promise<{ blocks: object[], attached: number, dropped: number }>}
 */
export async function projectImages(attachments, refs, signal) {
  const blocks = [];
  let attached = 0;
  let dropped = 0;
  for (const { ref, name } of refs) {
    const label = name === undefined ? ref.attachmentId : `${name} (${ref.attachmentId})`;
    if (attachments === undefined) {
      dropped += 1;
      blocks.push({ type: "text", text: `[image ${label} was attached but the deployment has no attachment service, so it could not be sent]` });
      continue;
    }
    try {
      const version = await attachments.readImageRequest(ref, requestImageTarget(ref), signal);
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: version.mediaType,
          data: Buffer.from(version.data).toString("base64"),
        },
      });
      attached += 1;
    } catch (error) {
      dropped += 1;
      blocks.push({ type: "text", text: `[image ${label} could not be read: ${String(error?.message ?? error)}]` });
    }
  }
  return { blocks, attached, dropped };
}

/** 把内容块包成 SDK 需要的单条用户消息流（streaming input 模式）。 */
export function promptStream(content) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
    },
  };
}

/**
 * 由本回合认领的消息造出交给 Claude 的提示词。
 *
 * 没有图片时返回字符串（与旧行为逐字一致，避免无谓地切到 streaming input 模式）；
 * 有图片时返回 `AsyncIterable<SDKUserMessage>`，文本拼接方式与字符串路径完全相同，
 * 图片块跟在其后。
 * @param {object} ctx 宿主上下文（取 attachments 服务）
 * @param {object[]} messages 本回合认领的用户消息
 * @param {AbortSignal} [signal] 回合取消信号
 * @returns {Promise<{ prompt: string|AsyncIterable<object>, images: number, dropped: number }>}
 */
export async function buildPrompt(ctx, messages, signal) {
  const text = (messages ?? []).map(textOf).join("\n");
  const refs = promptImageRefs(messages);
  if (refs.length === 0) return { prompt: text, images: 0, dropped: 0 };
  const { blocks, attached, dropped } = await projectImages(ctx?.get?.("attachments"), refs, signal);
  const content = text === "" ? blocks : [{ type: "text", text }, ...blocks];
  return { prompt: promptStream(content), images: attached, dropped };
}
