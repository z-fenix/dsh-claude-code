// Host-owned state only; this module observes composition and adapts exact goal tools.
const TOOLS = ["mcp__dsh-bridge__get_goal", "mcp__dsh-bridge__create_goal", "mcp__dsh-bridge__update_goal"];

async function rpc($, bridge, claudeSessionId, requestId, method, params, callerAgentId = null) {
  if (!bridge) throw new Error("DSH bridge is unavailable");
  const response = await $.http.fetch(bridge.url, {
    method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: bridge.sessionId, agentId: bridge.agentId, epoch: bridge.epoch,
      claudeSessionId, callerAgentId, requestId, method, params }),
  });
  if (!response.ok) throw new Error("DSH bridge request failed");
  return JSON.parse(response.text).value;
}

export function register(on, options) {
  let bridge;
  let claudeSessionId;
  let sequence = 0;
  let capture = false;
  const definitions = new Map();

  on("session.start", async ($, e, next) => {
    try {
      const raw = await $.env.get("DSH_CLAUDE_BRIDGE");
      if (raw === undefined) return next(e);
      await $.env.set("DSH_CLAUDE_BRIDGE", undefined);
      const value = JSON.parse(raw);
      if (!/^http:\/\/127\.0\.0\.1:\d+\/bridge$/.test(value.url) || typeof value.token !== "string"
        || ![value.sessionId, value.agentId, value.epoch].every((item) => typeof item === "string" && item.length > 0)) return next(e);
      bridge = value;
      claudeSessionId = await $.session.id();
      const hello = await rpc($, bridge, claudeSessionId, `${bridge.epoch}-${++sequence}`, "handshake", { protocol: 1 });
      if (hello.protocol !== 1) throw new Error("unsupported bridge protocol");
      capture = hello.capture === "observed-compose";
      for (const definition of hello.tools) {
        if (!TOOLS.includes(`mcp__dsh-bridge__${definition.name}`)) throw new Error("unexpected host tool");
        await $.tool.register({ name: definition.name, description: definition.description, inputSchema: definition.inputSchema, isDeferred: false });
        definitions.set(`mcp__dsh-bridge__${definition.name}`, definition);
      }
      await rpc($, bridge, claudeSessionId, `${bridge.epoch}-${++sequence}`, "handshake", { protocol: 1, ready: true });
    } catch {
      bridge = undefined;
      capture = false;
      definitions.clear();
    }
    return next(e);
  });

  on("prompt.compose", async ($, e, next) => {
    const result = await next(e);
    if (bridge && capture) {
      try { await rpc($, bridge, claudeSessionId, `${bridge.epoch}-${++sequence}`, "prompt_snapshot", { sections: result.sections, model: e.model }); }
      catch {
        capture = false;
        try { $.ui.log("dsh-bridge: prompt capture disabled (snapshot unavailable)."); } catch {}
      }
    }
    return result;
  }).catch(($, e, next) => next(e));

  on("tool.call", { tool: TOOLS }, async ($, e) => {
    const definition = definitions.get(e.tool);
    if (!bridge || !definition) return { deny: "DSH goal bridge is unavailable." };
    if (e.agentId !== undefined) return { deny: "DSH goal tools require the main agent." };
    const params = {};
    for (const key of Object.keys(definition.inputSchema.properties ?? {})) {
      if (e[key] !== undefined) params[key] = e[key];
    }
    const result = await rpc($, bridge, claudeSessionId, `${bridge.epoch}-${++sequence}`, definition.name, params, e.agentId ?? null);
    const text = result.content.map((block) => block.text ?? "").join("\n");
    if (result.isError) return { deny: text };
    // 领域 JSON 必须是首个文本块；收尾指令等后续文本块与它一同交给模型，不参与校验。
    JSON.parse(result.content[0]?.text ?? "");
    return { result: text };
  }).catch(() => ({ deny: "DSH goal bridge failed closed." }));
}
