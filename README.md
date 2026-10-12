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
- **🔐 权限桥接**：DSH 的沙箱模式 + 审批策略映射到 Claude 的 `canUseTool`（工作区内写放行、区外弹 DSH 审批）；`AskUserQuestion` 用 DSH 的选择题 UI 作答。
- **🧰 预设自带完整工具目录**：预设的 `plugins` 列表就是该会话的工具目录来源，所以 `claude-code` 预设声明了与 DSH 自带 `standard` 预设等价的工具集（文件、搜索、shell、子代理、网络…），只把人设换成 Claude Code。**预设里省掉工具行 = 会话没有任何读写工具**，模型只能回答“我读不了文件”。
- **⏯️ 精确续接**：Claude 会话 id 旁路持久化，重启后续聊接回**同一个** Claude 会话。
- **🌐 子代理照旧 DeepSeek**：不管主会话选了谁，子代理都走原生循环。
- **🧩 可扩展**：引擎注册表暴露为 `ctx.claudeCodeEngines`，别的插件可以注册自己的引擎，复用同一套「预设 → 引擎」路由与空白会话内切换。
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
> 链接安装的附带好处：改本仓库源码立即生效，无需重装。

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
        goal:
          enabled: true                    # 默认开：把 goal 工具桥接进 Claude Code
          blockedAfterConsecutiveRounds: 3 # 同一阻塞条件连续多少轮才允许标记 blocked
          # defaultMaxGoalRounds: 256      # 可选：模型未给 max_goal_rounds 时的兜底
        env: {}                          # 例如 { ANTHROPIC_API_KEY: sk-... }
        contextWindow: 200000            # 可选：SDK 取不到时兜底
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
| `engines.claude-code.goal.enabled` | `true` | 是否把 `get_goal`/`create_goal`/`update_goal` 桥接进 Claude Code（会话可用 `/goal` 自动推进） |
| `engines.claude-code.goal.blockedAfterConsecutiveRounds` | `3` | 同一阻塞条件连续达到多少个 goal round 才允许模型标记 `blocked` |
| `engines.claude-code.goal.defaultMaxGoalRounds` | 未配置 | 模型调 `create_goal` 未给上限时的兜底轮数（默认走 DSH 的 256） |

## 🔍 原理（可选阅读）

- **预设是 Loader 行，不是目录**。DSH 0.2.0-rc.2 起，agent 预设由 `@deepseek-ai/dsh-agent-preset` 插件行声明（`config.id` / `name` / `description` / `order` / `plugins`），旧的 `~/.dsh/.agent-presets/<id>/` 目录已不再被读取。本包的 `cordis.patch.yml` 就是一条这样的声明。
- **路由靠接管 agent factory 槽位**。`ctx.agents.setFactory()` 在已有工厂时会抛错，而后加载的插件必然晚于 `dsh-base` 的 agent-loop 行；槽位是普通字段（`{ target: factory }`），插件替换它、并在自己的 fiber 释放时换回原工厂。**拿不到工厂时抛错**（而不是 warn 后静默返回）：静默降级的后果是预设列表里出现一个没有任何主循环接管的 Claude Code 预设，用户只能看到「模型自称 Claude Code 却没有工具」，无从归因。
- **只有本插件引擎的会话被接管，其余整条委托回原工厂**。新建会话按 `meta.agentPreset` 路由，resume 先读持久化日志反推预设（空白期切过预设的会话必须按日志而不是 header 判断）；只要解析结果不是本插件引擎，`createAgent`/`resume` 都直接转交 `@deepseek-ai/dsh-agent-loop`。
  为什么不让原生会话也走自己的实现：AgentLoop 的建会话链路包含 `ownership.trackWrapper` → `setupAndPublish`（`raceAbort(options.setup)` + `interruptedTurnClosers` + `appendUnstoredSuffix`）→ `raceAbortCall` → owner/ownership 融合信号与失败回滚，每一步都参与它的生命周期记账。复刻其中一段会把原生会话换成残缺实现——实测表现为**会话文件建好、header 写入，之后再无任何事件，既打不开也发不出消息**，而 Claude Code 会话因为走另一条路径反而正常。
  代价：原生会话不再登记 record/handle，因此**不能**在空白会话内原地切到本插件引擎——宿主（dsh-agent-preset-registry）的预设切换是「原地重挂组合」，会把 Claude Code 预设挂到原生 Agent 上并向 UI 报告成功，但真正的引擎接管要等下次 resume（重启 / 重新打开会话）时按持久化日志判定；本插件会话切回 standard 则会**当场**用原工厂的 prepare() 换回原生循环，无需重建会话。
- **轨迹映射**：`request/header`（模型 + 工具表，供上下文构成投影）→ 每个 Claude assistant 消息一个 `step`（`step/start` → `assistant/message`（含 `stream` 与 `usage`）→ `tool/call` → `tool/result` → `step/end`）→ `request/context`（上下文窗口）。
- **休眠 LLM 路由**：`claude-code` 注册进 `ctx.llm` 但从不转发请求，只为让前端模型选择认为该 provider「已被服务」——否则首轮之后输入框会自锁。

## ⚠️ 已知限制

- **预设的 `plugins` 列表就是会话的工具目录**。`@deepseek-ai/dsh-agent-preset` 把这里声明的行挂进 agent scope，会话能看到哪些工具完全由它决定；预设只写一行 persona，会话就一个工具都没有。本插件因此照搬 DSH 自带 `standard` 预设的工具集（`dsh-web-app` 的 `presets/standard.patch.yml`），只替换 persona 行。改预设时务必用宿主自己的 schema 校验，并保留 `test/cordis.patch.test.mjs` 里的回归护栏。
- **预设绝不能重复声明 host plane 已注册的工具**。`@deepseek-ai/dsh-tools` 的 `tools.register()` 先注册到全局、再注册到 agent 作用域，**同层同名直接抛错**：

  ```
  failed to create session "…": Error: tool "subagent" is already registered in this scope
  ```

  实测踩过：本插件曾照搬 `standard` 预设，连它的 `delegation` 组一起抄了进来（`tool-subagent` 声明 `toolName: subagent` 等 6 行）。而 `@deepseek-ai/dsh-base` 已经在 host plane 注册了这些行（`dsh-web-app` 只是把它们在 host plane 上 `disabled`，语义是「委派工具由预设层选择」）。在同时存在其它委派工具来源的部署里（例如 `dsh-experimental-agent-team-profile`），预设再声明一次就撞名，后果是**所有会话都创建不出来**——不只是选中本预设的会话。

  因此本预设**刻意不含** `delegation` 组：`subagent` / `subagent_fork` / `interrupt_agent` / `list_agents` / `send_message` / `workflow` 都由 DSH 的 host plane 提供。`test/cordis.patch.test.mjs` 有一条护栏断言这 8 个 id 不得出现。
- 预设同时也是**路由键**：只有路由到本插件引擎时，会话才由 Claude Code CLI 驱动；此时 Claude 用自带工具与默认人设，预设里的工具行不影响它（它们服务于原生循环那条路径）。
- 会话一旦发出第一条消息就锁定预设（DSH 的规则），不能再切引擎。
- Claude Code 内部子代理是**只读投影**：只映射成 lineage 树里的只读子会话展示轨迹，不挂 DSH Agent、不可续跑。
- 精确续接依赖插件旁路持久化（`~/.dsh/dsh-claude-code/sessions.json`）；该文件丢失时退化为重放。
- **goal 续跑依赖 DSH host 平面的 goal 栈**（`dsh-goal` + `dsh-goal-round-driver`）。未装该栈的部署里 `goal.enabled` 自动失效（不挂工具、不加提示），`/goal` 行为回落到 DSH 原生（若该预设未挂 `command-goal`，则无 `/goal` 命令）。

## 🧪 开发

```sh
pnpm install
pnpm test        # 156 个用例：待办队列 / 权限映射 / 轨迹映射 / 路由判定 / patch 校验 / apply 接线
```

## 📄 许可证

MIT。第三方组件见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
