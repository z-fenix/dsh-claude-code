# dsh-claude-code 设计说明

本目录记录这个插件的设计取舍与 DSH 版本适配要点。只想知道怎么装、怎么用，看
[README](../README.md) 就够。

## 它解决的问题

DSH 默认把会话交给内置的 `ReactLoopAgent`（DeepSeek）。本插件让**同一台机器上的 Claude
Code CLI 也能当主循环**，而不改动 DSH 本身：

- 用户侧：agent 预设列表多一个「Claude Code」，选中即用；
- 系统侧：不改 `agent-loop`，不替换任何 DSH 包，只是一个普通 profile 插件。

## 为什么不能直接 `ctx.agents.setFactory()`

DSH 0.2.0-rc.2 的 `AgentRegistry.setFactory()` 在槽位已被占用时**抛错**
（`an agent factory is already registered`），而工厂槽位由 `dsh-base` 里的 `agent-loop`
行在构造时注册。插件一定后加载，所以这条路是死的。

槽位本身是普通字段：

```js
ctx.agents.factory = { target: router };   // 接管
```

`setFactory()` 的调用方与 `create()/resume()` 都读 `factory?.target`，因此直接替换字段是
可行的接管方式；本插件在自己的 `ctx.effect` 释放时把原工厂换回去，保证热插拔安全。

## 三条路由路径

| 场景 | 判定依据 | 动作 |
|---|---|---|
| 新建会话 | `options.meta.agentPreset` | 命中本插件引擎 → 自造会话 + `ClaudeCodeAgent`；否则走原生 `ReactLoopAgent` |
| 恢复会话 | 持久化日志反推预设（`agent-preset/selected` 末条优先，其次 header） | 命中 → 自己重建会话；否则委托原工厂 |
| 空白会话内切预设 | `agent-preset/selected` 事件 | **原地换 Agent**：只拆 agent、保留会话 |

第三条是关键。DSH 只允许「还没出过回合」的会话切预设，而用户在 GUI 里选预设正是在这个
阶段。若走「整会话重建」，会触发 `session/disposed` → `session/created`，客户端会把会话
标记成 removed 并锁死输入框。所以本插件自己 publish（顺序与原生完全一致：

```
sessions.enter → agents.enter → sessions.announce → agents.announce
```

），把**会话的 detach 闭包**握在自己手里（`SessionLease`），换 Agent 时把它交给下一个
Agent，会话始终留在 store 里。

> 这也是为什么 `createAgent` 走原生循环时**不**直接调用 `original.createAgent()`，而是用
> `original.prepare()` 造出 `ReactLoopAgent` 后由本插件 publish —— 原生那条路会把 detach
> 闭包留在 `AgentLoop` 自己的 ownership 里，插件此后就拿不回来了。

## 为什么自造会话重建要读持久化

resume 时不能只看 header：会话可能在空白期切过预设，header 记的是创建时的值。必须按
「日志里最后一条 `agent-preset/selected`」判断，这与 DSH 自己的
`resolveSessionPreset` 语义一致。

重建走公开面：`sessionPersistence.open(id,'write')` → `handle.read()` →
`sessions.prepare(id, { seed, meta, inheritedEventCount, eventState })` →
`SessionPreparation.create()`，与 `AgentLoop.resume()` 的做法相同。

## 预设是 Loader 行，不是目录

DSH 0.2.0-rc.2 起，agent 预设由 `@deepseek-ai/dsh-agent-preset` 插件行声明：

```yaml
- insert:
    - id: preset-claude-code
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: claude-code
        name: Claude Code
        description: ...
        order: 99
        plugins: [ ... ]
```

`~/.dsh/.agent-presets/<id>/{preset.yml,agent.cordis.yml}` 那套目录式预设**已不再被读取**。
因此本插件的 `cordis.patch.yml` 同时插入「插件行」与「预设声明行」，两者都随着包被 profile
的 bundle 层自动应用。

## 事件映射

一次 Claude 查询 = 一个 DSH 回合；一条 Claude assistant 消息 = 一个 step。

```
turn/start                     （agent.mjs）
  request/header               （模型 + 工具表 → 上下文构成投影）
  step/start
    assistant/message          （content + stream + usage）
    tool/call ×N
    tool/result ×N
  step/end
  request/context              （上下文窗口）
turn/end                       （agent.mjs）
```

两个容易踩的点，都由测试固定住：

1. **用量必须与消息同一条事件落盘**。`dsh-token-meter` 的 `usageOf()` 只读
   `assistant/message.data.usage` 或它内嵌 `stream` 里的最后一个 `usage` 分片；因此
   trace 会**延迟结算**最后一条助手消息到 `result` 事件，把 `result.usage` 兜底写进去。
   消息一旦落盘，晚到的用量补写不在 token-meter 的读取路径上。
2. **实时帧只承载增量**。`agent/assistant-stream` 的 chunk 会让客户端自增渲染，所以帧里
   只放文本 / 思考 / 工具入参分片，不放整块内容。

## 与参考实现的关系

参考项目 `dsh-engine-switch` + `dsh-claude-code` 面向 DSH `0.1.0-rc.6`。本插件是面向
`0.2.0-rc.2` 的独立实现，主要差异：

| 主题 | 0.1.0-rc.x 参考实现 | 本实现（0.2.0-rc.2） |
|---|---|---|
| 预设声明 | 磁盘目录 + `preset.yml` | Loader 行（`@deepseek-ai/dsh-agent-preset`） |
| 待办队列 | 复用 `dsh-agent` 导出的 `Inbox` | `dsh-agent` 不再导出，自持 `DshInbox`（投影 key `inbox` 由 agent-loop 注册） |
| 流式 | `assistant/chunk` 事件 | 事件已移除 → `agent/assistant-stream` 帧 + `assistant/message.stream` |
| 会话历史读取 | `session.events` | `session.snapshotEvents()` |
| 用量来源 | `message_delta` 写在消息之后 | 延迟结算到 `result`，与消息同事件 |
| 引擎依赖 | 必须先装 `dsh-engine-switch` | 自包含；引擎注册表作为服务暴露，别的插件可选接入 |

## 环境注意事项：profile 的共享 node_modules 可能是旧版

DSH 的 profile 会复用 `~/.dsh/profiles/node_modules` 这个共享依赖目录，它可能是**旧版
DSH** 安装留下的（例如本机是 `0.1.0-rc.8` 的 pnpm 链接），而桌面应用跑的是 `0.2.0-rc.2`。

本插件对此的处理：

- 自己真正 import 的 `@deepseek-ai/dsh-*` 一律声明为**精确版本依赖**，安装时会落到插件
  自己的 `node_modules`，优先于共享目录；
- 可选协作者（`dsh-subprocess`）用「懒加载 + 本地兜底」，解析不到也不影响插件加载。

如果预设行里的 `@deepseek-ai/dsh-persona` 解析到了旧版（行会在预设列表里显示为 broken），
把共享目录里对应的包换成桌面版同版本即可，例如：

```sh
cd ~/.dsh/profiles
pnpm add @deepseek-ai/dsh-persona@0.2.0-rc.2
```
