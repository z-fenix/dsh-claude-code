# Mods 能力桥第一阶段：原生 compact

状态：用户已通过会话 goal 确认连续实现 P1–P3；P1.1 已进入实现。离线测试与零推理探针不等于付费摘要或桌面实机验收。

## 1. 目标、范围与阶段

用户已同意按 Mods 适配路线推进。路线涉及多个独立子系统，按可独立验收的增量实施：

1. P1.1：本设计——让 Claude Code 预设的 `/compact` 作用于该会话真正的 CLI 上下文。
2. 后续 P1：Plan 提示词与状态桥、原生工具生命周期；保留既有只读双入口防护。
3. 后续 P2：子代理内部事件、上下文原生分项采集、经逐项授权的命令/Skills/工具桥。
4. 后续 P3：逐 step 模型与 effort 控制。

后续增量各自设计、实施、验收，不在本次 compact 改动中顺带开放接口。目标不是把整个 Engine 搬进 Mod，也不是宣称与 standard 循环完全等价。

本次成功标准：用户在一个有可续接 Claude 历史、当前空闲的 Claude Code 会话执行 `/compact`，插件在独占维护窗口内通过 `$.command.run({ command: "compact" })` 进入 CLI 原生压缩，并由独立观察 Mod 的 `session.compact` 结果确认完成；只有收到可信的完成结果才显示成功。不得发送伪造的用户消息、借用宿主摘要 LLM，或把 DSH 显示面的 shadow 当成 CLI 压缩。

## 2. 已核实的接缝

- 现有 `mods/dsh-bridge/hooks/bridge.mjs` 已通过本地 plugin 加载，负责握手、prompt compose 观察和精确 goal 工具。不是重新引入 Mods。
- `lib/mod-host.mjs` 现有 RPC 用本机 loopback、一次运行的 token、session/agent/epoch/Claude session 身份和请求去重保护；`live()` 仅接受 running agent。
- `ClaudeCodeAgent.runMaintenance` 提供回合之外的独占维护入口；维护期不能通过把 agent 假改为 running 来绕过上述运行边界。
- 一个 DSH 回合会新建 CLI query，结束后关闭。单次 query 的第一个 result 也不保证 CLI 已真正空闲，不能在那里插入压缩。
- 原生 DSH `/compact` 直接调用宿主 `compaction.compactNow()`。Claude Code 预设已经在 agent scope 装了同名命令，同 scope 再注册会冲突；其他预设的命令必须保留。命令注册细节来自相邻 `deepseek-harness` 工作区源码，实施前必须对照实际安装版本的公开接口确认，不能把相邻源码当作已安装宿主的证明。
- 当前 CLI 2.1.301 导出 `$.session.compact({ instructions? })`；它只在回合间可调用。类型存在不证明 resume 初始化中的调用时序已经通过真实 CLI 验收。

源码依据：`lib/mod-options.mjs`、`lib/mod-host.mjs`、`lib/agent.mjs`、`lib/claude-run.mjs`、`mods/dsh-bridge/hooks/bridge.mjs`。旧接口调查见 `2026-10-13-claude-compaction-design.md`，其中“无法触发”的结论仅适用于当时没有 Mods compact 的通道。

## 3. 方案选择

采用：**预设专用命令 + 独占维护运行 + 现有 Mod 的受限维护协议**。

不采用：

- 把 `/compact` 当普通 SDK 用户消息发送：不是可靠的原生命令通道，还会污染输入与回合语义。
- 替换全局 `compaction` 服务或修改宿主依赖：影响 standard 会话，也没有解决 CLI 实际上下文所有权问题。
- 在每个普通回合结束时顺便 compact：会引入未请求的模型开销，而且 result 不等于安全维护窗口。

## 4. 用户可见行为

- 只替换 Claude Code 预设中的 compact 命令提供者；standard 和其他预设不变。新增模块使用本包显式 export，由 preset 声明装载，不能同 scope 重复注册。
- 按实际 agent 能力分流，不只看预设名：`routeMainLoop:false` 或路由覆盖使该预设承载真正原生 agent 时，保留原生命令调用宿主 compaction 的语义；实际是 ClaudeCodeAgent 时只走 `compactNative`，即使 Mods 不支持也不能静默回退宿主压缩。
- 命令仍是 `/compact`。本阶段只支持原命令的无参手动操作，不新增模型可调用的压缩工具、自动压缩策略或额外 UI。
- 会话正忙、维护已被占用、没有该会话自己的可续接 Claude session、Mods 不可用或 CLI 不支持时，命令明确报不可执行，不悄悄排到下一轮，不回退到宿主摘要。
- `persistSession: false`、尚未建立自己的 Claude 历史的会话、只有尚未物化的 fork 父会话提示时拒绝维护。不得为压缩创建一个与当前历史无关的新 Claude 会话，更不得改写 fork 父会话。
- 已经完成的压缩才显示成功。原生 skip 显示未执行及脱敏理由；失败、取消或超时不显示成功。
- 压缩本身可能产生摘要模型费用，只在用户明确执行命令时触发；不因加载插件或新建会话而自动调用。

## 5. 维护生命周期

1. 命令核对调用者与当前 Claude Code agent，取得 `runMaintenance` 独占窗口；它必须与普通输入、另一条维护操作互斥。
2. 读取当前会话已持久化且归属于本会话的 Claude session ID，铸造独立 `operationId` 和有界维护租约。
3. 启动专用 streaming query，resume 精确 Claude session；保持输入通道未投递状态，不 claim、submit 或消费任何用户/goal 输入。
4. Mod 在会话就绪后握手。宿主核对实际 Claude session ID，并仅广告本次维护操作，不广告 goal 或 DSH 工具，不开启 prompt 正文采集。
5. Mod 先向宿主取得该操作的一次性执行许可，再通过原生命令队列执行 `$.command.run({ command: "compact" })`。独立的 compact observer 包裹真实 `session.compact` 结果，用观察专属 bearer token 报告结构化统计或 skip；driver 读取该凭据并完成操作。不得用本地命令文案推断成功，也不得让自动重载或重复握手再次取得执行许可。
6. Mod 回报最小完成凭据。宿主记录终态，正常关闭输入通道、排空并关闭 query，最后释放租约。
7. 任何失败路径都取消仍在运行的 CLI、关闭桥、回收 waiter/timer/abort listener 并释放维护窗口；恢复 idle 后才能接收后续输入。

维护总等待默认上限为 5 分钟。摘要不在现有 5 秒 HTTP 方法回调内执行：RPC 只负责快速领取操作与回报结果，原生摘要在 Mod 侧单独等待。超时必须中断维护 query，不能留下后台摘要继续写同一 transcript。

### 必须先通过的运行时门槛

`session.start` 是否已加载 resume transcript、且允许在不投递用户 prompt 的前提下进入原生 compact，必须用所选 CLI 的真实运行验证，不能用 mock 或类型签名替代。**2026-10-16 已完成零推理门槛验证（CLI 2.1.301）**：直接 `$.session.compact()` 明确报 SDK/headless 不支持；`$.command.run({ command: "compact" })` 则在零 SDK 用户输入下进入含两条 fixture 历史的 manual compact。独立 observer 成功回报结构化 skip 凭据，API 请求数为 0，证据位于 `.dsh-diag/native-startup-h8308X/result.json`。探针在 summarizer 之前截断，不证明真实摘要、重启持久化或正式桌面验收通过；后者仍需单独费用授权。

## 6. RPC 与授权边界

维护模式是宿主创建桥时确定的状态，不能由请求体选择。普通 turn 桥现有行为保持兼容。

- 普通 turn 模式继续只接受原有主查询的 goal/prompt 请求；不全局放宽 `live()` 或 `callerAgentId`。
- compact 维护模式只接受握手、一次性领取、结果读取、观察回报和完成回报；driver 与 observer 使用不同令牌，driver 不能提交观察，observer 不能领取/完成操作。拒绝所有 goal、通用工具、prompt 正文和子代理请求。
- 每次核对 token、session、agent 对象、operation/epoch、Claude session ID、主循环身份、租约状态和取消信号。
- 沿用现有拒绝 browser Origin、限制 Host/路径/body 字节、严格 schema、请求超时及去重的约束；token 只留在当前子进程环境，不能进日志、命令输出或持久化状态。
- operation 状态显式区分 pending、claimed、succeeded、skipped、failed、uncertain。网络重试沿用同 request ID；同 ID 不同参数拒绝。
- 已领取操作只允许执行一次。重复握手/模块重载读到 claimed 时不得再次 compact；终态重放返回原结果，不重复副作用。
- 在执行许可发出后失去可信结果时记 uncertain，不自动重试，不回退到其他压缩实现。取消/报错也不能承诺 CLI transcript 一定没有变化。

## 7. 日志与结果

- 使用 `claude-code/*` 私有、可忽略事实记录维护意图与终态，并关联 operation、命令和 Claude session；不伪造 DSH `turn/start/end`、`step/start`、原生 checkpoint 或 `compaction` 事件。
- 真实 CLI 上报的 compact 状态和 boundary 可按既有私有事实路径记录；没有上报时不能自行合成原生 boundary。
- 完成回报只传必要统计与状态，不传整份 transcript、系统提示、摘要正文或凭据。`tokensBefore/tokensAfter` 缺失保持缺失，不写 0，也不把估算说成精确测量。
- 默认不向 DSH 原生 contextBreakdown 注入数据，不 shadow DSH 历史。命令输出明确说明压缩的是 Claude 上下文，DSH 完整轨迹仍保留。
- 维护失败不得清空原有 resume ID 或自动新建会话；不改变 Goal 的权威状态、输入台账、CAS、暂停/恢复和 uncertain 不重投规则。

## 8. 模块边界

- 新增 preset 专用 compact 命令模块：只负责命令准入、调用维护操作和输出结果。
- 新增原生 compact runner：负责 SDK query、resume、维护租约、等待及清理；不继续扩大普通 `runClaudeCode` 主流程。
- `lib/mod-host.mjs`：以明确模式和严格方法表接入维护 RPC；普通 turn 安全策略保持不变。
- `mods/dsh-bridge`：将维护执行与现有 goal/prompt 观察分开，正常模式语义不变。
- `lib/agent.mjs`：复用维护互斥机制，不引入假回合或假 running 状态。
- `package.json`、`cordis.patch.yml`：只增加本包命令 export 并替换 Claude Code preset 对应行。
- 文档与测试同步更新。旧调查保留历史对象和日期，新增当前支持条件，不把未验收结果写成既成事实。

## 9. 验证与验收

### 离线、无推理费用

- TDD：命令 scoped 注册不冲突、其他预设不变；busy/缺历史/persistSession false/未物化 fork/Mods 不支持时明确拒绝。
- 维护 runner：精确 resume、零用户 prompt、零 inbox/goal 消费；成功/skip/报错/取消/超时均清理 query 和 bridge，串行维护不并发写 transcript。
- RPC：普通与维护模式隔离；错 session/agent/epoch/Claude ID/child/过期租约均拒绝；重复领取/模块重载不重复执行；令牌与异常详情不外泄。
- Mod 原生测试：compact 被调用一次，skip 与不完整结果不报成功；无 goal/DSH 工具广告；普通 goal 输出和 prompt 捕获回归不变。
- 用实际选定 CLI 运行 plugin validate/test，运行完整 Node 测试、syntax 与 diff 检查。

### 需单独确认预算的真实验收

仅用隔离 DSH_HOME、独立 fixture cwd 和专属 CLI session；不改正式 profile 或用户全局 Claude 配置。真实摘要会调用模型，因此未经用户明确确认验收预算，不启动付费回合。

验收必须证明：resume 历史在调用前已就绪；没有额外用户 prompt/推理回合；确实出现原生压缩结果并被持久化；再次 resume 仍使用同一会话且读到压缩后的历史；DSH 日志通过原生 v4 行与关系校验；清理后没有专属子进程、桥 listener 或维护锁残留。未完成此验收时，只报告离线测试结果，不声称功能已在真实 CLI 工作。

## 10. 本阶段明确不做

不改宿主源码或全局 compaction 服务；不新增自动压缩、不接通整个 `agent/pre-step`；不放宽 DSH 工具白名单；不搬迁 Goal 权威/持久化；不新增原生 UI；不顺带实现子代理续聊、动态 Skills 或逐 step 模型控制。
