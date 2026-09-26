# Optional CI: run the council on catalog changes

The main way to run the council is a scheduled agent routine ([routines/scheduled-agent.md](routines/scheduled-agent.md)).
Use CI when you also want a pull-request check, or score artifacts attached to each PR.

## Consumer wiring

Copy [examples/consumer-ci.yml](../examples/consumer-ci.yml). It:

1. Installs the council from git (`npm install -g github:WildConstruct/localization-council`).
2. Runs `council run --target … --json` so only missing or untranslated keys run. It uses
   `--profile=openrouter` when an `OPENROUTER_API_KEY` repository secret exists and
   `--profile=mock` otherwise.
3. Treats exit `10` (escalations) as "a person needs to look", and any other non-zero code as a
   failure. Uncomment one line to make escalations a required gate.
4. Uploads `scores/` (without the cache) for review.

The council never merges. Reviewers read `report.md` / `escalate.json` and merge the strings from
`accepted.json` themselves.

## This repository's CI

- [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs `npm test` on Node 20 and 22. That covers
  unit tests, the provider contract test against recorded fixtures and fake CLIs, and the
  mock/openrouter/fleet parity test against local fakes. No live provider calls, no secrets.
- [`.github/workflows/council-delta.yml`](../.github/workflows/council-delta.yml) (mirrored at
  `examples/workflows/`) is the toy demo: `diff --json`, then a mock run with every post-escalate
  stage on the delta.

## Why delta-only

- Cost scales with the size of the change, not the size of the catalog.
- Stable strings aren't re-judged on every PR.
- Reviewers see only the new surface area.
