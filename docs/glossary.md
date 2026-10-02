# The glossary: how it grows and how the council uses it

The glossary is the product's own file (`locales/glossary.<locale>.json`, schema
[`glossary.v0.json`](../schemas/glossary.v0.json)). It lives in the product's repo, and a person on
the product team decides what goes in it. The council reads it on every run and proposes additions
from what ships, but it never edits it on its own.

```
          ┌──────────────── council run / tidy ─────────────────┐
          │ translate, judge, blind-audit votes and the         │
glossary ─┤ deterministic rejected-term check each use the      │
   ▲      │ entries the string's English contains               │
   │      └─────────────────────────────────────────────────────┘
   │                                │ a person merges accepted strings
   │                                ▼
   │                         shipped catalogs
   │                                │
   │                    council glossary harvest
   │                                │ glossary-proposals.json, PROPOSALS.md
   │                                ▼
   └──── council glossary apply ◄── a person decides
         (+ affected-keys.json → council tidy)
```

## How the council uses it

- **Translate.** The translator gets the approved term and the rejected terms (with their reasons)
  for every glossary term the English string contains.
- **Judge.** The judge gets the same entries and sets `glossaryOk` false when an approved term is
  rendered differently or a rejected term appears. Blind back-translation never sees the glossary.
- **Deterministic check.** Even when the judge misses it, a rejected term in the candidate
  escalates the row (`glossary_rejected_term:<term>`).
- **Post-escalate and tidy.** Faceoff candidates, consensus-cull rows and blind-audit votes go
  through the same checks, and `council tidy` re-audits shipped strings against today's glossary.

**Only the entries a string uses reach the provider.** An entry applies when its `source` term, or
one of its `relatedTerms`, appears in the English string as a whole word. Matching ignores case and
treats hyphen, space and no space the same in either direction ("pre-compose", "pre compose",
"precompose"). It also accepts common English inflections of the last word ("layers", "skinning",
"composing"). Short words get few inflections: a two-letter term like "US" matches only itself, and a
three-letter term only its plural, so "car" never matches "card". The deterministic rejected-term
check uses the entry's own `source` term, not its related terms.

This keeps prompts short as the glossary grows. The result cache keys on the entries each string
uses. Adding or editing an entry re-runs only the strings that contain its term, a glossary with no
entry for a string caches like no glossary at all, and bumping `version` alone re-runs nothing.

## How it grows

### 1. Harvest proposals from shipped strings

```bash
council glossary harvest \
  --catalog  <repo>/locales/en.json \
  --locale-file <repo>/locales/de.json \
  --glossary <repo>/locales/glossary.de.json \
  --locale de \
  --profile openrouter \
  --out scores/de-glossary \
  --json
```

Add `--accepted scores/de/accepted.json` to include strings a run accepted into output that
nobody has merged yet. The proposals can then go into the same PR as the strings.

For each shipped pair, the extractor (`--extractor`, default: the profile's judge) lists the product
and domain terms in the English and how the translation renders them. Every answer is checked
against the strings. The English term has to be in the source, and the rendering has to be in the
translation. Answers that fail are set aside (`unverified` in `terms.json`). A string identical to
its source is skipped, because it may simply be untranslated.

A term becomes a **proposal** when it appears in at least `--min-keys` keys (default 2), isn't in
the glossary, and wasn't declined earlier. Proposals whose renderings disagree come first, because
those are the terms a glossary settles.

| Exit | `status` | Meaning |
|------|----------|---------|
| `0` | `clean` | Nothing new. Every recurring term is in the glossary or was declined |
| `10` | `proposals` | Proposals are waiting for a person's decision |

Artifacts under `--out`:

| File | Contents |
|------|----------|
| `glossary-proposals.json` | The proposals. A person edits this file |
| `PROPOSALS.md` | The same proposals for reading: suggested term, every rendering with its keys |
| `terms.json` | Every term seen, with status `proposed`, `in_glossary`, `declined` or `below_min_keys`, plus unverified answers |
| `manifest.json` | Profile, extractor, model, glossary version, threshold, counts, cost, cache ([schema](../schemas/glossary-manifest.v1.json)) |

Harvest results are cached per string, so a nightly harvest only pays for strings that changed.
Re-harvesting into the same `--out` keeps a person's decisions and edits and refreshes the evidence.
A proposal a person decided or edited is never dropped. If a narrower harvest (`--keys-file`,
`--limit`) doesn't propose it again, it stays in the file marked `"stale": true` until apply puts it
in the glossary. If `glossary-proposals.json` exists but isn't valid JSON, harvest stops with exit
`2` rather than overwrite it.

### 2. A person decides

Each proposal in `glossary-proposals.json` looks like this:

```json
{
  "id": "keyframe",
  "source": "keyframe",
  "practitionerTerm": "Keyframe",
  "productMeaning": "A stored value at a point in time",
  "decision": null,
  "reject": [],
  "why": "",
  "suggested": { "source": "keyframe", "practitionerTerm": "Keyframe", "productMeaning": "A stored value at a point in time" },
  "consistent": false,
  "renderings": [
    { "term": "Keyframe", "forms": ["Keyframe", "Keyframes"], "keys": ["ui.keyframe.add", "ui.keyframe.delete"] },
    { "term": "Schlüsselbild", "forms": ["Schlüsselbild"], "keys": ["ui.keyframe.ease"] }
  ],
  "keys": ["ui.keyframe.add", "ui.keyframe.delete", "ui.keyframe.ease"],
  "affectedKeys": ["ui.keyframe.add", "ui.keyframe.delete", "ui.keyframe.ease"]
}
```

- **Approve:** set `"decision": "approve"`. Fix `source`, `practitionerTerm` and `productMeaning` if
  needed. List renderings you don't want in `reject`, as `"Schlüsselbild"` or
  `{ "term": "Schlüsselbild", "why": "…" }`. The reason is shown to translators and judges. An
  inflected form of the approved term isn't a rejection.
- **Decline:** set `"decision": "decline"` and say why in `why`. The term is recorded under the
  glossary's `declined` list and isn't proposed again.
- **Not yet:** leave `decision` as `null`.

### 3. Apply the decisions

```bash
council glossary apply --proposals scores/de-glossary/glossary-proposals.json \
  --glossary <repo>/locales/glossary.de.json            # writes scores/de-glossary/glossary.next.json
council glossary apply … --write                         # updates the glossary file in place
```

Approved terms become entries with `approved: true`, the rejected renderings, and
`origin: { via: "harvest", keys }`. Declined terms go into `declined`. A term someone already added
by hand is skipped. If `--glossary` doesn't exist yet, apply starts a new glossary, so a locale can
start growing one from nothing. Contradictory decisions are a usage error (exit `2`), and nothing
is written:
- rejecting a term contained in the approved one (rejected terms match anywhere inside a translation,
  so rejecting "Komposition" next to an approved "Vorkomposition" would flag every string that uses it)
- an unknown `decision`
- approving with an empty `practitionerTerm`

Approvals that were skipped are listed in `skipped` with a warning. Apply exits `10` while
proposals remain that aren't in the glossary yet. With `--write` it keeps the glossary's indentation
and one-line arrays, so the diff is the new entries.

Commit the updated glossary to the product repo like any other change.

### 4. Re-audit what already shipped

`affected-keys.json` lists every catalog key whose English contains a newly approved term. Strings
that shipped before the decision may use a rendering you just rejected:

```bash
council tidy --catalog <en.json> --locale-file <de.json> --locale de \
  --glossary <repo>/locales/glossary.de.json \
  --keys-file scores/de-glossary/affected-keys.json --generate-bt --json
```

Rows that use a rejected rendering reopen with a glossary reason
([retrospective-tidy.md](retrospective-tidy.md)).

## Rules

- The council proposes, and a person decides. Harvest never edits the glossary, and agents never
  fill in `decision`, never run `glossary apply --write`, and never edit glossary entries to make
  escalations pass ([AGENTS.md](../AGENTS.md)).
- Nothing is enforced until it's in the glossary. Proposals are suggestions with evidence.
- `declined` terms never reach a provider. They only stop repeat proposals.

## Try it offline

```bash
council glossary harvest --catalog fixtures/glossary-growth/en.json \
  --locale-file fixtures/glossary-growth/de.json --locale de \
  --glossary fixtures/glossary-growth/glossary.de.json --profile=mock --out scores/de-glossary
```

The fixture proposes *keyframe* (whose renderings disagree: Keyframe vs. Schlüsselbild), *layer* and
*render queue*. It skips *composition* and *onion skin* (already in the glossary) and *viewport*
(declined).

Agent recipe: [skills/glossary-growth/SKILL.md](../skills/glossary-growth/SKILL.md).
