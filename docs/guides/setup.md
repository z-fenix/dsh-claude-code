---
type: Guide
title: 安装与启用
description: 把 dsh-claude-code 装进 DSH 桌面版（0.2.0-rc.2），让预设列表出现「Claude Code」。
tags: [setup, install, desktop]
timestamp: 2026-08-14
---

# 前置条件

| 项 | 要求 |
|---|---|
| DSH | `0.2.0-rc.2`（本机桌面版自带） |
| Node | `^22.19.0 \|\| >=24.0.0` |
| pnpm | 在 PATH 里（`dsh plugin` 会把安装转发给它） |
| Claude | 本机 `claude` CLI 已登录，或提供 `ANTHROPIC_API_KEY` |

先确认 claude 可用：

```powershell
claude --version
```

# 安装

**必须装成链接（`link:`），不要用 `file:`** —— 直接给本仓库检出的绝对路径：

```powershell
dsh plugin --profile desktop add C:/Users/Administrator/workplace/project/tools/dsh-claude-code
```

安装做三件事：

1. 把包按 `"dsh-claude-code": "link:<该目录>"` 加进 `~/.dsh/profiles/desktop/package.json` 的 `dependencies`；
2. 把包名追加进同文件的 `dsh.profile.bundles`；
3. 读取包内 `package.json` 的 `dsh.bundle.patch`，加载 `cordis.patch.yml` 作为一层 profile 补丁。

装完**重启桌面应用**（bundle 层在启动时组合）。

## 为什么必须是 `link:`，不能是 `file:`

本插件 import 的 `@deepseek-ai/dsh-scope` / `dsh-agent` / `dsh-session` / `dsh-llm` / `cordis`
必须与宿主**共用同一个模块实例**：`dsh-scope` 用模块私有的 `Symbol("dsh.scope")` 给 ctx 打
scope 标签，同一个进程里两份物理副本就是两个 Symbol。DSH 的解析器只在**链接安装**下提供
这条共享通道（官方约定见 harness 的 `docs/user/develop/basic/publish.md`：需要共享实例的
dsh 包只放 `peerDependencies` + `devDependencies`，不要放 `dependencies`）：

- **链接安装**：profile 的 `node_modules/dsh-claude-code` 是指向外部的符号链接，插件属于
  linked root；它 import 的包名只要在本包 `peerDependencies` 里声明过，就被重定向到
  **installation（`app.asar`）里的那份实例**。
- **`file:` 安装**：pnpm 把检出**复制**进 profile，插件变成 profile 内的普通包。此时 profile
  里也会装上一份 `@deepseek-ai/dsh-scope`（它是本包的依赖），插件加载的就是那份副本 —— 它
  铸出来的 agent scope 宿主读不到，**新建会话与恢复会话都会直接失败**，报
  `Agent preset binding requires a scoped context`。

> 附带好处：链接安装下改动本仓库源码立即生效，不用重新安装。链接是符号链接，pnpm 不会
> 导入/复制目标目录，所以不存在「安装过程清空目标 node_modules」的风险。

## 校验安装结果

```powershell
# 1) 依赖是链接
Select-String -Path ~/.dsh/profiles/desktop/package.json -Pattern 'dsh-claude-code'
#    期望形如 "dsh-claude-code": "link:C:/Users/.../dsh-claude-code"（不是 file:）

# 2) profile 的 node_modules 里不该有 @deepseek-ai 的本地副本
Get-ChildItem ~/.dsh/profiles/desktop/node_modules -Name
#    期望只有 dsh-claude-code 等非 @deepseek-ai 的条目。出现 dsh-scope / dsh-agent /
#    dsh-session / dsh-llm / cordis / schemastery 等，说明以前用 file: 装过，必须删掉：
#    Remove-Item -Recurse -Force ~/.dsh/profiles/desktop/node_modules/@deepseek-ai
#    （这些包应由 app.asar 提供，见上一节）

# 3) 插件能被加载
cd ~/.dsh/profiles/desktop
node -e "import('dsh-claude-code').then(m=>console.log(m.name))"

# 4) 补丁文件里两个行都在
Select-String -Path ~/.dsh/profiles/desktop/node_modules/dsh-claude-code/cordis.patch.yml -Pattern 'name:'
```

# 启用与会话选择

- 插件行的 `config.enabled` 默认已经是 `true`，装完即生效。
- 桌面端**新建会话**时，输入框上方的预设选择器里会多出「Claude Code」（Developer tools 打开时才显示该选择器）。
- 选中它 → 这个会话由 Claude Code 驱动；选其它预设 → 照旧走原生循环。

> 预设选择器只在会话还没出过回合时可用，这是 DSH 自身的规则，不是本插件的限制。

# 配置

profile 的 `~/.dsh/profiles/desktop/cordis.patch.yml` 里按行 id 覆盖：

```yaml
- id: dsh-claude-code
  name: dsh-claude-code
  config:
    enabled: true
    engines:
      claude-code:
        executable: claude
        env: {}
```

> 按 id 覆盖一行时**必须把 `name` 一起写回**：profile 补丁覆盖的是整行的 config，缺了
> `name` Loader 就不知道该加载哪个插件。

常见的两类配置：

**用 API key 而不是本机登录**

```yaml
        env:
          ANTHROPIC_API_KEY: sk-ant-...
```

**claude 不在 PATH 里**（Windows 上常见，npm 全局装的 shim 在 `%APPDATA%\npm`）

```yaml
        executable: C:\Users\Administrator\AppData\Roaming\npm\claude.cmd
```

> 插件会自动解开 Windows 上的 `.cmd` / `.bat` shim：Node 从 CVE-2024-27980 起不允许
> `spawn`（shell:false）直接执行批处理文件，而 npm 全局 bin 默认就是这种 shim，因此解析到
> `.cmd` 时会读出它引用的真实 `.exe` 再交给 SDK。所以 `executable: claude` 通常就够了。

# 卸载

```powershell
dsh plugin --profile desktop remove dsh-claude-code
```

然后重启桌面应用。

# 排障

| 现象 | 原因与处理 |
|---|---|
| 新建/恢复会话报 `Agent preset binding requires a scoped context` | 插件被装成了 profile 内的副本（`file:`），或 profile 里残留 `@deepseek-ai/dsh-scope` 等本地副本 —— 插件的 scope 标签与宿主的不是同一个 Symbol。按「为什么必须是 `link:`」一节重装成链接，并删掉 `~/.dsh/profiles/desktop/node_modules/@deepseek-ai` |
| 预设列表里没有「Claude Code」 | 没重启；或该预设行显示为 broken（见下一条）；或 Developer tools 没开 |
| 预设显示为 broken | 行里的某个插件名解析失败，常见是共享目录里的 `@deepseek-ai/dsh-persona` 是旧版：`cd ~/.dsh/profiles && pnpm add @deepseek-ai/dsh-persona@0.2.0-rc.2` |
| 会话报「Claude Code run failed」 | `claude` 不可执行或未登录：先手工跑一次 `claude --version`，必要时配 `executable` / `env` |
| 输入框显示「当前模型不可用」 | 休眠 LLM 路由没注册成功，检查日志里有没有 `dsh-claude-code: routing active` |
| 装了插件但会话还是 DeepSeek | 该会话创建时选的预设不是「Claude Code」；会话出过回合后无法再切 |
| 想彻底停用 | profile 补丁里给插件行加 `config: { enabled: false }`（记得带 `name`） |
