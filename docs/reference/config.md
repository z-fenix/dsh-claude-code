---
type: Reference
title: 配置项
description: dsh-claude-code 的全部配置字段、默认值与生效位置。
resource: index.mjs
tags: [config, reference]
timestamp: 2026-08-14
---

# 生效位置

插件配置写在 profile 的补丁层，按行 id 覆盖：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: dsh-claude-code
  name: dsh-claude-code        # 必填：覆盖整行 config 时必须写回 name
  config:
    enabled: true
    defaultEngine: deepseek
    engineByPreset: {}
    engines: {}
```

随包的 `cordis.patch.yml` 提供的是默认值；profile 补丁层与 home 补丁层可以再覆盖。

# 插件级字段（`Config`）

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总闸。`false` 时 `apply()` 早退：不接管 agent factory、不注册 LLM 路由，所有会话走原生循环 |
| `defaultEngine` | string | `"deepseek"` | 没有命中 `engineByPreset`、也不是某个引擎自带预设时使用的引擎 id。`"deepseek"` 是保留哨兵，表示「回原生 `ReactLoopAgent`」 |
| `engineByPreset` | Record<string, string> | `{}` | 预设 id → 引擎 id 的**显式覆盖**，优先级高于「预设 id 即引擎 id」的自动映射 |
| `engines` | Record<string, any> | `{}` | 引擎 id → 该引擎的私有配置。插件不解析、不校验，原样交给引擎的 `makeAgent` |

# 路由判定顺序

给定一个预设 id，引擎这样选：

1. `engineByPreset[presetId]` 命中 → 用它；
2. 否则预设 id 恰是一个已注册引擎的 id（by-id 映射）→ 用那个引擎；
3. 否则 `defaultEngine`；
4. 结果是 `"deepseek"`（或空、未注册）→ 交给原生 `ReactLoopAgent`。

预设 id 为空 / 非字符串时直接走 `defaultEngine`。

# 引擎私有配置：`engines["claude-code"]`

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `executable` | string | `"claude"` | claude 可执行文件。含路径分隔符时按绝对路径使用，否则先经 `ctx.subprocess.resolveExecutable` 解析、失败再退回本地 PATH 扫描（Windows 会补 `PATHEXT` 后缀） |
| `persistSession` | boolean | `true` | 跨轮复用同一个 Claude 会话。`false` 时每轮新开 |
| `includePartialMessages` | boolean | `true` | token 级流式（`stream_event`）。关闭后只剩整块 `assistant` 消息，界面不再逐字刷新 |
| `traceSubagents` | boolean | `true` | 把 Claude Code 内部子代理（Agent / Task 工具）映射成独立只读 DSH 子会话。关闭后这些消息被丢弃，主轨迹更干净 |
| `env` | Record<string, string> | `{}` | 追加给 claude 子进程的环境变量，覆盖父环境同名值（如 `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`） |
| `contextWindow` | number | 未配置 | 手动指定模型上下文窗口（token 数）。SDK 的 `result.modelUsage` 取不到时用它兜底 |

> 环境合成顺序：`scrubbedParentEnv()`（清洗掉凭据类与 `DSH_*`）→ 补回父环境的
> `ANTHROPIC_*`（claude 需要它们认证）→ `env` 显式覆盖。

# 暴露给其他插件的服务

| 服务 | 内容 |
|---|---|
| `ctx.claudeCodeEngines` | `EngineRegistry`：`register(engine)` / `get(id)` / `list()`。第三方插件 `inject: ["claudeCodeEngines"]` 后可注册自己的引擎，复用同一套预设路由与空白会话内切换 |

引擎记录的形状：

```js
{
  id: "my-engine",              // 必填；同时是它自带预设的目录/声明 id
  name: "My Engine",            // 预设显示名
  description: "...",           // 预设描述
  presetDir: undefined,         // 可选（0.2.0-rc.2 不再有磁盘预设目录，保留字段仅作信息）
  makeAgent(loopCtx, id, options, session, engineConfig) => DSH Agent
}
```

`makeAgent` 必须返回满足 `@deepseek-ai/dsh-agent` 的 `Agent` 接口的对象：
`id` / `session` / `ctx` / `inbox` / `status` / `options` / `send` / `followup` / `steer` /
`inject` / `cancel` / `whenIdle` / `runMaintenance`（本插件的 `ClaudeCodeAgent` 是完整示例）。
