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
- **🎯 Goal-driven automatic tasks** — a session on the Claude Code preset supports the same goal mode as the standard preset: type `/goal <objective>` and it advances round after round, with Claude reading the bridged `get_goal`/`update_goal` and closing the objective out (complete/blocked). Toggle with `engines.claude-code.goal.enabled`, on by default.

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
        goal:
          enabled: true                    # on by default: bridges the goal tools into Claude Code
          blockedAfterConsecutiveRounds: 3 # consecutive rounds on one blocker before `blocked` is allowed
          # defaultMaxGoalRounds: 256      # optional: fallback when the model omits max_goal_rounds
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
| `engines.claude-code.goal.enabled` | `true` | Whether to bridge `get_goal`/`create_goal`/`update_goal` into Claude Code (the session can auto-advance with `/goal`) |
| `engines.claude-code.goal.blockedAfterConsecutiveRounds` | `3` | How many consecutive goal rounds on the same blocker are needed before the model may mark it `blocked` |
| `engines.claude-code.goal.defaultMaxGoalRounds` | unset | Fallback round cap when the model calls `create_goal` without one (defaults to DSH's 256) |

## ⚠️ Known limitations

- The preset is a routing key: its DSH tools and persona are **not** forwarded to Claude Code, which brings its own tools and persona.
- A session locks its preset once it has produced a turn (a DSH rule), so the engine can no longer be switched. Within a blank session, switching **away** from Claude Code (to `standard` or any native preset) swaps back to the native loop in place; switching a native session **into** Claude Code takes effect on the next resume (app restart or reopening the session), because the host recomposes presets in place without recreating agents.
- Claude Code's internal subagents are a **read-only projection**: they appear in the lineage tree as child sessions and carry no loop and no continuation. To make the panel report the right run state, each child also registers a **passive status-carrier agent** (no model loop, no input); the panel's running/completed/not-running labels come from the host agent registry alone.
- Exact resume depends on the plugin's sidecar store (`~/.dsh/dsh-claude-code/sessions.json`).
- **Goal continuation depends on the goal stack in the DSH host plane** (`dsh-goal` + `dsh-goal-round-driver`). On deployments without that stack `goal.enabled` silently does nothing (no tools bridged, no prompt added), and `/goal` falls back to DSH's native behavior (there is no `/goal` command at all if that preset doesn't mount `command-goal`).

## 🧪 Development

```sh
pnpm install
pnpm test
```

## 📄 License

MIT. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
