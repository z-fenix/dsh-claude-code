// lib/host-tool-gate.mjs — 把 Claude Code 的文件工具调用派发进宿主的 `tools/pre-execute` waterfall。
//
// 为什么需要它：`dsh-workspace-changes` 记录器有两条采集途径，其中「编辑前整文件捕获」只在
// `tools/pre-execute` 监听器里排队（`exec.name` + `exec.arguments` → `mutationPath`）。Claude 的文件
// 工具在 CLI 进程内执行，从不经过宿主的工具注册表，那条路对插件会话**永远不触发**——工作区在 git
// 仓库内时靠快照对比兜底，不在任何 git 仓库内时改动文件卡片基本是空的（见 event-mapping.md 的
// 覆盖边界一节）。这里在 canUseTool（工具真正执行之前）按宿主的载荷形状把这次调用派发一遍，
// 让宿主监听器看得到它。顺带让 `dsh-hooks-claude-code` 的 PreToolUse 钩子也能作用于这些调用。
//
// 形状不是猜的，是 app.asar 里读到的宿主实现：
//   - 派发点：`dsh-tools/lib/index.js` 的 `prepareExecution` →
//     `ctx.waterfall(scopeTarget(this, exec.agent), "tools/pre-execute", exec, () => ({kind:"allow"}))`
//   - 监听器读的字段：`dsh-workspace-changes` 读 `exec.agent?.session` / `exec.name` / `exec.arguments`；
//     `dsh-hooks-claude-code` 读 `exec.name` / `exec.arguments` / `exec.callId` / `exec.signal`
//   - 决定形状：`{kind:"allow"}` / `{kind:"deny", reason, info?}` / `{kind:"cancel"}` /
//     `{kind:"ask", reason?, displayReason?}`（后两者见 `dsh-experimental-auto-review`）
//   - 分级：宿主自己的 monotonic guard（`ctx.tools.guard`）排在 pre-execute **之后**，所以插件的
//     硬拒绝（read-only / approval policy）也排在派发之后，与宿主一致。
//
// 边界（如实记录，不掩盖）：
//   - `MultiEdit` / `NotebookEdit` 的入参形状宿主记录器认不出来（`mutationPath` 要求
//     `edit` 带 `old_string` + `new_string`、`write` 带 `content`），所以它们**不会**产生改动前捕获。
//     这里仍然派发（其它监听器该看到「一个会改文件的工具要跑了」），但不伪造参数去骗过记录器。
//   - 派发的 exec 不是注册表铸造的执行对象：没有 `token` / `deferContext` / `concludeTurn`。
//     监听器若要改写参数或接管执行流程，在这条路上没有对应机制。
import { agentEvents } from "@deepseek-ai/dsh-agent";

/** waterfall 的终止值：没有监听器表态时的默认决定。 */
const ALLOW = Object.freeze({ kind: "allow" });

/** 宿主 pre-execute 能给出的决定种类（`dsh-tools` 的 `prepareExecution` 只读 `kind`）。 */
const DECISION_KINDS = new Set(["allow", "deny", "cancel", "ask"]);

/**
 * 会写文件的 Claude Code 工具 → 宿主 wire 工具名。
 *
 * 必须是 wire 名：宿主记录器的 `mutationPath` 按 wire 名分派（`write` / `edit` /
 * `str_replace_editor`）。这张表与 `lib/claude-run.mjs` 的 `TOOL_NAME_MAP` 里那四条同值，
 * 但这里**只列会改文件的工具**——只有它们需要进这道门。`test/host-tool-gate.test.mjs`
 * 有一条护栏断言两者一致，改渲染映射时不会悄悄脱钩。
 */
export const FILE_TOOL_WIRE_NAMES = Object.freeze({
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
});

/**
 * 为一次 Claude 工具调用派发宿主 `tools/pre-execute`。
 *
 * 非文件工具直接返回 allow，不派发：宿主那条路上本来也不会有这次调用，凭空造一条只会让监听器
 * 看到不存在的工具。
 *
 * 监听器抛错一律 fail-closed 成 `deny`：宿主自己的注册表就是这个语义（`prepareExecution` 把
 * 监听器异常物化成工具错误，工具体不会执行）。在这里放宽，等于把「宿主能不能拦住这次写」交给运气。
 *
 * @param {object} ctx 派发用上下文（宿主/循环 ctx 都行，`agentEvents` 只借它取 waterfall）
 * @param {object} agent 本次调用的 agent（也是 scope carrier 的键；记录器靠它的 `session` 归位）
 * @param {object} call
 * @param {string} call.toolName Claude Code 的工具名
 * @param {object} call.input 工具入参（原样传给监听器；监听器改了它也不会回流到实际调用）
 * @param {string} [call.callId] Claude 的 tool_use id，作为 exec 的关联令牌
 * @param {AbortSignal} [call.signal] 本回合的取消信号
 * @returns {Promise<{kind: string, reason?: string, [key: string]: unknown}>} 派发结果（`allow` / `deny` / `cancel` / `ask`）
 */
export async function dispatchHostToolGate(ctx, agent, { toolName, input, signal, callId } = {}) {
  const wireName = FILE_TOOL_WIRE_NAMES[toolName];
  // 没有 agent 就没有可归属的会话，也就没有 scope carrier；后面的策略分支会以自己的理由拒绝。
  if (wireName === undefined || !agent) return ALLOW;
  // 没有派发器（不在 DSH app 组合里、或宿主版本不提供 waterfall）等于「没有监听器要说话」：
  // 这道门只按宿主的请求**追加**限制，没有宿主可问时不构成任何放宽。
  if (typeof ctx?.waterfall !== "function") return ALLOW;

  const exec = {
    callId,
    rootCallId: callId,
    name: wireName,
    arguments: input,
    ...(signal === undefined ? {} : { signal }),
  };
  let gate;
  try {
    gate = await agentEvents(ctx, agent).waterfall("tools/pre-execute", exec, () => Promise.resolve(ALLOW));
  } catch (error) {
    return { kind: "deny", reason: `host tools/pre-execute listener failed: ${String(error?.message ?? error)}` };
  }
  if (gate === null || typeof gate !== "object" || !DECISION_KINDS.has(gate.kind)) {
    // 监听器没给决定（宿主自己遇到这种情况会 TypeError 后整条调用失败），同样不放行。
    return { kind: "deny", reason: `host tools/pre-execute returned no usable decision (${String(gate)})` };
  }
  return gate;
}
