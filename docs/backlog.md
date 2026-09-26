# Backlog

Deliberate deferrals. Good first issues are drafted in [good-first-issues.md](good-first-issues.md).

## Roadmap

Stages people expect from a localization pipeline that the council doesn't run yet (tracked as
GitHub issues with the `roadmap` label):

- **Domain research stage.** Draft a short style and terminology brief from the source catalog and
  product context before translating.
- **Separate semantic-drift stage.** Measure drift independently of the judge model, so a lenient
  judge can't hide it.
- **Per-language glossary generation.** Propose candidate glossary entries per locale for a person
  to approve. The council keeps enforcing only approved entries.

## Pipeline

- **Garden council walk.** Let `council garden` run the council per delta row, the same way the
  routine does now, with one aggregated summary.
- **Pre-run routing.** Decide single-candidate vs. faceoff per key before spending, for example
  with a Jev `run_mode` gate ([jev-gates.md](jev-gates.md#candidate-gates-not-built-yet)).
- **Batched CLI calls.** Pack 20–40 keys per CLI call for translate and back-translate, keeping the
  one-key fallback. Judges stay one key per call.
- **Full ICU AST.** Replace the lightweight structure checks with a real MessageFormat parser if
  consumers hit edge cases.
- **Screenshots / visual QA.** Show the reviewer where a string appears.

## Providers

- **Grok and Codex cost.** Record cost when those CLIs start reporting it (cost is marked
  incomplete today).
- **More Jev gates**: glossary risk, ICU risk, RTL risk, and register audit.

## Launch follow-ups

- Publish to npm (today: `npm install -g github:WildConstruct/localization-council`).
- Refresh `test/fixtures/recorded/openrouter/` from live traffic
  (`npm run smoke:openrouter -- --record`).
- Fill in the numbers in [results.md](results.md) from the Turkish run's artifacts.
- Open the drafted good first issues.
