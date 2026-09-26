# Contributing

Thanks for helping. Localization Council is small on purpose: zero runtime dependencies, one
provider contract, and deterministic tests.

## Setup

```bash
git clone https://github.com/WildConstruct/localization-council && cd localization-council
npm test          # everything offline: unit, contract (recorded fixtures + fake CLIs), profile parity
npm run demo      # mock run on the toy German catalog
```

You need Node ≥ 20. `npm install` isn't needed because there are no dependencies.

## Security

Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md). Please don't
open public issues for them.

## Ground rules

- **CI never calls a live provider.** New behavior needs a test that runs offline, with the mock
  profile, `test/fixtures/fake-*.mjs`, the local fake OpenRouter server
  (`test/helpers/fake-openrouter.mjs`), or recorded fixtures.
- **Every adapter passes the contract test** (`test/contract.test.mjs`). A new provider implements
  `translate`, `backtranslate`, `judge`, and `compare` over batches (`src/providers/contract.mjs`),
  or throws `UnsupportedStageError` for stages it can't do. Add it to the contract test's list.
- **Fail closed.** Missing or malformed provider output is an error (`MissingVerdictError`),
  never a pass.
- **Model IDs and minimum CLI versions live in `config/models.json`.** Docs link there instead of repeating IDs.
- **Bump the prompt version** when you change prompt wording (`src/providers/prompts.mjs` or the
  adapter's `promptVersion`), so stale cache entries aren't reused.
- **Keep the machine contract stable.** Changes to `--json` output or exit codes need a matching
  change to `schemas/summary.v1.json` and a note in the PR.
- **Say "accept into output" and "merge"** the way the README defines them. The council never merges.

## Live checks (optional)

```bash
OPENROUTER_API_KEY=… npm run smoke:openrouter
npm run smoke:fleet     # claude, grok and codex installed and logged in
```

Both skip cleanly when their prerequisites are missing. `npm run smoke:openrouter -- --record` refreshes
the OpenRouter fixtures. Review that diff before committing.

## Pull requests

- Keep them focused. Describe the behavior change and how you tested it.
- `npm test` must pass.
- Glossary or fixture changes: explain the terminology choice in the entry's `why`.

## Good first issues

See [docs/good-first-issues.md](docs/good-first-issues.md), or the `good first issue` label.
