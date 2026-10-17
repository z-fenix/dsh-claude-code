// 精确审计白名单的一份执行权威；MCP 与 Mod 只更换 transport，不绕过宿主 registry。
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export const DSH_TOOL_SERVER_NAME = "dsh";
export const DSH_TOOL_PREFIX = `mcp__${DSH_TOOL_SERVER_NAME}__`;
export const DSH_MOD_TOOL_PREFIX = "mcp__dsh-bridge__";
export const DEFAULT_DSH_TOOL_NAMES = Object.freeze(["present", "job_list", "job_output", "job_kill"]);

/** 宿主已经生成标准 JSON Schema；这个选择器本身不改写投影。 */
export function selectBridgedTools(schemas, names) {
  const wanted = new Set(names ?? []);
  return (schemas ?? []).filter(schema => wanted.has(schema?.name) && schema.parameters !== undefined)
    .map(schema => ({ name: schema.name, description: schema.description ?? "", inputSchema: schema.parameters }));
}
export function mapToolResult(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return { content: content.length ? content : [{ type: "text", text: "" }], isError: result?.isError === true };
}
function service(ctx, name) {
  try { const found = ctx?.get?.(name); if (found !== undefined) return found; } catch {}
  // 仅兼容旧的普通对象协作者；不触发 Cordis 的属性/getter trap 绕过 inject。
  const descriptor = ctx && Object.getOwnPropertyDescriptor(ctx, name);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}
const fail = text => ({ content: [{ type: "text", text }], isError: true });

export function buildDshToolBridge({ ctx, agent, signal, names = DEFAULT_DSH_TOOL_NAMES, toolPrefix = DSH_MOD_TOOL_PREFIX } = {}) {
  if (!Array.isArray(names)) throw new TypeError("dshTools.names must be an array");
  if (names.some(name => !DEFAULT_DSH_TOOL_NAMES.includes(name))) throw new TypeError("dshTools.names must be a subset of the audited allowlist");
  if (![DSH_TOOL_PREFIX, DSH_MOD_TOOL_PREFIX].includes(toolPrefix)) throw new TypeError("invalid DSH tool transport prefix");
  const registry = service(ctx, "tools");
  if (!agent || !registry || typeof registry.schemas !== "function" && typeof registry.wireSchemas !== "function") return undefined;
  const wanted = new Set(names);
  const closing = new AbortController();
  const owners = new Map(); const waiting = new Map(); const active = new Set();
  let closed = false, closePromise;
  const schemasFor = () => typeof registry.wireSchemas === "function" ? registry.wireSchemas(agent).schemas : registry.schemas(agent);
  const definitions = () => {
    if (closed || signal?.aborted) return [];
    try {
      return selectBridgedTools(schemasFor(), names).map(definition => ({ ...definition,
        inputSchema: JSON.parse(JSON.stringify(z.json().parse(definition.inputSchema))) }));
    } catch { return []; }
  };
  const awaitOwner = (callId, executionSignal) => {
    if (closed || executionSignal.aborted) return Promise.resolve(undefined);
    if (owners.has(callId)) return Promise.resolve(owners.get(callId));
    return new Promise(resolve => {
      const waiters = waiting.get(callId) ?? new Set(); waiting.set(callId, waiters);
      const finish = owner => {
        clearTimeout(timer); executionSignal.removeEventListener("abort", aborted); waiters.delete(finish);
        if (!waiters.size) waiting.delete(callId); resolve(owner);
      };
      const aborted = () => finish(undefined);
      const timer = setTimeout(() => finish(undefined), 5000);
      waiters.add(finish); executionSignal.addEventListener("abort", aborted, { once: true });
    });
  };
  const observe = (message, { isMain = false } = {}) => {
    if (closed || message?.type !== "assistant") return;
    for (const block of message.message?.content ?? []) {
      if (block.type !== "tool_use" || typeof block.id !== "string" || !block.id) continue;
      if (![...wanted].some(name => block.name === toolPrefix + name)) continue;
      const owner = isMain && message.parent_tool_use_id == null ? block.name : null;
      const confirmed = owners.has(block.id) && owners.get(block.id) !== owner ? null : owner;
      owners.set(block.id, confirmed);
      for (const finish of waiting.get(block.id) ?? []) finish(confirmed);
    }
  };
  const executeOne = async (name, args, extra = {}) => {
    if (!wanted.has(name)) return fail("DSH bridge tool is not in the audited query allowlist");
    const callId = extra?._meta?.["claudecode/toolUseId"];
    if (typeof callId !== "string" || !callId.trim()) return fail("DSH bridge requires a Claude tool-use id");
    const signals = [signal, extra?.signal, closing.signal].filter(Boolean);
    const executionSignal = AbortSignal.any(signals);
    const validate = () => {
      if (closed || executionSignal.aborted) return fail("DSH bridge query is closed or cancelled");
      if (service(ctx, "agents")?.get(agent.id) !== agent || agent.status !== "running") return fail("DSH bridge requires the exact live running agent");
      if (!definitions().some(definition => definition.name === name)) return fail("DSH bridge tool is no longer visible");
    };
    try {
      let denied = validate(); if (denied) return denied;
      const owner = await awaitOwner(callId, executionSignal);
      if (owner !== toolPrefix + name) return fail("DSH bridge requires a confirmed main-query tool call; subagent calls are unsupported");
      denied = validate(); if (denied) return denied;
      // 在实际执行前重读完整当前 schema；Mod 没有 SDK 的 Zod 前置层，不能只信注册快照。
      const definition = definitions().find(definition => definition.name === name);
      const parsed = z.fromJSONSchema(definition.inputSchema).safeParse(args ?? {});
      if (!parsed.success) return fail("DSH bridge arguments do not match the current tool schema");
      return mapToolResult(await registry.execute({ callId, name, arguments: parsed.data, agent, signal: executionSignal }));
    } catch { return fail("DSH bridge execution failed"); }
  };
  return {
    definitions,
    get names() { return definitions().map(definition => definition.name); },
    execute(name, args, extra) {
      if (closed) return Promise.resolve(fail("DSH bridge query is closed or cancelled"));
      const operation = executeOne(name, args, extra); active.add(operation);
      const retire = () => { active.delete(operation); }; void operation.then(retire, retire);
      return operation;
    },
    observe,
    close() {
      if (closePromise) return closePromise;
      closed = true; closing.abort();
      for (const waiters of waiting.values()) for (const finish of waiters) finish(undefined);
      owners.clear();
      closePromise = Promise.allSettled([...active]).then(() => {});
      return closePromise;
    },
  };
}

/** 默认 MCP adapter 仍只广告建 query 时的快照；动态增删由显式 Mod transport 处理。 */
export function buildDshToolsServer(options = {}) {
  const bridge = buildDshToolBridge({ ...options, toolPrefix: DSH_TOOL_PREFIX });
  if (!bridge) return undefined;
  const definitions = bridge.definitions();
  if (!definitions.length) { void bridge.close(); return undefined; }
  const tools = definitions.map(definition => tool(definition.name, definition.description, z.fromJSONSchema(definition.inputSchema),
    (args, extra) => bridge.execute(definition.name, args, extra)));
  return { server: createSdkMcpServer({ name: DSH_TOOL_SERVER_NAME, version: "1.0.0", tools }),
    names: definitions.map(definition => definition.name), observe: bridge.observe, close: bridge.close, execute: bridge.execute };
}
