---
type: Reference
title: 事件映射
description: Claude Agent SDK 消息 → DSH 会话事件 / 实时帧的对照表。
resource: lib/claude-run.mjs
tags: [reference, events, trace]
timestamp: 2026-10-13
---

# 回合与 step 的分界

一次 Claude Code 查询 = 一个 DSH **回合**（`turn/start` … `turn/end`，由 `lib/agent.mjs` 写）。
一个 Claude API 响应 = 一个 DSH **step**（`step/start` … `step/end`，由 `lib/claude-run.mjs` 写）。
SDK 可将同一响应的文本/工具分别发送为多个 `assistant` envelope，`message.id` 相同；这些分块合并，
不能每条都关 step，否则并行工具的真实结果会被提前补写的 interrupted 错误替代。
缺少响应 id 的旧消息保留原来的消息边界兜底。

`message_start` 的响应身份在新 stream 分片进入前结算旧响应；`message_stop`、下一响应、`result` 或
查询 EOF 结算完整响应。早于响应结束的工具结果先保存，广告调用后再写真实结果；未知回执不推动边界。
真正缺失的结果仍需在 step 关闭前补写错误，以保持日志合法。

`result` 只代表 **CLI 的一个回合**结束，**不代表这次查询结束**：只要还有后台子代理在跑，
CLI 会留在同一个 `query()` 流上继续产出（补一条 `system/init` → 把通知唤醒出来的助手消息
逐条发下来 → 第二条 `result`）。因此一次查询 = 一个 DSH 回合里可能有很多 step，这些续跑
step 与首轮 step 同属一个回合（不伪造 `user/message`）。

# SDK 消息 → 会话事件

| Claude Agent SDK | DSH 会话事件 / 插件私有事实 | 说明 |
|---|---|---|
| `system/init` | `request/header`（`reason: "initial"`） | 模型名与内建工具表；工具名经 wire 映射。只在首轮或 model/tools 变化时写 |
| `stream_event` `content_block_delta`（text） | — | 转成实时帧（见下），最终进 `assistant/message.stream` |
| `stream_event` `content_block_delta`（thinking） | — | 同上，`reasoning-delta` |
| `stream_event` `content_block_delta`（input_json） | — | 同上，`tool-call-delta` |
| `stream_event` `message_delta` | — | 本条消息的权威用量，落在随后那条 `assistant/message` 的 `usage` 上 |
| `assistant` | `assistant/message`（+ `tool/call` ×N） | content 走块映射；工具调用另写 `tool/call` 供卡片渲染 |
| `user`（tool_result） | `tool/result` | 按 callId 配对；早到结果等待所属响应完成，未知/重复回执不写；`AskUserQuestion` 的结果不标 `isError`。消息上带 `tool_use_result`（SDK 给的工具完整 Output 对象）时写进 `data.meta`；这条消息里工具结果不止一个就不写，避免猜错归属，不可序列化或超过 16 KiB 也不写 |
| 本地 querying 意图 / reservation / 提交 / 回显 / 结果 UUID | `claude-code/input-intent`、`claude-code/input`、`claude-code/input-batch`、`claude-code/input-receipt` | 持久意图、逐消息台账、原子批次提交边界和 receipt；回显仅代表收到，匹配 success 结果才证明消费 |
| mod `prompt.compose` | `claude-code/prompt-snapshot` | 有序 sections、model、digest、epoch；source=observed-compose、completeness=partial、compositionLoop=unattributed |
| mod 能力 / 启动握手 / 当前 mod 的固定 `system/ui_log` 失效通知 | `claude-code/mod-status` | ready / fallback / unsupported / capture-disabled；精确 goal transport 与捕获状态，不含令牌或桥接地址；失效不改 composition 或 goal adapter |
| CLI 自己的上下文压缩（`system/compact_boundary` / `system/status`） | `claude-code/compact` | `kind: boundary` 带 trigger / 前后 token / 耗时；`kind: started` 与 `kind: settled` 带 `result` 与失败原因 `error`。DSH 的 compaction 事件属于宿主 checkpoint 契约，插件不伪造 |
| `result` | `request/context` | 写模型上下文窗口（`modelUsage` 取不到时用配置兜底）；并收掉当前 step——**不结束 run**（后台子代理的续跑随后继续写进同一回合的新 step） |
| `system/task_*`、带 `parent_tool_use_id` 的消息 | 子会话事件 | 开启子代理追踪时归位到独立子会话；关闭时丢弃 |

表中的 `claude-code/*` 是**独立插件台账的事实类型**，不是新追加的 DSH 会话事件。
台账位于 `${DSH_CLAUDE_CODE_STORE:-~/.dsh/dsh-claude-code}/facts/<sessionId摘要>.jsonl`，写入与 flush
成功后才更新投递状态。每条记录有私有 `factSeq` 和原生日志锚点；`readSessionEvents` 仍只返回原生
日志，只有输入/快照折叠使用合并视图。已有 manifest 的台账缺失、损坏或锚点不一致时停止投递，不
静默按空历史继续。旧日志中已标记 `ignorable:true` 的同名事实只读兼容，不重写成新的原生事件。

DSH 0.2.0-rc.2 的 `Session.append` 不保存 `ignorable` 选项；运行时能追加未知事件不代表重启能读取。
历史修复必须备份和停写，且以完整 format catalog restoration / persistence 校验为准；只跑事件关系
或 append admission 校验不能证明重启兼容。快照返回 `factSeq`；仅旧日志引用使用 `legacySeq`。

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

# 输入与提示词事实

每个 query 只有一份持久 async 输入流和 epoch，不用多个有限 `streamInput()` 来模拟追加。
宿主 inbox 先非破坏性 peek，图片准备后核对消息对象未被编辑/删除才 consume。普通 followup 不进活查询，
steer 使用 querying 输入，inject 使用 `shouldQuery:false`，不会自己启动模型回合。

投递状态为 pending/reserved/submitted/observed/canceled/uncertain。首批输入在 dequeue 前就保存 reserved，
其中含 message、原 queue/position 和 querying 意图；运行中批次同样先 reserve，后 claim / user surface。
整个 SDK envelope 的 submitted 边界由一条 `claude-code/input-batch` 保存，拒写不会只提交半批。
该边界仍先于实际交付，因此崩溃后的 submitted 只能按 uncertain 对待；不因缺少 receipt 而重发。

重开时旧 epoch 的 reserved 派生为 pending，submitted 派生为 uncertain；派生本身不追加状态转换事件。
仅带完整原队列信息且可证明未提交的 reservation 会恢复为原生 inbox splice；已在队列的消息不会重复插入。
用户编辑/删除的旧 reservation 不复活，明确清空也取消孤立的未提交 claim。旧版本缺少恢复信息的事实不会猜测重投。
`claude-code/input-intent` 保留 steer 的 querying 意图；编辑保留同 id 的意图，删除、取消和 claim 清理，
恢复 reservation 时重新登记原意图。缺少意图的旧 next-step 保守地按 inject 处理，不自动 querying。
中断回执不能单独证明取消或消费；`keepInbox` 不收回已提交消息。

`claude-code/prompt-snapshot` 是本机 hook 的观察事实，不是原生模型 surface。保留 sections 的 id、text、
scope 和顺序；只去重相同连续 digest，不解析 assistant 自称的提示词。`compositionLoop: unattributed`
表示绑定的宿主 agent 只是桥接所有者，不能证明捕获的 Claude 内部循环身份。首 user surface 的顺序、
最终 prompt 完整性和循环归属均未证明，因此不写 `system/message`，也不写 `request/header.system`。

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
只读、不可续跑，完成后 flush 再 detach（仍可读轨迹）。新子会话的 `subagent/catalog.label` 使用清洗后的
短任务 description/type/name（不解析角色 prompt，最多 48 个 Unicode code points）；provider 保留在
`subagent/descriptor`。原生非 user `session/title` 必须引用本子会话已有的人类 `user/message`，只读投影
没有这种来源，因此不写自动来源/类型标题、不伪造人类消息。不会重写旧标题，也不覆盖人工重命名。
列表 token 为累计真实用量，不是当前上下文压力。

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
