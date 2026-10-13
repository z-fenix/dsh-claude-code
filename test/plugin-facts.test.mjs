import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PluginFacts, bindPluginFacts, pluginFacts } from "../lib/plugin-facts.mjs";
import { DshInbox } from "../lib/inbox.mjs";
import { RunInputLedger } from "../lib/run-input.mjs";
import { PromptSnapshotRecorder } from "../lib/prompt-snapshot.mjs";
import { ClaudeRunControl } from "../lib/run-control.mjs";

function nativeSession() {
  const events = [];
  return { id: "facts-test", header: { createdAt: 1, cwd: "/w" }, events, snapshotEvents: () => events,
    append(type, data) { const event = { type, data: structuredClone(data), seq: events.length, time: 1 }; events.push(event); return event; } };
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "dsh-facts-"));
  const session = nativeSession();
  const facts = bindPluginFacts(session, new PluginFacts(session, { root }));
  const owners = [facts];
  t.after(() => { for (const owner of owners.reverse()) owner.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, session, facts, reopen: () => {
    const next = bindPluginFacts(session, new PluginFacts(session, { root })); owners.push(next); return next;
  }, file: () => join(root, "facts", readdirSync(join(root, "facts")).find((name) => name.endsWith(".jsonl"))) };
}
const intent = { messageId: "u1", querying: true };
const msg = (id) => ({ id, role: "user", content: [{ type: "text", text: id }] });

test("关闭后同一 session 可取得重新加载的台账", (t) => {
  const { root, session, facts } = fixture(t);
  const old = process.env.DSH_CLAUDE_CODE_STORE;
  process.env.DSH_CLAUDE_CODE_STORE = root;
  try {
    facts.append("claude-code/input-intent", intent);
    facts.close();
    const reopened = pluginFacts(session);
    assert.notEqual(reopened, facts);
    assert.equal(reopened.events()[0].data.querying, true);
    reopened.close();
  } finally { if (old === undefined) delete process.env.DSH_CLAUDE_CODE_STORE; else process.env.DSH_CLAUDE_CODE_STORE = old; }
});

test("拒绝不能无损 JSON 持久化的输入，失败不写入事实", (t) => {
  const { facts } = fixture(t);
  for (const data of [{ n: Infinity }, { n: NaN }, { n: -0 }, { f() {} }, { map: new Map() }, { n: undefined }]) {
    assert.throws(() => facts.append("claude-code/input-intent", data), /JSON|serializ/);
  }
  assert.deepEqual(facts.events(), []);
});

test("私有事实按原生锚点排序，恢复的 submitted 不重投，编辑/取消不复活", (t) => {
  const { session, facts, reopen } = fixture(t);
  const inbox = new DshInbox(session, { emit() {} });
  const ledger = new RunInputLedger(session, "e1");
  inbox.enqueue("next-step", msg("u1"), true);
  ledger.record("u1", "reserved", { message: inbox.nextStep[0], ...inbox.placement(inbox.nextStep[0]) });
  inbox.consume(inbox.peek("next-step"), 1);
  ledger.submitBatch(["u1"], { sdkUuid: "u1" });
  inbox.enqueue("next-step", msg("u2"), true);
  ledger.record("u2", "reserved", { message: inbox.nextStep[0], ...inbox.placement(inbox.nextStep[0]) });
  inbox.consume(inbox.peek("next-step"), 1);
  facts.close();
  const reopened = reopen();
  const restored = new DshInbox(session, { emit() {} });
  assert.deepEqual(restored.nextStep.map((item) => item.id), ["u2"]);
  assert.equal(new RunInputLedger(session, "e2").stateOf("u1"), "uncertain");
  restored.replace("u2", { ...msg("u2"), content: [{ type: "text", text: "edited" }] });
  assert.equal(new DshInbox(session, { emit() {} }).nextStep[0].content[0].text, "edited");
  restored.clear();
  assert.equal(new DshInbox(session, { emit() {} }).hasPending, false);
  assert.ok(session.events.every((event) => !event.type.startsWith("claude-code/")));
});

test("跨进程恢复台账和原生锚点，不依赖内存缓存", (t) => {
  const { root, session, facts } = fixture(t);
  facts.append("claude-code/input-intent", intent);
  facts.close();
  const url = new URL("../lib/plugin-facts.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { PluginFacts } from ${JSON.stringify(url)};
    const s = {id:'facts-test',header:{createdAt:1,cwd:'/w'},snapshotEvents:()=>[]};
    const facts = new PluginFacts(s,{root:process.argv[1]});
    console.log(JSON.stringify(facts.events().map(e=>e.data)));facts.close();
  `, root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [intent]);
});

test("第二个写入者不能追加，原写入者保留所有权", (t) => {
  const { root, session, facts } = fixture(t);
  facts.append("claude-code/input-intent", intent);
  const other = new PluginFacts(session, { root });
  assert.throws(() => other.append("claude-code/input-intent", { ...intent, messageId: "u2" }), /writer conflict/);
  facts.append("claude-code/input-intent", { ...intent, messageId: "u3" });
  assert.deepEqual(facts.events().map((event) => event.data.messageId), ["u1", "u3"]);
  other.close();
});

test("存在 manifest 的台账缺失、截断、错误归属或原生锚点改变时拒绝恢复", (t) => {
  const { root, session, facts, file } = fixture(t);
  session.append("agent/inbox/spliced", { target: "next-turn", start: 0, inserted: [] });
  facts.append("claude-code/input-intent", intent);
  facts.close();
  const path = file();
  const bytes = readFileSync(path);
  writeFileSync(path, bytes.subarray(0, -1));
  assert.throws(() => new PluginFacts(session, { root }), /truncated/);
  writeFileSync(path, bytes);
  const otherSession = { ...session, header: { ...session.header, createdAt: 2 } };
  assert.throws(() => new PluginFacts(otherSession, { root }), /identity/);
  session.events[0].data.start = 7;
  assert.throws(() => new PluginFacts(session, { root }), /anchor/);
  session.events[0].data.start = 0;
  unlinkSync(path);
  assert.throws(() => new PluginFacts(session, { root }), /missing/);
});

test("旧 ignorable 私有事实与新台账只读合并，不重新写入原生日志", (t) => {
  const { session, facts } = fixture(t);
  session.events.push({ type: "claude-code/input", seq: 0, time: 1, ignorable: true,
    data: { messageId: "old", epoch: "legacy", state: "submitted" } });
  const ledger = new RunInputLedger(session, "new");
  assert.equal(ledger.stateOf("old"), "uncertain");
  ledger.record("old", "observed");
  assert.equal(session.events.length, 1);
  assert.equal(facts.events().at(-1).data.state, "observed");
});

test("快照跨台账重开去重，返回私有 factSeq 而非原生 seq", (t) => {
  const { session, facts, reopen } = fixture(t);
  const value = { sections: [{ id: "system", text: "observed", scope: "shared" }] };
  const first = new PromptSnapshotRecorder({ session, agent: { id: "a1" }, epoch: "e1" }).record(value);
  assert.equal(first.factSeq, 0);
  assert.equal(first.seq, undefined);
  facts.close();
  const reopened = reopen();
  const second = new PromptSnapshotRecorder({ session, agent: { id: "a1" }, epoch: "e2" }).record(value);
  assert.equal(second.unchanged, true);
  assert.equal(reopened.events().filter((event) => event.type === "claude-code/prompt-snapshot").length, 1);
});

test("真实文件写入失败阻止首批 SDK 输入交付", async (t) => {
  const { root, session, facts } = fixture(t);
  writeFileSync(join(root, "facts"), "not a directory");
  const control = new ClaudeRunControl({ ctx: {}, session, epoch: "e1", signal: new AbortController().signal, abort() {} });
  const prepared = await control.prepareInitial("u1", [msg("u1")]);
  assert.throws(() => control.start({ close() {} }, prepared));
  assert.equal(control.initialSubmitted, false);
  control.channel.close();
  assert.equal((await control.channel[Symbol.asyncIterator]().next()).done, true);
  assert.deepEqual(facts.events(), []);
});

test("崩溃进程的锁可回收，输入事实不丢失或重复", (t) => {
  const { root, session, facts } = fixture(t);
  const url = new URL("../lib/plugin-facts.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { PluginFacts } from ${JSON.stringify(url)};
    const s={id:'facts-test',header:{createdAt:1,cwd:'/w'},snapshotEvents:()=>[]};
    new PluginFacts(s,{root:process.argv[1]}).append('claude-code/input-intent',{messageId:'crashed',querying:true});
    process.exit(0);
  `, root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  facts.close();
  const restored = new PluginFacts(session, { root });
  try {
    restored.append("claude-code/input-intent", intent);
    assert.deepEqual(restored.events().map((event) => event.data.messageId), ["crashed", "u1"]);
  } finally { restored.close(); }
});
