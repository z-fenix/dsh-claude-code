// Host-owned state and permissions stay authoritative; the Mod adapts only advertised capabilities.
import { registerRuntime } from "./runtime.mjs";
import { captureCatalog } from "./metadata.mjs";
import { refreshDshTools } from "./dsh-tools.mjs";
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

async function maintain($, bridge, claudeSessionId, operation) {
  try {
    const claim = await rpc($, bridge, claudeSessionId, `${operation.operationId}-claim`, "maintenance_claim", { operationId: operation.operationId });
    if (claim.execute !== true) return;
    let result;
    try {
      if (claim.action === "command") {
        const requested = claim.params?.command;
        if (requested !== "status" && requested !== "cost") throw new Error("unsupported command");
        // 只跑固定只读 builtin；文本本身就是产物，不经 session 改动。
        const output = await $.command.run({ command: requested });
        if (output.exitCode !== undefined && output.exitCode !== 0) result = { status: "failed", reason: "native command failed" };
        else if (typeof output.text !== "string" || !output.text.trim()) result = { status: "skipped", reason: "native command returned no text on this surface" };
        else if (output.text.length > 8192) result = { status: "failed", reason: "native command output exceeds the text budget" };
        else result = { status: "succeeded", text: output.text };
      } else if (claim.action === "compact") {
        // Headless 走原生命令队列，结果由独立 observer 回报，不能用输出文案推断完成。
        await $.command.run({ command: "compact" });
        result = await rpc($, bridge, claudeSessionId, `${operation.operationId}-receipt`, "maintenance_result", { operationId: operation.operationId })
          ?? { status: "uncertain", reason: "native compact returned no completion receipt" };
      } else throw new Error("unsupported operation");
    } catch { result = { status: "uncertain", reason: "native operation failed" }; }
    await rpc($, bridge, claudeSessionId, `${operation.operationId}-complete`, "maintenance_complete", { operationId: operation.operationId, result });
  } catch {
    try { $.ui.log("dsh-bridge: native operation result unavailable."); } catch {}
  }
}

export function register(on, options) {
  let bridge;
  let claudeSessionId;
  let sequence = 0;
  let capture = false;
  const definitions = new Map();
  const runtimeState = { bridge: undefined, claudeSessionId: undefined, capabilities: {}, sequence: 0, blocked: false };

  on("session.start", async ($, e, next) => {
    const started = await next(e);
    try {
      const raw = await $.env.get("DSH_CLAUDE_BRIDGE");
      if (raw === undefined) return started;
      await $.env.set("DSH_CLAUDE_BRIDGE", undefined);
      const value = JSON.parse(raw);
      if (!/^http:\/\/127\.0\.0\.1:\d+\/bridge$/.test(value.url) || typeof value.token !== "string"
        || ![value.sessionId, value.agentId, value.epoch].every((item) => typeof item === "string" && item.length > 0)) return started;
      bridge = value;
      claudeSessionId = await $.session.id();
      const hello = await rpc($, bridge, claudeSessionId, `${bridge.epoch}-${++sequence}`, "handshake", { protocol: 1 });
      if (hello.protocol !== 1) throw new Error("unsupported bridge protocol");
      if (hello.maintenance !== undefined) {
        capture = false;
        await rpc($, bridge, claudeSessionId, `${bridge.epoch}-${++sequence}`, "handshake", { protocol: 1, ready: true });
        $.clock.after(1, () => maintain($, bridge, claudeSessionId, hello.maintenance));
        return started;
      }
      capture = hello.capture === "observed-compose";
      runtimeState.bridge = bridge;
      runtimeState.claudeSessionId = claudeSessionId;
      runtimeState.capabilities = hello.runtime ?? {};
      for (const definition of hello.tools) {
        if (!TOOLS.includes(`mcp__dsh-bridge__${definition.name}`)) throw new Error("unexpected host tool");
        await $.tool.register({ name: definition.name, description: definition.description, inputSchema: definition.inputSchema, isDeferred: false });
        definitions.set(`mcp__dsh-bridge__${definition.name}`, definition);
      }
      await refreshDshTools($, runtimeState, hello.dshTools ?? []);
      await captureCatalog($, runtimeState);
      await rpc($, bridge, claudeSessionId, `${bridge.epoch}-${++sequence}`, "handshake", { protocol: 1, ready: true });
    } catch {
      bridge = undefined;
      runtimeState.bridge = undefined;
      runtimeState.capabilities = {};
      capture = false;
      definitions.clear();
    }
    return started;
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
    if (runtimeState.blocked || !bridge || !definition) return { deny: "DSH goal bridge is unavailable." };
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
  registerRuntime(on, runtimeState);
}
