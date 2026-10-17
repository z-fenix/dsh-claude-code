// CLI 的真实压缩观察；它不是 DSH surface compaction 或模型消费证明。
export function compactObservation(message) {
  if (message?.type !== "system") return undefined;
  if (message.subtype === "compact_boundary") {
    const meta = message.compact_metadata ?? {};
    return {
      kind: "boundary",
      ...(typeof meta.trigger === "string" ? { trigger: meta.trigger } : {}),
      ...(typeof meta.pre_tokens === "number" ? { preTokens: meta.pre_tokens } : {}),
      ...(typeof meta.post_tokens === "number" ? { postTokens: meta.post_tokens } : {}),
      ...(typeof meta.duration_ms === "number" ? { durationMs: meta.duration_ms } : {}),
    };
  }
  if (message.subtype !== "status") return undefined;
  if (message.status === "compacting") return { kind: "started" };
  if (message.compact_result === undefined) return undefined;
  return {
    kind: "settled",
    result: message.compact_result,
    ...(typeof message.compact_error === "string" && message.compact_error !== "" ? { error: message.compact_error } : {}),
  };
}
