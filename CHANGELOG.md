# Changelog

## 0.1.0 — 2026-11-21

First release.

- Observe tool calls through the `tools/execute` waterfall; track which code files a
  turn touched and whether anything verified them afterwards.
- Nudge through the `agent/pre-step` waterfall: when a turn edited code and nothing was
  run, one system message is appended to the next step's context.
- `verify_exemption(reason)` tool so an agent can declare why no check applies
  (reasons under 12 characters are rejected).
- Single ledger by design: `agent/pre-step` carries no agent identity, so per-agent
  isolation would be fake. Concurrent agents share one conservative judgement.
- 19 tests: 11 for the ledger, 8 for the wiring.

Verified live against DSH 0.2.2-rc.5:

| arm | behaviour | nudges |
|---|---|---:|
| A | `write` a .js, verify nothing | 1 |
| B | `write` a .js, then `node --check` | 0 |
| C | `write` a .mjs, then `verify_exemption` | 0 |
