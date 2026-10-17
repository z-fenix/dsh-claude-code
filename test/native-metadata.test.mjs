import { test } from "node:test";
import assert from "node:assert/strict";
import { attachFacts } from "./helpers/plugin-facts.mjs";
const load = () => import("../lib/native-metadata.mjs");
const snapshot = { window: 200000, tokens: 120, percent: 0, totalTokens: 120, rawMaxTokens: 180000,
  categories: [{ name: "Messages", tokens: 80, kind: "used" }], estimated: true, detail: "summary", truncated: false };
function world(subagents) {
  const session = attachFacts({ id: "metadata-session", snapshotEvents: () => [] });
  return { session, epoch: "epoch1", subagents };
}
const spawn = { kind: "spawn", nativeAgentId: "native1", toolUseId: "call1", model: "child-model", workflow: false };
const step = { kind: "step", turnId: "turn1", index: 0, model: "child-model", modelSource: "response", messageCount: 2,
  appendCount: 1, toolCount: 0, stopReason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 } };

test("context 是明确估算的有界数据，非法数字、full 和正文被拒", async () => {
  const { normalizeContext } = await load();
  assert.deepEqual(normalizeContext(snapshot), snapshot);
  for (const bad of [ { ...snapshot, window: NaN }, { ...snapshot, tokens: -1 }, { ...snapshot, percent: 101 },
    { ...snapshot, estimated: false }, { ...snapshot, detail: "full" }, { ...snapshot, messages: "private" },
    { ...snapshot, categories: Array.from({length:33},() => snapshot.categories[0]) } ]) assert.throws(() => normalizeContext(bad));
});

test("目录元数据不是技能授权，只有 SDK skills 更新可声明技能来源", async () => {
  const { createNativeMetadata, readNativeSnapshots } = await load(); const w = world(); const metadata = createNativeMetadata(w);
  metadata.catalog({ commands: [{ name: "plugin-command", description: "not necessarily a skill", source: "plugin" }], truncated: false });
  assert.equal(readNativeSnapshots(w.session).catalog.skillsObserved, false);
  assert.throws(() => metadata.catalog({ commands: [], skills: [{ name: "forged" }], truncated: false }));
  metadata.skills([{ name: "real-skill", description: "Description", argumentHint: "<input>" }]);
  const catalog = readNativeSnapshots(w.session).catalog;
  assert.equal(catalog.skillsObserved, true);
  assert.equal(catalog.skillsSource, "sdk-reload-skills");
  assert.deepEqual(catalog.skills.map(x => x.name), ["real-skill"]);
  assert.deepEqual(catalog.commands.map(x => x.name), ["plugin-command"]);
  metadata.invalidateSkills();
  assert.equal(readNativeSnapshots(w.session).catalog.skillsObserved, false);
  assert.equal(readNativeSnapshots(w.session).catalog.skillsSource, undefined);
  metadata.context(snapshot);
  assert.equal(readNativeSnapshots(w.session).context.estimated, true);
  assert.deepEqual(w.session.snapshotEvents(), []);
});

test("原生身份提前到达保持未知，SDK 创建子投影后只补一次绑定", async () => {
  const { createNativeMetadata } = await load(); const projections = new Map();
  const w = world({ childSessionIdForToolUseId: id => projections.get(id) }); const metadata = createNativeMetadata(w);
  metadata.observe(spawn, { callerAgentId: null });
  let facts = w.session.factRecords.filter(x => x.type === "claude-code/agent-identity");
  assert.equal(facts[0].data.projectedSessionId, null);
  projections.set("call1", "child-session");
  metadata.afterMessage(); metadata.afterMessage();
  facts = w.session.factRecords.filter(x => x.type === "claude-code/agent-identity");
  assert.equal(facts.length, 2);
  assert.equal(facts[1].data.projectedSessionId, "child-session");
  metadata.observe(step, { callerAgentId: "native1" });
  assert.equal(w.session.factRecords.at(-1).data.projectedSessionId, "child-session");
  metadata.observe(step, { callerAgentId: "unknown-native" });
  assert.equal(w.session.factRecords.at(-1).data.projectedSessionId, null);
  assert.equal(w.session.factRecords.at(-1).data.attribution, "unresolved");
  assert.deepEqual(w.session.snapshotEvents(), []);
});

test("共享 tool-use 的 workflow/多个原生 agent 不能冒认一个子会话", async () => {
  const { createNativeMetadata } = await load(); const w = world({ childSessionIdForToolUseId: () => "one-projection" });
  const metadata = createNativeMetadata(w);
  metadata.observe(spawn, { callerAgentId: null });
  metadata.observe({ ...spawn, nativeAgentId: "native2" }, { callerAgentId: null });
  metadata.observe(step, { callerAgentId: "native1" });
  assert.equal(w.session.factRecords.at(-1).data.projectedSessionId, null);
  assert.equal(w.session.factRecords.at(-1).data.attribution, "ambiguous");
  metadata.observe({ ...spawn, nativeAgentId: "workflow-agent", toolUseId: "workflow-call", workflow: true }, { callerAgentId: null });
  assert.equal(w.session.factRecords.at(-1).data.projectedSessionId, null);
});

test("观察输入不能伪造父身份、传正文或在关闭后继续写", async () => {
  const { createNativeMetadata } = await load(); const w = world(); const metadata = createNativeMetadata(w);
  assert.throws(() => metadata.observe({ ...spawn, parentNativeAgentId: "parent" }, { callerAgentId: null }));
  assert.throws(() => metadata.observe({ ...step, answer: "private text" }, { callerAgentId: null }));
  metadata.close();
  assert.throws(() => metadata.context(snapshot));
  assert.deepEqual(w.session.factRecords, []);
});
