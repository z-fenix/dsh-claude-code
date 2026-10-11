// test/tasks.test.mjs — Claude 原生任务工具 → DSH 任务表回放（todo/write 快照的数据源）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeTaskTable, normalizeTodoInput } from "../lib/tasks.mjs";

// ---------------------------------------------------------------------------
// normalizeTodoInput：TodoWrite 整表入参的归一化
// ---------------------------------------------------------------------------

test("normalizeTodoInput：trim 内容、丢弃空内容/非法状态/重复项", () => {
  assert.deepEqual(normalizeTodoInput([
    { content: " a ", status: "in_progress" },
    { content: "", status: "pending" },
    { content: "b", status: "bogus" },
    { content: "a", status: "completed" }, // 与 trim 后的 "a" 重复
  ]), [
    { content: "a", status: "in_progress" },
  ]);
});

test("normalizeTodoInput：非数组返回 null，空数组返回空表", () => {
  assert.equal(normalizeTodoInput(undefined), null);
  assert.equal(normalizeTodoInput("nope"), null);
  assert.deepEqual(normalizeTodoInput([]), []);
});

test("normalizeTodoInput：保留多个 in_progress（Claude 允许并行，投影层不做校验）", () => {
  const todos = normalizeTodoInput([
    { content: "a", status: "in_progress" },
    { content: "b", status: "in_progress" },
  ]);
  assert.equal(todos.length, 2);
  assert.ok(todos.every((item) => item.status === "in_progress"));
});

// ---------------------------------------------------------------------------
// ClaudeTaskTable：TodoWrite 整表替换
// ---------------------------------------------------------------------------

test("TodoWrite：整表替换，快照只含 content/status", () => {
  const table = new ClaudeTaskTable();
  const snapshot = table.applyToolCall("TodoWrite", { todos: [
    { content: "one", status: "completed", activeForm: "doing one" },
    { content: "two", status: "pending" },
  ] });
  assert.deepEqual(snapshot, [
    { content: "one", status: "completed" },
    { content: "two", status: "pending" },
  ]);
  // 第二次整表替换：last-write-wins
  const next = table.applyToolCall("TodoWrite", { todos: [{ content: "three", status: "in_progress" }] });
  assert.deepEqual(next, [{ content: "three", status: "in_progress" }]);
});

test("TodoWrite：入参缺 todos 数组 → 无变更（返回 null，不写事件）", () => {
  const table = new ClaudeTaskTable();
  assert.equal(table.applyToolCall("TodoWrite", {}), null);
  assert.equal(table.applyToolCall("TodoWrite", { todos: "nope" }), null);
  assert.equal(table.snapshot(), null, "空表快照为 null");
});

// ---------------------------------------------------------------------------
// ClaudeTaskTable：TaskCreate / TaskUpdate 原生任务系统
// ---------------------------------------------------------------------------

test("TaskCreate：追加 pending 项；回执文本绑定真实 id", () => {
  const table = new ClaudeTaskTable();
  const created = table.applyToolCall("TaskCreate", { subject: "alpha" }, "call1");
  assert.deepEqual(created, [{ content: "alpha", status: "pending" }]);

  // 实测回执："Task #1 created successfully: alpha"
  const bound = table.applyToolResult("TaskCreate", "call1", "Task #1 created successfully: alpha");
  assert.equal(bound, null, "绑定只改内部 id，不产生新快照");
  assert.deepEqual(table.snapshot(), [{ content: "alpha", status: "pending" }]);
});

test("TaskCreate：content 兜底 subject 缺失的场景（description / content）", () => {
  const table = new ClaudeTaskTable();
  table.applyToolCall("TaskCreate", { description: "from description" }, "call1");
  table.applyToolCall("TaskCreate", { content: "from content" }, "call2");
  assert.deepEqual(table.snapshot(), [
    { content: "from description", status: "pending" },
    { content: "from content", status: "pending" },
  ]);
});

test("TaskUpdate：已绑定 id 直接生效", () => {
  const table = new ClaudeTaskTable();
  table.applyToolCall("TaskCreate", { subject: "alpha" }, "call1");
  table.applyToolResult("TaskCreate", "call1", "Task #1 created successfully: alpha");

  const snapshot = table.applyToolCall("TaskUpdate", { taskId: "1", status: "in_progress" });
  assert.deepEqual(snapshot, [{ content: "alpha", status: "in_progress" }]);
});

test("TaskUpdate：id 未绑定时排队，TaskCreate 回执到达后清算", () => {
  const table = new ClaudeTaskTable();
  table.applyToolCall("TaskCreate", { subject: "alpha" }, "call1");
  // 回执未到，taskId 引用的 id 还不存在 → 排队
  assert.equal(table.applyToolCall("TaskUpdate", { taskId: "1", status: "completed" }), null);
  assert.deepEqual(table.snapshot(), [{ content: "alpha", status: "pending" }], "排队期间表不变");

  // 回执绑定后，排队的补丁自动生效
  table.applyToolResult("TaskCreate", "call1", "Task #1 created successfully: alpha");
  assert.deepEqual(table.snapshot(), [{ content: "alpha", status: "completed" }]);
});

test("TaskUpdate：status deleted 移除该项", () => {
  const table = new ClaudeTaskTable();
  table.applyToolCall("TaskCreate", { subject: "alpha" }, "call1");
  table.applyToolResult("TaskCreate", "call1", "Task #1 created successfully: alpha");
  const snapshot = table.applyToolCall("TaskUpdate", { taskId: "1", status: "deleted" });
  assert.deepEqual(snapshot, []);
});

test("TaskUpdate：subject 改写内容", () => {
  const table = new ClaudeTaskTable();
  table.applyToolCall("TaskCreate", { subject: "alpha" }, "call1");
  table.applyToolResult("TaskCreate", "call1", "Task #1 created successfully: alpha");
  const snapshot = table.applyToolCall("TaskUpdate", { taskId: "1", subject: "renamed" });
  assert.deepEqual(snapshot, [{ content: "renamed", status: "pending" }]);
});

test("TaskUpdate：引用从未创建的 id → 忽略（不崩溃、不产生快照）", () => {
  const table = new ClaudeTaskTable();
  table.applyToolCall("TaskCreate", { subject: "alpha" }, "call1");
  table.applyToolResult("TaskCreate", "call1", "Task #1 created successfully: alpha");
  assert.equal(table.applyToolCall("TaskUpdate", { taskId: "99", status: "completed" }), null);
  assert.deepEqual(table.snapshot(), [{ content: "alpha", status: "pending" }]);
});

test("非任务工具的调用/回执一律不产生快照", () => {
  const table = new ClaudeTaskTable();
  assert.equal(table.applyToolCall("Bash", { command: "ls" }), null);
  assert.equal(table.applyToolCall("Write", { file_path: "x" }), null);
  assert.equal(table.applyToolResult("TaskCreate", "unknown-call", "Task #9 created"), null, "无占位项可绑定时忽略");
  assert.equal(table.snapshot(), null);
});

test("TaskCreate：入参 tasks 数组一次创建多项", () => {
  const table = new ClaudeTaskTable();
  const snapshot = table.applyToolCall("TaskCreate", { tasks: [{ subject: "a" }, { subject: "b" }] });
  assert.deepEqual(snapshot, [
    { content: "a", status: "pending" },
    { content: "b", status: "pending" },
  ]);
});

test("TodoWrite 替换后，TaskCreate 的占位 id 从 1 重新编号", () => {
  // TodoWrite 的整表替换语义意味着 CLI 侧任务列表也换了语境；表内 id 无从对应，
  // 新建的 TaskCreate 回执 id 从 CLI 侧重新分配，绑定逻辑必须不受旧表残留影响。
  const table = new ClaudeTaskTable();
  table.applyToolCall("TaskCreate", { subject: "old" }, "call1");
  table.applyToolCall("TodoWrite", { todos: [{ content: "new", status: "pending" }] });
  table.applyToolCall("TaskCreate", { subject: "fresh" }, "call2");
  table.applyToolResult("TaskCreate", "call2", "Task #1 created successfully: fresh");
  table.applyToolCall("TaskUpdate", { taskId: "1", status: "in_progress" });
  assert.deepEqual(table.snapshot(), [
    { content: "new", status: "pending" },
    { content: "fresh", status: "in_progress" },
  ]);
});
