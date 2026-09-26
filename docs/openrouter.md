# OpenRouter profile

`--profile=openrouter` runs every stage over HTTP with one key, so any agent or CI job can run the
council without the `claude`, `grok`, and `codex` CLIs installed.

```bash
export OPENROUTER_API_KEY=…
council doctor --online        # key present? configured model slugs exist?
council run --profile=openrouter --catalog locales/en.json --locale de --target locales/de.json --json
```

## Stage models

The defaults live in [`config/models.json`](../config/models.json) under `openrouter.stages`. They
follow the same vendor split as Fleet: an Anthropic model translates, an xAI model back-translates
blind, and an OpenAI model judges. `openrouter.faceoff` and `openrouter.auditJudges` list the panels
used by `--faceoff` and `--blind-audit`.

### Why these defaults

- **Translate: Anthropic.** This stage has to get tone right, keep every placeholder, and follow
  the glossary, so it gets the strongest general model. Fleet's translator is Claude too.
- **Back-translate: xAI.** It has to be a different family from the translator, or the blind check
  gets weaker. It runs as many calls as translate, and it only needs to render text literally
  without smoothing it. Fleet's back-translator is Grok too.
- **Judge: OpenAI.** It has to differ from both other stages. It decides what a person sees, so
  this is where extra quality pays off most. Fleet's judge is Codex too.

The OpenRouter defaults follow Fleet on purpose. A catalog scored with either profile gets the same
vendor split, so switching profiles never changes which family checks which. To cut cost, move
back-translation to a smaller model from the **same** vendor, which keeps the split, and keep the
judge strong. Before shipping new defaults, run `council doctor --online`, because the slugs have to
exist on OpenRouter.

To use other models, choose one of these:

- **Per run**, with a stage map:
  `--provider=translate=openrouter:<slug>,backtranslate=openrouter:<slug>,judge=openrouter:<slug>`.
  A bare `openrouter` on a stage keeps that stage's default.
- **Per project**, with `--models my-models.json`. The file is merged over `config/models.json`, for example
  `{ "openrouter": { "stages": { "judge": "<slug>" } } }`.

Slugs are OpenRouter model IDs (`vendor/model`). `council doctor --online` checks every configured
slug against OpenRouter's public model list and marks the profile not runnable if one is missing.
Models get renamed and retired, so run it after you edit the config.

## Presets and per-stage overrides

Pick a named set of OpenRouter models with `--preset balanced` (the defaults), `--preset budget`, or `--preset cheapest`. Supplying a
preset without a profile selects the OpenRouter profile automatically. Override one stage with
`--translate-model <slug>`, `--backtranslate-model <slug>`, or `--judge-model <slug>`; these flags
also select the OpenRouter profile when no profile or provider was otherwise configured.

Precedence is `config/models.json` < `--models <file>` < `--preset` < per-stage model flags. The
`COUNCIL_PRESET` environment variable is the fallback when `--preset` is absent. Presets live under
`openrouter.presets` in `config/models.json`, so a project can add or replace presets through
`--models my-models.json` without changing the installed defaults.

`COUNCIL_PRESET` only applies when a run has OpenRouter stages. It is ignored (not an error) for
`--profile=mock` or `--profile=fleet`, while an explicit `--preset` or `--*-model` flag on those
profiles is a usage error (exit 2). `council doctor --online` checks every slug in every preset.
`manifest.json` records `preset` and any `stageModels` overrides, and the run summary carries `preset`.
The evidence behind `budget` is in [model-bakeoff.md](model-bakeoff.md). Agents: see
[skills/model-selection/SKILL.md](../skills/model-selection/SKILL.md).

## Vendor diversity

Blind back-translation only works as a check when the back-translator isn't the model family that
wrote the candidate, because a model reads its own phrasing back too kindly. The same applies to a judge
grading its own family's work. The council warns (`warnings[].code`) when:

- `same_family_translate_backtranslate`: translate and back-translate share a family.
- `same_family_judge_translate`: the judge shares the translator's family.
- `same_family_judge_backtranslate`: the judge shares the back-translator's family.

Families come from the slug's vendor (`anthropic/…`, `x-ai/…`, `openai/…`), and a CLI counts as its
vendor's family (`cli:claude` is anthropic). `--strict-diversity` turns these warnings into a usage
error.

## What each call does

- **Batching.** Items per request come from `openrouter.batchSize` (translate/back-translate 20,
  judge/compare 5 by default; `OPENROUTER_BATCH_SIZE` overrides). Judges get smaller batches so
  one item's score doesn't anchor the next.
- **JSON output.** Each request uses `response_format: json_schema` with the stage schema from
  [`schemas/`](../schemas). The reply is validated locally against the full schema, including
  ranges, so a backend that ignores `response_format` still can't slip through a bad row.
- **Retries.** 408/409/425/429/5xx responses, network errors, timeouts, and replies that fail
  validation are retried with exponential backoff (1s, 2s, 4s… plus jitter; `Retry-After` is
  honored), up to `openrouter.maxRetries` (3). A batch whose reply stays malformed falls back to
  one request per item, and keys missing from a reply are re-asked on their own. 400/401/402/403/404
  fail immediately with a hint (check the key, add credits, check the slug).
- **Timeouts.** Each request has its own timeout, covering the whole exchange including reading
  the body: `openrouter.timeoutMs` (120 s), overridden by `OPENROUTER_TIMEOUT_MS`.
- **Blind means blind.** Back-translation requests carry opaque ids (`c0`, `c1`, …) instead of
  catalog keys, because a key can be the English source itself (page-wrapper catalogs) or hint at
  it (`ui.viewport.onion`).
- **Telemetry.** `response.model` (the build that actually answered) and `usage.cost` go into
  `manifest.json` and the summary's `costUsd`.

## Environment

| Variable | Purpose |
|----------|---------|
| `OPENROUTER_API_KEY` | Required. Never written to disk or logs |
| `OPENROUTER_BASE_URL` | Override the API base URL (proxies, tests) |
| `OPENROUTER_TIMEOUT_MS` | Per-request timeout |
| `OPENROUTER_MAX_RETRIES` | Retries per request |
| `OPENROUTER_BATCH_SIZE` | Items per request for every stage |

## Live smoke and fixtures

`npm run smoke:openrouter` runs the toy catalog (with every post-escalate stage) and the tr/ar/he
RTL smoke catalog against the real API, then checks every summary and manifest against its schema.
It skips when no key is set. `npm run smoke:openrouter -- --record` also refreshes
`test/fixtures/recorded/openrouter/` with live responses for the contract test.
