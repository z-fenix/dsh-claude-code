# Mods runtime bridge：P1 剩余项、P2 与 P3

状态：用户会话 goal 已授权按设计连续实施；不重复等待阶段许可。与 `2026-10-16-native-compact-mod-design.md` 的只读、安全、预算边界共同生效。

## 目标与范围

沿用 authenticated loopback bridge，把 CLI 内部事件和逐请求控制接到现有 Engine。P1 补 Plan 与原生工具生命周期；P2 补原生上下文/命令/技能元数据、精确子代理身份和审计工具的动态 Mod transport；P3 补主循环模型/effort 的运行中选择。DSH 仍拥有目标、输入台账、会话日志与审批权威；SDK 转发仍独占 transcript 投影。

不开放任意 DSH 工具，不修改宿主，不派发整个 `agent/pre-step`，不以类型存在代替 SDK/headless 实测，不运行未授权的付费模型验收。

## 已核实契约

- 安装的 DSH 0.2.0-rc.2（只读提取 `app.asar`）确认命令支持 agent scope shadow；Plan 服务 `get(agent)` 返回 `{active,pending?}`，pending 是目标布尔值；事件是 `plan/mode {active}`，policy 名 `plan:policy`。
- Plan 服务在 open turn 中将用户切换排队，原来依赖原生 pre-step 提交。本插件在真实主 CLI step 准入时只提交用户选定的 Plan 状态，不运行其他 pre-step 监听器。
- CLI Mod `prompt.attachment` 的 engine-authored `plan_mode` / `plan_mode_reentry` detail 提供固定的主循环 planFilePath。ExitPlanMode 入参本身不含 plan；不猜测不存在的 SDK getPlan 方法。
- `turn.step` 是 async generator，只有 model/effort 可改写，agentId 由引擎固定；子循环不得继承主循环的选择覆盖。
- `$.session.usage({breakdown:"summary"})` 是本地估算；不默认用 full/token-count API。CommandInfo 不区分 prompt skill 与其他 plugin command；技能名单以 SDK `reloadSkills()` 的 skills 为准。
- SDK 0.3.220 支持 setPermissionMode、setModel、applyFlagSettings、supportedCommands、reloadSkills，以及包含 SDK server 的 setMcpServers。后者会替换动态集合，不能拿来清空不属于本插件的服务器。

## P1：Plan

1. query 起点读取 host Plan（pending ?? active），映射为 SDK plan mode；非 plan 时恢复原 sandbox/approval 派生 mode，保留所有既有只读拒绝。
2. 在主循环、engine-authored 的 `prompt.attachment: plan_mode` reminder 后附加受限 policy，翻译 DSH 工具名为 CLI 对应名；不向 child reminder 注入主策略。实际 CLI 证明 cached/unattributed 的 prompt.compose 不能可靠承载动态选择，故它继续仅观察。投递输入前先同步 native mode，确保首个请求生成正确 reminder。不复制工具目录、工作区指令或运行时沙箱宣称；读状态失败不得当成 inactive。
3. 每个主 turn.step 准入时重读 Plan，提交真实用户待生效选择并同步 SDK mode。只写真实已选择状态的 `plan/mode`，不伪造计划审批。子 step 只观察，不改变主模式。
4. Enter/ExitPlanMode 不再走普通 Full access/no-prompt 短路。Mod 先获得主循环调用身份；Exit 读取 engine detail 指定的实际 plan 文件，必须非空、以 # 标题开头，并通过 DSH userQuestions 的 plan-review intent 审批。缺路径/服务、拒绝、取消或文件变化都保持规划。
5. 审批只产生同 tool-use ID 的一次许可；真实 CLI 工具成功后才调用 host planMode.set。下一真实 step 提交 pending。没有 Mod 计划桥时拒绝不受同步的 native Enter/Exit，用户仍可用 DSH /plan。

## P1：工具生命周期

- 保留 canUseTool + SDK PreToolUse 的既有双入口只读策略。
- Mod tool.call 做执行前检查与执行后元数据观察；tool.check 仅追加当前只读拒绝，不把原生 deny 改 allow。
- 文件工具使用原有 host pre-execute，按真实 tool-use ID 缓存以免 Mod 和 canUseTool 重复派发。宿主明确 ask 仍必须问人，即使 Full access；成功审批仅对该次、该参数调用生效。
- Mod 路径允许把宿主改写过的参数交回 CLI schema 验证，保留工具名/id/agent 归属，不提供 registry token、deferContext 或 concludeTurn 的假实现。
- 子工具继承只读策略，但不借父 scope 派发宿主文件执行事件。MCP/DSH 桥工具不重复进入原生 gate。
- 只记录工具名、身份、状态、用量/字数等有界元数据；结果正文仍由已有 SDK tracer 负责。执行后失败不冒充“未执行”。

## P2：元数据与身份

- 在 Mod 注册原生 agent.spawn、turn.step、turn.complete、session.append 观察；append 只累计已接受的非 queue 行数，不对每行发 RPC、不传正文。
- native agent ID + tool_use ID + parent native ID 绑定现有 SubagentSessionManager 子会话；提前到达的身份暂存，SDK 创建子投影后再补绑定。无可靠关联时保留 unknown，不默认归为 main，不新建第二份 transcript。维持 one-shot，不承诺续聊或独立取消。
- context 只采集 summary，明确 estimated；限制类别/目录条目数、字符串长度和 JSON 字节，拒绝非法数字。私有事实与独立命令 `/claude-context` 展示最近观察，不注入 DSH 原生 contextBreakdown。
- `/claude-commands` 展示 CLI command 与真正 skill 的最近目录。`/claude-command` 只支持固定只读 builtin status/cost，通过维护通道执行；不提供任意后台命令运行。
- `/claude-skill <name> [args]` 只接受 `mods.skills.allowed` 精确配置且最近 SDK skills 名单包含的名称，作为用户明确请求投递到普通输入管线；不在维护 query 内偷偷启动模型，不假称接通 DSH skill 工具。默认 allowed=[]，DSH 工具白名单不变。

## P2：动态工具

- `dshTools.transport` 支持 mcp/mod/auto，默认 mcp；只有显式选择且 Mod 已就绪时使用 mod，一次 query 不重复广告两套相同工具。
- 动态定义只能来自现有 present/job_list/job_output/job_kill 子集，尊重 wireSchemas/PTC 和每次调用的真实可见性。主轨迹仍须确认同 tool-use ID 与精确模型工具名；子代理不能借父工具桥执行。
- Mod 在后续请求边界刷新定义，新增/更新通过 tool.register。没有 unregister 时撤销执行许可并拒绝旧定义，不能宣称从 CLI schema 中物理删除。
- 直接 Mod RPC 同样验证当前完整 JSON Schema 并走 registry.execute，不调用裸 handler。MCP 回退、已有 handlers、in-flight 归属及其他服务器不受破坏。

## P3：逐 step 模型选择

- 每个主 step 从会话重读最新有效 model/selection；无显式选择时使用现有 host 默认值，不从本插件历史 request/header 固化模型。
- 只在用户选择发生变化时调用 SDK setModel/applyFlagSettings，使后续 step 持续使用新选择；当前 step 通过 Mod 的 model/effort 改写同步。没有变化时不压过 CLI 自己的 fallback，也不动子代理独立模型。
- 档位只接受 low/medium/high/xhigh/max。清除 effort 使用 SDK flag-layer null，不猜测 budget。控制失败必须在请求发出前停止/报错，不能按旧模型悄悄计费。

## 协议、失败和预算

normal 模式只增加固定 runtime 方法，每个方法独立严格 schema 和主/子归属限制；维护模式不因此获得 normal 权限。已关闭 query、旧 epoch、非原 agent 或取消信号全部拒绝。策略/工具 gate 失败关闭；非权威观察失败只关闭该观察并告警，不重放 next 或伪造模型结果。

所有新事实经 PluginFacts fsync/anchor，新增类型显式准入。协议不转发 bearer、完整消息、thinking、工具结果或任意宿主调用。Plan 正文仅为明确的计划审阅传给本机 userQuestions，不写私有观察日志。元数据有界；溢出明确标记或拒绝，不将缺数据冒充 0。

验收：每个行为 TDD RED→GREEN，完整 Node 测试、原生 Mod validate/test、实际 CLI 的零推理控制探针、语法和 package dry-run。真实付费生成、摘要和正式桌面/v4 生命周期验收未授权，不会运行或宣称完成。
