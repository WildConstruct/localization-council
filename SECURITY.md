# Security policy

## Reporting a vulnerability

Please report security issues privately. Don't open a public issue.

- **Preferred:** GitHub private vulnerability reporting. Open the repository's **Security** tab,
  choose **Report a vulnerability**, and fill in the form
  (<https://github.com/WildConstruct/localization-council/security/advisories/new>).
- **Alternate:** email <support@wildconstruct.com> with "security" in the subject line if you
  can't use GitHub reporting.

Include the affected version or commit, how to reproduce, and the impact. We aim to acknowledge
reports within 5 business days and will coordinate a fix and disclosure date with you.

## Scope

Things we especially want to hear about:

- API keys or tokens leaking into artifacts (`manifest.json`, `run.log`, the cache) or into output
  (keys come only from the environment and should never be written).
- Path handling in the CLI or the MCP server that writes outside the requested `--out` directory
  in ways a caller wouldn't expect.
- Prompt-injection paths that make the council accept a row it should escalate.

Model quality issues (a bad translation that passed) are bugs, not vulnerabilities. Please use a
normal issue for those.

## Supported versions

Only the latest release on `main` gets security fixes.
