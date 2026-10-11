// test/router.test.mjs — 预设 → 引擎的路由判定（不启动真实运行时）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { EngineRouter, presetFromLog } from "../lib/router.mjs";
import { EngineRegistry, DEEPSEEK_ENGINE_ID } from "../lib/registry.mjs";

/** 最小假 ctx：只提供 router 构造与判定用得到的东西。 */
function fakeCtx() {
  return {
    logger: { debug() {}, info() {}, warn() {} },
    on() {},
    get: () => undefined,
    sessions: { get: () => undefined },
  };
}

function makeRegistry() {
  const registry = new EngineRegistry();
  registry.register({
    id: "claude-code",
    name: "Claude Code",
    makeAgent: () => {
      throw new Error("not used in this test");
    },
  });
  return registry;
}

/** 注册一个返回指定 agent 的 claude-code 引擎（用于需要真正造 agent 的用例）。 */
function makeRegistryWithAgent(agent) {
  const registry = new EngineRegistry();
  registry.register({
    id: "claude-code",
    name: "Claude Code",
    makeAgent: () => agent,
  });
  return registry;
}

function makeRouter(config = {}) {
  const registry = makeRegistry();
  const router = new EngineRouter(fakeCtx(), {
    defaultEngine: DEEPSEEK_ENGINE_ID,
    engineByPreset: {},
    engines: {},
    ...config,
  }, {}, registry);
  return { router, registry };
}

test("presetFromLog 取最后一条 agent-preset/selected，其次 header", () => {
  const events = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "agent-preset/selected", data: { agentPreset: "first" } },
    { type: "agent-preset/selected", data: { agentPreset: "second" } },
  ];
  assert.equal(presetFromLog({ agentPreset: "header" }, events), "second");
  assert.equal(presetFromLog({ agentPreset: "header" }, []), "header");
  assert.equal(presetFromLog({}, []), undefined);
});

test("引擎自带预设：预设 id 即引擎 id", () => {
  const { router } = makeRouter();
  assert.equal(router.engineIdFor("claude-code"), "claude-code");
  assert.equal(router.resolveEngine("claude-code").id, "claude-code");
});

test("未命中的预设回落到默认引擎（deepseek 哨兵 → 原生循环）", () => {
  const { router } = makeRouter();
  assert.equal(router.engineIdFor("standard"), DEEPSEEK_ENGINE_ID);
  assert.equal(router.resolveEngine(router.engineIdFor("standard")), null);
});

test("engineByPreset 显式覆盖优先于 by-id 自动映射", () => {
  const { router } = makeRouter({ engineByPreset: { "claude-code": "deepseek", custom: "claude-code" } });
  assert.equal(router.engineIdFor("claude-code"), "deepseek");
  assert.equal(router.resolveEngine("deepseek"), null);
  assert.equal(router.engineIdFor("custom"), "claude-code");
  assert.equal(router.resolveEngine("claude-code").id, "claude-code");
});

test("defaultEngine 可改成某个引擎", () => {
  const { router } = makeRouter({ defaultEngine: "claude-code" });
  assert.equal(router.engineIdFor("standard"), "claude-code");
  assert.equal(router.resolveEngine("claude-code").id, "claude-code");
});

test("空 / 非字符串预设 id 走默认引擎", () => {
  const { router } = makeRouter();
  assert.equal(router.engineIdFor(undefined), DEEPSEEK_ENGINE_ID);
  assert.equal(router.engineIdFor(""), DEEPSEEK_ENGINE_ID);
  assert.equal(router.engineIdFor(42), DEEPSEEK_ENGINE_ID);
});

test("engines 配置按引擎 id 取，未知引擎返回空对象", () => {
  const { router } = makeRouter({ engines: { "claude-code": { executable: "claude.cmd" } } });
  assert.deepEqual(router.engineConfig("claude-code"), { executable: "claude.cmd" });
  assert.deepEqual(router.engineConfig("nope"), {});
});

test("引擎注册表：保留 id、重复、缺 makeAgent 都拒绝", () => {
  const registry = new EngineRegistry();
  assert.throws(() => registry.register({ id: DEEPSEEK_ENGINE_ID, makeAgent() {} }), /reserved/);
  assert.throws(() => registry.register({ id: "" }), /non-empty string id/);
  assert.throws(() => registry.register({ id: "x" }), /requires makeAgent/);
  registry.register({ id: "x", makeAgent() {} });
  assert.throws(() => registry.register({ id: "x", makeAgent() {} }), /already registered/);
  assert.equal(registry.list().length, 1);
});

test("onRegister 回调在注册成功后触发（用于落地附加资源）", () => {
  const seen = [];
  const registry = new EngineRegistry((engine) => seen.push(engine.id));
  registry.register({ id: "a", makeAgent() {} });
  assert.deepEqual(seen, ["a"]);
});

// ── 回归护栏：原生会话绝不能被本路由接管 ────────────────────────────────────
//
// 历史故障：本路由曾对**所有**会话自造「prepare + publish」，把 AgentLoop 的
// ownership.trackWrapper → setupAndPublish → raceAbortCall 整条链路换成了残缺实现。
// 结果：原生会话的文件建好、header 写入，之后再无任何事件，会话既打不开也发不出消息，
// 而 Claude Code 会话因为走的是另一条路径反而正常。
//
// 契约：只有当预设解析到本插件引擎时，路由才自己造会话；其余情况（含子代理）必须
// 整条委托回原工厂，并且不留下 record/handle——否则切换预设时本路由会去动别人的会话。

/** 记录调用并返回可识别结果的原工厂替身。 */
function spyFactory() {
  const calls = { createAgent: [], resume: [] };
  const original = {
    async createAgent(ownerCtx, options) {
      calls.createAgent.push(options);
      return { agent: { native: true }, dispose: async () => {}, from: "original" };
    },
    async resume(ownerCtx, options) {
      calls.resume.push(options);
      return { agent: { native: true }, dispose: async () => {}, from: "original" };
    },
  };
  return { original, calls };
}

test("原生预设的 createAgent 整条委托回原工厂，不进本路由的自造路径", async () => {
  const { original, calls } = spyFactory();
  const registry = makeRegistry();
  const router = new EngineRouter(fakeCtx(), {
    defaultEngine: DEEPSEEK_ENGINE_ID, engineByPreset: {}, engines: {},
  }, original, registry);

  for (const preset of ["standard", "minimal", undefined]) {
    const handle = await router.createAgent({}, { sessionId: `session-${String(preset)}`, meta: { agentPreset: preset } });
    assert.equal(handle.from, "original", `预设 ${String(preset)} 必须由原工厂创建`);
  }
  assert.equal(calls.createAgent.length, 3);
});

test("子代理会话永远委托原工厂，即使预设指向本插件引擎", async () => {
  const { original, calls } = spyFactory();
  const router = new EngineRouter(fakeCtx(), {
    defaultEngine: DEEPSEEK_ENGINE_ID, engineByPreset: {}, engines: {},
  }, original, makeRegistry());

  await router.createAgent({}, { sessionId: "s1", meta: { agentPreset: "claude-code", origin: "subagent" } });
  await router.createAgent({}, { sessionId: "s2", meta: { agentPreset: "claude-code" }, parentAgent: {} });
  assert.equal(calls.createAgent.length, 2);
});

test("原生会话不登记 record/handle，切换预设时本路由不介入", async () => {
  const { original } = spyFactory();
  const router = new EngineRouter(fakeCtx(), {
    defaultEngine: DEEPSEEK_ENGINE_ID, engineByPreset: {}, engines: {},
  }, original, makeRegistry());

  await router.createAgent({}, { sessionId: "s-native", meta: { agentPreset: "standard" } });
  // 句柄与记录都不该留下：留下了就说明本路由以为自己在驱动这个会话。
  assert.equal(router.handles.has("s-native"), false);
  assert.equal(router.records.has("s-native"), false);
});

// 回归护栏（实测故障）：
//   resume failed for session "session-8e1595b4-…": Error: session "…" already exists
//
// 成因：resume 的「会话是否已 live」守卫与后面的 sessions.prepare(id, …) 之间隔着多个 await。
// 客户端重试 / 重连会并发发起同一会话的 resume，两次都通过守卫，第二次在 prepare 时撞
// @deepseek-ai/dsh-session 的 SessionStore.prepare（store 里已有该 id 即抛）。
// 修法：同一会话同时只允许一次 resume，其余共享同一个 Promise。
test("并发 resume 同一个会话时只真正执行一次（避免 session already exists）", async () => {
  const { original, calls } = spyFactory();
  // 让 #engineForResume 真的走一遍持久化读取，制造守卫与 prepare 之间的 await 窗口。
  const ctx = {
    logger: { debug() {}, info() {}, warn() {} },
    on() {},
    sessions: { get: () => undefined },
    get(name) {
      if (name !== "sessionPersistence") return undefined;
      return {
        async open() {
          // 读日志反推预设为 standard → 交给原工厂
          return {
            header: { agentPreset: "standard" },
            inheritedEventCount: 0,
            async read() { return { events: [], eventState: "detached" }; },
            async close() {},
          };
        },
      };
    },
  };
  const router = new EngineRouter(ctx, {
    defaultEngine: DEEPSEEK_ENGINE_ID, engineByPreset: {}, engines: {},
  }, original, makeRegistry());

  const [a, b, c] = await Promise.all([
    router.resume({}, { resumeSessionId: "s-race" }),
    router.resume({}, { resumeSessionId: "s-race" }),
    router.resume({}, { resumeSessionId: "s-race" }),
  ]);

  assert.equal(calls.resume.length, 1, `原工厂只该被调用一次，实际 ${calls.resume.length} 次`);
  assert.equal(a, b, "并发 resume 必须返回同一个句柄");
  assert.equal(b, c, "并发 resume 必须返回同一个句柄");
  assert.equal(router.resumes.has("s-race"), false, "进行中的 resume 必须在结束后清空");
});

test("持久化读取失败时不卡住登记表，后续 resume 仍会真的重试", async () => {
  const { original, calls } = spyFactory();
  let attempts = 0;
  const ctx = {
    logger: { debug() {}, info() {}, warn() {} },
    on() {},
    sessions: { get: () => undefined },
    get(name) {
      if (name !== "sessionPersistence") return undefined;
      return {
        async open() {
          attempts += 1;
          throw new Error("boom");
        },
      };
    },
  };
  const router = new EngineRouter(ctx, {
    defaultEngine: DEEPSEEK_ENGINE_ID, engineByPreset: {}, engines: {},
  }, original, makeRegistry());

  // 读不回日志 → 保守委托回原工厂（不抛错，这是刻意的降级）
  await router.resume({}, { resumeSessionId: "s-fail" });
  assert.equal(attempts, 1);
  assert.equal(calls.resume.length, 1, "应委托给原工厂");
  assert.equal(router.resumes.has("s-fail"), false, "结束后必须清空登记表");

  // 第二次必须真的重新尝试（登记表没被第一次卡住）
  await router.resume({}, { resumeSessionId: "s-fail" });
  assert.equal(attempts, 2, "第二次必须真的重新尝试");
  assert.equal(calls.resume.length, 2);
  assert.equal(router.resumes.has("s-fail"), false);
});

// ── 空白 Claude Code 会话切回 standard：必须真正换回原生循环 ─────────────────
//
// 宿主（dsh-agent-preset-registry）的预设切换是「原地重挂组合、不重建 Agent」：
// select() recompose 完就追加 agent-preset/selected 并向 UI 返回成功。若本路由只是
// 拒绝换回原生（旧行为，仅向 stderr 写一条看不见的 warn），会话芯片已显示 standard、
// 实际仍由 Claude Code CLI 驱动——用户看到的就是「切换无效」，且重启后 resume 按
// 日志判定 standard 又突然变回原生循环，状态不一致。
//
// 契约：本路由自造的会话（record/handle 都在）收到 agent-preset/selected 且目标解析到
// 原生循环时，用原工厂的 prepare() 真正换上原生 Agent：拆旧引擎 Agent（不动会话）、
// 会话所有权原样移交、挂载目标预设、只注册新 Agent（不重发 session/created）。
// 换回原生后本路由不再介入该会话（原生 prepared 的 ownership 无法安全拿回）。
test("空白 claude-code 会话切到 standard：拆旧引擎、用原工厂 prepare 换上原生 Agent", async () => {
  const calls = {
    cancel: 0, dispose: 0, nativePrepare: [], mount: [],
    agentsEnter: 0, agentsAnnounce: 0, sessionsEnter: [], sessionsAnnounce: [],
  };
  const session = { id: "s-swap", header: { agentPreset: "claude-code" } };
  const claudeAgent = {
    id: "s-swap",
    session,
    ctx: { tag: "claude-ctx" },
    async runMaintenance(job) { return job(); },
    cancel() { calls.cancel += 1; },
    async whenIdle() {},
    async dispose() { calls.dispose += 1; },
  };
  const nativeAgent = {
    id: "s-swap",
    async runMaintenance(job) { return job(); },
    cancel() {},
    async whenIdle() {},
    async dispose() {},
  };
  const original = {
    prepare(ownerCtx, id, agentOptions, preparedSession) {
      calls.nativePrepare.push({ id, agentOptions, session: preparedSession });
      return { agent: nativeAgent, signal: new AbortController().signal, dispose: async () => {} };
    },
    async createAgent() { throw new Error("not used"); },
    async resume() { throw new Error("not used"); },
  };

  let presetHandler;
  const ctx = {
    logger: { debug() {}, info() {}, warn() {} },
    on(event, handler) {
      if (event === "agent-preset/selected") presetHandler = handler;
    },
    agents: {
      enter() { calls.agentsEnter += 1; return () => {}; },
      async announce() { calls.agentsAnnounce += 1; },
    },
    sessions: {
      get: (id) => (id === "s-swap" ? session : undefined),
      prepare: (id) => ({ id }),
      enter(s) { calls.sessionsEnter.push(s.id); return () => {}; },
      announce(s) { calls.sessionsAnnounce.push(s.id); },
    },
    get(name) {
      if (name === "agentPresets") return { async mount(agentCtx, preset) { calls.mount.push(preset); } };
      return undefined;
    },
  };

  const router = new EngineRouter(ctx, {
    defaultEngine: DEEPSEEK_ENGINE_ID, engineByPreset: {}, engines: {},
  }, original, makeRegistryWithAgent(claudeAgent));
  assert.ok(presetHandler, "路由必须在构造时订阅 agent-preset/selected");

  // 1) 建一个 claude-code 会话（走本路由自造路径）。
  await router.createAgent({}, {
    sessionId: "s-swap",
    agentOptions: { provider: "local", model: "m" },
    meta: { agentPreset: "claude-code" },
  });
  assert.equal(router.handles.get("s-swap")?.engineId, "claude-code");
  assert.deepEqual(calls.sessionsEnter, ["s-swap"], "建会话时 enter 一次");
  assert.deepEqual(calls.sessionsAnnounce, ["s-swap"], "建会话时 announce 一次");

  // 2) 空白会话内切到 standard（宿主 recompose 后发事件）。
  presetHandler("s-swap", "standard");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(calls.cancel >= 1, "旧引擎 Agent 必须被 cancel");
  assert.ok(calls.dispose >= 1, "旧引擎 Agent 必须被 dispose");
  assert.equal(calls.nativePrepare.length, 1, "必须用原工厂 prepare() 造原生 Agent");
  assert.equal(calls.nativePrepare[0].id, "s-swap");
  assert.deepEqual(calls.nativePrepare[0].agentOptions, { provider: "local", model: "m" });
  assert.equal(calls.nativePrepare[0].session, session, "必须复用同一个会话对象，不得重建");
  assert.equal(router.handles.get("s-swap")?.engineId ?? null, null, "新句柄必须是原生引擎");
  assert.deepEqual(calls.mount, ["standard"], "必须给新原生 Agent 挂载目标预设");
  assert.equal(calls.agentsEnter, 2, "新原生 Agent 必须注册进 agents store");
  assert.deepEqual(calls.sessionsEnter, ["s-swap"], "换 Agent 不得重新 enter 会话");
  assert.deepEqual(calls.sessionsAnnounce, ["s-swap"], "换 Agent 不得重发 session/created");

  // 3) 换回原生后再切 claude-code：本路由必须不再介入（原生 ownership 拿不回来）。
  presetHandler("s-swap", "claude-code");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.nativePrepare.length, 1, "原生会话不得再次被本路由换引擎");
  assert.equal(calls.dispose, 1, "原生 Agent 不得被本路由拆除");
});

test("原生会话切到本插件引擎时记录一条说明（重启后 resume 才真正接管）", async () => {
  const warnings = [];
  const { original, calls } = spyFactory();
  let presetHandler;
  const ctx = {
    logger: { debug() {}, info() {}, warn(message) { warnings.push(message); } },
    on(event, handler) {
      if (event === "agent-preset/selected") presetHandler = handler;
    },
    get: () => undefined,
    sessions: { get: () => undefined },
  };
  const router = new EngineRouter(ctx, {
    defaultEngine: DEEPSEEK_ENGINE_ID, engineByPreset: {}, engines: {},
  }, original, makeRegistry());

  await router.createAgent({}, { sessionId: "s-native", meta: { agentPreset: "standard" } });
  presetHandler("s-native", "claude-code");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.createAgent.length + calls.resume.length, 1, "原生会话仍归原工厂，本路由不得介入");
  assert.ok(
    warnings.some((message) => message.includes("s-native") && message.includes("claude-code")),
    `必须向 logger.warn 写一条含会话 id 与引擎名的说明，实际：${JSON.stringify(warnings)}`,
  );
});

// 回归护栏（实测故障，报错逐字为 `cannot get property "systemPrompt" without inject`）：
//
// 原生 AgentLoop 在 setupAndPublish 里有一句 `await setup?.(prepared.agent.ctx, prepared.agent)`
// —— **预设就是在 options.setup 回调里挂到 agent scope 上的**（回调体做 agentPresets.mount）。
// 本路由早期自己造会话时漏掉了这一步，于是预设行从未挂载，它们读宿主服务时被 cordis
// 反射代理拒绝，建会话直接失败。
//
// 这里断言两件事：setup 被调用，且顺序在 publish（sessions.enter / announce）之前；
// 返回值里的 commit() 也必须被调用（否则预设代际不被确认）。
test("引擎会话建会话时必须调用 options.setup，且早于 publish", async () => {
  const order = [];
  const agent = {
    id: "s-setup",
    ctx: { tag: "agent-ctx" },
    async runMaintenance(job) { return job(); },
    cancel() {},
    async whenIdle() {},
    async dispose() {},
    async announce() {},
  };

  const ctx = {
    logger: { debug() {}, info() {}, warn() {} },
    on() {},
    agents: { enter() { order.push("agents.enter"); return () => {}; }, async announce() { order.push("agents.announce"); } },
    sessions: {
      get: () => undefined,
      prepare: (id) => ({ id }),
      enter() { order.push("sessions.enter"); return () => {}; },
      announce() { order.push("sessions.announce"); },
    },
    get(name) {
      if (name !== "sessionPersistence") return undefined;
      return {
        async create() { order.push("persistence.create"); return { async append() {}, async close() {} }; },
        async open() { return { header: {}, inheritedEventCount: 0, async read() { return { events: [], eventState: "detached" }; }, async append() {}, async close() {} }; },
      };
    },
  };

  let committed = 0;
  const options = {
    sessionId: "s-setup",
    meta: { agentPreset: "claude-code" },
    async setup(setupCtx, setupAgent) {
      order.push("setup");
      assert.equal(setupCtx, agent.ctx, "setup 必须拿到 agent.ctx");
      assert.equal(setupAgent, agent, "setup 必须拿到 agent 本身");
      return { commit() { committed += 1; order.push("setup.commit"); } };
    },
  };

  const router = new EngineRouter(ctx, {
    defaultEngine: DEEPSEEK_ENGINE_ID, engineByPreset: {}, engines: {},
  }, { async createAgent() { throw new Error("not used"); }, async resume() { throw new Error("not used"); } }, makeRegistryWithAgent(agent));

  await router.createAgent({}, options);

  assert.ok(order.includes("setup"), `setup 必须被调用，实际顺序：${order.join(" → ")}`);
  assert.equal(committed, 1, "setup 返回的 commit() 必须被调用一次");
  const setupAt = order.indexOf("setup");
  const publishAt = order.findIndex((step) => step.startsWith("sessions.") || step.startsWith("agents."));
  assert.ok(
    publishAt === -1 || setupAt < publishAt,
    `setup 必须早于 publish（sessions.enter/announce、agents.enter/announce），实际顺序：${order.join(" → ")}`,
  );
});

// 回归护栏（实测故障，两次不同会话都复现）：
//   resume failed for session "session-…": Error: session "session-…" already exists
//
// 成因不是并发，而是**会话已经 live 在 store 里**（页面刷新 / 重连 / 再次点开同一会话）。
// 此时 @deepseek-ai/dsh-session 的 SessionStore.prepare(id) 与 enter(session) 都会抛
// `session "<id>" already exists`。修法：resume 时若会话已 live，就复用该会话对象
// （不 prepare），并用 publishAgentOnly（不 enter/announce 会话，只注册 agent）。
test("resume 时会话已 live：必须复用而不 prepare / 不重复 enter", async () => {
  const liveSession = { id: "s-live", header: { agentPreset: "claude-code" } };
  const calls = { prepare: [], enter: [], announce: [], publishAgentOnly: 0, publish: 0 };

  const ctx = {
    logger: { debug() {}, info() {}, warn() {} },
    on() {},
    agents: {
      enter() { return () => {}; },
      async announce() {},
    },
    sessions: {
      get: (id) => (id === "s-live" ? liveSession : undefined),
      prepare(id) {
        calls.prepare.push(id);
        if (id === "s-live") throw new Error(`session "${id}" already exists`);
        return { id };
      },
      enter(session) {
        calls.enter.push(session.id);
        if (session.id === "s-live") throw new Error(`session "${session.id}" already exists`);
        return () => {};
      },
      announce(session) { calls.announce.push(session.id); },
    },
    get(name) {
      if (name !== "sessionPersistence") return undefined;
      return {
        async open() {
          return {
            header: { agentPreset: "claude-code" },
            inheritedEventCount: 0,
            async read() {
              return {
                events: [{ type: "agent-preset/selected", data: { agentPreset: "claude-code" } }],
                eventState: "detached",
              };
            },
            async append() {},
            async close() {},
          };
        },
      };
    },
  };

  // 假的 AgentLoop：提供 prepare()，返回带 runMaintenance/announce/dispose 的最小 agent。
  const agent = {
    id: "s-live",
    async runMaintenance(job) { return job(); },
    cancel() {},
    async whenIdle() {},
    async dispose() {},
    async announce() {},
  };
  const original = {
    async createAgent() { throw new Error("not used"); },
    async resume() { throw new Error("not used"); },
    prepare() {
      return { agent, signal: new AbortController().signal, dispose: async () => {}, publish: async () => ({ agent, dispose: async () => {} }) };
    },
  };

  const router = new EngineRouter(ctx, {
    defaultEngine: DEEPSEEK_ENGINE_ID, engineByPreset: {}, engines: {},
  }, original, makeRegistryWithAgent(agent));

  await router.resume({}, { resumeSessionId: "s-live" });

  assert.deepEqual(calls.prepare, [], "会话已 live 时不得再 prepare（会抛 already exists）");
  assert.deepEqual(calls.enter, [], "会话已 live 时不得再 enter（会抛 already exists）");
  assert.deepEqual(calls.announce, [], "会话已 live 时不得重发 session/created");
});
