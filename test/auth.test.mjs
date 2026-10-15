// test/auth.test.mjs — claude 可执行解析与子进程环境合成。
import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicEnvFromParent, cannotSpawnDirectly, resolveClaude, scrubbedParentEnvCompat } from "../lib/auth.mjs";

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

// `spawn EINVAL` 的**残留**成因（2026-10-15 定位）：上面那条护栏只覆盖「宿主给的 shim 能解开」。
// 一旦 shim 引用的可执行文件当时不可读（CLI 正被 npm/自带更新器替换、安装未完成），unwrap 返回
// undefined，旧实现 `unwrapWindowsShim(x) ?? x` 就把 .cmd **原样**交回给宿主——
// 而 SDK 只按扩展名判断要不要用 node 起脚本（`.js/.mjs/.ts/.tsx/.jsx` 才会），
// 于是 .cmd 被当成原生可执行文件直接 spawn，Node 同步抛 `spawn EINVAL`（errno -4071）。
// 实测这条链路是当时唯一能产生该报错的输入类别（.ps1 与无扩展名是 ENOENT；env/args/cwd
// 的非法形态分别是 ERR_INVALID_ARG_VALUE/ENOENT，都不是 EINVAL）。
test("宿主给的 shim 解不开时不得采信它：退回 PATH 扫描里能直接 spawn 的候选", { skip: process.platform !== "win32" }, async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "dsh-cc-brokenshim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // 引用的 claude.exe 不存在 —— 正是 CLI 更新中途的形态
  const broken = join(dir, "broken-claude.cmd");
  writeFileSync(broken, `@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\missing.exe"   %*\r\n`, "utf8");
  const usable = join(dir, "broken-claude.EXE");
  writeFileSync(usable, "not a real binary, but the extension is directly spawnable", "utf8");

  const before = process.env.PATH;
  process.env.PATH = `${dir};${before ?? ""}`;
  try {
    const ctx = fakeCtx({ subprocess: { resolveExecutable: async () => broken } });
    const { executable } = await resolveClaude({ ctx, config: { executable: "broken-claude" } });
    assert.equal(executable, usable, "宿主给的 shim 解不开时应当退回 PATH 扫描里的可用候选");
    assert.equal(cannotSpawnDirectly(executable), false);
  } finally {
    process.env.PATH = before;
  }
});

test("确实只有解不开的 shim 时：原样返回并留日志，由调用方拒绝（不交给 SDK）", { skip: process.platform !== "win32" }, async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "dsh-cc-onlyshim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shim = join(dir, "lonely-claude.cmd");
  writeFileSync(shim, `@ECHO off\r\n"%dp0%\\bin\\missing.exe"   %*\r\n`, "utf8");

  const warns = [];
  const ctx = { get: () => undefined, logger: { info() {}, warn: (line) => warns.push(line) } };
  const before = process.env.PATH;
  process.env.PATH = `${dir};${before ?? ""}`;
  try {
    const { executable } = await resolveClaude({ ctx, config: { executable: "lonely-claude" } });
    assert.ok(cannotSpawnDirectly(executable), "解不开的 shim 必须被标成不可直接 spawn");
    // 大小写不敏感：候选名来自 PATHEXT（`.CMD`），而 Windows 的文件系统也不区分大小写。
    assert.ok(warns.some((line) => /lonely-claude\.cmd/i.test(line)), `应当留下可定位的日志，实际 ${JSON.stringify(warns)}`);
  } finally {
    process.env.PATH = before;
  }
});

test("cannotSpawnDirectly 只对 Windows 批处理 shim 为真", () => {
  assert.equal(cannotSpawnDirectly("/usr/local/bin/claude"), false);
  assert.equal(cannotSpawnDirectly("C:\\tools\\claude.exe"), false);
  assert.equal(cannotSpawnDirectly(undefined), false);
  assert.equal(cannotSpawnDirectly("claude"), false);
  if (process.platform === "win32") {
    assert.equal(cannotSpawnDirectly("C:\\x\\claude.CMD"), true);
    assert.equal(cannotSpawnDirectly("C:\\x\\claude.bat"), true);
  }
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
