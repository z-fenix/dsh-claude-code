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
  不能据此宣称已找到或修复 `spawn EINVAL` 根因；该启动诊断与工具桥的执行结果分开记录。
  验收后已卸载临时 fixture、移除 `mods:false` 覆盖；仅保留已授权的隔离 bridge 开关。
  已核对并停止专属 host PID，19399 无 listener，私密 bootstrap 删除；未改正式 profile。
- 主查询/子代理归属、提前到达、未知 ID、名字替换、等待取消/超时/agent 替换有真实 SDK
  回归，runner 在关闭 child 投影时仍拒绝借用父 scope。最终 fresh-context 审查只有这条
  Important/P2 finding，已由失败复现测试 RED→GREEN 修复，没有再派发重复审查。
- 完整 `pnpm test`：**313/313 pass**，0 failed/cancelled/skipped（带既有 experimental
  module mocking / namedExports 警告）；四个产品入口 syntax check、`git diff --check` 通过。
  `npm pack --dry-run`：39 files，包含 bridge，不包含 scratch/isolation/bootstrap/credentials。IDE build 不可用，因为本仓库未在 IDE 打开；没有构建其它项目。

## 六、仍不承诺的能力

桥不是标准主循环等价层。skills/persona/runtime 段落由宿主 `agent/pre-step` 装配，
本插件刻意不派发整条装配管线（见 `2026-10-13-agent-pre-step-design.md`），不能靠工具桥解决。
CLI 与 DSH jobs 是不同 registry；未提供同步、启动或恢复后台工作的能力。动态工具须重新
审计并单独批准，而不是加一个名字就得到通用桥接权限。
