# 真实 Claude compact：旧通道历史调查（2026-10-13）

> **2026-10-16 更新**：下文保留当时 SDK/普通用户消息通道的调查，不再代表插件的当前能力。现在使用 scoped Mod 的 `$.command.run({ command: "compact" })` 和独立结果观察器进入原生压缩；CLI 2.1.301 的零推理探针已验证零用户输入 resume、历史可见、manual compact 和结构化 skip 凭据（0 API 请求）。直接 `$.session.compact()` 在 SDK/headless 仍被明确拒绝。真实收费摘要及桌面验收尚未执行。当前设计见 `2026-10-16-native-compact-mod-design.md`。

本文件记录第二期「`/compact`、自动压力与超限恢复作用于 Claude 实际上下文」这一项的只读调查。
结论是**插件无法触发 Claude 的真实压缩**，理由有接口层与实测两层；能做的只有「不再误导用户」
与「把 CLI 自己的压缩暴露出来」。调查对象是本机 Claude Code CLI 2.1.296 与
`@anthropic-ai/claude-agent-sdk` 0.3.220。

## 两边各自在压什么

- **DSH**：`/compact` 命令（`dsh-command-compact`）调用 `ctx.compaction.compactNow(agent, signal, commandId)`。
  `ctx.compaction` 是**一个上下文一份实现**的服务（`CompactionEngine extends Service`，
  「Load one implementation per context」），当前由 `dsh-compaction-basic` 提供；
  它在 `agent/pre-step` 里 shadow 掉**DSH 会话日志里的 surface 节点**，再用一个摘要节点替换那段历史。
- **Claude Code**：真正的上下文在 CLI 进程里，由 CLI 自己按 `autoCompactThreshold` /
  `autoCompactWindow` / `isAutoCompactEnabled` 自动压缩，并通过 SDK 上报：
  - `system/compact_boundary`（带 `compact_metadata`）
  - `status`（`SDKStatus = 'compacting' | 'requesting' | null`）
  - 本地斜杠命令输出 `local_command_output`

**两者没有任何交集**：DSH 压的是 DSH 的日志表面，CLI 压的是自己的上下文。本插件的 prompt 由
CLI 装配，所以 DSH 侧的压缩对模型**没有效果**——用户在 Claude Code 会话里按 `/compact`，
界面上看起来「压缩了」，模型那边什么都没变。

## 插件能触发 CLI 的压缩吗：不能

两条路都堵死，且都有证据：

1. **控制通道没有对应请求。** SDK 的 `SDKControlRequestInner` 联合类型里没有任何压缩请求
   （只有 interrupt / permission / initialize / setPermissionMode / setModel /
   setMaxThinkingTokens / rename / setColor / mcpStatus / getContextUsage / getSessionCost /
   listModels / getUsage / getBinaryVersion / mcpCall / fileSuggestions / hookCallback /
   mcpMessage / rewindFiles / cancelAsyncMessage / readFile / getWorkspaceDiff / getPlan /
   seedReadState / mcpSetServers / registerRepoRoot / reloadPlugins / reloadSkills /
   mcpReconnect / mcpToggle / stopTask / backgroundTasks / applyFlagSettings / getSettings /
   elicitation / requestUserDialog）。没有 compact。

2. **数据通道不认这条斜杠命令。** CLI 自己触发压缩走的是内部队列：

   ```js
   enqueueCompact: () => G.enqueue({ mode: "prompt", value: "/compact", isMeta: !0, skipAttachments: !0, ... })
   runCompact:    () => void this._submitSlashCommand("/compact")
   ```

   `isMeta` 是 CLI 内部标志；而 SDK 暴露的 `SDKUserMessage` 只有
   `type / message / parent_tool_use_id / isSynthetic / tool_use_result / priority / origin /
   shouldQuery / timestamp / uuid / session_id / subagent_type` 等，**没有 `isMeta`**。

   实测（真实隔离实例，`session-21f03030`）：把 `/compact` 当普通用户消息提交，turn 3 只有
   `request/header reason=change` 然后 `turn/end completed`——**零 step、零助手消息、没有
   `compact_boundary`**。斜杠命令根本没有被执行。

## 因此

- **自动压力 / 超限恢复不需要插件做**：CLI 自己按它的阈值压缩自己的上下文。DSH 的
  `compaction-basic` 在 Claude Code 会话里照样只会 shadow DSH 日志节点，对模型无效。
- **`/compact` 在 Claude Code 会话里只能改 DSH 显示面**。要让用户不走空，最诚实的做法是
  明说这一点（README 已写），而不是硬造一个「压缩成功」的界面。
- **CLI 自己的压缩目前完全不可见**：插件整个 `lib/` 里没有任何 `compact` 处理，
  `system/compact_boundary` 与 `status` 都被丢弃。以后若要补，最小改动是把它们记成
  `claude-code/*` 私有事实（与 `prompt-snapshot`、`mod-status` 同类），不写原生事件——
  原生 `compaction` 事件由 `BasicCompactionEngine` 按 checkpoint 契约写入，插件伪造会破坏日志。

## 残余风险（不是插件能修的）

CLI 的自动压缩打到**不支持压缩请求的代理**上会硬失败。真实会话里的现场是：

```
[claude-code:unrecognized_model] {"model":"ccs-claude-deepseek--deepseek-flash[1m]","query_source":"compact"}
Claude Code process exited with code 1
```

即压缩请求被上游拒绝 → 进程 exit 1 → **整轮无产出**。长会话（尤其 goal 连续轮次）会反复撞上。
插件能做的只有如实把 CLI 的 stderr 报成回合错误（现状如此）；真正的修复在代理侧支持压缩请求，
或换一个支持压缩的模型/端点。
