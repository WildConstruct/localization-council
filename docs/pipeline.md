# Pipeline

Localization Council is an evaluation harness, not a merge bot. Every string either passes every
check and is **accepted into output** (`accepted.json`), or it is escalated to a person. A person
**merges**. See the terminology in the [README](../README.md#two-terms-used-everywhere).

## The seven steps

| # | Step | What runs | Where |
|---|------|-----------|-------|
| 1 | **Detect the delta** | `council diff`, or `run --target`, finds keys that are missing or identical to the source | `src/catalog.mjs` |
| 2 | **Glossary-aware translate** | The translate provider gets the glossary block (approved terms and rejected terms with reasons) | `src/pipeline/translate.mjs` |
| 3 | **Structure checks** | Protected tokens (`{{name}}`, `{name}`, `%s`) and ICU MessageFormat structure (see below) | `src/catalog.mjs`, `src/icu.mjs` |
| 4 | **Blind back-translation** | A different provider renders the candidate back into English. It never sees the source | `src/pipeline/backtranslate.mjs` |
| 5 | **Scored judge** | Meaning (source vs. back-translation), fluency, and glossary compliance, as strict JSON | `src/pipeline/judge.mjs` |
| 6 | **Escalate or accept** | A row is accepted into output only if meaning ≥ threshold (default 0.75), the glossary passes (judge and a deterministic rejected-term check), tokens and ICU survive, and the judge didn't flag it. Everything else goes to `escalate.json` | `src/pipeline/escalate.mjs` |
| 7 | **Optional post-escalate resolution** | Faceoff → consensus cull → blind audit shrinks the human sheet ([escalate-resolution.md](escalate-resolution.md)) | `src/pipeline/post-escalate.mjs` |

Merging accepted strings into the product catalog is outside the pipeline. A person does it.

## Not in the pipeline

- **Domain research.** Nothing studies the product or its users before translating. The glossary and
  the catalog are the only context.
- **A separate semantic-drift stage.** Drift is measured once, by the judge: it scores the meaning
  of the blind back-translation against the source (step 5). No independent drift check runs.
- **Glossary generation.** The glossary is an input you write (`--glossary`). The council enforces
  it but doesn't propose terms.

These are roadmap items ([backlog.md](backlog.md#roadmap)).

## Profiles

A run's providers come from a profile ([`config/profiles.json`](../config/profiles.json)). The
stage models come from [`config/models.json`](../config/models.json).

| Profile | Translate | Blind back-translate | Judge | Needs |
|---------|-----------|----------------------|-------|-------|
| `mock` | `mock` | `mock` | `mock` | nothing |
| `openrouter` | `openrouter:<anthropic model>` | `openrouter:<xAI model>` | `openrouter:<OpenAI model>` | `OPENROUTER_API_KEY` |
| `fleet` | `cli:claude` | `cli:grok` | `cli:codex` | the three CLIs, logged in |

The judge is `cli:codex` for Fleet and an OpenAI-family model for OpenRouter, so no vendor grades
its own work. `--provider` accepts a stage map for anything else, for example
`translate=cli:claude,backtranslate=openrouter,judge=api:jev`. A stage map must name all three stages.
A bare `openrouter` stage uses that stage's default from `config/models.json`.

Precedence: `--mock` > `--provider` > `--profile` > `COUNCIL_PROFILE` > `COUNCIL_PROVIDER` > `mock`.

## Provider contract

Every adapter implements four batch methods ([`src/providers/contract.mjs`](../src/providers/contract.mjs)):

| Method | Input items | Output per item |
|--------|-------------|-----------------|
| `translate` | `{ key, source }` + locale + glossary | `candidate` |
| `backtranslate` | `{ key, candidate }` + locale (never the source) | `backtranslation` |
| `judge` | `{ key, source, candidate, backtranslation }` + glossary | `meaning`, `fluency`, `glossaryOk`, `escalate`, `rationale` |
| `compare` | `{ key, source, options: { X, Y, … } }` | `pick` (a label or none), `rationale` |

Output is normalized and validated against
[`schemas/stage-results.v1.json`](../schemas/stage-results.v1.json). A missing row, an empty
string, an out-of-range score, or a pick outside the labels is a **missing verdict**, which is an
error and never a pass. A stage an adapter can't run (for example `translate` on `api:jev`)
throws `UnsupportedStageError`. `test/contract.test.mjs` runs every adapter through all four
methods against recorded fixtures and fake CLIs.

## Caching and reproducibility

- **Cache.** Each result is cached under `<out>/.cache/<stage>.json`, keyed on the stage, provider,
  model, prompt version, adapter settings (for example Claude's effort level), the CLI's version for
  CLI providers, locale, glossary content hash, catalog key, and inputs. Rerunning the same command
  skips finished work, including after a crash. `--no-cache` turns it off and `--cache-dir` moves it.
  A CLI whose default model changes without a new CLI version (Grok, or Codex without
  `CODEX_MODEL`) needs `--no-cache` once.
- **Manifest.** `manifest.json` records the profile, requested and resolved models
  (`response.model` for HTTP providers), thresholds, seed, post-escalate settings, Node and CLI
  versions, cost (`usage.cost`, or the Claude CLI's `total_cost_usd`; `cost.complete` is false when
  a provider doesn't report cost), and cache hits.
- **Log.** `run.log` has one line per provider batch, plus stderr from the CLIs.

## ICU MessageFormat: what we protect and what we defer

**Protected, with no ICU dependency:** argument names; type keywords (`plural`, `select`,
`selectordinal`, `number`, `date`, `time`); plural and select branch keys (`one`, `other`, `=0`, …);
and `#` as the plural number placeholder. Nested arguments inside branches are walked too. Breaks
escalate as `icu_structure_break`. Translate and back-translate prompts include
`ICU_PRESERVE_PROMPT`. Plural/selectordinal branch keys are checked against the target locale's CLDR
categories (`Intl.PluralRules`), so `ar` may add zero/two/few/many and `ja` may drop `one`.

**Deferred:** a full ICU4J or FormatJS AST; semantic checks of number and date skeletons; exotic
apostrophe escaping; and `choice` semantics beyond opaque typed arguments. See the header of
`src/icu.mjs`.

## Explicitly later

- Screenshots and visual QA.
- Human review UI and ticket integrations.
- A full multi-repo council walk inside `council garden` (today it dry-diffs; a routine runs the council per delta).
