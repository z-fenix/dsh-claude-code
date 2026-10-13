// lib/fork.mjs — DSH 的 fork 会话继承 Claude 模型历史。
//
// 背景：DSH 的 `session/fork` 会把父会话的一段已完成前缀作为 seed 建一个新会话
// （`meta: { cwd, parentSession, isSeeded: true, agentPreset }`）。DSH 侧的 seed 只是**日志**，
// Claude 的真实上下文在 CLI 里，不继承就等于「分叉出来的会话失忆」。
//
// Claude Code CLI 支持分叉：`resume: <父会话 id>` + `forkSession: true` 会把父转录复制到一个
// **新的**会话 id（实测：新 id 与父不同、历史可回忆、父不被续写）。所以这里只负责判断
// 「这是一个 fork 吗」「该续接谁、要不要分叉」。
//
// 纯函数 + 注入 `load`，不依赖宿主服务，可单测。

/**
 * 该会话是不是 DSH fork 出来的。
 *
 * 子代理子会话同样带 `parentSession`，但它有 `origin: "subagent"`，而且它们根本不会走到引擎
 * 路由（router 对 subagent 直接交回原生工厂），这里再挡一道以免误判。
 */
export function isForkedSession(header) {
  return header?.isSeeded === true
    && typeof header?.parentSession === "string" && header.parentSession !== ""
    && header?.origin !== "subagent";
}

/**
 * 决定这个会话第一次运行该续接哪个 Claude 会话。
 *
 * @param {object} options
 * @param {string} options.sessionId 本会话（fork 出来的）的 DSH id
 * @param {object} options.header 本会话的 header
 * @param {(id: string) => Promise<string|undefined>} options.load 读取某个 DSH 会话已捕获的 Claude 会话 id
 * @returns {Promise<{claudeSessionId: string, fork: boolean}|undefined>}
 *   `fork: true` 表示这是首次运行、要 resume 父并把父转录分叉过来；`fork: false` 表示续接本会话
 *   自己的 Claude 会话。拿不到任何 id 时返回 undefined（fork 照常新建，只是没有继承历史）。
 */
export async function forkResumeHint({ sessionId, header, load }) {
  // 非 fork 会话：走原有的 per-session resume 路径，不在此处决定。
  if (!isForkedSession(header)) return undefined;
  // fork 出自己跑过之后，本会话就有了自己的 Claude 会话——续接它，不能再分叉父。
  const own = await load(sessionId);
  if (own !== undefined) return { claudeSessionId: own, fork: false };
  // 首次运行：父的 Claude 会话 id 缺失时不做无根据的 resume（宁可失忆也别接到错的会话上）。
  const parent = await load(header.parentSession);
  if (parent === undefined) return undefined;
  return { claudeSessionId: parent, fork: true };
}
