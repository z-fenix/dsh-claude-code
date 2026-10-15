# scope-aware DSH 工具桥：审计范围、实现与验收

用户已选定 **present + jobs**。本项通过 SDK MCP 桥接本机 DSH 0.2.0-rc.2 的原生工具，
不修改宿主包、正式会话或全局 Claude 设置。第三期的 persona/runtime 提示词、动态工具及
原生可续聊子代理不属于本项。

## 一、范围与配置

桥接本身 **默认关闭**。显式开启后，默认名字为四个已审计工具：

```yaml
engines:
  claude-code:
    dshTools:
      enabled: true
      names: [present, job_list, job_output, job_kill]
```

`names` 可以缩小这个集合；空数组不注册 server，非数组或未知名字使该轮报错并收尾，
不能通过配置扩大到 `bash` 或其它工具。server 名为 `dsh`，模型名为 `mcp__dsh__<name>`。
它独立于 goal 的 `mcp` / `mod` 选择；一次查询仍只使用一个 goal adapter。

| 工具 | 原生行为 | 边界 |
|---|---|---|
| `present` | 核对工作区的已有普通文件，经原生结果观察器登记 `deliverables/presented` | 需要有效 agent、open turn、cwd；交付事实关联真实调用 ID |
| `job_list` | 列出当前 agent 有权访问的原生 jobs | 不把 CLI 后台任务伪装成 DSH job |
| `job_output` | 消费原生 job 的输出；可按原生超时边界等待 | owner 由执行 agent 决定，不由参数指定 |
| `job_kill` | 请求原生 job 取消 | 有副作用；跨会话由宿主拒绝，不暴露 job-start |

没有桥接 DSH fs/bash/grep/todo/skill、动态插件工具或其它 MCP 客户端/资源能力。
结果适配仅返回已审计工具的 `content` 与 `isError`；不承诺任意工具的 `meta`、
`additionalContexts`、`value`、`concludesTurn` 或图片/附件语义。

## 二、宿主与 SDK 接缝

`ToolRuntime` 提供 `schemas(agent)`、`wireSchemas(agent)`、`get/resolveExecution` 和
`execute({callId, name, arguments, agent, signal})`。后者经过原生 pre-execute 门控、
调度、post-execute、结果物化及结果观察器；桥不直接调用裸 handler。

优先使用 **`wireSchemas(agent).schemas`**；只有宿主没有这个方法时才兼容回退到
`schemas(agent)`。PTC 模式的模型面只有 `run_code` 时不另开 MCP 入口，不能借
`schemas` 中仍存在的底层定义绕过折叠。每次执行前同样重查可见性。

DSH `defineTool` 在注册时已经把属性级 `required` DSL 转成标准 JSON Schema；
桥选择器保留宿主投影，不自行编写方言转换。SDK 0.3.220 的 `tool()` **不能直接接受
JSON Schema**，但能接受完整 Zod schema；实际实现是 `z.fromJSONSchema(inputSchema)`。
只取 raw shape 会丢掉对象级约束，所以转换完整对象。真实 SDK 回归覆盖嵌套 required、
optional、`additionalProperties: false`、无参 `job_list` 及无效参数不执行。

## 三、调用身份、权限与生命周期

实际 CLI 2.1.296 在 MCP 请求 `_meta["claudecode/toolUseId"]` 里携带 assistant 的
`tool_use.id`；SDK 把 `_meta` 交给 handler 的 extra。桥将这个 ID 传给宿主执行。
**JSON-RPC requestId 和随机 UUID 不能替代它**，否则交付事实虽然可通过字段校验，
却不能关联轨迹中的真实调用。缺失或空身份元数据一律拒绝执行。

这个 extra 元数据是已观察并测试的运行时契约，不是完整的类型层保证；不支持该契约的
CLI 不会获得静默降级的调用身份。广告及轨迹保留 `mcp__dsh__*` 名，宿主执行使用原生名。

**父 agent 桥仅允许主查询调用**。runner 先区分 child 消息，再将主 assistant 消息写入
轨迹；日志仍完整时才向桥确认同一个 tool-use ID 和精确工具名。child 消息即使被关闭的
子代理投影丢弃，也只登记为拒绝，不能使用父 cwd、交付会话或 jobs owner。桥自身同样
拒绝非空 `parent_tool_use_id`，不依赖调用参数中的自报身份。子代理仍是 one-shot，未实现
原生 child-scope 工具桥。

MCP 请求可能先到，最多等待 5 秒取得归属证据；超时、查询/请求取消或 close 均失败并
清理等待器。证据到达后再次核对 agent 对象、running、工具可见性和查询状态，然后才
进入原生执行。ID/名字冲突不升级为主调用，不为 unknown caller 默认选择父 scope。

`canUseTool` 仅自动允许当前查询实际注册的精确名字，不允许整段前缀。原生 `execute`
仍承担自己的权限与 owner 门控；这不为 Claude 内建工具增加 OS 沙箱。旧的
`goalToolNames` 参数仍兼容，新 `allowedToolNames` 参数优先。

每次调用核对：查询未关闭、查询和请求信号未取消、registry 中仍是同一个 agent 对象、
agent 仍为 running、工具仍可见。查询/request 信号融合后交给宿主。runner 在 finally
关闭桥；schema/配置错误也在 try/finally 内收尾，不能遗留 abort listener 或旧 handler。
原生工具域错误保留 `isError`；意外宿主异常只返回脱敏错误，不给模型异常栈或凭据。

## 四、日志不变量

**log-only 不是任意事件可安全追加的证明**。本次只审计四个工具的行为与必需字段。
`present` 的原生观察器在有效 turn 下追加 `deliverables/presented`，其 callId 必须是
真实 CLI ID。jobs 的结果通过已有工具轨迹投影；其原生完成通知仍可能进入 owner inbox，
不能宣称这些工具永不影响会话。没有把 persona/runtime 的宿主 prompt 装配搬进 CLI。

每条广告/assistant/tool-call 的名字与调用身份仍须匹配；工具结果要真实配对，不能靠
合成缺失结果补丁掩盖桥错误。完整 session 必须通过原生行准入及 released-v4 关系校验。

## 五、验收记录（2026-10-14）

- 单元与真实 SDK：精确 allowlist、schema 校验、真实调用 ID、缺失身份、取消、关闭、
  agent 替换、工具移除、PTC 折叠、无服务/无可见工具、不扩大配置。
- runner：查询结束后旧 handler 即使 agent 仍 running 也不可执行；无效配置结束为 error
  且清掉 abort listener；关闭桥不注册 server，goal 关闭时仅注册 `dsh`。
- 真实隔离 web：`DSH_HOME=.dsh-diag/iso-home`，loopback 19399，独立 fixture cwd。
  `present` 成功，原生交付卡片显示 `report.txt`，侧栏正文为
  `DSH bridge live acceptance fixture`；未点击操作系统“打开”按钮。
- CLI 身份修复后旧 fixture 的交付 seq31 和 seq90 均关联真实 tool/call；修复前 seq11 的
  随机身份事实保留作失败基线，不重写历史。旧 fixture 三回合曾完成并通过 97-event 校验；
  后续第四回合在工具前失败为 `spawn EINVAL`，104-event 日志仍有效，失败输入保留未重投。
- 最终主查询归属修复后，另建隔离 fixture `session-fd06f197-01c7-4162-81cb-2db1d5601e2c`：
  八次调用顺序完成，八个真实结果配对，**57 events** 通过原生 v4 行和关系校验，turn completed。
  新交付 seq46 关联 `call_6be6dd47d3be47f49c054cc5b1ed37cc`，原生 UI 卡片及正文再次核实。
- 通过临时隔离-only 插件在原生 registry 创建两条无进程的 inert job（无模型 job-start）：
  本 owner 的 list/output 显示 running 和 `OWNED-BRIDGE-PROBE`；foreign owner 的 output
  与 kill 都返回 `job bridgeforeign-1 belongs to another session`；本 owner 的 kill 确认，
  后续 output/list 显示 killed。另通过已认证 `job/list` 原生流 RPC 核实 foreign job 仍归属
  原会话且 running，拒绝取消未改变其状态；流随后关闭。这不是用 unknown-job 错误冒充验收。
- 新 fixture 验收时暂时关闭 isolated profile 的 mods，用于隔离此前启动错误；默认配置未改。
  验收当日不能宣称已找到或修复 `spawn EINVAL` 根因；该启动诊断与工具桥的执行结果分开记录。
  （**2026-10-15 已定位并修复，见下条**；此为当日记录，保留不改写。）
  验收后已卸载临时 fixture、移除 `mods:false` 覆盖；仅保留已授权的隔离 bridge 开关。
  已核对并停止专属 host PID，19399 无 listener，私密 bootstrap 删除；未改正式 profile。

### 五之二、`spawn EINVAL` 根因与修复（2026-10-15）

现象（重新核对旧日志）：失败回合 `turn/end` 带 `reason.kind:"error"` /
`error.message:"spawn EINVAL"` / `error.code:"CLAUDE_CODE_ERROR"`，**没有 `request/header`、
没有 `step/start`**，耗时 0.06–0.87 s —— CLI 根本没起来。出现于
`session-0faa2cfb…`（10-10，第 3/4/5 回合）与 `session-2c644cce…`（10-14，第 4 回合）。

根因链路（逐段实测，不靠推断）：

1. 宿主 `subprocess.resolveExecutable()` 返回的是**磁盘上第一个匹配的候选文件**；本机即
   `%APPDATA%\npm\claude.cmd`（npm 的批处理 shim，同目录没有 `claude.exe`）。
2. Claude Agent SDK 只按扩展名决定要不要用 node 起脚本（仅 `.js/.mjs/.ts/.tsx/.jsx`），
   `.cmd` 被当成原生可执行文件直接交给 `spawn(shell:false)`。
3. Node 自 CVE-2024-27980 起禁止直接 spawn `.cmd`/`.bat`，**同步**抛 `spawn EINVAL`
   （errno -4071）。实测该输入类别是当时唯一能产生 EINVAL 的形态：`.ps1` 与无扩展名
   一律 ENOENT（-4058）；env 值/键含 NUL、参数含 NUL 为 `ERR_INVALID_ARG_VALUE`；
   env 值非字符串、cwd 缺失或为文件均为 ENOENT。
4. 把 `.cmd` 交出去的路径是 `lib/auth.mjs` 的 **fail-open 兜底**：三个解析分支都以
   `unwrapWindowsShim(x) ?? x` 结尾，而 shim 引用的 `.exe` 当时不可读（CLI 正在被更新
   覆盖、安装未完成）或 shim 内没有可用 `*.exe` token 时，unwrap 返回 undefined，
   于是 `.cmd` 原样透传。间歇性与「更新窗口」一致（同一会话同一配置下失败段之间有成功回合）。

修复（两条，均已 TDD）：

- `lib/auth.mjs`：新增导出谓词 `cannotSpawnDirectly(file)`（仅 Windows && `.cmd|.bat`）。
  `resolveFromPath` 不再采信解不开的 shim，继续向后扫描可 spawn 的候选，实在没有才留作
  最后手段并 `warn`；`resolveClaude` 的宿主分支同样拒绝不可 spawn 的返回值，
  落到本地 PATH 扫描并留 `warn`。诊断日志仍记录
  `target → subprocessReturned → final` 的完整解析链。
- `lib/claude-run.mjs`：`runClaudeCode` 的 try 内、起 SDK 之前拦下不可 spawn 的路径，
  以**回合级可读错误**结束（含路径与修复方向），不再把 errno 直接抛给用户。
  选在回合内而非 `resolveClaude` 处抛，是因为后者在 `turn/start` 之前调用，
  会把失败变成 `phase.inputFailure` 并中断驱动循环、留下未提交的消息。

残留不确定性：10-10/10-14 当时究竟是「引用的 .exe 恰好不可读」还是「shim 内无可用
`.exe` token」触发，已无遗留日志可证（插件日志未保留，桌面崩溃日志与本故障无关）。
两条触发路径现均被同一条守卫覆盖。

测试：`test/auth.test.mjs`（+4：宿主 shim 解不开时退回 PATH 扫描 / 只剩 shim 时如实返回
并留日志 / 谓词真值表）与 `test/executable-guard.test.mjs`（+2：不可 spawn 时不调用 SDK
且回合以可读错误结束 / 可正常解析时不受影响）。完整 `node --test
--experimental-test-module-mocks "test/**/*.test.mjs"`：**477/477 pass**。

**仍未做**：真实桌面/真实 Claude 的复核（需批准的付费回合）。离线测试通过不等于
宿主生命周期或 UI 验收通过。
（**2026-10-15 隔离 web 实例已补**：把 `executable` 指向一个解不开的 `.cmd` shim 起真宿主，
该回合**零推理**地以 `reason.error.code = CLAUDE_CODE_ERROR` 结束、`steps: []`、`requestHeaders: []`
——守卫在真实生命周期里挡住并给出可读错误，证据 `.dsh-diag/live-verify-2026-10-15/guard-session.json`。
仍未做的是「真实桌面 UI / 正式 profile」的复核。）

- 主查询/子代理归属、提前到达、未知 ID、名字替换、等待取消/超时/agent 替换有真实 SDK
  回归，runner 在关闭 child 投影时仍拒绝借用父 scope。最终 fresh-context 审查只有这条
  Important/P2 finding，已由失败复现测试 RED→GREEN 修复，没有再派发重复审查。
- 完整 `pnpm test`：**313/313 pass**，0 failed/cancelled/skipped（带既有 experimental
  module mocking / namedExports 警告）；四个产品入口 syntax check、`git diff --check` 通过。
  `npm pack --dry-run`：39 files，包含 bridge，不包含 scratch/isolation/bootstrap/credentials。IDE build 不可用，因为本仓库未在 IDE 打开；没有构建其它项目。

## 六、仍不承诺的能力

桥不是标准主循环等价层。CLI 与 DSH jobs 是不同 registry；未提供同步、启动或恢复
后台工作的能力。动态工具须重新审计并单独批准，而不是加一个名字就得到通用桥接权限。

### 六之二、skills / persona / runtime 的逐项结论（2026-10-15 核实并修正）

原文把三者统称「由 `agent/pre-step` 装配的段落」，逐项查证后不成立：它们的到达路径不同，
能不能桥接也就不同。

| 项 | 真实到达路径 | 结论 |
|---|---|---|
| persona | 宿主 `systemPrompt` 的**段落** `deployment:persona-prefix` / `deployment:persona-suffix`，由预设里的 `@deepseek-ai/dsh-persona` 行注册进 agent scope | **已按项桥接**（见下） |
| skills | **不是段落**：`@deepseek-ai/dsh-skill-filesystem` 只往 `ctx.skills` 注册 provider，模型侧由 `@deepseek-ai/dsh-tool-skill` 的 `skill` **工具**列出与读取 | 工具桥问题，不是段落问题；要补齐必须把 `skill` 加入审计白名单，属**新工具桥条目，需单独批准**，本次未做 |
| runtime | 宿主 `systemPrompt.context()` 注册的**动态上下文**（沙箱策略、审批策略、子代理委派等），由宿主每步渲染成运行上下文快照 | **刻意不转发**：这些文本描述的是 DSH 的执行边界，而 Claude 模式下真正生效的是本插件的 `lib/permission.mjs` / `lib/approval.mjs` 策略；转过去等于向模型虚构一层并不存在的沙箱 |

persona 的桥接实现（`lib/host-persona.mjs`）：

- 在**同一回合内**（不是假装成 pre-step）调用宿主 `systemPrompt.assemble({ agent, scope: agent, signal })`
  —— `agent` 作 scope 键，与宿主自己的 `assembleContextFor` 形状一致，所以取到的正是本会话
  agent scope 的段落；宿主服务只能用 `ctx.get`（见 `2026-10-12-claude-code-goal-mode-design.md` §8.6）。
- **按名字白名单只取 persona 两段**并用宿主返回的 `variables` 插值。工具段落描述 DSH 的工具
  （Claude 有自己那套），转发即广告不存在的能力，所以不取；harness 身份段同样不取。
- 任何失败（无服务、assemble 抛错、变量缺失、段落标 `complete`）都退化成**不转发 + reason**，
  不抛错、不发空文本、**绝不把 `{{cwd}}` 原样发给模型**。段落标 `complete: true` 时它的语义是
  「这一段就是整份提示词」，`systemPrompt.append` 表达不了替换，如实不转发而不是照发冒充。
- 转发走 SDK 的 `systemPrompt: { type: "preset", preset: "claude_code", append }`，与 goal 策略文本
  并存（persona 在前、策略在后），不覆盖 CLI 自己的 system prompt，也不写 `request/header.system`。

**离线复核（`.dsh-diag/probe/run.mjs`，2026-10-15）**：单测用的是假服务，验不了「真宿主的
`ctx.get("systemPrompt")` 能不能解析」和「`assemble({agent, scope: agent})` 是不是真的链到 agent
scope」。探针把 app.asar 里抽出的**真** `SystemPrompt` 挂到真 cordis `Context` 上，用宿主自己的
`ctx.inject` + `section()`/`variable()` 复刻预设行的挂载形状，9 项检查全过：取到本 agent scope 的两段、
`{{cwd}}` 用宿主 `variables` 插值、兄弟 scope 不串味、随包预设 persona 全文原样转发（含两处 `{{cwd}}`）、
变量缺失时整段不转发且不漏字面量。顺带核出一处**与假服务不同但不影响行为**的差异：真宿主在全局
无条件注册两段 persona（文本为空），所以「取不到 persona 段落」这个 reason 分支在真宿主里不会走到，
`text` 仍是空串、调用方照旧不 append，只是少一条诊断。另：`ctx.inject()` 的回调是异步挂载的，
挂载未落定就读会读到空装配——真宿主里预设行在会话建立时就挂好，回合远在其后，够不到这条。

**仍未做**：真实桌面/真实 Claude 的复核（需批准的付费回合）。离线单测通过不等于宿主生命周期
或 UI 验收通过；`assemble()` 在真实宿主里被每回合调用的成本与副作用也只在单测里被建模，未被实测。
