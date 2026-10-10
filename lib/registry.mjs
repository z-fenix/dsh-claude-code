// lib/registry.mjs — 引擎注册表：引擎是「实现 DSH Agent 接口的主循环驱动」。
//
// 一条引擎记录：
//   {
//     id: string,            必填。引擎 id，同时是它自带预设的目录名（by-id 路由的锚点）。
//     name: string,          预设显示名。
//     description: string,   预设描述（一句话）。
//     order: number,         可选。预设列表排序位；越小越靠前。
//     presetDir?: string,    可选。引擎自带预设目录的绝对路径（内含 agent.cordis.yml + preset.yml）。
//     makeAgent(loopCtx, id, options, session, engineConfig) => DSH Agent
//   }
//
// 透明性约束：makeAgent 不接收任何「预设」概念（引擎对预设无感知），返回的就是 DSH Agent；
// 会话本身也不知道自己被谁驱动。路由只发生在 router.mjs 一处。
//
// `deepseek` 是保留 id：它是「委托回 DSH 原生 AgentLoop」的哨兵，不是一个真引擎，
// 所以不允许注册。

/** 委托回 DSH 原生主循环（ReactLoopAgent）的哨兵引擎 id。 */
export const DEEPSEEK_ENGINE_ID = "deepseek";

export class EngineRegistry {
  #engines = new Map();

  /**
   * @param onRegister 可选回调：每次 register 成功后调用（框架用它把引擎自带预设落地到用户 root）。
   */
  constructor(onRegister) {
    this.onRegister = onRegister;
  }

  /**
   * 注册一个引擎。
   * @throws 引擎 id 为空、占用保留 id、重复注册、或缺少 makeAgent() 时抛出。
   */
  register(engine) {
    if (!engine || typeof engine.id !== "string" || engine.id === "") {
      throw new Error("dsh-claude-code: engine requires a non-empty string id");
    }
    if (engine.id === DEEPSEEK_ENGINE_ID) {
      throw new Error(`dsh-claude-code: "${DEEPSEEK_ENGINE_ID}" is reserved for the delegate engine`);
    }
    if (this.#engines.has(engine.id)) {
      throw new Error(`dsh-claude-code: engine "${engine.id}" already registered`);
    }
    if (typeof engine.makeAgent !== "function") {
      throw new Error(`dsh-claude-code: engine "${engine.id}" requires makeAgent()`);
    }
    this.#engines.set(engine.id, engine);
    this.onRegister?.(engine);
  }

  /** 按 id 取引擎；未注册返回 undefined（调用方据此回退到默认引擎）。 */
  get(id) {
    return this.#engines.get(id);
  }

  /** 全部已注册引擎，注册顺序。 */
  list() {
    return [...this.#engines.values()];
  }
}
