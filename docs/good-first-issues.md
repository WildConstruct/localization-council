# Good first issues (drafts)

Ready to open as GitHub issues with the `good first issue` label. Each one is small, fully testable
offline, and touches one area.

---

## 1. `council diff`: show the source text next to each key

**Area:** `src/cli.mjs`
Human-mode `council diff` lists keys and reasons. Add the English source, truncated to 60
characters, so a reviewer can scan the delta without opening the catalog.
**Done when:** `council diff --source fixtures/toy/en.json --target fixtures/toy/de.json` shows the
source next to each key, `--json` output is unchanged, and `test/cli.test.mjs` covers it.

## 2. Glossary fixtures for `ar` and `he`

**Area:** `fixtures/rtl-smoke/`
Only `tr` has a glossary slice, so the judge's `glossaryOk` on Arabic and Hebrew smoke runs has
nothing to check against. Add `glossary.ar.json` and `glossary.he.json` (schema v0) for
*composition*, *pre-compose*, and *onion skin*, with at least one rejected calque each and a `why`.
**Done when:** both files pass `validateGlossary` (add a test), and `scripts/smoke.mjs` passes them
for `ar` and `he`.

## 3. `report.md`: link each escalated key to its `faceoff.json` candidates

**Area:** `src/pipeline/escalate.mjs`
When post-escalate stages ran, a reviewer wants to see the alternatives for a still-escalated row.
Add a "Candidates considered" sub-list under each escalated row that has faceoff candidates.
**Done when:** a mock run with `--faceoff` (margin 0.99, so rows stay escalated) shows the
alternatives in `report.md`, with a test in `test/pipeline.test.mjs`.

## 4. `--keys-file` for `council run`

**Area:** `src/cli.mjs`, `src/index.mjs`
`council tidy` accepts `--keys-file`, but `council run` only has `--keys a,b,c`. Reuse
`parseKeysFile` from `src/tidy.mjs`.
**Done when:** `council run … --keys-file keys.txt` runs only those keys, and there's a CLI test.

## 5. Doctor: warn when `OPENROUTER_BASE_URL` points somewhere unusual

**Area:** `src/doctor.mjs`
If `OPENROUTER_BASE_URL` is set, `council doctor` should show it (host only) in the human output and
add a `warnings[]` entry, so a stray test value doesn't go unnoticed.
**Done when:** `council doctor --json` with the variable set includes a warning with code
`openrouter_base_url_override`, covered in `test/cli.test.mjs`.
