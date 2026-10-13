// lib/permission.mjs — 把 DSH 会话的权限状态映射成 Claude Code 的权限策略。
//
// 纯折叠 + 纯判断，零依赖，可单测。
//
// 事件结构：
//   "sandbox/mode"    → data.mode   : 'read-only' | 'workspace-write' | 'danger-full-access'
//   "approval/policy" → data.policy : 'ask' | 'never'
// 这两个事件在会话创建时由 permission-presets 钉进初值，运行中用户切权限模式会再追加一条
// 同类型事件覆盖之——所以 last-event-wins 的折叠必须每次现读，不能缓存回合起点的快照。
import path from "node:path";

// 折叠本身住在 session-events.mjs（会话日志读取的统一入口），这里只做策略映射。
export { foldPermission as readPermission } from "./session-events.mjs";

/** 判断路径 p 是否落在工作区根目录 cwd 内（含 cwd 本身）。 */
export function isWithinWorkspace(cwd, p) {
  if (!cwd || !p) return false;
  const rel = path.relative(path.resolve(cwd), path.resolve(p));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * 把 DSH 权限映射成 SDK 策略：
 *  - "bypass"     danger-full-access → permissionMode=bypassPermissions，完全跳过权限判定
 *  - "no-prompt"  approval policy=never → 无交互；仅 workspace-write 的工作区路径可放行
 *  - "ask"        其余 → 需要权限的操作走 DSH 审批（read-only 不享有区内自动写许可）
 *
 * @param {{ mode?: string, policy?: string }} permission 折叠出的当前权限
 * @returns {'bypass'|'no-prompt'|'ask'}
 */
export function permissionStrategy({ mode, policy } = {}) {
  if (mode === "danger-full-access") return "bypass";
  if (policy === "never") return "no-prompt";
  return "ask";
}
