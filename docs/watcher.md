# Persistent peer watcher

The watcher polls the local OMP peer registry and selected lifecycle metadata. It queues turn-ended transitions and sends unreported transitions to the current master as a digest, at most once per five minutes by default. It keeps running when OMP has no sessions or no master and sends no provider request itself. **A delivered notification can start a model turn in the master and consume provider quota.** Install it only if you want that behavior.

## Run in the foreground

Use Python 3.9 or newer on macOS or Linux:

```sh
python3 tools/watch.py
```

The default registry is `$HOME/.omp/run/peers`; lifecycle logs live under `$HOME/.omp/logs`. The watcher keeps private state under `$HOME/.omp-peer-watch`. You can choose another OS home or runtime directory:

```sh
python3 tools/watch.py --home "$HOME" --state-dir "$HOME/.local/state/omp-peer-watcher" --interval 1 --digest-interval 300
```

`--interval` controls registry polling. `--digest-interval` controls the minimum spacing between transition digests and the initial batching delay; it defaults to 300 seconds. Both accept finite positive seconds. A digest includes up to 20 pending transitions, including newer transitions that arrived during the batching window. A backlog takes multiple digest intervals to drain; no master or a failed delivery leaves it queued. Explicit reports use the ordinary peer route immediately, outside this cadence. Stop a foreground watcher with Ctrl-C or SIGTERM. A second watcher using the same runtime directory exits with a singleton-lock error. Different state directories have separate locks; do not point two running watchers at the same registry.

Termination stops starting status lookups and deliveries, cancels an outstanding acknowledgement read, wakes even a long polling interval, and saves state before releasing the singleton lock. RPCs have a two-second total deadline, including fragmented responses. An unacknowledged or cancelled notification stays in the durable outbox with the same event IDs; an already accepted message whose acknowledgement was lost can be retried, so recipients must still deduplicate by event ID.

## Install as a macOS user LaunchAgent

Run from this checkout, without sudo, in your logged-in macOS account:

```sh
python3 tools/install_watcher.py install
```

The installer copies the script into `$HOME/.omp-peer-watch/watch.py`, renders the template at `tools/launchd/peer-watcher.plist.in`, and writes `$HOME/Library/LaunchAgents/org.omp-peers.watcher.plist`. It resolves your home and Python interpreter to absolute paths in the generated plist; launchd does not expand `$HOME` or `~` in plist strings. The committed template contains placeholders, not account-specific paths.

`RunAtLoad` starts the watcher at login. `KeepAlive` restarts it after exit; startup does not require OMP or a master. The launch agent runs as your user with umask `077`. The runtime directory has mode `0700`; scripts, state, lock, generated plist and logs have mode `0600`. The watcher opens runtime files without following final symlinks and rejects hard-linked or non-owned runtime files. These checks do not isolate mutually trusted processes that run as the same OS account.

Choose a label, interpreter, or runtime directory during installation:

```sh
LABEL=org.example.omp-peer-watcher
STATE_DIR="$HOME/.local/state/omp-peer-watcher"
python3 tools/install_watcher.py install --label "$LABEL" --state-dir "$STATE_DIR" --python "$(command -v python3)" --digest-interval 300
launchctl print "gui/$(id -u)/$LABEL"
```

Labels must contain at least two dot-separated components. Each component starts with a letter or digit and contains letters, digits, hyphens, or underscores. The maximum length is 200 characters. Use the same label and runtime directory for upgrades and uninstall. Choose a Python 3.9+ installation that remains available after logout; replacing or removing that interpreter breaks the agent until you reinstall with a working interpreter.

Re-run the install command after updating this checkout. The installer stops its managed agent, replaces the installed script and plist, and bootstraps it again. It refuses to overwrite an unmanaged `watch.py`, a conflicting plist, or another installation's manifest. The generated LaunchAgent has a five-second `ExitTimeOut`: one bounded RPC plus three seconds for saving state. Before stopping an existing agent, the installer captures its PID and effective `exit timeout` from `launchctl print`; older installations can have a different system-defined deadline. It allows that deadline plus one second for lock release, and waits only for the captured managed PID. Unrelated manual lock holders are refused immediately, without unloading the agent. If a running agent has a missing, malformed, or unbounded (zero) exit deadline, installation/uninstall refuses before bootout and leaves it running; repair its launchd configuration before retrying. If install reports a bootstrap failure, inspect your GUI login domain with `launchctl print "gui/$(id -u)"`, correct the error, then rerun install. Installed files remain available for that retry.

Do not copy an operational watcher's files, logs, or state into this checkout. For an existing custom watcher, keep its runtime untouched and choose a new `--state-dir`. Stop the old watcher before enabling the replacement so both do not notify the same master. The installer does not import custom state; a state file with a different schema produces a startup error instead of silent data loss.

## Notifications and completion semantics

The watcher groups registrations by stable session ID, prefers each live process's newest registration, and treats peer-ID changes as the same logical session. Its first observation establishes an idle baseline. A new idle registration, a replacement process's initial idle state, and a departed peer do not count as a completion.

The plugin assigns a random token to each main agent loop, from the supported `agent_start` callback through `agent_end`. This is the logical peer turn, including any internal provider/tool continuations. Tokens do not survive into the next agent loop or a different logical session. Child-agent reports cannot claim the main session's turn.

The plugin writes metadata-only `end` and successful `report` records under `$HOME/.omp/run/peers/notifications/<sha256-session-id>.jsonl` (`0700` directory, `0600` files). Each record carries `version: 1`, `sessionId`, `turnId`, a numeric Unix `timestamp`, and `type`. End records add the peer name; report receipts add `report`, `destinationId`, and `destinationSessionId`. The plugin stores no report body or transcript content there. Peers advertise `notificationVersion: 1` and their latest `notificationTurnId` in the registry. The watcher uses the token to coalesce registry edges and end records, even for short turns between polls.

A busy-to-idle observation queues a transition after a two-second flush allowance. For older peers without the metadata protocol, the watcher still accepts OMP JSON lifecycle entries with `message: "agent_end maintenance routing"`, `route: "entered"`, a matching session ID, and a timestamp after its initial baseline. It reads only these fields plus an allowlisted stop reason. While the metadata protocol is healthy, it advances host-log cursors without emitting log events, so a later fallback does not replay those ends. It does not inspect session transcripts or use words in message bodies to infer completion. Legacy events lack exact turn identity, so the watcher does not suppress them on the strength of an explicit report.

An observed busy-to-idle edge survives peer departure and watcher restart during the flush allowance. The watcher retains the departed process's lifecycle metadata until that edge flushes, so a delayed host-log entry or journal end record coalesces with the registry observation. A replacement process under the same session ID establishes its own busy/idle baseline without discarding an already-observed edge. Departure without an observed edge remains silent. With no live status, the notification reports `background/task completion UNKNOWN`.

The watcher persists event IDs, journal/log cursors, report receipts and the outbox. It retains the existing version-1 state format with additive fields; upgrades keep queued events, cursor positions and deduplication history. Old outbox entries remain deliverable without a turn token or enqueue timestamp. First installation samples up to the final 4 MiB of each journal to retain recent report receipts, including a report just before startup whose turn ends afterward; historical end records do not generate notifications. Restarts resume journal cursors and read newly created journals after the original baseline. The watcher resolves the current master for each delivery attempt and excludes the master's events to avoid notification feedback. It retains 8,192 recent event IDs, 256 timing windows, and receipts for 256 recent turns per session.

### Explicit reports

Send an important report as a structured object, instead of ordinary free-form `text`:

```text
peers_send({to: "<master-peer-id>", report: {kind: "DONE", unit: "Acceptance checks", evidence: {description: "Consumer checks passed", references: ["tests/notifications.ts"]}}})
```

The kinds are `DONE`, `BLOCKED`, `WAITING`, and `DECISION`, each with required human-readable fields. The interactive equivalent is `/peers report <peer|all> <json-report>`. See the [schema, rendering and deliberate readability limits](../README.md#structured-reports). The old string marker and `<kind> <text>` command syntax are rejected; upgrade both peers for structured reports. Ordinary `peers_send` text calls and `/peers msg` keep their behavior.

The sender delivers structured data through the peer message RPC immediately; the receiver validates it before rendering an agent-attributed message. It records a metadata-only receipt (kind, not report fields) only if the destination is the current master both before the send and after a successful acknowledgement, and the receiver acknowledges the same peer ID and logical session ID as the selected destination. Failed, refused, timed-out, legacy, or mismatched acknowledgements cannot authorize suppression. An ordinary message, a report to another peer, and a child-agent or out-of-turn report cannot authorize suppression either. The receiver's normal refusal/rate limits still apply, and the sender sees failures through the ordinary send result.

At digest delivery, the watcher removes only redundant end/idle notices with a receipt for the exact sender session, logical turn and current master destination. It does not remove or delay the report itself. A receipt from a prior turn or a report to a previous master cannot hide a notice for the new destination. Multiple important reports in one turn all take the ordinary route. A late acknowledgement retains the identity of the sending turn, even if another turn starts before it arrives.

Receipt bookkeeping failures do not fail a delivered report. A journal write failure removes the peer's metadata-protocol advertisement so the watcher can fall back to host lifecycle logs and registry transitions; a later successful write restores the advertisement. If the sender exits between delivery and durable receipt recording, the watcher may send an extra digest notice; it does not guess that delivery succeeded.

Treat delivery as **at least once**, not exactly once: if the receiving master accepts a message and the acknowledgement or subsequent state save fails, the watcher can repeat that event ID. Consumers should deduplicate by event ID. A master can change after the lookup but before the socket write; a notification already in flight can reach that previous master. Future attempts use the current claim.

A turn-ended or idle notification reports **agent yielded**, not task completion. At delivery the watcher reads live `status` metadata: positive job/subagent counts or `hasPendingAsyncWork: true` report pending work. It reports **session reports quiescence** only when all live registrations report `busy: false`, `isSettled: true` and `hasPendingAsyncWork: false`, with no contradictory positive activity counts. An older host, a partial status failure or an unavailable capability retains `background/task completion UNKNOWN`; missing counts display `?`, not zero. Counts represent one logical session, so duplicate registrations do not add their counts together. Even a quiescent session does not verify a project's acceptance criteria or authorize work on a parked project.

Quiescence describes the current status sample, not the historical yield event: a session may have resumed before delivery. Completion/cancellation updates peer registry activity within its five-second refresh interval, while socket status reads the host on demand. The watcher does not create a new completion event merely because jobs reach zero. See [background activity and quiescence](../README.md#background-activity-and-quiescence) for nullable fields, API scope and scheduler limitations.


Notification delivery uses the message RPC only. The watcher does not send prompts, run peer controls, dispatch work, or call a model provider. Messages can still wake a master model turn. A refusing or unavailable master leaves events queued for retry. Long-offline masters can accumulate an outbox; inspect it before choosing to re-enable delivery.

For an explicit end-to-end notification test, select a new non-sensitive test key:

```sh
python3 tools/watch.py --notify-test operator-check-1
```

Stop the installed agent first or use its runtime alone; the singleton lock prevents concurrent use. The test follows the same outbox/delivery route and **can start a master model turn**. Reusing the test key within the retained deduplication history does not generate another event. Do not use this option in offline CI against a real master.

## Logs and privacy

The launch agent writes `$STATE_DIR/watcher.stdout.log` and `watcher.stderr.log`. Without `--state-dir`, `STATE_DIR` means `$HOME/.omp-peer-watch`. Lifecycle diagnostics contain readiness, event IDs/kinds, master IDs and error classes. State includes stable session IDs, peer names, observed process identities, journal/log cursor paths and report destination IDs. Keep these files and the plugin's notification journals local even though they contain no assistant excerpts, report bodies, provider errors, credentials or transcript text.

The watcher does not rotate launchd output or notification journals. Stop the watcher and relevant peer sessions before archiving or truncating their metadata journals; journal replay remains bounded by retained event IDs. State metadata for old sessions and log cursors can grow over a long installation lifetime. Clearing state loses deduplication history; preserve it unless you intend a fresh baseline. Corrupt or unsupported state produces a startup error rather than an overwrite.

OMP lifecycle-log names and the `agent_end maintenance routing` metadata are host implementation details, used only for older peers. If a host upgrade changes them, legacy registry busy-to-idle detection still works but can miss short turns between polls. Delayed legacy timestamps outside an observed busy window can prevent cross-source coalescing. Upgraded peers use supported extension lifecycle callbacks and the metadata protocol instead.

## Uninstall

For the default installation:

```sh
python3 tools/install_watcher.py uninstall
```

For a custom label/runtime:

```sh
python3 tools/install_watcher.py uninstall --label "$LABEL" --state-dir "$STATE_DIR"
```

Uninstall boots out the managed agent and removes its plist, script and installation manifest. It keeps state and logs so a later install can reuse deduplication history. Add `--purge` to delete the known watcher state, lock and log files too. Purge preserves unrelated files and leaves a nonempty runtime directory in place. It does not touch OMP, peer sockets, provider configuration, or other launch agents.

## Offline checks

After integrating the watcher change, run from the checkout:

```sh
npm run test:watcher
npm run test:smoke
```

Run `npm ci --ignore-scripts` first and install Bun for the offline routing regression. The quick checks use temporary homes, local Unix sockets, controlled timestamps and mocked launchctl calls. Real watcher subprocesses exercise SIGTERM during stalled status RPCs and delayed message acknowledgements, a 20-event durable backlog, and managed upgrade/uninstall in private homes with fake launchctl (including replacement startup after upgrade). They never control an operational service or session. The routing regression exercises the registered send tool, command, receiver acknowledgement and lifecycle callbacks without starting a model provider. Python regressions also cover exact-turn/destination isolation, restart/retry deduplication, v1 outbox preservation and digest batching. The OMP integration smoke keeps its keyless setup and refuses inbound master messages while checking watcher startup, silent idle/departure handling and shutdown. Tests remove temporary runtime files and stop their subprocesses.
