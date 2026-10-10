// lib/llm-route.mjs — 把 `claude-code` 注册成一个「休眠」的 LLM provider 路由。
//
// 背景：DSH 前端的模型选择 / 输入框拦截只认 `ctx.llm.listProviders()`，把它当作
// 「当前 provider 是否有 adapter 服务」的唯一事实。而 Claude Code 由本机 CLI 驱动，
// 从不进 `ctx.llm`；轨迹模块却会把 `provider: "claude-code"` 写进会话的 request/header
// （用于用量归因）。若不注册该 provider，首轮之后前端读到「当前模型不可用」并锁死输入框。
//
// 本路由只为了让 `listProviders()` 包含 `claude-code`；它**从不真正转发请求**——
// 因此 stream() 显式抛错，作为「误入此路由」的兜底，而不是静默吞掉。
import { LlmAdapter } from "@deepseek-ai/dsh-llm";

/** 与引擎 id、以及轨迹模块写入 header 的 provider 一致。 */
export const CLAUDE_CODE_PROVIDER = "claude-code";

/**
 * 休眠的 Claude Code LLM 路由：只贡献 provider 目录，不承载任何流式调用。
 * listModels 沿用默认空列表（空组会被目录层剔除，不影响 routeServed）。
 */
export class ClaudeCodeLlmRoute extends LlmAdapter {
  providerInfo(provider) {
    return { id: provider, name: "Claude Code" };
  }

  stream() {
    throw new Error(
      "dsh-claude-code: claude-code sessions are driven by the Claude Code CLI, not the dsh llm adapter",
    );
  }
}
