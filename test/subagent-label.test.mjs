import { test } from "node:test";
import assert from "node:assert/strict";
import { subagentDisplay } from "../lib/subagent-label.mjs";

test("任务标签折叠空白，不把角色 prompt 当任务摘要", () => {
  assert.deepEqual(subagentDisplay({ description: "  分析\n工具体系  ", subagent_type: "Explore", prompt: "你是分析助手" }), {
    label: "分析 工具体系", title: "Claude Code · Explore",
  });
});

test("空值和非文本 description 继续尝试类型与名称", () => {
  assert.equal(subagentDisplay({ description: " ", subagent_type: "Explore" }).label, "Explore");
  assert.equal(subagentDisplay({ description: {}, subagent_type: null, name: "worker" }).label, "worker");
  assert.deepEqual(subagentDisplay({}), { label: "子代理", title: "Claude Code · 子代理" });
});

test("去掉终端控制与不可见方向字符，不隐藏真实任务名", () => {
  assert.equal(subagentDisplay({ description: "\x1b[31m任务\x1b[0m‮" }).label, "任务");
  assert.equal(subagentDisplay({ description: "\x1b]0;fake title\x07任务" }).label, "任务");
  assert.equal(subagentDisplay({ description: "\x1b]unterminated" }).label, "子代理");
});

test("合法emoji的连接符不被误当成隐藏方向控制字符", () => {
  assert.equal(subagentDisplay({ description: "👩‍💻 检查代码" }).label, "👩‍💻 检查代码");
});

test("过长中文与emoji按完整Unicode截断并显示省略", () => {
  const { label, title } = subagentDisplay({ description: "😀分析".repeat(80), subagent_type: "类型".repeat(80) });
  assert.ok([...label].length <= 48);
  assert.ok([...title].length <= 48);
  assert.ok(label.endsWith("…"));
  assert.ok(!label.includes("�"));
  assert.ok(!/[\ud800-\udbff]$/.test(label));
});
