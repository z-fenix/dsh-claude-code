# dsh-claude-code

<!-- Hero -->
<div align="center">
  <b style="font-size: 1.15em;">Drive a DSH session with Claude Code, watching its trajectory stream in live</b><br /><br />
  <a href="https://opensource.org/licenses/MIT"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a><br /><br />
  <img alt="Live trajectory" src="https://img.shields.io/badge/-live%20trajectory-4d6bfe" /> <img alt="Approval bridge" src="https://img.shields.io/badge/-approval%20bridge-4d6bfe" /> <img alt="Zero config" src="https://img.shields.io/badge/-zero%20config-4d6bfe" /><br /><br />
  <b>DSH drives DeepSeek by default.</b> Install this plugin and the agent-preset list gains a<br />
  “Claude Code” entry — pick it to run the session on your local Claude Code CLI; other presets stay native.
</div>

<div align="center">
  🌏 <a href="./README.md">中文</a> · <a href="./README_EN.md"><b>English</b></a>
</div>

## ✨ What it does

- **🎯 Claude Code in one step** — declares a `claude-code` agent preset plus an engine; select it and the session is driven by the local Claude Code CLI.
- **📡 Live trajectory** — text, thinking, tool calls, and tool results stream into the DSH session as they happen (`agent/assistant-stream` frames plus the durable `assistant/message`).
- **📊 Context occupancy** — Claude Code's token usage and model context window are written to the session log (`assistant/message.usage` + `request/context`), so the GUI shows context pressure and composition like it does natively.
- **🔐 Approval bridge** — the DSH sandbox mode and approval policy map onto Claude's `canUseTool` (in-workspace writes pass, out-of-workspace writes raise a DSH approval); `AskUserQuestion` is answered through the DSH question UI.
- **🧰 Tools and sandbox come from Claude Code** — the preset is only a routing key; DSH tools and persona are not forwarded.
- **⏯️ Exact resume** — the Claude session id is persisted on the side, so a resumed chat continues the *same* Claude session.
- **🌐 Subagents stay DeepSeek** — whatever the top-level session runs on, subagents use the native loop.
- **🧩 Extensible** — the engine registry is exposed as `ctx.claudeCodeEngines`, so other plugins can register engines and reuse the same preset→engine routing and blank-session swap.

## 🚀 Install

Requirements: `dsh` **0.2.0-rc.2** (bundled with the desktop app), pnpm on PATH, and a working `claude` CLI (signed in) or `ANTHROPIC_API_KEY`.

```sh
# Install as a link (link:), never file: — pass the absolute path to this directory
dsh plugin --profile desktop add /absolute/path/to/dsh-claude-code
```

Installation adds the package to the profile's `dsh.profile.bundles` and applies its bundled `cordis.patch.yml` (the plugin row plus the preset declaration). Restart the desktop app afterwards.

> **Why not `file:`** — the `@deepseek-ai/dsh-scope` / `dsh-agent` / `dsh-session` modules this plugin
> imports must be the *same module instances* the host uses (`dsh-scope` tags a context with the
> module-private `Symbol("dsh.scope")`, so two physical copies are two different Symbols). DSH
> redirects peer-declared packages to the host's copy inside `app.asar` only for linked installs.
> `file:` copies the checkout into the profile along with its own `dsh-scope`, and every session
> then fails to create or resume with `Agent preset binding requires a scoped context`. See the
> [setup guide](docs/guides/setup.md). A linked install also means source edits take effect
> immediately, with no reinstall.

## ⚙️ Configuration

Edit `~/.dsh/profiles/desktop/cordis.patch.yml` and override by row id:

```yaml
- id: dsh-claude-code
  name: dsh-claude-code        # restate name whenever you override a row's config
  config:
    enabled: true
    routeMainLoop: true         # on by default; false leaves the preset visible but unrouted
    defaultEngine: deepseek
    engineByPreset: {}
    engines:
      claude-code:
        executable: claude
        persistSession: true
        includePartialMessages: true
        traceSubagents: true
        env: {}
        contextWindow: 200000
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch; `false` leaves the native loop untouched |
| `routeMainLoop` | `true` | `false` keeps the global factory untouched: the preset is visible but sessions are not routed (safety valve, see index.mjs) |
| `defaultEngine` | `deepseek` | Engine for presets without a mapping; `deepseek` is the "native loop" sentinel |
| `engineByPreset` | `{}` | Explicit preset id → engine id overrides |
| `engines.<id>` | `{}` | Engine-private options, forwarded verbatim |
| `engines.claude-code.executable` | `claude` | Claude Code executable |
| `engines.claude-code.persistSession` | `true` | Reuse one Claude session across turns |
| `engines.claude-code.includePartialMessages` | `true` | Token-level streaming |
| `engines.claude-code.traceSubagents` | `true` | Map Claude's internal subagents to read-only DSH child sessions |
| `engines.claude-code.env` | `{}` | Extra environment for the claude subprocess |
| `engines.claude-code.contextWindow` | unset | Manual context window (tokens) fallback |

## ⚠️ Known limitations

- The preset is a routing key: its DSH tools and persona are **not** forwarded to Claude Code, which brings its own tools and persona.
- A session locks its preset once it has produced a turn (a DSH rule), so the engine can no longer be switched. Within a blank session, switching **away** from Claude Code (to `standard` or any native preset) swaps back to the native loop in place; switching a native session **into** Claude Code takes effect on the next resume (app restart or reopening the session), because the host recomposes presets in place without recreating agents.
- Claude Code's internal subagents are a **read-only projection**: they appear in the lineage tree as child sessions but carry no DSH agent.
- Exact resume depends on the plugin's sidecar store (`~/.dsh/dsh-claude-code/sessions.json`).

## 🧪 Development

```sh
pnpm install
pnpm test
```

## 📄 License

MIT. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
