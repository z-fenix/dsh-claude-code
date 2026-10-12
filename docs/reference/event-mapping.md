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

# 关键约束

**turn/end 之前必须 serial 派发 `agent/turn-stopping`。** 原生 dsh-agent-loop 在 append
`turn/end` 之前先 serial 派发该事件，宿主侧的轮内监听器（如 `dsh-workspace-changes`
记录器）等它完成才放行。本插件在 `lib/agent.mjs` 的 drive() 里遵守同一契约；漏掉它时
`workspace/changes` 会落在 `turn/end` 之后，客户端的改动文件卡片要等下一轮 `turn/start`
重建视图才渲染——表现为「每轮结束后的文件变更延迟到下一次发消息才显示」。`logIntact === false`
的回合不派发（回合不闭合，与原生错误路径一致，由记录器的 turn/end 兜底覆盖；本插件此处
连 turn/end 都不写，下一轮 start 丢弃状态）。

**改动文件卡片的覆盖边界（插件会话）。** `dsh-workspace-changes` 记录器有两条采集途径：
`tools/pre-execute` 里「编辑前整文件捕获」，以及轮内快照对比。Claude Code 的文件编辑发生在
CLI 进程内，不经过 DSH 的 `tools/pre-execute`，所以前一条路对插件会话**永远不触发**。工作区
在 git 仓库内时，快照对比仍能完整覆盖；工作区不在任何 git 仓库内时，插件会话的改动文件
卡片将基本为空（shell 改动同样不计）。这是宿主记录器的规则，本插件无法绕过，属已知边界。

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

## 任务列表回放（todo/write）

DSH 的任务列表面板读会话日志里的 `todo/write` 事件（`@deepseek-ai/dsh-tool-todo` 注册的
session projection：整表替换、last-write-wins、`turn/start` 重置）。这些任务工具在 CLI
本地执行、不经过 DSH 工具层，所以 tracer 在流结算处把每次原生任务操作回放进一张任务表
（`lib/tasks.mjs`，每个 turn 一个实例），并把变更后的**全量快照**写成 `todo/write` 事件：

- `TodoWrite`：整表替换（入参 `todos` 归一化：trim、丢空内容 / 非法状态 / 重复项；不做
  「至多一个 in_progress」校验，Claude 允许并行任务，面板如实渲染）。
- `TaskCreate`：追加 pending 项。入参没有 id，真实 id 在回执文本里
  （实测 `"Task #N created successfully: …"`）→ 先用占位 id，回执到达时绑定。
- `TaskUpdate`：按数字 `taskId` 补丁状态 / subject。它的 `tool_use` 可能先于 `TaskCreate`
  的回执到达（实测）→ 引用未绑定 id 的补丁先排队，绑定后自动清算。

回执在 step 关闭后才到（如回合被取消）时占位项绑定不上，补丁随 turn 丢弃 —— 面板在
`turn/start` 也会重置，两侧生命周期一致。

# 子代理追踪

以主轨迹里的 `Agent` / `Task` `tool_use` 块为**权威信号**：每个子代理用它的 `tool_use` id
作身份键，带 `parent_tool_use_id` 的转发消息据此归位。每个子代理是一个独立 DSH 子会话
（`origin: "subagent"` + `parentSession` + `delegationDepth` + `subagent/descriptor`），
只读、不可续跑，完成后 flush 再 detach（仍可读轨迹）。

每个子会话还会登记一个**只做状态载体的被动 Agent**（`lib/child-agent.mjs`，不驱动任何回合、
不接受输入）。原因：lineage 面板每行的运行状态只来自宿主对子会话的 running 判定，而 running
只可能由「该会话在 `ctx.agents` 注册表里有一个 `status === "running"` 的 Agent」产生
（`dsh-api-session-controller` 的 `summaryFor` 读 `agents.get(id)?.status`，`api-session/status`
只由 `agent/status` 派发）。不登记的话，正在执行的子代理会被渲染成「一次性 · 当前未运行」，
表头也不出现运行中计数。载体的生命周期与子会话同生共死：建会话即上报 `running`，收尾上报
`idle` 并从注册表注销。它是**附加信号**——登记失败只写诊断日志，子会话、轨迹、catalog、
落盘一律不受影响（判据同 `lib/router.mjs` 的 `publishResilient`：已进注册表就保留，
只少一次 `agent/created` 通知）。

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
