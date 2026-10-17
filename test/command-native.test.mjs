import { test } from "node:test";
import assert from "node:assert/strict";
import { attachFacts } from "./helpers/plugin-facts.mjs";
import { readNativeSnapshots } from "../lib/native-metadata.mjs";
import { Context } from "@deepseek-ai/cordis";
import { createScope } from "@deepseek-ai/dsh-scope";

async function fixture({ agent: agentExtra = {}, context, catalog, nativeCommand } = {}) {
  const { apply } = await import("../lib/command-native.mjs");
  const definitions = new Map();
  const cleanup = [];
  const ctx = {
    get: (name) => name === "commands" ? { register(definition) { definitions.set(definition.name, definition); return () => {}; } } : undefined,
    effect(factory) { for (const dispose of factory()) cleanup.push(dispose); },
  };
  apply(ctx);
  const session = attachFacts({ id: "cmd-session", snapshotEvents: () => [] });
  if (context) session.facts.append("claude-code/native-context", { snapshot: context });
  if (catalog) session.facts.append("claude-code/native-catalog", { snapshot: catalog });
  const followups = [];
  const agent = { id: "a1", status: "idle", session, nativeSnapshots: () => readNativeSnapshots(session), followup: (message) => followups.push(message), ...agentExtra };
  if (nativeCommand) agent.nativeCommand = nativeCommand;
  return { definitions, followups, agent, session,
    run: (name, rawInput = "") => definitions.get(name).handler({ agent, rawInput, signal: new AbortController().signal, commandId: "cmd1", attachments: [] }),
    dispose: async () => { for (const fn of cleanup.toReversed()) await fn(); } };
}
const contextFact = { window: 200000, tokens: 10, percent: 0, model: "claude-opus-4-6", estimated: true, detail: "summary", truncated: false,
  categories: [{ name: "Messages", tokens: 111, kind: "used" }, { name: "Free space", tokens: 122480, kind: "free" }] };
const catalogFact = { truncated: false, skillsObserved: true, skillsSource: "sdk-reload-skills", commandsSource: "mod-command-list",
  commands: [{ name: "compact", description: "Compact", source: "builtin" }],
  skills: [{ name: "real-skill", description: "Real skill", argumentHint: "<input>" }] };

test("native 命令声明依赖，等 commands 服务就绪才注册", async () => {
  const module = await import("../lib/command-native.mjs");
  const ctx = new Context(); const definitions = [];
  const fiber = ctx.plugin(module);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(definitions.length, 0);
  ctx.provide("commands", { register: definition => { definitions.push(definition); return () => {}; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(definitions.length, 4);
  await fiber.dispose();
});

test("取消、scope 不匹配、disposed 或模块卸载后不能投递技能", async () => {
  const world = await fixture({ agent: { config: { mods: { skills: { allowed: ["real-skill"] } } } }, catalog: catalogFact });
  const handler = world.definitions.get("claude-skill").handler;
  const signal = new AbortController(); signal.abort();
  assert.equal((await handler({ agent: world.agent, rawInput: "real-skill arg", commandId: "c", signal: signal.signal, attachments: [] })).kind, "error");
  world.agent.disposed = true;
  assert.equal((await world.run("claude-skill", "real-skill arg")).kind, "error");
  world.agent.disposed = false;
  await world.dispose();
  assert.equal((await world.run("claude-skill", "real-skill arg")).kind, "error");
  assert.equal(world.followups.length, 0);
  const scoped = new Context(); const owner = { id: "owner" }; const scope = createScope(scoped, owner); let registered;
  scoped.provide("commands", { register: definition => { if (definition.name === "claude-skill") registered = definition.handler; return () => {}; } });
  try {
    (await import("../lib/command-native.mjs")).apply(scope.ctx);
    assert.equal((await registered({ agent: world.agent, rawInput: "real-skill arg", signal: new AbortController().signal })).kind, "error");
  } finally { await scope.dispose(); }
  assert.equal(world.followups.length, 0);
});

test("多行技能参数原样保留，附件不被静默丢弃", async () => {
  const world = await fixture({ agent: { config: { mods: { skills: { allowed: ["real-skill"] } } } }, catalog: catalogFact });
  try {
    const result = await world.run("claude-skill", "real-skill first\n  second\tvalue  ");
    assert.equal(result.kind, "success");
    assert.equal(world.followups[0].content[0].text, "/real-skill first\n  second\tvalue  ");
    const attached = await world.definitions.get("claude-skill").handler({ agent: world.agent, rawInput: "real-skill arg", signal: new AbortController().signal, attachments: [{}] });
    assert.equal(attached.kind, "error");
    assert.equal(world.followups.length, 1);
  } finally { await world.dispose(); }
});

test("错误脱敏，非 CLI agent 不能把旧观察当成可用能力", async () => {
  const world = await fixture({ context: contextFact, agent: { nativeSnapshots: undefined }, nativeCommand: async () => { throw new Error("sensitive service secret"); } });
  try {
    assert.equal((await world.run("claude-context")).kind, "error");
    const result = await world.run("claude-command", "cost");
    assert.equal(result.kind, "error");
    assert.equal(result.text.includes("sensitive"), false);
  } finally { await world.dispose(); }
});

test("四个命令一次注册、名字固定，缺 live agent 一律拒绝", async () => {
  const world = await fixture();
  try {
    assert.deepEqual([...world.definitions.keys()].sort(), ["claude-command", "claude-commands", "claude-context", "claude-skill"]);
    for (const name of world.definitions.keys()) {
      const result = await world.definitions.get(name).handler({ rawInput: "", signal: new AbortController().signal, commandId: "c" });
      assert.equal(result.kind, "error", name);
    }
  } finally { await world.dispose(); }
});

test("/claude-context 只展示最近观察并保留估算标识", async () => {
  const empty = await fixture();
  try { assert.match((await empty.run("claude-context")).text, /no native context/i); }
  finally { await empty.dispose(); }
  const world = await fixture({ context: contextFact });
  try {
    const result = await world.run("claude-context");
    assert.equal(result.kind, "success");
    assert.match(result.text, /200000/);
    assert.match(result.text, /Messages/);
    assert.match(result.text, /estimated/i);
  } finally { await world.dispose(); }
});

test("/claude-commands 区分 SDK 技能与其他插件命令，且不宣称授权", async () => {
  const world = await fixture({ catalog: catalogFact });
  try {
    const result = await world.run("claude-commands");
    assert.equal(result.kind, "success");
    assert.match(result.text, /real-skill/);
    assert.match(result.text, /not an authorization|list is not/i);
    const names = (await world.run("claude-commands")).text;
    assert.match(names, /1 plugin\/builtin command/i);
  } finally { await world.dispose(); }
});

test("/claude-command 只允许 status|cost，失败不冒充成功也不写私有日志", async () => {
  const calls = [];
  const world = await fixture({ nativeCommand: async (input) => { calls.push(input); return { status: "succeeded", text: "$0.12 spent" }; } });
  try {
    assert.equal((await world.run("claude-command", "rm -rf")).kind, "error");
    assert.equal((await world.run("claude-command", "")).kind, "error");
    assert.equal(calls.length, 0);
    const result = await world.run("claude-command", "cost");
    assert.equal(result.kind, "success");
    assert.match(result.text, /\$0\.12 spent/);
    assert.equal(calls[0].command, "cost");
    assert.equal(calls[0].commandId, "cmd1");
    assert.equal(world.session.factRecords.length, 0);
  } finally { await world.dispose(); }
  const skipped = await fixture({ nativeCommand: async () => ({ status: "skipped", reason: "no output" }) });
  try { assert.equal((await skipped.run("claude-command", "status")).kind, "error"); }
  finally { await skipped.dispose(); }
  const unsupported = await fixture();
  try { assert.equal((await unsupported.run("claude-command", "status")).kind, "error"); }
  finally { await unsupported.dispose(); }
});

test("/claude-skill 需要 allowlist 与本次 SDK 观察同时命中，只 enqueue 一次", async () => {
  const agent = { config: { mods: { skills: { allowed: ["real-skill"] } } } };
  const world = await fixture({ agent, catalog: catalogFact });
  try {
    assert.equal((await world.run("claude-skill", "other-skill")).kind, "error");
    assert.equal(world.followups.length, 0);
    const sent = await world.run("claude-skill", "real-skill do the thing");
    assert.equal(sent.kind, "success");
    assert.equal(world.followups.length, 1);
    assert.deepEqual(world.followups[0].content, [{ type: "text", text: "/real-skill do the thing" }]);
    assert.equal(world.followups[0].source.kind, "user");
    assert.equal(typeof world.followups[0].id, "string");
  } finally { await world.dispose(); }
  const allowedOnly = await fixture({ agent });
  try {
    assert.equal((await allowedOnly.run("claude-skill", "real-skill")).kind, "error", "未观察到的技能不能发送");
    assert.equal(allowedOnly.followups.length, 0);
  } finally { await allowedOnly.dispose(); }
  const observedOnly = await fixture({ catalog: catalogFact });
  try {
    assert.equal((await observedOnly.run("claude-skill", "real-skill")).kind, "error", "未在 allowed 列表中的技能不能发送");
    assert.equal(observedOnly.followups.length, 0);
  } finally { await observedOnly.dispose(); }
});
