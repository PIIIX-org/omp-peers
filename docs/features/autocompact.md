# Auto-compact

An opt-in policy that compacts a session's own context at a safe turn boundary once it passes a threshold. It is off by default, compacts nothing until you list a session or group as eligible, and never acts on another session.

It is separate from OMP's built-in auto-compaction setting, which stays as you configured it. This policy adds a peer-level rule on top: its own threshold, an eligible list, a cooldown, an hourly limit and an audit log. Both can be on at once; they never run at the same time (see below).

## Commands

```text
/peers autocompact on | off
/peers autocompact status
/peers autocompact set <contextPercent|minGapMinutes|maxPerHour> <n>
/peers autocompact add <session|group:<name>>      (a live session's stable id or exact name, or group:<name>)
/peers autocompact remove <session|group:<name>>
/peers autocompact log [n]                         last n events, 1-100 (default 20)
/peers autocompact reset-suppression               clear this session's cooldown, hourly count and suppression
```

Only the local user typing these in a session can change the policy. There is no tool, no peer message, no master operation and no socket op for it: a remote session, including the master and its agent, cannot enable it, change it or trigger a compaction through it. (The master's existing `compact` control op is unrelated and unchanged.)

`on` with an empty eligible list is allowed and compacts nothing; the reply and `status` say so.

## When it runs

Every session evaluates only itself, from the host's `agent_end` event of its **main** agent (never `turn_end`, which can fall between tool calls, and never for subagents or in print/json mode). In OMP's current host, `isIdle()` is still false inside the `agent_end` handler (the prompt has not unwound and the host's own maintenance has not run yet), so the policy does not compact there. It checks again through the host's timer `SETTLE_MS` = 1 second later and repeats up to 10 times in total while the session is merely not idle or the host's own auto-compaction is running; after the last check the refusal is final and logged. A new agent run starting (or a session switch or shutdown) cancels any pending check.

Compaction is requested with `ctx.compact()` only when **all** of these hold at the moment of the call (the live facts are read again immediately before it, with no wait in between):

- the policy is on, this session is eligible (its stable id is listed, or it belongs to a listed group in the group registry) and the context usage is known and at or above the threshold;
- a turn boundary was reached and no newer agent run has started;
- the session is not paused (an unreadable pause file counts as paused);
- no message is queued (`hasPendingMessages()` is false): a queued or pending prompt always wins, recorded as `skipped: pending message`;
- no async/background job is running (`getAsyncJobSnapshot()` is null or lists none): that is a protected active phase;
- the session is idle (`isIdle()`), the host is not auto-compacting (tracked from `auto_compaction_start`/`auto_compaction_end`) and no compaction of this policy is in flight;
- no loop-suppression limit applies.

No instructions or mode are passed to `compact()`: the host's default summarisation runs unchanged.

## Loop suppression

- **Cooldown**: no new attempt within `minGapMinutes` (5-1440, default 30) of the previous attempt (measured from its end).
- **Hourly limit**: at most `maxPerHour` (1-6, default 2) attempts in any rolling hour per session. A failed attempt counts.
- **Hysteresis**: if the context after a successful compaction is still at or above the threshold, the session is suppressed until a later measurement falls below the threshold, or until `reset-suppression`. If the context after compaction cannot be read, nothing is guessed: the cooldown and hourly limit still apply.
- **Failures**: `onError`, a rejected promise and a synchronous throw all count as one failed attempt with a cooldown; there is no tight retry. The error text is dropped; the log says `failed: compaction error`.

An attempt is reserved in the state file under the lock before `compact()` is called, so overlapping evaluations cannot both pass the limits; a reservation the final re-check refuses is released again.

## When metrics or the safe-boundary API are unavailable

- Context usage missing, undefined, `percent` null, not a number or negative: **unknown**. Nothing is compacted, one `skipped: context unknown` line is logged per episode (not per turn; a known measurement below the threshold ends the episode), and `status` says `context: unknown (never guessed; nothing is compacted)`. The percentage is never derived from tokens.
- `compact`, `isIdle`, `hasPendingMessages` or `getAsyncJobSnapshot` missing, throwing or returning an unusable value: the policy reports `unavailable: <what>` in `status` and the log (once per episode) and never compacts. A snapshot of `null` (the host has no job manager) means no jobs are running.
- The group registry unreadable while eligibility depends on a group: `eligibility unknown`, no compaction.
- `autocompact.json` unreadable or invalid: no compaction and no write; `status` shows the error. Fix or remove the file.

## status and log

`status` shows the settings, the eligible list, this session's eligibility, the host capabilities, the current context percentage, this session's limiter state, and `would compact at the next safe turn boundary: yes` or `no (<reason>)`. It calls the same decision function as the real evaluation with the live facts (assuming the next boundary), so the answer matches what the next boundary would do for the same facts. `status` and `log` are read-only: they never write the state file, compact or wake anything.

Every reason is from a fixed vocabulary: `disabled`, `not eligible`, `eligibility unknown`, `unavailable: ...`, `context unknown`, `below threshold`, `paused`, `pending message`, `host compaction running`, `compaction in flight`, `async job running`, `not idle`, `suppressed: context still above threshold`, `cooldown`, `hourly limit`.

## Audit trail and reporting

Every compaction attempt and every refusal other than the resting states below is appended to the log in `autocompact.json` (the last 100 events are kept), as is each configuration change (`changed: enabled|disabled|settings|eligible|suppression reset`). An event records the time, the stable session id, the outcome (`compacted`, `failed`, `skipped`, `changed`), a fixed reason, the context percent that triggered it and, after a success, the percent afterwards when known. A repeated identical refusal is logged once until something else happens. Resting states (`disabled`, `not eligible`, `below threshold`) are not logged.

The log never holds prompt text, instructions, summaries, transcripts, error messages or credentials: reasons are fixed and the file is validated against that vocabulary on every read. The session's user also sees a notice in the session: `auto-compact: compacted at 91% (now 9.3%)` or `auto-compact: compaction failed at 91%; no retry before the 30-minute cooldown, at most 2 attempt(s) per hour`.

## Limits

| limit | value |
| --- | --- |
| `contextPercent` | whole number 50-95, default 85 |
| `minGapMinutes` | whole number 5-1440, default 30 |
| `maxPerHour` | whole number 1-6, default 2 (per session) |
| eligible entries | at most 32 (`p...` session ids or `group:<name>`, name 1-48 characters `a-z 0-9 . _ -`) |
| log events | last 100 |
| per-session limiter records | at most 64; the least recently touched is dropped first (this also drops its suppression) |
| settle check | first 1 s after `agent_end`, then every 1 s, 10 checks in total |

A value outside a range is refused and the state is unchanged.

## Caveats

- This is a coordination policy for one OS user, not a security boundary: anything that can write `~/.omp/agent/peer-state/autocompact.json` as that user can change it. The file is shared by this user's sessions on this machine; eligibility, cooldown and the hourly limit are per session.
- A `group:<name>` entry reads membership from the group registry, which the master can change for other sessions (see [groups.md](groups.md)). To keep eligibility strictly under your own control, list stable session ids.
- Compaction through `ctx.compact()` makes a summarisation request to the session's model and rewrites its history; use the cooldown and hourly limit to bound that cost. It cannot start a turn.
- A clock moved backwards delays the cooldown until the clock catches up; `reset-suppression` clears it.
- Session ids are stable per logical session: a forked or new session has a new id and is not eligible until you add it.

## Files and privacy

State is `~/.omp/agent/peer-state/autocompact.json` (`version: 1`; directory `0700`, file `0600`, atomic replace, symlinks refused), with settings, the eligible list, one small limiter record per session (attempt times, cooldown reference, suppression flag, last logged reason) and the log. Concurrent updates from several OMP processes are serialized with a kernel file lock (`autocompact.json.lock`).
