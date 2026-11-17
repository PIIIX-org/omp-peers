# Pause and resume

An explicit, persisted state that tells every automated coordinator not to wake a session. Nothing is paused until you pause it, or until the restart rule below pauses a session that was not working for the master when OMP died.

## Commands

```text
/peers pause [reason]      pause THIS session (reason: one line, at most 120 characters)
/peers pause status        show whether THIS session is paused, since when, by whom, and who may resume it (read-only)
/peers resume              resume THIS session, whoever paused it
/peers do <peer|all|group:<name>> pause [reason]    master only: pause other sessions
/peers do <peer|all|group:<name>> resume            master only: resume sessions the master paused itself
```

`peers_control` accepts the `pause` and `resume` actions, master only, with the same master check, the same `/peers lock` rule, the same audit records and the same `group:<name>` handling as every other control operation. A sender's claimed name is never authentication. A subagent can never resume: the tool refuses it, and the receiver refuses a request a sender marked as coming from a subagent (`resume is not available to subagents`).

## Who paused it decides who may resume it

Every pause records why it exists (`by` in `pause.json`, `pausedBy` in the registry row, shown in `/peers list` as `paused:<by>`, `/peers pause status` and the `/peers resume` message):

| `by` | set by | who may resume it |
| --- | --- | --- |
| `user` | the session's own `/peers pause`, or that user repeating `/peers pause` on a session the master paused | only its user (`/peers resume`) |
| `master` | the master's `pause` op | the master (`resume` op) or its user |
| `restart` | the restart rule below | only its user (`/peers resume`) |

The receiving session decides, under the pause file's cross-process lock. The master's `resume` clears a pause only when the stored `by` is `master`, and only while the sender is still the current master and the session still allows control: both are checked again inside the locked update, after any wait for the lock, so a master handoff or a `/peers lock` that lands in between refuses the request (`sender is not the master session`, `peer is locked (control refused)`, `peer refuses inbound requests`) and the pause stays. For any other pause the receiver refuses with a fixed error and changes nothing:

- `paused by its user: only that user can resume it with /peers resume`
- `paused after a restart because it was idle: only its user can resume it`

A session that is not paused answers `ok` and nothing changes (`ok (was not paused)`). The rules that keep a user in control:

- A user pause is never overridden: a master `pause` on a session that is already paused changes nothing, and the user running `/peers pause` on a session the master paused takes it over (`by` becomes `user`; the start time and reason stay). From then on the master cannot clear it. A `restart` pause stays `restart` when anyone pauses it again.
- If the user's pause and the master's `resume` race, whichever the lock admits first wins; a user pause that lands first is never cleared by the master.
- The local `/peers resume` is always allowed for the session's own user, whoever paused it.
- Entries written by older versions have no usable `by` (an older version stored the requester's peer id there). They read as `user`: only the session's own user can resume them. The next write of the file stores the normalized value.
- Nothing else resumes a session: not a restart, the watcher, triggers, a master prompt or message, or an incoming message. Requests from non-master senders (including a missing or forged `from`), to a locked session (`/peers lock`) and from a subagent are refused without touching the pause file.

Pausing an already paused session changes nothing otherwise: the original start time and reason stay. Reasons are screened like standing-rule text (control characters and credential-looking text are rejected), stored locally and never published to the registry. The word `status` alone is the read-only subcommand, not a reason.

## The restart rule

A session that was not working for the master before a blackout stays paused until its own user resumes it. The extension records, in the session's saved metadata (`~/.omp/agent/peer-sessions/<session id>.json`, `0600`), whether the previous process shut down cleanly (`clean`) and whether it was actively working under the master's management (`managed`):

- `clean` is `false` from the moment a session starts and becomes `true` only when the session shuts down through the extension's teardown: `session_shutdown`, a switch to another session in the same process, or a process exit with code 0. A nonzero exit code, kill -9, a crash, a power cut, or a signal that skips Node's exit handlers leaves `false` behind.
- `managed` is `true` while a turn that a master request started is running: a `prompt` from the master, or a `message` whose sender claims the master's id, accepted while the session is idle. A turn's provenance is fixed when it starts: a master message that joins a turn already running (for example the user's own) does not make it managed, and a user message that joins a managed turn does not make it unmanaged. The flag is cleared when the agent run ends. A turn the session's own user started is never managed. The sender's id is a claim, like every `from`: a false claim can only make the rule skip the automatic pause.

At session start, before the session serves any request, the rule (`restartDecision`, a pure function of the saved record and the pause file) decides:

| saved record | already paused | result |
| --- | --- | --- |
| none (a new session) | | unchanged |
| clean exit, or an older record without `clean` | | unchanged |
| unclean, `managed: true` (working for the master when it died) | | unchanged: the master may continue it |
| unclean, not managed (idle, or working on its own user's turn) | no | paused automatically: `by: restart`, reason `not working for the master before the restart` |
| unclean | yes | unchanged: the existing pause keeps its `by` |

The pause is normally written before the session's socket and registry row appear, so no master message, prompt or watcher digest can slip in. If the write fails (an unwritable state directory, a full disk), the session stays gated anyway: its receiver and its registry row (`paused`, `pausedBy: restart`) treat it as paused, the user gets one warning per distinct failure, the write is retried on every 5 second refresh, and `/peers pause status` says the pause is not recorded yet. It stays gated until the write succeeds or its user runs `/peers resume`, which cancels the pending pause (it is then never written). While the write is pending, a master `pause` changes nothing and a master `resume` is refused as for a restart pause. Features that read `pause.json` directly (auto-compact, digests, dependency and watchdog senders in other sessions) cannot see a pause that is not recorded; only the receiver gate and the published registry flag do.

The session's own user sees one local notice at start (`<name> (<id>) was paused automatically: the previous run did not shut down cleanly and the session was not working for the master. Nothing automatic can wake it and the master cannot resume it; run /peers resume to continue`). The master cannot clear a `restart` pause; only `/peers resume` in that session does. Nothing is evaluated by waking the session: the decision reads two files.

Consequences to know about: a master that is restarted after a kill is paused too (its own turns are never managed), so its watcher digests wait until its user resumes it. A saved session record written by an older version has no `clean` field, so the first restart after upgrading never pauses anything.

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
| `pause` | available, master only for remote callers |
| `resume` | available, master only for remote callers; clears only a pause the master set (see above) |

`deferred` is the structured status for informational traffic (a retry after resume is reasonable); `refused` marks a dispatch. Neither is queued by the paused session: nothing is stored on its behalf and no model request is made, so the sender must resend after resume. Only the completion watcher retains its own digest and retries it.

Refusals happen before any side effect: a refused `prompt` does not change the model, effort or tier either, and a refused `message` does not count against the sender's rate limit.

The decision is `wakeGate(state, op)` in `lib/features/pause.ts`, a pure function whose result is the table above.

## What senders see

- `/peers msg`, `/peers do ... prompt` and `peers_send`/`peers_control` print `not delivered: <name> is paused; resend after it is resumed (<who may resume it>) (<id>)` instead of `failed: ...`, where the parenthesis names who may resume it from the pause file: `paused by its user: only its user can resume it`, `paused by the master: the master or its user can resume it`, `paused after a restart: only its user can resume it`, or `resume policy: see /peers pause status` when it is not known. The structured result keeps `status: "deferred"` (message) or `"refused"` (prompt); the text says what actually happened: nothing was delivered or queued, so the sender must resend. A broadcast prints one line per target, so paused and working sessions are visible side by side. The completion-watcher, dependency and inbox texts use the same wording.
- `resume` prints `ok (resumed)`, `ok (was not paused)` or `failed: <the fixed error above>` per target. Over a group or `all`, each target answers for itself: the ones the master paused are resumed and the others print their refusal.
- `peers_list` and `/peers list` show `[paused:<by>]` in the flags (`[paused]` for a registration from an older version), `status` reports `paused`, `pausedSince` (an ISO time) and `pausedBy` in the session's registry row `~/.omp/run/peers/<id>.json`, and the session's own status line shows `paused`. Reading any of these never wakes anything. Registrations from older versions have no `paused` field and are shown without a flag.
- The completion watcher keeps its digest queued when the master is paused: it is not dropped and not marked delivered, it is retried after at most 30 seconds, and it logs one warning (`notification deferred: the master session is paused ...`) for the whole paused period instead of one per attempt. After the master resumes, the same digest, with the same event IDs, is delivered once.
- With the audit log on, a resume the receiver refused because of who paused the session is recorded as `refused` with reason `not-resumable`; the error text is never stored.

## Limits

- Pausing gates new wakes only. A turn that is already running keeps running; use `abort` to stop it. A message accepted before the pause is not recalled.
- Pause is a coordination gate between cooperating sessions of one OS user, not a security boundary: anything that can write `~/.omp/agent/peer-state/pause.json` or `~/.omp/agent/peer-sessions/<id>.json` as that user can change them. A session still running a version without this feature does not enforce it. Provenance is only as strong as that file: the receiver decides, but a process that can write the file can also rewrite `by`.
- Pause is per logical session (its stable peer ID). A session resumed from the same session file is still paused; a forked or new session has a new ID and is not.
- If `pause.json` cannot be read or is invalid, the session is treated as paused (wakes refused, status still works) and nothing is overwritten. Fix or remove the file to recover; `resume` cannot repair it (it reports the read error).
- A stored `by` longer than 64 bytes is invalid (the file is then treated as unreadable); the reason stays limited to 120 characters.
- `/peers do all pause` does not include the session you run it from; use `/peers pause` there.
- Pausing a master stops the watcher's digests from waking it; they wait as described above.
- The restart rule cannot tell a kill from a crash or a power cut, and it cannot see a turn that is accepted but has not started yet (milliseconds). A master message accepted while the session is idle that never starts a turn leaves the next turn marked managed until an agent run ends. It cannot know that a user was away: a session killed while its user was typing is paused like any session that was not working for the master. A process that exits through the extension's teardown with code 0 counts as clean even if it was about to crash later. Every session now has a saved metadata file (`clean`, `managed` and the previous fields); files are small and are not removed.

## Files and privacy

State is stored in `~/.omp/agent/peer-state/pause.json` (`version: 1`; directory `0700`, file `0600`, atomic replace, symlinks refused), keyed by stable peer ID. Each entry records the start time, who paused it (`user`, `master` or `restart`) and the optional reason. The peer ID of the requester that older versions stored is not kept. Session names are not stored. Concurrent updates from several OMP processes are serialized with a kernel file lock (`pause.json.lock`).

The restart rule adds two booleans, `clean` and `managed`, to the existing `peer-sessions/<id>.json` (`0600`); it stores no text.
