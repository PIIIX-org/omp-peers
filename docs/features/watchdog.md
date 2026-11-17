# Watchdog

An opt-in alert for sessions that look stuck or unhealthy: busy for too long, a run of failed turns, or a nearly full context window. Nothing is watched until you turn it on. The watchdog only tells you. It never interrupts, aborts, restarts, pauses, resumes or prompts anything.

## Commands

```text
/peers watchdog on | off
/peers watchdog status
/peers watchdog check
/peers watchdog set <busyMinutes|errorTurns|contextPercent|cooldownMinutes> <N>
/peers watchdog set scope all | group:<name>
/peers watchdog set notify <peer|group:<name>>... | none
/peers watchdog override <peer> [--busy-minutes N] [--context-percent N] [--error-turns N] [--off]
/peers watchdog clear-override <peer>
/peers watchdog ack <peer> <busy|context|errors>
```

Every command that changes anything (`on`, `off`, `set`, `override`, `clear-override`, `ack`) is master only (`/peers master` first). `status` and `check` work in any session.

## Thresholds

| setting | meaning | default | allowed |
| --- | --- | --- | --- |
| `busyMinutes` | minutes a session has been busy, counted from when the watchdog first observed it busy | 30 | 1 to 1440 |
| `errorTurns` | consecutive assistant turns that ended in an error | 3 | 2 to 50 |
| `contextPercent` | context window usage | 90 | 50 to 99 |
| `cooldownMinutes` | minimum time between two alerts for the same session and condition | 30 | 1 to 1440 |

Values must be whole numbers in range; anything else is refused and nothing changes. A stored file with an out-of-range value is rejected, never clamped.

**Long legitimate tasks.** `override <peer> --busy-minutes 240` (and `--context-percent`, `--error-turns`) raises or lowers one session's thresholds without touching the others; an override replaces any earlier one for that session. `override <peer> --off` stops watching that session entirely. Overrides are keyed by the session's stable id, so they survive a rename, can be set for a session that is not running right now, and are removed with `clear-override`. At most 100 overrides.

**Scope.** By default every live session other than the master is watched. `set scope group:<name>` limits it to the members of a [group](groups.md); it is accepted only when at least one live session belongs to the group, and if membership cannot be read the evaluation watches nothing and says why. A session that leaves the scope has its busy clock and alerts ended.

## How it evaluates

Only the master session evaluates, from the extension's 5 second refresh, and only while the watchdog is on. Inputs are published session metadata and nothing else: busy state, context usage, `recentErrorTurns`, pause state and the time of the registry row's last update. Transcripts and message bodies are never read.

- **busy** is measured by the watchdog from the first time it observed the session busy. It is not the age of the turn. An observation of idle ends the clock. The clock is persisted, so a master restart of a few minutes keeps it. If a session was not observed at all for more than 5 minutes (the master was away, the machine slept, the registry row was stale), the clock restarts at the next busy observation: the session may have gone idle and busy again meanwhile, and the watchdog reports only what it saw.
- **context** is the percentage in the session's published context usage (`1234 (56%)`). A figure without a percentage is unknown.
- **errors** is `recentErrorTurns`: the number of consecutive assistant turns of the session's main agent that ended in an error, counted by that session since its process started. A turn that ends normally resets it. It is the stop reason only; no error text is published.

### Unknown is explicit and never alerts

A condition with no usable data is shown as `unknown (<reason>)` in `status` and `check`, never alerts, and never clears an existing alert. Reasons: the session does not publish the value (a version without `recentErrorTurns`, no context figure, no busy state), or its registry row is not trustworthy: no or unreadable update time, older than 60 seconds, or timestamped more than 60 seconds in the future. A session whose process is hung stops refreshing its row and so becomes `unknown` after 60 seconds, not an alert.

## Alerts

An alert reports the observed value and the threshold, for example `busy for 30 min since first observed (limit 30 min)`, `context at 91% (limit 90%)`, or `3 consecutive assistant turns ended in an error (limit 3)`.

- **The master** gets one line in its next agent context: the count, then up to five `<session id> <condition text>` items, and a note that it is a notice and nothing was interrupted. It lists ids and observed values only, never names, and is omitted when the master refuses or locks remote requests.
- **Explicit recipients** (`set notify`: up to 5 targets, stable ids or names resolved to ids, or `group:<name>`) also get an ordinary peer message through the normal send path: `Watchdog alert (automated; from observed session metadata only; nothing was interrupted): <session id> <condition text>. This is a notice, not an instruction.` A group reaches at most 20 of its live members. The master itself and the alerted session are never recipients. A recipient that is idle and accepts messages may start a model turn to read it; that is the opt-in cost of `notify`.
- **A paused recipient is never messaged.** Pause state is read from the authoritative pause file just before sending (an unreadable file counts as paused), and the registry flag is honoured too. The outcome is recorded and shown as `not delivered: <name> is paused (only its user can resume it)`. A recipient that refuses inbound requests or locks remote control is `not delivered` with that reason, a session that is gone is `not delivered: session is not live`, and a failed send keeps its reason. Outcomes are listed under each alert in `status` and are not retried until the alert can fire again.

Alerts never include names in dispatched text, message bodies, transcripts, prompts or any file contents. A credential-looking session name or failure reason is withheld wherever it is displayed.

### Deduplication, cooldown, acknowledgement

- A condition alerts once when it is first observed over its threshold, however long it stays over.
- It can alert again only after it was observed back under the threshold (clears) and then crosses it again. If that happens within `cooldownMinutes` of the last alert for the same session and condition, the new alert waits until the cooldown has passed (`status` shows `no alert until <time> (cooldown)`).
- `ack <peer> <condition>` silences the hint and further alerts for an active alert until it clears and triggers again. It needs an alert that was emitted and is still active.
- Raising a threshold (or an override) above the current value clears the alert at the next evaluation.
- A session that stops running, leaves the scope or is overridden `--off` ends its busy clock and alerts. `off` clears all observations and alerts but keeps thresholds, scope, recipients and overrides.

## `status` and `check`

Both are read-only: they write nothing, send nothing and wake nothing. They run the same evaluation as the periodic tick on a copy of the state, so what they show is what the next evaluation does.

- `status` shows whether it is on, where evaluation runs, thresholds, scope, recipients, overrides, one block per watched session with each condition (`ok`, `triggered`, `unknown (<reason>)`, or off) and the alert state with its delivery outcomes.
- `check` lists what the next evaluation would alert and who would be notified or not (`would notify <name> (<id>): not delivered: ...`). Run it from any session; it says when this session is not the master.

## What it never does

Interrupt, abort, restart, resume, pause, compact, prompt or message a session except the explicit `notify` recipients, change any session's model or settings, or read a transcript. Subagents are not watched: counts are the main session's own turns. Turning it off stops all evaluation.

## Limits

- Busy time is "observed busy", not "turn age". It starts when the master first sees the session busy and restarts after a 5 minute observation gap; a master that is not running does not alert.
- Evaluation runs every 5 seconds in the master only; a session registry row is as fresh as the session's own 5 second refresh. Metrics older than 60 seconds are unknown.
- `recentErrorTurns` starts at 0 when a process starts and is not remembered across a restart. Sessions on an older plugin version publish none and show `unknown`.
- At most 200 alert records (inactive ones are dropped first, then the oldest active ones), 100 overrides, 5 notify targets, 20 recipients per group target. A session name shown to you is one line of at most 60 UTF-8 bytes; a delivery failure reason is at most 120 UTF-8 bytes and a stored delivery outcome at most 200 UTF-8 bytes.
- Alerts are advisory text between cooperating sessions of one OS user, not a security boundary: anything that can write `watchdog.json` as that user can change it. The master's hint is injected only if the master accepts remote requests.

## Files and privacy

State is stored in `~/.omp/agent/peer-state/watchdog.json` (`version: 1`; directory `0700`, file `0600`, atomic replace, symlinks and non-regular files refused), holding the thresholds, scope, notify targets, per-session overrides (by stable id), the busy start times and the alert records with delivery outcomes. Concurrent updates from several OMP processes are serialized with a kernel file lock (`watchdog.json.lock`). If the file cannot be read or is invalid, commands report the error and nothing is overwritten; fix or remove it. The watchdog adds one registry field, `recentErrorTurns` (a count, no text); sessions that do not publish it stay `unknown`.
