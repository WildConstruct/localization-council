# Routine: scheduled localization tidiness

This routine is for a scheduled agent. Any agent that can run shell commands and send a message
works. The agent checks catalogs on a schedule, runs the council only
on what changed, stays quiet when nothing needs a person, and sends one short message when
something does.

Treat the steps as intent, not a frozen script. The command-level contract (exit codes, fields,
reason codes) is in [AGENTS.md](../../AGENTS.md).

## Inputs

- A garden manifest ([docs/garden.md](../garden.md), example: [examples/garden.example.json](../../examples/garden.example.json)).
  It lists repos, source↔target catalog pairs, glossaries, and `localeTiers.active`.
- A checkout root that holds those repos. Pull them before each run.
- A profile. Pick `fleet` on a machine with the `claude`, `grok`, and `codex` CLIs logged in.
  Otherwise pick `openrouter` with `OPENROUTER_API_KEY` in the environment.
- Somewhere to send the message: DM, channel, or issue comment.

## Schedule

Nightly works for most teams, for example `0 2 * * *` in the owner's time zone. Use weekdays only if
catalogs rarely change on weekends.

## Steps

1. **Preflight.** Run `council doctor --profile <profile> --json`. On exit `3`, send one message
   naming `profiles.<profile>.missing` (for example "grok CLI not logged in") and stop. Don't fall
   back to `mock` for real catalogs.
2. **Walk the garden.** Run `council garden --manifest <file> --root <checkouts> --json`.
   - Exit `1` (`status: "errors"`) means a catalog path is missing. Include `errors[]` in the
     message, then carry on with the rows that worked.
   - Rows with `status: "CLEAN"` need nothing. Skip them.
   - Rows with `status: "DELTA"` go to step 3.
   - Locales outside `localeTiers.active` show as `deferred_locale`. Leave them alone.
3. **Run the council on each delta row:**
   ```bash
   council run --catalog <source> --target <target> --glossary <glossary> \
     --locale <locale> --profile <profile> --out scores/<repo>/<id>/<locale> \
     --faceoff --consensus-cull --blind-audit --json
   ```
   - Exit `0`: the rows were accepted into output. Record the `accepted.json` path for the digest.
   - Exit `10`: collect `escalations`, `artifacts.report`, and `artifacts.escalate`.
   - Exit `1`: rerun once, since finished work is cached. If it fails again, add
     `errors[0].message` to the message.
4. **Decide whether to speak:**
   - If there's no delta anywhere and no errors, **stay quiet.** Send nothing.
   - If rows were accepted but nothing escalated, send one line: "N strings accepted into output
     for <locales>; accepted.json ready for your PR", or fold it into a weekly digest if the owner
     prefers.
   - If anything escalated or errored, send the message below.
5. **Message** (one per run, not one per locale):
   ```
   Localization Council (nightly): 2 locales changed. 4 strings need a look; 31 accepted into output.

   your-site/common/de
     ui.viewport.onion   "Onion skin" → "Zwiebelschale" (reads back "Onion skin"): rejected glossary term
     ui.status.rendering "Rendering…" → "Wird verarbeitet…" (reads back "Processing…"): meaning 0.55
     report: scores/your-site/common/de/report.md

   your-site/docs-hub/de
     …

   Nothing was merged. Accepted strings are in each accepted.json for your PR.
   Cost: $0.12 (sum of costUsd). Warnings: none.
   ```
   Include any `warnings` from the summaries, especially `same_family_*` and `cli_below_min_version`.

## Never

- Never merge, approve, or push translations to a product branch. A person merges.
- Never write into product catalogs, even with strings from `accepted.json`.
- Never lower thresholds, swap judges, or edit glossaries to make escalations go away.
- Never promote a deferred locale on your own. A person moves it into `localeTiers.active`.

## Optional extras

- **Monthly tidy.** For locales that shipped a while ago, run `council tidy … --bt-file <prior
  backtranslations.json> --json` and report rows where `reopen` is true
  ([docs/retrospective-tidy.md](../retrospective-tidy.md)).
- **Cost guard.** If the summed `costUsd` exceeds a budget the owner set, stop the walk and say so.
