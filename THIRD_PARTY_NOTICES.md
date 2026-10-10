# Third-party notices

`dsh-claude-code` is distributed under the MIT License (see [LICENSE](LICENSE)).
It depends on the following third-party packages. No third-party source is
vendored into this repository; they are consumed as ordinary npm dependencies.

## Runtime dependencies

| Package | Version | License | Role |
|---|---|---|---|
| [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) | 0.3.220 | MIT | Drives the Claude Code CLI and streams its messages. |
| [`js-yaml`](https://www.npmjs.com/package/js-yaml) | ^4.1.0 | MIT | Parses the bundled `cordis.patch.yml` in tests. |
| [`@deepseek-ai/dsh-agent`](https://www.npmjs.com/package/@deepseek-ai/dsh-agent) | 0.2.0-rc.2 | MIT | DSH Agent interface, event dispatch vocabulary, and the `agent/inbox/spliced` session event. |
| [`@deepseek-ai/dsh-llm`](https://www.npmjs.com/package/@deepseek-ai/dsh-llm) | 0.2.0-rc.2 | MIT | Assistant/tool-result message factories, stream accumulator, and the dormant LLM adapter base. |
| [`@deepseek-ai/dsh-scope`](https://www.npmjs.com/package/@deepseek-ai/dsh-scope) | 0.2.0-rc.2 | MIT | Agent scope creation and disposal. |
| [`@deepseek-ai/dsh-session`](https://www.npmjs.com/package/@deepseek-ai/dsh-session) | 0.2.0-rc.2 | MIT | `SessionPreparation` and session-log vocabulary. |

### Why the DSH packages are pinned exactly

`@deepseek-ai/dsh-*` ships with the harness rather than with this plugin, so
they are declared both as `peerDependencies` (the compatibility statement the
DSH plugin manager checks before installation) and as exact-version
`dependencies`. The duplication is deliberate: a profile may already hold
another `0.2.x` pre-release of these packages, and an exact dependency makes
Node resolve the version this plugin was built and tested against instead of
whatever happened to sit higher in the profile's `node_modules`.

`@deepseek-ai/dsh-subprocess` is deliberately **not** a dependency: it provides
two small helpers here (parent-environment scrubbing and executable resolution),
both used through a lazy, failure-tolerant import with local fallbacks, so a
missing peer chain can never stop the whole plugin from loading.

## Peer dependencies

`@deepseek-ai/cordis` (^4.0.4) is supplied by the harness at runtime.

## Acknowledgements

`dsh-claude-code` follows the architecture pioneered by the reference plugins
[`dsh-engine-switch`](https://github.com/Yuki-takuya-kun/dsh-engine-switch) and
[`dsh-claude-code`](https://github.com/Yuki-takuya-kun/dsh-claude-code), which
route DSH sessions to pluggable loop engines by agent preset. This project is an
independent implementation targeting DSH `0.2.0-rc.2`, whose declarative agent
presets, session-event vocabulary, and agent-factory ownership model differ from
the versions those plugins target.
