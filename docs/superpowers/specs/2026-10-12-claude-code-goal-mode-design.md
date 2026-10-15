# Claude Code 会话的 goal 模式 — 设计

- 日期：2026-10-12
- 状态：已评审（对话内），待用户复核本文档
- 相关：`dsh-claude-code` 插件；DSH `@deepseek-ai/dsh-goal` / `dsh-goal-round-driver` / `dsh-command-goal` / `dsh-tool-goal`

## 1. 目标与范围

让**由 Claude Code CLI 驱动的会话**，也能像 DSH 标准模式一样使用持久化 goal：
用户在界面执行 `/goal <目标>` 后，会话在无人干预下**一轮轮自动推进**，直到 Claude
把目标标记为 complete / blocked，或轮数上限耗尽。

### 纳入范围

- 复用 host 平面已有的 goal 栈（goal 服务、round driver、`/goal` 命令、GoalBar）。
- 把模型侧 goal 工具 (`get_goal` / `create_goal` / `update_goal`) 桥接进 Claude Code。
- 给 Claude Code 追加 goal 策略提示。
- 配置开关，默认开。

### 不纳入范围（非目标）

- 不重写 goal 领域、不新增第二套 goal 状态、不新增独立的续跑驱动器。
- 不改变任何非 Claude Code 会话（原生循环）的行为。
- 不处理标准模式本身；`dsh-tool-goal` 的 complete/blocked 收尾 `deferContext` 原不在本设计内，
  已于 2026-10-15 作为对照修复补齐（见 §8.4）。
- 不修复与本特性无关的既有问题（例如 AskUserQuestion 在 bypass 下的既有修复，属独立改动）。

## 2. 背景与现状（决定设计的实测事实）

1. **goal 栈是引擎无关的，且本插件已接上大半。** goal 服务 `ctx.goals` 与
   `dsh-goal-round-driver` 都挂在 host 平面，对所有 agent 生效；它们只依赖 agent 的
   公开接口与事件：`followup()`、`inbox.nextTurn.nextStep.prepend()`、`status`、`session`、
   `agent/status`、`agent/created`、`agent/error`、`agent/disposed`、`agent/inbox/inserted|claimed|discarded`、
   `session/event`。`ClaudeCodeAgent`（`lib/agent.mjs`）与 `DshInbox`（`lib/inbox.mjs`）
   已实现这些，并通过 `ctx.agents.enter()` 正式注册。
2. **续跑轮次计数不依赖 `agent/pre-step`。** goal 服务是从**会话日志** fold `user/message`
   事件、看 `source.kind==="goal"` 且 `round === roundsStarted + 1` 来推进 `roundsStarted`
   （见 `dsh-goal` 的 `applyGoalEvent`）。`ClaudeCodeAgent.drive()` 已原样
   `session.append("user/message", message)`，故计数可对上。
3. **真正的缺口：模型工具不可见。** `get_goal`/`create_goal`/`update_goal` 是 DSH 的
   agent-scope 工具（`ctx.tools.register`），而 Claude Code 走 SDK 自带工具系统，看不到它们。
   后果：Claude 读不到 goal 的 `id`/`revision`，也无法把目标标记 complete/blocked →
   目标只能跑到轮数上限再被 `round-limit` 阻塞，无法真正「自动完成」。
4. **桥接通道可用。** `@anthropic-ai/claude-agent-sdk` 提供 `createSdkMcpServer` + `tool()`，
   可在 `runClaudeCode` 的 options 里挂一个**进程内** MCP server；已实测构造成功，且
   **不需要**额外安装 `@modelcontextprotocol/sdk`。模型看到的工具名为 `mcp__<server>__<tool>`。
5. **`/goal` 命令对 Claude Code 会话可用。** 预设（含 `command-goal` 行）在
   `EngineRouter.#runSetup` → `options.setup` → `agentPresets.mount` 中挂进 agent scope，
   路由到 Claude 引擎时同样执行；命令由 DSH 命令平面派发、作用于调用它的 agent。
6. **`canUseTool` 现已恒挂。** 工作区当前含一处进行中的修复：`lib/approval.mjs` 把
   AskUserQuestion 处理**提前到策略短路之前**，`lib/claude-run.mjs` 让 `canUseTool`
   在 `danger-full-access` 下**也**挂上（否则 CLI 会丢弃 AskUserQuestion）。本设计遵循该新形态。

## 3. 架构与数据流

复用整套 host goal 栈；插件只新增「模型工具桥接」与「策略提示」两件事。

```
用户 /goal <目标>
  └─ ctx.goals.create(+arm)                 ← 已有 command-goal（preset 已挂）
      └─ host driver 检测对应 agent 空闲
          └─ agent.followup(<goal_round>)    ← 已有：driver 调本插件 agent
              └─ ClaudeCodeAgent.drive() 原样 append user/message(source=goal)
                  └─ 转给 Claude Code 新回合
                      └─ Claude 调 mcp__goal__get_goal 读 id/revision
                          └─ ……推进目标……
                              └─ Claude 调 mcp__goal__update_goal(complete|blocked)
                                  └─ ctx.goals.complete/block(+disarm) → 循环结束
```

关键性质保持不变：轮数上限、阻塞阈值、持久化、不变量校验全部由 host goal 栈负责，
插件不复制这些语义。

## 4. 组件设计

### 4.1 新模块 `lib/goal-bridge.mjs`

单一职责：把 goal 领域的三个模型工具，以进程内 MCP server 的形式暴露给 Claude Code。

导出工厂：

```js
buildGoalServer({ ctx, agent, turnContext, config })
  → createSdkMcpServer({ name: "goal", version: "1.0.0", tools: [getGoal, createGoal, updateGoal] })
```

- `agent`：本会话的 `ClaudeCodeAgent`；所有 `ctx.goals.*` 调用都以它为归属。
- `turnContext`：只读访问器（见 §4.2），用于权限判定。
- `config`：`{ blockedAfterConsecutiveRounds, defaultMaxGoalRounds? }`。
- 若 `ctx.get("goals")` 不可用，调用方（§4.3）根本不构造该 server；本模块不做探测。

三个工具的语义与 `@deepseek-ai/dsh-tool-goal` 对齐（参数名、紧凑 JSON 输出、错误码）：

| 工具 | 实现 | 权限（在插件侧复刻 `dsh-tool-goal` 的判定） |
|---|---|---|
| `get_goal()` | `goalValue(ctx.goals.get(agent))` | 无 |
| `create_goal(objective, max_goal_rounds?)` | `ctx.goals.create(agent, { objective, maxGoalRounds? })` | 当前回合须含**人类直接消息** |
| `update_goal(goal_id, revision, action, objective?, max_goal_rounds?, blocked_reason?)` | 见下 | `edit`/`pause`/`resume` 须人类直接消息；`complete`/`blocked` 亦允许 goal round；`blocked` 受连续轮数阈值；`resume` 拒绝已 paused 的 goal |

`update_goal` 的分支（逐条复刻 `dsh-tool-goal`）：

- `edit`：需人类直接消息；`blocked_reason` 非法 → 错误。
- `pause` / `resume`：需人类直接消息；`objective`/`max_goal_rounds`/`blocked_reason` 非法；
  `resume` 且当前 goal 为 paused → 抛 `GOAL_TOOL_RESUME_PAUSED`（model 不能恢复 paused）。
- `complete` / `blocked`：`objective`/`max_goal_rounds` 非法；`complete` 带 `blocked_reason` 非法；
  `blocked` 必须给非空 `blocked_reason`，且在 goal round 中要求
  `goal.roundsStarted >= blockedAfterConsecutiveRounds`；否则抛 `GOAL_TOOL_BLOCK_THRESHOLD`。
  落库时 `blocked` 用 `{ code: "model-reported", message }`。
- 严格 schema 的空串 / 零值按「未提供」处理（`hasText` / `hasRoundCap` 同款）。

输出与错误：

- 成功：`content: [{ type:"text", text: JSON.stringify({ goal, activation }) }]`，
  其中 `goal` 为 `null` 或 `{ id, revision, objective, phase, roundsStarted, maxGoalRounds, blockedReason? }`。
- 预期领域错误（`GoalError`）与参数错误：返回可读文本（`isError: true`），
  **不让异常穿过** MCP 边界。
- 意外异常：同样兜成 `isError` 结果并 `ctx.logger.warn`。

### 4.2 `lib/agent.mjs` 改动

- `drive()` 在 `claim("next-turn", turn)` 之后记录 `this.currentTurn = { turn, messages }`；
  在 `turn/end`（成功或失败分支）之后清空为 `undefined`。
- 新增只读访问器 `currentTurnContext()`，返回：
  - `hasHumanMessage`：本回合被 claim 的消息里是否有 `source.kind === "user"` 的（人类直接消息）。
  - `isGoalRound`：是否有 `source.kind === "goal"` 的消息。
  - （`roundsStarted` 直接由 bridge 从 `ctx.goals.get(agent)` 现读，不从回合快照取。）
- 其余 agent 行为不变。

> 说明：`hasHumanMessage` 是最接近 `dsh-tool-goal` 权限语义的近似——它证明「本回合由人类直接发起」。
> 无法、也无需证明该请求「足够重大值得建目标」，这一点本就由模型判断。

### 4.3 `lib/claude-run.mjs` 改动

在 `runClaudeCode` 构造 `options` 处：

- 当 `config.goal.enabled !== false` **且** `ctx.get("goals") !== undefined` 时：
  - `options.mcpServers = { goal: buildGoalServer({ ctx, agent, turnContext, config: config.goal }) }`
  - `options.systemPrompt = { type: "preset", preset: "claude_code", append: goalGuidance(config.goal) }`
- `turnContext` 由调用方（agent）传入（`runClaudeCode` 参数新增 `turnContext`）。
- 两者都关闭时 options 不含这两个键，行为与当前完全一致。

`goalGuidance({ blockedAfterConsecutiveRounds })`：返回 `dsh-tool-goal` 同款策略文本
（含阻塞阈值），要点：可从任意语言的直接人类请求推断 goal；resume/fork 后 goal 为停用，
人类要求继续时用 `update_goal action resume` 重新武装；仅有真正达成时才 `complete`；同一阻塞
条件连续达到阈值轮数才 `blocked` 并写明具体条件。

### 4.4 `lib/approval.mjs` 改动

在 `canUseTool` 内、**策略短路之前**（与 AskUserQuestion 同一处，紧随其后）新增：

```js
// goal 桥接工具是进程内、无副作用、且自带领域权限判定的交互，不受沙箱/审批门控；
// 必须早于 strategy 短路，否则 no-prompt（never）下会被拒绝。
if (toolName.startsWith("mcp__goal__")) return { behavior: "allow" };
```

（放在短路之前的原因：`ask`/`no-prompt`/`bypass` 三种策略下 goal 工具都应可用；
若落到 `no-prompt` 分支会被一律拒绝。）

### 4.5 `index.mjs` 配置

`ENGINE_DEFAULTS` 增加：

```js
goal: {
  enabled: true,
  blockedAfterConsecutiveRounds: 3,
  defaultMaxGoalRounds: undefined, // 可选：仅在本插件 create_goal 时透传
},
```

`engines` 在 `Config` 中是 `z.dict(z.any())`、原样透传，故只需改 `ENGINE_DEFAULTS` 一处。

`cordis.patch.yml` 的插件的 `config.engines["claude-code"]` 里可选地补 `goal:` 段作为示例；
不是必需（默认值已内建）。

### 4.6 `package.json`

新增运行时依赖 `"zod": "^4.0.0"`（SDK 的 `tool()` 需要 zod raw shape；宿主已存在 4.6.5）。

## 5. 数据与不变量（会话安全）

- 插件**绝不**自行 `session.append("goal/change")`，**绝不**手搓 `source.kind === "goal"` 的
  `user/message`。所有 goal 变更必须经 `ctx.goals.*`。
- goal round 提示由 host driver 生成、经 `agent.followup` 进入 inbox，`drive()` **原样**转发并
  `append`。不得改写其 `content` 或 `source`。
- 理由：`@deepseek-ai/dsh-goal` 与 `dsh-goal-round-driver` 各带一个**全局严格**不变量伴生，
  会 fold **每一条**会话的 goal 事件并对不一致 fail（会话判定 corrupt）。破坏上述任何一条
  都会导致会话打不开。
- 单测必须包含断言：桥接代码不直接 append goal 事件；转发路径不改写消息。

## 6. 错误处理与降级

| 情形 | 行为 |
|---|---|
| 无 `ctx.goals`（部署未装 goal 栈） | 不挂 bridge、不加 systemPrompt；功能静默缺席，不报错、不影响会话 |
| `config.goal.enabled === false` | 同上关闭 |
| 桥接工具收到领域拒绝（`GoalError`） | 返回 `isError` 的稳定文案（同 `dsh-tool-goal`） |
| 桥接工具未知异常 | 兜成 `isError` 结果 + `logger.warn`；不打断回合 |
| `ctx.goals.create/edit/...` 抛非预期异常 | 让回合正常结束（异常被 `drive()` 的 catch 收束），不污染日志 |

## 7. 测试

单元（`node --test`，现有 54 用例之上）：

- `test/goal-bridge.test.mjs`（新）：
  - 三工具的输入 schema 与输出形状（`goal: null` / 完整 JSON）。
  - 权限矩阵：人类回合 vs goal 回合 × create/edit/pause/resume/complete/blocked。
  - 阈值：`blocked` 在 `roundsStarted < threshold` 时拒绝，达到时通过。
  - `resume` 对 paused goal 抛 `GOAL_TOOL_RESUME_PAUSED`。
  - 错误路径：`GoalError` → `isError`；未知异常 → `isError` 且不外抛。
  - 严格 schema 空值填充按省略处理。
- `test/agent.test.mjs`（补）：`currentTurn` 在 claim 后写入、`turn/end` 后清空；
  `currentTurnContext()` 的 human/goal 判定。
- `test/claude-run.test.mjs`（补）：goal 开启时 options 含 `mcpServers.goal` 与
  `systemPrompt.append`；关闭或 `ctx.get("goals")` 缺失时两者都不含。
- `test/approval.test.mjs`（补）：`mcp__goal__*` 在 `no-prompt` 下返回 allow。

集成（`.dsh-diag` 隔离 harness，必要时桌面 app）：

- `/goal <目标>` → 观察多轮 `<goal_round>` 自动续跑。
- Claude 经 `get_goal` 读快照、`update_goal` 收尾后循环停止。
- 会话日志通过 goal 不变量校验、可正常 reopen（用离线 v4 校验路径）。
- 关闭配置后，Claude 会话行为与改动前一致、无 goal 工具。

## 8. 已知限制与风险（实现期必验）

1. **driver 假设 `agent/pre-step`，本插件不发出该事件。** 已分析：轮数计数走会话日志，
   不受影响；缺的仅是无竞态防护与 `startsRequestSeries` 的 UI 呈现（goal round 消息的
   「自包含请求 header」）。实现期用隔离 harness 实测续跑是否成立；仅当实测确有问题，
   才另案评估补发事件——**本设计不含**。
2. **host driver 能否看到本插件 agent 的 `agent/status` / inbox 事件**（跨 scope 派发）
   是「能自动续跑」的前提，实现期第一步即验证。
3. **KV cache / token 成本**：goal 工具 schema 常驻 + 策略提示，每次请求少量固定开销；
   关闭开关可消除。
4. **收尾指令（原为缺口，2026-10-15 已补齐）**：`dsh-tool-goal` 在 complete/blocked 后
   `deferContext` 一段收尾指令。现按同一文本补入 `lib/goal-domain.mjs`（`goalWrapupContext`），
   与原生一样只在 `authority.kind === "goal-round"` 时附带，人类直接回合不带；
   MCP 路径作为第二个 text 块随工具结果下发，mod 路径把两个块按换行拼接后交给模型。
   **已知差异**：原生把该上下文注册为会话可见 notice（source `tool-goal` / form `notice`），
   本版挂在工具结果里，因此 transcript 中不会另有一条 notice 气泡。
5. **`hasHumanMessage` 是近似**：仅证明本回合由人类直接发起，不判断目标是否「足够重大」。
6. **宿主服务只能用 `ctx.get(name)` 取，不能当属性读（2026-10-15 实测踩中）。** 宿主 ctx 是
   cordis 代理：插件 `inject` 清单（`agents`/`sessions`/`sessionPersistence`）之外的服务，
   属性访问抛 `cannot get property "goals" without inject`。`7585f7d` 的 admission guard
   用 `loopCtx.goals.get` 读目标，该抛错被 `assessGoalAdmission` 吞成 `hold`/`goal-read-failed`，
   于是每个 goal round 被永久暂挂、agent 空闲、宿主驱动器随即暂停目标（现场表现为
   「目标创建后 0 回合、11ms 后被暂停」）。已改为 `loopCtx.get?.("goals")`（同
   `lib/goal-domain.mjs`）。**测试盲区**：`wireGoalFixture` 在裸 `new Context()` 上 `provide`，
   属性访问不受 inject 限制，所以只有包裹代理的用例（`test/agent.test.mjs`「宿主不把 goals
   暴露成 ctx 属性时…」）能复现。新增任何对宿主服务的读取都必须走 `ctx.get`。

## 9. 交付物

- 新增：`lib/goal-bridge.mjs`、`test/goal-bridge.test.mjs`。
- 修改：`lib/agent.mjs`、`lib/claude-run.mjs`、`lib/approval.mjs`、`index.mjs`、`README.md`、
  `package.json`（`zod` 依赖）。
- 设计文档：本文件。
- 实现计划：随后经 writing-plans 生成。

## 10. 验收标准

1. 选中 `claude-code` 预设的会话，`/goal <目标>` 后能自动多轮推进，且最终由 Claude
   `update_goal` 收尾（complete/blocked），或到达轮数上限被阻塞。
2. 会话日志合法：不触发 goal/rl 不变量，能正常 reopen。
3. 关闭 `engines.claude-code.goal.enabled` 后，行为与现状一致，且无 goal 工具注入。
4. 非 Claude Code 会话行为零变化。
5. 全部单测通过。
