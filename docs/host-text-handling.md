# Host text handling

A string the judge ships is only half done. The app that loads it still has to show it. Every
localization run checks how **each host app** consumes the text, for every app in scope, not only
the one that broke last. A missing check, or a missing encoding branch, is a **defect** even when
every row ships.

## The five checks (per host app and supported version range)

Find the answer in code or vendor docs and record it in the PR or hand-off report.

1. **Encoding path.** What encoding the host expects per version and OS (UTF-8, UTF-16, system ANSI
   codepage, …) and whether your code converts to match. Hosts that change behavior by version or OS
   need every branch present, plus an override (for example an environment variable).
2. **Limits and reserved characters.** Byte or character caps per field, measured in the host's
   encoding rather than in characters; truncation behavior; reserved bytes or delimiters (for
   example `|` / `0x7C` in popup lists).
3. **Fallback.** What happens when a string fails (blank, mojibake, source-language fallback) and
   whether that fallback is safe.
4. **Fonts and layout.** Glyph coverage for CJK and Cyrillic, text direction, and room for longer
   languages (clipping, ellipsis).
5. **Proof.** A real or emulated render, or a unit test that exercises each encoding branch, for at
   least one CJK and one Cyrillic locale. With no proof, list it as an open risk.

## Language detection

Detection is part of the same check.

- Use only **documented** OS UI-language APIs. On Windows: `GetUserDefaultUILanguage` plus
  `LCIDToLocaleName`. Never call an API name that is not in the vendor docs; a bad name can fail
  silently and look like English.
- Map OS tags to catalog files explicitly, for example `zh-Hans*` → `zh-CN`, LANGID `0x0411` →
  `ja`. Generic prefix stripping (`zh-Hans-CN` → `zh`) misses region-keyed catalogs.
- Tests **must fail** when detection returns empty or silently falls back to the source language.
  A test that passes on a silent English fallback proves nothing.

## Worked example (illustrative): After Effects plugins on Windows

After Effects reads plugin UI strings on Windows in the **system ANSI codepage** (ja cp932, ko
cp949, zh-CN cp936, ru cp1251, Western cp1252) before AE 26.2, and as **unchanged UTF-8** on 26.2+
or when the system codepage is 65001. Ship both branches plus an env override. Popup items are
capped at **31 bytes** in the target encoding and must not contain byte `0x7C`. Always converting
blanks dropdowns on newer AE; never converting breaks older AE.

## Hand-off and PR body

Add a **Host text handling** section to every PR or hand-off. One row per host app:

```
## Host text handling
| Host / versions | Encoding path | Limits & reserved | Fallback | Fonts & layout | Detection | Proof |
|---|---|---|---|---|---|---|
| <app> <range> | ✅ / ⚠️ note | … | … | … | … | render / test / ⚠️ open risk |

Warnings: <any missing host text handling check, missing encoding branch, or untested detection>
```

The council CLI does not run these checks itself; they are a required step for the agent or person
running it.
