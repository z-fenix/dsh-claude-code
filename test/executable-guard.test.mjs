// test/executable-guard.test.mjs — 解析出的 claude 若不可直接 spawn，必须在起进程前拦住。
//
// 现象（工具桥验收 2026-10-14 的第四个回合）：回合以 `spawn EINVAL` / CLAUDE_CODE_ERROR 结束，
// 时间 <1s、没有 request/header —— CLI 根本没起来。根因链路（2026-10-15 定位并实测）：
//   shim 解不开 → lib/auth.mjs 把 .cmd 原样返回 → SDK 按扩展名判定它是原生可执行文件
//   （只对 .js/.mjs/.ts/.tsx/.jsx 才改用 node 起）→ Node 直接 spawn .cmd
//   → 自 CVE-2024-27980 起的守卫同步抛 `spawn EINVAL`（errno -4071）。
// 旧实现只在 catch 里记一句快照，用户只看到 errno。这里锁定：解析结果不可 spawn 时，
// 不调用 SDK、直接以带修复指引的错误结束该回合。
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 私有事实库默认落在用户真实的 `~/.dsh/dsh-claude-code`；必须在 import 之前改写根目录。
process.env.DSH_CLAUDE_CODE_STORE = mkdtempSync(join(tmpdir(), "dsh-cc-exe-guard-"));

let queryCalls = 0;
mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    query: () => { queryCalls += 1; return (async function* empty() {})(); },
    createSdkMcpServer: (opts) => opts,
    tool: (name, description, inputSchema, handler) => ({ name, description, inputSchema, handler }),
  },
});
const { runClaudeCode } = await import("../lib/claude-run.mjs");

let sessionSeq = 0;
const sessionWith = () => ({
  id: `exe${++sessionSeq}`, append() {}, requestContext: () => undefined, requestHeader: () => undefined,
  snapshotEvents: () => [],
});
const ctx = { get: () => undefined, logger: { warn() {}, info() {} } };
const run = (executable) => runClaudeCode({
  ctx, config: {}, session: sessionWith(), agent: { id: "a1", status: "running" },
  turn: 1, prompt: "hi", signal: new AbortController().signal, cwd: process.cwd(), executable, env: {},
});

test("解析结果是 Windows 批处理 shim 时：不启动 SDK，回合以可读错误结束", { skip: process.platform !== "win32" }, async () => {
  queryCalls = 0;
  const result = await run("C:\\npm\\claude.cmd");

  assert.equal(queryCalls, 0, "不可直接 spawn 的 shim 绝不能交给 SDK");
  assert.equal(result.stopReason, "error");
  const text = result.output.map((block) => block.text).join(" ");
  assert.match(text, /claude\.cmd/, `错误里要能看出是哪个路径，实际 ${JSON.stringify(text)}`);
  assert.match(text, /\.exe/i, "错误里要给出可行的修复方向（指向真正的 exe）");
});

test("可解析成真实可执行文件时不受影响", async () => {
  queryCalls = 0;
  const result = await run(process.platform === "win32" ? "C:\\npm\\claude.exe" : "/usr/local/bin/claude");
  assert.equal(queryCalls, 1);
  assert.equal(result.stopReason, "completed");
});
