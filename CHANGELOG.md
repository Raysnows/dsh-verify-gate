# Changelog

## 0.1.5 — 2026-11-22

- **Chinese is now the default face of the plugin.** `README.md` is the Chinese one (the market
  sniffs README.md for CJK and files it under `zh`, so the default page a Chinese reader lands
  on is the Chinese text); the English README moved to `README.en.md` and keeps every section.
  This matches where the plugin's users actually are.
- **The opening section says what the plugin does, in plain words.** The old README opened with
  a metrics table — evidence with no explanation in front of it. It now opens with the two
  questions the gate asks each turn, then what it deliberately refuses to do (no blocking, no
  docs, no judging pass/fail, no fake per-agent isolation), then the evidence.
- `locale/zh.json` and `locale/en.json` rewritten: the card text now states the behaviour
  ("提醒模型一次，不需要检查可申报豁免") instead of naming the mechanism.
- `package.json`: `description` leads with what happens rather than what it is called;
  `files` drops `README.zh.md` and ships `README.en.md`.
- No behaviour change — same code as 0.1.4, which is what the tests cover.

## 0.1.4 — 2026-11-22

- **The icon actually reaches npm now.** 0.1.3 carried the icon files in the repository but was
  published before they were wired in, so the tarball users download has no `icon.svg`, no
  `assets/` and no `icon` field — the plugin list showed the generic placeholder. This release
  is the same code with the icon shipped.
- Plugin icon (`icon.svg`, 36×36 tile): a gate frame with the tick that gets through it. The
  frame is the "gate", the tick is the only thing allowed past it. Plus `assets/icon-180.png`
  for the market card.
- No behaviour change.

## 0.1.3 — 2026-11-22

- Published without the icon assets (see 0.1.4). No behaviour change.

## 0.1.2 — 2026-11-21

- Ship `scripts/repair-session.mjs`: repairs session logs that 0.1.0 already broke
  (`user/message` rows carrying a `system` message). Dry-run by default; `--apply` rewrites,
  keeps a `.orig-<timestamp>` backup, verifies the rebuilt log, and leaves every untouched
  frame byte-identical.
- README (en/zh): how to run the repair, and why it has to happen with DSH closed.

## 0.1.1 — 2026-11-21

- **Fix: the nudge no longer corrupts session history.** The reminder was injected as a
  `system`-role message; the harness records every non-`runtime-context` `agent/pre-step`
  message as a `user/message` event, so that payload produced logs rejected on load
  (`stored session ... failed validation: message must have role "user"`) and the session
  could not be opened again. The reminder is now a `user`-role message wrapped in
  `<system-reminder>` with `source.kind = "verify-gate"`.
- Added `assertInjectable()`: an injected message that is not user-role (or that carries a
  retired `plugin`/`system-prompt` source) throws instead of reaching the log.
- Stop duplicating the call-to-action: the verdict text already carries it (the reminder
  used to repeat the sentence twice).

## 0.1.0 — 2026-11-21

First release. Published to npm as `dsh-verify-gate@0.1.0`.

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
