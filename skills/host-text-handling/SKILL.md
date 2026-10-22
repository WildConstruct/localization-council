---
name: host-text-handling
description: Use before opening any localization PR or hand-off, for every host app that will load the strings. Checks encoding per version and OS, byte limits and reserved characters, fallback, fonts and layout, language detection, and proof.
---

# Host text handling

Full rules: [docs/host-text-handling.md](../../docs/host-text-handling.md).

For every host app and version range in scope, before any PR:

1. Encoding path per version and OS, every branch present, plus an override.
2. Limits measured in the host's encoding; reserved bytes or delimiters.
3. Fallback behavior is safe (no blank or mojibake).
4. Fonts and layout for CJK and Cyrillic and longer languages.
5. Proof: a render or a test per encoding branch, one CJK and one Cyrillic locale minimum.
6. Language detection: documented OS APIs only (Windows: `GetUserDefaultUILanguage` +
   `LCIDToLocaleName`), explicit tag-to-catalog mapping (`zh-Hans*` → `zh-CN`), and tests that fail
   on empty detection or a silent source-language fallback.

A missing check or branch is a defect even if every row ships. Put a **Host text handling** table and
warnings in the PR body; anything unproven goes in as an open risk.
