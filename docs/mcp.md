# Localization Council over MCP

`src/mcp-server.mjs` (bin: `council-mcp`) is a small stdio MCP server. It has no dependencies and
calls the same functions as the CLI, so every tool returns the same machine summary as the
matching `council … --json` command ([schemas/summary.v1.json](../schemas/summary.v1.json)). The
summary comes back twice: as JSON text in `content[0].text` and as `structuredContent`. The
council never merges anything into a product catalog, and escalated rows still go to a person.

## Tools

| Tool | Arguments | Same as |
|---|---|---|
| `council_list_presets` | `modelsFile?` | the `openrouter.presets` block in `config/models.json`, plus profiles and precedence |
| `council_doctor` | `online?`, `profile?`, `preset?`, `modelsFile?` | `council doctor --json` (never probes CLIs over MCP) |
| `council_diff` | `source`, `target` | `council diff --json` |
| `council_run` | `catalog`, `locale`; optional `target`, `keys` (array), `glossary`, `out`, `profile`, `provider`, `preset`, `translateModel`, `backtranslateModel`, `judgeModel`, `meaningThreshold`, `faceoff`, `faceoffProviders`, `consensusCull`, `blindAudit`, `auditJudges`, `seed`, `noCache`, `modelsFile`, `strictDiversity` | `council run --json` |
| `council_status` | `out` | reads an existing run directory (read-only) |

- **Model selection** works exactly as in the CLI. Precedence is `config/models.json < modelsFile < preset < per-stage model`. If you pass `preset` or a `*Model` argument and no `profile`/`provider` (and neither `COUNCIL_PROFILE` nor `COUNCIL_PROVIDER` is set), the `openrouter` profile is used. `COUNCIL_PRESET` in the server's environment is a default. Passing a preset or model to a mock or fleet run is a usage error.
- **Results.** `status` is `clean`, `escalations`, or `error`. `isError` is set only for `error`, because escalations are a normal outcome. `artifacts` holds absolute paths to `candidates.json`, `backtranslations.json`, `scores.json`, `accepted.json`, `escalate.json`, `report.md`, `manifest.json`, and `run.log`. These are the same audit trail the CLI writes. `manifest.json` records `argv: ["mcp", "council_run", …]` so provenance shows the run came over MCP.
- **Progress.** If a `tools/call` carries `_meta.progressToken`, each `run.log` line is also sent as a `notifications/progress` message.
- **Paths.** Relative paths resolve against `COUNCIL_MCP_ROOT`, then `CLAUDE_PROJECT_DIR` (Claude Code sets it), then the server's working directory. Absolute paths are safest.
- **Tool annotations.** Every tool except `council_run` is marked `readOnlyHint: true`, so clients that prompt only for writes (for example Codex `default_tools_approval_mode = "writes"`) ask only before a run.
- **Security.** The server can read and write any path its process can, and it spends OpenRouter credit. Give it only to agents you trust, and pass keys through the environment. It never echoes environment values.

## Claude Code

Project scope (`.mcp.json` at the repository root). Claude Code expands `${OPENROUTER_API_KEY}` from
your shell, so the key is never written to disk:

```json
{
  "mcpServers": {
    "localization-council": {
      "command": "node",
      "args": ["/abs/path/to/localization-council/src/mcp-server.mjs"],
      "env": { "OPENROUTER_API_KEY": "${OPENROUTER_API_KEY}" },
      "timeout": 900000
    }
  }
}
```

Or add it from the command line. Put `--transport stdio` between `--env` and the name. Note that
`--env` stores the literal value in `~/.claude.json`:

```bash
claude mcp add --env OPENROUTER_API_KEY="$OPENROUTER_API_KEY" --transport stdio --scope user \
  localization-council -- node /abs/path/to/localization-council/src/mcp-server.mjs
claude mcp get localization-council
```

After `npm install -g github:WildConstruct/localization-council` you can use `council-mcp` as the
command, with no args. Runs over about two minutes move to a background task in Claude Code. The
per-server `timeout` above caps a call at 15 minutes.

## Codex CLI

`~/.codex/config.toml`, or `.codex/config.toml` in a trusted project:

```toml
[mcp_servers.localization-council]
command = "node"
args = ["/abs/path/to/localization-council/src/mcp-server.mjs"]
env_vars = ["OPENROUTER_API_KEY"]   # forwarded from Codex's environment, not stored
cwd = "/abs/path/to/your/project"  # base for relative catalog paths
startup_timeout_sec = 20
tool_timeout_sec = 900              # the 60 s default is too short for real runs

# Only for unattended `codex exec`: without this, Codex cancels council_run
# ("user cancelled MCP tool call") because it is the one tool not marked read-only.
[mcp_servers.localization-council.tools.council_run]
approval_mode = "approve"
```

One-off, without touching any config file (this is how the end-to-end check in the PR ran):

```bash
codex exec --skip-git-repo-check \
  -c 'mcp_servers.localization-council.command="node"' \
  -c 'mcp_servers.localization-council.args=["/abs/path/to/localization-council/src/mcp-server.mjs"]' \
  -c 'mcp_servers.localization-council.env_vars=["OPENROUTER_API_KEY"]' \
  -c 'mcp_servers.localization-council.tool_timeout_sec=900' \
  -c 'mcp_servers.localization-council.tools.council_run.approval_mode="approve"' \
  "Call council_list_presets, then council_run with preset budget on …" </dev/null
```

A project `.codex/config.toml` is read only when Codex trusts the project. Check what's loaded with
`codex mcp list`, or with `/mcp` in the TUI.

## Any other client

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"council_list_presets","arguments":{}}}' \
  | node src/mcp-server.mjs
```

Protocol versions 2025-11-25, 2025-06-18, 2025-03-26, and 2024-11-05 are accepted (the default is
2025-06-18). Messages are newline-delimited JSON-RPC 2.0 without batching. Requests run
concurrently, so `ping` answers during a long run.
