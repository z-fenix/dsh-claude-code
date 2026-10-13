import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePromptSections, PromptSnapshotRecorder } from "../lib/prompt-snapshot.mjs";
import { attachFacts } from "./helpers/plugin-facts.mjs";

const sections = [{ id: "system", text: "shared", scope: "shared" }, { id: "environment", text: "local", scope: "session" }];
test("提示节保持原文/顺序；非法节不被当作系统提示词", () => {
  assert.deepEqual(validatePromptSections(sections), sections);
  for (const invalid of [undefined, "assistant guessed prompt", [{ id: "", text: "x", scope: "shared" }],
    [...sections, { ...sections[0] }], [...sections].reverse(), [{ id: "x", text: 42, scope: "shared" }],
    [{ id: "x", text: "x", scope: "other" }], [{ ...sections[0], complete: true }],
    [{ id: "x", text: "x".repeat(600000), scope: "shared" }]]) {
    assert.throws(() => validatePromptSections(invalid));
  }
});
test("快照仅标 observed-compose，去重且不写 header/system surface", () => {
  const events = [];
  const session = attachFacts({ id: "s1", snapshotEvents: () => events, append(type, data) { const event = { type, data, seq: events.length }; events.push(event); return event; } });
  const recorder = new PromptSnapshotRecorder({ session, agent: { id: "a1" }, epoch: "e1" });
  const first = recorder.record({ sections, model: "model" });
  const duplicate = recorder.record({ sections, model: "model" });
  assert.equal(first.digest, duplicate.digest);
  assert.equal(session.factEvents().length, 1);
  assert.equal(events.length, 0, "私有快照不写原生日志");
  assert.equal(session.factEvents()[0].type, "claude-code/prompt-snapshot");
  assert.equal(session.factEvents()[0].data.source, "observed-compose");
  assert.equal(session.factEvents()[0].data.completeness, "partial");
  assert.equal(session.factEvents()[0].data.compositionLoop, "unattributed");
  assert.deepEqual(session.factEvents()[0].data.sections, sections);
  assert.ok(!events.some((event) => ["system/message", "request/header"].includes(event.type)));
  session.rejectFact = () => { throw new Error("write rejected"); };
  assert.throws(() => recorder.record({ sections: [{ ...sections[0], text: "changed" }], model: "model" }), /write rejected/);
  assert.equal(recorder.record({ sections, model: "model" }).digest, first.digest);
});
