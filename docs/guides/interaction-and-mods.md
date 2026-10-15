---
type: Guide
title: 运行中输入与 mods 桥接
description: 第一期输入、goal、子代理和 prompt 捕获的用法及边界。
tags: [guide, input, mods, goal]
timestamp: 2026-10-13
---

# 第一期的使用边界

Claude 拥有实际执行循环；DSH 拥有会话、队列、目标权威和日志写入。此次实现改善交互与可观测性，
不将 DSH standard 的整个工具/沙箱/上下文系统转发进 Claude，也不改 standard 会话的原生路由。

## 运行中输入

| 宿主接口 | 行为 |
|---|---|
| `followup` | 普通待办留在 next-turn，当前查询结束后另开一轮，不自动打断 |
| `steer` | next-step 进入当前仍可接受输入的查询；查询已进入 EOF 排空时留在宿主队列供下一轮 |
| `inject` | next-step 且 `shouldQuery:false`；不独自唤醒查询，等待下一条 querying 输入 |
| `cancel` | 先 SDK interrupt，再有界关闭 query；默认清空待办 |
| `cancel(..., {keepInbox:true})` | 保留未提交待办及可恢复 reservation，但不自行恢复运行，也不收回已提交的输入 |

保留原消息 id/source；图片与普通输入走同一附件转换。准备期间的编辑/删除会使原 snapshot 失效，
不能把旧内容偷偷提交。已有查询的迟到回调不能把输入交给下一份 query。

首批和运行中输入都先保存含原队列、位置和 querying 意图的 reservation，再 durable dequeue。
日志拒写或启动崩溃时，可证明尚未提交的 reservation 会对账回原 inbox；整批提交使用一条原子边界事实，
不会因逐条写 submitted 中途失败而留下半批遗失。编辑/删除/明确清空不会恢复旧文本或复活已取消消息。
steer 的 querying 意图跨重启保留，显式 wake 仍有效；缺少意图的旧 next-step 记录保守地按 inject 处理。

`submitted` 是交付前的保守提交边界，不证明 CLI 已收到或模型已消费。SDK replay 是收到回执，不是消费；
只有匹配的 success 结果 UUID 才把该批运行中消息计入 goal 的已消费权限来源。边界之后的未确认输入
会记录为 `uncertain`，不会自动重发，即使崩溃实际上发生在 SDK 读取之前。
如果界面显示已发出而结果不明，应先检查该状态，不要把取消视为“没有执行”——尤其是写入/进程操作。

## Goal 的两种适配器

```yaml
engines:
  claude-code:
    mods:
      enabled: true
      handshakeTimeoutMs: 8000
    goal:
      enabled: true
      transport: mcp  # mcp（默认）/ mod / auto
```

- `mcp`：SDK 进程内 goal server；observer 若支持仍可捕获 prompt，但不会注册 goal 工具。
- `mod` / `auto`：能力验证及注册握手成功时由随包 mod 提供 goal 工具，失败回 MCP。
- 一份 query 只选一套。MCP 名为 `mcp__goal__get_goal/create_goal/update_goal`；mod 名为
  `mcp__dsh-bridge__get_goal/create_goal/update_goal`，不是任意前缀自动放行。
- mod 工具结果保留 MCP 的 JSON 文本语义，符合原生工具输出类型，不直接返回 JavaScript 对象。
- 两者都调用同一 `goal-domain`。宿主验证 live/running agent、当前 turn 来源、revision CAS、goal round
  和 blocked 轮数阈值；mod 不能通过参数伪造人类身份，也不能建立另一套 goal 状态。
- 未安装 DSH goals 服务或 `goal.enabled:false` 时，不注册 goal 工具。observer 是独立能力。

**恢复注意：**会话恢复后的 `active + disarmed` 与真正 `paused` 不同。前者可在有权限的人类回合中
重新激活；后者保留标准限制，模型恢复会被拒绝。用 `/goal resume` 或目标条 ▶ 恢复 paused 目标。
普通聊天“ok，继续”可能继续对话，却没有恢复目标。宿主自然语言恢复需要另行批准授权规则，当前未实现。

## Mods 的离线能力检查

插件对**实际选中的 executable**运行这两项，不按版本号猜测：

```sh
claude plugin validate mods/dsh-bridge
claude plugin test mods/dsh-bridge
```

它们不进行模型推理。能力结果按 executable 与 mod 文件修改时间缓存；共享探测使用独立的取消信号。
每个调用者取消后独立退出，不会使其他活跃调用者降级；最后一个等待者退出才取消子进程并移除未完成缓存。
握手分绑定 session/agent/epoch 和工具注册完成两步。未就绪前不发送用户输入；失败查询关闭后用新的
MCP 查询发送首批输入，不尝试重放已交付消息。状态写入 `claude-code/mod-status`。

2026-10-13 本机证据：

- 所选安装 CLI **2.1.296**：validate 通过，native mod tests **6 pass / 0 fail**。
- SDK **0.3.220** 附带 CLI **2.1.220**：validate 拒绝 hooks 格式，返回
  `hooks: Invalid input: expected record, received undefined`；生产 probe 判定 unsupported，保留 MCP。
- 实际 SDK + 所选 CLI 的**零输入探测**成功完成就绪握手、注册三个 goal 工具：无用户输入、无 goal 调用、
  无模型消息；使用无效凭据和 loopback 模型端点。它证明加载能力，不证明桌面/真实模型端到端行为。

mod 只加载到该 Claude 子进程，保留既有 env/plugin 配置，不修改全局 settings 或 DSH app.asar。
宿主桥只监听 127.0.0.1，使用短期随机令牌及严格方法白名单，绑定 session+agent+epoch+Claude session。
拒绝子代理 goal 调用、未知方法、错身份、过大请求、冲突重放和超时；重复请求 id 不重复执行变更。
不要把 bridge token、URL 或描述环境变量写入模型提示词、文档示例或真实日志。

## 私有台账与重启兼容

`claude-code/input*`、`prompt-snapshot`、`mod-status` 是插件事实，不写入 DSH 原生日志。
它们同步保存到 `${DSH_CLAUDE_CODE_STORE:-~/.dsh/dsh-claude-code}/facts/<会话id摘要>.jsonl`；
提交事实写入并 flush 成功后才发送 SDK 输入。原生日志锚点用于恢复顺序；submitted 无消费证据仍为
uncertain，不自动重投。私有 `factSeq` 与 DSH `seq` 是不同序号。

不要单独删除 `.jsonl`、`.required` 或锁文件。台账缺失（已有 manifest）、损坏、身份/锚点不匹配或
并发写入会明确失败，不当成空台账继续运行。正常释放会话会移除写锁；已退出进程的旧锁可回收。
异常遗留的锁 guard 需在确认所有写入者退出后检查，不自动强行解锁。备份/迁移应同时保留原生日志与
插件台账。fork 的台账继承仍属于后续功能，不能宣称原生日志单独复制即可精确恢复插件输入事实。

旧版本已经写入原生日志的六类私有事件可保留并被插件折叠；历史修复必须停写、保留原压缩字节备份，
仅补顶层 `ignorable:true`，通过真实宿主完整读取校验后才替换。当前 DSH 的 `Session.append` 不保存该
选项，因此“给 append 加 ignorable 参数”不能防复发。不放行其他未知事件或改写原生业务类型。

## 提示词捕获不是最终全文

`claude-code/prompt-snapshot` 保留 hook 的 sections 原样，标记：

```text
source: observed-compose
completeness: partial
compositionLoop: unattributed
```

一次 snapshot 失败会关闭本查询的后续捕获，但原 composition 保持不变。mod 通过独立于 HTTP 桥的
SDK `system/ui_log` 发送一次固定脱敏诊断；宿主记录 `claude-code/mod-status: capture-disabled` 并告警，
不会因此换 goal adapter 或重启查询。该通知没有 token、URL、prompt 正文，也不进入模型提示词。

其他外层 mods 仍可修改组成；hook 没有可证明的循环归属。绑定宿主 agent 只是通道所有者。
因此目前没有把它投影成原生轨迹“系统提示词”节点，没有 `system/message` 或 `request/header.system`。
也不从 assistant 文本、system/init、token 分类反推系统提示词。原生展示仍需证明首 user surface 顺序、
模型请求前落盘、最终完整性和循环身份，不能仅把快照倒插进去。

## 子代理与工具轨迹

新子会话显示短任务 label，控制序列清洗且 Unicode 安全截断；provider 保留在 descriptor。
原生自动 `session/title` 必须引用本子会话已存在的人类 `user/message`；只读投影没有该来源，当前不写
自动来源/类型标题，不通过伪造人类输入或 `source.kind:user` 绕过约束。实测前已写入的旧标题不自动修复。
仍为 one-shot 只读投影，运行态由被动载体 Agent 提供。没有伪造“可继续”，没有重写历史标题或 token。
列表用量是实际累计消耗，不等同于当前模型上下文占用。

同一 API 响应的多个 assistant 分块按 `message.id` 聚合，工具结果成对落盘。真正缺失结果仍记录兜底
错误以避免日志损坏；不会因并行 Read/Grep 分块就提前写 interrupted。旧历史中的误报不自动重写。

## 验证与后续阶段

`pnpm test` 覆盖输入、审批、goal、mod host、prompt、轨迹和路由；native v4 校验离线验证事件关系。
真实桌面/模型调用没有纳入离线通过声明，需单独批准预算。链接安装修改后重启 DSH 重新加载源码。

第二、三期**已交付**的部分：宿主 persona 段落按项桥接（`lib/host-persona.mjs`）、DSH fork 继承
Claude 历史（`forkSession`）、会话所选模型/effort 真正转发、工具结果里的图片落成附件引用
（`lib/tool-result-images.mjs`，只有「轨迹」视图画图）、Claude 文件工具补派发进宿主
`tools/pre-execute`（`lib/host-tool-gate.mjs`，非 Git 工作区也能出改动卡片）、scope-aware 工具桥
（默认关闭，仅 `present` / `job_*` 白名单）、SDK 沙箱透传 + `read-only` 硬拒绝。

**仍未交付的三项，卡在宿主/CLI 一侧**（不是插件没写，也不是「以后再说」）：

| 项 | 卡在哪 | 谁能解开 |
|---|---|---|
| 实际 Claude compact（DSH `/compact` 压不到 CLI 的真实上下文） | SDK 控制请求里有 interrupt / 权限 / 模型，**没有 compact**；CLI 自触发压缩用的内部 `isMeta` 标记不是 `SDKUserMessage` 的字段 | Claude Agent SDK / CLI 暴露压缩请求，或允许插件注入该标记 |
| 可续跑子代理 / workflow | 子代理活在**父查询进程内**，父查询结束转录只读；SDK 没有「给子代理发消息 / 恢复子代理」的控制请求，CLI 的 `SendMessage` 是**模型手里的工具** | Claude Code 暴露子代理会话地址，或允许父进程代发消息 |
| DSH 面板里的真实 context 分项 | 分项是宿主自己的启发式估计；Claude 的真实分项只存在于 CLI 进程内，插件没有写入通道 | DSH 开放分项注入 seam，或 SDK 上报分类用量 |

同一类边界还有一条：`read-only` 的写限制与 SDK 沙箱透传已落地，但「让 Claude 的工具走 DSH 的文件/
进程执行器」需要宿主把 CLI 的执行纳入自己的执行器，属宿主侧改造。

**插件刻意不做的一项**：skills 不是 prompt 段落而是 DSH 的 `skill` 工具，补齐属新工具桥条目、需单独
审计批准（见 README 的工具桥白名单）。未经各期审批，不自动扩大实现范围。
