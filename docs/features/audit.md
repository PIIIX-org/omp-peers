# Audit log of master controls

A private, local record of which control operation reached which session and how it ended. It is off until you turn it on, it never leaves your machine, and it never stores prompt text, setting values, transcripts or tokens.

## Commands

```text
/peers audit [status]
/peers audit on | off
/peers audit tail [n]
/peers audit clear --yes
```

- `on` / `off`: switch recording for every session on this machine (the flag is `~/.omp/agent/peer-state/audit-config.json`). Default is off. `off` keeps the existing log.
- `status`: whether recording is on, size of the log and of its previous file, record count, oldest and newest timestamps, the retention limits in force, and the last write error this session saw. Records that cannot be parsed are counted, never shown.
- `tail [n]`: the newest `n` records, oldest first, rendered from the validated fields only. `n` is 1 to 50 (default 10); more than 50 is an error.
- `clear --yes`: deletes the log and its one previous file. The literal `--yes` is required; any local session may run it. Recording resumes into a new file if it is still on.

`status` and `tail` only read the files. They never start a model turn or wake a session. The audit commands are not available as agent tools, so no model can read the log through this plugin.

## What is recorded

Every control operation that reaches a session's control path is recorded by the **receiving** session, and by the **sending** session for each target it sent to. Control operations are `prompt`, `abort`, `compact`, `model`, `effort`, `subagents`, `setting`, `rename`, `tail` and `shutdown`. `status` and plain messages are not control operations and are not recorded. A control command that the sending session refuses locally because it is not the master (`Not the master...`) is never sent and is not recorded.

Each operation produces an `attempted` record when it starts and a `completed` record with the result. A sender's and a receiver's records for one operation share the same `request` id, so one operation is up to four lines (sender attempted, receiver attempted, receiver completed, sender completed). A receiver also records requests that did not come through a sender, for example a refused request written straight to its socket; those have only the two receiver lines.

One JSON object per line (version 1):

| field | meaning |
| --- | --- |
| `v` | `1` |
| `ts` | milliseconds since the epoch |
| `event` | random id of this line (32 hex digits) |
| `request` | random id shared by the records of one operation (32 hex digits) |
| `side` | `sender` or `receiver` |
| `phase` | `attempted` or `completed` |
| `actorClaim`, `actorClaimName` | the id and name the request **claimed** to come from. `unknown` when absent, `[invalid]` when malformed |
| `targetId`, `targetName` | the session the control was aimed at (stable id, name at the time) |
| `op` | the control operation |
| `params` | the limited arguments below, when there are any |
| `masterChecked` | receiver `completed` records only: `true` when the claimed id equalled the receiver's master id at the check, `false` when it did not. Absent when the check never ran (the session refuses inbound requests or is locked) |
| `outcome` | `completed` only: `ok`, `refused`, `failed`, `unreachable`, `deferred` or `unknown` |
| `reason` | `refused`, `failed`, `unreachable` and `unknown` outcomes: one of a fixed list |

Outcomes: `ok` finished; `deferred` accepted but finishing later (`compact`, `shutdown`, a prompt queued behind running work); `refused` by policy; `failed` after being accepted; `unreachable` the target could not be contacted (sender only); `unknown` the sender sent the request but never got a usable answer (timeout, closed connection, bad response), so it cannot say whether the operation ran. Compare it with the receiver's own records.

Reasons come from this fixed list and are never copied from a message: `not-master`, `locked`, `inbound-refused`, `not-ready`, `protected-setting`, `invalid-argument`, `unavailable-model`, `no-credentials`, `busy`, `error`, `unreachable`, `timeout`, `connection-closed`, `bad-response`, `response-too-large`.

### Claims are not authenticated

`actorClaim` is whatever the request said. A request has no signature, and any process running as your user can write to a session's socket. The receiver only compares the claimed id with its master id (`masterChecked`); that is the same check that gates control, not proof of who sent it. The log therefore says "claimed actor". Only the sending session's own lines describe its own id; the receiver's lines describe nothing but the claim it was given.

## What is never stored

Not stored: tokens or credentials, prompt or task text, `tail` output or any transcript, `setting` values, model replies, free-form error messages. Stored arguments are limited to:

| op | `params` |
| --- | --- |
| `prompt` | `textLength` (UTF-8 bytes), the requested `tier` and `overridePin` if any |
| `rename` | `textLength` only |
| `subagents` | `mode` (`auto`, `auto-off`, `auto-managed`, `clear`, or `spec`) and `textLength` |
| `setting` | `mode` (`get`, `set`, `clear`, `list`) and `key`, the setting id (never the value) |
| `model` | `selector`, the requested model selector |
| `effort` | `effort`, the requested level |
| `tail` | `n`, the requested count |
| `abort`, `compact`, `shutdown` | none |

Every string is stripped of control characters and capped: names 60 characters, `selector` and `effort` 80, `key` 80. A name, selector or key that looks like a credential (token prefixes, `key=value` assignments, bearer tokens, private-key headers, URL passwords, or an unbroken run of 32 or more letters, digits, `+` or `/`) is stored as `[redacted]`; a selector or key with characters outside the usual identifier set is stored as `[redacted]` too. This is a conservative screen, not a guarantee. A record line never exceeds 4096 bytes. `tail` re-validates each line and skips anything that is not exactly a version 1 record.

## Files, permissions and tampering

Everything lives in `~/.omp/agent/peer-state/`: directory `0700`, files `0600`.

| file | content |
| --- | --- |
| `audit.jsonl` | the log, append-only |
| `audit.jsonl.1` | the single previous log, after a rotation |
| `audit-config.json` | `{"version":1,"enabled":true|false}` |
| `audit.jsonl.lock` | lock shared by every process that writes or rotates the log |

Records are appended with `O_APPEND` in one write per line and flushed (`fsync`) before the control operation continues. Several sessions append to the same file safely. The log is opened without following symlinks. It is refused, and nothing is written, when it is a symlink, not a regular file, has more than one hard link, belongs to another user, or is readable or writable by group or others. `status` and `tail` apply the same checks before reading and report the problem instead of showing the file.

The log is a local aid, not tamper-proof evidence: it carries no signature or hash chain, so any process running as your user can edit or delete it, and a flood of control requests can push older records out through rotation.

A failure to write (including the lock being held for more than 2 seconds) never fails or delays the control operation by more than that wait. The session shows one warning, and `/peers audit status` shows the most recent error since the last successful write.

## Retention

Defaults: 1 MiB (`maxBytes`) and 30 days (`maxAgeDays`). Override them in `~/.omp/agent/peers.json`:

```json
{ "audit": { "maxBytes": 1048576, "maxAgeDays": 30 } }
```

`maxBytes` is an integer from 65536 to 67108864 (64 KiB to 64 MiB). `maxAgeDays` is an integer from 1 to 3650. A value outside its range or of the wrong type is ignored, the default is used, and `status` says so.

When the next record would take `audit.jsonl` past `maxBytes`, or the oldest record in it is older than `maxAgeDays`, the file is renamed to `audit.jsonl.1` (replacing the previous one), records older than `maxAgeDays` are removed from it, and a new `audit.jsonl` is started. At most two files exist, so the log holds roughly up to twice `maxBytes`. A previous file whose last write is older than `maxAgeDays` is deleted at the next write.

Pruning happens when something is written. If no control operation is recorded after records expire, they stay on disk until the next write or until you delete them.

## Inspecting and deleting by hand

The files are plain text. Read them with any tool, for example `less ~/.omp/agent/peer-state/audit.jsonl` or `jq . ~/.omp/agent/peer-state/audit.jsonl`. Delete them with `/peers audit clear --yes` or `rm ~/.omp/agent/peer-state/audit.jsonl*`. Do not publish them: they contain session ids and names and a history of what you controlled.

## Network

The audit feature has no network code. Nothing is uploaded or sent to any service, and no option to do so exists.
