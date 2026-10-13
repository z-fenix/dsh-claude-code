// 一个查询拥有一份输入流和 epoch；回显是收到回执，只有可关联的消费证据才改变回合权威。
import { randomUUID } from "node:crypto";
import { buildPrompt } from "./attachments.mjs";
import { RunInputChannel, RunInputLedger } from "./run-input.mjs";
import { pluginFacts } from "./plugin-facts.mjs";

async function contentOf(prompt) {
  if (typeof prompt === "string") return [{ type: "text", text: prompt }];
  const content = [];
  for await (const item of prompt) {
    const blocks = item.message?.content;
    if (typeof blocks === "string") content.push({ type: "text", text: blocks });
    else if (Array.isArray(blocks)) content.push(...blocks);
  }
  return content;
}

export class ClaudeRunControl {
  channel = new RunInputChannel();
  initialSubmitted = false;
  #ctx;
  #session;
  #signal;
  #abort;
  #query;
  #ledger;
  #epoch;
  #entries = new Map();
  #lane = Promise.resolve();
  #preparing = 0;
  #draining = false;
  #stopping = false;
  #stop;
  #resultSeen = false;
  #tasks = new Set();
  #onSubmitted;
  #onConsumed;
  #canSubmit;
  #placement;

  constructor({ ctx, session, signal, abort, epoch = randomUUID(), onInputSubmitted, onInputConsumed, canSubmitInput, inputPlacement }) {
    this.#epoch = epoch;
    this.#ctx = ctx;
    this.#session = session;
    this.#signal = signal;
    this.#abort = abort;
    this.#ledger = new RunInputLedger(session, this.#epoch);
    this.#onSubmitted = onInputSubmitted;
    this.#onConsumed = onInputConsumed;
    this.#canSubmit = canSubmitInput;
    this.#placement = inputPlacement;
  }

  get stopping() { return this.#stopping; }
  get closed() { return this.#draining || this.#stopping; }
  get public() {
    return Object.freeze({
      submit: (messages, options) => this.submit(messages, options),
      interrupt: () => this.interrupt(),
      close: () => this.close(),
    });
  }

  async prepareInitial(prompt, messages) {
    return { content: await contentOf(prompt), messages };
  }

  start(query, prepared) {
    this.#query = query;
    this.#assertOpen();
    this.#publish(prepared.messages, prepared.content, true, true);
    this.initialSubmitted = true;
  }

  submit(messages, { shouldQuery = true } = {}) {
    this.#preparing += 1;
    const task = this.#lane.then(async () => {
      this.#assertOpen();
      const { prompt } = await buildPrompt(this.#ctx, messages, this.#signal);
      const content = await contentOf(prompt);
      this.#assertOpen();
      if (this.#canSubmit && !this.#canSubmit(messages)) return false;
      this.#publish(messages, content, shouldQuery, false);
      return true;
    });
    this.#lane = task.catch(() => {});
    return task.finally(() => { this.#preparing -= 1; this.#maybeEnd(); });
  }

  #assertOpen() {
    if (this.closed || this.#signal.aborted) throw new Error("Claude input channel is closed or stopping");
  }

  #publish(messages, content, shouldQuery, initial) {
    const ids = messages.map((message) => typeof message.id === "string" && message.id !== "" ? message.id : randomUUID());
    const uuid = ids.at(-1) ?? randomUUID();
    const placements = initial ? [] : this.#placement?.(messages) ?? [];
    for (let index = 0; index < ids.length; index++) {
      const state = this.#ledger.stateOf(ids[index]);
      if (state !== undefined && state !== "pending" && !(initial && state === "reserved")) throw new Error(`input ${ids[index]} has already been submitted`);
      this.#ledger.record(ids[index], "reserved", { ...placements[index], message: messages[index], shouldQuery });
    }
    if (!initial) this.#onSubmitted?.(messages);
    this.#ledger.submitBatch(ids, { sdkUuid: uuid, shouldQuery });
    this.#entries.set(uuid, { ids, messages, shouldQuery, consumed: false });
    this.channel.push({
      type: "user", uuid, parent_tool_use_id: null,
      message: { role: "user", content }, shouldQuery,
      priority: shouldQuery && !initial ? "now" : "next",
      origin: { kind: messages.some((message) => message.source?.kind === "user") ? "human" : "auto-continuation" },
    });
  }

  handleMessage(message) {
    if (this.#stopping) return;
    if (message.type === "system") {
      if (message.subtype === "background_tasks_changed" && Array.isArray(message.tasks)) {
        this.#tasks = new Set(message.tasks.map((task) => task.task_id));
      } else if (message.subtype === "task_started") {
        this.#tasks.add(message.task_id);
      } else if (message.subtype === "task_notification") {
        this.#tasks.delete(message.task_id);
      }
    }
    if (message.parent_tool_use_id != null) return;
    if (message.type === "user" && message.isReplay && this.#entries.has(message.uuid)) {
      pluginFacts(this.#session).append("claude-code/input-receipt", { epoch: this.#epoch, sdkUuid: message.uuid, kind: "acknowledged" });
    }
    if (message.type === "result") {
      this.#resultSeen = true;
      const entry = this.#entries.get(message.user_message_uuid);
      if (entry && !entry.consumed && message.subtype === "success") {
        for (const id of entry.ids) this.#ledger.record(id, "observed", { sdkUuid: message.user_message_uuid, evidence: "result" });
        entry.consumed = true;
        this.#onConsumed?.(entry.messages);
      }
    }
    this.#maybeEnd();
  }

  #maybeEnd() {
    if (!this.closed && this.#resultSeen && this.#tasks.size === 0 && this.#preparing === 0) {
      this.#draining = true;
      this.channel.end();
    }
  }

  interrupt() {
    if (this.#stop) return this.#stop;
    this.#stopping = true;
    this.channel.close();
    this.#stop = (async () => {
      let timer;
      try {
        const receipt = await Promise.race([
          Promise.resolve().then(() => this.#query?.interrupt()),
          new Promise((resolve) => { timer = setTimeout(resolve, 1000); }),
        ]);
        if (Array.isArray(receipt?.still_queued)) {
          const queued = receipt.still_queued.filter((uuid) => this.#entries.has(uuid));
          pluginFacts(this.#session).append("claude-code/input-receipt", { epoch: this.#epoch, kind: "interrupt", stillQueued: queued });
        }
      } catch {
        // 无 receipt / 旧 CLI / 控制失败都不证明未消费；硬关闭后保留 uncertain。
      } finally {
        clearTimeout(timer);
        this.close();
        this.#abort();
      }
    })();
    return this.#stop;
  }

  close() {
    this.#stopping = true;
    this.channel.close();
    this.#query?.close?.();
  }

  async finish() {
    if (this.#stop) await this.#stop;
    for (const entry of this.#entries.values()) {
      if (!entry.consumed) {
        for (const id of entry.ids) this.#ledger.record(id, "uncertain", { reason: "query ended without consumption evidence" });
      }
    }
    this.close();
  }
}
