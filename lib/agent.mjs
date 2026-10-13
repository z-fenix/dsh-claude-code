// lib/agent.mjs — 自定义 Agent：把 DSH 会话的主循环交给 Claude Code。
//
// 实现 @deepseek-ai/dsh-agent 的 Agent 接口（inbox / status / cancel / whenIdle / runMaintenance
// / ctx / session），驱动换成「每轮跑一次 Claude Code」。刻意不实现模型选择、压缩、重试、
// 工具调度——这些都属于 DSH 原生循环，Claude Code 自带。
import { agentEvents } from "@deepseek-ai/dsh-agent";
import { randomUUID } from "node:crypto";
import { RunInputLedger } from "./run-input.mjs";
import { pluginFacts } from "./plugin-facts.mjs";
import { createScope } from "@deepseek-ai/dsh-scope";
import { DshInbox } from "./inbox.mjs";
import { SubagentSessionManager } from "./subagents.mjs";
import { runClaudeCode } from "./claude-run.mjs";
import { buildPrompt } from "./attachments.mjs";
import { resolveClaude } from "./auth.mjs";
import { load as loadClaudeSessionId, save as saveClaudeSessionId } from "./store.mjs";
import { lastTurnOf, readSessionEvents } from "./session-events.mjs";

/** 把一条 DSH 用户消息的文本内容拼起来（多块时以换行分隔）——见 lib/attachments.mjs。 */

export class ClaudeCodeAgent {
  /**
   * @param {object} loopCtx 宿主上下文（用于取服务、派发 agent 事件）
   * @param {string} id 会话 / agent 身份
   * @param {object} options AgentOptions（provider / model / …，Claude 侧不直接使用）
   * @param {object} session DSH 会话
   * @param {object} pluginConfig 引擎配置（见 index.mjs 的 Config.engine）
   */
  constructor(loopCtx, id, options, session, pluginConfig) {
    this.loopCtx = loopCtx;
    this.id = id;
    this.options = options ?? {};
    this.session = session;
    this.config = pluginConfig;
    this.dispatch = agentEvents(loopCtx, this);
    this.facts = pluginFacts(session);
    this.inbox = new DshInbox(session, this.dispatch);
    this.phase = { kind: "idle", lastTurn: lastTurnOf(readSessionEvents(session)) };
    // scope 的 key 用 agent 自身：dsh-agent 的 agentCarrier(agent) 也这么做，
    // 两侧取到的 scope 必须一致，预设挂载与事件派发才落在同一个 scope 上。
    this.scope = createScope(loopCtx, this);
    this.ctx = this.scope.ctx;
    this.activityDone = Promise.resolve();
    /** 跨轮复用：本 DSH 会话对应的 Claude Code 会话 id（首轮捕获，之后续接）。 */
    this.claudeSessionId = undefined;
    /** 子代理追踪：把 Claude Code 内部子代理映射成独立 DSH 子会话（跨轮存活）。 */
    this.subagents = pluginConfig.traceSubagents !== false
      ? new SubagentSessionManager(this.ctx, {
        mainSession: session,
        cwd: session.header.cwd,
        // 状态载体的作用域必须**和主 agent 一样**从宿主 ctx 建（原生 agent-loop 也是这么做的），
        // 而不是嵌在本 agent 的 scope 之下：嵌进去的 scope 是「非活跃上下文」，第三方
        // agent/created 监听器往它里面 inject（dsh-tool-subagent / dsh-file-reference-local）会
        // 直接抛 "cannot create effect on inactive context"，整条载体登记失败。
        hostCtx: this.loopCtx,
      })
      : null;
    /** 需要恢复的 Claude 会话 id（resume 路径由引擎写入）。 */
    this.pendingResume = undefined;
    /** 当前回合的 claimed 消息（供 goal 桥接工具做权限判定）；回合收尾后清空。 */
    this.currentTurn = undefined;
    this.activeInput = undefined;
    this.steers = this.inbox.steers;
  }

  get status() {
    return this.phase.kind === "idle" || this.phase.kind === "maintenance" ? "idle" : "running";
  }

  /** 切换内部阶段；status 变化时对外发一次通知。 */
  setPhase(next) {
    const previous = this.status;
    this.phase = next;
    const status = this.status;
    if (status !== previous) this.dispatch.emit("agent/status", { status });
  }

  /**
   * 投递一条消息。
   * @param {object} message 用户消息
   * @param {'next-turn'|'next-step'} target 队列
   * @param {boolean} wakeup 是否立即唤醒驱动
   */
  send(message, target, wakeup) {
    const wakingAfterAbort = wakeup && this.phase.kind !== "idle" && this.phase.abort?.signal.aborted;
    const actualTarget = wakingAfterAbort ? "next-turn" : target;
    this.inbox.enqueue(actualTarget, message, wakeup);
    if (actualTarget === "next-step") {
      if (this.activeInput) this.flushInput(this.activeInput);
    }
    if (wakeup) this.wakeDriver(wakingAfterAbort);
  }

  /** 排一个独立的新回合。 */
  followup(message) {
    this.send(message, "next-turn", true);
  }

  /** 插入到下一个 step 边界（会唤醒驱动）。 */
  steer(message) {
    this.send(message, "next-step", true);
  }

  /** 插入到下一个 step 边界（不唤醒驱动）。 */
  inject(message) {
    this.send(message, "next-step", false);
  }

  /**
   * 取消当前工作。
   * @param {object} cause AgentCancelCause
   * @param {{keepInbox?: boolean}} [options]
   */
  cancel(cause, options = {}) {
    if (!options.keepInbox) {
      this.inbox.clear();
      if (this.phase.kind !== "idle") this.phase.wakeRequested = false;
    }
    if (this.phase.kind !== "idle") {
      this.phase.keepInbox = options.keepInbox === true;
      this.phase.abort.abort(cause);
    }
  }

  /** 等待当前驱动 / 维护任务结束。 */
  whenIdle() {
    return this.activityDone;
  }

  /**
   * 跑一个非回合任务（DSH 用这个窗口做「创建 / resume 事务」）。
   * @throws 已有活动工作时同步抛出（上层据此判断 agent 忙）
   */
  runMaintenance(job) {
    if (this.phase.kind !== "idle") throw new Error(`agent "${this.id}" already has active work`);
    const done = Promise.withResolvers();
    const maintenance = {
      kind: "maintenance",
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    };
    this.setPhase(maintenance);
    this.activityDone = done.promise;
    return (async () => {
      try {
        return await job(maintenance.abort.signal);
      } finally {
        this.setPhase({ kind: "idle", lastTurn: maintenance.lastTurn });
        if (maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver();
        done.resolve();
      }
    })();
  }

  /** 释放 agent：停掉驱动、拆掉 scope。 */
  async dispose() {
    try {
      this.cancel({ kind: "disposed" }, { keepInbox: true });
    } catch {
      // 已空闲 / 已取消
    }
    await this.whenIdle();
    try { await this.scope.dispose(); }
    finally { this.facts.close(); }
  }

  /** 唤醒驱动（已在跑就只记一个「跑完再来一轮」的请求）。 */
  wakeDriver(wakeAfterAbort = false) {
    if (this.phase.kind !== "idle") {
      if (this.phase.abort?.signal.reason?.kind !== "disposed"
        && (this.phase.kind === "maintenance" || wakeAfterAbort)) {
        this.phase.wakeRequested = true;
      }
      return;
    }
    const driver = Promise.withResolvers();
    this.activityDone = driver.promise;
    this.setPhase({
      kind: "running",
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      wakeRequested: false,
    });
    this.drive().then(() => driver.resolve(), (error) => {
      this.dispatch.emit("agent/error", { turn: this.phase.turn ?? 0, step: 0, error });
      driver.resolve();
    });
  }

  /** 活查询的 next-step 输入由一个串行 lane 准备；next-turn 永不在这里取走。 */
  flushInput(active) {
    if (active.flushing || !active.accepting) return;
    active.flushing = (async () => {
      while (this.activeInput === active && !active.phase.abort.signal.aborted && this.inbox.nextStep.length > 0) {
        const messages = this.inbox.peek("next-step");
        await active.controller.submit(messages, { shouldQuery: messages.some((message) => this.steers.has(message.id)) });
      }
    })().catch((error) => {
      active.accepting = false;
      if (!active.phase.abort.signal.aborted && !/closed|stopping/.test(String(error?.message))) {
        this.dispatch.emit("agent/error", { turn: active.turn, step: 0, error });
      }
    }).finally(() => {
      active.flushing = undefined;
      if (this.activeInput === active && active.accepting && !active.phase.abort.signal.aborted && this.inbox.nextStep.length > 0) {
        this.flushInput(active);
      }
    });
  }

  /** 主驱动：普通输入建立回合；steer 可唤醒独立回合，inject 单独不会。 */
  async drive() {
    const phase = this.phase;
    try {
      while ((this.inbox.nextTurn.length > 0 || this.inbox.nextStep.some((message) => this.steers.has(message.id)))
        && !phase.abort.signal.aborted) {
        const target = this.inbox.nextTurn.length > 0 ? "next-turn" : "next-step";
        const messages = this.inbox.peek(target);
        let stopAfterTurn = false;
        const { prompt, images, dropped } = await buildPrompt(this.loopCtx, messages, phase.abort.signal);
        const cwd = this.session.header.cwd;
        const { executable, env } = await this.loopCtx.agents.withInitiator(this, () => resolveClaude({
          ctx: this.loopCtx, config: this.config, signal: phase.abort.signal,
        }));
        if (phase.abort.signal.aborted) break;
        const turn = phase.turn + 1;
        if (!messages.every((message) => this.inbox.nextStep.includes(message) || this.inbox.nextTurn.includes(message))) continue;
        const inputEpoch = randomUUID();
        const ledger = new RunInputLedger(this.session, inputEpoch);
        for (const message of messages) {
          if (typeof message.id === "string") ledger.record(message.id, "reserved", {
            message, ...this.inbox.placement(message), shouldQuery: true,
          });
        }
        if (this.inbox.consume(messages, turn).length !== messages.length) continue;
        phase.turn = turn;
        for (const message of messages) this.steers.delete(message.id);
        this.currentTurn = { turn, messages: [...messages] };
        const currentTurn = this.currentTurn;
        let turnStarted = false;
        try {
          this.session.append("turn/start", { turn });
          turnStarted = true;
          for (const message of messages) this.session.append("user/message", message, { surfaceOp: "append" });
          if (images > 0 || dropped > 0) {
            this.loopCtx.logger?.info?.(
              `dsh-claude-code: turn ${turn} prompt carries ${images} image(s)${dropped > 0 ? `, ${dropped} could not be attached` : ""}`,
            );
          }
          await this.loopCtx.agents.withInitiator(this, async () => {
            const resumeSessionId = this.claudeSessionId ?? this.pendingResume;
            this.pendingResume = undefined;
            const result = await runClaudeCode({
              ctx: this.loopCtx,
              config: this.config,
              session: this.session,
              // agent 传入供审批桥（canUseTool → userQuestions.ask）携带 agent 归属，
              // 否则 web provider 因「非 agent-owned session」拒绝弹窗。
              agent: this,
              // 当前回合上下文（人类直接回合 / goal round）——goal 桥接工具据此做权限判定。
              turnContext: () => this.currentTurnContext(),
              turn,
              prompt,
              initialMessages: messages,
              inputEpoch,
              inputPlacement: (batch) => batch.map((message) => this.inbox.placement(message)),
              onReady: (controller) => {
                if (this.phase !== phase || this.currentTurn !== currentTurn || phase.abort.signal.aborted) { controller.close(); return; }
                const active = { controller, phase, turn, accepting: true };
                this.activeInput = active;
                this.flushInput(active);
              },
              canSubmitInput: (batch) => this.currentTurn === currentTurn && this.phase === phase
                && batch.every((message) => this.inbox.nextStep.includes(message)),
              onInputSubmitted: (batch) => {
                if (this.currentTurn !== currentTurn || phase.abort.signal.aborted) throw new Error("input is stopping");
                if (this.inbox.consume(batch, turn).length !== batch.length) throw new Error("input snapshot changed");
                for (const message of batch) {
                  this.session.append("user/message", message, { surfaceOp: "append" });
                  this.steers.delete(message.id);
                }
              },
              onInputConsumed: (batch) => {
                if (this.phase === phase && this.currentTurn === currentTurn) currentTurn.messages.push(...batch);
              },
              signal: phase.abort.signal,
              cwd,
              executable,
              env,
              resumeSessionId,
              emitStream: (frame) => this.dispatch.emit("agent/assistant-stream", { frame }),
              subagents: this.subagents,
            });
            if (result.initialSubmitted === false && (result.stopReason === "error" || phase.keepInbox)) stopAfterTurn = true;
            if (result.claudeSessionId) {
              this.claudeSessionId = result.claudeSessionId;
              // 跨进程持久化，供 resume 精确续接同一 Claude 会话（失败静默）。
              void saveClaudeSessionId(this.id, result.claudeSessionId);
            }
            // 本轮若被写入口拒绝过某条 append（logIntact === false），**不能**再补 turn/end：
            // 日志会停在「开着的 step」，DSH 的格式校验据此判定整条会话损坏
            // （SessionFormatError: turn/end does not match the open turn with no open step
            //  → 历史加载失败 / resume failed … is corrupt，会话永久打不开）。
            // turn 停在「开着」是格式允许的收尾状态（tracer 已把 step 关掉）。
            if (result.logIntact === false) {
              stopAfterTurn = true;
              this.loopCtx.logger?.warn?.(
                `dsh-claude-code: turn ${turn} was left open — a session append was rejected mid-turn, so no turn/end was written and the stored log stays loadable`,
              );
            } else {
              // 原生 dsh-agent-loop 在 append turn/end **之前** serial 派发 agent/turn-stopping
              // （见 dsh-agent-loop 的 runTurn）：宿主侧监听器（如 dsh-workspace-changes 的
              // 轮内记录器）要等它完成才落盘。必须遵守同一契约——否则 workspace/changes 事件
              // 落在 turn/end 之后，客户端的改动文件卡片要等下一轮 turn/start 才渲染，
              // 表现为「每轮结束后的文件变更延迟到下一次发消息才显示」。
              await this.dispatch.serial("agent/turn-stopping", { turn, signal: phase.abort.signal });
              this.session.append("turn/end", { turn, reason: this.#endReason(result) });
            }
          });
        } catch (error) {
          stopAfterTurn = true;
          if (!turnStarted) throw error;
          this.dispatch.emit("agent/error", { turn, step: 0, error });
          // turn/start 之后的任何失败都走这里。补 turn/end 本身也可能被写入口拒绝，
          // 拒绝时**不要**让异常穿出去：日志停在开着的 turn 仍是合法状态。
          try {
            this.session.append("turn/end", {
              turn,
              reason: {
                kind: "error",
                error: { message: String(error?.message ?? error), code: "UNKNOWN" },
              },
            });
          } catch (appendError) {
            this.loopCtx.logger?.warn?.(
              `dsh-claude-code: could not close turn ${turn} (${String(appendError?.message ?? appendError)}); leaving it open so the stored log stays loadable`,
            );
          }
        } finally {
          this.activeInput = undefined;
          this.currentTurn = undefined;
        }
        if (stopAfterTurn) break;
      }
    } finally {
      // 兜底清空：turn/start、user/message 循环或 buildPrompt 在进入内层 try 之前就抛错时，
      // 内层 finally 还没接上，currentTurn 会一直残留到下一轮。这里兜底保证回合结束即清空。
      this.activeInput = undefined;
      this.currentTurn = undefined;
      try { this.inbox.recover(); }
      catch (error) { this.loopCtx.logger?.warn?.(`dsh-claude-code: unsubmitted reservations remain recoverable (${String(error?.message ?? error)})`); }
      this.setPhase({ kind: "idle", lastTurn: phase.lastTurn ?? phase.turn ?? 0 });
      // 取消收尾（keepInbox）后仍留在队列里的人类输入要自己接上：宿主传入 keepInbox 的语义是
      // 「停止当前生成、保留待办」，而保留的待办若无人唤醒就永远停在队列里——界面上表现为
      // 「消息发出去了但没进会话」，且此时 agent 已 idle，「插入」会被宿主以
      // session/steer-unavailable（current turn no longer accepts steering）拒绝。
      // 只对能自己成回合的输入放行（排队回合或带 querying 意图的 steer）；纯 inject 仍不建回合。
      const resumable = phase.keepInbox === true
        && (this.inbox.nextTurn.length > 0 || this.inbox.nextStep.some((message) => this.steers.has(message.id)));
      if ((phase.wakeRequested || resumable)
        && phase.abort.signal.reason?.kind !== "disposed" && this.inbox.hasPending) this.wakeDriver();
    }
  }

  /**
   * 当前回合上下文，供 goal 桥接工具判定「人类直接回合」与「goal round」。
   * @returns {{ hasHumanMessage: boolean, goalSource?: object }}
   */
  currentTurnContext() {
    const messages = this.currentTurn?.messages ?? [];
    let hasHumanMessage = false;
    let goalSource;
    for (const message of messages) {
      const source = message?.source;
      if (source?.kind === "user") hasHumanMessage = true;
      else if (source?.kind === "goal" && goalSource === undefined) goalSource = source;
    }
    return { hasHumanMessage, goalSource };
  }

  #endReason(result) {
    if (result.stopReason === "aborted") return { kind: "aborted", reason: { kind: "user" } };
    if (result.stopReason === "error") {
      const text = (result.output ?? []).map((block) => block.text ?? "").join(" ");
      return {
        kind: "error",
        error: { message: text || "Claude Code run failed", code: "CLAUDE_CODE_ERROR" },
      };
    }
    return { kind: "completed" };
  }
}

/** 读某个 DSH 会话上次捕获的 Claude 会话 id（resume 精确续接用）。 */
export { loadClaudeSessionId };
