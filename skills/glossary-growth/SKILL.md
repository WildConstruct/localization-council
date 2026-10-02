---
name: localization-council-glossary-growth
description: >-
  Use after strings ship (or after a council run) to keep a product's glossary growing: propose
  entries for recurring terms the glossary doesn't cover, and hand them to a person. Never decides
  or applies proposals; never edits the glossary.
---

# Glossary growth (Localization Council)

## Goal
The product's glossary should grow as the product is localized. Harvest the terminology the
shipped strings already use, propose entries for recurring terms the glossary doesn't cover, and
give a person what they need to decide. Full design: `docs/glossary.md`. Agent contract: `AGENTS.md`.

## When to use
- On a schedule (weekly works), per active locale that has shipped strings.
- Right after a `council run`, with `--accepted <out>/accepted.json`, so proposals can go into the
  same PR as the accepted strings.
- When a person asks which terms the glossary is missing.

## When to skip
- The locale has shipped nothing yet. Harvest needs shipped pairs. Tell the person the glossary
  has to start by hand for now.

## Hard rules
- Never fill in a proposal's `decision`, `reject` or `why`. Never run `council glossary apply
  --write`. Never edit a glossary file. A person does all three.
- Harvest into the same `--out` every time, so the person's decisions carry over.
- Never lower `--min-keys` just to produce proposals.

## Steps
1. Preflight: `council doctor --json`. Pick a runnable profile; don't use `mock` on real catalogs.
2. Harvest:

```bash
council glossary harvest \
  --catalog fixtures/glossary-growth/en.json \
  --locale-file fixtures/glossary-growth/de.json \
  --glossary fixtures/glossary-growth/glossary.de.json \
  --locale de \
  --profile=mock \
  --out scores/de-glossary \
  --json
```

   With other apps that share terms, add `--reference app-a=<their glossary>`. For a whole garden,
   run `council garden --mode glossary --manifest <garden.json> --root <checkouts> --out <dir> --json`
   instead; every catalog then references the others.
3. Exit `0`: nothing new. Stay quiet. Exit `10`: send the person `proposals` from the summary
   (term → suggested rendering, key count, and whether the renderings disagree, listing those
   first), plus the paths of `PROPOSALS.md` and `glossary-proposals.json`.
4. If the person has decided and asks you to apply, run `council glossary apply --proposals …
   --glossary …` without `--write` and hand them `glossary.next.json`. Then offer a re-audit:
   `council tidy … --keys-file <out>/affected-keys.json --generate-bt`.
