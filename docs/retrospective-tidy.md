# Retrospective tidy: `council tidy`

Localization isn't one-and-done. When a better judge, a stricter glossary, or a new gate appears,
`council tidy` re-audits strings that **already shipped**, without retranslating them. Most rows stay
fine, and the ones that fail today's checks are marked to reopen. Nothing is merged or edited. You get
a sheet and decide which rows become PRs.

```bash
council tidy \
  --catalog locales/en.json \
  --locale-file locales/ja.json \
  --locale ja \
  --glossary locales/glossary.ja.json \
  --bt-file scores/ja/backtranslations.json \
  --profile=openrouter \
  --out scores/ja-tidy \
  --json
```

Exit `10` means some rows should reopen; exit `0` means everything still passes.

## Inputs

| Flag | Required | Notes |
|------|----------|-------|
| `--catalog` | yes | English source catalog (`--en` also works) |
| `--locale-file`, `--locale` | yes | The shipped locale catalog and its tag. Only keys present in both files are audited |
| `--glossary` | recommended | Schema v0. Glossary-dense locales benefit most |
| `--bt-file` | recommended | Back-translations from a prior run (`backtranslations.json`, `[{key, backtranslation}]`, or `{key: bt}`) |
| `--generate-bt` | optional | Back-translate keys missing from `--bt-file` with the profile's back-translate provider |
| `--judge` | optional | Defaults to the profile's judge. Any judge provider works; `api:jev` asks typed tidy questions (below) |
| `--keys-file`, `--limit` | optional | Allow-list (JSON array, `{keys: []}`, or one key per line) and a row cap |
| `--meaning-threshold` | optional | Default 0.75 |

A row with no back-translation reopens for a person with the note `bt_missing`. The council never
invents a back-translation. It either uses yours or runs a real blind one (`--generate-bt`).
When `--bt-file` records the candidate each back-translation was made from (a prior run's
`backtranslations.json` does), an entry whose candidate no longer matches the shipped string is
ignored as stale (`counts.btStale`). A back-translation of old wording says nothing about the new one.

## How a row is decided

**Any judge provider** (mock, `cli:*`, `openrouter:*`) re-scores the shipped candidate against its
back-translation. A row reopens when it would fail today's council checks: meaning, glossary
(including the deterministic rejected-term check), protected tokens, ICU, or a judge flag.
`why_bucket` is `icu`, `glossary`, `meaning`, `other`, or `fine`, and `note` carries the reasons and the
judge's rationale.

**`--judge api:jev`** asks one batched Decisions call per row: `reopen` (yes/no probability),
`why_bucket` (`fine`/`meaning`/`glossary`/`register`/`ui_role`/`icu`/`other`), and `priority`
(0–2). A row reopens when `reopen ≥ 0.5`, when `why_bucket` isn't `fine`, or when any answer's
confidence is below 0.5 (low confidence goes to a person). Details are in
[jev-translator-judge.md](jev-translator-judge.md).

## Outputs

Under `--out` (default `./scores/<locale>-tidy`):

| File | Contents |
|------|----------|
| `tidy.json` | Every row, the judge, resolved model, cost, and counts |
| `tidy.csv` | `key, locale, en, candidate, backtranslation, reopen, why_bucket, priority, confidence_min, model, note, cost` |
| `SUMMARY.md` | Counts and cost |
| `manifest.json` | Profile, judge, glossary version, thresholds, cost, cache |

## Where to start

1. Locales with dense practitioner vocabulary and an active reviewer.
2. Right-to-left locales (he, ar), where UI-role and register slips are common.
3. Keys with glossary terms, after the glossary changes.
4. Skip locales that are all green unless a spot-check fails.

Agent recipe: [skills/retrospective-tidy/SKILL.md](../skills/retrospective-tidy/SKILL.md).
