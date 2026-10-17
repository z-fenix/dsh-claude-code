// 每个 executable 都用离线 CLI 校验/测试证明能力；只给本次子进程追加 mod。
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalize } from "node:path";

export const MOD_PATH = fileURLToPath(new URL("../mods/dsh-bridge/", import.meta.url)).replace(/[\\/]$/, "");
export const COMPACT_OBSERVER_PATH = fileURLToPath(new URL("../mods/dsh-compact-observer/", import.meta.url)).replace(/[\\/]$/, "");
const probes = new Map();
function stamp(path) { try { return statSync(path).mtimeMs; } catch { return "missing"; } }
function command(executable, args, env, signal) {
  return new Promise((resolve, reject) => execFile(executable, args, {
    env: { ...env, NO_COLOR: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    signal, timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true,
  }, (error, stdout, stderr) => {
    if (error) reject(new Error(String(stderr || error.message).slice(0, 2048)));
    else resolve(`${stdout}\n${stderr}`);
  }));
}
export async function probeModSupport({ executable, env, signal, modPath = MOD_PATH }) {
  const canceled = { supported: false, reason: "mod capability probe canceled" };
  if (signal?.aborted) return canceled;
  const key = [executable, modPath, stamp(executable), ...[".claude-plugin/plugin.json", "hooks/hooks.json", "hooks/bridge.mjs",
    "hooks/bridge.test.ts", "hooks/runtime.mjs", "hooks/runtime.test.ts", "hooks/rpc.mjs", "hooks/rewrite.mjs",
    "hooks/metadata.mjs", "hooks/metadata.test.ts", "hooks/dsh-tools.mjs", "hooks/dsh-tools.test.ts", "hooks/observer.mjs", "hooks/observer.test.ts"].map((file) => stamp(`${modPath}/${file}`))].join(":");
  if (!probes.has(key)) {
    const task = { controller: new AbortController(), subscribers: 0, settled: false };
    task.promise = (async () => {
      try {
        await command(executable, ["plugin", "validate", modPath], env, task.controller.signal);
        const report = await command(executable, ["plugin", "test", modPath], env, task.controller.signal);
        if (!/\b[1-9]\d*\s+pass\b/.test(report)) return { supported: false, reason: "CLI did not confirm passing mod tests" };
        return { supported: true };
      } catch (error) { return { supported: false, reason: String(error.message) }; }
    })().finally(() => {
      task.settled = true;
      if (task.controller.signal.aborted && probes.get(key) === task) probes.delete(key);
    });
    probes.set(key, task);
  }
  const task = probes.get(key);
  task.subscribers += 1;
  let onAbort;
  try {
    if (!signal) return await task.promise;
    return await Promise.race([task.promise, new Promise((resolve) => {
      onAbort = () => resolve(canceled);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    task.subscribers -= 1;
    if (!task.settled && task.subscribers === 0) {
      task.controller.abort();
      if (probes.get(key) === task) probes.delete(key);
    }
  }
}

export function buildModOptions({ config = {}, env = {}, bridge, supported = false }) {
  const requested = config.goal?.transport ?? "mcp";
  if (!["mcp", "mod", "auto"].includes(requested)) throw new TypeError("goal.transport must be mcp, mod or auto");
  const enabled = config.mods?.enabled === true && supported;
  const goalTransport = enabled && requested !== "mcp" ? "mod" : "mcp";
  const plugins = [...(config.plugins ?? [])];
  const samePath = (path) => {
    const key = normalize(path).replace(/[\\/]$/, "");
    return process.platform === "win32" ? key.toLowerCase() : key;
  };
  if (enabled && !plugins.some((plugin) => plugin.type === "local" && samePath(plugin.path) === samePath(MOD_PATH))) plugins.push({ type: "local", path: MOD_PATH });
  return { enabled, goalTransport, sdkOptions: {
    env: { ...env, ...(enabled ? { DSH_CLAUDE_BRIDGE: JSON.stringify(bridge) } : {}) },
    ...(plugins.length > 0 ? { plugins } : {}),
  } };
}
