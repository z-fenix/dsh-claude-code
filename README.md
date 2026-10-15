# dsh-claude-code

<!-- Hero -->
<div align="center">
  <b style="font-size: 1.15em;">在 DSH 里用 Claude Code 驱动会话，轨迹实时可见</b><br /><br />
  <a href="https://opensource.org/licenses/MIT"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a><br /><br />
  <img alt="轨迹实时流式" src="https://img.shields.io/badge/-轨迹实时流式-4d6bfe" /> <img alt="权限桥接" src="https://img.shields.io/badge/-权限桥接-4d6bfe" /> <img alt="零配置注册" src="https://img.shields.io/badge/-零配置注册-4d6bfe" /><br /><br />
  <b>DSH 默认只用 DeepSeek</b>。装上本插件，预设列表就多一个「Claude Code」<br />
  —— 选中它用本机 Claude Code CLI 驱动会话，选其它预设照旧走原生循环。
</div>

<div align="center">
  🌏 <a href="./README.md"><b>中文</b></a> · <a href="./README_EN.md">English</a>
</div>

## ✨ 能干什么

- **🎯 一键接入 Claude Code**：声明一个 `claude-code` agent 预设 + 一个引擎，选中它，会话就交给本机 Claude Code CLI，零配置自动对上。
- **📡 轨迹实时可见**：文本、思考、工具调用与结果，每一步都实时流进 DSH 会话（`agent/assistant-stream` 实时帧 + `assistant/message` 落盘）。
- **📊 上下文占用可见**：把 Claude Code 的 token 用量与模型上下文窗口写进会话日志（`assistant/message.usage` + `request/context`），像 DSH 原生一样显示上下文占用与构成。
- **🔐 权限桥接**：DSH 的模式和审批策略映射到 Claude 的 `canUseTool`；仅 `workspace-write` 的工作区内 `blockedPath` 可自动放行，其他需要权限的调用按策略处理。`read-only` 下文件工具与 `Bash` 一律拒绝（见「已知限制」）。`AskUserQuestion` 用 DSH 的选择题 UI 作答。这不是 DSH 操作系统沙箱。
- **🧰 Claude 自带执行循环**：选中插件引擎时，实际工具、人设和上下文来自 Claude Code；DSH 预设工具行不会自动桥接到 Claude。预设仍负责路由和 DSH 侧服务组合。
- **⏯️ 精确续接**：Claude 会话 id 旁路持久化（旁路表 + 私有事实两份记录），重启后续聊接回**同一个** Claude 会话。
- **🌐 子代理轨迹**：Claude 内建 `Agent` / `Task` 子代理映射成 one-shot 只读子会话，显示短任务标签和真实运行状态；provider 保留在描述符里，没有合法人类消息来源时不伪造自动标题。原生 DSH 委派仍由宿主原生循环负责。
- **⌨️ 运行中输入**：普通 followup 排队到下一轮，steer 进入活查询，inject 不自行启动查询；显式取消先请求 SDK interrupt，再关闭查询。保留原始消息来源、图片和投递台账。
- **🧩 按能力加载 mods**：随包的 `dsh-bridge` mod 只加载到当前 Claude 子进程；可观察 prompt.compose、可选适配 goal 工具。不改全局插件设置，不修改 DSH 宿主包。
- **🎯 目标式自动任务**：选中 Claude Code 预设的会话支持标准模式那套 goal —— 输入 `/goal <目标>` 后自动一轮轮推进，Claude 用桥接的 `get_goal`/`update_goal` 读取并把目标收尾（complete/blocked）。开关 `engines.claude-code.goal.enabled`，默认开。

## 🚀 安装

要求：`dsh` **0.2.0-rc.2**（桌面版自带）、PATH 里有 pnpm、本机有可用的 `claude` CLI（已登录）或 `ANTHROPIC_API_KEY`。

```sh
# 必须装成链接（link:），不要用 file: —— 直接给本目录的绝对路径
dsh plugin --profile desktop add /绝对路径/dsh-claude-code
```

安装会把本包加进 profile 的 `dsh.profile.bundles`，并自动应用随包的 `cordis.patch.yml`（插入插件行 + 预设声明行）。装完**重启桌面应用**。

> **为什么不能写 `file:`**：本插件 import 的 `@deepseek-ai/dsh-scope` / `dsh-agent` / `dsh-session`
> 必须与宿主共用同一个模块实例（`dsh-scope` 用模块私有的 `Symbol("dsh.scope")` 给 ctx 打 scope
> 标签，两份副本 = 两个 Symbol）。DSH 只在链接安装下把这类包重定向到宿主 `app.asar` 里的实例；
> `file:` 会把检出复制进 profile 并连带装上一份 `dsh-scope` 副本，结果是新建/恢复会话都失败：
> `Agent preset binding requires a scoped context`。详见 [安装指南](docs/guides/setup.md)。
> 链接安装无需重装；修改源码后重启桌面应用，让已加载的插件模块更新。

> 也可以在桌面端的「设置 → 插件」里用插件管理器安装：`install_bundle` 指向本目录的绝对路径。

## ⚙️ 启用与配置

预设列表里出现「Claude Code」即装好了。想改选项，编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`，按行 id 覆盖：

```yaml
- id: dsh-claude-code
  name: dsh-claude-code        # 覆盖行的 config 时必须把 name 一起写回
  config:
    enabled: true
    routeMainLoop: true          # 默认已开；false = 预设可见但会话不被接管
    defaultEngine: deepseek    # 未选预设的会话走原生循环
    engineByPreset: {}         # 预设 id → 引擎 id 的显式覆盖（可选）
    engines:
      claude-code:
        executable: claude               # 或绝对路径，如 C:\Users\me\AppData\Roaming\npm\claude.cmd
        persistSession: true
        includePartialMessages: true
        traceSubagents: true
        mods:
          enabled: true                  # 按实际 CLI 的离线能力检查启用捕获
          handshakeTimeoutMs: 8000       # 输入提交前的 mod 注册握手超时
        goal:
          enabled: true                    # 默认开：把 goal 工具桥接进 Claude Code
          transport: mcp                   # mcp（默认）/ mod / auto；失败保留 MCP
          blockedAfterConsecutiveRounds: 3 # 同一阻塞条件连续多少轮才允许标记 blocked
          # defaultMaxGoalRounds: 256      # 可选：模型未给 max_goal_rounds 时的兜底
        dshTools:
          enabled: false                 # 显式改 true 才桥接原生交付物 / jobs
          # names: [present, job_list, job_output, job_kill] # 只能缩小这个审计白名单
        env: {}                          # 例如 { ANTHROPIC_API_KEY: sk-... }
        contextWindow: 200000            # 可选：SDK 取不到时兜底
        readOnlyBash: deny               # read-only 下 Bash：deny（默认）/ ask（回到「批准一次就放行」）
        # sandbox:                       # 可选：把 SDK 的 SandboxSettings 原样透传（Linux/macOS 才有真沙箱）
        #   enabled: true
```

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总闸；`false` = 插件完全不介入 |
| `routeMainLoop` | `true` | `false` 时不接管全局工厂：预设可见但会话不被接管（安全阀，见 index.mjs 注释） |
| `defaultEngine` | `deepseek` | 未命中映射的预设用哪个引擎；`deepseek` 是「回原生循环」的哨兵 |
| `engineByPreset` | `{}` | 预设 id → 引擎 id 覆盖表，优先于「预设 id 即引擎 id」的自动映射 |
| `engines.<id>` | `{}` | 该引擎的私有配置，插件不解析、原样转发 |
| `engines.claude-code.executable` | `claude` | Claude Code 可执行文件 |
| `engines.claude-code.persistSession` | `true` | 跨轮复用同一个 Claude 会话 |
| `engines.claude-code.includePartialMessages` | `true` | token 级流式输出 |
| `engines.claude-code.traceSubagents` | `true` | Claude 内部子代理映射成独立只读子会话 |
| `engines.claude-code.env` | `{}` | 追加给 claude 子进程的环境变量 |
| `engines.claude-code.contextWindow` | 未配置 | 手动指定上下文窗口（token 数） |
| `engines.claude-code.readOnlyBash` | `deny` | read-only 下 `Bash` 的策略：`deny` 直接拒绝（不弹审批）／`ask` 退回「批准一次就放行」 |
| `engines.claude-code.sandbox` | 未配置 | 原样透传给 SDK `query()` 的 `SandboxSettings`；不配则完全不传。不是 DSH 沙箱，Windows 上不生效 |
| `engines.claude-code.mods.enabled` | `true` | 用所选 CLI 的 `plugin validate/test` 检查捕获能力，仅对子进程加载随包 mod |
| `engines.claude-code.mods.handshakeTimeoutMs` | `8000` | 输入提交前的就绪握手超时，范围 1–30000 毫秒；失败另建 MCP 查询，不重复发送输入 |
| `engines.claude-code.goal.transport` | `mcp` | `mcp` 保持兼容；`mod`/`auto` 在 mod 可用时选择 mod，否则回 MCP；一次查询不重复暴露两套 goal 工具 |
| `engines.claude-code.goal.enabled` | `true` | 是否把 `get_goal`/`create_goal`/`update_goal` 桥接进 Claude Code（会话可用 `/goal` 自动推进） |
| `engines.claude-code.goal.blockedAfterConsecutiveRounds` | `3` | 同一阻塞条件连续达到多少个 goal round 才允许模型标记 `blocked` |
| `engines.claude-code.goal.defaultMaxGoalRounds` | 未配置 | 模型调 `create_goal` 未给上限时的兜底轮数（默认走 DSH 的 256） |
| `engines.claude-code.dshTools.enabled` | `false` | 显式开启 scope-aware DSH 工具桥；与 goal 的 transport 独立 |
| `engines.claude-code.dshTools.names` | `[present, job_list, job_output, job_kill]` | 仅可配置这个审计白名单的子集；空数组不注册 server，未知名字/非数组报错 |

## 🔍 原理（可选阅读）

- **预设是 Loader 行，不是目录**。DSH 0.2.0-rc.2 起，agent 预设由 `@deepseek-ai/dsh-agent-preset` 插件行声明（`config.id` / `name` / `description` / `order` / `plugins`），旧的 `~/.dsh/.agent-presets/<id>/` 目录已不再被读取。本包的 `cordis.patch.yml` 就是一条这样的声明。
- **路由靠接管 agent factory 槽位**。`ctx.agents.setFactory()` 在已有工厂时会抛错，而后加载的插件必然晚于 `dsh-base` 的 agent-loop 行；槽位是普通字段（`{ target: factory }`），插件替换它、并在自己的 fiber 释放时换回原工厂。**拿不到工厂时抛错**（而不是 warn 后静默返回）：静默降级的后果是预设列表里出现一个没有任何主循环接管的 Claude Code 预设，用户只能看到「模型自称 Claude Code 却没有工具」，无从归因。
- **只有本插件引擎的会话被接管，其余整条委托回原工厂**。新建会话按 `meta.agentPreset` 路由，resume 先读持久化日志反推预设（空白期切过预设的会话必须按日志而不是 header 判断）；只要解析结果不是本插件引擎，`createAgent`/`resume` 都直接转交 `@deepseek-ai/dsh-agent-loop`。
  为什么不让原生会话也走自己的实现：AgentLoop 的建会话链路包含 `ownership.trackWrapper` → `setupAndPublish`（`raceAbort(options.setup)` + `interruptedTurnClosers` + `appendUnstoredSuffix`）→ `raceAbortCall` → owner/ownership 融合信号与失败回滚，每一步都参与它的生命周期记账。复刻其中一段会把原生会话换成残缺实现——实测表现为**会话文件建好、header 写入，之后再无任何事件，既打不开也发不出消息**，而 Claude Code 会话因为走另一条路径反而正常。
  代价：原生会话不再登记 record/handle，因此**不能**在空白会话内原地切到本插件引擎——宿主（dsh-agent-preset-registry）的预设切换是「原地重挂组合」，会把 Claude Code 预设挂到原生 Agent 上并向 UI 报告成功，但真正的引擎接管要等下次 resume（重启 / 重新打开会话）时按持久化日志判定；本插件会话切回 standard 则会**当场**用原工厂的 prepare() 换回原生循环，无需重建会话。
- **轨迹映射**：`request/header` 只记录模型与工具表；同一 API 响应中共享 `message.id` 的 assistant 分块合并成一个 `step`，再配对真实工具结果。只有确实缺失结果时才补兜底错误，不把并行工具分块误判为中断。`request/context` 记录上下文窗口。
- **工具结果里的图片不再被丢弃，但只有「轨迹」视图会把它当图画出来**。Claude 的 `Read` 读图时，回执是一条内联 base64 的 `tool_result`；旧实现直接丢块，用户看到的是「模型描述了一张界面上不存在的图」。现在这些字节在消息进 tracer 之前先交给宿主附件库（`ctx.get("attachments").saveImages`），事件里只留持久引用 `{type:"image", attachment:{attachmentId, mediaType, width, height, bytes}}`，base64 不进会话日志；附件服务缺失、URL 形式、形状不支持或落盘失败时写**带原因的文字占位**，绝不静默丢（见 `lib/tool-result-images.mjs`）。**实机核验（2026-10-15，隔离 web 实例）**：`Read` 一张 64×64 的 PNG，字节落在 `<DSH_HOME>/attachments/v1/objects/…`，**「轨迹」视图的工具详情「结果」区渲染出真图**（工具行摘要标 `图片 ×1`，DOM 里是 64×64 的 blob 图）。**「对话」视图仍显示该块的 JSON**：DSH 的图片画廊卡片只认原生 `read_image` 的调用形状与它那套模型面 envelope 文本，而 Claude 的 `Read` 映射成 `read`、也不产出该 envelope，于是走通用卡片（`resultText`：非文本块 pretty JSON）。要进画廊只能伪造 DSH 原生工具身份和信封文本（那段文本会被画廊原样显示给用户），属于编造内容，故不做。附带一条如实记录：`data.meta` 仍可能带 CLI 自己的 `file.base64`（小于 16 KiB 上限的图会落盘，更大的图整条 meta 被丢弃），前端不读这个字段。
- **休眠 LLM 路由**：`claude-code` 注册进 `ctx.llm` 但从不转发请求，只为让前端模型选择认为该 provider「已被服务」——否则首轮之后输入框会自锁。

## ⚠️ 已知限制

- **审批桥不等于 DSH 的执行沙箱，但 `read-only` 的写限制会自己落地**。Claude 内建工具不经过 DSH 的文件系统/进程执行器，DSH 文件沙箱的 `writableRoots` 对它们无效，所以插件按 sandbox mode 自己补一层：`read-only` 下 `Write` / `Edit` / `MultiEdit` / `NotebookEdit` **一律拒绝**，不弹审批——不给「批准一次就放行」的口子（standard 会话在 read-only 下无论怎么批准都改不了文件）。`workspace-write` 下工作区内的 `blockedPath` 可自动放行，`never` 本身不授予写权限，Full access 维持既有交互。**`read-only` 下的 `Bash` 同路：默认直接拒绝**，理由是「这条命令是否写文件」无法静态判定，而 Claude 的 `Bash` 没有 DSH 文件沙箱兜底，留审批口子等于把 read-only 降级成「点一下就能写」；代价是 read-only 会话里连 `ls` 也用不了——要恢复旧的「批准一次就放行」须显式设 `engines.claude-code.readOnlyBash: "ask"`。**残余边界（诚实说明）**：这仍**不构成与 standard 等价的 OS 级隔离**——插件只在 `canUseTool` 被调用时判定，而 Claude 的沙箱/权限机制可能不调用它（见下一条）。

- **SDK 沙箱是唯一能拿到的真沙箱，但它不是 DSH 沙箱、也不是默认开的**。`engines.claude-code.sandbox` 会原样透传给 SDK 的 `sandbox`（`SandboxSettings`），不配则完全不传（行为与旧版一致）。三点必须知道：(1) 它依赖宿主系统能力——Linux 的 bubblewrap / macOS 的 `sandbox-exec`，Windows 上不生效；(2) 它约束的是 CLI 进程自己怎么执行，与 DSH 的 sandbox mode / fs 沙箱是两套互不联动的机制，插件不会拿它去推导 read-only，也不会因它放宽 read-only；(3) 命令在**真沙箱内**被 CLI 自行放行时，`canUseTool` 可能根本不被调用，此时上面的 read-only 判定不适用——那正是沙箱本身作为边界的场景。所以「配了 sandbox」不等于「read-only 更严」，两者是正交的。

- **不派发宿主 `agent/pre-step`**。那是原生循环装配 prompt 的管线（工作区指令、时间快照、plan-mode 段落、DSH 侧自动压缩都在这一步改写装配结果），而本插件的 prompt 由插件自己生成、真正发出的请求由 Claude Code CLI 装配——DSH 的装配结果从不上网。照搬会让工作区指令被注入两遍（CLI 本来就会加载），并让压缩/段落作用于模型看不到的节点。代价：goal 轮仍没有 standard 的私有 reservation fence（插件侧有限准入保护见下文），goal 轮也不按「独立请求序列」渲染请求头。论证与监听器清单见 `docs/superpowers/specs/2026-10-13-agent-pre-step-design.md`。

- **`/compact` 改不了 Claude 的真实上下文**。DSH 的 `/compact` 走 `ctx.compaction.compactNow`，压的是 DSH 会话日志的 surface 节点；Claude 的真实上下文在 CLI 进程里，由 CLI 自己按阈值压缩。插件**无法**触发 CLI 的压缩：SDK 的控制请求里没有 compact，而 CLI 自己触发时用的内部 `isMeta` 标记也不在 `SDKUserMessage` 上（实测把 `/compact` 当普通消息提交只会得到一轮零 step 的空回合）。所以 Claude Code 会话里按 `/compact` 只影响 DSH 显示面；长会话的自动压缩由 CLI 负责，代理不支持压缩请求时会以 `unrecognized_model … "query_source":"compact"` 硬失败并打挂整轮。详见 `docs/superpowers/specs/2026-10-13-claude-compaction-design.md`。**不过 CLI 自己的压缩不再是无声的**：它上报的边界与成败会记成 `claude-code/compact` 事实（带前后 token、耗时，失败时带 `compact_error`），压缩开始/成功/失败都可审计。DSH 面板的 context 分项是宿主自己的启发式估计，插件无法把 Claude 的真实分项喂进去（无接口），但压力条的分子/分母取的是真实用量与真实窗口。

- **预设的 `plugins` 列表就是会话的工具目录**。`@deepseek-ai/dsh-agent-preset` 把这里声明的行挂进 agent scope，会话能看到哪些工具完全由它决定；预设只写一行 persona，会话就一个工具都没有。本插件因此照搬 DSH 自带 `standard` 预设的工具集（`dsh-web-app` 的 `presets/standard.patch.yml`），只替换 persona 行。改预设时务必用宿主自己的 schema 校验，并保留 `test/cordis.patch.test.mjs` 里的回归护栏。
- **预设绝不能重复声明 host plane 已注册的工具**。`@deepseek-ai/dsh-tools` 的 `tools.register()` 先注册到全局、再注册到 agent 作用域，**同层同名直接抛错**：

  ```
  failed to create session "…": Error: tool "subagent" is already registered in this scope
  ```

  实测踩过：本插件曾照搬 `standard` 预设，连它的 `delegation` 组一起抄了进来（`tool-subagent` 声明 `toolName: subagent` 等 6 行）。而 `@deepseek-ai/dsh-base` 已经在 host plane 注册了这些行（`dsh-web-app` 只是把它们在 host plane 上 `disabled`，语义是「委派工具由预设层选择」）。在同时存在其它委派工具来源的部署里（例如 `dsh-experimental-agent-team-profile`），预设再声明一次就撞名，后果是**所有会话都创建不出来**——不只是选中本预设的会话。

  因此本预设**刻意不含** `delegation` 组：`subagent` / `subagent_fork` / `interrupt_agent` / `list_agents` / `send_message` / `workflow` 都由 DSH 的 host plane 提供。`test/cordis.patch.test.mjs` 有一条护栏断言这 8 个 id 不得出现。
- 预设同时也是**路由键**：只有路由到本插件引擎时，会话才由 Claude Code CLI 驱动；此时 Claude 用自带工具与默认人设。预设工具默认不转发；下述显式启用的工具桥只读取其中审计过的子集，不转发人设。
- 会话一旦发出第一条消息就锁定预设（DSH 的规则），不能再切引擎。
- Claude Code 内部子代理是**只读投影**：只映射成 lineage 树里的只读子会话展示轨迹，不挂主循环、不可续跑。为了让面板显示正确的运行状态，每个子会话另挂一个**只做状态载体的被动 Agent**（不驱动模型、不消费输入；面板的「正在运行／已完成／当前未运行」只认宿主注册表里的 Agent 状态）。
- 精确续接依赖插件旁路持久化（`~/.dsh/dsh-claude-code/sessions.json`）；该文件丢失时可能新建 Claude 会话，不能保证恢复原模型历史。**同一份映射还写了一份私有事实**（`claude-code/session`，fsync 落盘、按会话分文件），所以旁路表漏写/被半截文件覆盖时仍能恢复续接目标——查表没有再查事实，两处都没有才按新建处理（宁可失忆也不猜着接）。**DSH fork 会继承 Claude 的历史**：分叉会话以 `forkSession` 续接父的 Claude 会话，CLI 把转录复制到新会话 id——分叉出来的会话记得原来的对话，父会话不被续写。父会话还没有记录的 Claude 会话（或两处记录都丢失）时，分叉按新建处理，不猜着接。
- **系统提示词仅捕获观察快照**：`claude-code/prompt-snapshot` 标记为 `observed-compose`、`partial`、`compositionLoop: unattributed`。其他 mods 可能继续改写，捕获点也无法证明只属于主循环；目前不写原生 `system/message`，不冒充轨迹中的最终完整系统提示词。
- **会话里选的模型与推理档位现在会真正生效**。插件折叠最后一条 `model/selection`，把 `model` / `effort` 透传给 SDK 查询——此前模型只来自 CLI 自己的 env/settings，前端换模型等于没换。SDK 不认识的推理档位不会被猜测或强行映射。因此模型必须是本机 Claude CLI 能服务的 id。
- **提交不等于消费**：SDK 回显只是 acknowledgment；运行中人类输入须有匹配结果 UUID 的消费证据才提升 goal 权威。未确认输入记为 `uncertain`，不自动重发；`keepInbox` 保留未提交待办及可恢复 reservation，不能保证收回已交付输入。首批/运行中输入在 dequeue 前保存原队列，提交使用原子批次事实；steer 意图跨重启保留，旧 next-step 不猜测为 querying。显式停止收尾后，仍留在队列里、能自己成回合的待办（排队的 followup 或带 querying 意图的 steer）**会自动开始新回合**；纯 inject 仍不建立回合。
- 捕获失败通过脱敏 SDK 诊断记录 `capture-disabled` 并告警，不改变 prompt 或 goal adapter；共享能力探测的调用者可独立取消，不影响其他活跃调用者。
- **暂停目标须显式恢复**：`active + disarmed` 可由有权限的人类回合请求重新激活；`paused` 保持标准策略，只能通过 `/goal resume` 或目标条 ▶ 恢复。聊天里的“继续”并不保证恢复暂停目标。
- mod 检查失败或握手超时会记录 `claude-code/mod-status` 并保留 MCP。实测所选 CLI **2.1.296** 通过；SDK 附带 **2.1.220** 不支持本 mod 的 hooks 格式。插件不会自动升级 CLI。
- **子代理保持 one-shot，不能从这里续聊**。SDK 的控制请求里没有「给子代理发消息 / 恢复子代理」这一项；CLI 的 `SendMessage` 是**模型手里的工具**，插件无法代为调用。唯一的非模型通道是 mod 钩 `SubagentStop` 在子代理收尾时喂一段反馈——那是「再推它一把」，不是「点开子会话接着聊」。结构上子代理活在**父查询进程内**，父查询一结束转录只能读、不能对话。因此目录里**保持 `mode: "one-shot"`**，不为界面把 mode 改成看起来能继续。详见 `docs/superpowers/specs/2026-10-13-continuable-subagent-design.md`。
- **DSH 工具桥默认关闭、只开放审计白名单**：显式设置 `engines.claude-code.dshTools.enabled: true` 后，将当前 agent 可见的 `present` / `job_list` / `job_output` / `job_kill` 注册为 `mcp__dsh__*`。`names` 只能缩小这个集合，不开放动态工具、DSH bash/fs 或 job-start。优先取宿主 `wireSchemas(agent).schemas`，尊重 PTC 的 `run_code` 折叠；SDK 边界用 `z.fromJSONSchema` 转换完整对象。调用使用 CLI 的真实 tool-use ID，并重新核对查询、取消信号、原 agent 对象和工具可见性，再走宿主 `execute(exec)` 门控。缺少 CLI 身份元数据时拒绝执行，查询结束后旧 handler 失效。**仅主查询可使用这个父 agent 桥**：同一 ID 和工具名必须被主轨迹确认；子代理继承调用与未知归属均拒绝，绝不借用父目录、交付会话或 jobs owner。MCP 请求先到时最多等待 5 秒确认，取消/关闭会清理等待。真实隔离 web 实例已核实交付卡片、侧栏文件正文及原生 v4 日志；真实 SDK 注册与参数校验有回归覆盖。**jobs 是 DSH 的原生 registry，不包含 Claude 自己的后台任务**；宿主完成通知仍走原生 inbox。本桥不转发宿主 prompt 段落，也不替代标准主循环。设计与验收见 `docs/superpowers/specs/2026-10-14-dsh-tool-bridge-design.md`。
- **宿主 persona 按项转发、其余 prompt 装配不转发**：本插件不派发 `agent/pre-step`，所以宿主 `systemPrompt.assemble()` 的产物不会自动进 Claude 的请求。其中部署方在预设里写死的 persona 两段（`deployment:persona-prefix/suffix`）会被**显式**取来、按宿主变量插值后追加进 CLI preset（`systemPrompt.append`，见 `lib/host-persona.mjs`）；工具用法段落（描述的是 DSH 的工具）与 runtime 上下文（描述的是 DSH 的沙箱/审批边界，Claude 模式下生效的其实是本插件的 permission/approval 策略）**刻意不转发**。取不到、装配失败、变量缺失或段落标了 `complete` 时一律不转发并留 reason，不会把 `{{cwd}}` 之类未插值的字面量发给模型。**skills 不在此列**：它不是 prompt 段落，而是 DSH 的 `skill` 工具（`@deepseek-ai/dsh-skill-filesystem` + `@deepseek-ai/dsh-tool-skill`），要补齐须作为新工具桥条目单独审计批准。
- **goal 日志有限准入保护**：Goal 自动消息在准备前、异步准备后和日志写入口检查宿主公开状态；首批 SDK 交付前（包括 mod 握手和 MCP 回退后）再次核对已准入轮。运行中自动 goal 输入不受支持并在提交前拒绝。普通 followup、steer、inject 及 keepInbox 的原语义保留。读取失败不等于没有目标或自动恢复授权；已提交/不确定输入不自动重投。恢复会核对原生登记证据以避免重复 `user/message`。这是插件侧有限准入保护，不等价 standard 的私有 reservation/stale/content/fiber fence，不修复历史损坏日志。离线 Session/v4 重放不替代需另行批准的真实 Claude/宿主生命周期验收。
- **goal 续跑依赖 DSH host 平面的 goal 栈**（`dsh-goal` + `dsh-goal-round-driver`）。未装该栈的部署里 `goal.enabled` 自动失效（不挂工具、不加提示），`/goal` 行为回落到 DSH 原生（若该预设未挂 `command-goal`，则无 `/goal` 命令）。
- **Windows 上解不开的 `.cmd`/`.bat` shim 被拒绝，不交给 SDK 去撞 errno**。npm 装的 `claude` 常是批处理 shim，升级中途它引用的可执行文件可能不在盘上。Claude Agent SDK 只按扩展名决定要不要用 node 起脚本，`.cmd` 会被它当原生可执行文件直接 spawn，而 Node 自 CVE-2024-27980 起同步抛 `spawn EINVAL`——用户只看到一个 errno，既不知道是哪个文件也不知道怎么修。插件改为：解析时跳过解不开的 shim、继续按 PATH 找可 spawn 的候选；一个都没有时以带路径与修复方向的可读错误拒绝整轮（`lib/auth.mjs` 的 `cannotSpawnDirectly`）。

## 🛠️ 图片输入排查

如果发送图片得到 `session/attachment-invalid` / `MODEL_DOES_NOT_SUPPORT_IMAGES`，拒绝发生在 DSH 的消息准入阶段，尚未进入 Claude Code 插件。插件能转发图片，并不代表当前模型已被宿主声明为支持图片。

使用 `@deepseek-ai/dsh-llm-pi-ai` 的自定义模型别名时，应在该 provider 的**具体模型条目**中声明真实能力，例如：

```yaml
models:
  - id: your-vision-model-alias
    name: Your vision model
    input: [text, image]
```

这里的配置键是 `input`（不是解析结果里的 `inputModalities`）；未知自定义模型省略它会保守地默认为纯文本。此配置属于宿主模型 provider，不属于 `engines.claude-code`。不要为混合模型目录统一开启图片，也不要给实际纯文本模型添加图片能力。重载配置或重启 DSH 后确认模型元数据；准入通过仍不等于上游网关实际接受图片，需要另行验证。

## 🧪 开发

```sh
pnpm install
pnpm test        # 队列 / 权限 / 轨迹 / 子代理 / 路由 / goal / mods / prompt / 输入控制回归
```

第一期的输入语义、mods 配置、离线校验与限制见 [交互与桥接指南](docs/guides/interaction-and-mods.md)。
CLI 的 `plugin validate` / `plugin test` 不调用模型；真实桌面/推理测试需单独确认预算。

## 📄 许可证

MIT。第三方组件见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
