// lib/dialog.mjs — 桥接 Claude Code 的 request_user_dialog（AskUserQuestion）→ DSH 选择题 UI。
//
// 机制：Claude Code 调用 AskUserQuestion 时发一条 control request，由 onUserDialog 回调渲染
// 对话框并返回用户选择。
//
// result 结构（按 Claude Agent SDK 的 permission_ask_user_question 对话框）：
//   { behavior: 'allow' | 'deny' | 'cancelled' | 'completed', answers?: { [问题文本]: 答案 }, custom? }
//   - behavior 是权限决定；'completed' 表示对话框已作答并把 result 交回；
//   - answers 是「问题文本 → 答案字符串」（record），多选答案用逗号分隔；
//   - custom 是用户键入的自由文本（代替选结构化选项）。

/** 候选 dialogKind；实测后按真实值收敛（多写几个候选只是提高命中率，不产生副作用）。 */
export const SUPPORTED_DIALOG_KINDS = [
  "ask_user_question",
  "askUserQuestion",
  "permission_ask_user_question",
];

/** 从 payload 提取 questions 数组（payload 可能是 `{ questions }`，也可能直接是数组）。 */
function extractQuestions(payload) {
  if (!payload || typeof payload !== "object") return [];
  const raw = Array.isArray(payload) ? payload : payload.questions;
  if (!Array.isArray(raw)) return [];
  return raw.filter((q) => q && typeof q === "object" && ("question" in q || "header" in q));
}

/**
 * 把一个 Claude 问题转成 DSH `userQuestions.ask` 的问题。
 * 保留 question 原文，因为回填 answers 时要以它为键。
 */
function toDshQuestion(q, index) {
  return {
    id: q.id ?? q.header ?? q.question ?? `q${index}`,
    question: typeof q.question === "string" ? q.question : "",
    ...(typeof q.header === "string" ? { header: q.header } : {}),
    ...(Array.isArray(q.options) && q.options.length
      ? {
        options: q.options.map((o) => ({
          label: String(o?.label ?? ""),
          ...(o?.description ? { description: o.description } : {}),
        })),
      }
      : {}),
    ...(q.multiSelect ? { multiSelect: true } : {}),
  };
}

/** 把 DSH 答案转成 Claude 期望的 dialog result。 */
function buildResult(dshAnswer, dshQuestions) {
  const answers = {};
  let custom;
  for (const q of dshQuestions) {
    const ans = dshAnswer?.answers?.find((a) => a.id === q.id);
    if (!ans) continue;
    if (ans.custom) custom = ans.custom;
    else if (Array.isArray(ans.selected) && ans.selected.length) answers[q.question] = ans.selected.join(", ");
  }
  return { behavior: "allow", answers, ...(custom ? { custom } : {}) };
}

/**
 * 生成 onUserDialog 回调。
 * @param {object} ctx 取 `userQuestions` 服务的上下文
 * @param {object} agent 当前 agent（web provider 要求 agent-owned session 才弹窗）
 * @returns {(request: object, options?: { signal?: AbortSignal }) => Promise<object>}
 */
export function makeOnUserDialog(ctx, agent) {
  return async function onUserDialog(request, { signal } = {}) {
    const rawQuestions = extractQuestions(request?.payload);
    if (!rawQuestions.length) return { behavior: "cancelled" };
    const dshQuestions = rawQuestions.map(toDshQuestion);
    const userQuestions = ctx.get("userQuestions");
    if (!userQuestions) return { behavior: "cancelled" };
    try {
      const answer = await userQuestions.ask({
        questions: dshQuestions,
        agent,
        ...(signal ? { signal } : {}),
      });
      return { behavior: "completed", result: buildResult(answer, dshQuestions) };
    } catch (error) {
      // NO_PROVIDER / 会话已不 live / 用户取消 → cancelled，让 CLI 走它自己的默认行为。
      ctx.logger?.debug?.(`dsh-claude-code: onUserDialog ask failed: ${String(error?.message ?? error)}`);
      return { behavior: "cancelled" };
    }
  };
}
