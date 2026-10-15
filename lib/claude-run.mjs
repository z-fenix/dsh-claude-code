// lib/claude-run.mjs — 跑一次 Claude Code 查询，并把它的轨迹实时映射成 DSH 会话事件。
//
// 职责分三层：
//   1. StreamAttempt —— 把 Claude 的流式分片喂给 DSH 的累积器，产出「实时帧」（web 界面据此
//      逐字渲染）和「最终持久化记录」（写进 assistant/message 的 stream 字段）。
//   2. ClaudeRunTracer —— SDK 消息 → DSH 会话事件的纯映射（step 边界、消息、工具调用/结果）。
//   3. runClaudeCode —— 组装 SDK 选项（权限、对话框、续接）并驱动一次查询。
//
// 映射约定：一个 Claude API 响应 = 一个 DSH step；共享 message.id 的 assistant 分块合并。
// 缺少响应 id 的旧消息按消息边界处理。turn/start 与 turn/end 由上层 agent.mjs 负责。
import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { buildGoalHandlers, goalToolDefinitions } from "./goal-domain.mjs";
import { buildModOptions, probeModSupport } from "./mod-options.mjs";
import { createModHost } from "./mod-host.mjs";
import { PromptSnapshotRecorder } from "./prompt-snapshot.mjs";
import {
  AssistantStreamAccumulator,
  BlockAssembler,
  createAssistantMessage,
  createToolResultMessage,
} from "@deepseek-ai/dsh-llm";
import { ClaudeRunControl } from "./run-control.mjs";
import { makeCanUseTool } from "./approval.mjs";
import { readPermission, permissionStrategy } from "./permission.mjs";
import { makeOnUserDialog, SUPPORTED_DIALOG_KINDS } from "./dialog.mjs";
import { readSessionEvents, foldModelSelection } from "./session-events.mjs";
import { pluginFacts, bindPluginFacts } from "./plugin-facts.mjs";
import { ClaudeTaskTable, claudeToolResultText } from "./tasks.mjs";
import { buildGoalServer, goalGuidance, resolveGoalConfig, GOAL_SERVER_NAME } from "./goal-bridge.mjs";
import { buildDshToolsServer, DEFAULT_DSH_TOOL_NAMES, DSH_TOOL_PREFIX, DSH_TOOL_SERVER_NAME } from "./dsh-tools-bridge.mjs";
import { cannotSpawnDirectly } from "./auth.mjs";
import { readHostPersona } from "./host-persona.mjs";

/** 写进会话 `request/header` 的 provider 名；与 llm-route.mjs 注册的 provider 一致。 */
export const PROVIDER = "claude-code";

/** SDK 认可的推理档位（sdk.d.ts 的 EffortLevel）；不在此列的档位不透传。 */
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

/**
 * 宿主随 agent 创建传给引擎的模型路由：`dsh-api-session-controller.agentOptions()`
 * 作为 `agentOptions` 传入，`lib/agent.mjs` 原样存成 `agent.options`。
 * 它取的是 `agentDefaultModel.currentSelection()`，即进程级默认值（配置里 pin 住的那个）——
 * 也正是前端模型选择器在没有会话级选择时显示的值。
 *
 * 会话内的显式选择不在这里：它走 `model/selection` 会话事件（见 `foldModelSelection`），
 * 由调用处排在它前面。宿主解析链的第三支「已记录的 request/header」本插件**故意不复刻**：
 * 那是本插件自己写下的历史值，照抄会把第一次写错的模型固化。
 *
 * 只采信非空字符串：宿主可能没提供，给别的类型时宁可退回 CLI 默认，也不把脏值塞给 SDK。
 *
 * @param {object} agent 当前 agent
 * @returns {{ model: string }|undefined}
 */
function hostModelSelection(agent) {
  const model = agent?.options?.model;
  return typeof model === "string" && model.length > 0 ? { model } : undefined;
}

/** `tool/result.data.meta` 的体积上限（序列化后字节数）；超限宁可不带 meta。 */
const TOOL_META_MAX_BYTES = 16 * 1024;

/**
 * 把 CLI 自己上报的上下文压缩归一成一条可审计的**私有事实**（不是原生事件）。
 *
 * Claude Code 的真实上下文由 CLI 自己压缩；DSH 的 compaction 事件由 `BasicCompactionEngine`
 * 按 checkpoint 契约写入，插件伪造会破坏日志，所以这里只记 `claude-code/compact`。
 * 成功与否、失败原因（`compact_error`）都在这条里——长会话压缩失败时至少是看得见的。
 *
 * @returns {object|undefined} 与压缩无关的消息返回 undefined
 */
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

/**
 * 把 SDK 的 `tool_use_result` 净化成可落盘的 `tool/result.data.meta`。
 *
 * SDK 文档写明这是工具的**完整 Output 对象**（Agent/Task 还带 run totals），消费者应从它渲染，
 * 而不是去解析 tool_result 文本。原生循环把工具的 `result.meta` 写进 `tool/result.data.meta`，
 * 这里对齐同一槽位。
 *
 * 不可序列化（循环引用 / BigInt / 函数）或超过上限时返回 undefined：宁可少带 meta，
 * 也不能让一条事件把日志写坏或写爆。
 */
export function structuredToolMeta(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") return undefined;
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (typeof json !== "string" || json.length > TOOL_META_MAX_BYTES) return undefined;
  return value;
}

/**
 * `request/header` 的 system 占位文本：Claude Code 的系统提示词由 claude CLI 内部生成，
 * SDK 不暴露原文，只能写一句说明占位，让 token-meter 的上下文构成投影至少有一个诚实的读数。
 */
const SYSTEM_STUB =
  "Claude Code built-in system prompt (tools + environment; rendered inside the claude CLI and not exposed by the SDK)";

/**
 * Claude Code 内建工具名 → DSH 原生 wire 工具名。
 * DSH 前端按 wire 名分类渲染（bash / read / write / edit / glob / grep / web_search …），
 * 名字对不上会全部落进通用 "Tool call" 卡片。未命中的保持原名（走通用卡片）。
 */
const TOOL_NAME_MAP = {
  Bash: "bash",
  BashOutput: "bash",
  KillShell: "bash",
  Skill: "skill",
  Read: "read",
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Glob: "glob",
  Grep: "grep",
  WebFetch: "web_fetch",
  WebSearch: "web_search",
  Agent: "subagent",
  Task: "subagent",
  TodoWrite: "todo_write",
};

/** 会 spawn 子代理的 Claude Code 工具名（子代理追踪的权威信号）。 */
export const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task"]);

/**
 * 需要改写入参键、DSH 前端才能读出摘要/名称的工具。目前只有 Skill：
 * Claude Code 用 `{ command }`，DSH 的 skill 卡片读 `{ name }`。
 */
const TOOL_INPUT_REMAP = {
  Skill: (input) => (typeof input?.command === "string" ? { name: input.command } : input),
};

/** 把 Claude Code 工具名映射成 DSH wire 工具名（未命中保持原名）。 */
export function mapToolName(claudeName) {
  return TOOL_NAME_MAP[claudeName] ?? claudeName;
}

/** 把 Claude Code 工具入参改写为 DSH 前端可读的形式（无改写规则时原样返回）。 */
export function mapToolInput(claudeName, input) {
  const remap = TOOL_INPUT_REMAP[claudeName];
  return remap ? remap(input) : input;
}

/**
 * 已知但不产生 DSH 正文的 Claude 块。
 *
 * `redacted_thinking` 是端点对加密思考的占位块：它占据了响应的一个 block 位置，
 * 但没有可持久化的正文。它既不是「未知块」（不表示混合流或对齐失败），
 * 也不能当成 reasoning 正文写出去（内容是密文）。实测：中断响应里该块先于可见
 * 文本出现，若按未知块处理会永久关闭安全前缀收尾，界面已显示的文本在重放时消失。
 */
function isIgnorableClaudeBlock(block) {
  return block?.type === "redacted_thinking";
}

/** 把一个 Claude content block 映射成 DSH ContentBlock；不认识的类型返回 null。 */
export function mapClaudeBlock(block) {
  if (!block || typeof block.type !== "string") return null;
  switch (block.type) {
    case "text":
      return { type: "text", text: typeof block.text === "string" ? block.text : "" };
    case "thinking":
      return { type: "reasoning", text: typeof block.thinking === "string" ? block.thinking : "" };
    case "tool_use":
      return {
        type: "tool-call",
        id: block.id ?? "",
        name: mapToolName(block.name ?? ""),
        arguments: JSON.stringify(mapToolInput(block.name ?? "", block.input ?? {})),
      };
    default:
      return null; // image / web_search 等块，v1 忽略
  }
}

/** 把 Claude tool_result 的 content（string | block[]）映射成 DSH tool-result content。 */
export function mapClaudeToolResultContent(content) {
  if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];
  if (Array.isArray(content)) return content.map(mapClaudeBlock).filter(Boolean);
  return [];
}

/**
 * 把一个 Claude usage 对象映射成 DSH TokenUsage（缺失字段按 0 计；非对象返回 null）。
 * 计数是互斥的：inputTokens 只算未命中缓存的输入，缓存读写单独报。
 */
export function usageFromClaude(usage) {
  if (!usage || typeof usage !== "object") return null;
  return {
    inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
    outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
    cacheReadTokens: typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0,
    cacheWriteTokens: typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0,
  };
}

/** 判断一份 TokenUsage 是否为空（null 或四个桶全 0）。 */
export function isZeroUsage(usage) {
  return !usage
    || (usage.inputTokens === 0
      && usage.outputTokens === 0
      && (usage.cacheReadTokens ?? 0) === 0
      && (usage.cacheWriteTokens ?? 0) === 0);
}

/**
 * 从 result 的 `modelUsage`（Record<model, ModelUsage>）取主模型的上下文窗口。
 * 只返回正整数：token-meter 的投影 schema 要求 contextWindow 为正。
 * 匹配顺序：主模型 key → canonicalModel 命中 → 任意带正 contextWindow 的条目。
 */
export function contextWindowOf(modelUsage, model) {
  if (!modelUsage || typeof modelUsage !== "object") return undefined;
  const positive = (value) => (Number.isInteger(value) && value > 0 ? value : undefined);
  const direct = positive(modelUsage[model]?.contextWindow);
  if (direct !== undefined) return direct;
  const entries = Object.values(modelUsage);
  for (const entry of entries) {
    if (entry && entry.canonicalModel === model) {
      const value = positive(entry.contextWindow);
      if (value !== undefined) return value;
    }
  }
  for (const entry of entries) {
    const value = positive(entry?.contextWindow);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * 判断一条 SDK 消息是否属于「子代理转发内容」（关闭子代理追踪时用于丢弃，避免污染主轨迹）。
 * `parent_tool_use_id` 非空即转发；`task_*` 系统消息是旧 Task 工具的生命周期事件。
 */
export function isSubagentMessage(message) {
  if (message == null || typeof message !== "object") return false;
  if (message.type === "system") {
    switch (message.subtype) {
      case "task_started":
      case "task_progress":
      case "task_notification":
      case "task_updated":
        return true;
      default:
        return false;
    }
  }
  return message.parent_tool_use_id != null;
}

/**
 * 一次模型尝试的流式累积器：同时产出实时帧与最终持久化记录。
 *
 * 帧协议（@deepseek-ai/dsh-agent 的 `agent/assistant-stream`）：
 *   { type: 'start', attemptId, revision, turn, step }
 *   { type: 'chunk', attemptId, revision, index, time, chunk }
 *   { type: 'end',   attemptId, revision, index, outcome }
 * 区块本身在累积器内部即时组装；帧只承载增量的文本 / 思考 / 工具入参分片，
 * 因为 DSH 客户端按帧的 chunk 自增渲染，重复整块会翻倍。
 */
class StreamAttempt {
  #accumulator = new AssistantStreamAccumulator();
  #assembler = new BlockAssembler();
  #emit;
  #sessionId;
  #turn;
  #step;
  #index = 0;
  #revision = 0;
  #terminal = false;
  #prefixEligible = true;
  #prefixKinds = new Map();

  constructor({ sessionId, turn, step, emit }) {
    this.#sessionId = sessionId;
    this.#turn = turn;
    this.#step = step;
    this.#emit = emit ?? (() => {});
  }

  get attemptId() {
    return `${this.#sessionId}:${this.#turn}.${this.#step}`;
  }

  /** 发开头帧（在第一个分片之前）。 */
  start() {
    this.#emit({ type: "start", attemptId: this.attemptId, revision: ++this.#revision, turn: this.#turn, step: this.#step });
  }

  /** 喂一个 DSH StreamChunk：持续久化记录 + 实时帧。 */
  push(chunk) {
    if (chunk.type === "tool-call-delta") this.excludePrefix();
    // assembler 按首次种类组装同 index；冲突分片不能落成错归类的前缀正文。
    if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
      const previous = this.#prefixKinds.get(chunk.index);
      if (previous !== undefined && previous !== chunk.type) this.excludePrefix();
      else this.#prefixKinds.set(chunk.index, chunk.type);
    }
    let timed;
    try {
      timed = this.#accumulator.push({ time: Date.now(), chunk });
      this.#assembler.push(timed.chunk);
    } catch {
      this.excludePrefix();
      // 累积器拒绝的分片（形状不合 DSH 协议）不能污染持久化记录；
      // 仍把原文交给实时帧，界面照常显示，只是不进最终 stream。
      this.#emit({
        type: "chunk",
        attemptId: this.attemptId,
        revision: ++this.#revision,
        index: this.#index++,
        time: Date.now(),
        chunk,
      });
      return;
    }
    this.#emit({
      type: "chunk",
      attemptId: this.attemptId,
      revision: ++this.#revision,
      index: this.#index++,
      time: timed.time,
      chunk: timed.chunk,
    });
  }

  /** 记录空块的位置，不补造正文分片；signature-only thinking 也占一个 block。 */
  startBlock(index, type) {
    if (!Number.isSafeInteger(index) || index < 0) {
      this.excludePrefix();
      return;
    }
    const kind = type === "reasoning" ? "reasoning-delta" : "text-delta";
    const previous = this.#prefixKinds.get(index);
    if (previous !== undefined && previous !== kind) this.excludePrefix();
    else this.#prefixKinds.set(index, kind);
    this.#assembler.push({ type: "block-start", index, blockType: type });
  }

  /** 便捷方法：推文本 / 思考分片。 */
  pushText(index, text) {
    this.push({ type: "text-delta", index, text });
  }

  pushReasoning(index, text) {
    this.push({ type: "reasoning-delta", index, text });
  }

  pushToolCallDelta(index, id, name, argumentsDelta) {
    this.push({
      type: "tool-call-delta",
      index,
      id,
      ...(name === undefined || name === "" ? {} : { name }),
      argumentsDelta,
    });
  }


  get usage() {
    return this.#assembler.usage;
  }

  get stream() {
    return this.#accumulator.snapshot();
  }

  get replayState() {
    return this.#assembler.replayState;
  }

  get terminal() {
    return this.#terminal;
  }

  excludePrefix() {
    this.#prefixEligible = false;
  }

  /** 混合工具/未知块或无效分片不能靠过滤伪装成纯文本前缀。 */
  interruptedBlocks() {
    return this.#prefixEligible ? this.#assembler.interruptedBlocks() : [];
  }

  /** 已完成块以 envelope 为准，只补可按原始位置对齐的纯文本/reasoning 尾部。 */
  withInterruptedTail(blocks) {
    if (!this.#prefixEligible || blocks.some((block) => block.type !== "text" && block.type !== "reasoning")) return blocks;
    const observed = this.#assembler.blocks();
    // envelope 没有提供任何可持久化的对齐位置（例如只有 redacted_thinking 占位块）时，
    // 没有位置需要猜测：直接保存已观察到且合格的前缀。
    // 当前位置号不连续只说明 envelope 的块被丢弃了，不说明 stream 分片不可信。
    if (blocks.length === 0) {
      const prefix = observed.filter((block) => block.text.trim() !== "");
      return prefix.length > 0 ? prefix : blocks;
    }
    // envelope 没有 block index；缺号/乱序时不能猜测它覆盖了哪些 stream 块。
    if ([...this.#prefixKinds.keys()].some((index, position) => index !== position)) return blocks;
    if (blocks.length >= observed.length || blocks.some((block, index) => block.type !== observed[index].type)) return blocks;
    // 对齐前不能过滤空块，否则空 thinking envelope 会吃掉后面的文本位置。
    const tail = observed.slice(blocks.length).filter((block) => block.text.trim() !== "");
    return tail.length > 0 ? [...blocks, ...tail] : blocks;
  }

  abandon() {
    if (this.#terminal) return;
    this.#terminal = true;
    this.#emit({
      type: "end",
      attemptId: this.attemptId,
      revision: ++this.#revision,
      index: this.#index,
      outcome: { kind: "abandoned" },
    });
  }

  /** 组装最终 content blocks（含未闭合文本的安全前缀）。 */
  blocks() {
    return this.#assembler.blocks();
  }

  /**
   * 落盘最终 assistant 消息并发结束帧。
   * @param {object[]} blocks 已映射好的 DSH content blocks（工具名已按 DSH wire 名改写）
   * @returns {number|undefined} 持久化事件的 seq
   */
  settle(blocks) {
    if (this.#terminal) return undefined;
    let seq;
    try {
      seq = this.#append(blocks);
    } catch (error) {
      this.abandon();
      throw error;
    }
    this.#terminal = true;
    this.#emit({
      type: "end",
      attemptId: this.attemptId,
      revision: ++this.#revision,
      index: this.#index,
      outcome: { kind: "committed", eventType: "assistant/message", seq },
    });
    return seq;
  }

  /** 被上层替换掉的钩子（本模块直接 set）。 */
  #append = () => undefined;

  setAppender(fn) {
    this.#append = fn;
  }
}

/**
 * 一次 Claude Code 查询的轨迹转写器。
 *
 * 用法：`new ClaudeRunTracer(sink, turn)` → 逐条 `handleMessage(msg)` → `finish()`。
 */
export class ClaudeRunTracer {
  #sink;
  #turn;
  #step = 0;
  #stepOpen = false;
  #attempt = null;
  #toolCallSeqByCallId = new Map();
  #toolNameByCallId = new Map();
  /** callId → { step, name }：已发出 tool/call、尚未收到 tool/result 的调用。 */
  #openToolCalls = new Map();
  /** 原生任务工具 → DSH 任务表回放（todo/write 快照的数据源）。tracer 每回合一个实例，
   * 表生命周期与面板投影的「turn/start 重置」对齐。 */
  #taskTable = new ClaudeTaskTable();
  #model = PROVIDER;
  #configContextWindow;
  #lastHeader = null;
  #ended = false;
  /** 事件是否全部完整落盘；false 时上层不得补 turn/end（见 #closeStep 的说明）。 */
  #logIntact = true;
  /** 当前 step 是否已经落过一条 assistant/message（决定下一条助手消息要不要另起一步）。 */
  #stepSettled = false;

  /**
   * @param {object} sink 会话写入口：`append(type, data, opts?)`、`requestHeader()`、`requestContext()`
   * @param {number} turn 本查询所属的 DSH 回合号
   * @param {object} [options]
   * @param {number} [options.contextWindow] 引擎配置的上下文窗口兜底值
   * @param {(frame: object) => void} [options.emitStream] 实时帧发布器（agent/assistant-stream）
   */
  constructor(sink, turn, options = {}) {
    this.#sink = sink;
    this.#turn = turn;
    this.#configContextWindow = options.contextWindow;
    this.#emitStream = options.emitStream ?? (() => {});
  }

  #emitStream;

  /** 处理一条 SDK 消息。 */
  handleMessage(message) {
    if (this.#ended) return;
    switch (message?.type) {
      case "system":
        if (message.subtype === "init") this.#onInit(message);
        break;
      case "stream_event":
        this.#onStreamEvent(message);
        break;
      case "assistant":
        this.#onAssistant(message);
        break;
      case "user":
        this.#onUser(message);
        break;
      case "result":
        this.#onResult(message);
        break;
      default:
        break; // tool_progress / status / hook_* 等，v1 忽略
    }
  }

  /** 结束转写（幂等）：结算延迟的助手消息、关掉未闭合的 step。 */
  finish() {
    // 结算最后一条消息可能抛（写入口拒绝 append）；那一步失败也要继续关 step，
    // 否则日志会停在「开着的 step」——比少一条消息严重得多。
    try {
      this.#settlePending();
    } catch {
      this.#logIntact = false;
    }
    this.#closeStep();
    this.#ended = true;
  }

  /** 已开启的 step 数。 */
  get step() {
    return this.#step;
  }

  #onInit(msg) {
    if (typeof msg.model === "string" && msg.model) this.#model = msg.model;
    if (Array.isArray(msg.tools)) {
      this.#tools = msg.tools
        .filter((name) => typeof name === "string" && name.length > 0)
        .map((name) => ({ name: mapToolName(name), description: "", parameters: {} }));
    }
    this.#emitRequestHeader();
  }

  #tools = null;

  /**
   * 把本轮请求的信封（system + tools）写成 `request/header`，token-meter 的上下文构成投影
   * 据此给出 systemTokens / toolsTokens（对话部分由 surface 折叠给出）。
   * 只在首轮或 model/tools 变化时写，避免每轮重复。
   */
  #emitRequestHeader() {
    const header = {
      config: { provider: PROVIDER, model: this.#model },
      ...(this.#tools && this.#tools.length > 0 ? { tools: this.#tools } : {}),
    };
    const prev = this.#sink.requestHeader?.();
    if (prev
      && prev.config?.model === header.config.model
      && JSON.stringify(prev.tools ?? null) === JSON.stringify(header.tools ?? null)) {
      this.#lastHeader = header;
      return;
    }
    this.#sink.append("request/header", { header, reason: prev ? "change" : "initial" });
    this.#lastHeader = header;
  }

  #onStreamEvent(msg) {
    const event = msg?.event;
    if (!event) return;
    switch (event.type) {
      // 只用 message_start 的响应身份切边界；兼容端点的零 usage / 短 model 不作为权威。
      case "message_start":
        if (this.#pending && event.message?.id !== this.#pending.message.id) this.#settlePending();
        break;
      case "message_stop":
        this.#settlePending(undefined, "message-stop");
        break;
      case "content_block_start": {
        const block = event.content_block;
        this.#ensureAttemptForNewMessage();
        if (block?.type === "text" || block?.type === "thinking") {
          this.#attempt.startBlock(event.index, block.type === "thinking" ? "reasoning" : "text");
        } else if (isIgnorableClaudeBlock(block)) {
          // 占位块不产生正文，但真实占用一个 stream index；记录位置以免后续
          // 文本分片的 index 被判为缺号，也不把它当成混合流证据。
          this.#attempt.startBlock(event.index, "reasoning");
        } else this.#attempt.excludePrefix();
        if (block?.type === "tool_use") {
          this.#attempt.pushToolCallDelta(event.index, block.id ?? "", mapToolName(block.name ?? ""), "");
        }
        break;
      }
      case "content_block_delta": {
        const delta = event.delta;
        if (!delta) break;
        this.#ensureAttempt();
        this.#streamed = true;
        if (delta.type === "text_delta") this.#attempt.pushText(event.index, delta.text ?? "");
        else if (delta.type === "thinking_delta") this.#attempt.pushReasoning(event.index, delta.thinking ?? "");
        else if (delta.type === "input_json_delta") {
          this.#attempt.pushToolCallDelta(event.index, undefined, undefined, delta.partial_json ?? "");
        }
        // signature_delta / citations_delta 忽略
        break;
      }
      case "message_delta": {
        const usage = usageFromClaude(event.usage);
        if (!usage) break;
        // message_delta 是这条消息的权威定稿用量；它晚于 assistant 消息到达，
        // 所以挂在当前 attempt 上，随 assistant/message 一起落盘。
        this.#attempt?.push({ type: "usage", usage });
        break;
      }
      default:
        break;
    }
  }


  #onAssistant(msg) {
    const message = msg?.message;
    if (!message) return;
    const content = Array.isArray(message.content) ? message.content : [];
    const blocks = content.map(mapClaudeBlock).filter(Boolean);
    // 只有真正没被识别的块才算对齐失败；占位块被丢弃是预期行为，不是混合流证据。
    const unmapped = content.some((block) => !isIgnorableClaudeBlock(block) && mapClaudeBlock(block) === null);
    // SDK 按 content block 发 assistant；同一 API 响应共享 message.id，不能据此结束工具 step。
    if (typeof message.id === "string" && message.id !== "" && this.#pending?.message.id === message.id) {
      if (unmapped) this.#attempt?.excludePrefix();
      if (!this.#streamed) this.#pushBlocks(blocks, this.#pending.blocks.length);
      this.#pending = { message: { ...message, usage: message.usage ?? this.#pending.message.usage },
        blocks: [...this.#pending.blocks, ...blocks] };
      return;
    }
    // 新 envelope 触发的旧消息边界不能补尾部：这些 delta 可能正属于新 envelope。
    if (this.#pending !== undefined) this.#settlePending(undefined, "assistant");
    // 本步若已经落过一条助手消息，这一条要另起一步：一个 step 的 attempt 在第一条消息
    // 结算后即终止，第二条消息会**落不了盘**，而它的 `tool/call` 仍会发出，日志里就出现
    // 「没人广告过的 tool/call」，DSH 的会话格式校验直接判损坏（实测：
    //   SessionFormatError: tool/call … has no advertised tool lifecycle
    //   → 历史加载失败 / resume failed … is corrupt，会话永久打不开）。
    this.#ensureAttemptForNewMessage();
    const attempt = this.#attempt;
    if (!attempt) return;
    if (unmapped) attempt.excludePrefix();
    // 把已流式累积的分片固化成 assistant/message；这一步完全没有流式分片时
    // （端点不支持流式，或 includePartialMessages 关闭）用整块补推，
    // 保证 stream 记录与 content 一致。有流式时**不能**补推，否则内容会翻倍。
    if (!this.#streamed) this.#pushBlocks(blocks);
    // 延迟结算：结算要发生在这条消息的用量到达之后（见 #settlePending）。
    this.#pending = { message, blocks };
  }

  #pushBlocks(blocks, offset = 0) {
    blocks.forEach((block, index) => {
      if (block.type === "text") this.#attempt.pushText(offset + index, block.text);
      else if (block.type === "reasoning") this.#attempt.pushReasoning(offset + index, block.text);
      else if (block.type === "tool-call") this.#attempt.pushToolCallDelta(offset + index, block.id, block.name, block.arguments);
    });
  }

  /** 本步是否收到过流式分片（决定要不要用整块补推）。 */
  #streamed = false;

  /** 结算延迟的助手消息：落盘 assistant/message + 工具调用，并开 step 边界。 */
  #settlePending(fallbackUsage, boundary = "final") {
    const pending = this.#pending;
    if (pending === undefined) return;
    const attempt = this.#attempt;
    if (!attempt) return;
    const blocks = boundary === "assistant" ? pending.blocks : attempt.withInterruptedTail(pending.blocks);
    const interrupted = blocks !== pending.blocks;
    // message_stop 可能先于最后一个 block 的 envelope；留到迟到 envelope 或最终收尾。
    if (interrupted && boundary === "message-stop") return;
    this.#pending = undefined;

    // 用量优先级：assistant 帧自带的 BetaMessage.usage → 本步流里的 message_delta →
    // 调用方给的兜底（result.usage 只对最后一条生效）。
    // 写进 `assistant/message` 的 usage 字段是 token-meter 的权威读数来源：
    // 它按 (turn, step) 记账，并把 assistant/message 当作「紧跟其后请求的上下文锚点」，
    // 所以用量必须跟消息同一条事件落盘，晚到的补写不在它的读取路径上。
    // 补入的尾部不是完整响应，不把 result 聚合用量归给这条部分消息。
    const usage = usageFromClaude(pending.message.usage) ?? attempt.usage ?? (interrupted ? null : fallbackUsage) ?? null;
    if (usage !== null && !isZeroUsage(usage)) attempt.push({ type: "usage", usage });
    let messageSeq;
    try {
      messageSeq = attempt.settle(blocks);
    } catch (error) {
      // pending 已清空、attempt 已终止；finish 无法再观察到这次拒写。
      this.#logIntact = false;
      throw error;
    }
    // 消息没落盘（attempt 已终止 / 被放弃）时**绝不能**再发 tool/call：DSH 的会话格式要求
    // 每个 tool/call 先被 assistant/message 里的 tool-call 块广告过，否则整条会话判损坏。
    if (messageSeq === undefined) return;
    this.#stepSettled = true;

    this.#toolCallSeqByCallId = new Map();
    for (const block of pending.blocks) {
      if (block.type !== "tool-call") continue;
      const ev = this.#sink.append("tool/call", {
        turn: this.#turn,
        step: this.#step,
        callId: block.id,
        name: block.name,
        arguments: block.arguments,
      });
      this.#toolCallSeqByCallId.set(block.id, ev.seq);
      this.#toolNameByCallId.set(block.id, block.name);
      // 登记为「未决」：step 关闭前必须有配对的 tool/result，否则会话日志会被判定损坏。
      this.#openToolCalls.set(block.id, { step: this.#step, name: block.name });
      // 原生任务工具（TodoWrite / TaskCreate / TaskUpdate）：CLI 本地执行、不经过 DSH 工具层，
      // 在这里回放进任务表，把变更后的全量快照写成 todo/write 事件 —— 任务列表面板的数据源
      // （dsh-tool-todo 注册的 session projection 整表替换、last-write-wins）。
      const todos = this.#applyTaskToolCall(block.name, block.arguments, block.id);
      if (todos !== null) this.#sink.append("todo/write", { todos });
    }
    const results = this.#pendingToolResults;
    this.#pendingToolResults = [];
    for (const { block, meta } of results) this.#onToolResult(block, meta);
  }

  #pending = undefined;
  #pendingToolResults = [];

  /** 任务工具调用 → 任务表回放；入参解析失败视为无变更。 */
  #applyTaskToolCall(name, argumentsJson, callId) {
    let input;
    try {
      input = typeof argumentsJson === "string" && argumentsJson !== "" ? JSON.parse(argumentsJson) : {};
    } catch {
      return null;
    }
    return this.#taskTable.applyToolCall(name, input ?? {}, callId);
  }

  #onUser(msg) {
    const content = msg?.message?.content;
    if (!Array.isArray(content)) return; // prompt echo（字符串）等非工具结果消息忽略
    // `tool_use_result` 挂在整条消息上，所以只有这条消息恰好带**一个**工具结果时才能无歧义归属；
    // 多个结果时宁可不带（猜错归属比少带更糟）。
    const toolResultCount = content.filter((block) => block?.type === "tool_result").length;
    const meta = toolResultCount === 1 ? structuredToolMeta(msg.tool_use_result) : undefined;
    for (const block of content) {
      if (!block || block.type !== "tool_result") continue;
      // 已知响应可能还有后续 assistant 分块；早到结果等响应边界后统一配对，不能切 step。
      if (typeof this.#pending?.message.id === "string" && this.#pending.message.id !== "") {
        if (this.#pending.blocks.some((call) => call.type === "tool-call" && call.id === block.tool_use_id)) {
          this.#pendingToolResults.push({ block, meta });
        } else this.#onToolResult(block, meta);
        continue;
      }
      this.#settlePending();
      this.#onToolResult(block, meta);
    }
  }

  #onToolResult(block, meta) {
    const callId = block.tool_use_id ?? "";
    // 只写已广告且未结算的调用；未知/重复结果不能进入 DSH 工具生命周期。
    if (!this.#openToolCalls.has(callId)) return;
    // AskUserQuestion 的 deny 是答案，不是工具执行错误。
    const isAskUserQuestion = this.#toolNameByCallId.get(callId) === "AskUserQuestion";
    const result = createToolResultMessage({
      callId,
      content: mapClaudeToolResultContent(block.content),
      isError: isAskUserQuestion ? false : block.is_error === true,
    });
    const opts = { surfaceOp: "append" };
    const callSeq = this.#toolCallSeqByCallId.get(callId);
    if (callSeq !== undefined) opts.sourceEventSeqs = [callSeq];
    this.#ensureStepOpen();
    this.#sink.append("tool/result", {
      turn: this.#turn, step: this.#step, message: result,
      ...(meta === undefined ? {} : { meta }),
    }, opts);
    this.#openToolCalls.delete(callId);
    // TaskCreate 回执绑定真实任务 id，并清算先到的 TaskUpdate 排队补丁。
    const todosFromResult = this.#taskTable.applyToolResult(
      this.#toolNameByCallId.get(callId),
      callId,
      claudeToolResultText(block.content),
    );
    if (todosFromResult !== null) this.#sink.append("todo/write", { todos: todosFromResult });
  }

  /**
   * 一条 `result` = CLI 的**一个回合**结束，**不是整个 run 结束**。
   *
   * 关键区别（实测）：只要还有后台子代理在跑，CLI 就会在发完第一条 result 后继续留在同一个
   * query() 流上——先补一条 system/init，再把「子代理完成通知」唤醒出来的助手消息逐条发下来，
   * 最后以第二条 result 收尾（实测：第一条 result 之后还有 12 条消息）。所以这里只能收掉当前
   * step，绝不能把 tracer 关掉：一旦置 `#ended`，那段续跑（包含最终的总结）会被整段丢弃，
   * 界面上表现为「子代理跑完之后什么都没有」。
   */
  #onResult(msg) {
    // 收尾兜底：最后一条助手消息若还没落盘（或没拿到用量），此时用 result 的用量结算它。
    // 这一步必须发生在 closeStep 之前，且用量要连同 assistant/message 一起落盘。
    this.#settlePending(usageFromClaude(msg?.usage));
    this.#emitRequestContext(msg);
    this.#closeStep();
  }

  /** 从 result 的 modelUsage 取上下文窗口（配置兜底），变更时写 `request/context`。 */
  #emitRequestContext(msg) {
    let contextWindow = contextWindowOf(msg?.modelUsage, this.#model);
    if (contextWindow === undefined
      && Number.isInteger(this.#configContextWindow)
      && this.#configContextWindow > 0) {
      contextWindow = this.#configContextWindow;
    }
    if (contextWindow === undefined) return;
    const context = { provider: PROVIDER, model: this.#model, contextWindow };
    const previous = this.#sink.requestContext?.();
    if (previous
      && previous.provider === context.provider
      && previous.model === context.model
      && previous.contextWindow === context.contextWindow) return;
    this.#sink.append("request/context", context);
  }

  /** 需要内容时确保当前 step 开着（顺带在需要时新开一步）。 */
  #ensureAttempt() {
    this.#ensureStepOpen();
  }

  /**
   * 为「一条新的助手消息」准备 attempt：本步已落过消息就先关掉它、另起一步。
   *
   * 触发点有两处：流式路径的第一块 `content_block_start`（消息的分片必须先落进正确的
   * attempt），以及非流式路径的 `assistant` 事件。只认「本步是否已落过消息」而不是
   * 「来了新消息就切」——否则流式路径每条消息前面都会多出一个空 step。
   */
  #ensureAttemptForNewMessage() {
    if (this.#stepSettled) this.#closeStep();
    this.#ensureStepOpen();
  }

  #ensureStepOpen() {
    if (!this.#stepOpen) this.#openStep();
  }

  #openStep() {
    this.#step += 1;
    this.#stepOpen = true;
    this.#streamed = false;
    this.#pending = undefined;
    this.#stepSettled = false;
    this.#sink.append("step/start", { turn: this.#turn, step: this.#step });
    this.#attempt = new StreamAttempt({
      sessionId: this.#sink.sessionId ?? "session",
      turn: this.#turn,
      step: this.#step,
      emit: (frame) => this.#emitStream(frame),
    });
    this.#attempt.setAppender((blocks) => this.#sink.append("assistant/message", {
      turn: this.#turn,
      step: this.#step,
      message: createAssistantMessage({
        content: blocks,
        source: { provider: PROVIDER, model: this.#model },
      }),
      stream: this.#attempt.stream,
      ...(this.#attempt.usage === undefined ? {} : { usage: this.#attempt.usage }),
    }, { surfaceOp: "append" }).seq);
    this.#attempt.start();
  }

  #closeStep() {
    if (!this.#stepOpen) return;
    // 完整 envelope 已优先结算；这里只保存实际观察到的纯文本/reasoning 前缀。
    try {
      if (this.#attempt && !this.#attempt.terminal) {
        const blocks = this.#attempt.interruptedBlocks();
        if (blocks.length > 0) this.#attempt.settle(blocks);
        else this.#attempt.abandon();
      }
    } catch {
      this.#logIntact = false;
    }
    this.#stepOpen = false;
    this.#attempt = null;
    this.#pending = undefined;
    // 关键：step/end 之前必须给这个 step 里所有未决的 tool/call 补一条 tool/result。
    //
    // 实测故障：CLI 启动失败 / 回合被取消时，Claude 已经发出的 tool_use 永远等不到
    // tool_result，于是日志里留下「有调用、没结果」的 step。DSH 的会话格式校验会直接
    // 判定整条会话损坏：
    //   SessionFormatError: step/end leaves unresolved tool call call_…
    //   历史加载失败：stored session "…" is corrupt
    // 后果是这个会话**永久打不开**——比少一条结果严重得多，所以这里必须补齐。
    //
    // 但补写本身**同样会失败**（实测：合成结果没带 surfaceOp，被 DSH 的写入闸门拒绝：
    //   session event "tool/result" is surface-eligible and requires a surfaceOp marker）。
    // 因此两步都吞掉异常、只记标志：日志里留下开着的 step 是硬违规，而「turn 停开着」是
    // 格式允许的收尾状态。上层据此决定不补 turn/end（见 lib/agent.mjs 的 drive()）。
    try {
      this.#settleOpenToolCalls(this.#step, "interrupted");
    } catch {
      this.#logIntact = false;
    }
    try {
      this.#sink.append("step/end", { turn: this.#turn, step: this.#step });
    } catch {
      this.#logIntact = false;
    }
  }

  /**
   * 这一步的事件是否都完整落盘。false 表示补写或 step/end 被写入口拒绝，
   * 此时**不允许**再补 turn/end（那会让日志停在「开着的 step」，整条会话判损坏）。
   */
  get logIntact() {
    return this.#logIntact;
  }

  /**
   * 给指定 step 里尚未收到结果的 tool/call 补写合成结果。
   * @param {number} step 目标 step 号
   * @param {string} reason 写进结果文本的原因（便于排查）
   */
  #settleOpenToolCalls(step, reason) {
    for (const [callId, info] of [...this.#openToolCalls]) {
      if (info.step !== step) continue;
      const callSeq = this.#toolCallSeqByCallId.get(callId);
      // surfaceOp 不能省：tool/result 是 surface-eligible 事件，DSH 的写入闸门要求显式标记，
      // 只给 sourceEventSeqs 会被拒（session event "tool/result" is surface-eligible and
      // requires a surfaceOp marker），而这条 append 抛错会连带把回合收尾搞坏。
      const opts = {
        surfaceOp: "append",
        ...(callSeq === undefined ? {} : { sourceEventSeqs: [callSeq] }),
      };
      const result = createToolResultMessage({
        callId,
        content: [{
          type: "text",
          text: `dsh-claude-code: tool call "${info.name}" did not report a result (${reason}); the Claude Code run ended before it completed.`,
        }],
        isError: true,
      });
      this.#sink.append("tool/result", { turn: this.#turn, step, message: result }, opts);
      this.#openToolCalls.delete(callId);
    }
  }
}

/** 把 session 包装成 tracer 需要的 sink。 */
function sessionSink(session) {
  return {
    sessionId: session.id,
    append: (type, data, opts) => session.append(type, data, opts),
    requestContext: () => session.requestContext(),
    requestHeader: () => session.requestHeader(),
  };
}

/**
 * 跑一次 Claude Code，并把轨迹实时转写进会话。
 *
 * @param {object} options
 * @param {object} options.ctx 主上下文（取 approval / userQuestions）
 * @param {object} options.config 引擎配置
 * @param {object} options.session DSH 会话
 * @param {object} options.agent 当前 agent（审批与选择题的归属）
 * @param {() => object} [options.turnContext] 当前回合上下文访问器（goal 桥接的权限判定依据）
 * @param {number} options.turn 回合号
 * @param {string|AsyncIterable<object>} options.prompt 本轮提示词；带图片的回合是 SDK 的
 *   streaming input 消息流（见 lib/attachments.mjs 的 buildPrompt），否则是纯字符串。
 * @param {AbortSignal} options.signal 回合取消信号
 * @param {string} options.cwd 工作区根目录
 * @param {string} options.executable claude 可执行文件
 * @param {Record<string,string>} options.env 子进程环境
 * @param {string} [options.resumeSessionId] 上一轮捕获的 Claude 会话 id（续接）
 * @param {boolean} [options.forkSession] 与 resumeSessionId 成对：把父转录分叉到新会话（DSH fork）
 * @param {(frame: object) => void} [options.emitStream] 实时帧发布器
 * @param {object|null} [options.subagents] 子代理会话管理器；null 表示不追踪（子代理消息被丢弃）
 * @returns {Promise<{ output: object[], stopReason: 'completed'|'aborted'|'error', claudeSessionId?: string, logIntact: boolean }>}
 *   `logIntact === false` 表示本轮的会话事件没能全部落盘（写入口拒绝了某条 append），
 *   调用方**不得**再补 `turn/end` —— 那会把日志停在「开着的 step」而被判损坏。
 */
export async function runClaudeCode({
  ctx,
  config,
  session,
  agent,
  turnContext,
  turn,
  prompt,
  signal,
  cwd,
  executable,
  env,
  resumeSessionId,
  forkSession,
  emitStream,
  subagents,
  initialMessages = [],
  inputEpoch,
  inputPlacement,
  onReady,
  onInputSubmitted,
  onInputConsumed,
  canSubmitInput,
  canStartInput,
}) {
  const tracer = new ClaudeRunTracer(sessionSink(session), turn, {
    contextWindow: config.contextWindow,
    emitStream,
  });
  const controller = new AbortController();
  const requestCancel = () => {
    if (!controller.signal.aborted) controller.abort(new Error("dsh-claude-code: run cancelled locally"));
  };
  let inputControl;
  let modHost;
  let liveQuery;
  let inputLogIntact = true;
  const onAbort = () => {
    if (inputControl) void inputControl.interrupt();
    else requestCancel();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();

  // 回合起点的权限快照，只用于决定是否启用 permissionMode=bypassPermissions；
  // 其余策略统一走 canUseTool，不在此处固化回合内的权限。
  const strategy = permissionStrategy(readPermission(readSessionEvents(session)));
  // 用户在会话里选的模型 / 推理档位。Claude Code 模式下模型本来只来自 CLI 自己的
  // 配置（env / settings），前端换模型等于没换；这里把选择透传给 SDK，让选择真正生效。
  //
  // 会话里没显式选过时不能就此罢手（那样 CLI 会用自己的默认模型，出现「选择器显示 A、
  // 实际按 B 计费」）：退回宿主解析给本 agent 的有效模型。优先级与会话内一致——
  // 会话里选过的以会话为准，它覆盖宿主的默认路由。
  const modelSelection = foldModelSelection(readSessionEvents(session)) ?? hostModelSelection(agent);
  const onUserDialog = makeOnUserDialog(ctx, agent);
  /** 把会话选择落到 SDK options 上；SDK 不认识的推理档位不透传（不猜）。 */
  const applyModelSelection = () => {
    if (modelSelection === undefined) return;
    options.model = modelSelection.model;
    if (modelSelection.reasoningEffort !== undefined && EFFORT_LEVELS.has(modelSelection.reasoningEffort)) {
      options.effort = modelSelection.reasoningEffort;
    }
  };

  const goalArgs = { ctx, agent, turnContext, config: config.goal };
  const goalHandlers = config.goal?.enabled === false ? undefined : buildGoalHandlers(goalArgs);
  // 宿主装配的 persona：本插件不派发 `agent/pre-step`，所以 `systemPrompt.assemble()` 的产物
  // 从来不会进模型请求。persona 是部署方在预设里写死的身份文本（如「You are Claude Code,
  // an agent working inside DeepSeek Harness.」），必须按项转发；工具段落与 runtime contexts
  // 不转发（前者广告 DSH 的工具、后者虚构 DSH 的沙箱边界），见 lib/host-persona.mjs。
  const hostPersona = await readHostPersona({ ctx, agent, signal });
  // 最坏的失效形状是**静默**：真宿主在全局无条件注册两段空 persona，于是没有 persona 的 agent
  // 也拿到「2 段、空文本、无 reason」——只看 text/reason 分不出「宿主没配」和「配了没转到」，
  // 插件侧一片安静。落一条私有事实把段数/字数/是否转发/原因留在会话侧（只记长度，不落正文）。
  pluginFacts(session).append("claude-code/host-persona", {
    sections: hostPersona.sections,
    chars: hostPersona.text.length,
    forwarded: hostPersona.text !== "",
    ...(hostPersona.reason === undefined ? {} : { reason: hostPersona.reason }),
  });
  if (hostPersona.reason !== undefined) {
    try {
      ctx.logger?.info?.(`dsh-claude-code: host persona not forwarded — ${hostPersona.reason}`);
    } catch {
      // 日志失败不影响本轮
    }
  }
  /** 追加进 CLI preset 的文本：persona 在前（身份），goal 策略在后（流程）。 */
  const systemPromptAppend = [
    hostPersona.text,
    goalHandlers === undefined ? "" : goalGuidance(resolveGoalConfig(config.goal)),
  ].filter((part) => part !== "").join("\n\n");
  // DSH 侧工具桥：把白名单里的 agent-scope 工具（present / job_* 等）按 MCP 暴露给 Claude。
  // 默认关闭；创建失败也必须经过下方 try/finally 回收查询资源。
  let dshTools;
  /** 本轮 MCP server 表：DSH 工具桥与 goal 桥各占一个 server，互不覆盖。 */
  const mcpServersFor = (transport) => ({
    ...(dshTools === undefined ? {} : { [DSH_TOOL_SERVER_NAME]: dshTools.server }),
    ...(goalHandlers !== undefined && transport === "mcp" ? { [GOAL_SERVER_NAME]: buildGoalServer(goalArgs) } : {}),
  });
  const goalOptionsFor = (transport) => {
    const servers = goalHandlers === undefined && dshTools === undefined ? {} : mcpServersFor(transport);
    return {
      // 一支 server 都没有时**不能**留个空的 mcpServers——CLI 会把它当成"配了但没有服务器"。
      ...(Object.keys(servers).length === 0 ? {} : { mcpServers: servers }),
      ...(systemPromptAppend === "" ? {} : {
        systemPrompt: { type: "preset", preset: "claude_code", append: systemPromptAppend },
      }),
    };
  };

  const options = {
    abortController: controller,
    cwd,
    pathToClaudeCodeExecutable: executable,
    env,
    persistSession: config.persistSession !== false,
    includePartialMessages: config.includePartialMessages !== false,
    // 子代理全文转发：仅在开启子代理追踪时要求 SDK 转发子代理的 text/thinking 块。
    forwardSubagentText: subagents != null,
    // danger-full-access（回合起点）：跳过 Claude 的权限/沙箱判定，其余工具一律自动放行。
    // 但 canUseTool 仍要挂上：CLI 只在存在该回调时才把 AskUserQuestion 放进工具表——
    // bypassPermissions 不会自动放行「提问」这种交互。少了它，从 Full access 起手的整轮都缺
    // 这个工具，模型只能答「AskUserQuestion is disabled for this session」再退回纯文本。
    // 挂上后 AskUserQuestion 依旧走 canUseTool → DSH 选择题桥（见 lib/approval.mjs）。
    ...(strategy === "bypass"
      ? { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }
      : {}),
    onUserDialog,
    supportedDialogKinds: SUPPORTED_DIALOG_KINDS,
  };
  if (resumeSessionId) options.resume = resumeSessionId;
  // DSH fork 出来的会话：resume 父的 Claude 会话并把转录**分叉**到新 id，父不被续写。
  // 两者必须成对：没有 resume 就没有可分叉的对象（见 lib/fork.mjs）。
  if (forkSession === true && resumeSessionId !== undefined) options.forkSession = true;

  let finalResult = "";
  let resultError;
  let captureDisabled = false;
  let claudeSessionId = resumeSessionId;
  const startAllowed = () => {
    if (!canStartInput) return true;
    const decision = canStartInput(initialMessages);
    if (typeof decision !== "boolean") throw new TypeError("canStartInput must return boolean");
    return decision;
  };
  const rejectedInitial = async () => {
    await inputControl?.finish();
    tracer.finish();
    subagents?.finishRun({ aborted: signal.aborted });
    return { output: [], stopReason: "error", claudeSessionId,
      logIntact: tracer.logIntact && inputLogIntact,
      initialSubmitted: false, initialRejected: true };
  };
  try {
    if (signal.aborted) return { output: [], stopReason: "aborted", claudeSessionId, logIntact: true, initialSubmitted: false };
    // 解析结果若不可直接 spawn（Windows 上解不开的 .cmd shim）必须先拦下：Claude Agent SDK
    // 只按扩展名判断要不要用 node 起脚本，.cmd 会被当成原生可执行文件直接 spawn，Node 自
    // CVE-2024-27980 起同步抛 `spawn EINVAL`（errno -4071）。用户只能看到一个 errno，既不知道
    // 是哪个文件也不知道怎么修；这里换成带路径与修复方向的可读回合级错误。
    if (cannotSpawnDirectly(executable)) {
      throw new Error(
        `dsh-claude-code: the resolved Claude executable is a Windows batch shim (${executable}) whose target could not be unwrapped; ` +
        "Node refuses to spawn .cmd/.bat directly (spawn EINVAL). Reinstall the CLI, or point engines.claude-code.executable at the real .exe.",
      );
    }
    if (config.dshTools?.enabled === true) {
      dshTools = buildDshToolsServer({ ctx, agent, signal, names: config.dshTools.names ?? DEFAULT_DSH_TOOL_NAMES });
    }
    const inputSession = {
      id: session.id,
      snapshotEvents: () => readSessionEvents(session),
      append: (...args) => {
        try { return session.append(...args); }
        catch (error) { inputLogIntact = false; inputControl?.close(); throw error; }
      },
    };
    const facts = pluginFacts(session);
    bindPluginFacts(inputSession, {
      events: () => facts.events(),
      append: (...args) => {
        try { return facts.append(...args); }
        catch (error) { inputLogIntact = false; inputControl?.close(); throw error; }
      },
    });
    let epoch = inputEpoch ?? randomUUID();
    const makeInputControl = () => new ClaudeRunControl({ ctx, session: inputSession, signal, abort: requestCancel, epoch,
      onInputSubmitted: (messages) => {
        try { onInputSubmitted?.(messages); }
        catch (error) { inputLogIntact = false; inputControl.close(); throw error; }
      },
      onInputConsumed, canSubmitInput, inputPlacement });
    inputControl = makeInputControl();
    const support = config.mods?.enabled === true && agent?.id
      ? await probeModSupport({ executable, env, signal }) : { supported: false };
    let selected = buildModOptions({ config, env, supported: support.supported });
    if (selected.enabled) {
      const snapshots = new PromptSnapshotRecorder({ session: inputSession, agent, epoch });
      modHost = await createModHost({ session, agent, epoch, signal,
        goalHandlers: selected.goalTransport === "mod" ? goalHandlers : undefined,
        onPrompt: (snapshot) => snapshots.record(snapshot),
      });
      selected = buildModOptions({ config, env, supported: true,
        bridge: { url: modHost.url, token: modHost.token, sessionId: session.id, agentId: agent.id, epoch } });
    }
    Object.assign(options, selected.sdkOptions, goalOptionsFor(selected.goalTransport));
    applyModelSelection();
    const selectGoalPermissions = () => {
      const prefix = selected.goalTransport === "mod" ? "mcp__dsh-bridge__" : `mcp__${GOAL_SERVER_NAME}__`;
      options.canUseTool = makeCanUseTool(ctx, { cwd, session, agent,
        // 精确放行表：goal 桥工具 + 本轮真的注册进 server 的 DSH 工具（不可见的不写进来）。
        allowedToolNames: [
          ...(goalHandlers ? goalToolDefinitions().map((definition) => prefix + definition.name) : []),
          ...(dshTools?.names ?? []).map((name) => DSH_TOOL_PREFIX + name),
        ] });
    };
    selectGoalPermissions();
    const prepared = await inputControl.prepareInitial(prompt, initialMessages);
    if (signal.aborted) return { output: [], stopReason: "aborted", claudeSessionId, logIntact: true, initialSubmitted: false };
    if (!startAllowed()) return await rejectedInitial();
    let q = query({ prompt: inputControl.channel, options: { ...options } });
    liveQuery = q;
    if (modHost) {
      let timer;
      let abortWait;
      let ready;
      try {
        const timeout = config.mods?.handshakeTimeoutMs ?? 8000;
        if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000) throw new TypeError("invalid mod handshake timeout");
        ready = await Promise.race([modHost.ready,
          new Promise((resolve) => { timer = setTimeout(resolve, timeout); }),
          new Promise((resolve) => { abortWait = () => resolve(); signal.addEventListener("abort", abortWait, { once: true }); if (signal.aborted) abortWait(); }),
        ]);
      } finally { clearTimeout(timer); if (abortWait) signal.removeEventListener("abort", abortWait); }
      if (!inputLogIntact) throw new Error("prompt snapshot could not be recorded");
      if (!ready) {
        inputControl.close(); q.close(); await modHost.close(); modHost = undefined;
        if (signal.aborted) return { output: [], stopReason: "aborted", claudeSessionId, logIntact: inputLogIntact, initialSubmitted: false };
        pluginFacts(inputSession).append("claude-code/mod-status", { state: "fallback", goalTransport: "mcp", reason: "mod handshake did not complete before input" });
        ctx.logger?.warn?.("dsh-claude-code: mod handshake unavailable; using MCP without replaying input");
        epoch = randomUUID(); inputControl = makeInputControl();
        selected = buildModOptions({ config, env, supported: false });
        delete options.plugins;
        Object.assign(options, selected.sdkOptions, goalOptionsFor("mcp"));
        applyModelSelection();
        selectGoalPermissions();
        if (!startAllowed()) return await rejectedInitial();
        q = query({ prompt: inputControl.channel, options: { ...options } }); liveQuery = q;
      } else {
        claudeSessionId = ready.claudeSessionId;
        pluginFacts(inputSession).append("claude-code/mod-status", { state: "ready", goalTransport: selected.goalTransport, capture: "observed-compose" });
      }
    } else if (config.mods?.enabled === true) {
      pluginFacts(inputSession).append("claude-code/mod-status", { state: "unsupported", goalTransport: "mcp", reason: support.reason ?? "scoped mod capability unavailable" });
      ctx.logger?.warn?.("dsh-claude-code: selected CLI cannot load the scoped mod; using MCP");
    }
    if (!startAllowed()) return await rejectedInitial();
    inputControl.start(q, prepared);
    onReady?.(inputControl.public);
    for await (const message of q) {
      inputControl.handleMessage(message);
      // CLI 自己压缩上下文时留一条审计事实（原生事件里没有对应类型；见 compactObservation）。
      const compactFact = compactObservation(message);
      if (compactFact !== undefined) {
        try { facts.append("claude-code/compact", compactFact); }
        catch (error) { ctx.logger?.warn?.(`dsh-claude-code: could not record compaction fact (${String(error?.message ?? error)})`); }
      }
      if (message.type === "system" && message.subtype === "init" && typeof message.session_id === "string") {
        claudeSessionId = message.session_id;
      }
      if (modHost && !captureDisabled && message.type === "system" && message.subtype === "ui_log"
        && message.plugin === "dsh-bridge" && message.session_id === claudeSessionId
        && message.text === "dsh-bridge: prompt capture disabled (snapshot unavailable).") {
        captureDisabled = true;
        pluginFacts(inputSession).append("claude-code/mod-status", { state: "capture-disabled", epoch,
          goalTransport: selected.goalTransport, capture: false, reason: "snapshot unavailable" });
        ctx.logger?.warn?.("dsh-claude-code: prompt capture disabled (snapshot unavailable); goal adapter unchanged");
      }
      const childMessage = subagents != null ? subagents.handleMessage(message) : isSubagentMessage(message);
      if (childMessage) {
        dshTools?.observe(message, { isMain: false });
        continue;
      }
      tracer.handleMessage(message);
      dshTools?.observe(message, { isMain: tracer.logIntact && inputLogIntact });
      if (message.type === "result") {
        if (message.subtype === "success" && typeof message.result === "string") finalResult = message.result;
        else if (message.subtype !== "success") resultError = (message.errors ?? []).join("\n") || message.subtype;
      }
      if (!tracer.logIntact || !inputLogIntact) {
        inputControl.close();
        throw new Error("session append rejected; stopping Claude input");
      }
      if (controller.signal.aborted) break;
    }
    if (!inputLogIntact) throw new Error("session append rejected; stopping Claude input");
    await inputControl.finish();
    tracer.finish();
    subagents?.finishRun({ aborted: controller.signal.aborted });
    if (controller.signal.aborted || signal.aborted) {
      return { output: [], stopReason: "aborted", claudeSessionId, logIntact: tracer.logIntact && inputLogIntact, initialSubmitted: inputControl?.initialSubmitted === true };
    }
    return { output: [{ type: "text", text: resultError ?? finalResult }], stopReason: resultError ? "error" : "completed", claudeSessionId, logIntact: tracer.logIntact && inputLogIntact, initialSubmitted: inputControl?.initialSubmitted === true };
  } catch (error) {
    try { await inputControl?.finish(); } catch { inputLogIntact = false; }
    tracer.finish();
    subagents?.finishRun({ aborted: controller.signal.aborted || signal.aborted });
    if (controller.signal.aborted || signal.aborted) {
      return { output: [], stopReason: "aborted", claudeSessionId, logIntact: tracer.logIntact && inputLogIntact, initialSubmitted: inputControl?.initialSubmitted === true };
    }
    // CLI 启动/运行失败的现场快照。`spawn EINVAL` 这类错误只给出 errno，
    // 无从判断是哪个参数不对（可执行文件？cwd？env？信号？），所以把决定性字段一次性记下来。
    ctx.logger?.warn?.(
      `dsh-claude-code: claude CLI failed — ${JSON.stringify({
        error: String(error?.message ?? error),
        code: error?.code,
        errno: error?.errno,
        syscall: error?.syscall,
        path: error?.path,
        spawnargs: error?.spawnargs,
        executable,
        cwd,
        cwdExists: (() => { try { return existsSync(cwd); } catch { return "unknown"; } })(),
        envKeys: Object.keys(env ?? {}).length,
        callerSignalAborted: signal.aborted,
        localSignalAborted: controller.signal.aborted,
        resume: resumeSessionId !== undefined,
      })}`,
    );
    return {
      output: [{ type: "text", text: String(error?.message ?? error) }],
      stopReason: "error",
      claudeSessionId,
      logIntact: tracer.logIntact && inputLogIntact, initialSubmitted: inputControl?.initialSubmitted === true,
    };
  } finally {
    dshTools?.close();
    signal.removeEventListener("abort", onAbort);
    inputControl?.close();
    liveQuery?.close?.();
    await modHost?.close();
    try {
      controller.abort();
    } catch {
      // 已中止则忽略
    }
  }
}

export { query };
