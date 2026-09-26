# Provider fixtures

The contract test (`test/contract.test.mjs`) runs every adapter against these
fixtures. CI never calls a live provider.

- `openrouter/*.json`: chat-completion bodies in OpenRouter's response shape
  (`model`, `choices[0].message.content` holding the stage JSON, and `usage.cost`).
- `jev/*.json`: Decisions API bodies (`model`, typed `answers`, `usage`).
- CLI envelopes come from the fake CLIs in `test/fixtures/fake-*.mjs`.

Refresh them from real traffic with `npm run smoke:openrouter -- --record`. That writes
the live response bodies for the contract batch to
`test/fixtures/recorded/openrouter/`. Review the diff before you commit. The
smoke run needs `OPENROUTER_API_KEY` and costs a few cents.
