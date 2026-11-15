# Session task board

A persisted record of which session was given which task and the latest state it reported. It survives restarts and changes of master. It is fed only by explicit commands and structured reports. Nothing is stored until you assign a task or a report arrives.

## Commands

```text
/peers board [list]
/peers board assign <peer> <task>
/peers board set <peer> <status> [note]
/peers board clear <peer>
/peers board stale [<hours>]
```

- `list` (the default) shows every entry. `stale` shows only stale entries, optionally with a threshold other than the configured one. Both are read-only: they never write the file, never create the state directory and never send anything to a session.
- `assign` is master-only (same check as peer control operations; run `/peers master` first). It records the task with status `assigned`. It does **not** send the task to the session or wake it; use a message or `/peers do` for that.
- `set` changes an existing entry's status and optional note. The master may change any entry; a session may change its own. The entry must exist (assign it first).
- `clear` removes an entry. Same authorization as `set`.
- `<peer>` is a stable session ID or an exact name. Live sessions are matched first; if none match, board entries are matched by ID or last known name, so an entry of a session that is not running can still be set or cleared. Ambiguous names are refused; use the ID.
- `<status>` is one of `assigned`, `in-progress`, `blocked`, `waiting`, `decision`, `done`, `unknown`.
- Task and note are one line of at most 200 characters. Whitespace is collapsed, control characters are rejected, and text that looks like a credential (the same conservative screen as standing rules) is rejected without repeating it.

## Entries

One entry per stable logical session ID (the ID derived from the session, not from the process), so a restart, a rename or a change of master does not create or move an entry. Each entry holds: session ID, last known name (display only, never used to match a write), optional task and note, status, source, the unit named by the last report, update time, and `updatedBy`.

- `source` is `report` when the current status came from a structured report and `assignment` when a user command recorded it (`assign`, `set`).
- `updatedBy` is the ID the writer claimed. Peer messages are not authenticated, so listings say `claimed by` and the board is a coordination aid, not proof of what a session did.

## Reports

When a session accepts a structured report message (`peers_send` with a `report`, or `/peers report`), the receiving session updates the sender's entry: `DONE` becomes `done`, `BLOCKED` `blocked`, `WAITING` `waiting`, `DECISION` `decision`. The entry's unit is the report's `unit` (dropped if it looks like a credential). The assigned task is kept; a manual note is cleared. A sender without an entry gets one with source `report`. Every accepted report refreshes the entry's time, so a still-valid WAITING report that is re-sent stops being stale. Reports sent by a subagent are delivered as ordinary messages but never update the board, because a subagent's status is not its parent session's status. Ordinary text messages, idle transitions and session histories are never read.

## Staleness and unknown status

- An entry whose last update is at least the threshold old is shown as `stale (<status>, no update for <age>)`. The threshold is `board.staleHours` in `~/.omp/agent/peers.json` (a number above 0 and at most 8760; default 24):

  ```json
  { "board": { "staleHours": 48 } }
  ```

  An unusable value falls back to 24 and the listing says so. `done` entries never go stale.
- An assigned task nobody has reported on shows `assigned (progress unknown: nothing reported)`; the board never guesses `in-progress`. `unknown` can be set explicitly.
- Sessions that are not currently running are labelled `not running` (from the live peer registry). Their entries remain until cleared.
- Ages are shown as minutes (under an hour), hours (under 48 hours) or days.

## Files and privacy

State is `~/.omp/agent/peer-state/board.json` (`version: 1`; directory `0700`, file `0600`, atomic replace, symlinks refused). Each update is a locked read-modify-write of one entry (`board.json.lock`), so concurrent updates from several OMP processes to different entries never overwrite each other. An unreadable or invalid file is reported and never overwritten. Reports contribute only status and unit; evidence, blockers, questions, references and transcripts are not stored. The board holds at most 200 entries.

Limits: a full board rejects new entries (a report then shows a warning in the receiving session); a report is recorded by the session that receives it, so a report sent to a session with inbound requests refused is not recorded.
