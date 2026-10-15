// test/session-store.test.mjs — 「DSH 会话 → Claude 会话 id」的两份记录与恢复优先级。
//
// 两份记录的分工（见 lib/store.mjs / lib/agent.mjs）：
//   · 旁路 JSON 表 `sessions.json`：整表覆盖写、失败静默，正常恢复走它；
//   · 私有事实 `claude-code/session`：fsync、按会话分文件，是旁路库丢写时的兜底。
// 这里锁定的是「表里没有就回落到事实；事实也不可用时宁可失忆（undefined），不猜」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginFacts, readJournalRecords } from "../lib/plugin-facts.mjs";
import { load, save } from "../lib/store.mjs";

function withRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "dsh-cc-store-"));
  const previous = process.env.DSH_CLAUDE_CODE_STORE;
  process.env.DSH_CLAUDE_CODE_STORE = root;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_CLAUDE_CODE_STORE;
    else process.env.DSH_CLAUDE_CODE_STORE = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/** 在真实磁盘上给某个会话写事实记录（模拟一次回合的捕获），写完释放锁。 */
function writeJournal(root, sessionId, records) {
  const events = [];
  const session = { id: sessionId, header: { createdAt: 1, cwd: "/w" }, snapshotEvents: () => events };
  const facts = new PluginFacts(session, { root });
  for (const record of records) facts.append(record.type, record.data);
  facts.close();
}

const sessionFact = (id) => ({ type: "claude-code/session", data: { claudeSessionId: id } });
/** 与实现同一套命名规则：只按 session id 的 sha256 定名（写测试时才需要知道文件路径）。 */
const journalName = (sessionId) => `${createHash("sha256").update(JSON.stringify(sessionId)).digest("hex")}.jsonl`;

test("旁路表命中时直接返回它的值", async (t) => {
  const root = withRoot(t);
  await save("s1", "claude-from-table");
  writeJournal(root, "s1", [sessionFact("claude-from-journal")]);
  assert.equal(await load("s1"), "claude-from-table", "表里有值就不必回落到事实");
});

test("旁路表丢失该会话时，从私有事实恢复（表被覆盖/丢写的兜底）", async (t) => {
  const root = withRoot(t);
  writeJournal(root, "s1", [sessionFact("claude-a")]);
  assert.equal(await load("s1"), "claude-a", "表里没有 → 从事实恢复");
});

test("旁路表整个文件损坏（半截 JSON）时同样回落到事实", async (t) => {
  const root = withRoot(t);
  writeJournal(root, "s1", [sessionFact("claude-a")]);
  writeFileSync(join(root, "sessions.json"), '{ "s1": "claude-trunc');
  assert.equal(await load("s1"), "claude-a", "表损坏 = 当作没有这张表，不能因此新建 Claude 会话");
});

test("多条 session 事实以最后一条为准", async (t) => {
  const root = withRoot(t);
  writeJournal(root, "s1", [sessionFact("claude-old"), sessionFact("claude-new")]);
  assert.equal(await load("s1"), "claude-new");
});

test("没有 session 事实时不猜：返回 undefined", async (t) => {
  const root = withRoot(t);
  writeJournal(root, "s1", [{ type: "claude-code/mod-status", data: { state: "fallback" } }]);
  assert.equal(await load("s1"), undefined);
  assert.equal(await load("never-existed"), undefined);
});

test("空值 / 非法值的 session 事实不被当成有效 id", async (t) => {
  const root = withRoot(t);
  writeJournal(root, "s1", [sessionFact("")]);
  assert.equal(await load("s1"), undefined);
});

test("事实日志损坏（截断）时不恢复，也不抛错", async (t) => {
  const root = withRoot(t);
  writeJournal(root, "s1", [sessionFact("claude-a")]);
  const file = join(root, "facts", journalName("s1"));
  const bytes = readFileSync(file);
  writeFileSync(file, bytes.subarray(0, bytes.length - 1));
  assert.equal(await load("s1"), undefined, "截断的日志宁可当作没有");
  assert.equal(readJournalRecords("s1"), undefined);
});

test("文件头身份与请求的会话 id 不符时拒绝（不接错会话）", async (t) => {
  const root = withRoot(t);
  writeJournal(root, "s1", [sessionFact("claude-a")]);
  // 把 s1 的日志内容顶到 s2 的路径上：文件名对得上，但文件头里的 identity.id 是 s1。
  copyFileSync(join(root, "facts", journalName("s1")), join(root, "facts", journalName("s2")));
  assert.equal(await load("s2"), undefined, "身份对不上必须拒绝，宁可失忆");
});

test("save 仍写旁路表（既有行为不变）", async (t) => {
  const root = withRoot(t);
  await save("s1", "claude-x");
  await save("s2", "claude-y");
  const table = JSON.parse(readFileSync(join(root, "sessions.json"), "utf8"));
  assert.deepEqual(table, { s1: "claude-x", s2: "claude-y" });
  // 空 id 不写（避免把 undefined 记成映射）。
  await save("s3", "");
  assert.equal(await load("s3"), undefined);
});
