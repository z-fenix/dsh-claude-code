# continuable 子代理：接口现状与结论

本文件记录第三期「continuable 子代理 / 续聊 / 单独停止及 workflow 接入」这一项的只读调查。
结论是**插件无法提供 DSH 意义上的 continuable 子代理**，理由分接口与结构两层。调查对象是本机
Claude Code CLI 2.1.296 与 `@anthropic-ai/claude-agent-sdk` 0.3.220。

## DSH 要的是什么

DSH 的 `subagent/catalog` 里 `mode` 只有两档：`one-shot` 与 `continuable`。lineage 面板据此显示
「一次性」或「可继续」，可继续的子会话能被点开、继续对话。本插件当前**始终**写 `one-shot`
（`lib/subagents.mjs` 的 `snapshotOneShotDescriptor`），这是刻意的：不为界面好看而谎报能力。

## 插件能驱动一个子代理吗：不能

1. **控制通道没有对应请求。** SDK 的 `SDKControlRequestInner` 联合里有 `stopTask`、
   `backgroundTasks`（把前台任务转后台），但**没有任何「给子代理发消息 / 恢复子代理」的请求**。
   整份联合类型里与子代理地址相关的只有 `SDKTaskStartedMessage` 的 `task_id` / `tool_use_id` /
   `subagent_type` —— 那是**观测**用的标识，不是可寻址的收件人。
2. **`SendMessage` 只是模型手里的工具。** CLI 给模型暴露了 `subagent` / `ListAgents` /
   `SendMessage` / `TaskStop` 四个工具（实测取自会话的 `request/header`），模型可以用
   `SendMessage { to: <agentId>, message }` 给自己起过的代理发消息。但它是**模型调用**的工具，
   SDK 没有等价接口——插件无法代替模型调用它，也不该伪造一条用户消息去诱导模型调用。
3. **唯一非模型的通道是 `SubagentStop` 钩子，且语义不同。** SDK 写明
   `SubagentStopHookSpecificOutput.additionalContext` 是「non-error feedback delivered to the
   subagent; **the subagent continues so it can act on it**」。也就是说，本插件已经随包发布的那套
   mod 可以在子代理**停止时**喂一段反馈让它继续跑。这不是「用户随时点开子会话接着聊」，
   而是「子代理收尾时再推它一把」，且只在父查询还活着的时候有意义。

## 结构上也不成立

一个 Claude 子代理是**父查询进程内**的一个子代理：它的消息是带 `parent_tool_use_id` 的转发，
父查询结束（CLI 退出）后它就不存在了，`resume` 只把它的转录「materialize」出来供阅读
（SDK 的 `SessionStore.listSubkeys` 注释：*Used during resume to discover and materialize all
subagent data*），并不能让它重新可对话。DSH 的 continuable 子会话则要求子会话本身有一个能接受
输入、能自己驱动的 Agent —— 这正是它没有的东西。

## 因此

- **保持 `mode: "one-shot"`**，不在目录里改 mode 换界面上的一句话：能力确实不存在。
- 子代理已经是**只读投影 + 真实运行态载体**：轨迹可读、运行/完成态如实上报、累计 token 有读数
  （新子会话实测 `tokenUsage` / `subagentTiming` 齐全）。缺的只是「继续对话」，而它没有接口。
- 若将来要做，唯一站得住的路径是 **mod 承接 `SubagentStop` 反馈**：把 DSH 侧排队的消息在子代理
  收尾时喂回去，从而让一个子代理在父查询存活期间被「追问」。它的边界必须说清楚——用户不能随时
  打开一个已结束的子会话继续聊天；能做的只是「给它续一口气」。这需要单独设计。

## 验证方式

- 控制请求清单取自 `sdk.d.ts` 的 `SDKControlRequestInner` 联合；工具清单取自真实会话的
  `request/header`（`subagent` / `ListAgents` / `SendMessage` / `TaskStop`）。
- `SubagentStopHookSpecificOutput` 的语义取自 `sdk.d.ts` 的原文注释。
- 「本插件始终写 one-shot」是代码事实：`lib/subagents.mjs` 只有 `snapshotOneShotDescriptor`，
  `#appendCatalog` 写 `mode: "one-shot"`。
