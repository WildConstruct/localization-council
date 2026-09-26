# AGENTS.md

Instructions for coding agents (Codex, Claude Code, Grok, and others) that **run** Localization
Council on a product's catalogs or **work on** this repository. `CLAUDE.md` points here.

## Hard rules

1. **Never merge.** The council accepts candidates into output (`accepted.json` under `--out`).
   A person merges. Don't merge PRs, push translations to a product's main branch, or approve
   your own translation PRs.
2. **Never edit product catalogs directly.** Don't write into the product's `locales/…` files,
   even with strings from `accepted.json`. Hand the files to a person (see below).
3. **Don't route around an escalation.** Don't rerun with a lower `--meaning-threshold`,
   a different judge, or edited glossary entries to make rows pass. Escalated rows go to a person.
4. **No secrets in files.** Keys come from the environment (`OPENROUTER_API_KEY`) or the CLIs'
   own logins. Never write them to disk, logs, or messages.
5. **Model IDs live in `config/models.json`.** Don't hardcode model IDs elsewhere.

## Running the council

Scope: the council translates, blind back-translates, judges, and escalates. It doesn't research the
domain, run a separate drift check, or write glossaries, so don't claim it did in PRs or reports. If
a locale has no glossary, say so and ask a person for one. Don't invent one.

### 1. Preflight

```bash
council doctor --json
```

This prints one object. Read these fields:

| Field | Use |
|-------|-----|
| `profiles.<name>.runnable` | Whether `mock`, `openrouter`, and `fleet` can run on this machine |
| `profiles.<name>.missing` | What's missing, e.g. `env:OPENROUTER_API_KEY`, `cli:grok`, or `model:<slug>` |
| `recommendedProfile` | The first runnable profile in the order `fleet`, `openrouter`, `mock` |
| `clis.<name>.version` / `versionOk` | Installed version against the minimum in `config/models.json` |

If the routine requires a profile, use `council doctor --profile fleet --json`. It exits `3` when that
profile can't run. Stop there and report `missing`. Don't fall back to `mock` for real catalogs:
mock output isn't a translation.

`--online` also checks that the configured OpenRouter model slugs exist. `--probe` makes one tiny
live call per CLI to confirm it's logged in.

### 2. Run a delta

For choosing OpenRouter presets and stage overrides, see [skills/model-selection/SKILL.md](skills/model-selection/SKILL.md).

Do one run per locale. Use `--target` so only missing or untranslated keys run:

```bash
council run \
  --catalog <repo>/locales/en.json \
  --target  <repo>/locales/de.json \
  --glossary <repo>/locales/glossary.de.json \
  --locale de \
  --profile fleet \
  --out scores/de \
  --json
```

Add `--faceoff --consensus-cull --blind-audit` to shrink the human sheet
([docs/escalate-resolution.md](docs/escalate-resolution.md)). These flags cost extra provider calls.

To see the delta without running anything: `council diff --source <en> --target <locale> --json`
(`delta` is the key count).

#### Over MCP

The same steps are available as MCP tools from `node src/mcp-server.mjs` (setup for Claude Code and
Codex: [docs/mcp.md](docs/mcp.md)): `council_doctor` for preflight, `council_list_presets` for model
choices, `council_diff` for the delta, `council_run` to run it (arguments mirror the flags: `keys` is
an array, `--translate-model` becomes `translateModel`), and `council_status` to revisit an output
directory. Each returns the same summary as the `--json` command, so handle `status` and `exitCode`
exactly as below. `isError` is only set for `status: "error"`.

### 3. Act on the exit code

| Exit | `status` | What to do |
|------|----------|------------|
| `0` | `clean` | Nothing needs a person. Stay quiet. If `accepted.json` has strings, a person still merges them on their own schedule. |
| `10` | `escalations` | Hand the escalations to a person (step 5). |
| `1` | `error` | Something failed. Rerun the same command once: finished work is cached, so it resumes. If it fails again, report `errors[0].message` and stop. |
| `2` | `error` | Bad flags. Fix the command. Don't retry the same command. |
| `3` | `not_runnable` | Doctor preflight failed. Report `profiles.<name>.missing`. |

A clean run with no delta prints nothing (without `--json`) and exits `0`.

### 4. Read the summary and `escalate.json`

The `--json` summary (`schemas/summary.v1.json`) has the same shape for every profile. It has
`counts` (`keys`, `accepted`, `escalated`, `initialEscalations`, `resolvedBy*`, `cacheHits`),
`escalations` (`[{ key, reasons }]`), `artifacts` (absolute paths), `costUsd`, and `warnings`.

`escalate.json` holds the full rows:

```json
{
  "threshold": 0.75,
  "count": 1,
  "items": [
    {
      "key": "ui.viewport.onion",
      "source": "Onion skin",
      "candidate": "Zwiebelschale",
      "backtranslation": "Onion skin",
      "meaning": 0.96,
      "reasons": ["glossary_violation", "rejected term \"Zwiebelschale\": Calque that confuses artists; keep English loan in UI."],
      "action": "human_review",
      "postEscalate": ["faceoff:near_tie"]
    }
  ],
  "resolved": [{ "key": "ui.layer.precomp", "text": "Vorkomponieren", "via": "faceoff", "provider": "cli:codex" }]
}
```

Reason codes:

| Reason | Meaning |
|--------|---------|
| `low_meaning:<n>` | The judge's meaning score is below the threshold (default 0.75) |
| `glossary_violation` | The judge found a glossary problem; the judge's notes follow |
| `glossary_rejected_term:<term>` | A rejected glossary term appears (a deterministic check, even if the judge missed it) |
| `judge_flagged` | The judge asked for a human look even though the scores passed |
| `protected_tokens_missing:<tokens>` | A `{{name}}`, `{name}` or `%s` placeholder was lost |
| `icu_structure_break:<details>` | The plural/select branches, argument names, or `#` don't match the source |
| `missing_score` | The judge gave no verdict (treated as a failure, never a pass) |

`resolved` lists rows the post-escalate stages accepted into output, and how.

`warnings` in the summary are worth passing on. The main ones are `same_family_*`, which means two
stages use the same model family and the blind check is weaker, and `cli_below_min_version`.

### 5. What to hand a person

Keep it short, and don't paste whole catalogs:

```
Localization Council: de — 3 of 12 new strings need a look (9 accepted into output).

ui.viewport.onion   "Onion skin" → "Zwiebelschale" (reads back as "Onion skin")
                    glossary: rejected term, a calque that confuses artists
ui.status.rendering "Rendering…" → "Wird verarbeitet…" (reads back as "Processing…")
                    meaning 0.55
…

Report: scores/de/report.md · Sheet: scores/de/escalate.json
Accepted strings for your PR: scores/de/accepted.json
Profile: fleet · cost: $0.04 (see manifest.json)
```

Tell the person that nothing was merged. They decide what goes into the catalog.

### Re-auditing shipped strings

`council tidy` re-judges strings that already shipped, without retranslating them. Exit `10` means some rows should reopen. Pass
`--bt-file` with a prior run's `backtranslations.json`, or pass `--generate-bt`. Report
`SUMMARY.md` and the reopen rows, and don't change the catalog. See
[docs/retrospective-tidy.md](docs/retrospective-tidy.md).

### Scheduled routines

For a nightly or garden-wide routine, follow [docs/routines/scheduled-agent.md](docs/routines/scheduled-agent.md).

## Working on this repository

- `npm test` runs everything offline: unit tests, the provider contract test against recorded
  fixtures and fake CLIs, and the mock/openrouter/fleet parity test. CI runs only this.
- Live checks are optional: `npm run smoke:openrouter` and `npm run smoke:fleet`. Each skips cleanly
  when its key or CLIs are missing.
- There are zero runtime dependencies. Keep it that way unless a dependency clearly pays for itself.
- Every adapter implements `translate`, `backtranslate`, `judge`, and `compare` over batches
  (`src/providers/contract.mjs`) and must pass `test/contract.test.mjs`.
- Put model IDs and minimum CLI versions in `config/models.json`. Put profiles in `config/profiles.json`.
- If you change a prompt, bump its version (`src/providers/prompts.mjs` or the adapter's
  `promptVersion`) so stale cache entries aren't reused.
- The MCP server (`src/mcp-server.mjs`) mirrors `council run` option for option. If you add or
  rename a run option, update its `council_run` input schema and `test/mcp.test.mjs` in the same change.
- Don't commit `scores/`.
