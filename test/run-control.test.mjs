import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { RunInputChannel } from "../lib/run-input.mjs";
import { attachFacts } from "./helpers/plugin-facts.mjs";
import { wireGoalFixture } from "./helpers/goal-fixture.mjs";

let active;
let onQuery;
let queryError;
mock.module("@anthropic-ai/claude-agent-sdk", { namedExports: {
  query: ({ prompt, options }) => {
    if (queryError) throw queryError;
    const output = new RunInputChannel();
    const first = Promise.withResolvers();
    const ended = Promise.withResolvers();
    const waiters = [];
    const input = [];
    const fake = {
      input, output, options, first: first.promise, ended: ended.promise, interrupts: 0, closes: 0,
      receipt: { still_queued: [] },
      waitInput(count) {
        if (input.length >= count) return Promise.resolve();
        return new Promise((resolve) => waiters.push({ count, resolve }));
      },
      emit: (message) => output.push(message),
      finish: () => output.close(),
      async interrupt() { fake.interrupts += 1; return fake.receipt; },
      close() { fake.closes += 1; output.close(); },
      [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
    };
    active = fake;
    onQuery?.(fake);
    void (async () => {
      if (typeof prompt === "string") { input.push({ legacy: prompt }); first.resolve(); ended.resolve(); return; }
      for await (const message of prompt) {
        input.push(message);
        first.resolve();
        for (const waiter of waiters) if (input.length >= waiter.count) waiter.resolve();
      }
      ended.resolve();
    })();
    return fake;
  },
  createSdkMcpServer: (options) => options,
  tool: (name, description, inputSchema, handler) => ({ name, description, inputSchema, handler }),
} });
mock.module("../lib/auth.mjs", { namedExports: { resolveClaude: async () => ({ executable: "fake-claude", env: {} }) } });
const { runClaudeCode } = await import("../lib/claude-run.mjs");
const { ClaudeCodeAgent } = await import("../lib/agent.mjs");

function session(onNativeEvent = () => {}) {
  const events = [];
  const waiters = [];
  return attachFacts({ id: "s1", header: { cwd: "/w" }, events,
    waitEvent(predicate) {
      const existing = this.factEvents().find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
    append(type, data, opts) {
      const event = { type, data, opts, seq: events.length }; events.push(event);
      onNativeEvent(event);
      for (const waiter of waiters) if (waiter.predicate(event)) waiter.resolve(event);
      return event;
    },
    snapshotEvents: () => events,
    requestContext: () => undefined,
    requestHeader: () => undefined,
  }, [], (event) => {
    for (const waiter of waiters) if (waiter.predicate(event)) waiter.resolve(event);
  });
}
const message = (id, kind = "user") => ({ id, role: "user", source: kind === "goal"
  ? { kind, goalId: "g1", revision: 1, round: 1 } : { kind }, content: [{ type: "text", text: id }] });
function start(options = {}) {
  active = undefined;
  const s = options.session ?? session();
  const signal = options.signal ?? new AbortController().signal;
  let control;
  const run = runClaudeCode({ ctx: { get: () => undefined, logger: { warn() {} } }, config: {},
    session: s, agent: { id: "s1" }, turn: 1, prompt: "u1", initialMessages: [message("u1")],
    signal, cwd: "/w", executable: "fake-claude", env: {}, ...options,
    onReady: (value) => { control = value; options.onReady?.(value); },
  });
  return { s, run, control: () => control, fake: () => active };
}
const success = (uuid) => ({ type: "result", subtype: "success", result: "done", user_message_uuid: uuid });
function makeAgent(attachments) {
  active = undefined;
  const ctx = new Context();
  let agent;
  const goal = wireGoalFixture(ctx, () => agent);
  if (attachments) ctx.provide("attachments", attachments);
  const s = session(event => goal.onNativeEvent(event));
  agent = new ClaudeCodeAgent(ctx, "s1", {}, s, { traceSubagents: false });
  return { s, agent, goal };
}
const imageMessage = (id) => ({ ...message(id), content: [{ type: "image", attachment: { attachmentId: "a1", width: 1, height: 1 } }] });

// 让旧实现也能确定性结束；测试断言活控制器缺失，而不是等待 onReady 超时。
async function first(run) {
  while (run.fake() === undefined) await Promise.resolve();
  await run.fake().first;
  return run.fake();
}

test("活查询接收 steer 与非查询 inject，保留来源/uuid", async () => {
  const consumed = [];
  const observed = Promise.withResolvers();
  const run = start({ onInputConsumed: (items) => { consumed.push(...items); if (items.some((item) => item.id === "u2")) observed.resolve(); } });
  const fake = await first(run);
  try {
    const control = run.control();
    assert.equal(typeof control?.submit, "function");
    assert.equal(fake.input[0].uuid, "u1");
    assert.deepEqual(fake.input[0].origin, { kind: "human" });
    await control.submit([message("u2")], { shouldQuery: true });
    await fake.waitInput(2);
    assert.equal(fake.input[1].uuid, "u2");
    assert.equal(fake.input[1].shouldQuery, true);
    fake.emit({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "task-1", task_type: "agent", description: "work" }] });
    fake.emit(success("u1"));
    await control.submit([message("injected", "system")], { shouldQuery: false });
    await fake.waitInput(3);
    assert.equal(fake.input[2].shouldQuery, false);
    assert.notEqual(fake.input[2].origin?.kind, "human");
    fake.emit({ type: "user", isReplay: true, uuid: "u2", message: { role: "user", content: "u2" }, parent_tool_use_id: null });
    fake.emit(success("u2"));
    await observed.promise;
    assert.ok(consumed.some((item) => item.id === "u2"));
    fake.emit({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    fake.finish();
    assert.equal((await run.run).stopReason, "completed");
  } finally { fake.finish(); await run.run; }
});

test("明确打断调用 SDK interrupt、关闭旧句柄并保留不确定投递事实", async () => {
  const abort = new AbortController();
  const run = start({ signal: abort.signal });
  const fake = await first(run);
  try {
    const control = run.control();
    assert.equal(typeof control?.interrupt, "function");
    fake.receipt = { still_queued: ["u1", "unknown-internal"] };
    abort.abort({ kind: "user" });
    const result = await run.run;
    assert.equal(result.stopReason, "aborted");
    assert.equal(fake.interrupts, 1);
    assert.ok(fake.closes >= 1);
    await assert.rejects(control.submit([message("late")]), /closed|stopping/);
    assert.ok(run.s.factEvents().some((event) => event.type === "claude-code/input" && event.data.messageId === "u1" && event.data.state === "uncertain"));
  } finally { fake.finish(); await run.run; }
});

test("SDK result error 不是 completed，错误信息保留", async () => {
  const run = start();
  const fake = await first(run);
  fake.emit({ type: "result", subtype: "error_max_turns", errors: ["turn budget exceeded"], is_error: true });
  fake.finish();
  const result = await run.run;
  assert.equal(result.stopReason, "error");
  assert.match(result.output[0].text, /turn budget exceeded/);
});

test("user replay 仅为收到回执，不把 goal 回合中的排队人类输入提前提权", async () => {
  const consumed = [];
  const run = start({ initialMessages: [message("g1", "goal")], prompt: "g1", onInputConsumed: (items) => consumed.push(...items) });
  const fake = await first(run);
  try {
    assert.equal(typeof run.control()?.submit, "function");
    assert.notEqual(fake.input[0].origin?.kind, "human");
    await run.control().submit([message("human-steer")]);
    await fake.waitInput(2);
    fake.emit({ type: "user", isReplay: true, uuid: "human-steer", message: { role: "user", content: "human-steer" }, parent_tool_use_id: null });
    fake.emit({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } });
    fake.finish();
    await run.run;
    assert.deepEqual(consumed, []);
  } finally { fake.finish(); await run.run; }
});

test("真实 Agent：followup 留在下一轮，steer 进入当前查询，取消保留队列", async () => {
  active = undefined;
  const ctx = new Context();
  ctx.provide("agents", { withInitiator: async (_agent, fn) => fn() });
  const s = session();
  const agent = new ClaudeCodeAgent(ctx, "s1", {}, s, { traceSubagents: false });
  agent.followup(message("initial"));
  while (!active) await Promise.resolve();
  const fake = active;
  await fake.first;
  try {
    agent.followup(message("queued"));
    agent.steer(message("steered"));
    assert.ok(agent.activeInput, "活查询控制器必须已绑定到 Agent");
    await fake.waitInput(2);
    assert.ok(fake.input.some((item) => item.uuid === "steered"));
    assert.deepEqual(agent.inbox.nextTurn.map((item) => item.id), ["queued"]);
    assert.ok(!fake.input.some((item) => item.uuid === "queued"));
    agent.cancel({ kind: "user" }, { keepInbox: true });
    await agent.whenIdle();
    assert.deepEqual(agent.inbox.nextTurn.map((item) => item.id), ["queued"]);
  } finally { fake.finish(); await agent.dispose(); }
});

for (const kind of ["no-receipt", "throw"]) {
  test(`interrupt ${kind} 时仍关闭句柄，不把未知输入重投`, async () => {
    const abort = new AbortController();
    const run = start({ signal: abort.signal });
    const fake = await first(run);
    fake.interrupt = async () => { fake.interrupts += 1; if (kind === "throw") throw new Error("unsupported"); };
    abort.abort();
    assert.equal((await run.run).stopReason, "aborted");
    assert.equal(fake.interrupts, 1);
    assert.ok(fake.closes > 0);
    assert.equal(fake.input.length, 1);
  });
}

test("启动前取消不创建 SDK 查询", async () => {
  const abort = new AbortController();
  abort.abort();
  const run = start({ signal: abort.signal });
  assert.equal((await run.run).stopReason, "aborted");
  assert.equal(run.fake(), undefined);
});

test("图片 steer 走 attachment 投影；转换期间取消时不交付", async () => {
  const read = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const abort = new AbortController();
  const attachments = { readImageRequest: async () => { entered.resolve(); return read.promise; } };
  const run = start({ signal: abort.signal, ctx: { get: (name) => name === "attachments" ? attachments : undefined, logger: { warn() {} } } });
  const fake = await first(run);
  const image = { ...message("image"), content: [{ type: "image", attachment: { attachmentId: "a1", width: 1, height: 1 } }] };
  const sending = run.control().submit([image]);
  await entered.promise;
  abort.abort();
  read.resolve({ data: new Uint8Array([1, 2, 3]), mediaType: "image/png" });
  await assert.rejects(sending, /closed|stopping/);
  await run.run;
  assert.equal(fake.input.length, 1);
});

test("旧 epoch 控制器不能向新的查询提交输入", async () => {
  const old = start();
  const oldFake = await first(old);
  const stale = old.control();
  oldFake.emit(success("u1")); oldFake.finish(); await old.run;
  const current = start({ prompt: "new", initialMessages: [message("new")] });
  const fake = await first(current);
  try {
    await assert.rejects(stale.submit([message("stale")]), /closed|stopping/);
    assert.deepEqual(fake.input.map((item) => item.uuid), ["new"]);
  } finally { fake.finish(); await current.run; }
});

test("投递台账拒写时不发送未记录输入，并报告 logIntact=false", async () => {
  const run = start();
  const fake = await first(run);
  run.s.rejectFact = (record) => { if (record.type === "claude-code/input") throw new Error("write rejected"); };
  await assert.rejects(run.control().submit([message("unlogged")]), /write rejected/);
  const result = await run.run;
  assert.equal(result.logIntact, false);
  assert.equal(fake.input.length, 1);
});

test("user/message 提交拒写时关闭活查询，不发送该输入", async () => {
  const run = start({ onInputSubmitted: () => { throw new Error("user message write rejected"); } });
  const fake = await first(run);
  try {
    await assert.rejects(run.control().submit([message("unlogged")]), /write rejected/);
    assert.ok(fake.closes > 0, "用户消息无法记录时必须停止活查询");
    const result = await run.run;
    assert.equal(result.logIntact, false);
    assert.equal(result.stopReason, "error");
    assert.equal(fake.input.length, 1);
  } finally { fake.finish(); await run.run; }
});

test("取消期间的新 followup 唤醒新运行，但 keepInbox 本身不自动续跑", async () => {
  active = undefined;
  const ctx = new Context();
  ctx.provide("agents", { withInitiator: async (_agent, fn) => fn() });
  const agent = new ClaudeCodeAgent(ctx, "s1", {}, session(), { traceSubagents: false });
  agent.followup(message("first"));
  while (!active) await Promise.resolve();
  const fake = active;
  await fake.first;
  const receipt = Promise.withResolvers();
  fake.interrupt = () => receipt.promise;
  const oldIdle = agent.whenIdle();
  agent.cancel({ kind: "user" }, { keepInbox: true });
  const next = Promise.withResolvers();
  onQuery = next.resolve;
  agent.followup(message("new"));
  receipt.resolve(undefined);
  try {
    await oldIdle;
    assert.equal(agent.phase.kind, "running", "新输入应唤醒一个新查询");
    const second = await next.promise;
    await second.first;
    assert.equal(second.input[0].uuid, "new");
    agent.cancel({ kind: "user" }, { keepInbox: true });
    await agent.whenIdle();
  } finally { onQuery = undefined; active?.finish(); await agent.dispose(); }
});

test("取消保留待办后，仍在队列里的人类输入自动开始新回合", async () => {
  active = undefined;
  const ctx = new Context();
  ctx.provide("agents", { withInitiator: async (_agent, fn) => fn() });
  const s = session();
  const agent = new ClaudeCodeAgent(ctx, "s1", {}, s, { traceSubagents: false });
  agent.followup(message("first"));
  while (!active) await Promise.resolve();
  const fake = active;
  await fake.first;
  const next = Promise.withResolvers();
  onQuery = next.resolve;
  try {
    // 运行中排队一条普通人类消息，然后显式打断并保留队列。
    agent.followup(message("queued-human"));
    agent.cancel({ kind: "user" }, { keepInbox: true });
    await agent.whenIdle();
    // 保留的待办必须在取消收尾后自动续跑；没续跑时用有界等待失败，而不是永久挂起。
    const started = await Promise.race([
      next.promise.then(() => true),
      new Promise((resolve) => { setTimeout(() => resolve(false), 2000); }),
    ]);
    assert.equal(started, true, "保留的待办应自动开一条新回合");
    const second = await next.promise;
    await second.first;
    assert.equal(second.input[0].uuid, "queued-human", "保留的待办应自动开一条新回合");
    assert.deepEqual(agent.inbox.nextTurn, []);
    second.finish();
    await agent.whenIdle();
  } finally { onQuery = undefined; active?.finish(); await agent.dispose(); }
});

test("取消保留待办后，纯 inject 待办不自动建立回合", async () => {
  active = undefined;
  const ctx = new Context();
  ctx.provide("agents", { withInitiator: async (_agent, fn) => fn() });
  const agent = new ClaudeCodeAgent(ctx, "s1", {}, session(), { traceSubagents: false });
  agent.followup(message("first"));
  while (!active) await Promise.resolve();
  const fake = active;
  await fake.first;
  try {
    agent.inject(message("notice", "system"));
    agent.cancel({ kind: "user" }, { keepInbox: true });
    await agent.whenIdle();
    assert.equal(agent.status, "idle", "只有 inject 时不应自动开回合");
    assert.equal(active, fake, "不得创建新查询");
    assert.deepEqual(agent.inbox.nextStep.map((item) => item.id), ["notice"], "待办仍保留");
  } finally { fake.finish(); await agent.dispose(); }
});

test("真实 Agent：goal 回合的 human steer 只有消费证据后才影响权威", async () => {
  const { agent, s } = makeAgent();
  agent.followup(message("goal-round", "goal"));
  while (!active) await Promise.resolve();
  const fake = active;
  await fake.first;
  try {
    agent.steer(message("human-steer"));
    await fake.waitInput(2);
    assert.equal(agent.currentTurnContext().hasHumanMessage, false);
    fake.emit({ type: "user", isReplay: true, uuid: "human-steer", message: { role: "user", content: "human-steer" }, parent_tool_use_id: null });
    await s.waitEvent((event) => event.type === "claude-code/input-receipt");
    assert.equal(agent.currentTurnContext().hasHumanMessage, false);
    fake.emit({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "b1" }] });
    fake.emit(success("human-steer"));
    await s.waitEvent((event) => event.type === "claude-code/input" && event.data.messageId === "human-steer" && event.data.state === "observed");
    assert.equal(agent.currentTurnContext().hasHumanMessage, true);
  } finally { fake.finish(); await agent.dispose(); }
});

test("图片准备期间编辑 pending，只投递编辑后的文本，不发送旧图片", async () => {
  const entered = Promise.withResolvers();
  const read = Promise.withResolvers();
  const { agent } = makeAgent({ readImageRequest: async () => { entered.resolve(); return read.promise; } });
  agent.followup(message("first"));
  while (!active) await Promise.resolve();
  const fake = active;
  await fake.first;
  try {
    agent.steer(imageMessage("edited"));
    await entered.promise;
    agent.inbox.replace("edited", { ...message("edited"), content: [{ type: "text", text: "new text" }] });
    read.resolve({ data: new Uint8Array([1]), mediaType: "image/png" });
    await fake.waitInput(2);
    assert.deepEqual(fake.input[1].message.content, [{ type: "text", text: "new text" }]);
  } finally { read.resolve({ data: new Uint8Array([1]), mediaType: "image/png" }); fake.finish(); await agent.dispose(); }
});

test("live 图片输入保留实际 base64 内容", async () => {
  const attachments = { readImageRequest: async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: "image/png" }) };
  const run = start({ ctx: { get: (name) => name === "attachments" ? attachments : undefined } });
  const fake = await first(run);
  try {
    await run.control().submit([imageMessage("image")]);
    await fake.waitInput(2);
    assert.deepEqual(fake.input[1].message.content, [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } }]);
  } finally { fake.finish(); await run.run; }
});

test("首轮图片准备期间取消保留 inbox，不创建查询也不丢消息", async () => {
  const entered = Promise.withResolvers();
  const read = Promise.withResolvers();
  const { agent } = makeAgent({ readImageRequest: async () => { entered.resolve(); return read.promise; } });
  agent.followup(imageMessage("image"));
  await entered.promise;
  agent.cancel({ kind: "user" }, { keepInbox: true });
  read.resolve({ data: new Uint8Array([1]), mediaType: "image/png" });
  await agent.whenIdle();
  assert.equal(active, undefined);
  assert.deepEqual(agent.inbox.nextTurn.map((item) => item.id), ["image"]);
  await agent.dispose();
});

test("SDK 构造查询失败时消息恢复为 pending，不自动重试", async () => {
  const { agent, s } = makeAgent();
  queryError = new Error("spawn failed before query returned");
  try {
    agent.followup(message("retryable"));
    await agent.whenIdle();
    assert.deepEqual(agent.inbox.nextTurn.map((item) => item.id), ["retryable"]);
    assert.equal(s.events.filter((event) => event.type === "turn/start").length, 1);
    assert.equal(active, undefined);
  } finally { queryError = undefined; await agent.dispose(); }
});

test("interrupt 不返回时由有限超时关闭句柄", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const abort = new AbortController();
  const run = start({ signal: abort.signal });
  const fake = await first(run);
  fake.interrupt = () => new Promise(() => {});
  abort.abort();
  t.mock.timers.tick(1000);
  assert.equal((await run.run).stopReason, "aborted");
  assert.ok(fake.closes > 0);
  await fake.ended;
});

test("maintenance 中的 steer 在维护结束后开始，inject 本身不启动查询", async () => {
  const { agent } = makeAgent();
  const release = Promise.withResolvers();
  const maintenance = agent.runMaintenance(() => release.promise);
  agent.inject(message("notice", "system"));
  agent.steer(message("steer"));
  assert.equal(active, undefined);
  release.resolve();
  await maintenance;
  while (!active) await Promise.resolve();
  const fake = active;
  await fake.first;
  try { assert.equal(fake.input[0].uuid, "steer"); }
  finally { fake.finish(); await agent.dispose(); }
});

test("图片准备期间删除 pending，不发送已删除输入", async () => {
  const entered = Promise.withResolvers();
  const read = Promise.withResolvers();
  const { agent } = makeAgent({ readImageRequest: async () => { entered.resolve(); return read.promise; } });
  agent.followup(message("first"));
  while (!active) await Promise.resolve();
  const fake = active;
  await fake.first;
  try {
    agent.steer(imageMessage("removed"));
    await entered.promise;
    agent.inbox.remove("removed");
    read.resolve({ data: new Uint8Array([1]), mediaType: "image/png" });
    await agent.activeInput.flushing;
    assert.equal(fake.input.length, 1);
    assert.equal(agent.inbox.nextStep.length, 0);
  } finally { read.resolve({ data: new Uint8Array([1]), mediaType: "image/png" }); fake.finish(); await agent.dispose(); }
});

function restoredAgent(original) {
  const ctx = new Context();
  ctx.provide("agents", { withInitiator: async (_agent, fn) => fn() });
  const s = session();
  s.events.push(...structuredClone(original.events));
  s.facts.close();
  attachFacts(s, original.factRecords);
  return { s, agent: new ClaudeCodeAgent(ctx, "s1", {}, s, { traceSubagents: false }) };
}

test("首批输入在 SDK 构造窗口崩溃后仍能从日志恢复到原队列", async () => {
  const { agent, s } = makeAgent();
  let recovered;
  onQuery = () => { recovered = restoredAgent(s); };
  try {
    agent.followup(message("recover-initial"));
    while (!active) await Promise.resolve();
    await active.first;
    assert.deepEqual(recovered.agent.inbox.nextTurn.map((item) => item.id), ["recover-initial"]);
  } finally { onQuery = undefined; active?.finish(); await agent.dispose(); await recovered?.agent.dispose(); }
});

for (const rejected of ["turn/start", "user/message"]) {
  test(`首批 ${rejected} 拒写不丢失已证明未交付的输入`, async () => {
    const { agent, s } = makeAgent();
    const append = s.append;
    let failed = false;
    s.append = (type, ...rest) => {
      if (type === rejected && !failed) { failed = true; throw new Error("startup write rejected"); }
      return append(type, ...rest);
    };
    let recovered;
    try {
      agent.followup(message("recover-rejected"));
      await agent.whenIdle();
      assert.equal(active, undefined);
      assert.deepEqual(agent.inbox.nextTurn.map((item) => item.id), ["recover-rejected"]);
      recovered = restoredAgent(s);
      assert.deepEqual(recovered.agent.inbox.nextTurn.map((item) => item.id), ["recover-rejected"]);
    } finally { await agent.dispose(); await recovered?.agent.dispose(); }
  });
}

for (const failure of ["user-message", "second-claim", "submitted-fact"]) {
  test(`运行中 ${failure} 拒写后整批未交付输入仍可恢复`, async () => {
    const { agent, s } = makeAgent();
    agent.followup(message("first"));
    while (!active) await Promise.resolve();
    const fake = active;
    await fake.first;
    let recovered;
    try {
      agent.inbox.append("next-step", message("a"));
      agent.inbox.append("next-step", message("b"));
      const append = s.append;
      let claims = 0;
      let failed = false;
      s.rejectFact = (record) => {
        if (failure === "submitted-fact" && record.type === "claude-code/input-batch" && !failed) {
          failed = true; throw new Error("live write rejected");
        }
      };
      s.append = (type, data, opts) => {
        const reject = failure === "user-message" ? type === "user/message"
          : failure === "second-claim" && type === "agent/inbox/spliced" && data.removedCount > 0 && ++claims === 2;
        if (reject && !failed) { failed = true; throw new Error("live write rejected"); }
        return append(type, data, opts);
      };
      agent.flushInput(agent.activeInput);
      await agent.whenIdle();
      assert.equal(fake.input.length, 1);
      recovered = restoredAgent(s);
      assert.deepEqual(recovered.agent.inbox.nextStep.map((item) => item.id), ["a", "b"]);
    } finally { fake.finish(); await agent.dispose(); await recovered?.agent.dispose(); }
  });
}

test("重启保留 steer 的 querying 意图，显式 wake 有效而 inject 不独自查询", async () => {
  const { agent, s } = makeAgent();
  const release = Promise.withResolvers();
  const maintenance = agent.runMaintenance(() => release.promise);
  let recovered;
  try {
    agent.inject(message("notice", "system"));
    agent.steer(message("durable-steer"));
    recovered = restoredAgent(s);
    agent.cancel({ kind: "disposed" });
    release.resolve();
    await maintenance;
    onQuery = (fake) => { fake.emit(success("durable-steer")); fake.finish(); };
    recovered.agent.wakeDriver();
    await recovered.agent.whenIdle();
    assert.equal(recovered.s.events.filter((event) => event.type === "turn/start").length, 1);
    assert.deepEqual(active.input.map((input) => input.uuid), ["durable-steer"]);
    const injected = makeAgent();
    injected.agent.inject(message("inject-only", "system"));
    const injectRestored = restoredAgent(injected.s);
    try {
      injectRestored.agent.wakeDriver();
      await injectRestored.agent.whenIdle();
      assert.equal(injectRestored.s.events.filter((event) => event.type === "turn/start").length, 0);
    } finally { await injected.agent.dispose(); await injectRestored.agent.dispose(); }
  } finally { onQuery = undefined; release.resolve(); await maintenance; await agent.dispose(); await recovered?.agent.dispose(); }
});

for (const gate of ["before-prepare", "after-prepare"]) {
  test(`active goal ${gate} 拒绝删除落盘失败不自动进入下一查询`, async () => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const { agent, s, goal } = makeAgent({ async readImageRequest() { entered.resolve(); return release.promise; } });
    const queries = [];
    onQuery = fake => {
      queries.push(fake);
      if (queries.length > 1) { fake.emit(success("active-auto")); fake.finish(); }
    };
    agent.followup(message("initial-human"));
    while (!active) await Promise.resolve();
    const fake = active; await fake.first;
    const phase = agent.phase;
    const append = s.append;
    let failed = false;
    try {
      const automatic = gate === "before-prepare" ? message("active-auto", "goal") : imageMessage("active-auto");
      agent.inbox.enqueue("next-step", automatic, true);
      s.append = (type, data, opts) => {
        if (!failed && type === "agent/inbox/spliced" && data.removedCount > 0) {
          failed = true;
          throw new Error("goal rejection persistence failed");
        }
        return append(type, data, opts);
      };
      agent.flushInput(agent.activeInput);
      if (gate === "after-prepare") {
        await entered.promise;
        automatic.source = message("active-auto", "goal").source;
        release.resolve({ data: new Uint8Array([1]), mediaType: "image/png" });
      }
      await agent.activeInput.flushing;
      assert.equal(failed, true);
      phase.keepInbox = true;
      phase.wakeRequested = true;
      fake.emit(success("initial-human")); fake.finish();
      await agent.whenIdle(); await fake.ended;
      assert.equal(queries.length, 1, "failed durable rejection must not become an initial goal round");
      assert.equal(phase.inputFailure, true);
      assert.equal(goal.view.roundsStarted, 0);
      assert.equal(s.events.some(e => e.type === "user/message" && e.data.id === "active-auto"), false);
      assert.equal(agent.inbox.nextStep[0], automatic);
      assert.equal(agent.status, "idle");
      s.append = append;
      agent.wakeDriver();
      await agent.whenIdle(); await queries.at(-1).ended;
      assert.equal(queries.length, 2, "explicit wake may retry preserved evidence");
      assert.deepEqual(queries[1].input.map(i => i.uuid), ["active-auto"]);
      assert.equal(goal.view.roundsStarted, 1);
    } finally {
      s.append = append;
      release.resolve({ data: new Uint8Array([1]), mediaType: "image/png" });
      onQuery = undefined; active?.finish(); await agent.dispose();
    }
  });
}

test("active automatic goal 剔除后 steer/inject 重新准备", async () => {
  const { agent, s } = makeAgent();
  agent.followup(message("first"));
  while (!active) await Promise.resolve();
  const fake = active; await fake.first;
  try {
    agent.inbox.enqueue("next-step", message("stale-goal", "goal"), false);
    agent.inbox.enqueue("next-step", message("steer"), true);
    agent.inbox.enqueue("next-step", message("context", "system"), false);
    agent.flushInput(agent.activeInput);
    await fake.waitInput(2);
    assert.deepEqual(fake.input[1].message.content, [{ type: "text", text: "steer\ncontext" }]);
    assert.equal(fake.input[1].shouldQuery, true);
    assert.equal(s.events.some(e => e.type === "user/message" && e.data.id === "stale-goal"), false);
  } finally { fake.finish(); await agent.dispose(); }
});
test("active goal 剔除后只有 inject 按 shouldQuery false 交付", async () => {
  const { agent, s } = makeAgent();
  agent.followup(message("first"));
  while (!active) await Promise.resolve();
  const fake = active; await fake.first;
  try {
    agent.inbox.enqueue("next-step", message("stale-goal", "goal"), false);
    agent.inbox.enqueue("next-step", message("context", "system"), false);
    agent.flushInput(agent.activeInput);
    await fake.waitInput(2);
    assert.deepEqual(fake.input[1].message.content, [{ type: "text", text: "context" }]);
    assert.equal(fake.input[1].shouldQuery, false);
    assert.equal(s.events.some(e => e.type === "user/message" && e.data.id === "stale-goal"), false);
  } finally { fake.finish(); await agent.dispose(); }
});
test("submit false 且 pending 不变不会重新 flush", async () => {
  const { agent } = makeAgent();
  const phase = { abort: new AbortController() };
  let submissions = 0;
  const lane = { phase, turn: 1, accepting: true, controller: { async submit() {
    if (++submissions > 2) phase.abort.abort({ kind: "user" });
    return false;
  } } };
  agent.activeInput = lane;
  agent.inbox.enqueue("next-step", message("pending"), true);
  agent.flushInput(lane); await lane.flushing; await Promise.resolve();
  assert.equal(submissions, 1);
  assert.equal(agent.inbox.nextStep[0].id, "pending");
  agent.activeInput = undefined; await agent.dispose();
});
test("初始 canStartInput 晚拒绝不是日志失败或已交付", async () => {
  let allowed = true;
  onQuery = fake => { allowed = false; fake.finish(); };
  const run = start({ canStartInput: () => allowed });
  try {
    const result = await run.run; await run.fake()?.ended;
    assert.equal(result.initialSubmitted, false);
    assert.equal(result.initialRejected, true);
    assert.equal(result.logIntact, true);
    assert.equal(run.fake()?.input.length ?? 0, 0);
    assert.ok(run.fake()?.closes > 0);
  } finally { onQuery = undefined; run.fake()?.finish(); await run.run; }
});
test("初始 query 前拒绝不创建查询", async () => {
  onQuery = fake => fake.finish();
  const run = start({ canStartInput: () => false });
  try {
    const result = await run.run;
    assert.equal(run.fake(), undefined);
    assert.equal(result.initialRejected, true);
    assert.equal(result.logIntact, true);
  } finally { onQuery = undefined; run.fake()?.finish(); await run.run; }
});
test("首批 prepareInitial 等待后重读授权", async () => {
  let allowed = true;
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const prompt = { async *[Symbol.asyncIterator]() { entered.resolve(); await release.promise; yield { message: { content: "u1" } }; } };
  onQuery = fake => fake.finish();
  const run = start({ prompt, canStartInput: () => allowed });
  try {
    await entered.promise; allowed = false; release.resolve();
    const result = await run.run;
    assert.equal(result.initialRejected, true);
    assert.equal(run.fake(), undefined);
  } finally { release.resolve(); onQuery = undefined; run.fake()?.finish(); await run.run; }
});
test("生产 Agent 已登记 goal 在 query 创建期间 disarm，模型输入为零", async () => {
  const { agent, s, goal } = makeAgent();
  const created = Promise.withResolvers();
  onQuery = fake => { goal.view.activation = "disarmed"; created.resolve(fake); fake.finish(); };
  try {
    agent.followup(message("late-goal", "goal"));
    const fake = await created.promise; await agent.whenIdle(); await fake.ended;
    assert.equal(fake.input.length, 0);
    assert.equal(s.events.filter(e => e.type === "user/message" && e.data.id === "late-goal").length, 1);
    assert.equal(goal.view.roundsStarted, 1);
    assert.ok(fake.closes >= 1);
  } finally { onQuery = undefined; active?.finish(); await agent.dispose(); }
});
test("Promise canStartInput 不能作为 truthy 放行", async () => {
  onQuery = fake => fake.finish();
  const run = start({ canStartInput: () => Promise.resolve(false) });
  try {
    const result = await run.run;
    assert.equal(result.stopReason, "error");
    assert.match(result.output[0].text, /canStartInput must return boolean/);
    assert.equal(run.fake(), undefined);
  } finally { onQuery = undefined; run.fake()?.finish(); await run.run; }
});
test("Promise canSubmitInput 不能作为 truthy 放行", async () => {
  const run = start({ canSubmitInput: () => Promise.resolve(false) });
  const fake = await first(run);
  try {
    await assert.rejects(run.control().submit([message("forbidden")]), /canSubmitInput must return boolean/);
    assert.equal(fake.input.length, 1);
  } finally { fake.finish(); await run.run; }
});

test("active 图片准备期间替换为 goal 不投递旧图片或自动项", async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const { agent, s } = makeAgent({ async readImageRequest() { entered.resolve(); return release.promise; } });
  agent.followup(message("first"));
  while (!active) await Promise.resolve();
  const fake = active; await fake.first;
  try {
    agent.steer(imageMessage("edited-goal"));
    await entered.promise;
    agent.inbox.replace("edited-goal", message("edited-goal", "goal"));
    release.resolve({ data: new Uint8Array([1]), mediaType: "image/png" });
    await agent.activeInput.flushing;
    assert.equal(fake.input.length, 1);
    assert.equal(agent.inbox.nextStep.length, 0);
    assert.equal(s.events.some(e => e.type === "user/message" && e.data.id === "edited-goal"), false);
  } finally { release.resolve({ data: new Uint8Array([1]), mediaType: "image/png" }); fake.finish(); await agent.dispose(); }
});
test("已登记 goal 晚读取失败 recover clone 保留 hold，无自动忙循环", async () => {
  const { agent, s, goal } = makeAgent();
  onQuery = fake => {
    goal.error = new Error("projection failed");
    agent.phase.keepInbox = true;
    agent.phase.wakeRequested = true;
    fake.finish();
  };
  try {
    agent.followup(message("held-goal", "goal"));
    await agent.whenIdle();
    await active.ended;
    assert.equal(active.input.length, 0);
    assert.equal(goal.reads, 5);
    assert.equal(agent.status, "idle");
    assert.equal(agent.inbox.nextTurn[0].id, "held-goal");
    assert.equal(agent.heldGoalInputs.has(agent.inbox.nextTurn[0]), true);
    assert.equal(s.events.filter(e => e.type === "user/message" && e.data.id === "held-goal").length, 1);
    onQuery = fake => { fake.emit(success("human-after-hold")); fake.finish(); };
    agent.followup(message("human-after-hold"));
    await agent.whenIdle(); await active.ended;
    assert.deepEqual(active.input.map(i => i.uuid), ["human-after-hold"]);
    assert.equal(goal.reads, 6);
  } finally { onQuery = undefined; active?.finish(); await agent.dispose(); }
});

test("idle inject 不建立回合；idle steer 可以唤醒查询", async () => {
  const { agent } = makeAgent();
  agent.inject(message("notice", "system"));
  assert.equal(agent.status, "idle");
  assert.equal(active, undefined);
  agent.steer(message("steer"));
  while (!active) await Promise.resolve();
  const fake = active;
  await fake.first;
  try { assert.equal(fake.input[0].uuid, "steer"); }
  finally { fake.finish(); await agent.dispose(); }
});
