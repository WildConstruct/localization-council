# Multi-repo garden

A **garden** is a manifest of repos and catalog pairs that one routine tends on a schedule. For
each pair it diffs source and target, runs the council only on the delta, stays quiet when
everything is clean, and hands a person the escalations. The routine is described in
[routines/scheduled-agent.md](routines/scheduled-agent.md).

`council garden` does the walking and diffing. Today it's **dry-diff only**: it reports which
catalog pairs have a delta and calls no providers. The routine then runs `council run` for each
delta row.

```bash
council garden --manifest examples/garden.example.json --root ~/checkouts --json
```

Exit `0` means the walk finished (`status` is `clean` or `delta`). Exit `1` (`status: "errors"`)
means some catalog paths weren't found under `--root`. `errors[]` names them.

## Manifest

```json
{
  "version": 1,
  "name": "example-garden",
  "localeTiers": { "active": ["de"], "deferred": ["fr", "ja", "tr"] },
  "repos": [
    {
      "repo": "your-org/your-site",
      "catalogs": [
        {
          "id": "common",
          "source": "locales/en/common.json",
          "target": "locales/de/common.json",
          "locale": "de",
          "glossary": null
        }
      ]
    }
  ]
}
```

| Field | Meaning |
|-------|---------|
| `repos[].repo` | `owner/name`. The last segment is also the checkout folder under `--root` |
| `repos[].catalogs[]` | One source↔target pair per locale file |
| `id` | A stable name for the catalog (e.g. `common`, `docs-hub`) |
| `source` / `target` | Paths relative to the repo checkout (absolute paths also work) |
| `locale` | BCP 47 tag passed to `council run --locale` |
| `glossary` | Optional glossary path |

Relative paths are tried as `<root>/<repo-name>/<path>`, then `<root>/<path>`, then relative to the
current directory. The first one that exists wins.

Full example: [examples/garden.example.json](../examples/garden.example.json).

## Locale tiers: active vs. deferred

Review capacity is the real limit, so a garden can declare which locales to walk:

| Tier | Meaning |
|------|---------|
| `active` | Locales that are walked and run |
| `deferred` | Planned locales, listed for planning but not walked (status `deferred_locale`) |

Without `localeTiers`, every catalog row is walked. To promote a locale, add its source↔target
rows, make sure a glossary slice and a reviewer exist, and move the tag into `active`. That's a
decision for a person, not the routine. Choosing a starter set:
[recommend-base-locales.md](recommend-base-locales.md).

## Catalog formats

`normalizeCatalog` (`src/catalog.mjs`) accepts:

- Flat maps: `{ "ui.play": "Play" }`
- Lists: `[{ "id": "ui.play", "text": "Play" }]` or `[{ "key": …, "value": … }]`
- Page wrappers, where the English string is its own id:
  `{ "page": "common", "locale": "en", "strings": ["Skip to content", …] }`
  and, for a locale, `{ "page": "common", "locale": "de", "strings": { "Skip to content": "Zum Inhalt springen" } }`.
  Metadata keys next to `strings` are ignored.

`accepted.json` uses the page-wrapper map form (`{ "strings": { key: text } }`), so it loads as a
catalog too.

## UTF-8 and RTL

Artifacts are UTF-8. Storing Arabic or Hebrew is fine. Mirroring the layout is the consuming
app's job. Judges score meaning and glossary compliance, not script direction.
