// 旧会话的受限修复：完整解码，不丢记录；实际替换必须另经宿主校验、备份和停写。
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { PRIVATE_FACT_TYPES } from "./plugin-facts.mjs";

export function decodeSessionLog(raw) {
  const limit = 256 * 1024 * 1024;
  if (!Buffer.isBuffer(raw) || raw.length === 0 || raw.length > limit) throw new Error("invalid compressed session size");
  const chunks = [];
  let offset = 0;
  let bytes = 0;
  while (offset < raw.length) {
    const result = zstdDecompressSync(raw.subarray(offset), { info: true, maxOutputLength: limit - bytes });
    const consumed = result.engine.bytesWritten;
    if (!Number.isSafeInteger(consumed) || consumed <= 0 || consumed > raw.length - offset) throw new Error("invalid zstd frame progress");
    bytes += result.buffer.length;
    if (bytes > limit) throw new Error("decoded session is too large");
    chunks.push(result.buffer);
    offset += consumed;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  if (!text.endsWith("\n")) throw new Error("session JSONL is truncated");
  const rows = text.slice(0, -1).split("\n").map((line) => JSON.parse(line));
  if (rows[0]?.type !== "session") throw new Error("session header is missing");
  return { rows, frameCount: chunks.length };
}

// 宿主发现/读取日志要求首个 zstd 帧恰好一行 header，正文另帧；不能整本压成一帧。
export function encodeSessionLog(rows) {
  if (rows[0]?.type !== "session") throw new Error("session header is missing");
  const header = zstdCompressSync(Buffer.from(JSON.stringify(rows[0]) + "\n"));
  if (rows.length === 1) return header;
  const body = zstdCompressSync(Buffer.from(rows.slice(1).map((row) => JSON.stringify(row)).join("\n") + "\n"));
  return Buffer.concat([header, body]);
}

export function markLegacyFacts(original) {
  const rows = structuredClone(original);
  let changed = 0;
  for (const row of rows.slice(1)) {
    if (PRIVATE_FACT_TYPES.has(row.type) && row.ignorable !== true) {
      row.ignorable = true;
      changed++;
    }
  }
  return { rows, changed };
}

/**
 * 事件里指回本日志的序号引用键。重编号只改 `seq` 而不搬这些值，引用会**静默指向别的记录**：
 * 校验只看「更早且唯一」，照样通过，但 tool/result 已经挂到错误的 tool/call 上。v4 里目前只有
 * 这两个键（`sourceEventSeqs` 在 tool/result 上，`messageSeqs` 在 session/title* 上）。
 */
const SEQ_REFERENCE_KEYS = new Set(["sourceEventSeqs", "messageSeqs"]);

/** 找出现有日志里除上述两键之外、长得像序号引用的键；格式演进时用来拦住静默错位。 */
function unknownSeqReferenceKeys(node, found = new Set()) {
  if (Array.isArray(node)) { for (const item of node) unknownSeqReferenceKeys(item, found); return found; }
  if (node === null || typeof node !== "object") return found;
  for (const [key, value] of Object.entries(node)) {
    if (key !== "seq" && !SEQ_REFERENCE_KEYS.has(key) && /Seq$|Seqs$/.test(key)) found.add(key);
    unknownSeqReferenceKeys(value, found);
  }
  return found;
}

/**
 * 把事件按目标顺序重编号（`seq` = 数组下标），并**按同一映射搬走序号引用**。
 *
 * 修复插入/删除行后，后续事件的序号都会位移；引用（sourceEventSeqs / messageSeqs）留在原值上
 * 就会错位。锚点用每行原有的 `seq`，因此 `events` 必须保留原 seq —— 本次新插入的行用
 * `isNew` 标出来（它们没有旧 seq，不参与映射）。
 *
 * @param {object[]} events 目标顺序的事件行（不含 header）
 * @param {{isNew?: (row: object) => boolean}} [options]
 * @returns {object[]} 重编号后的事件行
 */
export function renumberEvents(events, { isNew = () => false } = {}) {
  const unknown = events.map((row) => unknownSeqReferenceKeys(row)).find((keys) => keys.size > 0);
  if (unknown !== undefined) throw new Error(`unsupported seq reference key(s): ${[...unknown].join(", ")}`);
  const moved = new Map();
  events.forEach((row, index) => {
    if (!isNew(row) && Number.isSafeInteger(row.seq)) moved.set(row.seq, index);
  });
  const remap = (value, owner) => {
    if (!Number.isSafeInteger(value)) throw new Error(`seq reference ${String(value)} on "${owner}" is not a seq`);
    if (!moved.has(value)) throw new Error(`seq reference ${value} on "${owner}" no longer exists after renumbering`);
    return moved.get(value);
  };
  const rewrite = (node, owner) => {
    if (Array.isArray(node)) return node.map((item) => rewrite(item, owner));
    if (node === null || typeof node !== "object") return node;
    const next = {};
    for (const [key, value] of Object.entries(node)) {
      next[key] = SEQ_REFERENCE_KEYS.has(key) && Array.isArray(value)
        ? value.map((seq) => remap(seq, owner))
        : rewrite(value, owner);
    }
    return next;
  };
  return events.map((row, index) => ({ ...rewrite(row, row.type), seq: index }));
}
