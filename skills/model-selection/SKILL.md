---
name: localization-council-model-selection
description: >-
  Use when choosing or changing which models run each Localization Council stage (translate,
  blind back-translate, judge) over OpenRouter: picking a preset, overriding one stage, adding a
  project preset, or checking cost against quality. Never merges; never weakens the judge to make
  rows pass.
---

# Model selection (Localization Council)

## Goal
Pick the models for each stage deliberately, record the choice, and keep the blind check honest.
Presets and slugs live in `config/models.json` (`openrouter.presets`). Don't copy model IDs into
other files. Evidence: `docs/model-bakeoff.md`. Agent contract: `AGENTS.md`.

## The three stages and what matters for each
- **translate**: glossary compliance, tone, and keeping `{{name}}`, `%s`, and ICU plurals intact.
  Cheap models were close to the default on the bakeoff, so this is a safe place to save money.
- **backtranslate** (blind): literal rendering. Every model tested exposed the planted meaning
  drift, so pick on cost and latency. It must be a **different vendor** from translate and judge.
- **judge** (includes the drift check, meaning scored against the back-translation): this decides
  what a person sees. Cheap judges caught blatant drift but let most subtle terminology errors
  through, so it's the last stage to downgrade.

## Choosing
1. Preflight: `council doctor --online --json` (add `--preset <name>` to check the one you'll
   use). Every slug in every preset is listed under `openrouter.models`. If one is `false`, stop
   and report it. Don't guess a replacement slug.
2. Pick a preset:
   - `balanced` (default): sign-off runs and anything a person will merge without re-review.
   - `budget`: everyday deltas. It uses cheap translate and back-translate models with the
     default judge, for about half the cost.
   - `cheapest`: every stage is cheap. Use it for drafts, smoke tests, or first passes over huge
     catalogs that a stronger judge will re-check later (for example with `council tidy --judge …`).
     Don't use it for sign-off.
3. Say which preset you used and why in your hand-off (the manifest records it too).

## Specifying models on the CLI
```bash
council run --preset budget --catalog <en.json> --target <de.json> --glossary <glossary.de.json> \
  --locale de --out scores/de --json
# one stage on top of a preset (bare OpenRouter slugs):
council run --preset budget --judge-model <vendor/model> …
# also: --translate-model <slug>, --backtranslate-model <slug>
# fully explicit stage map (any provider, all three stages required):
council run --provider translate=openrouter:<slug>,backtranslate=openrouter:<slug>,judge=openrouter:<slug> …
```
- Precedence: `config/models.json` < `--models <file>` < `--preset` < `--*-model`.
- `--preset` or `--*-model` with no profile selects `--profile=openrouter`. On `mock` or `fleet`
  they're a usage error (exit 2). `COUNCIL_PRESET` in the environment is only a default for
  OpenRouter runs.
- Project presets: put `{ "openrouter": { "presets": { "myproj": { "stages": {…}, "faceoff": […], "auditJudges": […] } } } }`
  in a file and pass `--models that-file.json --preset myproj`.
- Check the result in `manifest.json` (`preset`, `stageModels`, `models.<stage>.requested/resolved`)
  and in the summary's `preset`, `costUsd`, and `warnings`.

## Over MCP
The server is `node src/mcp-server.mjs` (setup: `docs/mcp.md`).
- `council_list_presets` returns the default stages, every named preset (with its faceoff and
  audit panels), the profiles, and the precedence rule. Call it instead of reading `config/models.json`.
- `council_run` takes `preset` plus optional `translateModel`, `backtranslateModel`, and
  `judgeModel` (the `--*-model` flags), and `modelsFile` for project presets. The profile rules are
  the same as the CLI: a preset or model with no `profile` means `openrouter`, and on `mock`/`fleet`
  it's a usage error.
- Example: `{"catalog": "…/en.json", "locale": "tr", "glossary": "…/glossary.tr.json", "preset": "budget", "keys": ["…"]}`.
- Check the returned summary's `preset`, `models`, `costUsd`, and `warnings`, or call
  `council_status` on the `outDir` later. The manifest records `argv: ["mcp", "council_run", …]`.
- Pass the preset as an explicit argument, not through `COUNCIL_PRESET` in the server's
  environment, so the choice shows in the transcript. The hard rules below apply unchanged.

## Hard rules
- Keep the three stages in three model families. A `same_family_*` warning in the summary means
  the blind check is weaker. Fix the selection, or report the warning. `--strict-diversity` makes
  it an error.
- Never switch to a cheaper or more lenient judge, or rerun with a different preset, to make
  escalated rows pass. Escalations go to a person (AGENTS.md hard rule 3).
- Never merge. Never write model IDs or keys into product repos.
- If a model is slow or rate-limited (timeouts, HTTP 429 in `run.log`), rerun once (finished work
  is cached), then report it instead of silently swapping models.

## Refreshing the evidence
Before changing a preset, rerun a small bakeoff on the toy fixtures (`fixtures/rtl-smoke`, plus a
glossary locale), comparing cost, ICU and placeholder survival, planted-drift detection, and
agreement with the `balanced` judge. Update `docs/model-bakeoff.md` and `config/models.json` in
the same PR, then run `council doctor --online`.
