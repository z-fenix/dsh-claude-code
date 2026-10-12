// lib/child-agent.mjs — 子代理的「状态载体」Agent。
//
// 为什么需要它：DSH 的 lineage 面板每一行的运行状态，只来自**宿主对子会话的 running 判定**，
// 而 running 只可能由「该会话在 `ctx.agents` 注册表里有一个 `status === "running"` 的 Agent」
// 产生——`@deepseek-ai/dsh-api-session-controller` 的 `summaryFor` 读
// `agents.get(id)?.status`，而 `api-session/status` 只由 `agent/status` 派发
// （见 `packages/api/session-controller/src/list.ts`、`src/index.ts`）。
// 子代理是只读投影、不驱动任何模型回合，但**必须**在注册表里登记一个 Agent，否则正在执行的
// 子代理会被渲染成「一次性 · 当前未运行」（实测故障），表头也不会出现「正在运行」计数。
//
// 这个载体刻意什么都不驱动：没有模型路由、不消费待办队列、不派发任何回合，只在
// `start()` / `settle()` 之间把 status 从 idle 翻到 running 再翻回去。会话本身仍是**只读**的：
// 子会话头部的 `origin: 'subagent'` 会让宿主把通用控制（cancel / queue / prompt）以
// `session/agent-busy` 拒掉（`hasApiSessionSubagentOwner`），所以面板不会因此多出可用的输入框。
import { agentEvents } from "@deepseek-ai/dsh-agent";
import { createScope } from "@deepseek-ai/dsh-scope";
import { DshInbox } from "./inbox.mjs";

/**
 * 一个只做状态载体的被动 Agent：接口与 `@deepseek-ai/dsh-agent` 的 Agent 一致，行为全部退化。
 */
export class ClaudeChildAgent {
  /** `idle`（未开始）→ `running`（子代理在执行）→ `settled`（已收尾，幂等终态）。 */
  #state = "idle";
  /** 注册表注销闭包；由 `attach()` 写入（登记成功之后）。 */
  #detach = undefined;
  /** `whenIdle()` 的完成许诺。 */
  #settled;
  #resolveSettled;

  /**
   * @param {object} loopCtx 宿主上下文（与主 Agent 同一个：状态派发要落到宿主监听器上）
   * @param {object} session 子会话
   */
  constructor(loopCtx, session) {
    this.loopCtx = loopCtx;
    this.id = session.id;
    this.session = session;
    /** 无自有模型路由：载体不请求任何模型。 */
    this.options = {};
    this.dispatch = agentEvents(loopCtx, this);
    // 只读子会话的待办队列恒为空；构造只折叠已有事件，不写日志。
    this.inbox = new DshInbox(session, this.dispatch);
    // 必须是**真** scope：第三方 `agent/created` 监听器会在 `agent.ctx` 上 inject 自己的贡献
    // （`dsh-file-reference-local` 的提示段、`dsh-tool-subagent` 的委派工具），绑不到 scope
    // 就会让整条登记失败（`agent.ctx.inject` 不存在直接抛）。
    this.scope = createScope(loopCtx, this);
    this.ctx = this.scope.ctx;
    this.#settled = new Promise((resolve) => { this.#resolveSettled = resolve; });
  }

  /** 当前生命周期状态（宿主的 running 判定读的就是它）。 */
  get status() {
    return this.#state === "running" ? "running" : "idle";
  }

  /**
   * 收到注册表注销闭包。已收尾（登记晚于收尾）时就地注销，避免留下未成对的 entry。
   * @param {() => void} detach 注册表 detach 闭包
   */
  attach(detach) {
    if (this.#state === "settled") {
      detach?.();
      return;
    }
    this.#detach = detach;
  }

  /** 子代理开始执行：idle → running（只在真实跳变时上报；dsh-agent 的 invariant 禁止重复同态）。 */
  start() {
    if (this.#state !== "idle") return;
    this.#state = "running";
    this.dispatch.emit("agent/status", { status: "running" });
  }

  /**
   * 子代理收尾：running → idle（上报）+ 注销 + 拆 scope；未上报过 running 就等于只是关掉载体。
   * 幂等。次序有意固定：先上报 idle（宿主把会话标成不运行）、再注销（对方按 `agent/disposed`
   * 收自己的 per-agent 注册）、最后才拆 scope——反过来的话监听器会在已死的作用域上再注册。
   * @returns {Promise<void>}
   */
  async settle() {
    if (this.#state === "settled") return this.#settled;
    const wasRunning = this.#state === "running";
    this.#state = "settled";
    if (wasRunning) this.dispatch.emit("agent/status", { status: "idle" });
    try {
      this.#detach?.();
    } catch {
      // 注册表 detach 幂等；重复/失效句柄忽略。
    }
    this.#detach = undefined;
    try {
      await this.scope.dispose();
    } catch {
      // 作用域已拆（父 agent 释放时可能连带拆掉）等价于成功。
    }
    this.#resolveSettled();
    return this.#settled;
  }

  /** 释放载体（与 settle 同义：载体的「活动」就是子代理的一生）。 */
  dispose() {
    return this.settle();
  }

  /** 等待载体收尾（= 子代理结束）。 */
  whenIdle() {
    return this.#settled;
  }

  /**
   * 不驱动任何回合，所以任何窗口都是空闲的——直接执行任务。
   * @param {(signal: AbortSignal) => Promise<unknown>} task 宿主维护任务
   */
  runMaintenance(task) {
    return Promise.resolve(task(new AbortController().signal));
  }

  /**
   * 取消：无操作。子代理归 Claude Code 管（父回合被取消时整条 CLI run 一起停，
   * 子会话由 SubagentSessionManager 收尾），载体没有可中止的活动。
   */
  cancel() {}

  /**
   * 投递输入：忽略。只读投影不接受后续消息——one-shot 子会话的输入框在客户端本就是只读的
   * （`dsh-ui-subagent` 的 selectReadOnlySubagent），通用 queue/cancel 又被 origin:'subagent'
   * 挡在 `session/agent-busy`。
   */
  send() {}

  /** @see send */
  followup() {}

  /** @see send */
  steer() {}

  /** @see send */
  inject() {}
}
