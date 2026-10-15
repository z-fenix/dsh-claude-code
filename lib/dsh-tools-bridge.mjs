// lib/dsh-tools-bridge.mjs — 把 DSH 侧 agent-scope 工具按**精确白名单**桥给 Claude Code。
//
// 背景：Claude 会话用的是 CLI 自带工具，看不到 DSH 的工具（dsh-tool-*）。标准模式里这些工具
// 挂在预设上；这里优先读 `wireSchemas(agent).schemas`，尊重预设可见性及 PTC 的 run_code 折叠。
// 只将选中的工具暴露成 MCP，调用仍交给宿主 `execute` 的门控与结果管线；不替代标准主循环。
//
// 只桥 Claude 没有对等物的工具：把 DSH 的 fs/bash/grep 也桥过去会得到两张脸（模型选谁不可控）。
// 白名单必须精确到名字——不放行整段前缀，也不做「全部可见工具」的放行。
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/** MCP server 名；工具对模型呈现为 `mcp__dsh__<name>`。 */
export const DSH_TOOL_SERVER_NAME = "dsh";
export const DSH_TOOL_PREFIX = `mcp__${DSH_TOOL_SERVER_NAME}__`;

/**
 * 显式开启桥接后使用的默认名字（桥接本身默认关闭）。
 *
 * 选择标准（见 docs/superpowers/specs/2026-10-14-dsh-tool-bridge-design.md）：
 * Claude 的工具不使用 DSH 的这两类状态，且**日志影响面已核对**——
 *   - `present`：核对工作区已有文件并 append `deliverables/presented`，须关联真实调用 ID；
 *   - `job_list` / `job_output` / `job_kill`：操作 DSH 原生 jobs；完成通知仍可能进入原生 inbox。
 * 其余可见工具（fs/bash/grep/todo/skill…）刻意不桥：Claude 自带同名能力的会撞脸。
 */
export const DEFAULT_DSH_TOOL_NAMES = Object.freeze(["present", "job_list", "job_output", "job_kill"]);

/**
 * 从 agent scope 的可见工具里挑出白名单那几支。
 *
 * schema **原样取自宿主**（`ctx.tools.schemas(agent)`）：`defineTool` 在注册时已经用
 * `parameterSchemaSpecToJsonSchema` 把 DSH 的 schema 方言转成了标准 JSON Schema，所以这里
 * 不需要手写方言转换。SDK 注册边界另用 Zod 的标准转换器适配，不能直接传 JSON Schema。
 *
 * @param {{name: string, description?: string, parameters?: object}[]} schemas `ctx.tools.schemas(agent)`
 * @param {string[]} names 白名单（精确名字）
 * @returns {{name: string, description: string, inputSchema: object}[]} 实际可见且在白名单里的工具
 */
export function selectBridgedTools(schemas, names) {
  const wanted = new Set(names ?? []);
  return (schemas ?? [])
    .filter((schema) => wanted.has(schema?.name) && schema.parameters !== undefined)
    .map((schema) => ({ name: schema.name, description: schema.description ?? "", inputSchema: schema.parameters }));
}

/**
 * 把宿主工具结果映射成 MCP 的 CallToolResult。
 *
 * 宿主的最终结果是 `{isError, content, meta?, additionalContexts?, value?}`（见 dsh-tools 的
 * `materializeFinalResult`）；本次审计的四个工具只桥 content 与 isError，不承诺通用结果语义。
 */
export function mapToolResult(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return { content: content.length > 0 ? content : [{ type: "text", text: "" }], isError: result?.isError === true };
}

/**
 * 造 DSH 工具的 MCP server；白名单里一支都不可见时返回 undefined（不注册空 server）。
 *
 * @param {object} options
 * @param {object} options.ctx 宿主上下文（用 `ctx.tools`）
 * @param {object} options.agent 桥接归属的 agent（DSH 的权限/CAS 靠它定位）
 * @param {AbortSignal} [options.signal]
 * @param {string[]} [options.names] 白名单，默认 {@link DEFAULT_DSH_TOOL_NAMES}
 * @returns {{server: object, names: string[], observe: Function, close: Function}|undefined}
 */
export function buildDshToolsServer({ ctx, agent, signal, names = DEFAULT_DSH_TOOL_NAMES } = {}) {
  if (!Array.isArray(names)) throw new TypeError("dshTools.names must be an array");
  if (names.some((name) => !DEFAULT_DSH_TOOL_NAMES.includes(name))) {
    throw new TypeError("dshTools.names must be a subset of the audited allowlist");
  }
  if (agent === undefined) return undefined;
  // 服务是可选协作者，未组合时不注册空 server。
  let registry;
  try {
    registry = ctx?.get?.("tools") ?? ctx?.tools;
  } catch {
    registry = ctx?.tools;
  }
  const schemasFor = () => typeof registry?.wireSchemas === "function"
    ? registry.wireSchemas(agent).schemas : registry?.schemas?.(agent);
  let schemas;
  try {
    schemas = schemasFor();
  } catch {
    return undefined;
  }
  const bridged = selectBridgedTools(schemas, names);
  if (bridged.length === 0) return undefined;
  // SDK 接受 Zod schema，不接受 JSON Schema。转换整个对象以保留嵌套 required、可选参数和
  // additionalProperties；只取 raw shape 会丢掉对象级约束。宿主投影仍是唯一 schema 来源。
  let closed = false;
  const callOwners = new Map();
  const waiting = new Map();
  // MCP 请求可先于 SDK assistant 消息到达；只等宿主确认，不把未知调用当成主查询。
  const awaitOwner = (callId, executionSignal) => {
    if (closed || executionSignal.aborted) return Promise.resolve(undefined);
    if (callOwners.has(callId)) return Promise.resolve(callOwners.get(callId));
    return new Promise((resolve) => {
      const finish = (owner) => {
        clearTimeout(timer);
        executionSignal.removeEventListener("abort", onAbort);
        waiters.delete(finish);
        if (waiters.size === 0) waiting.delete(callId);
        resolve(owner);
      };
      const onAbort = () => finish(undefined);
      const waiters = waiting.get(callId) ?? new Set();
      waiting.set(callId, waiters);
      waiters.add(finish);
      const timer = setTimeout(() => finish(undefined), 5000);
      executionSignal.addEventListener("abort", onAbort, { once: true });
    });
  };
  const observe = (message, { isMain = false } = {}) => {
    if (closed || message?.type !== "assistant") return;
    for (const block of message.message?.content ?? []) {
      if (block.type !== "tool_use" || typeof block.id !== "string" || !block.id) continue;
      if (!bridged.some((definition) => block.name === `${DSH_TOOL_PREFIX}${definition.name}`)) continue;
      const owner = isMain && message.parent_tool_use_id == null ? block.name : null;
      const previous = callOwners.get(block.id);
      // 冲突身份永远不升级为主查询；observer 是 runner 的证据入口，不接受模型参数。
      const confirmed = callOwners.has(block.id) && previous !== owner ? null : owner;
      callOwners.set(block.id, confirmed);
      for (const finish of waiting.get(block.id) ?? []) finish(confirmed);
    }
  };
  const fail = (text) => ({ content: [{ type: "text", text }], isError: true });
  const tools = bridged.map((definition) => tool(definition.name, definition.description, z.fromJSONSchema(definition.inputSchema), async (args, extra) => {
    // CLI 经 MCP _meta 提供真实调用身份；不能用 JSON-RPC requestId 或随机 UUID 代替。
    const callId = extra?._meta?.["claudecode/toolUseId"];
    if (typeof callId !== "string" || callId.trim() === "") return fail("DSH bridge requires a Claude tool-use id");
    const validate = () => {
      if (closed || signal?.aborted || extra?.signal?.aborted) return fail("DSH bridge query is closed or cancelled");
      const agents = ctx?.get?.("agents") ?? ctx?.agents;
      if (agents?.get(agent.id) !== agent || agent.status !== "running") return fail("DSH bridge requires the exact live running agent");
      if (!selectBridgedTools(schemasFor(), [definition.name]).length) return fail("DSH bridge tool is no longer visible");
    };
    try {
      let denied = validate();
      if (denied) return denied;
      const signals = [signal, extra?.signal].filter(Boolean);
      const executionSignal = signals.length ? AbortSignal.any(signals) : new AbortController().signal;
      const owner = await awaitOwner(callId, executionSignal);
      if (owner !== `${DSH_TOOL_PREFIX}${definition.name}`) return fail("DSH bridge requires a confirmed main-query tool call; subagent calls are unsupported");
      denied = validate();
      if (denied) return denied;
      const result = await registry.execute({ callId, name: definition.name, arguments: args ?? {}, agent, signal: executionSignal });
      return mapToolResult(result);
    } catch {
      // 不把宿主异常栈、路径或凭据送入模型；工具域错误仍由宿主物化为 CallToolResult。
      return fail("DSH bridge execution failed");
    }
  }));
  return {
    server: createSdkMcpServer({ name: DSH_TOOL_SERVER_NAME, version: "1.0.0", tools }),
    names: bridged.map((d) => d.name),
    observe,
    close: () => {
      closed = true;
      for (const waiters of waiting.values()) for (const finish of waiters) finish(undefined);
      callOwners.clear();
    },
  };
}
