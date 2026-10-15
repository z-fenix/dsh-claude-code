# Goal 日志准入与异步准备竞态保护

日期：2026-10-14。

状态：对话设计已确认；本文为待用户审阅的独立 spec。尚未批准实施计划或产品实现。本文不授权提交、真实模型调用或正式会话修复。

## 1. 意图与交付边界

用户希望 Claude Code 模式的 goal 自动回合与运行中输入能够可靠工作：准备输入期间修改、暂停或取消目标时，不应把陈旧的自动消息写入会话或提交给模型；拒绝自动消息不能顺带丢掉人类消息、steer 或 inject。

本阶段交付是插件侧的 **goal 日志准入与异步准备竞态保护**。它使用宿主公开 goal view，保留宿主作为目标状态、轮数与自动驱动的唯一权威。它不是完整的 standard reservation fence，也不修复既有损坏日志。

成功标准：

- 无效自动消息不会进入新的 `user/message`，不会提交给 Claude，也不会推进 goal 轮数。
- 异步准备后重新校验，准备期间发生的目标或队列变化不能沿用旧授权。
- 混合批次中其它输入保持来源、内容、顺序和 querying 意图；不因剔除 goal 而提交仍含旧 goal 的 prompt。
- keepInbox 恢复待办时重新准入，不自动恢复目标的 continuation authority。
- 读取错误与“没有当前目标”明确区分；失败路径没有自动忙循环或未经证据的重投。
- 合法自动消息仍沿用宿主的 `user/message` 计数机制；同一消息只准入一次。

## 2. 约束

- 不修改 DSH app.asar，不安装全局 Claude 插件，不自动 commit/push，不运行未经批准的收费推理。
- 不修改正式 profile、全局 Claude settings 或正式/历史无效会话日志；不读取或导出认证秘密。
- 普通 followup 排队；steer 在安全边界插入；inject 不自己启动新的人类回合；显式 cancel 停止当前生成，keepInbox 保留待办。
- 不派发整个 `agent/pre-step`，不重复运行宿主的 prompt、工作区指令或压缩装配。
- 不访问或复制 goal-round-driver 私有 attempt，不另建 goal 状态、计数器或自动轮次生成器。
- 不改 source 为人类，不把消息正文、mod 参数或模型声明当作 continuation authority。
- MCP 与 mod 继续调用同一领域 handler；mod 未支持时保留 MCP，同一查询不重复暴露 goal 工具。
- 系统提示词快照不冒充最终全文，不向 request/header 写 system；子代理继续保持 one-shot，不伪造用量、不重写历史标题。
- 本文的审批不延伸到其它 parity 项、宿主接口开发、真实隔离模型验收或提交操作。

## 3. 已核对的契约

### 3.1 公开 goal view

当前安装宿主的 `GoalService.get(agent)`：

1. 要求 registry 中的 exact live agent，而不是只比较 id。
2. 返回由 durable goal projection 和 process-local activation 组成的新 view。
3. 无当前目标时返回 `undefined`。
4. 投影失败或 agent 不再 live 时抛错。

`disarm(agent)` 仅移除 process-local continuation authority，不改变 durable phase/revision。插件不能以读取失败为理由猜测旧引用并调用 resume。

### 3.2 轮数准入

宿主 goal projection 在 `user/message` 上验证 source，并在有效事件上推进 roundsStarted。正数自动 round 必须匹配当前 active goal 的 id、revision，满足 `round === roundsStarted + 1`，且不超过 maxGoalRounds。

activation 是 process-local 的附加准入条件，不能仅靠 durable replay 获得。

当前安装宿主对 `source.kind === "goal"` 要求非空 goalId、正安全整数 revision 和 round。`round:0`、负数、非整数等不是可直接写入原生 `user/message` 的普通通知。driver 恢复逻辑出现 round 0 的过滤分支，不构成 goal projection 接受 round 0 的证明。

### 3.3 完整 native reservation 不公开

standard driver 还要求私有 attempt 已 claimed、非 stale、正文与预留内容深度相等，且 driver fiber 有效、未 stopping。竞争输入可以把私有 attempt 标记 stale，即使公开 goal view 的 id/revision/round 仍未改变。

这些条件无法仅通过 `goals.get(agent)` 验证。本阶段不承诺检查原生 reservation provenance、私有 stale、预留正文相等、driver 生命周期或 startsRequestSeries 等价行为。

### 3.4 插件现有输入路径

`agent.drive()` 在 buildPrompt、resolveClaude 后检查消息对象仍在队列，随后记录 reserved、consume、写 turn/start 和 user/message；缺少目标准入检查。

`DshInbox.consume()` 验证对象身份，然后逐条持久移除，再派发 claimed。持久化和派发都不能被假定为一个不受同步监听器影响的原子事务。

运行中 next-step 输入也可经 `onInputSubmitted` 写 user/message。准入不变量必须覆盖这些写入口，不能只保护首批输入后留下旁路。此要求不新增运行中自动 goal round 支持，也不改变普通 inject 的非 querying 语义。

## 4. 方案选择

采用插件侧有限准入保护：公开 goal view 提供目标身份、状态与下一轮约束，现有 inbox/input ledger 提供对象身份与未提交输入的恢复依据。

不采用 whole `agent/pre-step`：它会运行其它 prompt/指令/压缩监听器，破坏 Claude CLI 对实际模型上下文的装配职责。

完整 standard reservation 等价留给宿主的独立公开 admission 接口。该接口若将来可用，需要另行设计与审批，不能通过解析私有实现或模拟整个 driver 获得。

## 5. 组件职责

### 5.1 准入判定

将判定与队列/日志副作用分开。判定接受真实消息批次、当前公开 goal view 和当前执行生命周期，返回以下三类结果：

- **允许**：本批至多一条 goal 自动消息，source 合法，exact live agent、当前 phase 与取消状态有效，goal 为 active/armed，身份、revision、下一轮与上限均匹配。
- **拒绝自动消息**：source 非法、多条自动 goal、无当前目标、身份/状态/轮次不匹配；拒绝涉及的 goal 项，不授权其它项为人类。
- **读取或生命周期失败**：无法可信获取 view 或执行主体已失效。停止自动消息准入，保留错误，不把错误降为 `goal:null`。

无 goal 的普通输入不因新增守卫而额外依赖一次成功的 goal 读取。多个 goal 项不能凭任取第一条而获得授权，即使其中一条满足下一轮条件。

### 5.2 驱动集成

驱动负责执行判定、持久化拒绝结果、重新选择和准备剩余输入，以及保护日志写入口。不在准入判定中调用 create/edit/pause/resume/complete/blocked。

### 5.3 输入账本与审计

沿用现有 inbox/input ledger，保留原 message.id、placement、source、querying 意图和 epoch 边界。拒绝原因通过插件诊断记录；不得向原生日志写入新的未注册事件，也不得把插件拒绝标成用户主动取消的业务原因。

若复用现有 inbox 移除契约，其持久化 outcome 仍遵循已有词汇；另以诊断说明是准入拒绝。不得仅直接 splice 内存数组或静默清空队列。

## 6. 准入数据流

### 6.1 准备前

1. 非破坏读取本次候选消息。
2. 检查 goal source 格式及批次唯一性。
3. 有 goal 项时读取公开 view 并执行准入判定。
4. 已确定无效时，在 claim/turn/start 前拒绝对应 goal 项，其它项留在队列。
5. 重新选择具有 querying 意图的剩余输入；只有 inject 时保持 pending，不启动查询。

拒绝是针对 exact pending 消息对象的操作。用户已替换或移除的对象不能仅凭相同 id 被旧异步回调删除。

### 6.2 异步准备后

buildPrompt、图片准备及 resolveClaude 完成后，重新检查消息对象、phase、abort 状态，并重新读取 goal view。

- 仍有效：进入同步 claim/日志准入路径。
- 已无效：拒绝对应自动项；旧 prompt/images 不再使用。下一次准备必须从剩余真实队列重新构造。
- 读取失败：不 claim、不写自动 user/message、不提交模型；保留该批 pending 与错误。
- 队列快照变化：放弃该准备结果，从新的队列快照重新评估。

新的 steer 或普通输入插入不能被这次读取偷偷纳入旧 prompt。公开字段仍匹配时，也不能推断 native attempt 没有因竞争输入而 stale；这是本阶段明确保留的差距。

### 6.3 Claim 与日志边界

最后一次公开状态校验到 claim 之间不插入新的 await。consume、turn/start、前序 user/message 的同步通知仍可能改变目标或取消运行，因此在写每条 goal user/message 前再次校验当时的下一轮条件。

若 claim 后失效：

- 不写被拒绝的 goal user/message，不启动包含它的模型输入。
- 停止该批提交；已经发生的 inbox/turn/user 事件不删除、不重编号、不伪造回滚。
- 不对已经写入 user/message 的人类项重复写入同一原生事件。
- 能证明尚未提交的 reservation 按现有恢复契约保留；已提交或 uncertain 的项不自动重发。
- 已打开 turn 的收尾遵守既有日志完整性契约；不能因关闭失败继续向模型发送输入。

计划阶段须把“已 claim、已登记、已 submitted”的分界映射到现有 ledger 和收尾代码；不能将它们合并成一个 sent 标记。本 spec 不授权用成功 receipt 代替实际消费证据。

### 6.4 运行中写入口

任何运行中写 user/message 的路径都不能绕过 goal source 格式与目标准入边界。若遇到自动 goal 项，必须在该项进入模型提交路径之前拒绝不受支持的运行中自动轮次投递；不能先提交模型再以日志拒写作为守卫。

拒绝这样的自动项不改变同批普通 steer/inject 的既有交付语义；重新准备后只交付可支持的项。不得新增一个自动 round 来扩充 currentTurnContext 或获得人类权限。

## 7. 取消、恢复及宿主协调

- keepInbox 保留可恢复待办，不保证收回 Claude 已收到的内容，也不等于目标 armed。
- 重新开始 drive 时，goal 项必须重新通过本 spec 的准入；不得使用上一 epoch 的成功判定。
- 非 goal 输入继续按既有 querying 意图决定是否可独立成回合，不新增 human-only source 过滤。
- 纯 inject 保持非唤醒；过滤掉 goal 后不得将 inject 升格成 querying 输入。
- 通过 inbox 契约拒绝旧预留可能触发宿主暂停目标。尊重暂停，不自动 resume/disarm、补发 round 或修改 roundsStarted。
- goal 读取失败不写 durable blocked，不猜 id/revision，不修正式日志。
- 同一失败自动项不能靠 finally 的 keepInbox/wakeRequested 反复自唤醒。失败期间自动准入保持停止；新的人类输入仍应可处理，不能永久卡在失败自动项之后。
- 自动项仅在后续明确的宿主/人类操作触发重新评估且公开 view 可读取、满足准入时恢复处理；不增加定时重试或新的自动驱动。读取成功本身不调用 resume。
- 判定拒绝、读取错误或取消不会被报告成已通过完整 native reservation 校验。

## 8. 错误与可观测性

诊断区分 source-invalid、multiple-goal-inputs、goal-mismatch、goal-inactive、goal-disarmed、round-mismatch、round-limit、goal-read-failed、lifecycle-ended 和 unsupported-active-goal-input 等原因。

诊断仅保留必要身份、轮次与失败阶段；不复制目标正文、消息正文、图片、认证信息或整份 goal view。没有当前目标与投影错误不得共享同一个“无目标”结论。

本会话已出现 event 9934 的 goal replay 失败。它只能证明宿主拒绝了当时的历史状态/事件组合，不能证明本 spec 所针对的缺失守卫就是该事件的根因。本阶段不读取或修复正式日志，也不宣称修复该历史错误。

## 9. 验收矩阵

先执行离线回归，使用生产驱动/inbox/ledger 与可控依赖；可控依赖测试不得称为真实 CLI 或 UI 端到端验证。

| 场景 | 必须观察到的结果 |
|---|---|
| 合法当前 active/armed 下一轮 | 只登记一次自动 user/message；宿主轮数只推进一次 |
| 旧 id/revision、重复轮次、跳轮、超上限 | 无自动 user/message、无模型提交、无轮数推进 |
| 无目标、paused/completed/blocked、disarmed | 拒绝自动项；不自动恢复目标 |
| round 0/负数/非整数、非法引用、多个 goal 项 | 在原生 user/message 前拒绝；不任取第一条放行 |
| 图片准备/resolveClaude 等待期间 edit/pause/disarm | 后置校验捕获变化；旧正文不进入模型 |
| 准备期间替换/删除消息或新增 steer | 不删除替代对象；不提交与当前批次不一致的 prompt |
| goal + human/steer/inject | 仅拒绝自动项；其它内容、来源、顺序和 querying 意图保留 |
| 剔除 goal 后只剩 inject | 保持 pending；不启动模型回合 |
| claim、turn/start 或前序 user/message 监听器同步重入 | 失效 goal 不写入；不启动旧批次；合法收尾且可恢复 |
| 运行中 next-step 出现自动 goal | 提交模型前拒绝不支持的自动项；普通输入无旁路损失 |
| cancel keepInbox 后仍有合法/失效 goal | 恢复时重新准入；取消判定不跨 epoch 复用 |
| goal view 读取抛错 | 区分错误与无目标；无自动提交、无忙循环；人类输入可处理 |
| 原生日志或私有账本写入失败 | fail closed；无模型提交、无伪造成功、无重复外部副作用 |
| submitted/uncertain 恢复 | 不自动重投，继续保留现有消费证据边界 |
| 无 goal 的普通 followup/steer/inject | 保持既有语义，不强制依赖 goal 读取成功 |

运行完整 pnpm test，并对合成或隔离会话执行原生 v4 日志验证/重放。真实宿主生命周期、暂停效果和 Claude 消费行为需要另行批准的隔离验收；离线测试不替代这些证据。

## 10. 不在本阶段内

- 完整 private reservation provenance/stale/content/fiber 校验与 startsRequestSeries 等价。
- 宿主新增公开 admission API。
- 当前正式 event 9934 故障的根因调查、修复或历史重写。
- mod goal mutation/失效矩阵、live inject 验收、spawn EINVAL 根因。
- 子代理第二行显示契约、累计用量 UI 验收、continuable child。
- 完整最终系统提示词获取与原生 surface 投影。
- present/jobs 桥重新实现、其它工具桥、OS sandbox 或其它 parity 子项目。

## 11. 源码依据与审批

本机 DSH 0.2.0-rc.2 的已提取源码已在只读调查中与安装 archive 字节核对。提取路径只用于诊断，不作为产品运行时依赖：

- `.dsh-diag/goal-src/goal_index.js:163`：goal source 格式。
- `.dsh-diag/goal-src/goal_index.js:270`：user/message 驱动的严格 round fold。
- `.dsh-diag/goal-src/goal_index.js:611`、`:622`、`:767`、`:880`：公开 view、disarm、live identity 与 activation。
- `.dsh-diag/goal-src/driver_index.js:55`、`:94`、`:132`、`:274`：私有 attempt、恢复、预留及完整 native fence。
- `lib/agent.mjs:218`、`:282`、`:355`：初始准入、运行中写入口与恢复唤醒。
- `lib/inbox.mjs:112`、`:118`、`:157`、`:185`：快照、consume、移除与通知。
- `lib/goal-domain.mjs:78`：已开放回合内的工具权限；不是下一轮 admission。

相关既有文档：`2026-10-13-agent-pre-step-design.md` 和 `2026-10-12-claude-code-goal-mode-design.md`。本文收窄旧文档对“公开字段校验等价 native fence”的理解，不用旧批准替代本阶段审批。

审批顺序：对话设计确认 → 本书面 spec 审阅 → 书面实施计划审阅并确认执行方式 → TDD 实施 → 分层验证。当前停在书面 spec 审阅；不自动进入下一阶段，不自动 commit/push。
