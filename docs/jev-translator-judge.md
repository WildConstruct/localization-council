# Jev as translator-judge

`judge=api:jev` uses Jev as a typed decision gate over an existing candidate. It never translates or
back-translates. Overview and other gates: [jev-gates.md](jev-gates.md).

## Jev vs. a prose judge

| Concern | Jev (`api:jev`) | Prose judge (`cli:codex`, `openrouter:*`, …) |
|---------|-----------------|---------------------------------------------|
| Accept / escalate | `escalate` noul plus the mapping rule below | `escalate` flag |
| Meaning (via the back-translation) | `meaning_ok` noul → `meaning` | graded `meaning` |
| Glossary | `glossary_ok` noul → `glossaryOk` | `glossaryOk` |
| Overall quality | `quality` score → `fluency` | graded `fluency` |
| Register / UI role | `register_ok`, `ui_role_ok` (soft escalate) | usually buried in the rationale |
| Why, for a person | a short structured string | a readable rationale |

Use a prose judge when a person needs a readable audit trail. Use Jev when you want a cheap, crisp
gate, especially for register and UI-role slips (for example Hebrew "Play" rendered as a noun
instead of an imperative) and glossary-dense keys.

## State

`buildJevJudgeState` sends only what the questions need (`JEV_LEAN_STATE_KEYS`): the English
source, candidate, back-translation, locale, key, glossary notes, ICU flags, and optional `ui_role`
or `register` hints. It sends no long rationales from other judges.

## Mapping to the council's judge shape

| Council field | From Jev |
|---------------|----------|
| `meaning` | `meaning_ok.noul` |
| `fluency` | `quality.score / 2`, clamped to 0–1 |
| `glossaryOk` | `glossary_ok.noul ≥ 0.5` |
| `escalate` | `escalate ≥ 0.5` or meaning < 0.75 or not glossaryOk or (`ui_role_ok` / `register_ok` < 0.5) or any watched answer with confidence < 0.5 |
| `rationale` | `jev escalate=… meaning_ok=… glossary_ok=… quality=… [register_ok=…] [ui_role_ok=…]` |
| `registerOk`, `uiRoleOk`, `confidenceUnsure` | extra fields when present |

Constants: `JEV_MEANING_THRESHOLD = 0.75`, `JEV_NOUL_TRUE = 0.5`, `JEV_CONFIDENCE_FLOOR = 0.5`.
The pipeline still applies `--meaning-threshold` on top.

**noul vs. confidence.** Noul is P(yes) for the question. Confidence is how sure Jev is about that answer.
A noul of 0.5 isn't "medium confidence", and a confident answer with a low `meaning_ok` still escalates.

## When to use it

- A second opinion on right-to-left and glossary-dense locales.
- Tie-breaking in the blind audit (`--audit-judges …,api:jev`). Jev abstains unless it is sure.
- Re-auditing shipped strings (`council tidy --judge api:jev`).

## When to skip it

- Mock runs, CI, or machines without `OPENROUTER_API_KEY`.
- Easy left-to-right locales where the default judge is already confident and the glossary is clean.

## Running both judges

To keep a prose judge's audit trail and still get Jev's gate, run the normal council first. Then
re-check what it accepted with Jev. `accepted.json` loads as a catalog:

```bash
council tidy --catalog locales/en.json --locale de \
  --locale-file scores/de/accepted.json --bt-file scores/de/backtranslations.json \
  --judge api:jev --out scores/de-jev-check --json
```

Treat a row as needing a person if **either** judge flags it.
