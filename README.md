# Localization Council

Machine translation of product UI is usually fluent. Mostly the mistakes are fluent too: a
literal calque that confuses professional users, or a "Rendering…" that quietly becomes "Processing…".
Localization Council flags those before they ship. It drafts each string with the glossary you
provide, has a different model back-translate it blind, scores meaning and glossary compliance, and
sends anything doubtful to a person. The person doesn't need to speak the target language, because every
flag comes with the source, the candidate, a blind back-translation, and a reason.

It was built to localize a real product's UI catalog and is released under MIT so small teams
can use it and help improve it.

**What runs today:** translate (glossary-aware, with placeholder and ICU checks) → blind
back-translate (a different vendor) → judge (meaning of the back-translation against the source,
fluency, glossary compliance) → accept into output or escalate to a person. Optional faceoff,
consensus cull, and blind audit then work through the escalated rows. **What it doesn't do (yet):**
research the product's domain, run a separate semantic-drift stage (drift is caught by the judge's
meaning score against the blind back-translation), or generate glossaries (you write them). Those
are on the [roadmap](docs/backlog.md#roadmap).

It runs three ways with the same commands and the same artifacts:

- **mock**: offline and deterministic, with no keys. Use it to try the tool and in CI.
- **openrouter**: one `OPENROUTER_API_KEY`, with a model per stage.
- **fleet**: the `claude`, `grok`, and `codex` terminal CLIs you already have logged in.

## Pipeline

```
            ┌──────────────┐   ┌──────────────────────┐   ┌──────────────┐
 en.json ──►│  translate   │──►│ blind back-translate │──►│    judge     │──┬──► accepted.json
 (delta)    │  glossary +  │   │  never sees the      │   │  meaning,    │  │    (accepted into output)
            │  ICU/token   │   │  English source;     │   │  fluency,    │  │
            │  checks      │   │  different vendor    │   │  glossary    │  └──► escalate.json + report.md
            └──────────────┘   └──────────────────────┘   └──────────────┘         (a person decides)
                                                                                    │
                                     optional: faceoff → consensus cull → blind audit
```

Every stage caches its results. A rerun skips work that already finished, and every run writes a
`manifest.json` that records the profile, the models that answered, the thresholds, the seed, tool
versions, and cost.

### Two terms used everywhere

- **Accept into output**: the council writes a candidate to `accepted.json` under `--out`. That is
  the only thing the council ever does with a translation.
- **Merge**: a person moves accepted strings into the product catalog, usually through a normal
  pull request. The council, and any agent that drives it, never merges.

## Quickstart

Install from git. The package has zero dependencies (Node ≥ 20 standard library only) and adds a `council` command:

```bash
npm install -g github:WildConstruct/localization-council   # or: git clone … && node src/cli.mjs
```

**Mock** (offline, no keys):

```bash
git clone https://github.com/WildConstruct/localization-council && cd localization-council
node src/cli.mjs doctor
node src/cli.mjs run --profile=mock --catalog fixtures/toy/en.json --locale de --glossary fixtures/toy/glossary.de.json
```

**OpenRouter** (one key):

```bash
export OPENROUTER_API_KEY=…
council doctor --online
council run --profile=openrouter --catalog locales/en.json --locale de --target locales/de.json
council run --preset budget --catalog locales/en.json --locale de --target locales/de.json
```

**Fleet** (local CLIs):

```bash
council doctor            # shows whether claude, grok and codex are installed, recent enough, and logged in
council run --profile=fleet --catalog locales/en.json --locale de --target locales/de.json
```

`--target` limits a run to keys that are missing or untranslated in the locale file. Artifacts go to
`--out`, which defaults to `./scores/<locale>/`:

| File | What it is |
|------|------------|
| `candidates.json` | Draft translations with token and ICU check results |
| `backtranslations.json` | Blind back-translations |
| `scores.json` | Judge verdicts |
| `accepted.json` | Strings the council accepted into output (`{ strings: { key: text } }`) |
| `escalate.json` | Rows a person needs to look at, with reasons |
| `report.md` | The same information as a readable report |
| `manifest.json` | Profile, models, thresholds, seed, tool versions, cost, cache hits |

Default stage models for each profile live in [`config/models.json`](config/models.json). Each
profile uses a different vendor for translation, back-translation, and judging. The council warns
if you pick models from the same family for two of those stages (see
[docs/openrouter.md](docs/openrouter.md#vendor-diversity)).

## A glossary entry

Glossaries record what the product means by a term, the word practitioners actually use, and the
wrong words, each with the reason it's wrong
([schema](schemas/glossary.v0.json)). From [`fixtures/toy/glossary.de.json`](fixtures/toy/glossary.de.json):

```json
{
  "source": "onion skin",
  "locale": "de",
  "productMeaning": "Semi-transparent overlay of adjacent frames for frame-by-frame animation.",
  "relatedTerms": ["Onion skinning", "ghost frames"],
  "practitionerTerm": "Onion Skin",
  "approved": true,
  "rejected": [
    { "term": "Zwiebelschale", "why": "Calque that confuses artists; keep English loan in UI." },
    { "term": "Geisterbilder", "why": "Implies haunt/ghost UI, not standard animation jargon." }
  ]
}
```

## An escalated row

From `report.md` after the mock quickstart above:

| Key | Source | Candidate | Back-translation | Meaning | Reasons |
|-----|--------|-----------|------------------|---------|---------|
| `ui.viewport.onion` | Onion skin | Zwiebelschale | Onion skin | 0.96 | glossary_violation; rejected term "Zwiebelschale": Calque that confuses artists; keep English loan in UI. |

The back-translation looks perfect, so meaning alone would have accepted it. The glossary catches
it. Add `--faceoff --consensus-cull --blind-audit` and the council tries other providers for the
escalated rows, then accepts "Onion Skin" into output once two independent candidates agree and
pass every check.

## For agents

Agents can also use the stdio MCP server; see [docs/mcp.md](docs/mcp.md).

Every subcommand takes `--json` and prints one summary object
([schemas/summary.v1.json](schemas/summary.v1.json)). Exit codes are `0` clean, `10` escalations
(or reopen rows for `tidy`), `1` error, `2` usage, and `3` for a doctor preflight that failed. Without
`--json`, the council prints nothing when there is nothing to do. [AGENTS.md](AGENTS.md) is the
full contract: how to run a delta, how to read `escalate.json`, and what to hand a person.

```js
import { runCouncil } from "localization-council";
const summary = await runCouncil({ catalog: "en.json", locale: "de", profile: "mock", out: "scores/de" });
```

## Advanced

- [Post-escalate stages](docs/escalate-resolution.md): faceoff, consensus cull, and blind audit (`--faceoff`, `--consensus-cull`, `--blind-audit`).
- [Retrospective tidy](docs/retrospective-tidy.md): `council tidy` re-audits strings that already shipped when a better judge or glossary arrives.
- [Multi-repo garden](docs/garden.md): walk many catalogs, with locale tiers.
- [Jev decision gates](docs/jev-gates.md): an optional typed judge (`judge=api:jev`) for accept/escalate and blind-audit votes.
- [Agent routines](docs/routines/scheduled-agent.md): a scheduled agent runs deltas, stays quiet when clean, and pings a person when needed.
- [Fleet CLIs](docs/fleet-cli.md) and [OpenRouter](docs/openrouter.md): provider details, environment variables, and timeouts.
- [Model presets](docs/openrouter.md#presets-and-per-stage-overrides) (`--preset balanced|budget|cheapest`, `--judge-model` …) and the [cheap-model bakeoff](docs/model-bakeoff.md) behind them; agents follow [skills/model-selection/SKILL.md](skills/model-selection/SKILL.md).
- [Pipeline internals](docs/pipeline.md), [CI as a PR gate](docs/ci-delta.md), [design notes](docs/design-notes.md), and [results](docs/results.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). `npm test` runs everything offline. CI never calls a live
provider, and `npm run smoke:openrouter` / `npm run smoke:fleet` run the live checks when you
have the keys or CLIs.

## About Wild Construct

Wild Construct makes tools for artists. Our mission is to build professional creative tools that
expand what artists can do without increasing their dependence on the companies that make them.

We hold ourselves to [The Artist Compact](https://wildconstruct.com/compact/). Its core idea is
that a tool should increase an artist's capability without increasing their captivity. The Compact
judges every tool we make by seven properties: Directable, Embodied, Decomposed, Persistent,
Low-friction, Accessible, and Legible.

We hope to keep building better tools for artists, and to build more of them in the open.
Localization Council is one small part of that. Creative software should meet artists in their own
language, and the words in a UI carry real craft knowledge. This harness keeps that work open,
legible, and auditable: every accepted string and every escalation leaves a trail that a person can
read, reproduce, and question.

## License

MIT. See [LICENSE](LICENSE). Maintained by Wild Construct.
