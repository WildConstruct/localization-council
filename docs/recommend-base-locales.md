# Choosing a starter locale set

Not every community needs to come first. Start narrow, show that quality holds, then promote
deferred locales one at a time. The output of this recipe drops straight into a garden manifest's
`localeTiers` ([garden.md](garden.md#locale-tiers-active-vs-deferred)).

## Ask first

| Input | Why it matters |
|-------|----------------|
| Domain | How dense the jargon is, and how many terms practitioners keep in English |
| Where paying and power users are | Which communities feel the translation first |
| Who can review | Someone has to read `escalate.json` for each locale |
| What already ships | Existing catalogs, even partial ones |
| Weekly review capacity | How many locales a person can actually keep up with |

## Heuristic

1. **Active:** one to three locales where you have users *and* a reviewer. Write the glossary slice
   before you promote the locale.
2. **Deferred:** everything else you plan to support. List them so planning is visible, but don't
   walk them.
3. **Next wave:** locales that need extra care, such as right-to-left scripts (ar, he) or markets
   waiting on a partner reviewer. Exercise them with the smoke fixtures first
   (`fixtures/rtl-smoke/`, `npm run smoke:*`).

Example for a motion-graphics tool with a strong German practitioner community:

```json
"localeTiers": {
  "active": ["de"],
  "deferred": ["es", "fr", "it", "ja", "ko", "pt-BR", "ru", "zh-CN", "tr", "ar", "he"],
  "notes": "German first: largest practitioner community and an existing glossary. Promote one deferred locale at a time once a glossary slice and a reviewer exist."
}
```

A LatAm-first SaaS product might start with `es` and `pt-BR` instead.

## Promotion checklist

Before a locale moves from `deferred` to `active`:

1. Source catalogs exist for the pages you care about.
2. Target files exist. Empty or partial files are fine, because the delta flags what's missing.
3. A glossary slice exists (schema v0), or someone has noted explicitly that there's no glossary yet.
4. A person can read that locale's escalations.
5. Add the `catalogs[]` rows and move the tag into `active`.

The council still never merges. Each promoted locale adds escalations for a person to read.

## RTL locales

The council stores RTL text as UTF-8 and scores it like any other locale. Mirroring the UI (layout,
icons, scrollbars) is the consuming app's job.
