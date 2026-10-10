// index.mjs — dsh-claude-code 插件入口。
//
// 作用：给 DeepSeek Harness 增加一个「Claude Code 模式」。装上之后，Agent 预设列表里多一个
// `claude-code` 预设；选中它的会话由本机 Claude Code CLI 驱动（工具、沙箱、人设都来自
// Claude Code），轨迹逐条实时流进 DSH 会话；选其它预设的会话一切照旧（原生 ReactLoopAgent）。
//
// 组成：
//   - 引擎注册表（lib/registry.mjs）：本插件自带 `claude-code` 引擎；第三方插件也可以
//     `inject: ["claudeCodeEngines"]` 后注册自己的引擎，从而复用同一套路由与预设切换。
//   - 路由工厂（lib/router.mjs）：接管 `ctx.agents` 的 agent factory 槽位，按预设分发。
//   - 休眠 LLM 路由（lib/llm-route.mjs）：让前端模型选择认为 `claude-code` 这个 provider
//     「已被服务」，否则首轮之后输入框会被锁死。
//
// 预设本身由本包的 cordis.patch.yml 声明为 `@deepseek-ai/dsh-agent-preset` 行——
// 0.2.0-rc.2 起预设是声明式插件的配置行，不再有磁盘预设目录（见 docs/guides/setup.md）。
import z from "@deepseek-ai/schemastery";
import { EngineRegistry, DEEPSEEK_ENGINE_ID } from "./lib/registry.mjs";
import { EngineRouter } from "./lib/router.mjs";
import { ClaudeCodeAgent } from "./lib/agent.mjs";
import { CLAUDE_CODE_PROVIDER, ClaudeCodeLlmRoute } from "./lib/llm-route.mjs";
import { load as loadClaudeSessionId } from "./lib/store.mjs";

export const name = "dsh-claude-code";

// 只声明真正必须的服务：agents 是接管槽位的对象，sessions / sessionPersistence 供自造
// 会话与持久化使用。agentPresets、subprocess、approval、userQuestions、user-approval 一律
// 用 ctx.get() 宽松读取——它们是可选协作者，缺了要降级而不是让插件加载失败。
export const inject = ["agents", "sessions", "sessionPersistence"];

/** 引擎 id；同时是预设 id（by-id 路由的锚点）。 */
export const CLAUDE_CODE_ENGINE_ID = "claude-code";

/** 引擎私有配置默认值（覆盖在 config.engines["claude-code"] 之上）。 */
const ENGINE_DEFAULTS = {
  /** Claude Code 可执行文件（PATH 名或绝对路径）。 */
  executable: "claude",
  /** 跨轮复用同一个 Claude 会话（false 时每轮新开）。 */
  persistSession: true,
  /** token 级流式输出。 */
  includePartialMessages: true,
  /** 把 Claude Code 内部子代理（Agent/Task 工具）追踪为独立只读 DSH 子会话。 */
  traceSubagents: true,
  /** 额外环境变量（如 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL）。 */
  env: {},
  /** 手动指定模型上下文窗口（token 数）；SDK 取不到时兜底。 */
  contextWindow: undefined,
};

export const Config = z.object({
  /** 总闸：false = 插件完全不介入，所有会话走原生循环。 */
  enabled: z.boolean().default(true),
  /**
   * 主循环接管开关：true = 用本路由替换宿主全局的 agent factory（Claude Code 预设由
   * ClaudeCodeAgent 驱动）；false = **不碰全局工厂**，只保留预设声明与 LLM provider。
   *
   * 为什么默认 false：接管全局 factory 意味着**每一个会话**（含 standard / minimal 等
   * 完全无关的会话）都要经过本插件的代码路径。实测中这条路径一旦出问题，宿主会在启动
   * 阶段失败，而 DSH 的启动失败会触发 profile 恢复——重写用户的 cordis.patch.yml、
   * 删掉 node_modules。这个代价不该由一个第三方插件默认承担。
   *
   * 想启用主循环替换时显式打开它（profile 的 cordis.patch.yml 里按行 id 覆盖即可）。
   */
  routeMainLoop: z.boolean().default(false),
  /** 未在 engineByPreset 点名的预设使用的引擎 id；deepseek 是「回原生循环」的哨兵。 */
  defaultEngine: z.string().default(DEEPSEEK_ENGINE_ID),
  /** 预设 id → 引擎 id 覆盖表（显式覆盖高于「预设 id 即引擎 id」的自动映射）。 */
  engineByPreset: z.dict(z.string()).default({}),
  /** 引擎 id → 引擎私有配置（插件不解析、不校验，原样交给引擎）。 */
  engines: z.dict(z.any()).default({}),
});

/**
 * `claude-code` 引擎：把 ClaudeCodeAgent 交给路由。
 * 引擎接口刻意保持最小（id / name / description / makeAgent），第三方插件可照此注册自己的引擎。
 */
export const claudeCodeEngine = {
  id: CLAUDE_CODE_ENGINE_ID,
  name: "Claude Code",
  description: "Driven by the local Claude Code CLI; tools and sandbox come from Claude Code.",
  order: 99,

  /**
   * 造一个由 Claude Code 驱动的 DSH Agent。
   * @param {object} loopCtx 宿主上下文
   * @param {string} id 会话 / agent 身份
   * @param {object} options AgentOptions
   * @param {object} session DSH 会话
   * @param {object} engineConfig 引擎私有配置
   * @returns {ClaudeCodeAgent}
   */
  makeAgent(loopCtx, id, options, session, engineConfig) {
    const config = { ...ENGINE_DEFAULTS, ...(engineConfig ?? {}) };
    const machine = new ClaudeCodeAgent(loopCtx, id, options, session, config);
    // resume 路径：把上一进程捕获的 Claude 会话 id 读回来，首轮即续接同一个 Claude 会话。
    machine.loadResumeState = async () => {
      const existing = await loadClaudeSessionId(id);
      if (existing !== undefined) machine.pendingResume = existing;
    };
    return machine;
  },
};

export function apply(ctx, config) {
  if (!config.enabled) {
    ctx.logger?.info?.("dsh-claude-code: disabled (enabled=false) — sessions stay on the native loop");
    return;
  }

  // 引擎注册表暴露为 cordis 服务：第三方插件 `inject: ["claudeCodeEngines"]` 后注册自己的引擎。
  const registry = new EngineRegistry((engine) => {
    ctx.logger?.info?.(`dsh-claude-code: engine "${engine.id}" registered`);
  });
  registry.register(claudeCodeEngine);
  ctx.provide("claudeCodeEngines", registry);

  // 休眠 LLM 路由：只贡献 provider 目录，让前端把 `claude-code` 判为「已服务」，
  // 否则轨迹里写的 provider 会让输入框在首轮之后自锁。无 llm 注册表时无需注册。
  // 仅在真正接管主循环时注册：provider 目录的意义是「这个会话由 Claude Code 驱动」，
  // 不接管时注册它只会让前端误判。
  const llm = ctx.get("llm");
  if (config.routeMainLoop && llm !== undefined) {
    ctx.effect(() => {
      const unregister = llm.registerAdapter([CLAUDE_CODE_PROVIDER], new ClaudeCodeLlmRoute());
      return () => unregister();
    }, "dsh-claude-code: llm route");
  }

  if (!config.routeMainLoop) {
    // 默认路径：**不碰全局 agent factory**。
    //
    // 预设行（本包 cordis.patch.yml 里那条 @deepseek-ai/dsh-agent-preset）已经独立生效，
    // 所以「Claude Code」预设照常出现在列表里、并带着完整工具目录工作；只是它走 DSH
    // 原生循环而不是 Claude Code CLI。
    //
    // 这样做的理由：接管全局 factory 会让**每一个会话**都经过本插件，而一旦踩到
    // agent-loop 的 setFactory 抢占问题就会让宿主启动失败 → DSH profile 恢复 →
    // 用户配置与 node_modules 被清空。默认关掉它，让插件不可能以这种方式伤害用户环境。
    ctx.logger?.info?.(
      "dsh-claude-code: routeMainLoop=false — the Claude Code preset is registered, but the global agent factory is untouched (no session is rerouted)",
    );
    return;
  }

  // ── routeMainLoop=true：经由 EngineRouter.attach 接管主循环 ────────────────
  //
  // attach 的时序契约（实测得来的关键约束）：**绝不抢在 `@deepseek-ai/dsh-agent-loop`
  // 之前占住工厂槽位**。那一行是 required，它在自己的构造函数里调 `ctx.agents.setFactory(this)`，
  // 而 setFactory 先到先得：被抢了就会抛 `an agent factory is already registered`，
  // 该行激活失败 → 宿主启动失败 → DSH 的 profile 恢复重写用户配置、清空 node_modules。
  //
  // 所以 attach 的逻辑是「等它先注册，再用官方 setFactory 包住它」：槽位已有工厂就立刻接管；
  // 还没有就等 cordis 的 `internal/service` 事件里 agents 就绪的通知再接管。
  const routing = EngineRouter.attach({
    agents: ctx.agents,
    ctx,
    config,
    registry,
    onInner: () => ctx.logger?.info?.("dsh-claude-code: took over the agent factory (native loop wrapped)"),
  });
  ctx.effect(() => () => routing.detach(), "dsh-claude-code: agent factory routing");

  ctx.logger?.info?.(
    routing.attached
      ? `dsh-claude-code: routing active — preset "${CLAUDE_CODE_ENGINE_ID}" runs Claude Code; every other preset is delegated to the native loop untouched`
      : `dsh-claude-code: waiting for the native agent factory to register before routing — preset "${CLAUDE_CODE_ENGINE_ID}" will run Claude Code once it appears`,
  );
}

export { DEEPSEEK_ENGINE_ID };
