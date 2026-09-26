# Model bakeoff: low-cost OpenRouter models per stage (2026-09-25)

This is the evidence behind the `budget` and `cheapest` presets in
[`config/models.json`](../config/models.json) (`openrouter.presets`). It's a dated snapshot. Model
IDs and prices change, so rerun a bakeoff before you trust these numbers for a new language family.

## Setup

- **Strings:** the 12 strings in `fixtures/rtl-smoke/en.json` (including an ICU plural), plus two
  placeholder strings (`Exporting {{name}}…` and `%s of %d frames rendered`). That's 14 strings per locale.
- **Locales:** `tr` (with `fixtures/rtl-smoke/glossary.tr.json`), `ar`, `he`, and `ja` (with
  `fixtures/tidy-sample/glossary.ja.json`). That's 56 strings per model.
- **Planted drift:** each locale also gets 3 hand-made candidates that change the meaning
  ("Rendering…" → "Processing…", "Pause" → "Stop", "Export complete" → "Import complete") and 1
  faithful control. These test back-translation and the judge's drift check.
- **Reference:** the `balanced` defaults (translate `anthropic/claude-opus-5.5`, back-translate
  `x-ai/grok-4.7`, judge `openai/gpt-5.6-sol`). Each cheap translator's output was back-translated
  by the reference back-translator and scored by the reference judge.
- **Calls:** every call went through the council's own OpenRouter adapter (JSON schema output,
  default batch sizes) with `OPENROUTER_TIMEOUT_MS=90000`, `OPENROUTER_MAX_RETRIES=1`, and a
  5-minute limit per stage call.
- **Prices:** read from the live OpenRouter model list on the day. Cost is OpenRouter's `usage.cost`.
- **Candidates:** Kimi (`moonshotai/kimi-k2.6`), DeepSeek (`deepseek/deepseek-v4.1-flash`), Qwen
  (`qwen/qwen3.8-flash`), GLM (`z-ai/glm-5.3-flash`), Gemini (`google/gemini-3.5-flash-lite`), and
  OpenAI (`openai/gpt-6-luna`).

The whole bakeoff cost about $1.50 in OpenRouter credits, including one aborted first attempt.

## Translate (56 strings)

| Model | Cost | Accepted by reference judge | Mean meaning | ICU and placeholders intact | Avg latency / batch | Failures |
|---|---|---|---|---|---|---|
| claude-opus-5.5 (reference) | $0.0544 | 77% | 0.91 | 56/56 | 6.5 s | none |
| kimi-k2.6 | $0.0458 (3 locales) | 79% | 0.91 | 42/42 | 121 s | `he` timed out |
| **deepseek-v4.1-flash** | $0.0044 | 80% | 0.93 | 56/56 | 48 s | none |
| qwen3.8-flash | $0.0039 (3 locales) | 67% | 0.89 | 42/42 | 33 s | `tr` HTTP 429 |
| glm-5.3-flash | $0.0043 | 77% | 0.92 | 56/56 | 44 s (max 130 s) | none |
| gemini-3.5-flash-lite | $0.0039 | 73% | 0.89 | 56/56 | 1.9 s | none |
| gpt-6-luna | $0.0012 | 84%* | 0.96* | 56/56 | 7.3 s | none |

\* gpt-6-luna is in the same family as the reference judge, so its score may be inflated by
self-preference. It's also why `budget` can't pair it with the OpenAI judge (the diversity check
would warn).

RTL: every model produced Arabic/Hebrew script with no stray bidi control characters.
gemini-3.5-flash-lite added an English gloss to one Hebrew string ("… (Ease in/out)"). Only
claude-opus-5.5 and qwen3.8-flash wrote the full Arabic CLDR plural set
(`zero/one/two/few/many/other`). The others used `one/other`, which is valid ICU but thin Arabic
grammar.

## Blind back-translation (72 items: 56 strings and 16 planted)

| Model | Cost | Planted drift exposed | Avg latency | Failures |
|---|---|---|---|---|
| grok-4.7 (reference) | $0.0403 | 16/16 | 24 s | none |
| kimi-k2.6 | $0.0495 | 12/12 | 124 s | `ja` timed out |
| deepseek-v4.1-flash | $0.0084 | 16/16 | 33 s | none |
| qwen3.8-flash | $0.0057 | 16/16 | 49 s | none |
| glm-5.3-flash | $0.0054 | 16/16 | 40 s | none |
| **gemini-3.5-flash-lite** | $0.0044 | 16/16 | 1.9 s | none |
| gpt-6-luna | $0.0011 | 16/16 | 6.1 s | none |

Back-translation is literal work. Every model rendered the planted drift literally ("Processing…",
"Stop", "Import complete"), so cost, latency, and a vendor that differs from the other two stages
decide this stage.

## Judge and drift check (56 strings, 12 planted drifts, 4 controls)

| Model | Cost | Agrees with reference | Reference escalations also caught | Planted drift caught | Controls accepted | Avg latency | Failures |
|---|---|---|---|---|---|---|---|
| **gpt-5.6-sol (reference)** | $0.0804 | – | 13/13 | 12/12 | 4/4 | 27 s | none |
| kimi-k2.6 | $0.1122 | 13/14 | 1/2 | 3/3 | 1/1 | 248 s | 3 of 4 locales timed out |
| deepseek-v4.1-flash | $0.0242 | 44/56 | 3/13 | 12/12 | 4/4 | 143 s | none |
| qwen3.8-flash | $0.0103 | 31/42 | 5/12 | 5/9 | 3/3 | 120 s | `ja` HTTP 429 |
| glm-5.3-flash | $0.0083 | 42/56 | 1/13 | 12/12 | 4/4 | 61 s | none |
| gemini-3.5-flash-lite | $0.0133 | 47/56 | 4/13 | 6/12 | 4/4 | 6.1 s | none |
| gpt-6-luna | $0.0047 | 47/56 | 4/13 | 10/12 | 4/4 | 24 s | none |

The judge is where the cheap models fall short. Most of them catch blatant meaning flips. But
the ones that finished accepted 7–12 strings that the reference judge escalated. Those strings were subtle
domain errors, the kind the council exists to catch: "Rendering" read as "display" in Arabic,
"Ease in/out" as "Facilitate entry/exit", an "Onion peel" calque, and "Open documents" for
"Open documentation". The reference escalations are a strong model's judgment, not ground truth,
but the gap was consistent across all four locales.

## Recommendation

| Preset | Translate | Back-translate | Judge | Cost / 14-string locale | Use for |
|---|---|---|---|---|---|
| `balanced` (default) | claude-opus-5.5 | grok-4.7 | gpt-5.6-sol | ≈ $0.044 | Sign-off runs |
| `budget` | deepseek-v4.1-flash | gemini-3.5-flash-lite | gpt-5.6-sol | ≈ $0.022 | Everyday deltas: same judge, about half the cost |
| `cheapest` | deepseek-v4.1-flash | gemini-3.5-flash-lite | gpt-6-luna | ≈ $0.003 | Drafts, smoke tests, huge catalogs you re-judge later |

Excluded for now: **kimi-k2.6** was slow (2–5 min per batch at these sizes), hit repeated
timeouts and empty or invalid replies, and cost about as much as the reference translator.
**qwen3.8-flash** was rate-limited (HTTP 429) on 2 of 12 stage calls and missed planted drifts as
a judge. Both are worth retrying later. deepseek-v4.1-flash is slow as a judge (about 2.4 min
per batch of 5), which is another reason `budget` keeps the reference judge.
