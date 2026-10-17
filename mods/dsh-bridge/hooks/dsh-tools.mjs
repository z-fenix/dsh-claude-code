// 只处理四个审计名；移除时撤销执行许可，不能假称删除 CLI 中缓存的 schema。
import { callHost } from "./rpc.mjs";
const NAMES = ["present", "job_list", "job_output", "job_kill"];
const TOOLS = NAMES.map(name => `mcp__dsh-bridge__${name}`);
const ENVELOPE = new Set(["tool", "tool_use_id", "agentId", "consent", "requestMeta", "_meta"]);
export async function refreshDshTools($, state, definitions) {
  if (state.capabilities?.dshTools !== true) return;
  state.dshTools = new Map();
  if (!Array.isArray(definitions) || definitions.length > 4) throw new Error("invalid DSH tool catalog");
  const next = new Map();
  const signatures = state.dshSignatures ?? new Map(); state.dshSignatures = signatures;
  for (const definition of definitions) {
    if (!NAMES.includes(definition.name) || next.has(`mcp__dsh-bridge__${definition.name}`)
      || typeof definition.description !== "string" || definition.description.length > 4096
      || !definition.inputSchema || typeof definition.inputSchema !== "object" || Array.isArray(definition.inputSchema)
      || JSON.stringify(definition.inputSchema).length > 65536) throw new Error("unaudited or invalid DSH tool definition");
    const tool = `mcp__dsh-bridge__${definition.name}`;
    const signature = JSON.stringify(definition);
    if (signatures.get(tool) !== signature) {
      const registered = await $.tool.register({ name: definition.name, description: definition.description,
        inputSchema: definition.inputSchema, isDeferred: false });
      if (registered.tool !== tool) throw new Error("unexpected DSH registered tool name");
      signatures.set(tool, signature);
    }
    next.set(tool, definition);
  }
  state.dshTools = next;
}
export function registerDshTools(on, state) {
  state.dshTools = new Map();
  on("tool.call", { tool: TOOLS }, async ($, e) => {
    const definition = state.dshTools.get(e.tool);
    if (state.blocked || !state.bridge || state.capabilities?.dshTools !== true || !definition) return { deny: "DSH tool bridge is unavailable or the tool is no longer visible." };
    if (e.agentId !== undefined) return { deny: "DSH tool bridge requires the main query; child calls cannot borrow parent scope." };
    const args = Object.fromEntries(Object.entries(e).filter(([key]) => !ENVELOPE.has(key)));
    const result = await callHost($, state, "runtime_dsh", { name: definition.name, callId: e.tool_use_id, args });
    if (!Array.isArray(result?.content)) throw new Error("invalid DSH tool result");
    const text = result.content.map(block => typeof block?.text === "string" ? block.text : `Structured DSH content: ${JSON.stringify(block)}`).join("\n");
    return result.isError === true ? { deny: `DSH tool returned an error: ${text}` } : { result: text };
  }).catch(() => ({ deny: "DSH tool bridge failed; execution may be uncertain. Inspect state before retrying." }));
}
