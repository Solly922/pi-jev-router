# Jev router

`JevAgent` chooses an agent and a model/thinking pair, then starts the task through the installed `@tintinweb/pi-subagents` RPC executor. There is no dry-run mode, alternate runner, retry or automatic escalation.

## Install

Requires `@earendil-works/pi-coding-agent`, `@tintinweb/pi-subagents` with RPC protocol 2 (tested with 0.19.0), and a [TypeSafe API key](https://docs.typesafe.ai/introduction/quickstart). Install both Pi packages:

```sh
pi install npm:@tintinweb/pi-subagents
pi install git:github.com/Solly922/pi-jev-router
```

Copy the example into your own Pi agent directory. The Git package is normally cloned under `~/.pi/agent/git/github.com/Solly922/pi-jev-router/`:

```sh
mkdir -p ~/.pi/agent/jev-router
cp -n ~/.pi/agent/git/github.com/Solly922/pi-jev-router/config.example.json ~/.pi/agent/jev-router/config.json
```

Edit **your** `config.json` before routing. Replace model IDs, thinking levels, and agent definition paths with ones available on your machine. `pi --list-models` lists locally available models. The example's names and paths reflect one setup, not a universal catalog. Agent definition paths are relative to `~/.pi/agent/jev-router/`: `../agents/Explore.md` points to `~/.pi/agent/agents/Explore.md`. You must provide those agent definitions yourself. Pi's `PI_CODING_AGENT_DIR` override changes the user config directory.

Export `TYPESAFE_API_KEY` in the shell that launches Pi, or configure it through your shell startup. Never put the key in `config.json`. If Pi was running before you exported it, restart Pi; `/reload` does not update the process environment. Run `/reload` after installing or changing extension code. Config changes take effect on the next call. Don't install a second copy if you already have `JevAgent` in `~/.pi/agent/extensions/`.

```json
{
  "prompt": "Find the authentication entry points. Read only.",
  "description": "Find authentication entry points"
}
```

Call `JevAgent` with that input to auto-select all three fields. Optional `agent`, `model` and `thinking` fields are hard constraints. Model IDs must exactly match your `jev-router/config.json`, not fuzzy aliases. Optional `max_turns` is forwarded to the executor. Full explicit constraints bypass unnecessary inference but still launch the agent.

The result contains an agent ID. The existing executor owns its queue, tools, lifecycle, completion notifications and `get_subagent_result`. `Agent`, mentions, workflows and `TaskExecute` are unchanged and do not route through Jev. A subagent's frontmatter model/thinking defaults do not override a `JevAgent` selection; the existing RPC executor receives the selected values explicitly.

## Configuration

Edit the user-owned `~/.pi/agent/jev-router/config.json`. Changes take effect on the next call. The package's `config.example.json` is only a template.

- `models` lists exact provider/model IDs, `tier`, strengths and weaknesses, `thinking.supported` and `thinking.default`, routing hints, and nullable `benchmarks.artificialAnalysis` values. `null` means unknown, not zero. These are policy hints for Jev, not measured scores unless you supply them. Only locally available models and thinking levels become candidates. A configured default that the installed model does not support stays in the file but cannot be selected; explicit requests for that level fail. `routing.escalateTo` is advisory only and never starts another agent.
- `agents` names existing agent definitions. Paths are relative to the **user config directory**, not the extension directory. Use `../agents/Explore.md` for a global agent, or an absolute path for a project agent. Tilde (`~`) is not expanded. Their frontmatter descriptions are read for routing. The router checks global, workspace and project agent directories in executor precedence order and refuses missing, disabled or shadowed configured definitions. Workspace and project discovery uses `process.cwd()`, matching pi-subagents 0.19, not the session's `ctx.cwd`. Update the configured path if you intend to use a project override. This does not create or edit agent definitions.
- `timeoutMs` bounds the Jev request and executor startup acknowledgement. It does not limit the background agent's full runtime.
- `models[].usage.source` tells Jev how much subscription usage is left. The router attaches each option's remaining percentage per window, minutes until reset, and its `pool` (models in one pool share a limit). This is advisory. Jev may still choose a nearly exhausted model, and nothing is filtered out. Omitted means `none`.
  - `codex` calls `chatgpt.com/backend-api/wham/usage` with Pi's own `openai-codex` login. It is skipped if that provider is routed through a proxy.
  - `claude` calls `api.anthropic.com/api/oauth/usage` with the Claude Code login in `$CLAUDE_CONFIG_DIR/.credentials.json` (default `~/.claude`), which `pi-claude-bridge` also uses. The file is only read. An expired token is skipped, never refreshed. On macOS, where Claude Code stores credentials in the keychain, usage is reported as unknown. Optional `modelWindow` adds one more window for that model, either a response key such as `seven_day_opus` or a model-scoped limit's display name.
  - `none` sends `unknown`.

  Both endpoints are undocumented, so a response change degrades to `unknown`. Top-level `usage.cacheSeconds` (10–3600, default 60) sets how long a result is reused. `usage.timeoutMs` (100–10000, default 3000) bounds each fetch. After a failure, the last value is reported `stale` for up to 30 minutes, then `unknown`. Usage is fetched only when Jev chooses between two or more model/thinking options, and a usage failure never blocks routing.
- No fallback is enabled. To explicitly allow one on Jev failure, add `"fallback": {"agent":"Explore","model":"meta/muse-spark-1.3-contributor","thinking":"xhigh"}`. Caller constraints still win. If they make this fallback invalid, the call fails. Cancellation and executor failure never invoke fallback.

The task prompt, eligible model metadata and any usage reports (percentages and reset times, never tokens) are sent to `https://api.typesafe.ai/v1/systemone` with `jev-latest`. A single request asks for agent choice and a joint model/thinking choice. The configured thinking default is guidance, not an automatic selection. Unknown selections and `none` fail closed unless a fallback was configured. The example includes Muse `max`, which may be unavailable in your Pi model registry; unsupported levels are filtered at runtime.

This uses the documented pi-subagents protocol 2 `spawn` options `model` and `thinkingLevel`. That path honors them before agent frontmatter defaults. Patching the `Agent` tool's arguments alone would not, because its invocation resolver prioritizes frontmatter.

## Checks

From this repository's root:

```sh
node --test *.test.ts
```

Tests run on Node 22+ with native TypeScript support. The integration test needs Pi installed beside the current Node executable; set `PI_PACKAGE_DIR=/path/to/pi-coding-agent` if yours is elsewhere.

Tests exercise candidate selection, overrides, bad responses, explicit fallback, cancellation, deadlines and RPC payloads. The integration test loads the real extension through Pi and checks the registered tool's RPC payload. It finds Pi beside the current Node installation, or accepts `PI_PACKAGE_DIR`. HTTP and executor replies are mocked; these checks do not claim a paid live Jev or child-model run.

References: [TypeSafe API](https://docs.typesafe.ai/api), [Choice](https://docs.typesafe.ai/primitives/choice), and the installed `@tintinweb/pi-subagents/docs/rpc.md`.
