// test/auth.test.mjs — claude 可执行解析与子进程环境合成。
import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicEnvFromParent, resolveClaude, scrubbedParentEnvCompat } from "../lib/auth.mjs";

/** 最小假 ctx：subprocess 取不到时走本地兜底。 */
function fakeCtx(services = {}) {
  return { get: (name) => services[name] };
}

test("含路径分隔符的 executable 原样使用（不经 PATH 解析）", async () => {
  const target = process.platform === "win32" ? "C:\\tools\\claude.cmd" : "/usr/local/bin/claude";
  const { executable } = await resolveClaude({ ctx: fakeCtx(), config: { executable: target } });
  assert.equal(executable, target);
});

test("优先用 subprocess 服务解析可执行文件", async () => {
  const calls = [];
  const ctx = fakeCtx({
    subprocess: {
      resolveExecutable: async (name, env, signal) => {
        calls.push({ name, env, signal });
        return `/resolved/${name}`;
      },
    },
  });
  const { executable } = await resolveClaude({
    ctx,
    config: { executable: "claude", env: { ANTHROPIC_API_KEY: "k" } },
  });
  assert.equal(executable, "/resolved/claude");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "claude");
  assert.deepEqual(calls[0].env, { ANTHROPIC_API_KEY: "k" });
});

test("subprocess 解析失败时退回 PATH 扫描（找不到则原样返回）", async () => {
  const ctx = fakeCtx({
    subprocess: {
      resolveExecutable: async () => {
        throw new Error("nope");
      },
    },
  });
  const { executable } = await resolveClaude({ ctx, config: { executable: "definitely-not-a-real-cli-xyz" } });
  assert.equal(executable, "definitely-not-a-real-cli-xyz");
});

// 回归护栏（实测故障，报错逐字为 `spawn EINVAL` / CLAUDE_CODE_ERROR）：
//
// 宿主的 subprocess.resolveExecutable() 返回的是「磁盘上第一个匹配的候选文件」，在本机
// 那是 `…\npm\claude.CMD`（npm 的批处理 shim，因为 %APPDATA%\npm 里没有 claude.exe）。
// Claude Agent SDK 用 spawn(shell:false) 起进程，Node 从 CVE-2024-27980 起禁止直接执行
// .cmd/.bat，于是同步抛 EINVAL（errno -4071）。
//
// 旧实现只在「输入含路径分隔符」时才解 shim，而宿主返回值这条路径直接 return，
// 把 .cmd 交给了 SDK。这里断言：**只要宿主返回的是 .cmd shim，就必须被解成它引用的可执行文件**。
test("宿主 subprocess 返回 .cmd shim 时必须解成真实可执行文件", { skip: process.platform !== "win32" }, async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execPath } = await import("node:process");

  const dir = mkdtempSync(join(tmpdir(), "dsh-cc-hostshim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shim = join(dir, "claude.CMD");
  writeFileSync(shim, `@ECHO off\r\n"${execPath}"   %*\r\n`, "utf8");

  // 复刻宿主：返回 .cmd 的绝对路径（大写扩展名也要能解）
  const ctx = fakeCtx({ subprocess: { resolveExecutable: async () => shim } });
  const { executable } = await resolveClaude({ ctx, config: { executable: "claude" } });

  assert.ok(
    !/\.(cmd|bat)$/i.test(executable),
    `宿主返回 .cmd 时不得把 shim 原样交给 SDK（会 spawn EINVAL），实际得到 ${executable}`,
  );
  assert.equal(executable, execPath, "应当解成 shim 内部引用的真实可执行文件");
});

test("PATH 扫描能解析出真实存在的可执行文件", async () => {
  const target = process.platform === "win32" ? "node.exe" : "node";
  const { executable } = await resolveClaude({ ctx: fakeCtx(), config: { executable: target } });
  assert.match(executable.toLowerCase(), /node(\.exe)?$/);
  assert.ok(
    executable.includes("/") || executable.includes("\\"),
    `应当解析成一个绝对路径，实际得到 ${executable}`,
  );
});

test("Windows 上把 npm 的 .cmd shim 解成它真正调用的可执行文件", { skip: process.platform !== "win32" }, async (t) => {
  // Node 从 CVE-2024-27980 起不允许 spawn 直接执行 .cmd/.bat（shell:false 时 EINVAL），
  // 而 npm 全局 bin 的默认形态正是这种 shim。这里造一个与 npm 同形的 shim 来验证解开逻辑。
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execPath } = await import("node:process");

  const dir = mkdtempSync(join(tmpdir(), "dsh-cc-shim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shim = join(dir, "fake-claude.cmd");
  writeFileSync(shim, `@ECHO off\r\n"${execPath}"   %*\r\n`, "utf8");

  const fromPath = await resolveClaude({ ctx: fakeCtx(), config: { executable: "fake-claude" } });
  // 不在 PATH 里 → 原样返回；把目录临时加进 PATH 再试一次
  const before = process.env.PATH;
  process.env.PATH = `${dir};${before ?? ""}`;
  try {
    const { executable } = await resolveClaude({ ctx: fakeCtx(), config: { executable: "fake-claude" } });
    assert.equal(executable, execPath, "shim 应被解成它引用的真实可执行文件");
  } finally {
    process.env.PATH = before;
  }

  const explicit = await resolveClaude({ ctx: fakeCtx(), config: { executable: shim } });
  assert.equal(explicit.executable, execPath, "显式给出 .cmd 路径时也要解开");
  assert.notEqual(fromPath.executable, execPath);
});

test("ANTHROPIC_* 凭据在清洗之后被补回，且 config.env 最终覆盖", async () => {
  const before = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "from-parent";
  try {
    assert.equal(anthropicEnvFromParent().ANTHROPIC_API_KEY, "from-parent");

    const scrubbed = await scrubbedParentEnvCompat();
    // 清洗口径必须剥掉凭据类变量……
    assert.equal(scrubbed.ANTHROPIC_API_KEY, undefined);
    assert.equal(scrubbed.DSH_ANYTHING, undefined);

    // ……但最终合成出来的 env 必须带上它（否则 claude 无法认证）。
    const { env } = await resolveClaude({ ctx: fakeCtx(), config: { executable: "x/y" } });
    assert.equal(env.ANTHROPIC_API_KEY, "from-parent");

    const overridden = await resolveClaude({
      ctx: fakeCtx(),
      config: { executable: "x/y", env: { ANTHROPIC_API_KEY: "explicit" } },
    });
    assert.equal(overridden.env.ANTHROPIC_API_KEY, "explicit");
  } finally {
    if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = before;
  }
});

test("env 合成包含父进程的搜索路径（PATH），保证 claude 子进程能跑起来", async () => {
  const { env } = await resolveClaude({ ctx: fakeCtx(), config: { executable: "x/y" } });
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1];
  assert.equal(typeof pathValue, "string");
  assert.ok(pathValue.length > 0);
});
