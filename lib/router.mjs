// lib/router.mjs — 预设 → 引擎路由工厂：接管 `ctx.agents` 的 agent factory 槽位。
//
// 为什么是「接管槽位」而不是 `ctx.agents.setFactory()`：setFactory 在已有工厂时**抛错**
// （'an agent factory is already registered'），而后加载的插件必然晚于 dsh-base 的 agent-loop 行。
// 槽位本身是一个普通字段（`{ target: factory }`），直接替换它、并在本插件 fiber 释放时换回
// 原工厂，是引擎类插件唯一的接管方式。见 docs/overview/architecture.md。
//
// 三条路径：
//   createAgent —— 按创建时的预设（options.meta.agentPreset）路由：命中本插件引擎就自己
//                  造会话 + Agent，否则走「包装过的原生路径」（仍是 ReactLoopAgent，但由本
//                  路由持有句柄，这样空白会话内切预设时能原地换 Agent 而不惊动会话）。
//   resume      —— 先读持久化日志反推当前预设（空白期切过预设的会话必须按日志而不是
//                  header 判断），命中本插件引擎就自己恢复，否则委托回原工厂。
//   swap        —— DSH 只允许空白会话内切预设。切换时原地换 Agent：会话留在 store 里不动，
//                  只把驱动它的 Agent 换掉，避免 session/disposed → session/created 让客户端
//                  把会话标记成 removed 并锁死输入框。
//
// 「原地换 Agent」的关键是会话的 detach 闭包：原生 AgentLoop 的 prepared 对象与它自己的
// ownership 绑死，拿不到「只拆 agent、不拆会话」的能力。因此这里自己 publish（顺序与原生
// 完全一致：sessions.enter → agents.enter → sessions.announce → agents.announce），把
// detach 闭包握在本路由手里（SessionLease）。
import { SessionPreparation } from "@deepseek-ai/dsh-session";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEEPSEEK_ENGINE_ID } from "./registry.mjs";
import { readSessionEvents } from "./session-events.mjs";

/**
 * 诊断日志：宿主只把 warn/error 转 stderr，插件的 info 日志看不到，
 * 所以把路由关键决策写进文件，便于在隔离实例里直接读。
 * 写入失败一律忽略——诊断绝不能影响主流程。
 * @param {string} message 一行诊断文本
 */
export function diag(message) {
  try {
    const dir = join(homedir(), ".dsh", "dsh-claude-code");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "router-diag.log"), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // 忽略
  }
}

/**
 * 读持久化日志里记录的当前预设（最后一条 `agent-preset/selected` 胜出，其次 header）。
 * @param {object} header 持久化读回的会话 header
 * @param {readonly object[]} events 持久化读回的事件
 * @returns {string|undefined}
 */
export function presetFromLog(header, events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "agent-preset/selected") return event.data.agentPreset;
  }
  return header?.agentPreset;
}

/** 一次会话进入 session store 的所有权；可以被换 Agent 的操作「接管」。 */
class SessionLease {
  #detach;
  #consumed = false;

  constructor(detach) {
    this.#detach = detach;
  }

  /** 交出会话所有权给下一个 Agent（原持有者从此不再拆会话）。 */
  take() {
    const detach = this.#detach;
    this.#detach = undefined;
    this.#consumed = true;
    return detach;
  }

  get consumed() {
    return this.#consumed;
  }

  /** 释放：仅在所有权仍在本 lease 手上时才真正拆会话。 */
  release() {
    if (this.#consumed) return;
    const detach = this.#detach;
    this.#detach = undefined;
    this.#consumed = true;
    try {
      detach?.();
    } catch {
      // detach 幂等；已拆过的忽略
    }
  }
}

export class EngineRouter {
  /** sessionId → 排队中的切换 Promise：串行化 swap，避免连点预设互踩。 */
  #switches = new Map();
  /** sessionId → 本路由当前持有的句柄（换 Agent 时用来原拆原换）。 */
  #handles = new Map();
  /** sessionId → { ownerCtx, options }：换 Agent 需要复用的创建参数。 */
  #records = new Map();
  /** sessionId → 进行中的 resume Promise：同一个会话并发 resume 时共享结果（见 resume()）。 */
  #resumes = new Map();

  /**
   * @param {object} ctx 宿主上下文（dsh-base 的顶层上下文）
   * @param {object} config 插件配置
   * @param {object} [original] 原 agent factory（通常是 AgentLoop 实例）；省略时延迟解析
   * @param {object} registry EngineRegistry
   */
  constructor(ctx, config, original, registry) {
    this.loopCtx = ctx;
    this.config = config;
    /** 原工厂：先记住传入值，未传入时第一次用到再从槽位解析（见 #resolveOriginal）。 */
    this.original = original;
    this.registry = registry;
    ctx.on("agent-preset/selected", (sessionId, agentPreset) => {
      this.#enqueueSwitch(sessionId, agentPreset);
    });
  }

  /**
   * 把本路由接到 `ctx.agents.factory` 槽位上（**接管主循环的唯一正确姿势**）。
   *
   * 两条互相牵制的约束，缺一不可：
   *
   * **约束一：绝不能抢在 `@deepseek-ai/dsh-agent-loop` 之前占位。**
   * 那一行是 **required**，它在自己的构造函数里调 `ctx.agents.setFactory(this)`，而
   * `setFactory` 是 effect-scoped、**先到先得**：已有工厂就抛
   * `an agent factory is already registered`。被本插件抢了，该行激活失败 → 宿主启动失败
   * → 触发 DSH 的 profile 恢复（重写用户 cordis.patch.yml、清空 node_modules）。
   * 这就是「装了插件就没法用、只能清配置」的根因。
   *
   * **约束二：也绝不能只等 `internal/service` 事件。**
   * 本插件 `inject: ["agents", …]`，apply() 必然在 agents 服务就绪**之后**才跑，
   * 而该事件在服务实现变化时就已发过。只挂事件监听，监听器永远收不到，attached 恒为 false，
   * 所有会话照旧走原生工厂（实测现象：17 个 claude-code 会话没有一个 provider 是 claude-code）。
   *
   * 因此顺序是「**先立即试一次，再退化为等事件**」：
   *   1. apply() 当下就检查槽位：里面已有 agent-loop 的工厂 → 立刻包住它（正常路径）；
   *   2. 槽位当时还是空的（本行确实比 agent-loop 早）→ 不占位，挂 `internal/service`
   *      等它注册，收到通知再包住。
   *
   * @param {object} args
   * @param {object} args.agents 宿主 agents 服务（ctx.agents）
   * @param {object} args.ctx 宿主上下文（用于 ctx.on / ctx.effect）
   * @param {(inner: object) => void} [args.onInner] 解析到原工厂时的通知（用于日志）
   * @returns {{router: object, attached: boolean, detach: () => Promise<void>}} 接管结果
   */
  static attach({ agents, ctx, config, registry, onInner }) {
    const logger = ctx.logger;
    const router = new EngineRouter(ctx, config, agents.factory?.target, registry);

    let attached = false;
    let detachFactory;
    /** 接管前的工厂引用：释放时原样放回。 */
    let prior;

    const takeOver = (inner) => {
      if (attached || inner === undefined || inner === router) return false;

      if (agents.factory === undefined) {
        // 槽位为空：用官方入口注册（effect-scoped，释放时自动清空槽位）。
        try {
          detachFactory = agents.setFactory(router);
        } catch (error) {
          logger?.warn?.(`dsh-claude-code: could not register the routing factory: ${String(error?.message ?? error)}`);
          return false;
        }
      } else {
        // 槽位里已经是别人的工厂（正常情况：required 的 agent-loop 行先注册了）。
        //
        // 这里**不能**调 setFactory：它先到先得，槽位非空必抛
        // `an agent factory is already registered`。而我们绝不能抢在 agent-loop 之前注册
        // ——那会让那个 required 行激活失败 → 宿主启动失败 → DSH profile 恢复
        // （重写用户 cordis.patch.yml、清空 node_modules）。那是「装了插件就只能清配置」的根因。
        prior = inner;
        agents.factory = { target: router };
      }
      router.original = inner;
      attached = true;
      onInner?.(inner);
      return true;
    };

    // ① 先立即试一次。这一步是**必需的**，不是优化：
    //    本插件 `inject: ["agents", …]`，所以 apply() 必然在 agents 服务就绪之后才跑，
    //    而 cordis 的 `internal/service` 事件在服务实现变化时就已发过——只依赖那个事件，
    //    监听器永远等不到，attached 会恒为 false，于是所有会话照旧走原生工厂
    //    （实测现象：17 个 claude-code 会话没有一个 provider 是 claude-code）。
    //    apply() 时槽位里通常已经有 agent-loop 注册好的工厂，所以这一步一般就能接管成功。
    takeOver(agents.factory?.target);

    // ② 还没接管，说明 apply() 那一刻槽位是空的（本行比 agent-loop 先激活）。
    //
    //    这时**不能**只等 name === "agents" 的那一条 `internal/service`：`agents` 服务
    //    （dsh-agent 的注册表）就在本插件 inject 的门槛上，那条通知早在 apply() 之前发过了，
    //    永远等不到。实测（隔离实例 + routeMainLoop: true + 上面的 ①）：apply() 时槽位为空，
    //    attached 恒为 false，所有会话照旧走原生工厂。
    //
    //    apply() 时槽位为什么会空：agent-loop 的 inject 面比本插件宽得多
    //    （agents / sessions / llm / tools / systemPrompt / sessionProjections），
    //    它的 fiber 常常晚于本插件激活——槽位是它激活时才填上的。
    //
    //    真正会响的是**它激活那一轮**的两条通知，都在它 `setFactory` 之后：
    //      · fiber 进入 ACTIVE 时，cordis 会为它提供的服务补发 `internal/service`
    //        （AgentLoop 自己就是 `agentLoop` 服务，所以这条通知的名字不是 "agents"）；
    //      · 同一处（fiber._updateState）还会发 `internal/status`。
    //    因此这里改成「任何服务事件、任何 fiber 状态变化都再试一次」，并加一层启动后的
    //    有上限短重试兜底——不把成败押在某一条事件的名字或时序上。
    //
    //    takeOver 幂等，且槽位为空时只返回 false、绝不自己占位，
    //    所以「等 agent-loop 先注册、绝不抢位」这条约束不变。
    if (!attached) {
      const retry = () => {
        if (!attached) takeOver(agents.factory?.target);
      };
      ctx.on("internal/service", retry, { global: true });
      ctx.on("internal/status", retry, { global: true });
      // 兜底：启动头两秒按延时重试几次。effect-scoped，插件释放时自动清掉，
      // 不会在卸载之后又把槽位接管回来。
      ctx.effect(() => {
        const timers = [0, 25, 100, 400, 1500].map((ms) => setTimeout(retry, ms));
        return () => {
          for (const timer of timers) clearTimeout(timer);
        };
      }, "dsh-claude-code: attach retry");
    }

    return {
      router,
      get attached() {
        return attached;
      },
      /** 释放：先把槽位交还原工厂，再停掉本路由持有的 agent。 */
      detach: async () => {
        if (attached) {
          attached = false;
          try {
            detachFactory?.();
          } catch {
            // 已释放的 effect 再调一次会抛，忽略
          }
          // 非 setFactory 路径（槽位接管）：把原工厂放回去，别留下没有工厂的 agents 服务。
          if (detachFactory === undefined && prior !== undefined && agents.factory?.target === router) {
            agents.factory = { target: prior };
          }
        }
        await router.drain();
      },
    };
  }

  /**
   * 解析原工厂（原生主循环的 AgentFactory）。
   *
   * 延迟解析的原因见 index.mjs 的 apply()：插件加载阶段拿不到工厂是纯时序问题，
   * 那时抛错会让宿主启动失败，而启动失败会触发 DSH 的 profile 恢复（重写用户配置、
   * 清掉 node_modules），代价远大于本插件。所以这里才在「真正要造会话」时解析，
   * 拿不到才抛错——错误发生在该发生的地方。
   *
   * @returns {object} AgentLoop 实例
   * @throws 槽位里既没有本路由、也没有别的工厂时抛出
   */
  #resolveOriginal() {
    if (this.original !== undefined) return this.original;
    const current = this.loopCtx.agents?.factory?.target;
    if (current !== undefined && current !== this) {
      this.original = current;
      return current;
    }
    throw new Error(
      "dsh-claude-code: no agent factory to delegate to — the native agent-loop row (@deepseek-ai/dsh-agent-loop) is not loaded",
    );
  }

  /**
   * 本路由当前持有的句柄表（只读视图）。
   *
   * 原生会话**不在**这张表里：它们整条委托回原工厂，本路由不持有任何句柄。
   * 这也是「切换预设时本路由只动自己的会话」的判据。
   */
  get handles() {
    return this.#handles;
  }

  /** 本路由为「换 Agent」保留的创建参数表（只读视图）；原生会话不登记。 */
  get records() {
    return this.#records;
  }

  /** 进行中的 resume 表（只读视图）：用于验证并发去重。 */
  get resumes() {
    return this.#resumes;
  }

  /** 预设 id → 引擎 id：显式覆盖表 > 引擎自带预设（id 即引擎 id）> 默认引擎。 */
  engineIdFor(presetId) {
    if (typeof presetId !== "string" || presetId === "") return this.config.defaultEngine;
    const map = this.config.engineByPreset ?? {};
    if (Object.hasOwn(map, presetId)) return map[presetId];
    if (this.registry.get(presetId) !== undefined) return presetId;
    return this.config.defaultEngine;
  }

  /** 引擎 id → 已注册引擎；deepseek / 空 / 未注册都返回 null（表示走原生循环）。 */
  resolveEngine(engineId) {
    if (engineId === DEEPSEEK_ENGINE_ID || engineId == null || engineId === "") return null;
    return this.registry.get(engineId) ?? null;
  }

  /** 引擎私有配置（插件不解析、不校验，原样交给引擎）。 */
  engineConfig(engineId) {
    return (this.config.engines ?? {})[engineId] ?? {};
  }

  #dbg(...args) {
    this.loopCtx.logger?.debug?.(...args);
  }

  // ── 工厂契约 ────────────────────────────────────────────────────────────
  /**
   * 造一个新 agent。
   *
   * 分工是刻意不对称的：**只有本插件引擎的会话由本路由自己造**，其余一律整条委托回原工厂。
   *
   * 原工厂（`@deepseek-ai/dsh-agent-loop`）的建会话链路远不止「prepare + publish」：
   * `ownership.trackWrapper` → `setupAndPublish`（`raceAbort(options.setup)` +
   * `interruptedTurnClosers` + `appendUnstoredSuffix`）→ `raceAbortCall` → owner/ownership
   * 融合信号与失败回滚，每一步都参与它的生命周期记账。复刻其中一段来「保住会话 detach 闭包」
   * 会把原生会话整条换成残缺实现 —— 实测结果就是：会话文件建好、header 写入，
   * 之后再无任何事件，会话既打不开也发不出消息。
   *
   * 因此原生会话不再接管。代价是原生会话不能「原地换 Agent」（见 #onPresetSelected 的说明），
   * 换来的是所有既有会话与非本插件预设完全不受影响。
   *
   * @param {object} ownerCtx 调用方上下文（结构性拥有这次生命周期）
   * @param {object} options CreateAgentOptions
   */
  async createAgent(ownerCtx, options) {
    diag(`createAgent: sessionId=${String(options?.sessionId)} preset=${JSON.stringify(options?.meta?.agentPreset)} hasSetup=${typeof options?.setup === "function"} parentAgent=${options?.parentAgent !== undefined} origin=${JSON.stringify(options?.meta?.origin)}`);
    // 子代理会话始终走原生循环（DeepSeek），与顶层路由无关。
    if (options?.meta?.origin === "subagent" || options?.parentAgent !== undefined) {
      return this.#resolveOriginal().createAgent(ownerCtx, options);
    }
    const engineId = this.engineIdFor(options?.meta?.agentPreset);
    const engine = this.resolveEngine(engineId);
    diag(`createAgent: resolved engineId=${engineId} engine=${engine === null ? "null(原生)" : engine.id}`);
    if (engine === null) {
      // 原生会话：整条交回原工厂，连句柄都不持有（不记录 record，切换预设时本路由也不会介入）。
      this.#dbg("dsh-claude-code: createAgent delegates to the native loop", String(options?.sessionId));
      return await this.#resolveOriginal().createAgent(ownerCtx, options);
    }
    this.#records.set(options.sessionId, { ownerCtx, options });
    const handle = await this.#createWithEngine(ownerCtx, options, engine);
    this.#handles.set(options.sessionId, handle);
    return handle;
  }

  /**
   * 恢复一个已持久化的会话。
   * @param {object} ownerCtx 调用方上下文
   * @param {object} options ResumeAgentOptions
   */
  async resume(ownerCtx, options) {
    const id = options.resumeSessionId;
    const live = this.#handles.get(id);
    // 幂等守卫：会话已经 live（例如空白会话内刚 swap 完）时直接复用句柄，
    // 不再走持久化 open——否则撞「会话已经 live」。
    if (live !== undefined && this.loopCtx.sessions?.get(id) !== undefined) {
      this.#dbg("dsh-claude-code: resume reuses live handle", id);
      return live;
    }

    // 并发去重（实测踩过）：守卫读的是「此刻是否 live」，而它与后面的
    // `this.loopCtx.sessions.prepare(id, …)` 之间隔着多个 await。客户端重试 / 重连会并发
    // 发起同一个会话的 resume，两次都通过守卫，第二次在 prepare 时抛
    //   Error: session "<id>" already exists
    // （@deepseek-ai/dsh-session 的 SessionStore.prepare：store 里已有该 id 即抛）。
    // 因此同一个会话同时只允许一次 resume，其余共享同一个 Promise。
    const inflight = this.#resumes.get(id);
    if (inflight !== undefined) {
      this.#dbg("dsh-claude-code: resume already in flight, sharing it", id);
      return inflight;
    }
    const task = this.#resumeOnce(ownerCtx, options);
    this.#resumes.set(id, task);
    try {
      return await task;
    } finally {
      if (this.#resumes.get(id) === task) this.#resumes.delete(id);
    }
  }

  /** 一次真实的 resume（调用方负责并发去重）。 */
  async #resumeOnce(ownerCtx, options) {
    const id = options.resumeSessionId;
    const engine = await this.#engineForResume(options);
    if (engine === null) {
      // 原生会话（以及读不回日志的保守情况）：整条交回原工厂。
      this.#dbg("dsh-claude-code: resume delegates", id);
      return this.#resolveOriginal().resume(ownerCtx, options);
    }
    this.#records.set(id, { ownerCtx, options });
    const handle = await this.#resumeWithEngine(ownerCtx, options, engine);
    this.#handles.set(id, handle);
    return handle;
  }

  /** 读持久化日志反推该会话当前跑在哪个引擎上。 */
  async #engineForResume(options) {
    let handle;
    try {
      const persistence = this.loopCtx.get("sessionPersistence");
      if (persistence === undefined) return null;
      handle = await persistence.open(options.resumeSessionId, "read", {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const cold = await handle.read(0, undefined, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const preset = presetFromLog(handle.header, cold.events ?? []);
      const engineId = this.engineIdFor(preset);
      this.#dbg("dsh-claude-code: resume preset", String(preset), "-> engine", engineId);
      return this.resolveEngine(engineId);
    } catch (error) {
      // 读不回日志时保守走原生循环：宁可跑原生，也不要起一个接不上历史的 Claude 会话。
      this.#dbg("dsh-claude-code: resume preset read failed", String(error?.message ?? error));
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  // ── 自造路径（只服务本插件引擎的会话） ──────────────────────────────────
  /** 新会话：自己 prepare 会话 + 造引擎 Agent + 持久化 + 发布。 */
  async #createWithEngine(ownerCtx, options, engine) {
    return await this.#createCommon(ownerCtx, options, engine, "startup");
  }

  /** 新会话的公共路径（engine 恒为本插件引擎；原生会话不经此处）。 */
  async #createCommon(ownerCtx, options, engine, source) {
    const preparation = SessionPreparation.create(
      this.loopCtx.sessions.prepare(options.sessionId, {
        ...(options.seed === undefined ? {} : { seed: options.seed }),
        ...(options.meta === undefined ? {} : { meta: options.meta }),
        ...(options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount }),
      }),
    );
    const stored = await this.#createStoredSession(preparation.session, options.signal);
    try {
      let prepared;
      try {
        prepared = this.#prepare(ownerCtx, options.sessionId, options, preparation.session, engine, undefined);
      } catch (error) {
        diag(`#createCommon: #prepare 抛错 — ${String(error?.stack ?? error)}`);
        throw error;
      }
      return await this.#initialize(prepared, async () => {
        // 同 resume 路径：预设挂载必须发生在 publish 之前（见 #runSetup 的说明）。
        await this.#runSetup(options, prepared.agent);
        try {
          await this.#appendUnstoredSuffix(stored, preparation.session);
        } catch (error) {
          diag(`#createCommon: #appendUnstoredSuffix 抛错 — ${String(error?.stack ?? error)}`);
          throw error;
        }
        // 第三方 announce 监听器不得带崩建会话。
        //
        // 实测故障（报错原文 `cannot get property "systemPrompt" without inject`）：
        // `@deepseek-ai/dsh-experimental-tool-agent-team` 在 `agent/created` 上挂监听，
        // 而它的 `tryMembership()` 把**每个顶层 agent 都视为 Team Lead**，于是对任何自定义
        // 预设的会话都会执行 `install()`，其中 `scoped.systemPrompt.section({…})` 直接读
        // 宿主服务——cordis 要求服务必须经 `inject` 声明才能用属性语法读取，于是抛错。
        // `agents.announce` 走 serial 派发，**任一监听器抛错都会让整个 publish 失败**
        // （堆栈：agent-team install → cordis serial → dsh-agent announce → 本文件的 publish）。
        //
        // 会话本身是好的，坏的只是一个附加插件。所以走容错发布，让会话可用。
        return await prepared.publishResilient(source, (message) => {
          diag(`#createCommon: publish 降级 — ${message}`);
          this.loopCtx.logger?.warn?.(
            `dsh-claude-code: an agent/created listener failed while publishing session "${options.sessionId}" — the session is usable, that listener's contribution is missing: ${message}`,
          );
        });
      });
    } finally {
      preparation[Symbol.dispose]?.();
    }
  }

  /** resume：从持久化日志重建会话 + 造引擎 Agent + 发布。 */
  async #resumeWithEngine(ownerCtx, options, engine) {
    const persistence = this.loopCtx.get("sessionPersistence");
    if (persistence === undefined) {
      throw new Error("dsh-claude-code: cannot resume — session persistence is not configured");
    }
    const id = options.resumeSessionId;
    const handle = await persistence.open(id, "write", {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    let preparation;
    try {
      const cold = await handle.read(0, undefined, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const persisted = cold.events ?? [];

      // 关键：会话可能**已经 live** 在 store 里（页面刷新 / 重连 / 再次点开同一会话时，
      // 上一次 resume 已经把会话注册进去了）。`SessionStore.prepare(id, …)` 只要 store 里
      // 已有该 id 就抛 `session "<id>" already exists`（实测报错原文），所以这里必须先探测：
      //   有 live 会话 → 直接复用那个会话对象，不再 prepare；
      //   没有        → 按持久化日志重建。
      // 复用是安全的：本次 resume 依然会走 #initialize → publish（重新 enter/announce agent），
      // 而会话对象的 detach 由它自己的持有者负责。
      const liveSession = this.loopCtx.sessions?.get?.(id);
      const session = liveSession ?? this.loopCtx.sessions.prepare(id, {
        ...(persisted.length === 0 ? {} : { seed: [...persisted] }),
        meta: structuredClone(handle.header),
        inheritedEventCount: handle.inheritedEventCount,
        eventState: cold.eventState,
      });
      const reusedLive = liveSession !== undefined;
      this.#dbg("dsh-claude-code: resume session source", reusedLive ? "reused live session" : "rebuilt from log", id);
      // 只有自己 prepare 出来的会话才需要 preparation 生命周期；live 会话不归本次调用所有。
      preparation = reusedLive ? undefined : SessionPreparation.create(session);

      const stored = { handle, storedCount: persisted.length };
      const prepared = this.#prepare(ownerCtx, id, options, session, engine, undefined);
      return await this.#initialize(prepared, async () => {
        // 预设挂载必须在这里：与原生 AgentLoop.setupAndPublish 的
        // `await setup?.(prepared.agent.ctx, prepared.agent)` 等价，位置在 prepare 之后、
        // publish 之前。漏掉它的后果实测为：
        //   failed to create session "…": Error: cannot get property "systemPrompt" without inject
        // —— 预设行（persona 的 ctx.systemPrompt.section()、各工具行的同名调用）从未挂到
        // agent scope 上，于是它们读宿主服务时被 cordis 反射代理拒绝。
        await this.#runSetup(options, prepared.agent);
        this.#resumeHint(prepared.agent);
        if (reusedLive) {
          // 已 live 的会话：不能走 publish()——它内部的 `sessions.enter(session)` 会对已在
          // store 里的会话抛 `session "<id>" already exists`。publishAgentOnly 正是为这条
          // 路径准备的：只把 agent 注册进 agents store，不重复 enter/announce 会话。
          // 同时也不补写 suffix：该会话的持久化写入由它自己的持有者负责，重写会重复落盘。
          return prepared.publishAgentOnly("resume");
        }
        await this.#appendUnstoredSuffix(stored, session);
        // 与建会话同因：第三方 agent/created 监听器（agent-team 的 install）抛错时不让
        // 续接失败——会话本身是好的，缺的只是那个附加插件的贡献。
        return await prepared.publishResilient("resume", (message) => {
          diag(`#resumeWithEngine: publish 降级 — ${message}`);
          this.loopCtx.logger?.warn?.(
            `dsh-claude-code: an agent/created listener failed while resuming session "${id}" — the session is usable: ${message}`,
          );
        });
      });
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    } finally {
      preparation?.[Symbol.dispose]?.();
    }
  }

  /** resume 时把上次捕获的 Claude 会话 id 交给引擎 Agent（精确续接）。 */
  #resumeHint(agent) {
    if (agent === undefined || agent === null) return;
    if (typeof agent.loadResumeState !== "function") return;
    void agent.loadResumeState().catch(() => {});
  }

  /**
   * 跑调用方给的 setup 回调（**预设就是在这里挂到 agent scope 上的**）。
   *
   * 这是原生 AgentLoop 的一步：`await setup?.(prepared.agent.ctx, prepared.agent)`，
   * 位置在 prepare 之后、publish 之前（见 dsh-agent-loop 的 setupAndPublish）。
   * DSH 建会话时通过 options.setup 传入它，回调体里做 agentPresets.mount(agentCtx, presetId)。
   *
   * 漏掉这一步的后果（实测）：
   *   failed to create session "…": Error: cannot get property "systemPrompt" without inject
   * 因为预设行没被挂载——persona 行的 ctx.systemPrompt.section()、各工具行的同类调用
   * 从未执行，而它们正是会话工具目录与系统提示的来源。挂载失败的报错则来自 cordis
   * 反射代理：在未挂载的 scope 上读宿主服务会被拒绝。
   *
   * 返回值里可能带 commit()（预设代际提交），必须调用，否则预设不会被确认。
   *
   * @param {object} options AgentOptions（含 setup）
   * @param {object} agent 已构造、尚未发布的引擎 Agent
   */
  async #runSetup(options, agent) {
    const setup = options?.setup;
    diag(`runSetup: setupType=${typeof setup} optionKeys=${JSON.stringify(Object.keys(options ?? {}))}`);
    if (typeof setup !== "function") return;
    const outcome = await setup(agent.ctx, agent);
    outcome?.commit?.();
    diag("runSetup: preset mounted and committed");
  }

  /**
   * 造引擎的 Agent，并给出本路由自己 publish 的「准备发布」对象。
   *
   * 顺序与原生 AgentLoop.prepare().publish 完全一致：sessions.enter → agents.enter →
   * sessions.announce → agents.announce。差别只在会话 / agent 的 detach 闭包由这里持有，
   * 于是空白会话内换 Agent 时能「只拆 agent、保留会话」。
   */
  #prepare(ownerCtx, id, options, session, engine, sessionDetach) {
    const abort = new AbortController();
    const callerSignal = options.signal;
    const onCallerAbort = () => {
      abort.abort(callerSignal?.reason instanceof Error
        ? callerSignal.reason
        : new Error(`agent "${id}" creation aborted`));
    };
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

    // 原生分支复用 AgentLoop.prepare()：它自带的 dispose 会按原生顺序停机器（cancel →
    // whenIdle → scope.rawDispose）并执行它自己 ownership 里的清理，本路由只补「agent 与
    // 会话的 detach 闭包」和 publish 时机。
    const nativePrepared = engine === null
      ? this.#resolveOriginal().prepare(ownerCtx, id, options.agentOptions ?? {}, session, callerSignal, undefined, undefined)
      : undefined;
    const machine = nativePrepared !== undefined
      ? nativePrepared.agent
      : engine.makeAgent(this.loopCtx, id, options.agentOptions ?? {}, session, this.engineConfig(engine.id));

    // 诊断：建好 agent 后立刻探测它的 ctx 能否读到宿主服务 systemPrompt。
    // 「cannot get property "systemPrompt" without inject」来自 cordis 反射代理，
    // 这一行直接告诉我们：是 agent 的 ctx 本身取不到服务，还是错误另有来源。
    try {
      const probe = machine?.ctx;
      let readable;
      let viaGet;
      try {
        readable = probe?.systemPrompt !== undefined ? "有值" : "undefined";
      } catch (error) {
        readable = `抛错(${String(error?.message ?? error)})`;
      }
      try {
        viaGet = probe?.get?.("systemPrompt") !== undefined ? "有值" : "undefined";
      } catch (error) {
        viaGet = `抛错(${String(error?.message ?? error)})`;
      }
      diag(`#prepare: agent.ctx 探测 — 直接读=${readable} get()=${viaGet} ctx存在=${probe !== undefined}`);
    } catch (error) {
      diag(`#prepare: 探测本身失败 — ${String(error?.message ?? error)}`);
    }

    const lease = sessionDetach === undefined ? undefined : new SessionLease(sessionDetach);
    /**
     * publish 时真正生效的 lease。swap 路径的 sessionDetach 在这里就有；create/resume
     * 路径的 lease 要到 publish 里才创建（`sessions.enter` 的返回值），必须回写进这个
     * 闭包变量——detachAgentKeepSession / dispose 读的是它。旧实现只把 lease 放进返回的
     * handle，闭包里永远是 undefined，导致正常建出来的会话永远换不了 Agent（报
     * 「its session lease is not held by the router」）。
     */
    let activeLease = lease;
    let agentDetach;
    let disposing;

    const stopMachine = async () => {
      if (nativePrepared !== undefined) return; // 由 nativePrepared.dispose 负责
      machine.cancel({ kind: "disposed" }, { keepInbox: true });
      await machine.whenIdle();
      await machine.dispose();
    };

    const dispose = () => disposing ??= (async () => {
      abort.abort(new Error(`agent "${id}" lifecycle disposed`));
      callerSignal?.removeEventListener("abort", onCallerAbort);
      if (this.#handles.get(id) === handle) this.#handles.delete(id);
      try {
        if (nativePrepared !== undefined) await nativePrepared.dispose();
        else await stopMachine();
      } finally {
        try {
          agentDetach?.();
        } catch {
          // detach 幂等
        }
        activeLease?.release();
      }
    })();

    /** 原地换 Agent：只拆本 agent、保留会话，把会话所有权交给下一个 Agent。 */
    const detachAgentKeepSession = async () => {
      abort.abort(new Error(`agent "${id}" swapped`));
      callerSignal?.removeEventListener("abort", onCallerAbort);
      if (this.#handles.get(id) === handle) this.#handles.delete(id);
      if (nativePrepared !== undefined) await nativePrepared.dispose();
      else await stopMachine();
      try {
        agentDetach?.();
      } catch {
        // detach 幂等
      }
      agentDetach = undefined;
      disposing = Promise.resolve(); // 旧 dispose 从此 no-op
      return activeLease?.take();
    };

    const handle = {
      agent: machine,
      // 本句柄当前驱动的引擎 id（null = 原生 ReactLoopAgent）；swap 与释放都靠它判断。
      engineId: engine === null ? null : engine.id,
      dispose,
      detachAgentKeepSession,
    };

    /** 两处发布共用：进入 store、发通知、交出句柄（含会话所有权）。 */
    const enterAndAnnounce = async (source, sessionLease) => {
      agentDetach = this.loopCtx.agents.enter(machine, undefined);
      this.loopCtx.sessions.announce(session);
      await this.loopCtx.agents.announce(machine, source, abort.signal);
      return { ...handle, lease: sessionLease };
    };

    return {
      agent: machine,
      signal: abort.signal,
      dispose,
      detachAgentKeepSession,
      /** 首次发布：会话与 agent 都进 store，并各发一次创建通知。 */
      publish: async (source) => {
        const sessionLease = activeLease ?? new SessionLease(this.loopCtx.sessions.enter(session));
        activeLease = sessionLease;
        return await enterAndAnnounce(source, sessionLease);
      },
      /**
       * 容错发布：第三方 `agent/created` 监听器抛错时不让整条建会话失败。
       *
       * `agents.announce` 是 serial 派发，任一监听器抛错都会让 publish 整体失败——而
       * agent-team 插件正是这种监听器（它对每个顶层 agent 都执行 install()，其中直接读
       * `scoped.systemPrompt`，cordis 要求服务必须经 inject 声明才能属性读取，于是抛错）。
       * 坏的只是那个附加插件，会话本身是好的，所以降级继续。
       *
       * @param {string} source 发布来源（如 "startup"）
       * @param {(message: string) => void} onError 收集降级原因
       * @returns 与 publish 同形的句柄
       */
      publishResilient: async (source, onError) => {
        const sessionLease = activeLease ?? new SessionLease(this.loopCtx.sessions.enter(session));
        activeLease = sessionLease;
        agentDetach = this.loopCtx.agents.enter(machine, undefined);
        this.loopCtx.sessions.announce(session);
        try {
          await this.loopCtx.agents.announce(machine, source, abort.signal);
        } catch (error) {
          // agent 已经在 agents store 里；只少了一次通知，会话可用。
          onError?.(String(error?.message ?? error));
        }
        return { ...handle, lease: sessionLease };
      },
      /** 接管已 live 的会话：只进 agent store、不重发 session/created。 */
      publishAgentOnly: (source, detachedSession) => {
        agentDetach = this.loopCtx.agents.enter(machine, undefined);
        const carried = detachedSession === undefined ? activeLease : new SessionLease(detachedSession);
        activeLease = carried;
        return { ...handle, lease: carried };
      },
    };
  }

  /** 对齐原生工厂：把「创建 / resume 事务」包在 maintenance 窗口里，失败则整体回滚。 */
  async #initialize(prepared, initialize) {
    try {
      return await prepared.agent.runMaintenance(async () => {
        try {
          return await initialize();
        } catch (error) {
          prepared.agent.cancel({ kind: "disposed" }, { keepInbox: true });
          throw error;
        }
      });
    } catch (error) {
      await prepared.dispose().catch(() => {});
      throw error;
    }
  }

  /** 有持久化后端时替新会话取写所有权。 */
  async #createStoredSession(session, signal) {
    const persistence = this.loopCtx.get("sessionPersistence");
    if (persistence === undefined) return undefined;
    const handle = await persistence.create(session.header, {
      inheritedEventCount: session.inheritedEventCount,
      ...(signal === undefined ? {} : { signal }),
    });
    return { handle, storedCount: 0 };
  }

  /** 发布前把未落盘的事件（seed、构造期写入）补写进持久化日志。 */
  async #appendUnstoredSuffix(stored, session) {
    if (stored === undefined) return;
    const suffix = readSessionEvents(session).slice(stored.storedCount);
    if (suffix.length > 0) await stored.handle.append([...suffix]);
    stored.storedCount += suffix.length;
  }

  // ── 预设切换 → 换 Agent ─────────────────────────────────────────────────
  #enqueueSwitch(sessionId, agentPreset) {
    const queued = this.#switches.get(sessionId) ?? Promise.resolve();
    const settled = queued
      .then(() => this.#onPresetSelected(sessionId, agentPreset))
      .catch(() => undefined);
    this.#switches.set(sessionId, settled);
    settled.then(() => {
      if (this.#switches.get(sessionId) === settled) this.#switches.delete(sessionId);
    });
  }

  async #onPresetSelected(sessionId, agentPreset) {
    // 只有本路由自己造的会话才在 #records 里。原生会话（standard 等）刻意没有记录——
    // 它们整条由原工厂拥有，本路由不碰，因此这里直接返回就是正确行为。
    const record = this.#records.get(sessionId);
    if (record === undefined) {
      // 宿主（dsh-agent-preset-registry）的预设切换是「原地重挂组合」：select() 已把
      // 目标预设挂到现有 Agent 的 scope 上并向 UI 返回成功。若目标其实指向本插件的
      // 引擎，这个会话此刻仍由原生循环驱动——引擎要到下次 resume（重启 / 重新打开）
      // 时按持久化日志判定才会真正接管。必须写 warn 把这条时差说出来，否则用户看到
      // 的是「切过去了却没生效」。
      const engineId = this.engineIdFor(agentPreset);
      if (this.resolveEngine(engineId) !== null) {
        this.loopCtx.logger?.warn?.(
          `dsh-claude-code: session "${sessionId}" switched to preset "${agentPreset}" while staying on the native loop — the "${engineId}" engine takes over the next time this session is resumed (app restart or reopen)`,
        );
      }
      this.#dbg("dsh-claude-code: preset change ignored (session is not owned by this router)", sessionId);
      return;
    }
    const current = this.#handles.get(sessionId);
    if (current === undefined) return;
    // 已经换回原生循环的会话：原生 prepared 的 ownership 绑在 AgentLoop 自己的闭包里，
    // 本路由拿不到「只拆 agent、不拆会话」的能力，再介入只会留下一个谁也驱动不了的
    // 会话。宿主已把目标预设重挂到原生 Agent 的 scope 上，这里保持沉默即可。
    if ((current.engineId ?? DEEPSEEK_ENGINE_ID) === DEEPSEEK_ENGINE_ID) {
      this.#dbg("dsh-claude-code: preset change ignored (session is back on the native loop)", sessionId);
      return;
    }
    const nextEngineId = this.engineIdFor(agentPreset);
    if (nextEngineId === (current.engineId ?? DEEPSEEK_ENGINE_ID)) return; // 引擎没变：无动作
    const engine = this.resolveEngine(nextEngineId);
    // engine 为 null（切回原生循环）同样走 #swap：#prepare 的原生分支会用原工厂的
    // prepare() 造 ReactLoopAgent，会话对象与所有权原样移交。旧实现在此拒绝换回原生，
    // 结果是宿主 UI 显示切换成功、会话实际仍由 Claude Code 驱动（「切换无效」），
    // 重启后又按日志突然变回原生——所以必须在活会话上把引擎真的换掉。
    try {
      await this.#swap(sessionId, record, current, engine, agentPreset);
    } catch (error) {
      this.loopCtx.logger?.warn?.(
        `dsh-claude-code: engine swap failed for session "${sessionId}": ${String(error?.message ?? error)}`,
      );
    }
  }

  /** 空白会话内原地换 Agent：拆旧、保留会话、挂新预设、发布新 Agent。 */
  async #swap(sessionId, record, current, engine, agentPreset) {
    const session = current.agent.session;
    // 拆旧 Agent：只拆 agent，会话 detach 闭包被交出来（会话仍在 store 里，不重发 session/created）。
    const detachedSession = await current.detachAgentKeepSession();
    if (detachedSession === undefined) {
      // 拿不到会话所有权时不做危险操作：宁可停在「已拆旧 agent」的可用状态，
      // 也不要整会话重建（那会让客户端把会话标记成 removed）。
      this.loopCtx.logger?.warn?.(
        `dsh-claude-code: cannot swap session "${sessionId}" — its session lease is not held by the router`,
      );
      return;
    }
    const prepared = this.#prepare(record.ownerCtx, sessionId, record.options, session, engine, detachedSession);
    const handle = await this.#initialize(prepared, async () => {
      await this.#mountPreset(prepared.agent.ctx, agentPreset);
      // 会话已经 live：只把新 agent 放进 agent store，不重发 session/created。
      return prepared.publishAgentOnly("resume", detachedSession);
    });
    this.#handles.set(sessionId, handle);
    this.loopCtx.logger?.info?.(
      `dsh-claude-code: session "${sessionId}" switched to engine "${handle.engineId ?? "deepseek"}"`,
    );
  }

  /** 让新 agent 的 scope 挂到目标预设的 standing mount 上（注册视图因此可见）。 */
  async #mountPreset(agentCtx, agentPreset) {
    const presets = this.loopCtx.get("agentPresets");
    if (presets === undefined || typeof agentPreset !== "string" || agentPreset === "") return;
    // select() 已经 recompose 过 live agent 的旧 scope；新 agent 的 scope 是全新的 key，
    // 需要自己挂一次，否则它会掉出预设构成（工具 / 人设 / 提示词段都看不到）。
    await presets.mount(agentCtx, agentPreset);
  }

  /** 插件释放：停掉所有本路由持有的 agent。 */
  async drain() {
    const handles = [...this.#handles.values()];
    this.#handles.clear();
    this.#records.clear();
    for (const handle of handles) {
      try {
        await handle.dispose();
      } catch {
        // 释放失败不阻塞其它句柄
      }
    }
  }
}

export { DEEPSEEK_ENGINE_ID };
