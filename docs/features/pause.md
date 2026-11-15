# Pause and resume

An explicit, persisted state that tells every automated coordinator not to wake a session. Nothing is paused until you pause it.

## Commands

```text
/peers pause [reason]      pause THIS session (reason: one line, at most 120 characters)
/peers resume              resume THIS session
/peers do <peer|all> pause [reason]    master only: pause other sessions
/peers do <peer|all> resume            master only: resume other sessions
```

`peers_control` accepts the same `pause` and `resume` actions, again master only. The session's own user typing `/peers pause` or `/peers resume` is the authorization for that session; nothing else can clear a pause (restart, the watcher, triggers, a master prompt or an incoming message do not). The master's `pause`/`resume` use the same master check and the same `/peers lock` rule as every other control operation, so a locked session refuses them and only its own user can resume it. A sender's claimed name is never authentication.

Pausing an already paused session changes nothing: the original start time and reason stay. Reasons are screened like standing-rule text (control characters and credential-looking text are rejected), stored locally and never published to the registry.

## What a pause does

The gate runs in the receiving session, in the request handler, so every sender shares it: master dispatch, `peers_send` and `/peers msg`, the completion watcher's message RPC, and any later digest, adapter or trigger. While paused:

| op | result |
| --- | --- |
| `message` (peers_send, reports, watcher digests) | refused: `{ok:false, status:"deferred", paused:true, error:"session is paused"}` |
| `prompt` (master dispatch) | refused: `{ok:false, status:"refused", paused:true, error:"session is paused"}` |
| any op this table does not know | refused (`status:"refused"`): unknown ops fail closed |
| `status`, `tail` | available; read-only, never wake |
| `abort`, `shutdown` | available |
| `rename`, `model`, `effort`, `subagents`, `setting` | available (they change configuration only) |
| `compact` | available: it makes one summarisation request over the session's own history; it does not start a turn or deliver any peer content |
| `pause`, `resume` | available, master only for remote callers |

`deferred` marks informational traffic the sender may retry after resume; `refused` marks a dispatch that is not retained anywhere, so the master must send it again. Neither is queued by the paused session: nothing is stored on its behalf and no model request is made.

Refusals happen before any side effect: a refused `prompt` does not change the model, effort or tier either, and a refused `message` does not count against the sender's rate limit.

The decision is `wakeGate(state, op)` in `lib/features/pause.ts`, a pure function whose result is the table above.

## What senders see

- `/peers msg`, `/peers do ... prompt` and `peers_send`/`peers_control` print `deferred: <name> is paused (<id>)` or `refused: <name> is paused (<id>)` instead of `failed: ...`. A broadcast prints one line per target, so paused and working sessions are visible side by side.
- `peers_list` and `/peers list` show `[paused]` in the flags, `status` reports `paused` and `pausedSince` (an ISO time) in the session's registry row `~/.omp/run/peers/<id>.json`, and the session's own status line shows `paused`. Reading any of these never wakes anything. Registrations from older versions have no `paused` field and are shown without a flag.
- The completion watcher keeps its digest queued when the master is paused: it is not dropped and not marked delivered, it is retried after at most 30 seconds, and it logs one warning (`notification deferred: the master session is paused ...`) for the whole paused period instead of one per attempt. After the master resumes, the same digest, with the same event IDs, is delivered once.

## Limits

- Pausing gates new wakes only. A turn that is already running keeps running; use `abort` to stop it. A message accepted before the pause is not recalled.
- Pause is a coordination gate between cooperating sessions of one OS user, not a security boundary: anything that can write `~/.omp/agent/peer-state/pause.json` as that user can change it. A session still running a version without this feature does not enforce it.
- Pause is per logical session (its stable peer ID). A session resumed from the same session file is still paused; a forked or new session has a new ID and is not.
- If `pause.json` cannot be read or is invalid, the session is treated as paused (wakes refused, status still works) and nothing is overwritten. Fix or remove the file to recover; `resume` cannot repair it.
- `/peers do all pause` does not include the session you run it from; use `/peers pause` there.
- Pausing a master stops the watcher's digests from waking it; they wait as described above.

## Files and privacy

State is stored in `~/.omp/agent/peer-state/pause.json` (`version: 1`; directory `0700`, file `0600`, atomic replace, symlinks refused), keyed by stable peer ID. Each entry records the start time, who requested it (peer ID) and the optional reason. Session names are not stored. Concurrent updates from several OMP processes are serialized with a kernel file lock (`pause.json.lock`).
