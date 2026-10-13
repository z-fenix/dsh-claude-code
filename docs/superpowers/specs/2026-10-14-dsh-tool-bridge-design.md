# scope-aware DSH 工具桥：可行性、设计与风险

第三期最后一项「scope-aware DSH 工具桥（skills/persona/runtime sections、present、jobs、动态插件
工具）」的调查。结论：**机制存在且是宿主认可的路径，可以落地**；但开放哪些工具给模型是能力决定，
需要先定范围。调查对象是本机 DSH 0.2.0-rc.2（`resources/app.asar`）。

## 一、可用的宿主接缝（都已核实）

`ctx.tools`（`@deepseek-ai/dsh-tools` 的 `ToolRuntime extends Service`）正好提供了桥接需要的三件事：

| 方法 | 用途 |
|---|---|
| `schemas(scope)` / `wireSchemas(scope)` | 按 agent scope 给出可见工具的模型面 schema：`{name, description, parameters}`（另有 `knownNames` 与 PTC 模式的 `run_code` 折叠） |
| `get(name, scope)` / `resolveExecution(name, scope, nested)` | 取可见定义，并施加 PTC 模式的折叠规则 |
| `execute(exec)` | 执行一次调用；`exec = { callId, name, arguments, agent, signal }`，返回**最终物化结果**（`finishScheduledExecution` → `materializeFinalResult`），中途经过 pre-execute / 调度 / post-execute 全套宿主管线 |

这与本插件**已有的两条路**衔接得上：`createSdkMcpServer` + `tool(...)`（goal 桥就是这么做的，见
`lib/goal-bridge.mjs`）与随包发布的受限 mod（`$.tool.register` + `tool.call`，见 `mods/dsh-bridge`）。

## 二、日志不变量：桥接是安全的（只要选对工具）

DSH 的 surface event 只有五种消息类型（`system/developer/user/assistant/message`、`tool/result`），
其余都是**log-only**。桥进来的工具如果自己 append 事件（例如 `present` 会 append
`deliverables/presented`），只要是 log-only，在插件回合中途追加就是合法的——不触发
`surfaceOp` 闸门，也不影响 Claude 的 step 结构。

**但这条必须逐个工具核对**：任何会在回合中途写 surface 事件的工具，桥接后都可能把插件会话写坏
（最坏结果是会话永久打不开）。所以桥接对象必须是**白名单**，不能按前缀或「全部可见工具」放行。

## 三、权限模型

桥进来的工具名会进入 `canUseTool`。放行范围必须**精确到名字**（与 goal 桥的 `GOAL_TOOL_NAMES`
同一口径，不放行整段前缀）。被执行的是**DSH 侧的真实 handler**，它自带 DSH 的权限/审批语义
（`tools/pre-execute` 等），因此这条路不会绕过宿主自己的门控。

## 四、风险与边界

1. **能力放大**：白名单里的每个工具都成为模型可调用的动作。像 `present` 这种只读 cwd + 写一条
   log-only 事实的，风险低；带副作用（写文件、起进程、改配置）的必须逐个评估。
2. **命名冲突**：Claude 自带 `bash/read/edit/glob/grep/web/todo/skill/subagent` 等。桥接 DSH 的同名
   工具会得到两张脸（模型选谁不可控），所以**只桥 Claude 没有的**。
3. **schema 方言**：DSH 的 `parameters` 是它自己的 JSON Schema 方言（属性级 `required: true`、
   `additionalProperties` 等，见 `present` 的定义），`dsh-tools/lib/types/json-schema.js` 里有
   `assertSupportedJsonSchema` / `assertObjectJsonSchema` 做校验。桥接时**必须用宿主自己的投影**
   （`schemas(scope)`），不要手写转换——手写会随宿主方言漂移。
4. **schema 方言**：DSH 的 `parameters` 是它自己的 JSON Schema 方言（属性级 `required: true`、
   `additionalProperties` 等，见 `present` 的定义），`dsh-tools/lib/types/json-schema.js` 里有
   `assertSupportedJsonSchema` / `assertObjectJsonSchema` 做校验。桥接时**必须用宿主自己的投影**
   （`schemas(scope)`），不要手写转换——手写会随宿主方言漂移。
5. **两条注册通道接受的 schema 形态不同**（这是本项剩下最硬的一块）：
   - SDK 的 `createSdkMcpServer` + `tool(name, description, inputSchema, handler)` 要求
     `inputSchema` 是 **Zod raw shape**（`tool<Schema extends AnyZodRawShape>`，见 `sdk.d.ts`），
     而 DSH 给的是 JSON Schema 方言 —— 需要一次 **JSON Schema → Zod** 的转换（goal 桥之所以没这个
     问题，是因为它的 schema 本来就用 zod 写、再用 `z.toJSONSchema` 出 JSON Schema）。
   - mod 的 `$.tool.register({ inputSchema })` 接受 **JSON Schema**（现有 `mods/dsh-bridge` 正是把
     `z.toJSONSchema(...)` 的结果直接递进去，native `plugin validate`/`plugin test` 已通过），
     与 DSH 的方言更接近，但仍要核对属性级 `required: true` 这类方言糖能不能被 CLI 的注册校验接受。
   **两条路各有一次方言核对，必须真机验证，不能靠推断。**
6. **不该宣称的**：spec 明确「不宣称 standard 默认连接 MCP」。桥接是**插件自己起的**适配，不是
   standard 的默认行为。

## 五、建议的落地范围（待定）

按「Claude 没有 + 风险低 + 用户可见」筛：

| 候选 | 理由 | 风险 |
|---|---|---|
| `present` | Claude 无对等工具；只在 DSH UI 里登记交付物，append 的是 log-only 事件 | 低（只读 cwd 路径存在性 + 一条事实） |
| `jobs` | DSH 后台任务面板的入口 | 中（起/停进程，需按 DSH 自身权限走） |
| 动态插件工具 | 第三方挂进 agent scope 的工具 | 未知（取决于插件） |

`skills`/`persona`/`runtime` 属于**提示词截面**而不是工具：persona/runtime 段落由宿主的
`agent/pre-step` 装配注入，而本插件不派发该事件（见
`2026-10-13-agent-pre-step-design.md`），所以它们**不会**进 Claude 的请求——这部分要单独处理，
不能靠工具桥解决。

**默认建议**：白名单默认**为空**（不改变现状），由配置显式开启；首个落地目标选 `present`，
因为它的日志影响面已经核对干净、且用户可见。

## 六、验证计划

- 单元：schema 取自 `ctx.tools.schemas(agent)`（不手写转换）；白名单过滤；放行精确到名字；
  未在白名单的可见工具不注册。
- 真机（隔离 web 实例）：让模型调用一次桥进来的 `present`，确认 ① 工具出现在 request/header
  ② `deliverables/presented` 合法落盘 ③ 整条会话仍通过原生 v4 校验。
