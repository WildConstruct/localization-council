# Jev decision gates

TypeSafe **Jev**, served through the OpenRouter Decisions API, returns typed probabilities instead of
prose: `noul` (probability of yes), `choice` (an option plus a distribution), and `score` (a position on
ordered criteria). That fits **gates**, like accept vs. escalate or which candidate wins. It doesn't
fit generating strings, so `api:jev` is judge- and compare-only. It throws `UnsupportedStageError` for
translate and back-translate.

Jev is optional. No profile uses it by default. It needs `OPENROUTER_API_KEY`. The default Jev
model is `jev.defaultModel` in [`config/models.json`](../config/models.json) (override with
`JEV_MODEL`), and the build that actually answered (`response.model`) is recorded in `manifest.json`.

| Primitive | Returns | Use when |
|-----------|---------|----------|
| `noul` | P(yes) ∈ [0,1] | Binary accept / escalate / risk flags |
| `choice` | Selected option + distribution | Picking a winner, routing, register |
| `score` | Weighted position on ordered criteria | Quality or urgency |

The low-level call is `jevDecide(state, questions)` in `src/providers/jev-openrouter.mjs`
(`POST` to `jev.decisionsUrl` with `{ model, state, questions }`).

## Implemented gates

### Judge: `judge=api:jev`

```bash
council run --catalog fixtures/toy/en.json --locale de \
  --provider=translate=cli:claude,backtranslate=cli:grok,judge=api:jev --out scores/de-jev
```

This makes one call per row with six questions: `escalate`, `meaning_ok`, `glossary_ok`, `quality`,
`register_ok`, and `ui_role_ok`. The row escalates when `escalate ≥ 0.5`, `meaning_ok` is below the
threshold, `glossary_ok < 0.5`, `ui_role_ok` or `register_ok` is `< 0.5`, or any watched answer
reports confidence below 0.5. The mapping to the council's judge shape is in
[jev-translator-judge.md](jev-translator-judge.md).

### Blind-audit vote: `--audit-judges …,api:jev`

Jev's `compare` asks the faceoff questions `clear_winner`, `near_tie`, `winner` (a per-candidate
choice whose criteria include the candidate text), and `differentiation_enough`. Jev votes only when
**all** of these hold. Otherwise it abstains, and `abstainReasons` records why:

| Signal | Threshold |
|--------|-----------|
| `clear_winner` | ≥ 0.75 |
| `near_tie` | ≤ 0.30 |
| `differentiation_enough` | ≥ 0.70 |
| Confidence on any of the four answers | ≥ 0.65 |
| Winner's top probability (when a distribution is returned) | ≥ 0.60 |

Constants and parsing are in `src/providers/jev-faceoff.mjs`. Because it abstains when unsure,
Jev can break a tie among other judges but never overrides a clear disagreement. Before trusting
Jev as a *sole* auto-picker, check that it agrees with human picks on at least 90% of at least 20
labeled rows that have distinct candidates.

### Retrospective tidy: `council tidy --judge api:jev`

Typed `reopen` / `why_bucket` / `priority` questions per shipped row. See
[retrospective-tidy.md](retrospective-tidy.md).

## Candidate gates, not built yet

| Stage | Gate | Primitive |
|-------|------|-----------|
| Before a run | Route by locale or string complexity: single candidate vs. faceoff | `choice` `run_mode` |
| Before translate | Glossary risk: dense approved/rejected terms on this key? | `noul` |
| Structure | ICU risk: plural/select structure fragile enough to warrant an extra check? | `noul` |
| RTL | Bidi / script / practitioner-term risk for he, ar | `noul` |
| Consensus cull | Are candidates too similar to keep both? | `noul` |
| Register | Formal vs. neutral vs. casual against product voice | `choice` |
| Human sheet | Audit priority | `score` |

## Operating notes

- **Batch questions, keep state lean.** Ask many questions against one small state per call. State is
  filtered to the fields the questions need (`JEV_LEAN_STATE_KEYS`).
- **noul ≠ confidence.** A noul of 0.5 is a coin flip on "yes", not medium confidence. Confidence
  is a separate axis, and low confidence goes to a person.
- **Cost.** Billed on input tokens. Each response has `usage.cost`, which goes into the manifest.
