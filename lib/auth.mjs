// lib/auth.mjs — 解析本机 claude 可执行文件，并合成传给 Claude Agent SDK 的子进程环境。
//
// 双通道认证：既支持本机 `claude` 已登录（CLI 自带凭据），也支持显式给 API key / 代理端点。
//
// @deepseek-ai/dsh-subprocess 是**可选**依赖：它的加载会拉进一串 peer（dsh-http-proxy 等），
// 任何一条解析不到都会连带本插件加载失败，而它在这里只提供两个小工具。因此本模块延迟、
// 容错地取它；取不到时用等价的本地实现兜底（env 清洗宁可多洗，PATH 解析按 Windows 语义）。
let subprocessModule;

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** 尽力加载 dsh-subprocess；失败返回 undefined（调用方走本地兜底）。 */
async function loadSubprocess() {
  if (subprocessModule !== undefined) return subprocessModule;
  try {
    subprocessModule = await import("@deepseek-ai/dsh-subprocess");
  } catch {
    subprocessModule = null;
  }
  return subprocessModule ?? undefined;
}

/** 名字像凭据的环境变量（与 dsh-subprocess 的清洗口径一致）。 */
const SENSITIVE_ENV_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

/**
 * 按名字大小写不敏感地读环境变量。
 *
 * Windows 的环境块里 PATH 常常拼作 `Path`，`process.env.PATH` 只在 Node 的普通对象视图里
 * 才被兜住——一旦自己 `Object.entries(process.env)` 重建一份，就会丢掉这个键，claude 子进程
 * 便找不到 PATH（进而找不到任何命令）。所以凡是从父环境取值都必须走这里。
 */
export function readEnvCaseInsensitive(name) {
  const wanted = name.toUpperCase();
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key.toUpperCase() === wanted) return value;
  }
  return undefined;
}

/**
 * 清洗后的父环境：去掉凭据类与 `DSH_` 前缀变量，其余原样交给 claude 子进程。
 * 优先用 dsh-subprocess 的实现（它会额外处理代理变量），否则用上面的口径兜底。
 */
export async function scrubbedParentEnvCompat() {
  const mod = await loadSubprocess();
  if (typeof mod?.scrubbedParentEnv === "function") {
    try {
      const scrubbed = mod.scrubbedParentEnv();
      // 不同实现对键名大小写的处理可能不同；PATH 这类基础变量必须保证存在，
      // 且不能依赖键名恰好是 `PATH`（Windows 上通常是 `Path`）。
      const pathValue = readEnvCaseInsensitive("PATH");
      if (pathValue === undefined) return scrubbed;
      if (Object.keys(scrubbed).some((key) => key.toUpperCase() === "PATH")) return scrubbed;
      return { ...scrubbed, PATH: pathValue };
    } catch {
      // 落到本地实现
    }
  }
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SENSITIVE_ENV_PATTERN.test(key)) continue;
    if (key.toUpperCase().startsWith("DSH_")) continue;
    env[key] = value;
  }
  // Windows 上 PATH 常拼作 `Path`；统一补一个 PATH，避免子进程拿不到搜索路径。
  if (readEnvCaseInsensitive("PATH") !== undefined && !Object.keys(env).some((key) => key.toUpperCase() === "PATH")) {
    env.PATH = readEnvCaseInsensitive("PATH");
  }
  return env;
}

/**
 * 从父环境取回 Anthropic 专属环境变量（`ANTHROPIC_*`）。
 *
 * 清洗会把名字含 KEY/TOKEN/SECRET/PASSWORD 的变量剥掉（如 `ANTHROPIC_AUTH_TOKEN`、
 * `ANTHROPIC_API_KEY`），但 claude 子进程恰恰需要这些凭据才能认证；缺了它们，兼容端点会把
 * usage 全报 0（上下文占用条就没读数）。所以在清洗之后再补回父环境的 `ANTHROPIC_*`，
 * 最后仍由 config.env 覆盖。
 *
 * @returns {Record<string,string>} 需要补回的环境变量
 */
export function anthropicEnvFromParent() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key.startsWith("ANTHROPIC_")) env[key] = value;
  }
  return env;
}

/**
 * 这个路径交给 `spawn(shell:false)` 是否必然失败。
 *
 * Windows 上 `.cmd`/`.bat` 不能直接起：Node 自 CVE-2024-27980 起同步抛 `spawn EINVAL`
 * （errno -4071）。而 Claude Agent SDK 只按扩展名决定要不要用 node 起脚本
 * （`.js/.mjs/.ts/.tsx/.jsx` 才会，见 SDK 的 `hxe()`），所以 `.cmd` 会被它当成原生可执行文件
 * 直接 spawn。拆不出真身的 shim 因此必须由调用方拒绝，而不是交给 SDK 去撞 errno。
 *
 * @param {unknown} file 候选可执行文件路径
 * @returns {boolean}
 */
export function cannotSpawnDirectly(file) {
  return process.platform === "win32" && typeof file === "string" && /\.(cmd|bat)$/i.test(file);
}

/**
 * 按 PATH 解析可执行文件（Windows 下补 .cmd/.exe 等 PATHEXT 后缀）。
 * 找不到时原样返回 target，让 Claude SDK 自己再试一次并给出它自己的报错。
 */
function resolveFromPath(target) {
  const isWindows = process.platform === "win32";
  const pathValue = readEnvCaseInsensitive("PATH") ?? "";
  const dirs = pathValue.split(isWindows ? ";" : ":").filter(Boolean);
  const sep = isWindows ? "\\" : "/";
  // Windows 上必须解析出带扩展名的真实可执行文件：npm 全局装的 claude 旁边有
  // `claude.cmd` / `claude.ps1`，而同名的无扩展名文件是 POSIX shell 脚本，
  // CreateProcess 起不来它（会报 "native binary exists but failed to launch"）。
  // 所以 Windows 先按 PATHEXT 找，找不到才退回原名；POSIX 只认原名。
  const exts = isWindows
    ? [...(readEnvCaseInsensitive("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean), ""]
    : [""];
  let shimOnly;
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = `${dir}${sep}${target}${ext}`;
      try {
        if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
        const resolved = unwrapWindowsShim(candidate) ?? candidate;
        // 解不开的 shim（它引用的可执行文件当时不在，例如 CLI 正在被更新覆盖）不能采信：
        // 它只会让 SDK 撞上 `spawn EINVAL`。继续往后找，实在没有才拿它当最后手段报错。
        if (cannotSpawnDirectly(resolved)) { shimOnly ??= resolved; continue; }
        return resolved;
      } catch {
        // 单个候选不可读就继续
      }
    }
  }
  return shimOnly ?? target;
}


/**
 * Windows 上把 npm 生成的 `.cmd` shim 换成它真正调用的可执行文件。
 *
 * Node 从 CVE-2024-27980 起不允许 `spawn` 直接执行 `.cmd`/`.bat`（shell:false 时返回
 * EINVAL），而 Claude Agent SDK 正是用 spawn 起 claude。npm 全局装的 `claude.cmd` 只是
 * 一层转发，内容形如：
 *
 *     "%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*
 *
 * 读出它引用的 `.exe` 并改用那个绝对路径，是这里唯一能让 CLI 真正跑起来的做法。
 *
 * @param {string} file 候选可执行文件的绝对路径
 * @returns {string|undefined} shim 指向的真实可执行文件，解析不出来时返回 undefined
 */
function unwrapWindowsShim(file) {
  if (process.platform !== "win32") return undefined;
  if (!/\.(cmd|bat)$/i.test(file)) return undefined;
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const match = /"?([^"\r\n]*?\.exe)"?/i.exec(content);
  if (match === null) return undefined;
  const referenced = match[1].replace(/%dp0%|%~dp0/gi, dirname(file)).trim();
  if (referenced === "") return undefined;
  try {
    return existsSync(referenced) && statSync(referenced).isFile() ? referenced : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 解析 claude 可执行文件并合成 SDK 的 `env`。
 *
 * SDK 的 `env` 是「整体替换」子进程环境：先合并清洗过的父环境，再补回 claude 必需的
 * `ANTHROPIC_*` 凭据，最后叠加显式配置。
 *
 * @param {object} options
 * @param {object} options.ctx 取 `subprocess` 服务的上下文
 * @param {object} options.config 引擎配置（`executable` / `env`）
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ executable: string, env: Record<string,string> }>}
 */
export async function resolveClaude({ ctx, config, signal }) {
  const target = config?.executable ?? "claude";
  const env = { ...(await scrubbedParentEnvCompat()), ...anthropicEnvFromParent(), ...(config?.env ?? {}) };
  // 显式路径同样可能要解 shim（用户常直接写 ...\npm\claude.cmd）。
  if (target.includes("/") || target.includes("\\")) {
    return { executable: unwrapWindowsShim(target) ?? target, env };
  }

  // 优先用宿主 subprocess 服务解析（它会应用 PATH 覆盖、平台语义与显式 env）；
  // 服务不存在或其自身解析失败时退回本地 PATH 扫描。
  let subprocess;
  try {
    subprocess = ctx.get("subprocess");
  } catch {
    subprocess = undefined;
  }
  if (subprocess !== undefined && typeof subprocess.resolveExecutable === "function") {
    try {
      const resolved = await subprocess.resolveExecutable(target, config?.env ?? {}, signal);
      // 关键：宿主服务返回的是**磁盘上第一个匹配的候选文件**，在这台机器上是 npm 的批处理
      // shim `claude.cmd`。而 Claude Agent SDK 用 spawn(shell:false) 起进程，Node 从
      // CVE-2024-27980 起**禁止直接执行 .cmd/.bat**，于是同步抛 `spawn EINVAL`
      // （实测 errno -4071，与用户报错逐字一致）。所以这里无条件再解一次 shim。
      const executable = unwrapWindowsShim(resolved) ?? resolved;
      // 记录解析链条：EINVAL 只给 errno，没有这条日志就无法判断是「宿主给了 shim」还是
      // 「拆解失败」还是「SDK 拿到别的路径」。
      try {
        ctx.logger?.info?.(
          `dsh-claude-code: claude executable resolved — target=${JSON.stringify(target)} subprocessReturned=${JSON.stringify(resolved)} final=${JSON.stringify(executable)}`,
        );
      } catch {
        // 日志失败不影响解析
      }
      if (!cannotSpawnDirectly(executable)) return { executable, env };
      // 解不开的 shim 不采信（宿主只挑了「第一个存在的候选」，不代表它能跑）：
      // 落到下面的本地 PATH 扫描，那里会继续往后找可 spawn 的候选。
      ctx.logger?.warn?.(
        `dsh-claude-code: the host resolved ${JSON.stringify(resolved)} — a Windows batch shim whose target is not on disk right now (mid-update or a broken install); not handing .cmd to the SDK (it would fail with spawn EINVAL), falling back to the local PATH scan`,
      );
    } catch {
      // 落到本地实现
    }
  }
  // resolveFromPath 内部已经做过 PATHEXT 扫描与 shim 拆解，拿到的是真正的可执行文件。
  const fallback = resolveFromPath(target);
  try {
    ctx.logger?.info?.(
      `dsh-claude-code: claude executable resolved via local PATH scan — target=${JSON.stringify(target)} final=${JSON.stringify(fallback)}`,
    );
    if (cannotSpawnDirectly(fallback)) {
      // 最后手段只剩一个解不开的 shim：如实交回并由调用方拒绝，错误信息里带上路径。
      ctx.logger?.warn?.(
        `dsh-claude-code: only a Windows batch shim could be resolved for ${JSON.stringify(target)} (${JSON.stringify(fallback)}); the run must be refused rather than spawned`,
      );
    }
  } catch {
    // 忽略
  }
  return { executable: fallback, env };
}
