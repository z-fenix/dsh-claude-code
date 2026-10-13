import { test } from "node:test";
import assert from "node:assert/strict";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import * as repair from "../lib/session-repair.mjs";
import { decodeSessionLog, markLegacyFacts, renumberEvents } from "../lib/session-repair.mjs";

test("编码把 header 单独放在首帧，宿主列表不能接受整本日志一个帧", () => {
  assert.equal(typeof repair.encodeSessionLog, "function");
  const original = structuredClone(rows);
  const raw = repair.encodeSessionLog(rows);
  const first = zstdDecompressSync(raw, { info: true });
  assert.equal(first.buffer.toString("utf8"), '{"type":"session","version":4,"id":"s1"}\n');
  const body = zstdDecompressSync(raw.subarray(first.engine.bytesWritten));
  assert.equal(body.toString("utf8"), rows.slice(1).map((row) => JSON.stringify(row)).join("\n") + "\n");
  assert.deepEqual(decodeSessionLog(raw).rows, original);
  assert.deepEqual(rows, original);
});

const rows = [{ type: "session", version: 4, id: "s1" },
  { type: "claude-code/input-intent", seq: 0, time: 1, data: { messageId: "u1", querying: true } },
  { type: "unknown-required", seq: 1, time: 2, data: { keep: "unchanged" } }];

test("完整解码拼接帧，包括跨帧的 UTF-8 和 JSONL，不跳过错误", () => {
  const text = Buffer.from(`${JSON.stringify(rows[0])}\n${JSON.stringify({ ...rows[1], data: { text: "你好" } })}\n`);
  const split = text.indexOf(Buffer.from("你好")) + 1;
  const decoded = decodeSessionLog(Buffer.concat([zstdCompressSync(text.subarray(0, split)), zstdCompressSync(text.subarray(split))]));
  assert.equal(decoded.frameCount, 2);
  assert.equal(decoded.rows[1].data.text, "你好");
  for (const bad of [Buffer.from("bad zstd"), zstdCompressSync(Buffer.from('{"type":"session"}')),
    zstdCompressSync(Buffer.from('{"type":"session"}\ninvalid\n')), zstdCompressSync(Buffer.from([0xff, 0x0a])),
    Buffer.concat([zstdCompressSync(Buffer.from('{"type":"session"}\n')), Buffer.from("trailing garbage")])]) {
    assert.throws(() => decodeSessionLog(bad));
  }
});

test("旧日志修复仅改变允许类型的顶层标记，未知类型保持拒读，重复修复幂等", () => {
  const original = structuredClone(rows);
  const first = markLegacyFacts(rows);
  assert.equal(first.changed, 1);
  assert.deepEqual(first.rows, [rows[0], { ...rows[1], ignorable: true }, rows[2]]);
  assert.deepEqual(rows, original);
  assert.equal(markLegacyFacts(first.rows).changed, 0);
});

// 重编号：插入一行后，后面每一行的 seq 都 +1，引用（sourceEventSeqs）必须跟着搬。
const referenceEvents = () => [
  { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
  { type: "tool/call", seq: 1, time: 1, data: { callId: "c1" } },
  { type: "tool/result", seq: 2, time: 1, sourceEventSeqs: [1], data: { callId: "c1" } },
];

test("重编号把 sourceEventSeqs 按同一映射搬走，不留在旧序号上", () => {
  const events = referenceEvents();
  const inserted = { type: "step/end", seq: 99, time: 1, data: { turn: 1, step: 1 } };
  const merged = [events[0], inserted, ...events.slice(1)];
  const output = renumberEvents(merged, { isNew: (row) => row === inserted });
  assert.deepEqual(output.map((row) => row.seq), [0, 1, 2, 3]);
  assert.deepEqual(output[3].sourceEventSeqs, [2], "tool/result 移到 seq 3，引用必须一起搬到 2");
  // 不插入时完全幂等
  assert.deepEqual(renumberEvents(events), events);
});

test("重编号删除被引用的行会报错，不静默改指别的记录", () => {
  const events = referenceEvents();
  assert.throws(() => renumberEvents(events.filter((row) => row.type !== "tool/call")),
    /seq reference 1 on "tool\/result" no longer exists/);
});

test("重编号遇到未知的序号引用键就报错，不静默漏搬", () => {
  const events = [...referenceEvents().slice(0, 2), { type: "x/y", seq: 2, time: 1, throughSeq: 1, data: {} }];
  assert.throws(() => renumberEvents(events), /unsupported seq reference key\(s\): throughSeq/);
});
