// test/apply.test.mjs — 插件 apply() 与真实 cordis Context 的接线测试。
//
// 这一层测的是「装上之后到底接上了没有」：工厂槽位被接管、原来的工厂还留着以便释放时换回、
// 引擎注册表暴露成服务、休眠 LLM 路由注册进 llm、配置了 enabled=false 时完全不介入。
// 不启动真实 agent-loop，用最小的假服务代替（本插件的契约只用到它们的这几个方法）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { apply, Config, name, inject, CLAUDE_CODE_ENGINE_ID, DEEPSEEK_ENGINE_ID } from "../index.mjs";

/** 造一个装了最小假服务的 Context。 */
function makeContext({ withLlm = true, withFactory = true } = {}) {
  const ctx = new Context();
  const originalFactory = {
    tag: "original",
    createAgent: async () => ({ agent: { id: "native" }, dispose: async () => {} }),
    resume: async () => ({ agent: { id: "native" }, dispose: async () => {} }),
  };
  // 复刻 AgentRegistry 的 setFactory 契约：effect-scoped、先到先得、返回 disposer。
  const factoryCalls = [];
  const agents = {
    ...(withFactory ? { factory: { target: originalFactory } } : {}),
    setFactory(factory) {
      factoryCalls.push(factory);
      if (agents.factory !== undefined) throw new Error("an agent factory is already registered");
      agents.factory = { target: factory };
      return () => { agents.factory = undefined; };
    },
  };
  ctx.provide("agents", agents);
  ctx.provide("sessions", { get: () => undefined });
  ctx.provide("sessionPersistence", { open: async () => ({}), create: async () => ({}) });
  const registered = [];
  if (withLlm) {
    ctx.provide("llm", {
      registerAdapter(providers, adapter) {
        registered.push({ providers, adapter });
        return () => registered.splice(registered.indexOf(registered.find((r) => r.adapter === adapter)), 1);
      },
    });
  }
  return { ctx, originalFactory, registered, agents, factoryCalls };
}

const config = { enabled: true, defaultEngine: DEEPSEEK_ENGINE_ID, engineByPreset: {}, engines: {} };

/** 模拟宿主里 cordis 的服务就绪通知（插件正是靠它决定何时接管工厂）。 */
function emitServiceReady(ctx, name = "agents") {
  ctx.events.emit(ctx, "internal/service", name, ctx.get(name));
}

test("插件导出符合 Loader 的函数式插件约定", () => {
  assert.equal(name, "dsh-claude-code");
  assert.ok(Array.isArray(inject));
  assert.ok(inject.includes("agents"));
  assert.ok(inject.includes("sessions"));
  assert.equal(typeof apply, "function");
  assert.equal(typeof Config, "function", "Config 应当是 schemastery 的 schema 构造器");
});

test("Config schema 提供默认值", () => {
  const resolved = new Config({});
  assert.equal(resolved.enabled, true, "默认启用");
  // 主循环接管默认关闭：它替换的是宿主全局 agent factory，一旦出问题会让宿主启动失败，
  // 进而触发 DSH 的 profile 恢复（清空用户配置）。这种破坏性能力必须显式开启。
  assert.equal(resolved.routeMainLoop, false, "默认不接管主循环");
  assert.equal(resolved.defaultEngine, DEEPSEEK_ENGINE_ID);
  assert.deepEqual(resolved.engineByPreset, {});
  assert.deepEqual(resolved.engines, {});
});

test("默认（routeMainLoop=false）不碰全局 agent factory，只注册引擎服务", () => {
  const { ctx, originalFactory, registered } = makeContext();

  apply(ctx, config);

  assert.equal(ctx.agents.factory.target, originalFactory, "全局工厂必须保持原样");
  assert.equal(registered.length, 0, "不接管时不该注册休眠 LLM 路由");
  const registry = ctx.get("claudeCodeEngines");
  assert.ok(registry, "引擎注册表仍要暴露（预设与第三方引擎依赖它）");
  assert.equal(registry.get(CLAUDE_CODE_ENGINE_ID)?.id, CLAUDE_CODE_ENGINE_ID);
});

// 回归护栏（这是「预设是 claude-code，主循环却没被替换」的根因）：
// 本插件 inject: ["agents", …]，apply() 必然在 agents 服务就绪之后才跑，而 cordis 的
// `internal/service` 事件在服务实现变化时就已发过。所以**只挂事件监听会永远收不到通知**，
// attached 恒为 false。接管必须在 apply() 当下就完成（那时槽位里通常已有 agent-loop 的工厂）。
test("routeMainLoop=true：apply() 当下就接管，不等服务事件", () => {
  const { ctx, originalFactory, factoryCalls } = makeContext();

  apply(ctx, { ...config, routeMainLoop: true });
  // 刻意不发 internal/service：真实宿主里这个事件在我们能监听到之前就已经发过了。

  const factory = ctx.agents.factory?.target;
  assert.ok(factory, "槽位必须被接管");
  assert.notEqual(factory, originalFactory, "槽位里应当是路由工厂");
  assert.equal(typeof factory.createAgent, "function");
  assert.equal(typeof factory.resume, "function");
  assert.equal(typeof factory.engineIdFor, "function");
  assert.equal(factory.original, originalFactory, "原工厂必须被包住，原生会话才能委托回去");
  assert.equal(factoryCalls.length, 0, "槽位非空时不能调 setFactory（它会抛，并会挤掉 required 的 agent-loop）");

  const registry = ctx.get("claudeCodeEngines");
  assert.ok(registry, "必须暴露 claudeCodeEngines 服务");
  assert.equal(registry.get(CLAUDE_CODE_ENGINE_ID)?.id, CLAUDE_CODE_ENGINE_ID);
  assert.deepEqual(registry.list().map((engine) => engine.id), [CLAUDE_CODE_ENGINE_ID]);
  assert.equal(typeof registry.get(CLAUDE_CODE_ENGINE_ID).makeAgent, "function");
});

test("释放插件时把槽位交还原工厂", async () => {
  const { ctx, agents, originalFactory } = makeContext();

  apply(ctx, { ...config, routeMainLoop: true });
  assert.notEqual(agents.factory.target, originalFactory);

  // 触发插件 fiber 的释放效果：apply 里注册的 effect 会在卸载时执行。
  // （ctx 自己的服务在释放后不可读，所以断言用提前持有的 agents 引用。）
  await ctx.fiber.dispose();
  assert.equal(agents.factory?.target, originalFactory, "槽位必须还原");
});

// 回归护栏（这是「装了插件就没法用、只能清配置」的根因）：
// @deepseek-ai/dsh-agent-loop 是 required 行，它在构造函数里调 ctx.agents.setFactory(this)，
// 而 setFactory 先到先得、已有工厂就抛 `an agent factory is already registered`。
// 本插件若在它之前占住槽位，那一行就会激活失败 → 宿主启动失败 → DSH profile 恢复
// （重写 cordis.patch.yml、清空 node_modules）。所以插槽为空时必须**等待**，绝不抢占。
test("工厂尚未注册时绝不抢占据位（否则会挤掉 required 的 agent-loop 行）", () => {
  const { ctx, agents, factoryCalls } = makeContext({ withFactory: false });

  assert.doesNotThrow(() => apply(ctx, { ...config, routeMainLoop: true }));

  assert.equal(factoryCalls.length, 0, "工厂没就绪时一次都不该调用 setFactory");
  assert.equal(agents.factory, undefined, "槽位必须保持为空，留给 agent-loop 注册");
  assert.equal(agents.factory, undefined, "空槽位下收到服务事件也不该占位");
});

test("槽位当时为空：等到 agent-loop 注册并发出服务事件后才接管", () => {
  const { ctx, agents, originalFactory, factoryCalls } = makeContext({ withFactory: false });

  apply(ctx, { ...config, routeMainLoop: true });
  assert.equal(agents.factory, undefined, "此刻不能占位");

  // 模拟 agent-loop 行注册自己的工厂（真实里它会调 setFactory）。
  agents.factory = { target: originalFactory };
  emitServiceReady(ctx);

  assert.equal(agents.factory.target === originalFactory, false, "服务事件到达后应当接管");
  assert.equal(agents.factory.target.original, originalFactory, "并包住原工厂");
  assert.equal(factoryCalls.length, 0, "仍然不调用 setFactory（槽位非空）");
});

// 回归护栏（真实宿主里的实际形状）：槽位是 agent-loop **激活时**才填上的，而那一刻 cordis
// 补发的通知名字是它自己提供的服务（`AgentLoop` → `agentLoop`），不是 `agents`。只认
// name === "agents" 会永远等不到通知，attached 恒为 false（实测：隔离实例里 30+ 个
// claude-code 会话没有一个 provider 是 claude-code）。
test("槽位为空：agent-loop 激活时的通知（服务名不是 agents）也必须能接管", () => {
  const { ctx, agents, originalFactory, factoryCalls } = makeContext({ withFactory: false });

  apply(ctx, { ...config, routeMainLoop: true });
  assert.equal(agents.factory, undefined, "此刻不能占位");

  agents.factory = { target: originalFactory };
  ctx.events.emit(ctx, "internal/service", "agentLoop", {});

  assert.notEqual(agents.factory.target, originalFactory, "不能只认 name === 'agents'");
  assert.equal(agents.factory.target.original, originalFactory, "并包住原工厂");
  assert.equal(factoryCalls.length, 0, "仍然不调用 setFactory（槽位非空）");
});

// 同一处（fiber._updateState）还会发 internal/status；它也是「agent-loop 已激活」的信号。
test("槽位为空：fiber 状态变化（internal/status）也必须能接管", () => {
  const { ctx, agents, originalFactory } = makeContext({ withFactory: false });

  apply(ctx, { ...config, routeMainLoop: true });
  agents.factory = { target: originalFactory };
  ctx.events.emit(ctx, "internal/status", {}, "pending");

  assert.notEqual(agents.factory.target, originalFactory, "状态变化后应当接管");
  assert.equal(agents.factory.target.original, originalFactory, "并包住原工厂");
});

test("apply 注册休眠的 claude-code LLM 路由（仅接管时）", () => {
  const { ctx, registered } = makeContext();

  apply(ctx, { ...config, routeMainLoop: true });

  assert.equal(registered.length, 1);
  assert.deepEqual(registered[0].providers, ["claude-code"]);
  assert.equal(registered[0].adapter.providerInfo("claude-code").name, "Claude Code");
  assert.throws(() => registered[0].adapter.stream(), /driven by the Claude Code CLI/);
});

test("没有 llm 注册表时跳过路由注册而不是报错", () => {
  const { ctx } = makeContext({ withLlm: false });
  assert.doesNotThrow(() => apply(ctx, { ...config, routeMainLoop: true }));
  assert.ok(ctx.agents.factory?.target, "工厂仍然要被接管");
});

test("enabled=false 时完全不介入", () => {
  const { ctx, originalFactory, registered } = makeContext();

  apply(ctx, { ...config, enabled: false });

  assert.equal(ctx.agents.factory.target, originalFactory, "槽位必须保持原样");
  assert.equal(ctx.get("claudeCodeEngines"), undefined);
  assert.equal(registered.length, 0);
});
