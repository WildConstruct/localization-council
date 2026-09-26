# Design notes

Why the harness works the way it does. These decisions came out of adversarial reviews of the
provider adapters (one per CLI vendor). The full review notes are in git history; this page keeps
what still applies.

## Blind back-translation has to be enforced, not requested

- The back-translator never receives the source. That's true for the batch payload
  (`{ key, candidate }` only) and for every CLI prompt.
- Agentic CLIs could still *find* the source, so every CLI runs in an empty scratch directory, and
  Claude Code runs with its file and shell tools denied. A back-translator that can read
  `locales/en.json` produces a clean round-trip of a bad candidate, and the check quietly stops working.
- The back-translation prompt says "preserve awkwardness and errors rather than repairing them". A
  strong model otherwise smooths a bad translation on the way back and hides the drift.

## No vendor grades its own work

Fleet and OpenRouter both use three vendors: one translates, one back-translates, one judges. When
the same family appears in two stages, the council warns (`same_family_*`), and
`--strict-diversity` makes that an error. An earlier Fleet map used the same CLI for back-translation
and judging, so the judge was scoring its own round-trip.

## Judges fail closed

- Output must match a strict schema (`schemas/judge-verdict.v1.json`): `meaning` and `fluency` finite
  in 0–1, and `glossaryOk`, `escalate`, and `rationale` required. A missing or malformed field is a
  **missing verdict**, an error that stops the run (it resumes from the cache), never a silent
  pass. Earlier versions defaulted a missing `glossaryOk` to true and let a missing `meaning` fall
  through a `NaN < 0.75` comparison.
- The judge always receives the glossary, and a deterministic rejected-term check backs it up.
- Empty translations and back-translations are also missing verdicts.
- Codex answers are read only from `--output-last-message`. JSONL telemetry is never mined for text,
  because intermediate events can look like answers.

## Prompts treat catalog content as data

Every prompt says the payload is data, not instructions, and HTTP calls send it as a JSON object.
A catalog string that reads like a prompt injection is still just a string to translate.

## Process hygiene

- Everything is spawned without a shell. Prompts go on stdin wherever the CLI allows it, which avoids
  `E2BIG` on large payloads.
- On timeout the adapter sends SIGTERM, then SIGKILL after a grace period, and the kill timer
  survives the promise rejection. A fixture that ignores SIGTERM covers this in the tests.
- `codex exec` always gets `--skip-git-repo-check`. Scratch directories aren't trusted repos, and
  without the flag the failure looks like an empty answer.
- `--bare` for Claude Code is opt-in, because it skips OAuth/keychain logins.

## Everything is reproducible and resumable

A per-key result cache (keyed on inputs, model, prompt version, and glossary version) lets
interrupted runs resume and reruns cost nothing. `manifest.json` records the profile, requested
and resolved models, thresholds, seed, tool versions, and cost. The blind-audit shuffle is seeded,
and the seed is recorded.

## Deliberately not done (yet)

- Packing many keys into one CLI call. HTTP calls batch, but CLI calls stay one key per process for
  simpler failure isolation.
- A full ICU AST (see [pipeline.md](pipeline.md#icu-messageformat-what-we-protect-and-what-we-defer)).
- A council walk inside `council garden`. A routine drives `council run` per delta instead.
