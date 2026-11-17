# Dashboard

A read-only view of what the other coordination features already record: sessions, groups, locks, the task board and pending decisions on one screen. It is a terminal view only: there is no web page, no HTTP server and no listening socket. A web surface, if it is ever added, needs its own access-control design and is out of scope here. (Plain `/peers`, with no argument, is still the interactive peer picker.)

## Commands

```text
/peers dashboard [--group <name>] [--stale-after <seconds>] [--panels sessions,groups,locks,tasks,decisions] [--once]
```

| option | meaning | default | allowed |
| --- | --- | --- | --- |
| `--group <name>` | show only that [group](groups.md)'s members in every panel | none | a group name (1-48 characters: lower-case letters, digits, `.`, `_`, `-`) |
| `--stale-after <seconds>` | mark a registry row `[stale]` once it is at least this old | 60 | whole seconds, 5 to 3600 |
| `--panels <list>` | which panels to show (the display order is always sessions, groups, locks, tasks, decisions) | all five | comma-separated, no repeats |
| `--once` | print one snapshot as text instead of opening the live view | off | |

Filters exist only as command options. Nothing is stored: no config file, no state file, nothing written. An unknown or repeated option, a missing value or an out-of-range value is an error that prints the usage line and shows nothing.

In a terminal UI the command opens a live overlay. In every other context (RPC, print) and with `--once` it prints the same panels once as plain text, 100 columns wide. Any session may run it, including a paused one and a non-master: it shows only what the registry and the shared state files already expose to every session of the same OS user.

## The live view

| key | action |
| --- | --- |
| `q`, `Esc` | close |
| `Tab`, `Shift-Tab` | next, previous panel (only the selected panels are cycled; one panel is shown at a time) |
| `r` | refresh now |
| `g` | cycle the group filter: all, then each existing group in name order, then all again |
| `Up`, `Down`, `PgUp`, `PgDn` | scroll the panel when it is taller than the window |
| `?` | show or hide the key help |

While the view is open it refreshes itself every 5 seconds from one timer, which is cleared the moment the view closes: nothing runs in the background when it is closed. Each refresh reads the same sources again; a refresh that fails keeps the previous snapshot and says so on screen. Lines are cut to the overlay width (wide characters count as two columns) and details wrap onto extra lines instead of disappearing.

## Panels

**sessions.** One row per live logical session (a session registered twice is shown once, as in `/peers list`): name and stable id, `busy`/`idle`, `[this session]` for the session you are in, and `[stale]` when the registry row is older than `--stale-after`. Details: `context` (the published figure), `jobs` and `agents` (running background jobs and streaming subagents), `settled` (whether the session's whole agent tree was quiescent when it last published), `inbound` (open or refused), `control` (open, locked, or `n/a` while inbound is refused), `paused`, `error turns` (consecutive failed turns since the process started), `dir` (the last component of the project directory only) and `registry` (the age of the row).

**groups.** Each group with its member count and members (name and id, or `no running session`), at most 10 members per group.

**locks.** Each resource with `N of M slots in use` (`(busy)` when full) and its leases: lease id, holder, `expires in <time>` or `EXPIRED <time> ago (not counted)`, the note, and `[owner not running]` when the holder has no live session. Expired leases are shown, never reclaimed.

**tasks.** The board entries: the session, its status, whether it is running, the assigned task, any note, and whether the status was `recorded` by a command or `reported` by the session, with its age. An entry that has not changed for the board's threshold (`board.staleHours` in `~/.omp/agent/peers.json`, default 24 h, the same setting `/peers board` uses; `done` never goes stale) is marked `[stale: no update for <age>]`. An `assigned` entry says `progress unknown: nothing reported`. Statuses are claims by the writer, not verified.

**decisions.** The open questions in the decision inbox: id, asking session, age and the question. Answered and deferred questions are only counted (`not listed: N deferred, M answered`).

With `--group`, every panel is limited to that group's members: their sessions, the group itself, the leases they hold (the slot count still counts every lease on the resource), their board entries and the questions they asked.

## Missing and stale data

- Every value a session does not publish (a version without it, or a value of the wrong type) is shown as `unknown`. Nothing is inferred: a missing `paused` is not `no`, a missing activity count is not `0`.
- `registry: age unknown` marks a row without a usable update time and is never called stale; a time in the future counts as `0s`. A `[stale]` row's other values may no longer be true.
- A state file that is missing counts as empty. One that is unreadable or invalid, or a registry that cannot be read, makes only its own panel say `unknown: <reason>` (the reason is capped and cleaned like every other displayed text); the other panels still render.
- A `--group` name that does not exist matches nothing and says so (`no group named x; the filter matches nothing`). If the group file is unreadable the filter cannot be applied, so the panels say `unknown` instead of showing unfiltered data.
- A logical session registered twice with no proven writer is left out of the registry view, exactly as in every other command.

## What is hidden

- Credentials: every displayed free-text field (names, context, notes, tasks, questions, directory names, error reasons) is screened with the same credential pattern check as the other features; a match is shown as `(withheld)`.
- Transcripts, prompts, tool output and message bodies are never read. Socket paths, process ids and instance ids are never shown. The working directory is reduced to its last path component.
- Terminal control sequences and control characters are stripped from every field, so a hostile session name cannot move the cursor, change the title or recolour the screen.
- Caps (UTF-8 bytes, cut on a character boundary with `…` counted in the cap): names and context 40 bytes; tasks, notes and questions 80 bytes. At most 50 rows per panel, then `… N more not shown (50 shown)`; at most 10 group members and 10 lock holders per row.

## Read-only

The dashboard code is handed a view of the host with exactly five members (home directory, clock, this session's identity, the master check and the registry listing) and calls no send, dispatch, pause, lock, model or write function. State files are read with the same non-blocking, symlink-refusing readers `/peers locks`, `/peers board`, `/peers inbox` and `/peers groups` use; none of them writes, repairs or reclaims. A test checks the exact bytes and modification times of every state file before and after.

Opening or refreshing it therefore never wakes, messages, pauses, resumes or controls any session. To list the registry it does what `/peers list` does: it confirms each duplicate registration's writer with one `status` request, which never starts a turn and is allowed even while a session is paused; it also removes registry files of processes that have already exited, as every listing does.

## Limits

- The view is a snapshot of files and published metadata taken a moment ago; a session may have changed since. It does not watch files for changes between refreshes.
- Only the sessions and files of the current OS user are visible.
- No history and no export: the dashboard keeps nothing after it closes.
