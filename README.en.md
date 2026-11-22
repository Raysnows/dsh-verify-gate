# dsh-verify-gate

**Stop the agent from saying "done" without checking anything.**

When a turn changed code files and nothing was run to verify them, this plugin puts one
reminder in front of the model before it can finish: go run something, or state a concrete
reason why no check applies.

[简体中文](README.md) · English

---

## What it actually does

Agents share one failure mode: they **write, re-read, decide it looks fine, and stop** —
without ever running anything. The "done" you see may never have been checked.

`dsh-verify-gate` stands on exactly that step. Every turn it asks two questions:

1. Did the agent **change code files** this turn? (`.js` / `.ts` / `.py` / `.go` / `.rs` …)
2. Did anything **check them afterwards**? (tests, a type check, `node --check`, `tsc`, `pytest` …)

When the first is yes and the second is no, it injects one reminder into the model's **next
step of context**: run the tests, or say why none apply.

**The reminder talks to the model, not to you.** Catching it before it declares the task done
is worth far more than a badge you notice later.

## Why it exists

Measured on a real machine, 49 sessions / 937 turns:

| metric | value |
|---|---:|
| turns that edited **code** files | 394 |
| …that never ran a test or type check | **355 (90.1%)** |

That is the failure mode Can Bölük catalogued in
[_The Harness Problem_](https://blog.can.ac/2026/02/12/the-harness-problem/).
DSH ships a safety reviewer (`dsh-experimental-auto-review`) and advisory loop reminders,
but nothing guards the *completion* boundary. This plugin is that guard.

## What it deliberately does not do

- **Never blocks.** A reminder costs one line; blocking makes every task slower. A gate that
  cries wolf gets uninstalled.
- **Code files only.** `.md` / `.json` edits do not count, otherwise every doc commit screams.
- **A failing check still counts as verified.** It cares whether the agent looked at reality,
  not whether reality said yes.
- **No fake isolation.** `agent/pre-step` carries no agent identity, so concurrent agents share
  one conservative ledger rather than a made-up per-agent split.

## Install and forget

No configuration, no host restart. Once installed:

| the agent's behaviour | result |
|---|---|
| writes a `.js`, verifies nothing, says "done" | **1 reminder** |
| writes a `.js`, then runs `node --check` | no reminder |
| writes a `.mjs`, calls `verify_exemption("types only, no runnable path")` | no reminder |

The exemption has a floor: reasons under 12 characters are rejected, so "n/a" does not pass.

## How it works (for people who read source)

Three seams, read out of `atdeepseek-ai/dsh-agent-loop/lib/index.js` on DSH
`0.2.2-rc.5` — not guessed:

| seam | kind | role |
|---|---|---|
| `tools/execute` | waterfall `(exec, next)` | observe calls; `exec.name` + `exec.arguments` |
| `agent/pre-step` | waterfall `(payload, next)` | **inject** the reminder into `decision.messages` |
| `agent/turn-stopping` | serial | settle the turn, reset the ledger |

> `turn/start` and `turn/end` are **session records** (`session.append(...)`), not context
> events. Listening for them silently never fires — the first probe fell into that hole.

> **The injected message must be `user` role.** `agent/pre-step` messages that are not
> `runtime-context` are recorded by the harness as `user/message` session events no matter
> their role, so a `system`-role payload there writes a log that fails validation on load
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

## Known limits

- **Direct `fs` writes inside PTC bypass tool dispatch** and are not seen. Only
  `tools.write` / `tools.edit` inner calls are observed.
- **Single ledger.** See "No fake isolation" above.
- **Verification is a command regex.** A project-specific check script may be missed — the
  failure direction is one extra reminder, never a false pass.

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
node test/wiring.test.mjs    # 11 wiring cases (fake host context)
```

`node --test` spawns a child per file; on a sandboxed host that fails with `EPERM`,
so these are plain in-process runners.

## Reproduce the evidence

```sh
node scripts/evidence.mjs   # reads ~/.dsh/sessions/*.jsonl.zstd
```

## License

MIT
