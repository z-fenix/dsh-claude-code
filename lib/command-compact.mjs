// 本预设的 compact 命令；实际是原生 agent 时保留宿主语义，Claude agent 不偷偷降级。
export const name = "claude-code-command-compact";
export const inject = ["commands"];

const FAILURE = {
  busy: "Native compact is unavailable while the agent has active work.",
  unsupported: "The selected CLI or configuration does not support native compact.",
  history: "No owned, persistent Claude history is available to compact.",
  fork: "Start the fork's first normal turn before compacting its own Claude history.",
  cancelled: "Native compact was cancelled.",
  timeout: "Native compact timed out.",
  uncertain: "Native compact returned no confirmed result.",
};
async function execute(ctx, invocation) {
  if (typeof invocation.rawInput !== "string" || invocation.rawInput.trim()) return { kind: "error", text: "Usage: /compact (no arguments)" };
  if (!invocation.agent) return { kind: "error", text: "Compaction requires a live agent." };
  const native = typeof invocation.agent.compactNative === "function";
  try {
    if (native) {
      const result = await invocation.agent.compactNative({ signal: invocation.signal, commandId: invocation.commandId });
      if (result.status === "skipped") {
        // Producer 只回传受限脱敏理由；这里限成单行，避免把 skip 显示为完成。
        const reason = typeof result.reason === "string" ? result.reason.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 256) : "native operation skipped";
        return { kind: "success", text: `Claude context was not compacted: ${reason}. DSH history is unchanged.` };
      }
      if (result.status !== "succeeded") return { kind: "error", text: "Native compact returned no confirmed completion." };
      const counts = Number.isFinite(result.tokensBefore) && Number.isFinite(result.tokensAfter)
        ? ` (${result.tokensBefore} → ${result.tokensAfter} tokens)` : "";
      return { kind: "success", text: `Compacted Claude context${counts}. DSH history is unchanged.` };
    }
    const compaction = ctx.get("compaction");
    if (typeof compaction?.compactNow !== "function") return { kind: "error", text: "Compaction service is unavailable." };
    const result = await compaction.compactNow(invocation.agent, invocation.signal, invocation.commandId);
    if (result === null) return { kind: "success", text: "No compactable history yet." };
    return { kind: "success", text: `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens).`, sourceEventSeq: result.summarySeq };
  } catch (error) {
    const text = native ? FAILURE[error?.code] ?? "Native compact failed."
      : invocation.signal?.aborted ? "Compaction cancelled." : "Compaction did not finish cleanly.";
    return { kind: "error", text: `${text}${error?.uncertain ? " The CLI may already have changed its history; inspect it before retrying." : ""}` };
  }
}

export function apply(ctx) {
  const active = new Set();
  const handler = (invocation) => {
    const operation = execute(ctx, invocation);
    active.add(operation);
    const retire = () => { active.delete(operation); };
    void operation.then(retire, retire);
    return operation;
  };
  ctx.effect(function* () {
    yield async () => { await Promise.allSettled(active); };
    yield ctx.get("commands").register({ definitionId: "dsh-claude-code/command-compact", name: "compact",
      description: "Compact the active engine's conversation context", handler });
  }, "claude-code compact command");
}
