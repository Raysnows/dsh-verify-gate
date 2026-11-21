# dsh-verify-gate

**A completion gate for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).**
When a turn changed code files and nothing was run to check them, it says so — once —
at the next step, and accepts an exemption when no check applies.

English · [简体中文](README.zh.md)

---

## Why

Measured on a real machine, 49 sessions / 937 turns:

| metric | value |
|---|---:|
| turns that edited **code** files | 394 |
| …that never ran a test or type check | **355 (90.1%)** |

That is the failure mode Can Bölük catalogued in
[_The Harness Problem_](https://blog.can.ac/2026/02/12/the-harness-problem/):
the agent writes, re-reads, decides it looks fine, and stops — without ever asking reality.

DSH ships a safety reviewer (`dsh-experimental-auto-review`) and advisory loop reminders,
but nothing guards the *completion* boundary. This plugin is that guard.

## How it works

Three harness seams, read out of `@deepseek-ai/dsh-agent-loop/lib/index.js` on DSH
`0.2.2-rc.5` — not guessed:

| seam | kind | role |
|---|---|---|
| `tools/execute` | waterfall `(exec, next)` | observe calls; `exec.name` + `exec.arguments` |
| `agent/pre-step` | waterfall `(payload, next)` | **inject** the reminder into `decision.messages` |
| `agent/turn-stopping` | serial | settle the turn, reset the ledger |

> `turn/start` and `turn/end` are **session records** (`session.append(...)`), not context
> events. Listening for them silently never fires.

The injected message lands in the model's context for the very next step:

```json
{ "role": "user", "content": [{ "type": "text", "text": "<system-reminder>\nThis turn changed 1 code file(s) but nothing was run to check them. Run the project tests (or a type check) before calling the task done, or call verify_exemption with a concrete reason why no check applies.\n</system-reminder>" }], "source": { "kind": "verify-gate" } }
```

> **It must be a `user` message.** `agent/pre-step` messages that are not `runtime-context`
> are recorded by the harness as `user/message` session events no matter their role, so a
> `system`-role payload there writes a log that fails validation on load
> (`... message must have role "user"`) and can no longer be opened. The
> `<system-reminder>` wrapper is the harness's own convention for mid-conversation
> injections, so the model still reads it as harness guidance, not user speech.

## Repairing a session broken by 0.1.0

0.1.0 could write one unloadable row into a session log. Upgrading to 0.1.1+ stops new
damage, but it does not repair logs that are already broken: the session keeps failing to
open until that row is rewritten. This package ships the repair:

```sh
node node_modules/dsh-verify-gate/scripts/repair-session.mjs           # dry run, all sessions
node node_modules/dsh-verify-gate/scripts/repair-session.mjs --apply   # rewrite, with backups
```

It finds `user/message` rows whose payload is a `system` message, rewrites them into the
canonical `system/message` event the harness itself writes (`turn`/`step` taken from the
preceding `step/start`), recompresses only the Zstandard frame that held the row, verifies
the rebuilt log before writing, keeps `session.v4.jsonl.zstd.orig-<timestamp>` beside the
original, and moves that session's projection cache aside so it rebuilds.

Run it **while DSH is closed** — it rewrites session artifacts on disk. `--sessions-dir`
points it at a different root; `--no-projcache` leaves the cache alone.

## Design choices

- **Warn, never block.** Blocking turns makes every task slower; a reminder costs one line.
- **Code files only.** `.md` / `.json` edits do not count, otherwise every doc commit screams.
- **A failing check still counts as verified.** The plugin cares whether the agent looked at
  reality, not whether reality said yes.
- **An exemption exists.** `verify_exemption(reason)`, reasons under 12 characters rejected.
  A gate that cries wolf gets uninstalled.

## Live verification (DSH 0.2.2-rc.5)

| arm | behaviour | nudges |
|---|---|---:|
| A | `write` a `.js`, verify nothing | **1** |
| B | `write` a `.js`, then `node --check` | 0 |
| C | `write` a `.mjs`, then `verify_exemption` | 0 |

The plugin loaded without restarting the host.

## Known limits

- **Direct `fs` writes inside PTC bypass tool dispatch** and are not seen. Only
  `tools.write` / `tools.edit` inner calls are observed.
- **Single ledger.** `agent/pre-step` carries no agent identity, so concurrent agents
  share one conservative judgement rather than a fake per-agent isolation.
- **Verification is a command regex.** A project-specific check script may be missed —
  the failure direction is one extra reminder, never a false pass.

## Install

```sh
dsh plugin --profile web add dsh-verify-gate    # from npm
```

Or from a source checkout:

```sh
dsh plugin --profile web add /absolute/path/to/dsh-verify-gate
```

## Test

```sh
node test/run.mjs            # 11 ledger cases
node test/wiring.test.mjs    # 8 wiring cases (fake host context)
```

`node --test` spawns a child per file; on a sandboxed host that fails with `EPERM`,
so these are plain in-process runners.

## Reproduce the evidence

```sh
node scripts/evidence.mjs   # reads ~/.dsh/sessions/*.jsonl.zstd
```

## License

MIT
