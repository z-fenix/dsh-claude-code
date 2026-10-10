---
type: Index
title: dsh-claude-code 文档
description: 让 DSH 桌面版多一个「Claude Code」预设的插件：安装、配置、原理与事件映射。
tags: [index]
timestamp: 2026-08-14
---

# 这是什么

`dsh-claude-code` 是一个可安装的 DeepSeek Harness 插件。装上之后，agent 预设列表里多一个
「Claude Code」；选中它的会话由**本机 Claude Code CLI** 驱动，轨迹实时流进 DSH 界面，选其它
预设的会话一切照旧。

面向 DSH `0.2.0-rc.2`（当前桌面版自带的版本）。

# 从这里开始

| 文档 | 内容 |
|---|---|
| [安装与启用](guides/setup.md) | 前置条件、安装命令、校验、排障 |
| [配置项](reference/config.md) | 全部字段、默认值、路由判定顺序、对外暴露的服务 |
| [事件映射](reference/event-mapping.md) | SDK 消息 → DSH 会话事件 / 实时帧 |
| [架构与设计取舍](overview/architecture.md) | 为什么接管工厂槽位、三条路由路径、与参考实现的差异 |

# 一句话原理

预设是一条 Loader 声明行，不是磁盘目录；插件接管 `ctx.agents` 的 agent factory 槽位，按会话
的预设决定「跑 Claude Code」还是「跑原生循环」，并在空白会话内切预设时**原地换 Agent**（会话
留在 store 里不动，避免客户端锁死输入框）。
