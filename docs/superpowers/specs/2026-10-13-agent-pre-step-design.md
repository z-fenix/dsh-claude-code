# 为什么本插件的 agent 不派发 `agent/pre-step`

本文件记录一次只读调查的结论：Claude Code 驱动的 agent **不能**照搬宿主
`dsh-agent-loop` 的 `agent/pre-step` 契约。结论是**不派发**，并说明代价与残余风险。
调查对象是本机安装的 DSH 0.2.0-rc.2（`resources/app.asar`）与仓库当前实现。

## 这个事件是什么

原生循环在**每个 step 之前**派发一次 waterfall：

```js
// dsh-agent-loop/lib/index.js 的 preStep()
const claimed = this.inbox.claim(target, position.turn);
const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal));
const context = this.runtimeContext.project(joinContextSections(sections), sections);
const decision = await this.dispatch.waterfall("agent/pre-step",
  { messages: claimed, ...position, signal },
  () => Promise.resolve({ kind: "enter", messages: context === undefined ? claimed : [...claimed, context] }));
if (decision.kind === "reject") return decision;
return { ...decision, assembly };
```

它同时承担三件事：**组装本轮消息**（claim + 注入上下文）、**否决本轮**（`reject`）、
**记录装配结果**（`assembly`、`startsRequestSeries`）。宿主里挂在它上面的有 14 个包，
其中对会话内容有实质影响的是：

| 包 | 在 pre-step 做什么 |
|---|---|
| `dsh-agent-instructions` | `compose()` 出工作区指令文件内容，追加进 `decision.messages`；并直接增删 `agent.inbox.nextStep` 里的指令消息 |
| `dsh-time-context` | 每轮（按 `refreshIntervalMs`）追加一条时间快照消息 |
| `dsh-plan-mode` | 只在本步被接受时追加 `plan/mode` 段落 |
| `dsh-compaction-basic` | 「between-step pressure」自动压缩：shadow 掉会话日志里早期的 surface 节点 |
| `dsh-goal-round-driver` | 校验本轮 goal 预留（revision fence），接受时标记 `startsRequestSeries` |
| `dsh-session-reference` / `dsh-tmux-context` / `dsh-repeat-tool-reminder` / … | 各自注入或改写 |

## 为什么不能照搬

原生循环的 prompt 由 DSH 自己装配：`systemPrompt.assemble()` + `runtimeContext.project()`
的结果就是**真正发给模型的内容**。上面所有监听器都是在改写这份装配。而本插件的 prompt
由 `lib/attachments.mjs` 的 `buildPrompt()` 生成、真正发给模型的是 **Claude Code CLI 自己
装配的请求**——DSH 的装配结果从来不上网。因此在这里派发 pre-step 会得到：

1. **重复注入**。`agent-instructions` 会把工作区指令（CLAUDE.md 等）作为一条消息塞进本轮；
   而 Claude Code CLI 本来就会自己读取并加载同一份指令文件。结果是模型收到两份。
2. **对不上号的压缩与段落**。`compaction-basic` 去 shadow 的是 DSH 日志里的 surface 节点，
   可这些节点根本不是 Claude 的输入；`plan-mode` 追加的段落也不会被 CLI 发送。
   UI 与模型看到的东西就此分叉。
3. **在别人的排水管里改道**。`agent-instructions` 还会 `agent.inbox.remove()` 它自己管理的
   next-step 消息——那套约定的前提是「指令由 pre-step 装配」，本插件并不满足。

补充几何约束：即使忽略注入问题，本插件的一个回合就是**一次不透明的 Claude 查询**，
内部 step 由 CLI 产生；插件没有 step 边界可以重新校验。所以
`dsh-goal-round-driver` 那条「编辑通过修订栅栏让进行中的 Round 失效」在插件里
**结构上无法实现到 mid-round**，最多只能在回合起点判一次。

## 因此插件的现状与代价

本插件的 agent 只派发 `agent/status`、`agent/error`、`agent/assistant-stream`、
`agent/inbox/inserted|claimed|discarded`、`agent/turn-stopping`，**不派发 `agent/pre-step`**。
由此产生的已知差异：

- **没有 DSH 侧的每轮上下文注入**：工作区指令由 CLI 原生加载；时间快照、session 引用、
  plan-mode 段落、DSH 侧自动压缩都不会进 Claude 的请求。
- **goal 轮的 revision fence 不生效**：排队后、开始前目标被编辑/暂停的窗口内，
  那一轮不会被宿主拒绝。窗口只有「入队 → 本回合 claim」之间，实际很短；
  其余围栏（`agent/status`、`goal/changed`、inbox 增删事件）仍在工作。
- **`startsRequestSeries` 不会被设置**：goal 轮的请求 header 不按「独立请求序列」渲染。

## 建议

- **不要**为了「补齐契约」而派发 `agent/pre-step`：那会把 DSH 的装配管线接到一个它不拥有的
  prompt 上，产生重复指令与分叉状态。
- 若将来确实要把某项 DSH 上下文带给 Claude，应**按项显式桥接**（明确格式与去重），
  而不是整体打开 waterfall。
- goal 修订栅栏若要补，只能在**回合起点**做一次等价校验（读 `ctx.get("goals")`，
  比照 driver 的 `validReservation` 条件：`id`、`revision`、`phase: active`、
  `activation: armed`、`source.round === roundsStarted + 1`）。这属于对宿主策略的复制，
  会随宿主版本漂移，需单独批准；当前未实现。

## 验证方式

- 监听器清单位于安装包内（`node` 读 asar 后按字符串 `agent/pre-step` 扫描），
  上表逐条对应源码位置。
- 「本插件不派发该事件」是代码事实：`lib/agent.mjs` 的 `drive()` 全流程只有
  `dispatch.emit/serial`，无 `waterfall("agent/pre-step", …)`。
- 「不派发也不影响 goal 续跑」有实测：真实会话中 goal 轮 r1–r6 正常执行并正确收尾
  （`turn/end reason.kind = "completed"`），隔离实例中 r1–r3 同样正常。
