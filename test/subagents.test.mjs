// test/subagents.test.mjs — 子代理（Agent / Task 工具）→ DSH 子会话的生命周期映射。
import { test } from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { SubagentSessionManager } from "../lib/subagents.mjs";

/**
 * 假 agents 服务：agent 注册表在本用例里只需要最小面——`enter/announce` 登记、`get`
 * 反查、detach 注销。载体（lib/child-agent.mjs）的状态上报走宿主 ctx 的事件派发
 * （`agentEvents` → `ctx.events.dispatch`），由 fakeHost 上的真实监听器记账。
 */
function fakeAgents(parentAgent) {
  const store = new Map([[parentAgent.id, parentAgent]]);
  const service = {
    /** enter 记录：{ id, owner }（owner 为 undefined = root）。 */
    entered: [],
    announced: [],
    detached: [],
    /** 宿主监听器收到的状态序列：`<id>:<status>`。 */
    statuses: [],
    /** 模拟第三方 `agent/created` 监听器抛错（serial 派发会据此让 announce 整体失败）。 */
    announceThrows: false,
    /** 模拟注册表直接拒绝登记（enter 就失败）。 */
    enterThrows: false,
    get: (id) => store.get(id),
    enter(agent, owner) {
      if (service.enterThrows) throw new Error("carrier agent rejected by the registry");
      store.set(agent.id, agent);
      service.entered.push({ id: agent.id, owner: owner?.id });
      return () => {
        store.delete(agent.id);
        service.detached.push(agent.id);
      };
    },
    async announce(agent, source) {
      if (service.announceThrows) throw new Error("third-party agent/created listener blew up");
      service.announced.push({ id: agent.id, source });
    },
  };
  return service;
}

/**
 * 假 sessions 服务 + 假 sessionPersistence，联合模拟宿主的两条真实契约：
 *   ① `sessions.enter` 装上事件发布钩子（此后每次 append 都发 `session/event`）；
 *   ② 持久化后端按 `writers.get(session.id)` 路由 `session/event`，没有 write handle 的会话
 *      一个事件都写不出去（见 @deepseek-ai/dsh-session-persistence-jsonl 的 install()）。
 * 于是「事件是否完整进日志」在测试里是可断言的结果，而不是内部实现细节。
 *
 * ctx 用**真 cordis Context**（与 test/agent.test.mjs 同款）：载体要建真作用域
 * （`createScope`）、经真事件派发上报状态，这两条只有真 ctx 才跑得通——也才能让「根 ctx 上的
 * 监听器能收到子作用域派发的 agent/status」这条生产契约在单测里被覆盖。
 */
function fakeHost({ deferCreate = false, withPersistence = true, withAgents = true, announceThrows = false, enterThrows = false } = {}) {
  const writers = new Map();
  const created = [];
  const calls = [];

  const persistence = {
    created: [],
    pendingCreates: [],
    create(header, options) {
      const handle = {
        id: header.id,
        header,
        options,
        batches: [],
        closed: false,
        append: async (events) => { handle.batches.push(...events); },
        close: async () => { handle.closed = true; },
        storedEvents: () => handle.batches,
      };
      // 后端路由：与 jsonl 后端同形——handle 上的 enqueueLive 把事件排进同一本日志。
      handle.enqueueLive = (event) => { handle.batches.push(event); };
      persistence.created.push(handle);
      const materialize = () => { writers.set(header.id, handle); return handle; };
      if (!deferCreate) return Promise.resolve(materialize());
      return new Promise((resolve) => persistence.pendingCreates.push(() => resolve(materialize())));
    },
  };

  const sessions = {
    created,
    calls,
    /** 记录插件传给 prepare 的会话 id：断言它由插件显式铸造，而不是交给宿主计数器分配。 */
    prepareIds: [],
    prepare(_id, options) {
      sessions.prepareIds.push(_id);
      const session = {
        id: `child-${created.length + 1}`,
        header: { id: `child-${created.length + 1}`, createdAt: 1791000000000, cwd: options.meta.cwd },
        meta: options.meta,
        inheritedEventCount: 0,
        appended: [],
        live: false,
        append(type, data, opts) {
          const event = { type, data, opts, seq: this.appended.length };
          this.appended.push(event);
          // 发布钩子：只有 enter 之后才有，且只送给已经取到写所有权的会话。
          if (this.live) writers.get(this.id)?.enqueueLive(event);
          return event;
        },
        requestContext: () => undefined,
        requestHeader: () => undefined,
        snapshotEvents(from = 0) {
          return this.appended.slice(from);
        },
      };
      created.push(session);
      return session;
    },
    enter(session) {
      calls.push(`enter:${session.id}`);
      session.live = true;
      return () => calls.push(`detach:${session.id}`);
    },
    announce(session) {
      calls.push(`announce:${session.id}`);
    },
    flush: async (session) => { calls.push(`flush:${session.id}`); },
  };

  // 后端路由：与 jsonl 后端同形——handle 上的 enqueueLive 把事件排进同一本日志。
  const parentSession = {
    id: "session-main",
    header: { cwd: "C:\\work" },
    appended: [],
    append(type, data, opts) {
      const event = { type, data, opts, seq: this.appended.length };
      this.appended.push(event);
      return event;
    },
  };

  const warnings = [];
  // 父 agent 已在注册表里（生产里主 agent 由宿主工厂登记）：载体的 owner 就是它。
  const parentAgent = { id: parentSession.id, session: parentSession, status: "running" };
  const agents = fakeAgents(parentAgent);
  agents.announceThrows = announceThrows;
  agents.enterThrows = enterThrows;

  const ctx = new Context();
  ctx.provide("sessions", sessions);
  if (withPersistence) ctx.provide("sessionPersistence", persistence);
  if (withAgents) ctx.provide("agents", agents);
  ctx.logger = { warn: (message) => warnings.push(message), info: () => {} };
  // 宿主侧监听器（生产里是 dsh-api-session-controller）：收到 agent/status 才可能把会话
  // 标成 running——lineage 面板的「正在运行」就来自这一条。
  ctx.on("agent/status", ({ agent, status }) => { agents.statuses.push(`${agent.id}:${status}`); });

  return { ctx, sessions, persistence, agents, parentSession, parentAgent, warnings };
}

function makeManager(options) {
  const host = fakeHost(options);
  const manager = new SubagentSessionManager(host.ctx, { mainSession: host.parentSession, cwd: "C:\\work" });
  return { manager, host, child: () => host.sessions.created[0] };
}

/** 等所有已排队的微任务跑完（create/flush 都是 Promise 链）。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 主线程 assistant：Agent 工具发出 tool_use。 */
function spawnMessage(toolUseId, input) {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "Agent", input }] },
  };
}

/** 主线程 user：Agent 工具的 tool_result。 */
function toolResultMessage(toolUseId, text, isError = false) {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: text, is_error: isError }] },
  };
}

const childEventTypes = (child) => child.appended.map((event) => event.type);
const childTexts = (child) => child.appended
  .filter((event) => event.type === "assistant/message")
  .map((event) => event.data.message.content.map((block) => block.text ?? "").join(""));

// 回归护栏（实测故障：界面上「无法获取到子代理的数据」）。
//
// 本机 Claude Code 版本里 Agent 工具**默认就是后台异步启动**：即使入参里没有
// run_in_background，工具也会立刻返回一条「Async agent launched successfully」的元数据
// tool_result，真正的产出随后作为 parent_tool_use_id 命中的转发消息到达，完成信号是
// system/task_notification。旧实现把这个**启动回执**当成子代理结束，子会话当场被收尾，
// 之后所有转发消息都被 #closedToolUseIds 丢弃——子会话里一条内容都不剩。
test("后台子代理：启动回执不收尾，转发消息进子会话，task_notification 才收尾", async () => {
  const { manager, host, child } = makeManager();
  const toolUseId = "call_00_JlGePuqPdw7yyq49WhJ15568";

  manager.handleMessage(spawnMessage(toolUseId, { description: "Generate AUTH cases", subagent_type: "general-purpose" }));
  // SDK 在启动回执之前先发 task_started，带上 is_backgrounded
  manager.handleMessage({
    type: "system",
    subtype: "task_started",
    task_id: "ab876c163205eb253",
    tool_use_id: toolUseId,
    description: "Generate AUTH cases",
    subagent_type: "general-purpose",
    is_backgrounded: true,
  });
  manager.handleMessage(toolResultMessage(toolUseId, "Async agent launched successfully. agentId: ab876c163205eb253"));
  // 子代理真正的产出（SDK 转发）
  manager.handleMessage({
    type: "assistant",
    parent_tool_use_id: toolUseId,
    message: { role: "assistant", content: [{ type: "text", text: "AUTH 26 条已写入 parts/AUTH.json" }] },
  });
  manager.handleMessage({
    type: "system",
    subtype: "task_notification",
    task_id: "ab876c163205eb253",
    tool_use_id: toolUseId,
    status: "completed",
    summary: "AUTH 26, PRJ 20, MEM 26, GCA 20",
  });
  await settle();

  const kid = child();
  assert.ok(kid, "应当为子代理建立子会话");
  assert.deepEqual(childTexts(kid), ["AUTH 26 条已写入 parts/AUTH.json"], "转发消息必须写进子会话");
  assert.equal(childEventTypes(kid).filter((type) => type === "turn/end").length, 1, "只收尾一次");
  assert.equal(childEventTypes(kid).at(-1), "turn/end");
  assert.equal(kid.appended.at(-1).data.reason.kind, "completed");
  assert.equal(host.sessions.calls.filter((c) => c === "announce:child-1").length, 1);
});

test("run_in_background 明确为 true 时，启动回执同样不收尾", async () => {
  const { manager, child } = makeManager();
  const toolUseId = "call_bg";
  manager.handleMessage(spawnMessage(toolUseId, { description: "bg", prompt: "p", run_in_background: true }));
  manager.handleMessage(toolResultMessage(toolUseId, "running in the background"));
  manager.handleMessage({
    type: "assistant",
    parent_tool_use_id: toolUseId,
    message: { role: "assistant", content: [{ type: "text", text: "后台产出" }] },
  });

  const kid = child();
  assert.equal(childEventTypes(kid).includes("turn/end"), false, "后台子代理在完成通知前不得收尾");

  // 流关闭（CLI 退出）时兜底收掉，此时待结算的助手消息才落盘
  manager.finishRun({});
  await settle();
  assert.deepEqual(childTexts(kid), ["后台产出"]);
  assert.equal(childEventTypes(kid).filter((type) => type === "turn/end").length, 1);
});

test("前台子代理：tool_result 就是产出，仍以它收尾", async () => {
  const { manager, child } = makeManager();
  const toolUseId = "call_fg";
  manager.handleMessage(spawnMessage(toolUseId, { description: "fg", prompt: "p", subagent_type: "general-purpose" }));
  manager.handleMessage({
    type: "assistant",
    parent_tool_use_id: toolUseId,
    message: { role: "assistant", content: [{ type: "text", text: "前台产出" }] },
  });
  manager.handleMessage(toolResultMessage(toolUseId, "前台子代理的最终答复"));
  await settle();

  const kid = child();
  assert.deepEqual(childTexts(kid), ["前台产出"]);
  assert.equal(childEventTypes(kid).filter((type) => type === "turn/end").length, 1);
  assert.equal(kid.appended.at(-1).data.reason.kind, "completed");
});

test("回合结束仍有未收尾的子代理时，一并收掉（CLI 退出后不会再有人来通知）", async () => {
  const { manager, child } = makeManager();
  const toolUseId = "call_open";
  manager.handleMessage(spawnMessage(toolUseId, { description: "open", prompt: "p", run_in_background: true }));
  manager.handleMessage(toolResultMessage(toolUseId, "Async agent launched successfully"));

  manager.finishRun({});
  await settle();

  const kid = child();
  assert.equal(childEventTypes(kid).at(-1), "turn/end", "流结束时必须把子会话收干净");
});

// 回归护栏（实测故障：lineage 树里没有子会话，`subagentCatalog` 为空）。
//
// `subagentCatalog` 不是宿主会话名录，而是**父会话**上 `subagent/catalog` 事件的投影
// （@deepseek-ai/dsh-subagent 的 subagentCatalogProjectionDefinition）。只把子会话塞进
// sessions store 而不往父会话写这条事实，lineage 树就永远是空的。
test("建子会话时向父会话写 subagent/catalog", async () => {
  const { manager, host } = makeManager();
  const toolUseId = "call_00_cat";
  manager.handleMessage(spawnMessage(toolUseId, { description: "Reply PONG", subagent_type: "general-purpose" }));
  await settle();

  const catalog = host.parentSession.appended.filter((event) => event.type === "subagent/catalog");
  assert.equal(catalog.length, 1, "每个子代理恰好写一条 catalog 事实");
  assert.deepEqual(catalog[0].data, {
    version: 0,
    childId: "child-1",
    childCreatedAt: 1791000000000,
    mode: "one-shot",
    label: "Reply PONG",
  });
});

// 回归护栏（实测故障：应用重启后子会话 id 又变成 session-1，撞上上一轮已落盘的产物，
// 持久化后端拒绝为已存在的 id 建记录 → 这次子代理的轨迹被静默丢弃；父 catalog 里随即出现
// 两个同名子节点，点开都是旧那份）。
//
// 宿主 `sessions.prepare(undefined)` 用的是进程内计数器 `session-${++counter}`，只对 live
// store 去重、**不查已落盘会话**，所以应用一重启计数器归零，必然重号。插件必须自己铸一个
// 跨进程唯一的 id（与原生子代理的 SessionId(randomUUID()) 对齐）。
test("子会话 id 由插件显式铸唯一值，不依赖宿主 prepare(undefined) 的计数器", async () => {
  const { manager, host } = makeManager();
  manager.handleMessage(spawnMessage("call_a", { description: "a" }));
  manager.handleMessage(spawnMessage("call_b", { description: "b" }));
  await settle();

  const ids = host.sessions.prepareIds;
  assert.equal(ids.length, 2, "两个子代理应各建一个子会话");
  for (const id of ids) {
    assert.equal(typeof id, "string");
    assert.ok(id.length > 0, "必须显式传入会话 id（不能交给宿主计数器，即不能是 undefined）");
  }
  assert.notEqual(ids[0], ids[1], "两个子会话的 id 必须不同");
});

// 回归护栏（实测故障：子会话目录/文件一个都没落盘；宿主投影 subagentCatalog 也为空）。
//
// 写日志的不是 agents.enter/announce（那只管 agents store 与 agent/created 通知），而是
// sessionPersistence：jsonl 后端按 writers.get(session.id) 路由 session/event，没取到写
// 所有权的会话**一个事件都写不出去**。所以建子会话必须像原生 AgentLoop 那样取一份写所有权，
// 并把「发布之前」写进内存的事件补写进日志。
test("子会话取写所有权：发布前的事件补写进日志，发布后的事件按 id 路由", async () => {
  const { manager, host, child } = makeManager();
  const toolUseId = "call_00_store";
  manager.handleMessage(spawnMessage(toolUseId, { description: "Reply PONG" }));
  manager.handleMessage(toolResultMessage(toolUseId, "Async agent launched successfully"));
  manager.handleMessage({
    type: "assistant",
    parent_tool_use_id: toolUseId,
    message: { role: "assistant", content: [{ type: "text", text: "PONG" }] },
  });
  manager.handleMessage({
    type: "system", subtype: "task_notification", tool_use_id: toolUseId, status: "completed", summary: "PONG",
  });
  await settle();

  const kid = child();
  assert.equal(host.persistence.created.length, 1, "必须为子会话取一份写所有权");
  const handle = host.persistence.created[0];
  assert.equal(handle.id, kid.id);
  assert.equal(handle.options.inheritedEventCount, 0);

  // 结果层断言：会话里的事件**一条不少、不重、按序**地进了日志。
  const stored = handle.storedEvents().map((event) => `${event.type}#${event.seq}`);
  const memory = kid.appended.map((event) => `${event.type}#${event.seq}`);
  assert.deepEqual(stored, memory, "落盘日志必须与内存事件逐条一致（无丢失、无重复、无乱序）");
  assert.ok(stored.length > 0);
});

test("写所有权还没到手就收尾，事件也不能丢", async () => {
  const { manager, host, child } = makeManager({ deferCreate: true });
  const toolUseId = "call_00_slow";
  manager.handleMessage(spawnMessage(toolUseId, { description: "slow" }));
  manager.handleMessage(toolResultMessage(toolUseId, "Async agent launched successfully"));
  manager.finishRun({});          // create 还没 resolve
  for (const release of host.persistence.pendingCreates) release();
  await settle();

  const kid = child();
  const handle = host.persistence.created[0];
  assert.deepEqual(
    handle.storedEvents().map((event) => `${event.type}#${event.seq}`),
    kid.appended.map((event) => `${event.type}#${event.seq}`),
  );
});

test("没有持久化后端时降级：照旧建会话、照旧写 catalog", async () => {
  const host = fakeHost({ withPersistence: false });
  const manager = new SubagentSessionManager(host.ctx, { mainSession: host.parentSession, cwd: "C:\\work" });
  manager.handleMessage(spawnMessage("call_no_pers", { description: "nop" }));
  await settle();

  assert.equal(host.persistence.created.length, 0);
  assert.equal(host.parentSession.appended.filter((e) => e.type === "subagent/catalog").length, 1);
});

// 发布链的 Promise 可能直到收尾/销毁才被消费；中间一旦 reject 就是未处理的 rejection
// （Node 15+ 默认据此终止进程）。所以建会话时就必须把失败接住。
test("发布失败只记日志，不让 ready 变成未处理 rejection", async () => {
  const host = fakeHost();
  const warnings = [];
  host.ctx.logger = { warn: (message) => warnings.push(message), info: () => {} };
  host.sessions.enter = () => { throw new Error("session already exists"); };
  const manager = new SubagentSessionManager(host.ctx, { mainSession: host.parentSession, cwd: "C:\\work" });

  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    manager.handleMessage(spawnMessage("call_boom", { description: "boom" }));
    await settle();
  } finally {
    process.off("unhandledRejection", onRejection);
  }

  assert.deepEqual(rejections, [], "不得产生未处理的 rejection");
  assert.equal(warnings.some((m) => m.includes("could not be published")), true, "失败必须留下日志");
});

// 回归护栏（实测故障：正在跑的子代理在 lineage 面板里显示「一次性 · 当前未运行」，灰点，
// 表头也不出现「正在运行」计数）。
//
// 面板的运行状态**只**来自宿主对子会话的 running 判定，而 running 只可能由「该会话在
// ctx.agents 注册表里有一个 status==='running' 的 Agent」产生
// （dsh-api-session-controller 的 summaryFor 读 agents.get(id).status；api-session/status
// 只由 agent/status 派发）。插件此前只把子会话塞进 sessions store、不挂 Agent（README 的
// 「只读投影」），于是正在执行的子代理永远没有 running 可言。
// 修法：给每个子会话登记一个只做状态载体的被动 Agent（不驱动模型、不可续跑），
// 建会话即报 running，收尾报 idle 并注销。
test("状态载体：建会话即上报 running（owner 是父 agent），收尾上报 idle 并注销", async () => {
  const { manager, host, child } = makeManager();
  const toolUseId = "call_00_carrier";

  manager.handleMessage(spawnMessage(toolUseId, { description: "carry", prompt: "p" }));
  await settle();

  const kid = child();
  assert.deepEqual(host.agents.entered, [{ id: kid.id, owner: "session-main" }],
    "载体必须以**子会话 id** 登记，且 owner 是父 agent（与原生子代理同为「父所有」，不是 root）");
  assert.deepEqual(host.agents.announced.map((entry) => entry.id), [kid.id], "登记后要 await announce 走完 agent/created");
  assert.deepEqual(host.agents.statuses, [`${kid.id}:running`], "登记后必须上报 running —— 面板的「正在运行」就靠它");
  assert.equal(host.agents.get(kid.id)?.status, "running");

  // 收尾：turn/end 之后必须把载体注销，否则会话永远停在「运行中」
  manager.handleMessage({
    type: "system", subtype: "task_notification", tool_use_id: toolUseId, status: "completed", summary: "done",
  });
  await settle();

  assert.deepEqual(host.agents.statuses, [`${kid.id}:running`, `${kid.id}:idle`], "收尾必须先上报 idle 再注销");
  assert.deepEqual(host.agents.detached, [kid.id], "收尾必须 detach 载体");
  assert.equal(host.agents.get(kid.id), undefined);
  assert.equal(kid.appended.at(-1).type, "turn/end", "载体注销不得打乱子会话的收尾事件");
});

test("状态载体：前台子代理收尾（父 tool_result）同样注销", async () => {
  const { manager, host, child } = makeManager({});
  const toolUseId = "call_fg_carrier";
  manager.handleMessage(spawnMessage(toolUseId, { description: "fg", prompt: "p" }));
  // 真实的消费循环是 `for await`：每条 SDK 消息各占一个任务，发布链（写所有权 → 载体登记）
  // 总在子代理真正跑起来之前走完。这里显式 settle 一次，对齐这个边界。
  await settle();
  manager.handleMessage({
    type: "assistant",
    parent_tool_use_id: toolUseId,
    message: { role: "assistant", content: [{ type: "text", text: "前台产出" }] },
  });
  manager.handleMessage(toolResultMessage(toolUseId, "前台最终答复"));
  await settle();

  const kid = child();
  assert.deepEqual(host.agents.statuses, [`${kid.id}:running`, `${kid.id}:idle`]);
  assert.deepEqual(host.agents.detached, [kid.id]);
});

// 载体登记是**辅助信号**：登记失败只记日志，子会话本身、catalog、落盘都不得受影响。
//
// 两种失败各有各的处置（与 router.mjs 的 publishResilient 同一判据）：
//   - `enter` 失败 = 什么都没进注册表 → 收干净走人，面板维持「当前未运行」（与修复前一致）；
//   - `announce` 失败 = 已进注册表、只少了一次 `agent/created` 通知（serial 派发里任一第三方
//     监听器抛错都会这样）→ **保留 entry**：宿主的 running 判定读的是注册表里的 agent
//     （summaryFor 的 agents.get），不是那次通知。
test("载体 enter 失败只记日志：子会话、catalog、落盘都不受影响", async () => {
  const { manager, host, child } = makeManager({ enterThrows: true });
  const toolUseId = "call_00_carrier_boom";
  manager.handleMessage(spawnMessage(toolUseId, { description: "boom", prompt: "p" }));
  manager.handleMessage(toolResultMessage(toolUseId, "Async agent launched successfully"));
  manager.handleMessage({
    type: "assistant",
    parent_tool_use_id: toolUseId,
    message: { role: "assistant", content: [{ type: "text", text: "PONG" }] },
  });
  manager.handleMessage({
    type: "system", subtype: "task_notification", tool_use_id: toolUseId, status: "completed", summary: "PONG",
  });
  await settle();

  const kid = child();
  assert.ok(kid, "子会话照建");
  assert.deepEqual(childTexts(kid), ["PONG"], "子轨迹照写");
  assert.equal(host.parentSession.appended.filter((e) => e.type === "subagent/catalog").length, 1, "catalog 照写");
  assert.equal(host.agents.get(kid.id), undefined, "没进注册表就不该留 entry");
  assert.deepEqual(host.agents.statuses, [], "没登记成功就不该上报任何状态");
  assert.equal(host.warnings.some((m) => m.includes("carrier")), true, "失败必须留下日志");
});

test("载体 announce 被第三方监听器打断时保留 entry：运行状态照报", async () => {
  const { manager, host, child } = makeManager({ announceThrows: true });
  const toolUseId = "call_00_notify_fail";
  manager.handleMessage(spawnMessage(toolUseId, { description: "notify", prompt: "p" }));
  await settle();

  const kid = child();
  assert.ok(host.agents.get(kid.id), "已进注册表 → 必须保留（宿主的 running 判定读的就是它）");
  assert.deepEqual(host.agents.statuses, [`${kid.id}:running`], "通知失败不影响状态上报");
  assert.equal(host.warnings.some((m) => m.includes("notification failed")), true, "降级必须留下日志");

  manager.handleMessage({
    type: "system", subtype: "task_notification", tool_use_id: toolUseId, status: "completed", summary: "done",
  });
  await settle();
  assert.deepEqual(host.agents.statuses, [`${kid.id}:running`, `${kid.id}:idle`]);
  assert.deepEqual(host.agents.detached, [kid.id], "收尾照旧注销");
});

test("没有 agents 服务时降级：子会话与 catalog 照旧，不报状态", async () => {
  const { manager, host, child } = makeManager({ withAgents: false });
  manager.handleMessage(spawnMessage("call_no_agents", { description: "no-agents" }));
  await settle();

  const kid = child();
  assert.ok(kid);
  assert.equal(host.parentSession.appended.filter((e) => e.type === "subagent/catalog").length, 1);
  assert.deepEqual(host.agents.statuses, []);
});

test("收尾早于登记（发布链还没走完）时，不闪一次 running，且照旧注销", async () => {
  const { manager, host, child } = makeManager({ deferCreate: true });
  const toolUseId = "call_00_rush";
  manager.handleMessage(spawnMessage(toolUseId, { description: "rush", prompt: "p" }));
  manager.handleMessage(toolResultMessage(toolUseId, "Async agent launched successfully"));
  manager.finishRun({});               // create 还没 resolve 就收尾
  for (const release of host.persistence.pendingCreates) release();
  await settle();

  const kid = child();
  assert.deepEqual(host.agents.statuses, [], "从未标成 running 的子代理不该上报状态（面板靠 turn/end 判「已完成」）");
  assert.deepEqual(host.agents.detached, [kid.id], "登记完成后要立刻注销");
  assert.equal(host.agents.get(kid.id), undefined);
});
