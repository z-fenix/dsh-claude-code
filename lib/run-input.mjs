// 活查询的输入流与投递事实。SDK 收到输入不等于模型已消费；未知消费状态不能自动重放。
import { pluginFacts } from "./plugin-facts.mjs";

export class RunInputChannel {
  #queue = [];
  #readers = [];
  #closed = false;

  push(message) {
    if (this.#closed) throw new Error("Claude input channel is closed");
    const reader = this.#readers.shift();
    if (reader) reader({ done: false, value: message });
    else this.#queue.push(message);
  }

  end() {
    this.#closed = true;
    if (this.#queue.length === 0) {
      for (const resolve of this.#readers.splice(0)) resolve({ done: true, value: undefined });
    }
  }

  close() {
    this.#queue = [];
    this.end();
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.#queue.length) return Promise.resolve({ done: false, value: this.#queue.shift() });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.#readers.push(resolve));
      },
      return: async () => { this.close(); return { done: true, value: undefined }; },
    };
  }
}

const STATES = new Set(["pending", "reserved", "submitted", "observed", "canceled", "uncertain"]);
const NEXT = {
  pending: ["reserved", "canceled"],
  reserved: ["pending", "submitted", "canceled"],
  submitted: ["observed", "canceled", "uncertain"],
  uncertain: ["observed", "canceled"],
  observed: [],
  canceled: [],
};

function inputFacts(session) {
  const entries = new Map();
  const intents = new Map();
  const queues = { "next-turn": [], "next-step": [] };
  for (const event of pluginFacts(session).events()) {
    const data = event.data;
    if (event.type === "claude-code/input-intent" && typeof data?.messageId === "string") {
      intents.set(data.messageId, data.querying === true);
    } else if (event.type === "claude-code/input" && typeof data?.messageId === "string" && STATES.has(data.state)) {
      entries.set(data.messageId, data);
    } else if (event.type === "claude-code/input-batch" && data?.state === "submitted" && Array.isArray(data.entries)) {
      for (const entry of data.entries) {
        if (typeof entry?.messageId === "string" && entry.state === "submitted") entries.set(entry.messageId, entry);
      }
    } else if (event.type === "agent/inbox/spliced" && queues[data?.target]) {
      const queue = queues[data.target];
      const start = Number.isSafeInteger(data.start) ? Math.min(Math.max(data.start, 0), queue.length) : 0;
      const count = Number.isSafeInteger(data.removedCount) ? Math.min(Math.max(data.removedCount, 0), queue.length - start) : 0;
      const inserted = Array.isArray(data.inserted) ? data.inserted : [];
      for (const message of queue.slice(start, start + count)) {
        if (data.outcome === "canceled") entries.delete(message.id);
        if (!inserted.some((item) => item.id === message.id)) intents.delete(message.id);
      }
      queues[data.target] = queue.toSpliced(start, count, ...inserted);
    }
  }
  return { entries, intents };
}

export function inputIntents(session) { return inputFacts(session).intents; }

/** 只有 durable reservation 且没有提交事实的消息可以回到原队列。 */
export function recoverableInputs(session) {
  return [...inputFacts(session).entries.values()].filter((entry) => (entry.state === "reserved" || entry.state === "pending")
    && entry.message?.id === entry.messageId && ["next-turn", "next-step"].includes(entry.queue)
    && Number.isSafeInteger(entry.position) && entry.position >= 0);
}

export class RunInputLedger {
  #session;
  #epoch;
  #entries = new Map();

  constructor(session, epoch) {
    if (typeof epoch !== "string" || epoch.trim() === "") throw new TypeError("input epoch is required");
    this.#session = session;
    this.#epoch = epoch;
    this.#entries = inputFacts(session).entries;
    // reserved 的事实保证尚未提交；submitted 无消费回执时只能按 uncertain 对待。
    for (const [id, entry] of this.#entries) {
      if (entry.epoch === epoch) continue;
      if (entry.state === "reserved") this.#entries.set(id, { ...entry, state: "pending" });
      else if (entry.state === "submitted") this.#entries.set(id, { ...entry, state: "uncertain" });
    }
  }

  stateOf(id) { return this.#entries.get(id)?.state; }

  pending() {
    return [...this.#entries].filter(([, entry]) => entry.state === "pending").map(([id]) => id);
  }

  /** 同一个 SDK envelope 的提交边界只写一条事实，拒写不会留下部分 submitted 批次。 */
  submitBatch(ids, detail) {
    const entries = ids.map((id) => {
      if (this.stateOf(id) !== "reserved") throw new Error(`input ${id} is not reserved`);
      return { ...this.#entries.get(id), ...detail, messageId: id, epoch: this.#epoch, state: "submitted" };
    });
    pluginFacts(this.#session).append("claude-code/input-batch", { epoch: this.#epoch, state: "submitted", entries });
    for (const entry of entries) this.#entries.set(entry.messageId, entry);
  }

  record(id, state, detail = {}) {
    if (typeof id !== "string" || id.trim() === "") throw new TypeError("message id is required");
    if (!STATES.has(state)) throw new TypeError("invalid input state");
    const previous = this.stateOf(id);
    if (previous === state) return;
    const allowed = previous === undefined ? ["pending", "reserved"] : NEXT[previous];
    if (!allowed.includes(state)) throw new Error(`invalid input transition ${previous ?? "new"} -> ${state}`);
    const data = { ...this.#entries.get(id), ...detail, messageId: id, epoch: this.#epoch, state };
    pluginFacts(this.#session).append("claude-code/input", data);
    this.#entries.set(id, data);
  }
}
