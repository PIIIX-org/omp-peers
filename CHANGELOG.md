# Changelog

## Unreleased

### Scheduled digests

- Add opt-in `/peers digest on|off|status|set|preview|now|history|clear --yes` (private `digest.json`): the master turns the board, the pending decision inbox and the paused sessions into one bounded text (200 bytes per field, 6000 per digest, credential-looking text withheld, never transcripts, unknown stays unknown) on an hourly, daily or weekly schedule in an IANA time zone (DST gap and overlap slots fire once) for all sessions or chosen groups. A slot is claimed under the cross-process lock before it is rendered, so it produces one digest however many processes run; after a restart one `catch-up (missed N slot(s))` digest is produced for the latest missed slot if it is at most `catch-up-hours` old (default 24, 0 off), older slots are recorded `skipped: too old`, and turning it on or changing the schedule never produces a digest at once. A digest goes to the master's own next agent start (once, framed as data) or to a local notification, is kept in a 20-entry history, and is never sent to another session, so a paused session is never woken; a paused or remote-refusing master gets a notification only. `status` and `preview` are read-only and `preview` renders the exact text a real digest would contain; `off` stops delivery and discards a waiting digest. Extend the feature registry with an optional `tick` run from the master's 5 s refresh, make `agentContext` allowed to be asynchronous, and add `notify` to the feature host.

### Session templates

- Add `/peers templates add|show|list|remove|apply|launch` (private `templates.json`, 32 templates): a template names an optional model, a role prompt, up to 8 rules and up to 8 groups. It is applied only to the session that runs `apply <name> --yes`: the model is switched only if available with credentials (never substituted), the role and rules become session-scoped rules and the groups are joined, all or nothing (rollback deletes a group only if this run created it). `show` and `apply` without `--yes` print the same read-only plan; `launch` prints the shell line and starts nothing. `OMP_PEERS_TEMPLATE=<name>` in a new session only shows the plan: environment variables are inherited by programs the session starts, so they never authorize an apply.

### Session groups

- Add `/peers groups list|add|remove|delete|members|preview` (private `groups.json`, keyed by stable session id, 64 groups of 64 members) and a `group:<name>` target for `/peers msg|report|do`, `peers_send` and `peers_control`: recipients that are paused (from the published registry flag; the receiver's wake gate stays authoritative), refusing inbound or locked (control ops) are skipped and listed as `skipped: <name> (<reason>)`; unknown, empty, no-recipient and unproven-duplicate-writer groups are explicit errors and `all` is unchanged. Group-scoped standing rules now match real membership.

### Shared locks

- Add `/peers locks` and the `peers_lock` tool: named locks and semaphores (capacity 1-64, TTL with renewal) stored in a private `locks.json` and acquired atomically across processes. A session holds at most one slot per name (a second acquire is refused; use renew). Contention returns `acquired`, `busy` (names the holders, never waits) or `refused`; only the owner releases, an unexpired lease is never stolen (including after a restart of the same session), expired leases are reclaimed lazily, `status` is read-only, and the master can `force-release` (a live lease only with `--yes-live`).

### Report-driven dependencies

- Add `/peers deps` (`add`, `list`, `remove`, `enable`, `disable`, `preview`, `pending`, `approve`, `reject`, `ledger`): opt-in rules that turn a structured DONE report accepted by the master into one peer message for another session. Rules store stable session IDs and are validated for missing targets, self-dependency, session-graph cycles and caps (64 rules, 8 per source); a persisted, cross-process-locked ledger deduplicates by report event key across restarts; `confirm` mode (default) only queues a trigger until the master user approves it, `--auto` dispatches at once, a `--once` rule (default) disables itself after firing, and a paused, refusing or absent target is recorded as not delivered and never resumed. Adds `PeerView.refusesInbound` to the feature host.

### Decision inbox

- Add `/peers inbox` and the `peers_decision` tool: sessions queue deduplicated, credential-screened questions into a private cross-process-safe `inbox.json`; the master lists them grouped by source (read-only, never wakes a session) and answers, defers, reopens or retries them. An answer is sent once to the live asking session through the normal send path with the outcome recorded; otherwise it stays pending for `peers_decision check`. Extend the feature registry with `tools()` and the feature host with `send()`.

### Pause and resume

- Add `/peers pause [reason]`, `/peers resume` and a master-only `pause` control op. Resume is user-controlled: only the paused session's own `/peers resume` clears a pause, and no remote caller, including the master's agent, can. State is persisted per session (`pause.json`, also published as `paused`/`pausedSince` in the registry) and enforced by one receiver-side wake gate (`wakeGate`) that refuses `message` and `prompt` with a structured deferred/refused result while status, tail and the other non-wake ops stay available. Senders print `not delivered: <name> is paused; resend after its user resumes it`; the completion watcher keeps its digest queued with bounded retries and delivers it once after resume.

### Standing rules

- Add `/peers rules` with global/group/session scopes, deterministic precedence, visible key conflicts, duplicate and credential rejection, master-gated changes, and a private cross-process-safe `rules.json`; matching rules are appended to the main session's system prompt at each agent start. Introduce the shared feature registry, private state store and real-OMP scenario runner (`npm run test:features`, `npm run test:features-smoke`).

### Session task board

- Add `/peers board` (`list`, `assign`, `set`, `clear`, `stale`): a persisted, private `board.json` with one entry per stable session ID, fed by explicit assignments and accepted structured reports via a new `Feature.onReport` hook; shows stale (configurable `board.staleHours`), unknown and not-running state honestly, never wakes sessions, and updates entries under a per-entry locked read-modify-write.

### Audit log

- Add opt-in `/peers audit on|off|status|tail|clear --yes`: a private local record (`peer-state/audit.jsonl`, 0600, append-only, symlink/hard-link/owner/permission checks) of every master control attempt and outcome with sender claims kept as claims, no prompt text, setting values or transcripts, a fixed reason vocabulary, size and age retention with one rotated file, and write failures that never block the control op.

### Lifecycle cleanup

- Pin the first bound session manager per process so extra ACP sessions cannot swap the peer identity or master claim; only the pinned manager's `session_switch` moves the logical identity; a switch from another manager is ignored. Document single-session-per-process behavior.
- Register the process `exit` hook once instead of on every rebind, avoiding `MaxListenersExceededWarning` after many session switches.
- Write `peer-sessions` metadata only for non-default state (name, restore flag, unpinned routing); keep updating existing files and never overwrite a file for a different session ID.
- Drop a redundant session-lock check in `/peers release`.

### Structured reports

- Replace kind-only markers with strict DONE/BLOCKED/WAITING/DECISION objects, per-kind required human fields, explicit WAITING background state and separate DONE evidence references.
- Validate tool, JSON command and inbound socket reports before delivery; render readable labeled lines without reconstructing compressed prose. Preserve multilingual segmentation, attribution, ordinary messages and metadata-only receipt correlation.
- Preserve unknown fields and explicit nulls through the host tool-validation pipeline before strict send/report validation; regress the exported host validator plus registered handler without delivery, wake, rate-budget or receipt effects.
- Add deterministic consumer coverage and an isolated keyless OMP/local-socket report scenario.


- Require branch-based pull requests, independent review as wafa, passing CI, and merge commits before updating `main`.
- Add hosted CI for TypeScript checks, Python verification, publication leak checks, and isolated plugin smoke coverage.
- Upgrade checkout, setup-node, and setup-python CI actions to Node 24 runtimes while preserving the pinned tools, read-only permissions, and isolated checks.
- Document the contribution workflow and add a pull request template.
- Release displaced master locks during claims and periodic refresh without removing a live legacy master's claim; recover without restarting the displaced peer. Cover non-restoring and auto-restoring masters with isolated real-OMP lock probes.
- Keep session models and effort on default peer dispatch; persist a local `/peers unpin` automatic-routing opt-in and re-pin explicit master overrides. Report old/new selections and routing reasons, fail unavailable requests without dispatch/partial effort changes, and respect operator task pins before peer subagent overrides.
- Preserve native `@upstream` restrictions in live root-model status and old/new switch reports. Verify an upstream-only change through both sessions' visible reports, status, and real transport requests to a loopback fake gateway.
- Warn on duplicate peer names/logical identities, prove canonical writers through live socket incarnation and lock ownership, and prioritize exact IDs over colliding names. Refuse unresolved duplicate-session broadcasts before delivery; deduplicate proved aliases without deleting live registrations.
- Add deterministic duplicate-routing regressions and keyless isolated OMP/local-socket duplicate scenarios.

### Background activity status

- Expose nullable tree-owned background job and streaming subagent counts, the host's pending async-wake predicate, and conservative settled state through peer status/registry.
- Preserve unknown capabilities and autonomous scheduling uncertainty instead of inventing zero counts or quiescence. Read host metadata without transcripts or parked-agent revival.
- Label watcher notifications as agent yields, pending work or live quiescence without treating a settled session as task completion.
- Add deterministic activity/delivery/cancellation regressions and an isolated OMP session-job smoke with no model turns.


### Persistent watcher

- Replace the exit-on-event watcher with a persistent singleton that queues turn-ended notifications for the current master and preserves session/event deduplication across restarts. Initial idle registrations and peer departures do not count as completions.
- Read lifecycle metadata instead of assistant transcripts. Idle and turn-ended events do not prove task completion or background-work quiescence. Master notifications can start a model turn and consume provider quota.
- Add a configurable macOS LaunchAgent template and install/uninstall tooling that preserves state by default and refuses unmanaged installations.
- Add offline watcher/installer tests and adapt the keyless integration smoke for persistent startup, silent idle/departure handling, and shutdown.
- Batch unreported idle/turn-ended transitions into configurable five-minute digests, preserving the version-1 durable outbox and retry identities.
- Correlate explicit reports from `peers_send` and `/peers report` with acknowledged delivery to the current master, suppressing only that session/turn's redundant watcher notice; reports keep their immediate delivery route. Use metadata-only journals, not transcript reads or message-word heuristics.
- Cover report routing, exact turn/destination correlation, late receipts, digest cadence and v1 state compatibility with isolated offline regressions.
- Cancel watcher status/delivery RPCs on termination, wake polling immediately, and preserve unacknowledged events for retry instead of draining the digest during shutdown.
- Coordinate the LaunchAgent exit deadline with the installer's managed-PID lock wait; refuse unrelated manual lock holders immediately. Cover stalled status/acknowledgement cancellation and private-home managed upgrade/uninstall without real launchd services or provider calls.
- Preserve observed busy-to-idle transitions through peer departure and watcher restart, coalescing delayed lifecycle metadata without treating replacement initial-idle state as a new yield.

## 0.1.0

- Publish peer-session discovery, messaging, master control, and model/effort routing as an OMP extension.
- Include the initial optional one-shot peer watcher, dual MIT/Apache-2.0 licenses, and isolated OMP smoke scenario.
