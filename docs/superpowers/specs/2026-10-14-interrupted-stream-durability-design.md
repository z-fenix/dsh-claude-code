# 中断流式内容持久化设计

日期：2026-10-14
状态：书面 spec/plan 已获批准；2026-10-15 完成初始离线实施和独立审查。首次隔离真实 UI 验收发现部分 block envelope 后文本丢失；按 RED 定点修复并完成离线回归后，用户授权再次真实 UI 复验，仍失败：中断消息 stream 有 2,955 个文本字符，但 message.content 为空，刷新不能重放；正常回复对照通过。用户要求“重新 复验真实 UI”，第二次独立运行在同一构建上复现同一失败（stream 496 字符、body 为空），两次运行中断消息的 compact stream 都只含 block index 1 的 text-delta（无 index 0），仍属可复现症状而非已证原因。验证及范围记录见本项目账本和 `.dsh-diag/stream-durability-reaccept-2-2026-10-15/acceptance.md`。之后用真实 UI 复验的客户端 transcript 定位到根因（`redacted_thinking` 占位块）并完成定点修复与离线回归（464/464）；修复后的第三次隔离真实 UI 复验已通过（中断消息 stream 与 body 均 1,613 字符、刷新后可重放，控制回复正常）。未提交。

## 目的与成功标准

用户希望继续补齐 Claude Code 模式相对 DSH standard 的剩余能力差距。本子项目处理一个独立问题：文本/reasoning 分片已经实时显示，但查询在完整 `assistant` envelope 到达前结束时，内容不能在重开会话后重放。

成功标准：在限定的纯文本/reasoning attempt 中，取消、异常或 EOF 后保存实际观察到的有效安全前缀；关闭实时 attempt 恰好一次；不把持久化成功解释为模型成功完成、输入已消费或 goal 权威增加。正常完整响应保持既有行为。

## 全局约束

- 不修改 DSH app.asar，不安装全局 Claude 插件，不自动 commit/push，不运行未经批准的收费推理。
- 普通 followup 排队；steer 在安全边界插入；inject 不自己启动新的人类回合；显式 cancel 停止当前生成，keepInbox 保留待办。
- mod 未支持时保留 MCP；同一查询不重复暴露 goal 工具。
- 系统提示词快照不冒充最终全文，不向 request/header 写 system。
- 子代理继续保持 one-shot；不伪造用量，不重写历史标题。
- 保留当前 dirty main 工作区及既有桥接/goal guard 改动；不 reset、stash、自动 stage 或创建 worktree。
- 不读写正式业务日志、正式 profile、认证信息或宿主 archive；不修复历史事件，包括正式 event 9934。
- 使用现有 Node/依赖版本，不新增产品依赖。本次无需改 SDK 接口或加载 mod。
- 离线测试成功不等于真实 Claude、宿主生命周期或 UI 验收成功。

## 已确认的现状

`lib/claude-run.mjs` 中，`StreamAttempt` 已同时积累持久 stream、组装 blocks 和发布实时增量帧。

- `blocks()` 可提供未闭合文本的安全前缀。
- `settle(blocks)` 写 `assistant/message` 后发布 committed 终帧；写入异常发布 abandoned 并重新抛出。
- `ClaudeRunTracer.#settlePending()` 只处理已经收到完整 assistant envelope 的内容。
- `finish()` 调用上述结算后关闭 step；`#closeStep()` 丢弃 attempt。
- `#onResult()` 也会关闭 step，因此不能仅在 `finish()` 添加兜底。

所以，没有 envelope 的纯文本/reasoning 分片在 step 关闭时没有持久化路径。根因最初来自源码检查；实施阶段的 RED→GREEN 回归和离线重建已验证本设计的限定行为，证据保留在本项目执行账本。

## 方案选择

采用现有 tracer 中的安全前缀收尾，不引入第二套私有内容存储或新的 UI/宿主接口。原生 `assistant/message` 保存可重放内容，现有实时 end 帧标明本地持久化结果。

另一方案是私有中断快照加独立展示，需新的读取和展示契约，不能解决现有原生轨迹重放而不扩大范围，因此不采用。

## 范围

包含：

1. 当前 attempt 没有完整 envelope，且有效内容仅为 text/reasoning 时的收尾。
2. `finish()`（EOF、异常、取消共享的 tracer 收尾）及 `result` 关闭 step 的兜底。
3. 空 attempt、含工具片段的 attempt 和 append 拒绝时的终帧收尾。
4. 正常 envelope 优先、幂等收尾、真实 Session 重建和关系校验。
5. 事件映射文档明确区分观察前缀与成功响应。

不包含：

- retries、supersedes、缺失 envelope 的多个 response id 边界重构；不声称支持这些新语义。
- 图片、工具结果附件、截断工具参数恢复或 stream-only 工具调用持久化。
- 新的 usage 估算、补造成功工具结果、输入消费证据或 goal 状态。
- 输入控制器、goal guard、子代理生命周期、mod 或宿主 UI 重构。
- 正式日志修复、spawn EINVAL、真实模型/桌面验收。

## 组件与数据流

### StreamAttempt

继续拥有 stream 累积器、block assembler 和单次 terminal 状态。沿用 `settle()` 作为唯一的 committed 路径。

增加一个幂等的 abandoned 收尾入口，供没有可持久化内容的 attempt 关闭实时帧；已经 terminal 时无副作用。复用同一 terminal 状态，不能出现 committed 后再 abandoned，或失败后再次尝试提交。

资格判定同时检查观察到的内容种类与累积器接受的内容：

- 仅持久化非空、有效 text/reasoning 前缀；不能用过滤工具块的方式把混合 attempt 当纯文本。
- 任意工具片段（包括只有 start、空参数、未完成 JSON）都使本次前缀兜底不适用。
- 被累积器拒绝的分片不能成为持久内容，也不能让被拒绝的工具片段漏过混合流排除条件。
- usage 分片不是正文；usage-only/空块不生成空助手消息。

### ClaudeRunTracer

优先结算已有 pending envelope，保持其 content、usage 优先级、工具 advertisement/call/result 和任务表投影逻辑不变。

在丢弃当前 attempt 前执行单一收尾操作：

1. 已 terminal：不操作。
2. 有尚未结算的完整 envelope：走现有 pending 路径。
3. 没有 envelope、符合纯文本/reasoning 资格且存在非空安全前缀：使用既有 appender 和 `settle()` 保存。
4. 空或不符合范围：abandon 实时 attempt，不生成新的助手消息或工具事件。

前缀保存与正常消息共用 `assistant/message` 的 turn/step/source/stream 与 surfaceOp 契约。不得再推完整文本作为 live chunk，否则用户会看到重复内容。

若前缀写入成功，end 帧的 committed 只说明已存在可引用的 `assistant/message` seq，不修改回合结束原因。若已有实际 message_delta usage，可按既有 attempt 记录保存；没有 usage 就保持缺失，不从文本长度估算，不借此次收尾新增 result 用量分配规则。

## 故障与幂等

- `assistant/message` append 失败：abandoned 恰好一次，`logIntact=false`，沿用既有关闭 step 和上层 turn/end 防线。不重试、不补造 tool/call。
- 完整 pending append 失败后，不能再以其 stream 前缀第二次提交。
- `finish()` 重复调用、`result` 后再 `finish()`、晚到 envelope（tracer 已 ended）：不得重复持久化或重复终帧。
- 空/混合流 abandoned 本身不是落盘失败，不应仅因此设置 `logIntact=false`。
- 保持既有未决工具调用在 step 关闭前的 interrupted 错误配对；此次不修改该行为，不把它描述为工具成功。
- 保持既有实时发布器异常处理策略；不扩大为全局 stream 错误恢复项目。

## 预期文件职责

- 修改 `lib/claude-run.mjs`：attempt 终态与 tracer 关闭边界的最小扩展。
- 修改 `test/claude-run.test.mjs`：真实 tracer 输入/输出回归，不只断言 mock 调用次数。
- 修改 `test/session-compatibility.test.mjs`：生产 tracer 配真实 npm Session 的合成日志和重建验证，私有存储不得落到默认用户目录。
- 修改 `docs/reference/event-mapping.md`：stream-only 前缀、范围及 committed 语义。
- 实施计划及专属执行证据使用新的本项目目录，不修改之前已完成 goal 项目的账本。

## 验收

### 必须先 RED 后 GREEN 的行为

1. text/thinking deltas，无 assistant envelope，`finish()` 后存在唯一的前缀消息、step 已收尾、唯一 committed 终帧引用正确 seq。
2. 同样输入后 `result`，再 `finish()`：内容仍在，且不重复。
3. 只有空块或 usage：无空助手消息，但有唯一 abandoned 终帧。
4. 工具 start/partial JSON 与文本混合：不保存伪纯文本、不生成工具调用，唯一 abandoned 终帧。
5. 前缀 append 拒绝：无 committed，唯一 abandoned，logIntact=false；重复收尾不重复写入。

### 必须保留的回归

- 正常流式 envelope 与非流式 envelope 的 content 不变、无双重渲染。
- 已有 message_delta / assistant / result 用量优先级不变，缺失用量仍缺失。
- 已提交 attempt 的重复 finish 无新消息/终帧；完整 envelope 写失败不走第二次前缀提交。
- 正常工具 advertisement、并行调用、早到结果和 interrupted 配对不变。
- 合成 Session 的 native event 类型合法、turn/step/assistant 关系合法，重建后前缀正文和 stream 可读取。

### 验证层与完成条件

运行 targeted tracer/session 测试及完整 `pnpm test`，检查修改源码语法和 `git diff --check`。复用已安装 npm Session/公开格式能力做离线关系验证，不加载 app.asar 或另行获取宿主源码；若现有依赖不提供足够校验入口，实施计划需明确使用已存在的本地测试辅助接口及其证据边界，不能把 Session.create 冒充完整安装版格式校验。

执行方式建议沿用 Native：主会话逐项 TDD，最后一次 fresh-context 独立审查，Critical/Important 一轮 RED→GREEN 修复并运行完整 suite。需在用户审阅实施计划时确认。本 spec 的批准不自动批准尚未编写的实施计划。

本项目完成不代表所有 standard parity 完成，也不代表混合/工具流、真实中断 UI、历史坏日志或最终系统提示词已解决。

## 隔离 live RED 的后续修复 — 2026-10-15

用户在真实隔离测试失败后明确要求“按测试红进行修复”。诊断确认：SDK 可以在完整响应结束前先发送
thinking block 的 assistant envelope；原来的 pending 结算会使 attempt terminal，从而丢掉之后
只有 delta、还没有 envelope 的文本。原验收失败证据保留，不改写历史消息。

本次定点修复扩展 pending 收尾：只对可按位置和种类对齐的纯 text/reasoning 响应，保留已完成
block 的 envelope 正文，补上未被 envelope 覆盖的非空 stream 尾部；对齐前不丢空块。stream
index 必须从 0 连续按序，混合、无效、未知或无法对齐的数据仍不猜测恢复。没有补尾部的完整响应
保持既有结算行为。部分响应不新增 result 总用量分配，也不补推 live 文本。

有可补尾部的 pending 在 message_stop 不提前结算，允许迟到 envelope 覆盖对应位置；在最终
finish/result/下一响应 message_start 边界才补存。由新 assistant envelope 触发的旧消息结算不补尾部，
避免将新 envelope 已完成的文本保存两次；无有效 id 的旧协议继续逐消息处理。空 text/thinking start
仅记录组装位置，包含 signature-only 空 thinking，不解析 start 中的非空正文或伪造 live delta。
非法 start index 或 start/delta 种类冲突排除前缀恢复。沿用单一终态与拒写防线，未增加产品依赖或更改工具生命周期。
永久回归覆盖取消/错误后的真实 npm Session 重建；离线通过不等于修复后真实 UI 已通过。

## 真实 UI 复验根因与定点修复 — 2026-10-15

用户要求“进行修复”。用真实 UI 复验的客户端 transcript（只读取结构字段，不导出正文）定位到两次
复验同一形状的原因：端点在中断响应里先发一个 `redacted_thinking` 占位块（stream index 0），
可见文本落在 index 1。原实现对没映射的块调用 `excludePrefix()`，永久关闭安全前缀；同时
`withInterruptedTail` 要求 stream index 从 0 连续，于是一个只有该占位块 envelope 的收尾写成空
`message.content`，而 compact stream 里仍有已显示的文本。

修复（三处最小改动，均在 `lib/claude-run.mjs`）：

1. 新增占位块判定：`redacted_thinking` 既不是未知块（不表示混合流或对齐失败），也不写成
   reasoning（内容是密文，不落盘）。
2. `content_block_start` 对占位块只登记 stream 位置（复用 startBlock 空槽机制），不排除前缀；
   `assistant` 的 unmapped 判定忽略占位块。真正未知的块（如 `image`）仍排除前缀。
3. `withInterruptedTail` 在 envelope 没有提供任何可持久化块时直接返回已观察到的合格非空前缀：
   没有位置需要猜测，index 不从 0 连续不构成拒绝理由。

永久回归：tracer 三个收尾边界（finish/error-result/success-result）的占位块形状、占位块 start
形状、真正未知块仍排除；真实 npm Session 的取消重建（带/不带占位块 start 两种）验证正文、
`deriveMessages`、compact stream 与「密文不进日志」。完整 `pnpm test` 464/464。

修复后的第三次隔离真实 UI 复验通过（`session-0ab0033f-65d1-47bc-9a9e-7a50c8e4adf3`）：中断消息
seq 12 的 stream 1,613 字符与 body 1,613 字符一致、body 只有 text；刷新后可见文本逐字相同
（30 项 / 1,443 字符 / 哈希一致）；控制回复精确匹配、用量真实；中断消息无 usage；两次刷新窗口
零 console 错误。紧凑 stream 仍是 index 1 的 text-delta（与前两次失败形状相同），说明修复点正是
该形状的处理，而不是形状本身改变了。证据与范围见 `.dsh-diag/stream-durability-reaccept-3-2026-10-15/acceptance.md`。
