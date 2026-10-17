// RPC 身份来自本次 query 的宿主描述符和引擎固定的 loop id，不来自模型工具参数。
export async function callHost($, state, method, params, callerAgentId = null) {
  const bridge = state.bridge;
  if (!bridge) throw new Error("DSH runtime bridge unavailable");
  const response = await $.http.fetch(bridge.url, { method: "POST",
    headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: bridge.sessionId, agentId: bridge.agentId, epoch: bridge.epoch,
      claudeSessionId: state.claudeSessionId, callerAgentId, requestId: `${bridge.epoch}-runtime-${++state.sequence}`, method, params }) });
  if (!response.ok) throw new Error("DSH runtime request failed");
  return JSON.parse(response.text).value;
}
export function blockControl($, state) {
  if (!state.blocked) {
    state.blocked = true;
    try { $.ui.log("dsh-bridge: runtime control unavailable; request stopped."); } catch {}
  }
}
