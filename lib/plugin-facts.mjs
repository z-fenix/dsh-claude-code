// 插件私有事实不进入 DSH 的封闭事件词汇；同步写入确认后才能更新投递状态。
import { createHash, randomUUID } from "node:crypto";
import { openSync, closeSync, readFileSync, writeSync, fsyncSync, existsSync, mkdirSync, unlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const PRIVATE_FACT_TYPES = new Set([
  "claude-code/input-intent", "claude-code/input", "claude-code/input-batch",
  "claude-code/input-receipt", "claude-code/prompt-snapshot", "claude-code/mod-status",
  "claude-code/host-persona",
]);
const bound = new WeakMap();
const MAX_BYTES = 128 * 1024 * 1024;

function jsonSnapshot(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value;
  if (!value || typeof value !== "object" || seen.has(value) || Object.getOwnPropertySymbols(value).length
    || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) {
    throw new TypeError("private facts must be losslessly JSON serializable");
  }
  seen.add(value);
  let copy;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new TypeError("private facts must be dense JSON arrays");
    copy = Array.from({ length: value.length }, (_, index) => {
      if (!Object.hasOwn(value, index)) throw new TypeError("private facts must be dense JSON arrays");
      return jsonSnapshot(value[index], seen);
    });
  } else {
    copy = Object.fromEntries(Object.keys(value).map((key) => [key, jsonSnapshot(value[key], seen)]));
  }
  seen.delete(value);
  return copy;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
const digest = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
function snapshot(session) {
  const events = session.snapshotEvents();
  if (!Array.isArray(events)) throw new Error("private facts require a readable session log");
  return events;
}
function identityOf(session) {
  if (typeof session.id !== "string" || !session.id) throw new TypeError("private facts require a session id");
  return { id: session.id, createdAt: session.header?.createdAt ?? null, cwd: session.header?.cwd ?? null };
}
function frozen(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

class FileJournal {
  #identity;
  #file;
  #lock;
  #token = randomUUID();
  #owned = false;
  #size = 0;
  #failed = false;
  constructor(identity, root) {
    this.#identity = identity;
    this.#file = join(root, "facts", `${digest(identity.id)}.jsonl`);
    this.#lock = `${this.#file}.lock`;
  }
  read() {
    const required = `${this.#file}.required`;
    if (!existsSync(this.#file)) {
      if (existsSync(required)) throw new Error("private facts journal is missing");
      return undefined;
    }
    if (statSync(this.#file).size > MAX_BYTES) throw new Error("private facts journal is too large");
    const bytes = readFileSync(this.#file);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.endsWith("\n")) throw new Error("private facts journal is truncated");
    const [header, ...records] = text.slice(0, -1).split("\n").map((line) => JSON.parse(line));
    if (header?.version !== 1 || digest(header.identity) !== digest(this.#identity)) throw new Error("private facts journal identity mismatch");
    if (existsSync(required) && readFileSync(required, "utf8") !== digest(header)) throw new Error("private facts journal manifest mismatch");
    this.#size = bytes.length;
    return records;
  }
  #acquire() {
    if (this.#owned) return;
    mkdirSync(dirname(this.#file), { recursive: true });
    // 所有写入者先取得短租约再检查/回收旧进程的长租约，避免并发删掉新锁。
    const guard = `${this.#lock}.guard`;
    let fd;
    try { fd = openSync(guard, "wx", 0o600); }
    catch (error) { throw new Error("private facts writer conflict (lock guard)", { cause: error }); }
    try {
      if (existsSync(this.#lock)) {
        const owner = JSON.parse(readFileSync(this.#lock, "utf8"));
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error("invalid private facts writer lock");
        try { process.kill(owner.pid, 0); throw new Error("private facts writer conflict"); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
        unlinkSync(this.#lock);
      }
      const lock = openSync(this.#lock, "wx", 0o600);
      try { writeSync(lock, JSON.stringify({ pid: process.pid, token: this.#token })); fsyncSync(lock); }
      finally { closeSync(lock); }
      this.#owned = true;
    } finally { closeSync(fd); unlinkSync(guard); }
  }
  append(record) {
    if (this.#failed) throw new Error("private facts journal is unavailable after a write failure");
    this.#acquire();
    let fd;
    try {
      const header = { version: 1, identity: this.#identity };
      if (existsSync(this.#file)) {
        if (statSync(this.#file).size !== this.#size) throw new Error("private facts journal changed outside its owner");
        fd = openSync(this.#file, "a", 0o600);
      } else {
        if (this.#size !== 0 || existsSync(`${this.#file}.required`)) throw new Error("private facts journal is missing");
        fd = openSync(this.#file, "wx", 0o600);
        this.#write(fd, Buffer.from(`${JSON.stringify(header)}\n`));
        fsyncSync(fd);
      }
      if (!existsSync(`${this.#file}.required`)) {
        const manifest = openSync(`${this.#file}.required`, "wx", 0o600);
        try { this.#write(manifest, Buffer.from(digest(header))); fsyncSync(manifest); }
        finally { closeSync(manifest); }
      }
      const line = Buffer.from(`${JSON.stringify(record)}\n`);
      if (this.#size + line.length > MAX_BYTES) throw new Error("private facts journal is too large");
      this.#write(fd, line);
      fsyncSync(fd);
      this.#size = statSync(this.#file).size;
    } catch (error) { this.#failed = true; throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  #write(fd, bytes) {
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset);
      if (count <= 0) throw new Error("private facts write made no progress");
      offset += count;
    }
  }
  close() {
    if (!this.#owned) return;
    const owner = JSON.parse(readFileSync(this.#lock, "utf8"));
    if (owner.token !== this.#token) throw new Error("private facts writer ownership changed");
    unlinkSync(this.#lock);
    this.#owned = false;
  }
}

export class PluginFacts {
  #session;
  #storage;
  #records;
  #closed = false;
  #failed = false;
  constructor(session, { root = process.env.DSH_CLAUDE_CODE_STORE ?? join(homedir(), ".dsh", "dsh-claude-code"), storage } = {}) {
    this.#session = session;
    this.#storage = storage ?? new FileJournal(identityOf(session), root);
    this.#records = this.#storage.read() ?? [];
    this.#validate(snapshot(session));
    this.#records = this.#records.map(frozen);
  }
  #validate(events) {
    let previousAnchor = -1;
    for (const [index, record] of this.#records.entries()) {
      if (record.factSeq !== index || !PRIVATE_FACT_TYPES.has(record.type) || !Number.isSafeInteger(record.afterSeq)
        || record.afterSeq < previousAnchor || record.afterSeq < -1 || record.afterSeq >= events.length
        || record.anchorHash !== digest(record.afterSeq < 0 ? null : events[record.afterSeq])
        || !Number.isSafeInteger(record.time) || !record.data || typeof record.data !== "object") {
        throw new Error("private facts journal is corrupt or its session anchor does not match");
      }
      previousAnchor = record.afterSeq;
    }
  }
  append(type, data) {
    if (this.#closed || this.#failed) throw new Error("private facts journal is closed or unavailable");
    if (!PRIVATE_FACT_TYPES.has(type)) throw new TypeError("unknown private fact type");
    const events = snapshot(this.#session);
    this.#validate(events);
    const afterSeq = events.length - 1;
    const record = frozen({ type, data: jsonSnapshot(data), time: Date.now(), factSeq: this.#records.length,
      afterSeq, anchorHash: digest(afterSeq < 0 ? null : events[afterSeq]) });
    try { this.#storage.append(record); }
    catch (error) { this.#failed = true; throw error; }
    this.#records.push(record);
    return record;
  }
  /** 仅用于插件事实折叠；原生日志读取/持久化绝不能使用这个合并视图。 */
  events() {
    const native = snapshot(this.#session);
    this.#validate(native);
    const merged = [];
    let index = 0;
    for (let seq = -1; seq < native.length; seq++) {
      if (seq >= 0) merged.push(native[seq]);
      while (this.#records[index]?.afterSeq === seq) merged.push(this.#records[index++]);
    }
    return merged;
  }
  close() {
    if (this.#closed) return;
    this.#storage.close();
    this.#closed = true;
    if (bound.get(this.#session) === this) bound.delete(this.#session);
  }
}

export function bindPluginFacts(session, facts) { bound.set(session, facts); return facts; }
export function pluginFacts(session) {
  let facts = bound.get(session);
  if (!facts) { facts = new PluginFacts(session); bound.set(session, facts); }
  return facts;
}
