// lib/session-events.mjs — 读会话事件日志的小工具。
//
// DSH 0.2.0-rc.2 的 Session 不再暴露 `events` 数组（只有内部 `log`），公开读取口是
// `snapshotEvents(fromSeq, toSeqExclusive)`。本模块把「读全量事件 + 折叠某类事件」收在一处，
// 让权限、待办队列、续接三处都走同一个入口，也便于单测喂入普通数组。
//
// 说明：snapshotEvents 在 0.2.0-rc.2 标记为 deprecated（上游在把同步读迁移到投影），但它仍是
// 当前可用的公开读取面；投影注册（sessionProjections）是插件不能占用的原生 key（'inbox' /
// 'turnBoundary'），故本插件用读取 + 自行折叠的方式实现同样的事实。

/**
 * 读一个会话的全部事件（无会话或读取失败时返回空数组）。
 * @param {object} session 会话对象
 * @returns {readonly object[]} 事件数组
 */
export function readSessionEvents(session) {
  if (session === undefined || session === null) return [];
  try {
    if (typeof session.snapshotEvents === "function") {
      const events = session.snapshotEvents();
      return Array.isArray(events) ? events : [];
    }
  } catch {
    // 读取失败（会话已释放等）等价于「没有可读历史」
  }
  return [];
}

/**
 * 折叠 `agent/inbox/spliced` 事件，重建两条待办队列的当前状态。
 *
 * 与原生 inbox 投影（dsh-agent-loop 注册的 `inbox` key）语义一致：
 * `outcome: 'canceled'` 只表示这次移除是「被用户取消」，不影响队列本身。
 *
 * @param {readonly object[]} events 会话事件数组（时间序）
 * @returns {{ 'next-turn': object[], 'next-step': object[] }} 折叠结果
 */
export function foldInboxSplices(events) {
  const state = { "next-turn": [], "next-step": [] };
  for (const event of events ?? []) {
    if (event?.type !== "agent/inbox/spliced") continue;
    const splice = event.data;
    if (splice?.target !== "next-turn" && splice?.target !== "next-step") continue;
    const inbox = state[splice.target];
    const start = Number.isSafeInteger(splice.start) ? Math.min(Math.max(splice.start, 0), inbox.length) : 0;
    const removedCount = Number.isSafeInteger(splice.removedCount)
      ? Math.min(Math.max(splice.removedCount, 0), inbox.length - start)
      : 0;
    const inserted = Array.isArray(splice.inserted) ? splice.inserted : [];
    state[splice.target] = inbox.toSpliced(start, removedCount, ...inserted);
  }
  return state;
}

/**
 * 读会话里最后一次 `sandbox/mode` 与 `approval/policy`（last-event-wins）。
 * @returns {{ mode?: string, policy?: string }}
 */
export function foldPermission(events) {
  let mode;
  let policy;
  for (const event of events ?? []) {
    if (event?.type === "sandbox/mode") mode = event.data?.mode;
    else if (event?.type === "approval/policy") policy = event.data?.policy;
  }
  return { mode, policy };
}

/**
 * 取会话里已记录的最大回合号（用于续接时接着往下编号）。
 * @returns {number} 没有回合时为 0
 */
export function lastTurnOf(events) {
  let turn = 0;
  for (const event of events ?? []) {
    if (event?.type === "turn/start" && Number.isSafeInteger(event.data?.turn)) turn = event.data.turn;
  }
  return turn;
}
