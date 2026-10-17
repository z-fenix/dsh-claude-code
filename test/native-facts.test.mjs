import { test } from "node:test";
import assert from "node:assert/strict";
import { attachFacts } from "./helpers/plugin-facts.mjs";

test("原生维护和 CLI 压缩事实进入独立台账，不污染原生日志", () => {
  const session = attachFacts({ id: "native-facts", snapshotEvents: () => [] });
  session.facts.append("claude-code/native-operation", { operationId: "op1", state: "pending" });
  session.facts.append("claude-code/compact", { kind: "started" });
  session.facts.append("claude-code/tool-lifecycle", { phase: "prepared", callId: "t1" });
  assert.deepEqual(session.factRecords.map((x) => x.type), ["claude-code/native-operation", "claude-code/compact", "claude-code/tool-lifecycle"]);
  assert.deepEqual(session.snapshotEvents(), []);
  assert.throws(() => session.facts.append("arbitrary/fact", {}), /unknown private fact/);
});
