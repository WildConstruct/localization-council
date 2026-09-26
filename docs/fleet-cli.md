# Fleet profile: local CLIs

`--profile=fleet` drives the terminal CLIs that are already installed and logged in on the machine:
Claude Code translates, Grok back-translates blind, and Codex judges. The council calls no HTTP API
itself; each CLI uses its own login.

```bash
council doctor                 # installed? recent enough? logged in?
council run --profile=fleet --catalog locales/en.json --locale de --target locales/de.json --json
```

Minimum CLI versions and the default Claude model are in
[`config/models.json`](../config/models.json) (`cli.*`). `council doctor` compares installed
versions against those minimums, and each run records the versions in `manifest.json`.

## Why three vendors

The back-translator must not be the model family that wrote the candidate, or it reads its own
phrasing back too kindly. The judge must not grade its own family's translation or round-trip.
Fleet uses three vendors so no stage checks its own work. Single-CLI runs (`--provider=cli:claude`)
work, but they trigger `same_family_*` warnings, and their scores aren't comparable to a diverse run.

## How the adapters call each CLI

Every adapter spawns the CLI with `spawn` (no shell) in an **empty scratch directory**. An agentic
CLI can't read your catalogs from there, so the back-translation stays blind, and the product repo's
own agent config isn't picked up. Stderr is captured into `run.log`. Each call has a stage timeout;
a hung process gets SIGTERM, then SIGKILL after a grace period. Empty output, unparseable JSON,
out-of-range scores, or an invalid pick are **missing verdicts**: errors, never passes.

### claude

```bash
claude -p --output-format json \
  --permission-mode dontAsk --permission-prompts none \
  --disallowedTools Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,Agent,NotebookEdit,Skill \
  --system-prompt "<stage prompt>" --model "<model>" [--effort <level>] [--json-schema '<schema>']
# prompt on stdin; judge and compare add --json-schema
```

- The adapter checks `is_error` and `subtype` in the JSON envelope, and records `total_cost_usd` and
  `modelUsage` into the manifest.
- `--bare` is opt-in (`CLAUDE_CLI_BARE=1`) for API-key machines only. It skips the keychain/OAuth
  login.

### grok

```bash
grok -p "<prompt>" --output-format json [--json-schema '<schema>'] [--always-approve]
```

- `--always-approve` is opt-in with `GROK_CLI_ALWAYS_APPROVE=1`.
- Grok doesn't report cost, so `manifest.json` marks cost as incomplete.

### codex

```bash
codex exec --skip-git-repo-check --ephemeral -s read-only \
  -o <tmp>/last.txt [-m <model>] [--json --output-schema <tmp>/schema.json] -
# prompt on stdin
```

- **`--skip-git-repo-check` is always passed.** The scratch directory isn't a trusted git repo,
  and without the flag Codex refuses to run in a way that looks like an empty answer.
- The answer is read only from `-o` (`--output-last-message`). An empty file is a missing verdict.
  JSONL telemetry on stdout is never mined for text.

## Environment

| Variable | Purpose |
|----------|---------|
| `CLAUDE_CLI_BIN`, `GROK_CLI_BIN`, `CODEX_CLI_BIN` | Binary name or path (absolute or relative paths work) |
| `CLAUDE_MODEL`, `CLAUDE_TRANSLATE_MODEL`, `CLAUDE_BT_MODEL`, `CLAUDE_JUDGE_MODEL` | Claude model overrides (default in `config/models.json`) |
| `CLAUDE_EFFORT`, `CLAUDE_<STAGE>_EFFORT` | Optional `--effort` |
| `CODEX_MODEL`, `CODEX_TRANSLATE_MODEL`, `CODEX_BT_MODEL`, `CODEX_JUDGE_MODEL` | Codex `-m` overrides (unset uses the CLI's default) |
| `<CLI>_TIMEOUT_MS`, `<CLI>_<STAGE>_TIMEOUT_MS` | Per-call timeouts (defaults: 180 s translate/BT, 300 s judge/compare) |
| `CLAUDE_CLI_BARE=1` | Pass `--bare` (API-key machines only) |
| `CLAUDE_DISALLOWED_TOOLS` | Override the denied tool list |
| `GROK_CLI_ALWAYS_APPROVE=1` | Pass `--always-approve` |

`<STAGE>` is `TRANSLATE`, `BT`, or `JUDGE`. The compare stage (blind audit) uses the judge settings.

## Auth checks

`council doctor` reports each CLI's auth state as `logged_in`, `api_key`, `configured`, or
`unknown`. It checks files and environment variables without spending tokens (for example
`~/.claude/.credentials.json`, `~/.codex/auth.json`, `ANTHROPIC_API_KEY`). A macOS keychain login
shows as `unknown`. `council doctor --probe` makes one tiny live call per CLI and reports
`verified` or `failed`.

## Live smoke

`npm run smoke:fleet` runs the toy German catalog (with every post-escalate stage) and the tr/ar/he
RTL smoke catalog (`fixtures/rtl-smoke/`) through the real CLIs, then checks every summary and
manifest against its schema. It skips when a CLI is missing. Artifacts are UTF-8. Mirroring an RTL UI
is the consuming app's job, and judges score meaning, not script direction.

For a scheduled agent that runs Fleet on a garden of repos, see
[routines/scheduled-agent.md](routines/scheduled-agent.md).
