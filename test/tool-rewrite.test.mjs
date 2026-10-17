import { test } from "node:test";
import assert from "node:assert/strict";
const load = () => import("../mods/dsh-bridge/hooks/rewrite.mjs");
test("只改写已审计自由字段，不允许删 required、改类型或身份", async () => {
  const { validateToolRewrite } = await load();
  const original = { file_path: "/w/file", content: "old" };
  assert.deepEqual(validateToolRewrite("Write", original, { file_path: "/w/new", content: "new" }), { file_path: "/w/new", content: "new" });
  for (const candidate of [{ content: "new" }, { ...original, content: 42 }, { ...original, tool: "Bash" }, { ...original, extra: "x" }]) {
    assert.throws(() => validateToolRewrite("Write", original, candidate));
  }
  assert.throws(() => validateToolRewrite("Bash", { command: "read" }, { command: "write" }));
});

test("未改字段保留原生已验证的枚举，脱离监听器后续修改", async () => {
  const { validateToolRewrite } = await load();
  const original = { notebook_path: "/w/n.ipynb", new_source: "old", edit_mode: "replace", cell_type: "code" };
  const candidate = { ...original, new_source: "new" };
  const result = validateToolRewrite("NotebookEdit", original, candidate);
  candidate.new_source = "later change";
  assert.equal(result.new_source, "new");
  assert.throws(() => validateToolRewrite("NotebookEdit", original, { ...original, edit_mode: "invalid" }));
});
