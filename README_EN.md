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
- **🔐 Approval bridge** — DSH mode and approval policy map onto Claude's `canUseTool`; only an in-workspace `blockedPath` in `workspace-write` can pass automatically. `AskUserQuestion` uses the DSH question UI. This is not DSH's OS-level sandbox.
- **🧰 Claude-owned execution** — the preset is a routing key; Claude uses its own tools, persona and context. DSH preset tools are not automatically forwarded.
- **⏯️ Exact resume** — the Claude session id is persisted on the side, so a resumed chat continues the *same* Claude session.
- **🌐 Subagent trajectories** — Claude's built-in `Agent`/`Task` children appear as one-shot, read-only child sessions with short task labels and real run status. Provider identity stays in the descriptor; automatic titles are not emitted without legitimate human source messages. DSH-native delegation remains on the native loop.
- **⌨️ Live input** — followups queue for the next turn, steer enters the live query, and inject does not start a query by itself. Explicit cancellation requests SDK interrupt before closing the query; message sources, images and delivery facts are preserved.
- **🧩 Capability-checked mods** — the packaged `dsh-bridge` mod loads only into the current Claude subprocess. It observes prompt composition and can optionally adapt goal tools, without changing global plugin settings or the DSH application archive.
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
> [setup guide](docs/guides/setup.md). A linked install requires no reinstall after source edits;
> restart the desktop app to reload modules that are already loaded.

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
        mods:
          enabled: true                  # capture only after the selected CLI passes offline checks
          handshakeTimeoutMs: 8000       # ready handshake before submitting user input
        goal:
          enabled: true                    # on by default: bridges the goal tools into Claude Code
          transport: mcp                   # mcp (default) / mod / auto; failures retain MCP
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
| `engines.claude-code.mods.enabled` | `true` | Validate/test the selected CLI and load the packaged observer only into its subprocess |
| `engines.claude-code.mods.handshakeTimeoutMs` | `8000` | Pre-input ready timeout, 1–30000 ms; fallback starts a new MCP query without resending input |
| `engines.claude-code.goal.transport` | `mcp` | `mcp` for compatibility; `mod`/`auto` select mod when supported, otherwise MCP; never both in one query |
| `engines.claude-code.goal.enabled` | `true` | Whether to bridge `get_goal`/`create_goal`/`update_goal` into Claude Code (the session can auto-advance with `/goal`) |
| `engines.claude-code.goal.blockedAfterConsecutiveRounds` | `3` | How many consecutive goal rounds on the same blocker are needed before the model may mark it `blocked` |
| `engines.claude-code.goal.defaultMaxGoalRounds` | unset | Fallback round cap when the model calls `create_goal` without one (defaults to DSH's 256) |

## ⚠️ Known limitations

- The preset is a routing key: its DSH tools and persona are **not** forwarded to Claude Code, which brings its own tools and persona.
- A session locks its preset once it has produced a turn (a DSH rule), so the engine can no longer be switched. Within a blank session, switching **away** from Claude Code (to `standard` or any native preset) swaps back to the native loop in place; switching a native session **into** Claude Code takes effect on the next resume (app restart or reopening the session), because the host recomposes presets in place without recreating agents.
- Claude Code's internal subagents are a **read-only projection**: they appear in the lineage tree as child sessions and carry no loop and no continuation. To make the panel report the right run state, each child also registers a **passive status-carrier agent** (no model loop, no input); the panel's running/completed/not-running labels come from the host agent registry alone.
- Exact resume depends on the plugin's sidecar store (`~/.dsh/dsh-claude-code/sessions.json`). If it is lost, a new Claude session may be created; restoration of the original model history is not guaranteed. DSH fork history is not yet inherited by Claude.
- **The host's `agent/pre-step` event is not dispatched.** That event is the native loop's prompt-assembly pipeline: workspace instructions, time snapshots, plan-mode sections and DSH-side automatic compaction all rewrite the assembled step there. This plugin generates its own prompt and the request that actually goes out is assembled by the Claude Code CLI, so DSH's assembly never reaches the wire. Adopting the event would inject workspace instructions twice (the CLI already loads them) and apply compaction/sections to nodes the model never sees. Cost: a goal round has no host revision fence (editing the goal between queueing a round and claiming it does not reject that round), and goal rounds are not rendered as their own request series. Evidence and the listener inventory: `docs/superpowers/specs/2026-10-13-agent-pre-step-design.md`.
- **Prompt snapshots are observations, not a final system prompt**: `claude-code/prompt-snapshot` records `observed-compose`, `partial` and `compositionLoop: unattributed`. Outer mods may still change the prompt, and the capture cannot prove a main-agent-only origin. Native `system/message` projection remains disabled.
- **The approval bridge is not DSH's execution sandbox, but `read-only` is enforced here.** Claude's built-in tools never pass through DSH's filesystem/process executors, so the DSH file sandbox's `writableRoots` does not constrain them. The plugin applies the sandbox mode itself: under `read-only`, `Write` / `Edit` / `MultiEdit` / `NotebookEdit` are **denied outright with no approval prompt** — there is no "allow once" escape hatch, matching standard sessions where a read-only session cannot modify files however it is approved. Under `workspace-write` an in-workspace `blockedPath` may be auto-allowed; `never` grants no write permission; full access keeps its existing behavior. **Residual limit:** whether a `Bash` command writes a file cannot be decided statically, so it still goes through approval — this remains weaker than standard's **OS-level** isolation.
- **Submission is not consumption**: replay is acknowledgment only; live human input grants goal authority only after a matching result UUID proves consumption. Unconfirmed input becomes `uncertain` and is not automatically replayed. `keepInbox` preserves unsubmitted pending input and recoverable reservations, not input already delivered to Claude. Initial and live batches reserve their original queue before dequeue and commit submission atomically; steer intent survives restart, while legacy next-step entries are not guessed to be querying. When an explicit stop ends a turn, retained pending input that can still form a turn (a queued follow-up or a querying steer) now starts automatically; pure injects still never open a turn.
- Capture failure emits a sanitized SDK notice, records `capture-disabled` and warns without changing the prompt or goal adapter. Each shared capability-probe caller can cancel independently of other active callers.
- **Paused goals require explicit recovery**: active/disarmed goals can be rearmed in an authorized human turn. Paused goals retain standard policy: use `/goal resume` or the goal play control. A chat message saying “continue” does not guarantee a paused goal resumes.
- Failed mod checks or startup readiness produce `claude-code/mod-status` and retain MCP. The selected CLI **2.1.296** passed offline checks; the SDK-bundled **2.1.220** rejected this mod's hooks format. The plugin does not upgrade the CLI automatically.
- Model/effort forwarding, actual Claude compaction, DSH skills/persona/present/jobs, continuable subagents and rich tool results remain later-phase work. Phase one is not full standard-mode parity.
- **Goal continuation depends on the goal stack in the DSH host plane** (`dsh-goal` + `dsh-goal-round-driver`). On deployments without that stack `goal.enabled` silently does nothing (no tools bridged, no prompt added), and `/goal` falls back to DSH's native behavior (there is no `/goal` command at all if that preset doesn't mount `command-goal`).

## 🧪 Development

```sh
pnpm install
pnpm test
```

See the [interaction and mods guide](docs/guides/interaction-and-mods.md) for input semantics, configuration, offline checks and limits.
`plugin validate` / `plugin test` do not invoke a model. Real desktop/inference tests require a separately approved budget.

## 📄 License

MIT. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
