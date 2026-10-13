# context 分项与压缩可观测：结论与实现

第三期「getContextUsage 分项统计及压缩/进度可观测」这一项的调查与交付。调查对象是本机
Claude Code CLI 2.1.296 与 `@anthropic-ai/claude-agent-sdk` 0.3.220。

## 一、context 分项：拿得到，但**喂不进 DSH 的显示**

SDK 确实提供了真实分项：`query.getContextUsage()` → `SDKControlGetContextUsageResponse`，
含 `categories[{name,tokens,color}]`、`totalTokens`、`maxTokens`、`percentage`、`gridRows`、
`memoryFiles`、`mcpTools` 等（`get_context_usage` 控制请求）。

问题在**去处**：DSH 的显示由 `dsh-token-meter` 自己的投影算，且明说是**启发式估计**——

- `contextBreakdown`（`breakdown-projection.js`）：「Heuristic composition of the current retained
  surface, **independent of route image pricing and provider usage**」，只折叠 DSH 日志里的
  surface 事件与 `request/header`，输出固定三元 `{systemTokens, toolsTokens, messageTokens}`。
- `contextPressure`（`usage-projection.js`）：分母取最新 `request/context.data.contextWindow`，
  分子取 `assistant/message.data.usage` 的 prompt 侧 token。

两个投影的事件与字段都是**闭集**，没有留给「由适配器提供真实分项」的口子。插件能做的只有：
把 `request/header` 的真实工具表与 `request/context` 的真实 `contextWindow` 写准——**这两条已经
在做**。所以「把 Claude 的真实分项喂进 DSH 面板」需要 DSH 侧新增契约（新的投影/事件），
不是插件单方面能完成的。

**结论：分项不进（无接口），但压力条的分子/分母是真实的。**

## 二、压缩可观测：**已经落地**

CLI 会主动上报它自己的压缩，而插件此前把这些消息整块丢掉了：

| CLI 消息 | 内容 |
|---|---|
| `system/compact_boundary` | `compact_metadata: { trigger: manual/auto, pre_tokens, post_tokens?, duration_ms?, preserved_segment? }` |
| `system/status` | `status: "compacting"`；结束时的 `compact_result: success/failed` 与 `compact_error` |

现在 `lib/claude-run.mjs` 的 `compactObservation()` 把它们归一成一条**插件私有事实**
`claude-code/compact`（`kind: boundary | started | settled`，带前后 token、耗时、
`result` 与失败原因）。

**为什么记私有事实而不是原生事件**：DSH 的 compaction 事件由 `BasicCompactionEngine` 按
checkpoint 契约写（要 `compactCheckpointSource` 事务身份、要替换 surface 区段），插件伪造会
直接破坏会话日志。私有事实是这类「插件观察」既有的落点（同 `prompt-snapshot`、`mod-status`）。

**它的价值**：真实会话里那次压缩失败原本只留下一条难以理解的 CLI stderr
（`[claude-code:unrecognized_model] … "query_source":"compact"` 然后 exit 1）；现在事实流里会先有
`{"kind":"started"}`，然后是 `{"kind":"settled","result":"failed","error":"…"}`，压缩开始/成功/失败
都成为可审计的一条记录，而不是靠猜。

## 验证

- 测试：`compactObservation` 的三个用例（边界含 token/耗时、开始与成败、无关消息不产生事实）
  与 `structuredToolMeta` 同文件，RED→GREEN；全套 286/286。
- 接口事实取自 `sdk.d.ts`（`SDKCompactBoundaryMessage` / `SDKStatusMessage` /
  `SDKControlGetContextUsageResponse`）与安装包里的 `breakdown-projection.js` / `usage-projection.js`。
