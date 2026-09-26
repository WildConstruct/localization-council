---
name: localization-council-tidy
description: >-
  Use when re-auditing strings that already shipped, after a better judge or glossary appears,
  or on a periodic tidy pass. Marks rows to reopen without retranslating; never merges.
---

# Retrospective tidy (Localization Council)

## Goal
Re-audit **already shipped** strings (keys present in both the English catalog and the locale
catalog) with today's judge and glossary. Most rows stay fine. The sheet marks the rest to reopen.
A person decides which rows become PRs.

Full design: `docs/retrospective-tidy.md`. Agent contract: `AGENTS.md`.

## When to use
- A stronger judge or a new gate (for example `api:jev`) should revisit shipped catalogs.
- A glossary changed, and old strings may now violate it.
- A spot-check failed on a locale that looked green.

## When to skip
- No shipped locale file yet. Use `council run --target …` instead.

## Hard rules
- Never merge, and never edit the locale catalog. Output is a sheet under `--out`.
- Never invent back-translations. Pass `--bt-file` from a prior run, or `--generate-bt` for a real
  blind back-translation.
- Low confidence goes to a person.
- No secrets in files.

## Steps
1. Preflight: `council doctor --json`. Pick a runnable profile.
2. Run, starting small (`--limit`):

```bash
council tidy \
  --catalog fixtures/tidy-sample/en.json \
  --locale-file fixtures/tidy-sample/ja.json \
  --locale ja \
  --glossary fixtures/tidy-sample/glossary.ja.json \
  --bt-file fixtures/tidy-sample/bt.ja.json \
  --profile=mock \
  --limit 5 \
  --out scores/ja-tidy \
  --json
```

   `--judge api:jev` asks typed reopen / why_bucket / priority questions (needs `OPENROUTER_API_KEY`).
3. Exit `0` means nothing to reopen. Stay quiet. Exit `10` means send the person `SUMMARY.md` and the
   reopen rows from `tidy.csv` (key, source, candidate, back-translation, why_bucket, note).
4. For a second opinion, run again with a different `--judge` and treat a row as reopen if **either** run flags it.
