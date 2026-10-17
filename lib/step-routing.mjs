// 只把用户的新选择同步到主 loop；不在每步重置原生 fallback 或子代理模型。
import { foldModelSelection } from "./session-events.mjs";
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
function selectionOf(session, agent) {
  const events = typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : [];
  if (!Array.isArray(events)) throw new Error("model selection is unreadable");
  return foldModelSelection(events) ?? { model: agent?.options?.model };
}
function normalized(selection) {
  return { model: typeof selection?.model === "string" && selection.model ? selection.model : undefined,
    effort: EFFORTS.has(selection?.reasoningEffort) ? selection.reasoningEffort : undefined };
}
export function createStepRouting({ session, agent, getQuery, initialSelection, signal }) {
  let current = normalized(initialSelection ?? selectionOf(session, agent));
  return {
    async prepare(input) {
      if (input.agentId !== undefined) return {};
      if (signal?.aborted) throw new Error("model routing cancelled");
      const next = normalized(selectionOf(session, agent));
      const modelChanged = current.model !== next.model;
      const effortChanged = current.effort !== next.effort;
      if (!modelChanged && !effortChanged) return {};
      const query = getQuery();
      const result = {};
      if (modelChanged) {
        if (typeof query?.setModel !== "function") throw new Error("live model selection is unavailable");
        await query.setModel(next.model);
        if (next.model !== undefined) result.model = next.model;
      }
      if (effortChanged || modelChanged && next.effort === undefined) {
        if (typeof query?.applyFlagSettings !== "function") throw new Error("live effort selection is unavailable");
        await query.applyFlagSettings({ effortLevel: next.effort ?? null });
        if (next.effort !== undefined) result.effort = next.effort;
        else result.clearEffort = true;
      }
      current = next;
      return result;
    },
  };
}
