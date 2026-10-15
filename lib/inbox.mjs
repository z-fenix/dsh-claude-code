// lib/inbox.mjs — 自持的待办队列（Inbox）实现。
//
// DSH 的 Agent 接口要求 agent.inbox 提供 pending 输入的两条队列（next-turn / next-step），
// 并把每一次变更写成会话事件 `agent/inbox/spliced`——这是「模型可见 ⟺ 已记录」规则的落点，
// 也是刷新页面后待办队列能重建的依据。
//
// dsh-agent 在 0.2.0-rc.2 不再导出 Inbox 类（inbox.ts 已并入 dsh-agent-loop，且没有公开
// 子路径导出），所以本插件实现同一份语义：
//   - 每次变更先算归一化结果，再 append `agent/inbox/spliced`，最后发 live 通知；
//   - 同一批 pending 里不允许出现重复 message.id（append 前校验，避免污染重建结果）；
//   - claim() 先清空 next-step，target==='next-turn' 时再取走队首的一条 next-turn
//     （与原生 ReactLoopInbox 的顺序一致：注入消息排在真实用户回合之前）。
//
// 与原生实现的差异：本项目按需重建（从日志折叠），不注册会话投影。
import { foldInboxSplices, readSessionEvents } from "./session-events.mjs";
import { RunInputLedger, recoverableInputs, inputIntents } from "./run-input.mjs";
import { pluginFacts } from "./plugin-facts.mjs";

export class DshInbox {
  /** @type {import("@deepseek-ai/dsh-session").Session} */
  #session;
  /** agent 作用域的通知派发器（agentEvents(...)）。 */
  #dispatch;
  /** { 'next-turn': UserMessage[], 'next-step': UserMessage[] } */
  #state;
  #intents = new Map();
  steers = new Set();

  /**
   * @param session 会话（pending 变更写进它的日志）。
   * @param dispatch agent 作用域事件派发器，提供 emit(name, payload)。
   * @param state 可选初值：resume 时由 foldInboxSplices(session.events) 折叠得到。
   */
  constructor(session, dispatch, state) {
    this.#session = session;
    this.#dispatch = dispatch;
    this.#state = state ?? foldInboxSplices(readSessionEvents(session));
    this.#intents = inputIntents(session);
    for (const message of this.nextStep) if (this.#intents.get(message.id)) this.steers.add(message.id);
    this.recover();
  }

  /** 持久化 querying 意图后才插入；旧 next-step 记录保守地按 inject 处理。 */
  enqueue(target, message, querying) {
    if (this.#locate(message.id)) throw new Error(`message "${message.id}" is already pending`);
    pluginFacts(this.#session).append("claude-code/input-intent", { messageId: message.id, querying: querying === true });
    this.#intents.set(message.id, querying === true);
    this.append(target, message);
  }

  placement(message) {
    const at = this.#locate(message.id);
    return at ? { queue: at.target, position: at.index, querying: at.target === "next-turn" || this.steers.has(message.id) } : {};
  }

  /** 恢复可证明未提交的 claim，包括拒写后仅移除了一部分的批次。 */
  recover() {
    const entries = recoverableInputs(this.#session).sort((a, b) => a.position - b.position);
    for (const entry of entries) {
      if (this.#locate(entry.messageId)) continue;
      pluginFacts(this.#session).append("claude-code/input-intent", { messageId: entry.messageId, querying: entry.querying === true });
      this.#intents.set(entry.messageId, entry.querying === true);
      this.splice(entry.queue, Math.min(entry.position, this.#state[entry.queue].length), 0, [entry.message]);
    }
  }

  /** 等待各轮次处理的用户消息。 */
  get nextTurn() {
    return this.#state["next-turn"];
  }

  /** 等待下一个 step 边界的输入（steer / DSH 注入的提示）。 */
  get nextStep() {
    return this.#state["next-step"];
  }

  /** 两条队列是否都为空。 */
  get hasPending() {
    return this.#state["next-turn"].length > 0 || this.#state["next-step"].length > 0;
  }

  /** 当前队列快照（只读副本，供投影/调试读取）。 */
  get state() {
    return {
      "next-turn": [...this.#state["next-turn"]],
      "next-step": [...this.#state["next-step"]],
    };
  }

  /** 丢弃全部待办输入（先 next-step 再 next-turn，与原生顺序一致）。 */
  clear() {
    this.splice("next-step", 0, this.nextStep.length, []);
    this.splice("next-turn", 0, this.nextTurn.length, []);
    const ledger = new RunInputLedger(this.#session, "inbox-cancel");
    for (const entry of recoverableInputs(this.#session)) ledger.record(entry.messageId, "canceled");
  }

  /**
   * 取走一个边界要消费的整批消息。
   * @param target 'next-turn' 表示同时消费一条排队回合。
   * @param turn 将拥有这批消息的回合号。
   * @returns next-step 队列在前、被取走的回合消息在后。
   */
  claim(target, turn) {
    const claimed = this.#mutate("next-step", 0, this.nextStep.length, [], false);
    if (target === "next-turn") claimed.push(...this.#mutate("next-turn", 0, 1, [], false));
    for (const message of claimed) this.#dispatch.emit("agent/inbox/claimed", { message, turn });
    return claimed;
  }

  /** 非破坏地读取本次要准备的输入；异步图片投影期间仍允许用户修改队列。 */
  peek(target) {
    if (target !== "next-turn" && target !== "next-step") throw new TypeError("invalid inbox target");
    return target === "next-turn" ? [...this.nextStep, ...this.nextTurn.slice(0, 1)] : [...this.nextStep];
  }

  /** 仅消费仍与准备快照相同的一批输入；有编辑/删除时整个批次保持不动。 */
  consume(messages, turn) {
    if (new Set(messages.map((message) => message.id)).size !== messages.length) throw new Error("duplicate claim id");
    for (const message of messages) {
      const at = this.#locate(message.id);
      if (!at || this.#state[at.target][at.index] !== message) return [];
    }
    for (const message of messages) {
      const at = this.#locate(message.id);
      this.#mutate(at.target, at.index, 1, [], false);
    }
    for (const message of messages) this.#dispatch.emit("agent/inbox/claimed", { message, turn });
    return [...messages];
  }

  /** 追加一条消息到指定队列尾部。 */
  append(target, message) {
    this.splice(target, this.#state[target].length, 0, [message]);
  }

  /** 插入一条消息到指定队列头部。 */
  prepend(target, message) {
    this.splice(target, 0, 0, [message]);
  }

  /**
   * 就地替换一条 pending 消息。
   * @returns 该消息原本是否 pending。
   */
  replace(messageId, newMessage) {
    const at = this.#locate(messageId);
    if (at === undefined) return false;
    this.splice(at.target, at.index, 1, [newMessage]);
    return true;
  }

  /**
   * 移除一条 pending 消息。
   * @returns 该消息原本是否 pending。
   */
  remove(messageId, expectedMessage) {
    const at = this.#locate(messageId);
    if (at === undefined || (expectedMessage !== undefined
      && this.#state[at.target][at.index] !== expectedMessage)) return false;
    this.splice(at.target, at.index, 1, []);
    return true;
  }

  /**
   * 标准 splice 语义，并把归一化结果写进日志。
   * @returns 被移除的消息。
   */
  splice(target, start, deleteCount, inserted) {
    return this.#mutate(target, start, deleteCount, inserted, true);
  }

  /** 在两条队列里定位一条 pending 消息。 */
  #locate(messageId) {
    for (const target of ["next-turn", "next-step"]) {
      const index = this.#state[target].findIndex((message) => message.id === messageId);
      if (index >= 0) return { target, index };
    }
    return undefined;
  }

  /**
   * 归一化一次变更 → 落盘 → 发通知。
   * @param discardRemoved true 表示移除即「被用户取消」，需要发 discarded 通知。
   */
  #mutate(target, start, deleteCount, inserted, discardRemoved) {
    const inbox = this.#state[target];
    const truncatedStart = Math.trunc(start);
    const offset = Number.isNaN(truncatedStart) ? 0 : truncatedStart;
    const actualStart = offset < 0 ? Math.max(inbox.length + offset, 0) : Math.min(offset, inbox.length);
    const truncatedDeleteCount = Math.trunc(deleteCount);
    const actualDeleteCount = Math.min(
      Math.max(Number.isNaN(truncatedDeleteCount) ? 0 : truncatedDeleteCount, 0),
      inbox.length - actualStart,
    );
    if (actualDeleteCount === 0 && inserted.length === 0) return [];
    const candidate = inbox.toSpliced(actualStart, actualDeleteCount, ...inserted);
    const other = target === "next-turn" ? this.#state["next-step"] : this.#state["next-turn"];
    const ids = new Set();
    for (const message of [...candidate, ...other]) {
      if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`);
      ids.add(message.id);
    }
    const removed = inbox.slice(actualStart, actualStart + actualDeleteCount);
    const outcome = discardRemoved && actualDeleteCount > 0 ? "canceled" : undefined;
    const event = this.#session.append("agent/inbox/spliced", {
      target,
      start: actualStart,
      ...(actualDeleteCount === 0 ? {} : { removedCount: actualDeleteCount }),
      inserted,
      ...(outcome === undefined ? {} : { outcome }),
    });
    this.#state = target === "next-turn"
      ? { "next-turn": candidate, "next-step": this.#state["next-step"] }
      : { "next-turn": this.#state["next-turn"], "next-step": candidate };
    for (const message of removed) {
      if (!inserted.some((item) => item.id === message.id)) {
        this.steers.delete(message.id);
        this.#intents.delete(message.id);
      }
    }
    if (target === "next-step") for (const message of inserted) if (this.#intents.get(message.id)) this.steers.add(message.id);
    if (discardRemoved) {
      for (const message of removed) this.#dispatch.emit("agent/inbox/discarded", { message });
    }
    for (const message of event.data.inserted) this.#dispatch.emit("agent/inbox/inserted", { message });
    return removed;
  }
}
