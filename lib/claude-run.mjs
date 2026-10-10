// lib/claude-run.mjs — 跑一次 Claude Code 查询，并把它的轨迹实时映射成 DSH 会话事件。
//
// 职责分三层：
//   1. StreamAttempt —— 把 Claude 的流式分片喂给 DSH 的累积器，产出「实时帧」（web 界面据此
//      逐字渲染）和「最终持久化记录」（写进 assistant/message 的 stream 字段）。
//   2. ClaudeRunTracer —— SDK 消息 → DSH 会话事件的纯映射（step 边界、消息、工具调用/结果）。
//   3. runClaudeCode —— 组装 SDK 选项（权限、对话框、续接）并驱动一次查询。
//
// 映射约定：一条 Claude assistant 消息 = 一个 DSH step；一次查询里的多条消息 = 同一 turn 内的
// 多个 step。turn/start 与 turn/end 由上层 agent.mjs 负责，本模块只管 step 内部。
import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import {
  AssistantStreamAccumulator,
  BlockAssembler,
  createAssistantMessage,
  createToolResultMessage,
} from "@deepseek-ai/dsh-llm";
import { makeCanUseTool } from "./approval.mjs";
import { readPermission, permissionStrategy } from "./permission.mjs";
import { makeOnUserDialog, SUPPORTED_DIALOG_KINDS } from "./dialog.mjs";
import { readSessionEvents } from "./session-events.mjs";

/** 写进会话 `request/header` 的 provider 名；与 llm-route.mjs 注册的 provider 一致。 */
export const PROVIDER = "claude-code";

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
    let timed;
    try {
      timed = this.#accumulator.push({ time: Date.now(), chunk });
      this.#assembler.push(timed.chunk);
    } catch {
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
      this.#terminal = true;
      this.#emit({
        type: "end",
        attemptId: this.attemptId,
        revision: ++this.#revision,
        index: this.#index,
        outcome: { kind: "abandoned" },
      });
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
      // message_start 不处理：兼容端点下它的 usage 全为 0，且 model 是去后缀短名，
      // 处理它只会污染 #model。权威用量在 message_delta / result 里。
      case "content_block_start": {
        const block = event.content_block;
        this.#ensureAttemptForNewMessage();
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
    // 上一条 Claude 助手消息还挂着 → 先结算上一条。
    if (this.#pending !== undefined) this.#settlePending();
    // 本步若已经落过一条助手消息，这一条要另起一步：一个 step 的 attempt 在第一条消息
    // 结算后即终止，第二条消息会**落不了盘**，而它的 `tool/call` 仍会发出，日志里就出现
    // 「没人广告过的 tool/call」，DSH 的会话格式校验直接判损坏（实测：
    //   SessionFormatError: tool/call … has no advertised tool lifecycle
    //   → 历史加载失败 / resume failed … is corrupt，会话永久打不开）。
    this.#ensureAttemptForNewMessage();
    const blocks = (Array.isArray(message.content) ? message.content : []).map(mapClaudeBlock).filter(Boolean);
    const attempt = this.#attempt;
    if (!attempt) return;
    // 把已流式累积的分片固化成 assistant/message；这一步完全没有流式分片时
    // （端点不支持流式，或 includePartialMessages 关闭）用整块补推，
    // 保证 stream 记录与 content 一致。有流式时**不能**补推，否则内容会翻倍。
    if (!this.#streamed) {
      blocks.forEach((block, index) => {
        if (block.type === "text") attempt.pushText(index, block.text);
        else if (block.type === "reasoning") attempt.pushReasoning(index, block.text);
        else if (block.type === "tool-call") {
          attempt.pushToolCallDelta(index, block.id, block.name, block.arguments);
        }
      });
    }
    // 延迟结算：结算要发生在这条消息的用量到达之后（见 #settlePending）。
    this.#pending = { message, blocks };
  }

  /** 本步是否收到过流式分片（决定要不要用整块补推）。 */
  #streamed = false;

  /** 结算延迟的助手消息：落盘 assistant/message + 工具调用，并开 step 边界。 */
  #settlePending(fallbackUsage) {
    const pending = this.#pending;
    if (pending === undefined) return;
    this.#pending = undefined;
    const attempt = this.#attempt;
    if (!attempt) return;

    // 用量优先级：assistant 帧自带的 BetaMessage.usage → 本步流里的 message_delta →
    // 调用方给的兜底（result.usage 只对最后一条生效）。
    // 写进 `assistant/message` 的 usage 字段是 token-meter 的权威读数来源：
    // 它按 (turn, step) 记账，并把 assistant/message 当作「紧跟其后请求的上下文锚点」，
    // 所以用量必须跟消息同一条事件落盘，晚到的补写不在它的读取路径上。
    const usage = usageFromClaude(pending.message.usage) ?? attempt.usage ?? fallbackUsage ?? null;
    if (usage !== null && !isZeroUsage(usage)) attempt.push({ type: "usage", usage });
    const messageSeq = attempt.settle(pending.blocks);
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
    }
  }

  #pending = undefined;

  #onUser(msg) {
    const content = msg?.message?.content;
    if (!Array.isArray(content)) return; // prompt echo（字符串）等非工具结果消息忽略
    for (const block of content) {
      if (!block || block.type !== "tool_result") continue;
      // 工具结果可能在 assistant 事件之后、下一条 assistant 之前到达；
      // 先把上一条消息结算掉（工具调用事件必须先于它的结果）。
      this.#settlePending();
      const callId = block.tool_use_id ?? "";
      // 只为「本插件确实广告并发出过 tool/call」的调用补结果。否则会写出没有对应调用的
      // tool/result，同样是 DSH 会话格式的硬违规（tool/result … has no advertised tool lifecycle），
      // 而会话一旦违规就永久打不开。
      if (!this.#openToolCalls.has(callId)) continue;
      // AskUserQuestion 的 deny 是「答案」而非错误，故不标记 isError，避免渲染成红色。
      const isAskUserQuestion = this.#toolNameByCallId.get(callId) === "AskUserQuestion";
      const result = createToolResultMessage({
        callId,
        content: mapClaudeToolResultContent(block.content),
        isError: isAskUserQuestion ? false : block.is_error === true,
      });
      const opts = { surfaceOp: "append" };
      const callSeq = this.#toolCallSeqByCallId.get(callId);
      if (callSeq !== undefined) opts.sourceEventSeqs = [callSeq];
      // tool/result 必须在 step 内：Claude 的工具结果到达时当前 step 仍然开着。
      this.#ensureStepOpen();
      this.#sink.append("tool/result", { turn: this.#turn, step: this.#step, message: result }, opts);
      this.#openToolCalls.delete(callId);
    }
  }

  #onResult(msg) {
    // 收尾兜底：最后一条助手消息若还没落盘（或没拿到用量），此时用 result 的用量结算它。
    // 这一步必须发生在 closeStep 之前，且用量要连同 assistant/message 一起落盘。
    this.#settlePending(usageFromClaude(msg?.usage));
    this.#emitRequestContext(msg);
    this.#closeStep();
    this.#ended = true;
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
 * @param {number} options.turn 回合号
 * @param {string|AsyncIterable<object>} options.prompt 本轮提示词；带图片的回合是 SDK 的
 *   streaming input 消息流（见 lib/attachments.mjs 的 buildPrompt），否则是纯字符串。
 * @param {AbortSignal} options.signal 回合取消信号
 * @param {string} options.cwd 工作区根目录
 * @param {string} options.executable claude 可执行文件
 * @param {Record<string,string>} options.env 子进程环境
 * @param {string} [options.resumeSessionId] 上一轮捕获的 Claude 会话 id（续接）
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
  turn,
  prompt,
  signal,
  cwd,
  executable,
  env,
  resumeSessionId,
  emitStream,
  subagents,
}) {
  const tracer = new ClaudeRunTracer(sessionSink(session), turn, {
    contextWindow: config.contextWindow,
    emitStream,
  });
  const controller = new AbortController();
  const requestCancel = () => {
    if (!controller.signal.aborted) controller.abort(new Error("dsh-claude-code: run cancelled locally"));
  };
  const onAbort = () => requestCancel();
  signal.addEventListener("abort", onAbort, { once: true });

  // 回合起点的权限快照，只用于决定是否启用 permissionMode=bypassPermissions；
  // 其余策略统一走 canUseTool，不在此处固化回合内的权限。
  const strategy = permissionStrategy(readPermission(readSessionEvents(session)));
  const canUseTool = makeCanUseTool(ctx, { cwd, session, agent });
  const onUserDialog = makeOnUserDialog(ctx, agent);

  const options = {
    abortController: controller,
    cwd,
    pathToClaudeCodeExecutable: executable,
    env,
    persistSession: config.persistSession !== false,
    includePartialMessages: config.includePartialMessages !== false,
    // 子代理全文转发：仅在开启子代理追踪时要求 SDK 转发子代理的 text/thinking 块。
    forwardSubagentText: subagents != null,
    // danger-full-access（回合起点）：完全跳过 Claude 的权限/沙箱判定。
    ...(strategy === "bypass"
      ? { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }
      : { canUseTool }),
    onUserDialog,
    supportedDialogKinds: SUPPORTED_DIALOG_KINDS,
  };
  if (resumeSessionId) options.resume = resumeSessionId;

  let finalResult = "";
  let claudeSessionId = resumeSessionId;
  try {
    const q = query({ prompt, options });
    for await (const message of q) {
      if (message.type === "system" && message.subtype === "init" && typeof message.session_id === "string") {
        claudeSessionId = message.session_id;
      }
      if (subagents != null) {
        if (subagents.handleMessage(message)) continue;
      } else if (isSubagentMessage(message)) {
        continue;
      }
      tracer.handleMessage(message);
      if (message.type === "result" && message.subtype === "success" && typeof message.result === "string") {
        finalResult = message.result;
      }
      if (controller.signal.aborted) break;
    }
    tracer.finish();
    subagents?.finishRun({ aborted: controller.signal.aborted });
    if (controller.signal.aborted || signal.aborted) {
      return { output: [], stopReason: "aborted", claudeSessionId, logIntact: tracer.logIntact };
    }
    return { output: [{ type: "text", text: finalResult }], stopReason: "completed", claudeSessionId, logIntact: tracer.logIntact };
  } catch (error) {
    tracer.finish();
    subagents?.finishRun({ aborted: controller.signal.aborted || signal.aborted });
    if (controller.signal.aborted || signal.aborted) {
      return { output: [], stopReason: "aborted", claudeSessionId, logIntact: tracer.logIntact };
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
      logIntact: tracer.logIntact,
    };
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      controller.abort();
    } catch {
      // 已中止则忽略
    }
  }
}

export { query };
