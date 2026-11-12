# Persistent peer watcher

The watcher polls the local OMP peer registry and selected lifecycle metadata. It queues turn-ended notifications, delivers batches to the current master, and keeps running when OMP has no sessions or no master. It sends no provider request itself. **A delivered notification can start a model turn in the master and consume provider quota.** Install it only if you want that behavior.

## Run in the foreground

Use Python 3.9 or newer on macOS or Linux:

```sh
python3 tools/watch.py
```

The default registry is `$HOME/.omp/run/peers`; lifecycle logs live under `$HOME/.omp/logs`. The watcher keeps private state under `$HOME/.omp-peer-watch`. You can choose another OS home or runtime directory:

```sh
python3 tools/watch.py --home "$HOME" --state-dir "$HOME/.local/state/omp-peer-watcher" --interval 1
```

`--interval` accepts a finite positive number of seconds. Stop a foreground watcher with Ctrl-C or SIGTERM. A second watcher using the same runtime directory exits with a singleton-lock error. Different state directories have separate locks; do not point two running watchers at the same registry.

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
python3 tools/install_watcher.py install --label "$LABEL" --state-dir "$STATE_DIR" --python "$(command -v python3)"
launchctl print "gui/$(id -u)/$LABEL"
```

Labels must contain at least two dot-separated components. Each component starts with a letter or digit and contains letters, digits, hyphens, or underscores. The maximum length is 200 characters. Use the same label and runtime directory for upgrades and uninstall. Choose a Python 3.9+ installation that remains available after logout; replacing or removing that interpreter breaks the agent until you reinstall with a working interpreter.

Re-run the install command after updating this checkout. The installer stops its managed agent, replaces the installed script and plist, and bootstraps it again. It refuses to overwrite an unmanaged `watch.py`, a conflicting plist, or another installation's manifest. It also refuses to replace files while a watcher still holds the runtime lock. If install reports a bootstrap failure, inspect your GUI login domain with `launchctl print "gui/$(id -u)"`, correct the error, then rerun install. Installed files remain available for that retry.

Do not copy an operational watcher's files, logs, or state into this checkout. For an existing custom watcher, keep its runtime untouched and choose a new `--state-dir`. Stop the old watcher before enabling the replacement so both do not notify the same master. The installer does not import custom state; a state file with a different schema produces a startup error instead of silent data loss.

## Notifications and completion semantics

The watcher groups registrations by stable session ID, prefers each live process's newest registration, and treats peer-ID changes as the same logical session. Its first observation establishes an idle baseline. A new idle registration, a replacement process's initial idle state, and a departed peer do not count as a completion.

A busy-to-idle observation queues a turn-ended event after a two-second lifecycle-log flush allowance. The watcher also accepts OMP JSON lifecycle entries with `message: "agent_end maintenance routing"`, `route: "entered"`, a matching session ID, and a timestamp after its initial baseline. Those entries can catch turns that start and finish between polls. The watcher reads only these fields plus an allowlisted stop reason; it does not inspect session transcripts or preserve arbitrary lifecycle-log payloads. Existing startup logs establish cursors without replay. A log written after startup can supply a missed event.

The event ID depends on the stable session and the observed event key. The watcher persists deduplication history, log cursors and an outbox, retries pending notifications when a master becomes available, and resolves the current master for each delivery attempt. It excludes the master's own events to avoid notification feedback. Queue gaps and process restarts preserve pending events. It coalesces matching lifecycle and registry observations, retaining a bounded recent history of 8,192 event IDs and 256 timing windows per session.

Treat delivery as **at least once**, not exactly once: if the receiving master accepts a message and the acknowledgement or subsequent state save fails, the watcher can repeat that event ID. Consumers should deduplicate by event ID. A master can change after the lookup but before the socket write; a notification already in flight can reach that previous master. Future attempts use the current claim.

A turn-ended or idle notification does not establish that a task finished. Current peers expose busy/idle without background-task quiescence, so notifications state `background/task completion UNKNOWN`. If a future peer supplies `hasPendingAsyncWork`, the watcher reports pending work; it reports a settled session only when all live registrations report both `isSettled: true` and `hasPendingAsyncWork: false`. Even settled session state does not verify a project's acceptance criteria. The notification does not authorize work on a parked project.

Notification delivery uses the message RPC only. The watcher does not send prompts, run peer controls, dispatch work, or call a model provider. Messages can still wake a master model turn. A refusing or unavailable master leaves events queued for retry. Long-offline masters can accumulate an outbox; inspect it before choosing to re-enable delivery.

For an explicit end-to-end notification test, select a new non-sensitive test key:

```sh
python3 tools/watch.py --notify-test operator-check-1
```

Stop the installed agent first or use its runtime alone; the singleton lock prevents concurrent use. The test follows the same outbox/delivery route and **can start a master model turn**. Reusing the test key within the retained deduplication history does not generate another event. Do not use this option in offline CI against a real master.

## Logs and privacy

The launch agent writes `$STATE_DIR/watcher.stdout.log` and `watcher.stderr.log`. Without `--state-dir`, `STATE_DIR` means `$HOME/.omp-peer-watch`. Lifecycle diagnostics contain readiness, event IDs/kinds, master IDs and error classes. State includes stable session IDs, peer names, observed process identities and log cursor paths. Keep these files local even though the watcher does not store assistant excerpts, provider errors, credentials or transcript text.

The watcher does not rotate launchd output files. Stop the agent before archiving or truncating its logs, then reinstall to resume it. State metadata for old sessions and log cursors can also grow over a long installation lifetime. Clearing state loses deduplication history; preserve it unless you intend a fresh baseline. Corrupt or unsupported state produces a startup error rather than an overwrite.

OMP lifecycle-log names and the `agent_end maintenance routing` metadata are host implementation details, not a stable peer protocol. If a host upgrade changes them, registry busy-to-idle detection still works, but it can miss short turns between polls. Delayed timestamps outside a turn's observed busy window can also prevent cross-source coalescing. Validate a host upgrade with the offline checks before enabling it on active work.

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

The quick checks use temporary directories, a local fake Unix socket, the existing smoke polling helper, controlled timestamps and mocked launchctl calls. They do not start OMP, a launch agent, or a model provider. The integration smoke uses the existing keyless OMP setup and refuses inbound master messages while checking watcher startup, silent idle/departure handling and shutdown. Both remove the temporary runtime files and stop their subprocesses.
