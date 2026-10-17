// 只在独占维护查询加载；用观察专属凭据确认原生结果，不把调用者的文案当作完成凭据。
export function register(on) {
  on("session.compact", async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger !== "manual") return next(e);
    const raw = await $.env.get("DSH_CLAUDE_COMPACT_OBSERVER");
    if (raw === undefined) return next(e);
    await $.env.set("DSH_CLAUDE_COMPACT_OBSERVER", undefined);
    const bridge = JSON.parse(raw);
    if (!/^http:\/\/127\.0\.0\.1:\d+\/bridge$/.test(bridge.url) || typeof bridge.token !== "string"
      || ![bridge.sessionId, bridge.agentId, bridge.epoch, bridge.operationId].every((x) => typeof x === "string" && x.length > 0)) {
      throw new Error("invalid compact observer descriptor");
    }
    const result = await next(e);
    const receipt = result.skip !== undefined ? { status: "skipped", reason: "native compact skipped" }
      : result.messages.length === 0 ? { status: "skipped", reason: "no Claude history to compact" }
      : { status: "succeeded", messageCount: result.messages.length,
        ...(result.tokensBefore === undefined ? {} : { tokensBefore: result.tokensBefore }),
        ...(result.tokensAfter === undefined ? {} : { tokensAfter: result.tokensAfter }) };
    const response = await $.http.fetch(bridge.url, {
      method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: bridge.sessionId, agentId: bridge.agentId, epoch: bridge.epoch,
        claudeSessionId: await $.session.id(), callerAgentId: null, requestId: `${bridge.operationId}-observe`,
        method: "maintenance_observe", params: { operationId: bridge.operationId, result: receipt } }),
    });
    if (!response.ok) throw new Error("compact receipt unavailable");
    return result;
  }).catch(($, e, next) => next(e));
}
