# Post-escalate resolution: faceoff → consensus cull → blind audit

These stages are optional. They run after the core council decides which keys escalate, and their
job is to shrink the human sheet. They are provider-agnostic, work with every profile, and accept
nothing into output that wouldn't pass the core council's checks.

```bash
council run … --faceoff --consensus-cull --blind-audit
```

`--consensus-cull` and `--blind-audit` each imply `--faceoff`, because they work on the faceoff's
candidates. In the offline demo (`--profile=mock` on `fixtures/toy`), each stage settles one of the
three escalated rows.

## The one rule

A candidate is accepted into output only if it passes **every** core check: meaning at or above
`--meaning-threshold` (default 0.75), no glossary violation (from the judge or the deterministic
rejected-term check), protected tokens intact, ICU structure intact, and no judge flag. Faceoff
winners, consensus-cull rows, and blind-audit picks all go through the same check
(`candidateReasons` in `src/pipeline/escalate.mjs`).

## Stages

| # | Stage | Input | Rule | Output |
|---|-------|-------|------|--------|
| 1 | **Core council** | the run | Escalate anything that fails a check | `escalate.json` (snapshot) |
| 2 | **Faceoff** (`--faceoff`) | escalated keys | Each provider in the faceoff panel drafts a candidate. Each candidate is back-translated and judged by the run's own back-translate and judge providers. The top acceptable candidate wins when it leads the next acceptable one by ≥ `--faceoff-margin` (default **0.05**); a sole acceptable candidate wins outright | `faceoff.json` |
| 3 | **Consensus cull** (`--consensus-cull`) | faceoff near-ties | ≥ `--consensus-min` (default **2**) candidates produced identical text (after Unicode normalization and whitespace collapsing) **and** that text passes every check | `consensus-cull.json` |
| 4 | **Blind audit** (`--blind-audit`) | near-ties the cull couldn't settle | Distinct acceptable texts are shuffled into X/Y/Z with a recorded seed. Each judge in the audit panel picks one blind. ≥ `--audit-consensus-min` (default **2**) judges agreeing on one label wins | `blind-audit/` |
| 5 | **Human sheet** | anything left | A person picks a candidate or rewrites the row | final `escalate.json` |

Identical candidates still count as separate candidates in the faceoff, so two providers that
agree produce a margin of 0, which is a near-tie. The consensus cull then settles it. Each decision
stays traceable to one rule. Two agreeing groups of the same size (for example 2 vs. 2) are a split,
not a consensus, and go on to the blind audit.

The blind audit only votes when there are at least two different acceptable texts. A near-tie
where every acceptable candidate says the same thing is recorded as `skipped_single_option` in
`blind-audit/summary.json`. Use `--consensus-cull` to settle those.

### Panels

- **Faceoff panel** (`--faceoff-providers a,b,c`): defaults to the profile's `faceoff` list (Fleet:
  claude, grok, codex; OpenRouter: `openrouter.faceoff` in `config/models.json`; mock: `mock:alt`,
  `mock:third`). The core translator is skipped because its candidate is already in the faceoff.
  The faceoff scores every candidate with the run's own judge, so a candidate from the judge's own
  family is graded by that family. When that matters, rely on the blind audit, or leave the
  judge's family out of `--faceoff-providers`.
- **Audit panel** (`--audit-judges a,b,c`): defaults to the profile's `auditJudges`. Use at least
  three judges so "≥ 2 agree" is a real majority. Judges may be the same models that produced
  candidates, because the labels hide who wrote what. `api:jev` can vote; it abstains unless its
  faceoff gate is confident ([jev-gates.md](jev-gates.md)).

## Why blind

Judges tend to prefer candidates from a model they recognize, or from themselves. The blind audit
removes that signal. Each judge sees only the English source and unlabeled options, with no provider
names and no earlier scores. The origins are written to `reveal.json` **before** judging and read only
when the summary is built.

## Artifacts

```
<out>/
├── faceoff.json            # per key: every candidate, its back-translation, scores, reasons; won | near_tie | no_valid_candidate
├── consensus-cull.json     # per near-tie: accepted (with the agreeing providers) | divergent
└── blind-audit/
    ├── blind-items.json    # what judges see: source + options X/Y/Z, no origins
    ├── reveal.json         # sealed label → providers map, plus the seed
    ├── results/<judge>.json
    ├── summary.json        # votes, tally, consensus label, accepted text, status
    └── BLIND-AUDIT.md
```

`accepted.json` records each resolved key with `via: "faceoff" | "consensus_cull" | "blind_audit"`.
`escalate.json` keeps the unresolved rows, each with a `postEscalate` trail such as
`["faceoff:near_tie"]`, and lists the resolved ones under `resolved`.

Rerun with `--seed <n>` (recorded in `manifest.json`) to reproduce a shuffle. The default seed is
derived from the locale and catalog name, so reruns reuse cached verdicts.

## Missing verdicts

A judge that returns nothing, unparseable output, or a label that isn't one of the options is an
error, not an abstention and never a pass. The run exits `1`, and rerunning resumes from the cache.
A judge that explicitly answers `none` (no option acceptable), or Jev abstaining below its
confidence floors, is recorded as an abstention in `summary.json`.

## Origin

The stages were first run by hand as scripts on a Turkish product catalog, then ported into
`src/` as these flags. See [results.md](results.md) for that run.
