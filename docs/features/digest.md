# Scheduled coordination digests

An opt-in, scheduled summary of what sessions explicitly reported: the task board, the decisions waiting in the inbox and the sessions that are paused, in one readable text instead of a stream of separate reports. Nothing is produced until you turn it on, and turning it on never produces a digest by itself.

This is not the completion watcher's digest (`docs/watcher.md`), which batches "session finished" notices. A coordination digest is produced on a wall-clock schedule from stored board, inbox and pause state only.

## Commands

```text
/peers digest [status]
/peers digest on | off
/peers digest set <key> <value>
/peers digest preview
/peers digest now
/peers digest history [n]
/peers digest clear --yes
```

- `on`, `off`, `set`, `now` and `clear` are master-only (same check as peer control operations; run `/peers master` first). Only the master session evaluates the schedule and delivers digests; with no master nothing is delivered.
- `status`, `preview` and `history` work in any session and are read-only: they never write `digest.json`, never create a lock file, never wake or message a session and never mark a slot as sent. `status` says whether the next evaluation would produce a digest, a catch-up digest or a skipped slot.
- `preview` prints the exact text a real digest would contain now, from the same code as a real digest, for the next scheduled slot (it works while the feature is off). Only the slot name, the ages and the generated minute depend on when it is produced.
- `now` produces one extra digest immediately, clearly marked `manual (not a scheduled slot; no slot was used)`. It is refused while the feature is off, goes to the configured destination and does not use up a scheduled slot, so the next scheduled digest still arrives.
- `history` lists the stored digests newest first; `history <n>` (1-20) shows the full text of the newest `n`.
- `clear --yes` removes the history and any digest still waiting. The configuration and the slot baseline stay.

## Configuration

`set <key> <value>` validates every value and refuses unknown keys. Values are checked before anything is stored.

| key | values | default |
| --- | --- | --- |
| `cadence` | `hourly`, `daily`, `weekly` | `daily` |
| `at` | `HH:MM`, 24 hour clock (`00:00`-`23:59`); `hourly` uses the minutes only | `09:00` |
| `weekday` | `sun`, `mon`, `tue`, `wed`, `thu`, `fri`, `sat` (used by `weekly`; case does not matter) | `mon` |
| `timezone` | an IANA zone name such as `Europe/Berlin` or `UTC` (case is normalized; offsets like `+01:00` are refused) | the host's own zone |
| `groups` | `*` (every session) or 1-8 existing group names separated by commas | `*` |
| `destination` | `master`, `human` | `master` |
| `catch-up-hours` | a whole number from `0` (catch-up off) to `168` | `24` |

When `timezone` is not set the host's resolved zone is used and follows it if it changes; `status` marks it `(host default)`. Set it explicitly for a schedule that must not move.

A schedule change (`cadence`, `at`, `weekday`, `timezone`) while the feature is on applies from the next slot: every slot that has already fired under the new schedule counts as handled, so changing a schedule never produces a digest at once. `groups` and `catch-up-hours` apply from the next evaluation. Changing `destination` discards a digest still waiting for the old one.

## Schedule, time zones and daylight saving

A slot is a local wall-clock time in the configured zone and is named by it, for example `2026-11-17T09:00`. Slots are computed with `Intl` only.

- `daily`: every day at `at`. `weekly`: the configured weekday at `at`. `hourly`: minute `MM` of every local hour.
- Spring-forward gap (a wall time that does not exist): the slot fires once, at the first minute that does exist at or after it (a `02:30` slot on the night the clocks jump from 02:00 to 03:00 fires at `03:00`, and keeps the name `...T02:30`). An hourly schedule whose `02:00` and `03:00` slots collapse onto that instant fires once, named `...T03:00`.
- Fall-back overlap (a wall time that happens twice): the slot fires once, at its first occurrence. The repeated hour does not produce a second digest for the same wall time.
- Half-hour and quarter-hour zones work (`Asia/Kolkata`, `Asia/Kathmandu`, `Australia/Lord_Howe`).

Each of these is tested with fixed instants.

## One digest per scheduled interval

The master checks the schedule every 5 seconds. When a slot is due it first claims the slot in `digest.json` under the same cross-process lock the other features use, and only then renders and delivers the digest. The claim records the slot as handled before anything is produced, so two masters, two processes or a restart racing a refresh can never both produce it. A claim that never finishes (the master stopped between the claim and the delivery) stays in the history as `unfinished: the master stopped before this digest was produced` and is not repeated.

## Restart catch-up and duplicates

- A slot is on time when the master evaluates it within 120 seconds of its time. After a restart, a sleeping laptop or any pause in evaluation, if at least one slot was missed, the master produces **one** digest for the **latest** missed slot, marked `catch-up (missed N slot(s))` where `N` counts every slot since the last handled one up to and including that slot (shown as `1000+` beyond 1000). It never produces one digest per missed slot.
- Catch-up only happens when that latest slot is at most `catch-up-hours` old (inclusive). Otherwise nothing is produced and the history records `skipped: too old (...)`; the slot counts as handled. `catch-up-hours 0` turns catch-up off: only an on-time slot produces a digest, later ones are recorded `skipped: too old (catch-up is off; ...)`.
- Turning the feature on, or changing the schedule, produces nothing for slots that have already passed: the first digest is the next slot. Turning it off and on again does not catch up for the time it was off.
- A digest whose delivery fails after the slot was claimed is recorded (`failed: ...`) and is **not** retried: one slot, at most one digest. A delivery or evaluation that fails after the claim cannot produce a second digest for the same slot.
- `now` is the only way to get an extra digest for the same period; it is always marked manual.

## What a digest contains

Only state that sessions explicitly wrote, read at production time and never changed:

- the task board (`/peers board`): per session the status, the assigned task, the last reported unit and note, and how long ago and by whom it was written. Entries older than the board's stale threshold (24 hours, or `board.staleHours`) read `stale (...)`; `done` never goes stale. Live sessions without a board entry read `unknown (nothing reported)`; an assignment nobody reported on reads `assigned (progress unknown: nothing reported)`. Unknown stays unknown: a digest never turns missing information into `idle`, `in-progress` or `done`.
- the pending decision inbox (`/peers inbox`): open and deferred questions with their ids and the question text. Context, options and answers are not included.
- the paused sessions among the live ones (from the pause state, never from guessing). A source that cannot be read is shown as `unavailable: ...`, not as empty.

Never included: transcripts, tail output, prompts, or any message text beyond the board and inbox fields above. Statuses are claims written by the sessions themselves, not verified, and the digest says so.

Every free-text field (names, tasks, units, notes, questions) is collapsed to one line, control characters are removed, credential-looking text (the same conservative screen as standing rules) is replaced by `(withheld)` and each field is cut at **200 bytes** (UTF-8, never inside a character, ending in `…`). The whole digest is at most **6000 bytes**: items that do not fit are replaced by a final `… N more omitted` line, never cut in the middle, and the header (counts, scope) is always shown.

With `groups` set, only sessions that belong to one of those groups (from `/peers groups`) appear in all three sections; a session in no included group is left out. If the group registry cannot be read the sections say so instead of guessing.

## Where a digest goes

- `master` (default): the digest is saved in the history and added **once** to the master session's own next agent start (its system prompt for that request only, never to the conversation), framed as data and not as instructions. It is held until that start; it never triggers a start by itself. A newer digest replaces a waiting older one (the older is recorded `superseded`).
- `human`: shown once as a local notification in the master session and saved in the history. Nothing is added to any prompt.

Nothing else: no peer message is ever sent to any session, so a paused session is never woken and a locked or refusing session is never contacted. There is no external channel (chat, mail, webhook).

If the master session itself is paused, or refuses remote requests (inbound refused or control locked; digest text includes what other sessions wrote), the digest is **not** added to any prompt: it is saved in the history as `not delivered: ...` and shown as a notification only. A digest that was already waiting is held until the session accepts again.

## Disabling

`/peers digest off` stops scheduled delivery immediately, discards a digest that has not been injected yet and keeps the history until `clear --yes`. A digest that finishes rendering after `off` is saved as `not delivered: digests were turned off before this one was delivered` and neither queued nor shown.

## Limits

- At most 20 digests are kept (the oldest is dropped), each at most 6000 bytes, so `digest.json` stays well under 200 KB. A digest still waiting for an agent start that scrolls out of the history is dropped with it.
- The digest is a coordination aid between cooperating sessions of one OS user, not a security boundary: anything that can write `~/.omp/agent/peer-state/*.json` as that user can change what it reports. The credential screen is a conservative pattern match, not a guarantee.
- If `digest.json` cannot be read or is invalid, status reports it, the schedule does nothing and the file is never overwritten; fix or remove it.
- If the master changes, the new master evaluates the schedule from the stored baseline and may inject a waiting digest.
- Evaluation needs a running master session; nothing is produced while the master is closed, and the next start produces at most one catch-up digest as described above.

## Files and privacy

State is stored in `~/.omp/agent/peer-state/digest.json` (`version: 1`; directory `0700`, file `0600`, atomic replace, symlinks refused). It holds the configuration, the last handled slot, the history (kind, slot, time, outcome and the text above) and the id of the waiting digest. It holds no credentials (screened), transcripts or prompts. Concurrent updates from several OMP processes are serialized with a kernel file lock (`digest.json.lock`).
