---
type: Reference
title: 事件映射
description: Claude Agent SDK 消息 → DSH 会话事件 / 实时帧的对照表。
resource: lib/claude-run.mjs
tags: [reference, events, trace]
timestamp: 2026-08-14
---

# 回合与 step 的分界

一次 Claude Code 查询 = 一个 DSH **回合**（`turn/start` … `turn/end`，由 `lib/agent.mjs` 写）。
一条 Claude assistant 消息 = 一个 DSH **step**（`step/start` … `step/end`，由 `lib/claude-run.mjs` 写）。

一次查询里 Claude 可能连续产出多条 assistant 消息（每次工具调用前后各一条），它们都属于
同一个回合，各自一个 step。

`result` 只代表 **CLI 的一个回合**结束，**不代表这次查询结束**：只要还有后台子代理在跑，
CLI 会留在同一个 `query()` 流上继续产出（补一条 `system/init` → 把通知唤醒出来的助手消息
逐条发下来 → 第二条 `result`）。因此一次查询 = 一个 DSH 回合里可能有很多 step，这些续跑
step 与首轮 step 同属一个回合（不伪造 `user/message`）。

# SDK 消息 → 会话事件

| Claude Agent SDK | DSH 会话事件 | 说明 |
|---|---|---|
| `system/init` | `request/header`（`reason: "initial"`） | 模型名与内建工具表；工具名经 wire 映射。只在首轮或 model/tools 变化时写 |
| `stream_event` `content_block_delta`（text） | — | 转成实时帧（见下），最终进 `assistant/message.stream` |
| `stream_event` `content_block_delta`（thinking） | — | 同上，`reasoning-delta` |
| `stream_event` `content_block_delta`（input_json） | — | 同上，`tool-call-delta` |
| `stream_event` `message_delta` | — | 本条消息的权威用量，落在随后那条 `assistant/message` 的 `usage` 上 |
| `assistant` | `assistant/message`（+ `tool/call` ×N） | content 走块映射；工具调用另写 `tool/call` 供卡片渲染 |
| `user`（tool_result） | `tool/result` | `AskUserQuestion` 的结果不标 `isError`（它是答案，不是错误） |
| `result` | `request/context` | 写模型上下文窗口（`modelUsage` 取不到时用配置兜底）；并收掉当前 step——**不结束 run**（后台子代理的续跑随后继续写进同一回合的新 step） |
| `system/task_*`、带 `parent_tool_use_id` 的消息 | 子会话事件 | 开启子代理追踪时归位到独立子会话；关闭时丢弃 |

# 顺序（同一步内）

```
step/start
assistant/message        ← 含 content、stream、usage
tool/call ×N
tool/result ×N
step/end
```

`tool/result` 会带 `sourceEventSeqs: [toolCallSeq]` 指回它的 `tool/call`。

# 两个关键约束

**用量必须与消息同一条事件落盘。** `dsh-token-meter` 的 `usageOf()` 只读
`assistant/message.data.usage`，或它内嵌 `stream` 里最后一个 `usage` 分片。而 Claude 的用量
常常在 `result` 才给全，因此最后一条助手消息会**延迟结算**到 `result`：结算时按
「assistant 帧自带 usage → 本步 `message_delta` → `result.usage` 兜底」的顺序取值，写进同一条
`assistant/message`。消息一旦落盘，晚到的补写不在 token-meter 的读取路径上。

**实时帧只承载增量。** `agent/assistant-stream` 的分片会被客户端自增渲染，所以帧里只放
文本 / 思考 / 工具入参分片，不放整块内容；完整内容在 `assistant/message` 的 `content` 与
`stream` 里。

# 实时帧协议

`agent/assistant-stream` 的 payload 是 `{ frame }`：

| 帧 | 字段 | 时机 |
|---|---|---|
| `start` | `attemptId` / `revision` / `turn` / `step` | 开 step 之后、第一个分片之前 |
| `chunk` | `attemptId` / `revision` / `index` / `time` / `chunk` | 每个 DSH StreamChunk（`text-delta` / `reasoning-delta` / `tool-call-delta` / `usage` …） |
| `end` | `attemptId` / `revision` / `index` / `outcome` | `outcome.kind = "committed"`（带 `eventType`/`seq`）或 `"abandoned"` |

# 工具名映射

DSH 前端按 wire 工具名分类渲染；未命中的名字会落进通用卡片。映射表：

| Claude Code | DSH wire |
|---|---|
| `Bash` / `BashOutput` / `KillShell` | `bash` |
| `Read` | `read` |
| `Write` | `write` |
| `Edit` / `MultiEdit` / `NotebookEdit` | `edit` |
| `Glob` | `glob` |
| `Grep` | `grep` |
| `WebFetch` | `web_fetch` |
| `WebSearch` | `web_search` |
| `Skill` | `skill`（入参 `command` 改写成 `name`） |
| `TodoWrite` | `todo_write` |
| `Agent` / `Task` | `subagent` |

# 子代理追踪

以主轨迹里的 `Agent` / `Task` `tool_use` 块为**权威信号**：每个子代理用它的 `tool_use` id
作身份键，带 `parent_tool_use_id` 的转发消息据此归位。每个子代理是一个独立 DSH 子会话
（`origin: "subagent"` + `parentSession` + `delegationDepth` + `subagent/descriptor`），
只读、不可续跑，完成后 flush 再 detach（仍可读轨迹）。

收尾信号取决于是**前台**还是**后台**子代理：

- 前台：父线程的 `tool_result` 就是它的产出 → 到达即收尾。
- 后台：父线程的 `tool_result` 只是「异步启动回执」（`Async agent launched successfully`），
  产出经转发消息到达，收尾靠 `system/task_notification`。本机 CLI 的 `Agent` 工具**默认异步
  启动**，入参里没有 `run_in_background`，判定依据是 `system/task_started.is_backgrounded`
  （该消息先于启动回执到达）。

一次查询的 `query()` 流关闭 = CLI 已退出，此时仍未收尾的子会话由 `finishRun` 一并收掉
（不会再有人送来通知）。

子会话要真正出现在 lineage 树里、并且真的落盘，还依赖两条宿主契约（都踩过坑）：

- **lineage 树的数据源是父会话的事件**：树读的 `subagentCatalog` 是父会话上
  `subagent/catalog` 事件的投影（`@deepseek-ai/dsh-subagent` 的
  `subagentCatalogProjectionDefinition`），而不是宿主会话名录。所以建子会话时必须往
  **父会话**补一条 `{version: 0, childId, childCreatedAt, mode: "one-shot", label?}`；
  只把子会话塞进 sessions store，树里永远是空的。
- **落盘靠写所有权**：写日志的不是 `agents.enter/announce`（那只管 agents store 与
  `agent/created` 通知），而是 `sessionPersistence`——后端按 `writers.get(session.id)`
  路由 `session/event`，没取到写所有权的会话一个事件都写不出去。所以建子会话要先
  `persistence.create(header)`，把发布前攒下的事件补写进 handle，然后才 `enter/announce`
  （顺序反了，发布之后写的每个事件都会被路由到一个还不存在的 handle 而丢失）。
