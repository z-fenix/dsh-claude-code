// lib/subagents.mjs — 把 Claude Code 内部子代理（Agent / Task 工具 spawn）映射成独立只读
// DSH 子会话。
//
// 检测以「主轨迹里的 Agent/Task tool_use 块」为权威信号，不依赖 SDK 的 task_started /
// task_notification 生命周期事件（新版 Agent 工具可能根本不发）。每个子代理用其 tool_use 块的
// id 作身份键：SDK 的转发消息（带 parent_tool_use_id）据此归位，父线程的 tool_result 据此收尾。
//
// 只读投影：每个子代理建一个 DSH 子会话（origin:'subagent' + parentSession + delegationDepth
// + subagent/descriptor），复用 ClaudeRunTracer 把转发消息写成子轨迹；UI 经 lineage 树展示。
// 子会话不挂主循环、不可续跑，完成后 detach（仍可读轨迹）。
//
// 两件容易漏掉、漏了就"界面上什么都没有"的事：① 往**父会话**写一条 `subagent/catalog`——
// lineage 树读的 subagentCatalog 是它的投影，不是宿主会话名录；② 用 sessionPersistence 取
// 子会话的写所有权——后端按 session.id 路由 session/event，没有写 handle 的会话一个事件都
// 写不出去（文件也不会生成）。
//
// 第三件：每个子会话还要登记一个**只做状态载体的被动 Agent**（lib/child-agent.mjs）。面板每行的
// 运行状态只来自宿主对子会话的 running 判定，而 running 只可能由注册表里 status==='running' 的
// Agent 产生；不登记的话，正在执行的子代理会显示成「一次性 · 当前未运行」，表头也不出现运行中计数。
// 载体不驱动任何回合，登记/注销与子会话的发布、收尾同生共死；登记失败只记日志（子会话照旧可读）。
//
// 生命周期：spawn 建会话 → 转发消息实时写入 → 收尾。收尾信号取决于前台/后台：
//   前台 Agent：父 tool_result 就是产出 → 到达即收尾；
//   后台 Agent：父 tool_result 只是「异步启动回执」，产出经转发消息到达，收尾靠
//     system/task_notification（本机 CLI 的 Agent 工具默认异步启动，入参里没有
//     run_in_background，权威信号是 task_started.is_backgrounded）。
// run 结束（query() 流关闭）时由 finishRun 把仍未收尾的一并收掉；agent scope 销毁时由
// ctx.effect 兜底闭合。
import { randomUUID } from "node:crypto";
import { diag } from "./router.mjs";
import { ClaudeRunTracer, SUBAGENT_TOOL_NAMES, PROVIDER } from "./claude-run.mjs";
import { readSessionEvents } from "./session-events.mjs";
import { ClaudeChildAgent } from "./child-agent.mjs";
import { subagentDisplay } from "./subagent-label.mjs";

/**
 * `subagent/catalog` 事件的版本号（与 `@deepseek-ai/dsh-subagent` 的
 * SUBAGENT_CATALOG_VERSION 一致）。注意它和 `subagent/descriptor` 的版本号是两个独立的
 * 契约：catalog 写在**父会话**上，descriptor 写在子会话自己身上。
 */
const SUBAGENT_CATALOG_VERSION = 0;

/**
 * `subagent/descriptor` 的版本号（与 @deepseek-ai/dsh-subagent 的
 * SUBAGENT_DESCRIPTOR_VERSION 一致）。
 *
 * 这里自带一份常量、而不是 import dsh-subagent：本插件的子代理追踪是可选功能，
 * 而 dsh-subagent 在加载时会拉进一整串 peer（dsh-tools / dsh-sandbox / dsh-jobs …），
 * 任何一条解析不到都会让**整个插件**加载失败。descriptor 是稳定的持久化契约，
 * 形状只有几个字段，自带一份的代价远小于「可选功能拖垮主功能」。
 */
const SUBAGENT_DESCRIPTOR_VERSION = 3;

/** 一次性子代理的 durable 描述符（字段与顺序对齐 dsh-subagent 的 snapshot 实现）。 */
function snapshotOneShotDescriptor({ provider, label }) {
  return {
    version: SUBAGENT_DESCRIPTOR_VERSION,
    mode: "one-shot",
    provider,
    ...(label === undefined ? {} : { label }),
  };
}

/** 旧 Task 工具的 task_notification 兜底收尾：把状态映射成 turn/end 的 reason。 */
function reasonFor(notification) {
  if (notification.status === "failed") {
    return {
      kind: "error",
      error: { message: notification.summary || "subagent failed", code: "CLAUDE_CODE_SUBAGENT" },
    };
  }
  if (notification.status === "stopped") return { kind: "aborted", reason: { kind: "user" } };
  return { kind: "completed" };
}

/**
 * Agent 工具的 tool_result 是不是「异步启动回执」。
 *
 * 本机 Claude Code 版本里 Agent 工具**默认就异步启动**（入参里根本没有 run_in_background，
 * 见实测），启动时立刻回一条元数据文本，真正的产出稍后作为转发消息到达。把这条回执当成
 * 子代理的产出/结束，会让子会话在拿到任何内容之前就被收尾。
 */
function isAsyncLaunchResult(block) {
  const content = block?.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
      : "";
  return text.includes("Async agent launched successfully");
}

export class SubagentSessionManager {
  #ctx;
  #sessions;
  /** agent 注册表（可选协作者）：缺了只是子代理的运行状态无处上报，不影响子会话本身。 */
  #agents;
  /** 宿主 ctx：载体建作用域/派发事件的基座（原生 agent-loop 用同一个 ctx，见其 createAgent）。 */
  #hostCtx;
  #mainSession;
  #cwd;
  #depth;
  #byToolUseId = new Map();
  #closedToolUseIds = new Set();
  /** task_started 报过 is_backgrounded 的 tool_use id（本机 CLI 默认异步启动，入参里没有标记）。 */
  #backgroundToolUseIds = new Set();
  /** task_id → tool_use_id（task_notification 可能只带其中一个）。 */
  #toolUseIdByTaskId = new Map();
  #teardown = undefined;

  /**
   * @param {object} ctx agent 作用域上下文（用它的 effect 做兜底收尾）
   * @param {object} options
   * @param {object} options.mainSession 主线会话
   * @param {string} [options.cwd] 工作区根目录
   */
  /**
   * @param {object} ctx agent 作用域上下文（用它的 effect 做兜底收尾）
   * @param {object} options
   * @param {object} options.mainSession 主线会话
   * @param {string} [options.cwd] 工作区根目录
   * @param {object} [options.hostCtx] 宿主上下文（载体作用域的基座；缺省退回 agent 作用域）
   */
  constructor(ctx, { mainSession, cwd, hostCtx }) {
    this.#ctx = ctx;
    this.#sessions = ctx.get("sessions");
    this.#agents = ctx.get?.("agents");
    // 载体必须从宿主 ctx 建作用域（不是在 agent 作用域下再嵌一层：那是「非活跃上下文」，
    // 第三方监听器往里 inject 会抛 "cannot create effect on inactive context"）。
    this.#hostCtx = hostCtx ?? ctx;
    this.#mainSession = mainSession;
    this.#cwd = cwd;
    this.#depth = (mainSession.header.delegationDepth ?? 0) + 1;
  }

  /**
   * 处理一条 SDK 消息。
   * @returns {boolean} true 表示该消息已作为子代理消息被消费（主 tracer 不应再处理）
   */
  handleMessage(message) {
    if (message == null || typeof message !== "object") return false;

    if (message.type === "system") {
      switch (message.subtype) {
        // task_* 是子代理的生命周期事件：只消费、不驱动主流程（但 task_started 携带
        // 后台标记与 task_id，是判定「异步启动」的权威信号，必须先记下来）。
        case "task_started":
          this.#onTaskStarted(message);
          return true;
        case "task_progress":
        case "task_updated":
          return true;
        case "task_notification":
          this.#onTaskNotification(message);
          return true;
        default:
          return false;
      }
    }

    // 转发消息：parent_tool_use_id 命中已跟踪子代理 → 归位到子会话。
    if (message.parent_tool_use_id != null) {
      this.#routeForwarded(message);
      return true;
    }

    // 主线程 assistant：Agent/Task 的 tool_use 块 = 子代理诞生（仍交主 tracer 处理）。
    if (message.type === "assistant") {
      this.#onMainAssistant(message);
      return false;
    }

    // 主线程 user：Agent/Task 的 tool_result 块 = 子代理收尾（仍交主 tracer 处理）。
    if (message.type === "user") {
      this.#onMainToolResult(message);
      return false;
    }

    return false;
  }

  /**
   * 本轮 run 结束（SDK 的 query() 流关闭 = CLI 进程已经退出）：闭合所有仍未收尾的子会话。
   *
   * 这里**不区分**前台/后台：流关闭意味着 CLI 已经不在跑，后台子代理也随进程一起没了，
   * 不会再有人送来 task_notification 或转发消息。留一个开着的 turn 只会等 scope 销毁时
   * 才被兜底收掉。
   *
   * @param {object} [options]
   * @param {boolean} [options.aborted] 本轮是否被取消
   */
  finishRun({ aborted = false } = {}) {
    const reason = aborted ? { kind: "aborted", reason: { kind: "user" } } : { kind: "completed" };
    for (const child of this.#children()) {
      if (!child.closed) this.#closeChild(child, reason);
    }
    this.#pruneClosed();
  }

  #onMainAssistant(message) {
    const blocks = Array.isArray(message?.message?.content) ? message.message.content : [];
    for (const block of blocks) {
      if (!block || block.type !== "tool_use") continue;
      if (!SUBAGENT_TOOL_NAMES.has(block.name)) continue;
      if (typeof block.id !== "string" || this.#byToolUseId.has(block.id)) continue;
      const input = block.input ?? {};
      const child = this.#createChild(subagentDisplay(input));
      child.toolUseId = block.id;
      // 后台判定有两条来源：入参的 run_in_background，以及先到的 task_started.is_backgrounded
      // （本机 CLI 默认异步启动时入参里没有这个字段，只有 task_started 说了算）。
      child.background = input.run_in_background === true || this.#backgroundToolUseIds.has(block.id);
      this.#byToolUseId.set(block.id, child);
    }
  }

  #onMainToolResult(message) {
    const blocks = Array.isArray(message?.message?.content) ? message.message.content : [];
    for (const block of blocks) {
      if (!block || block.type !== "tool_result") continue;
      const child = this.#byToolUseId.get(block.tool_use_id);
      if (!child || child.closed) continue;
      // 异步启动的回执不是产出：子代理还在跑，真正的产出随后才转发过来，完成信号是
      // task_notification。在这里收尾会让子会话空着结束（实测故障：界面上拿不到子代理数据）。
      if (isAsyncLaunchResult(block)) {
        child.background = true;
        continue;
      }
      if (child.background) continue;
      this.#closeChild(child, block.is_error === true
        ? {
          kind: "error",
          error: { message: "subagent tool result reported an error", code: "CLAUDE_CODE_SUBAGENT" },
        }
        : { kind: "completed" });
    }
  }

  #routeForwarded(message) {
    if (this.#closedToolUseIds.has(message.parent_tool_use_id)) return; // 已收尾子代理的残留消息
    let child = this.#byToolUseId.get(message.parent_tool_use_id);
    if (!child) {
      // 兜底：转发消息先于 spawn 的 tool_use 到达（或 spawn 检测丢失）时惰性建子会话。
      child = this.#createChild(subagentDisplay({ subagent_type: message.subagent_type }));
      child.toolUseId = message.parent_tool_use_id;
      this.#byToolUseId.set(message.parent_tool_use_id, child);
    }
    child.tracer.handleMessage(message);
  }

  /**
   * task_started：记下后台标记与 task_id ↔ tool_use_id 的对应。
   *
   * 实测这条消息总是先于启动回执到达（顺序：assistant(tool_use) → background_tasks_changed
   * → task_started → user(启动回执)）。tool_use_id 可能缺失，所以两个 id 都留一份映射，
   * 供 task_notification 定位子会话。
   */
  #onTaskStarted(message) {
    if (typeof message.task_id === "string" && typeof message.tool_use_id === "string") {
      this.#toolUseIdByTaskId.set(message.task_id, message.tool_use_id);
    }
    if (message.is_backgrounded !== true || typeof message.tool_use_id !== "string") return;
    this.#backgroundToolUseIds.add(message.tool_use_id);
    const child = this.#byToolUseId.get(message.tool_use_id);
    if (child && !child.closed) child.background = true;
  }

  #onTaskNotification(message) {
    const toolUseId = typeof message.tool_use_id === "string"
      ? message.tool_use_id
      : this.#toolUseIdByTaskId.get(message.task_id);
    const child = this.#byToolUseId.get(toolUseId);
    if (!child || child.closed) return;
    this.#closeChild(child, reasonFor(message));
  }

  #createChild({ label }) {
    this.#ensureTeardown();
    // 显式铸唯一 id，**不能**用 `prepare(undefined)` 让宿主分配：宿主的默认 id 策略是
    // 进程内计数器 `session-${++counter}`（@deepseek-ai/dsh-session 的 SessionStore.create），
    // 它只对 live store 去重，不查已落盘的会话。应用一重启计数器归零，下一个子会话又会拿到
    // session-1，撞上上一轮已落盘的产物 → 持久化后端对已存在的 id 拒绝建记录，这个子代理的
    // 轨迹被静默丢弃（实测：父目录里两个子节点同名、点开都是旧那份）。原生子代理用
    // `SessionId(randomUUID())` 正是为躲开这一点，这里照做。
    const session = this.#sessions.prepare(randomUUID(), {
      meta: {
        parentSession: this.#mainSession.id,
        origin: "subagent",
        delegationDepth: this.#depth,
        ...(this.#cwd ? { cwd: this.#cwd } : {}),
      },
    });
    // 先写轨迹、后发布：enter 之后每个 append 都会被写入后端按 id 路由，此时若还没拿到
    // 写所有权，这些事件就永远丢了（实测故障：子会话目录/文件一个都不落盘）。所以
    // enter/announce 推到 #materialize 里，等写所有权到手、把发布前攒下的事件显式补写
    // 之后再发布——与 dsh-agent-loop 的 createStoredSession → appendUnstoredSuffix →
    // publish 完全同序。
    session.append("subagent/descriptor", snapshotOneShotDescriptor({ provider: PROVIDER, label }));
    // 自动标题必须引用本会话的人类 user/message；只读投影没有该来源，不能伪造输入。
    session.append("turn/start", { turn: 1 });
    const tracer = new ClaudeRunTracer(
      {
        sessionId: session.id,
        append: (type, data, opts) => session.append(type, data, opts),
        requestContext: () => session.requestContext(),
        requestHeader: () => session.requestHeader(),
      },
      1,
    );
    const child = {
      session,
      tracer,
      label,
      toolUseId: undefined,
      background: false,
      closed: false,
      detach: undefined,
      /** 只做状态载体的被动 Agent（登记成功才存在；见 #attachCarrier）。 */
      carrier: undefined,
      /** 写所有权与发布链；收尾/销毁都要先等它，否则会在 handle 就位前把事件发出去。 */
      ready: undefined,
      stored: undefined,
      storedCount: 0,
    };
    // 就地挂上失败处理：这条 Promise 可能直到收尾/销毁才被消费，中间一旦 reject 就是
    // 未处理的 rejection（Node 15+ 默认据此终止进程）。发布失败只影响子会话可见性，
    // 记一条日志继续跑。
    child.ready = this.#materialize(child).catch((error) => {
      this.#ctx.logger?.warn?.(
        `dsh-claude-code: subagent session "${session.id}" could not be published: ${String(error?.message ?? error)}`,
      );
    });
    return child;
  }

  /**
   * 取子会话的写所有权并发布它。
   *
   * 三个动作的顺序是有讲究的（与 `dsh-agent-loop` 的建会话事务一致）：
   * 取 handle → 把发布前攒下的事件补写进 handle → 才 enter/announce。反过来的话，
   * enter 装上发布钩子后写的每个事件都会被后端立刻路由，而那时 handle 还不存在，
   * 事件就此丢失（这正是「子会话不落盘」的成因）。
   */
  async #materialize(child) {
    const { session } = child;
    const persistence = this.#ctx.get?.("sessionPersistence");
    if (persistence === undefined) {
      // 取不到后端时子会话仍然可读（只是不落盘）。这里必须出声：静默降级在外观上与
      // 「子会话不落盘」这个故障完全一样，会让下一次排查从零开始。
      this.#ctx.logger?.warn?.(
        "dsh-claude-code: sessionPersistence is unavailable — subagent sessions will not be written to disk",
      );
    } else {
      try {
        const handle = await persistence.create(session.header, {
          inheritedEventCount: session.inheritedEventCount ?? 0,
        });
        const suffix = readSessionEvents(session).slice(child.storedCount);
        if (suffix.length > 0) await handle.append([...suffix]);
        child.stored = handle;
        child.storedCount += suffix.length;
      } catch (error) {
        // 取不到写所有权只影响落盘，子会话仍可读；不因它中断整轮。
        this.#ctx.logger?.warn?.(
          `dsh-claude-code: could not take write ownership of subagent session "${session.id}": ${String(error?.message ?? error)}`,
        );
      }
    }
    child.detach = this.#sessions.enter(session);
    this.#sessions.announce(session);
    this.#appendCatalog(child);
    await this.#attachCarrier(child);
  }

  /**
   * 给子会话登记一个只做状态载体的被动 Agent，并把它翻到 running。
   *
   * 面板每行的运行状态只来自宿主对子会话的 running 判定，而 running 只可能由注册表里
   * `status === 'running'` 的 Agent 产生（`dsh-api-session-controller` 的 summaryFor 读
   * `agents.get(id)?.status`，`api-session/status` 仅由 `agent/status` 派发）。所以不登记载体，
   * 正在执行的子代理就会被渲染成「一次性 · 当前未运行」。
   *
   * 登记用 `enter` + `await announce`（与本仓 router.mjs 的 publishResilient 同一手法）：
   *   - 先把载体作用域挂进父 agent 的预设组合（见 #joinCarrierComposition），与原生子代理同构；
   *   - `enter` 的 owner 传**父 agent**，让载体成为父所有的子 agent（与原生子代理一致），
   *     而不是一个 root——root 会被 dsh-schedule / dsh-user-questions / dsh-tool-goal 的
   *     root 遍历看见；
   *   - `agent/created` 是 serial 派发，任一第三方监听器抛错都会让通知链断在这里。装了
   *     `@deepseek-ai/dsh-tool-subagent` 的部署就会（实测）：它在重入对账里把**自己正在用的**
   *     inject fiber 拆掉，随后的 `systemPrompt.section(...)` 撞上已释放的 fiber
   *     （`cannot create effect on inactive context`）。这与载体是否合规无关——那只是**附加的
   *     一次广播**，宿主的 running 判定读的是注册表里的 agent 本身，所以这里保留 entry、只记
   *     诊断日志（判据同 router.mjs 的 publishResilient）。
   * @param {object} child 子代理记录
   */
  async #attachCarrier(child) {
    if (this.#agents === undefined) return;
    const carrier = new ClaudeChildAgent(this.#hostCtx, child.session);
    child.carrier = carrier;
    this.#joinCarrierComposition(carrier);
    let detach;
    try {
      const owner = this.#agents.get?.(this.#mainSession.id);
      detach = this.#agents.enter(carrier, owner);
      await this.#agents.announce(carrier, "startup");
    } catch (error) {
      const reason = String(error?.message ?? error);
      if (detach === undefined) {
        // enter 就没成功：什么都没登记，收干净走人（面板维持「当前未运行」，与今天一致）。
        diag(`subagent carrier: enter 失败 child=${child.session.id} — ${reason}`);
        this.#ctx.logger?.warn?.(
          `dsh-claude-code: subagent status carrier for "${child.session.id}" could not be entered: ${reason}`,
        );
        await carrier.settle();
        return;
      }
      // 已进注册表、只少了一次通知——与本仓 router.mjs 的 publishResilient 同一判据：
      // `agent/created` 是 serial 派发，任一第三方监听器抛错都会让通知链断掉；坏的只是那个
      // 附加插件。宿主的 running 判定读的是**注册表里的 agent**（summaryFor 的 agents.get），
      // 不是那次通知，所以这里保留 entry 才有运行状态可言。
      diag(`subagent carrier: 已登记但 agent/created 通知失败 child=${child.session.id} — ${reason}`);
      this.#ctx.logger?.warn?.(
        `dsh-claude-code: subagent status carrier for "${child.session.id}" is registered but its agent/created notification failed: ${reason}`,
      );
    }
    carrier.attach(detach);
    diag(`subagent carrier: 登记完成 child=${child.session.id} closed=${child.closed}`);
    // 收尾跑在发布前面（finishRun 可能先到）时直接 settle：只关掉载体，不闪一次 running。
    if (child.closed) await carrier.settle();
    else carrier.start();
  }

  /**
   * 把载体的作用域挂进**父 agent 所在的预设组合**（原生子代理走的就是这一步：
   * `@deepseek-ai/dsh-subagent` 的 `applyChildComposition` → `agentPresets.composeFrom(childCtx, parent.ctx)`）。
   *
   * 作用域链决定「谁看得见载体的注册」和「谁把载体当自己人」：按 scope 过滤的监听器
   * （例如 `dsh-tool-subagent` 装委派工具时的 `belongsToComposition`）会把链里没有它的 agent
   * 当外来者。载体不驱动模型、注册进它作用域的 prompt 段/工具没人消费，但保持与原生子代理
   * 同构能少一类怪异行为（比如对账时反复把它当外来 agent 摘挂）。
   *
   * 这不是「登记成功的保证」：实测该对账仍会打断载体的 `agent/created` 通知（见 #attachCarrier），
   * 真正兜住运行状态的是那条「保留 entry」的降级判据。
   * @param {object} carrier 载体 agent
   */
  #joinCarrierComposition(carrier) {
    const presets = this.#hostCtx?.get?.("agentPresets") ?? this.#ctx.get?.("agentPresets");
    if (presets?.composeFrom === undefined) return;
    try {
      presets.composeFrom(carrier.ctx, this.#ctx);
      diag(`subagent carrier: 已加入父组合 child=${carrier.id}`);
    } catch (error) {
      diag(`subagent carrier: 加入父组合失败 child=${carrier.id} — ${String(error?.message ?? error)}`);
      this.#ctx.logger?.warn?.(
        `dsh-claude-code: subagent status carrier for "${carrier.id}" could not join its parent's preset composition: ${String(error?.message ?? error)}`,
      );
    }
  }

  /**
   * 向**父会话**写一条 `subagent/catalog` 事实。
   *
   * lineage 树读的 `subagentCatalog` 不是宿主会话名录，而是父会话上 `subagent/catalog`
   * 事件的投影（`@deepseek-ai/dsh-subagent` 的 `subagentCatalogProjectionDefinition`）。
   * 只把子会话塞进 sessions store、不写这条事实，树里就永远没有子节点。
   */
  #appendCatalog(child) {
    try {
      this.#mainSession.append("subagent/catalog", {
        version: SUBAGENT_CATALOG_VERSION,
        childId: child.session.id,
        childCreatedAt: child.session.header.createdAt,
        mode: "one-shot",
        ...(child.label === undefined ? {} : { label: child.label }),
      });
    } catch (error) {
      this.#ctx.logger?.warn?.(
        `dsh-claude-code: could not record subagent "${child.session.id}" in the parent catalog: ${String(error?.message ?? error)}`,
      );
    }
  }

  #closeChild(child, reason) {
    if (child.closed) return;
    child.tracer.finish();
    child.session.append("turn/end", { turn: 1, reason });
    child.closed = true;
    if (typeof child.toolUseId === "string") this.#closedToolUseIds.add(child.toolUseId);
    // 先落盘再 detach：detach 触发 session/disposed，持久化插件据此做最终 flush；
    // 这里显式 flush 保证一次性写入（detach 自身幂等）。等 ready 是因为写所有权可能还在
    // 路上——提前 detach 会让会话在 materialize 之前就离开 store。载体最后收：先落盘、
    // 再上报 idle 并注销，客户端拿到 running=false 时 `subagentTiming.lastTurnCompleted`
    // 已经是 true（面板显示「已完成」而不是「当前未运行」）。
    void child.ready
      .catch(() => undefined)
      .then(() => this.#sessions.flush(child.session))
      .then(() => child.carrier?.settle?.())
      .then(() => child.detach?.(), () => child.detach?.());
    this.#pruneClosed();
  }

  #ensureTeardown() {
    if (this.#teardown !== undefined) return;
    // agent scope 销毁时闭合并释放所有仍未收尾的子会话（含后台），避免开放 turn 泄漏。
    this.#teardown = this.#ctx.effect(() => () => {
      const settle = [];
      for (const child of this.#children()) {
        if (!child.closed) {
          child.tracer.finish();
          child.session.append("turn/end", { turn: 1, reason: { kind: "aborted", reason: { kind: "disposed" } } });
          child.closed = true;
        }
        // 等写所有权与发布链走完再 detach：会话在 materialize 之前离开 store 会让
        // 持久化后端再也拿不到它的事件。载体同样要收，否则 agent 会一直挂在注册表里。
        settle.push(child.ready.catch(() => undefined)
          .then(() => child.carrier?.settle?.())
          .then(() => {
            try {
              child.detach?.();
            } catch {
              // detach 幂等；已 detach 的忽略。
            }
          }));
      }
      this.#byToolUseId.clear();
      this.#closedToolUseIds.clear();
      this.#backgroundToolUseIds.clear();
      this.#toolUseIdByTaskId.clear();
      return Promise.allSettled(settle);
    }, "dsh-claude-code:subagents");
  }

  #children() {
    return [...this.#byToolUseId.values()];
  }

  #pruneClosed() {
    for (const [key, child] of this.#byToolUseId) {
      if (child.closed) this.#byToolUseId.delete(key);
    }
  }
}
