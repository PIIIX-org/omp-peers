# Changelog

## Unreleased

### External events

- Add opt-in `/peers events on cli|on webhook <port>|off|status|source|route|routes|pending|approve|reject|log|quiet|test` (private `events.json`, off by default, master-only changes): external events reach an owning session or `group:<name>` through user-defined routes. Ingress is a private local spool (`scripts/omp-peers-event.ts`, files 0600 in a 0700 directory, 20 files and 64 KiB each per 5 s tick; foreign-owned or group/world-writable files are rejected) and an optional webhook that listens on 127.0.0.1 only, accepts one JSON `POST /events/<source>` of at most 64 KiB per connection (5 s timeout, 8 connections, fixed 404/405/411/413/415/401 bodies) and parses nothing before an HMAC-SHA256 `X-Hub-Signature-256` check against a secret read per request from a user-owned 0600 file outside the repository (never stored, logged or echoed). Events are strictly validated (generic `{id, type, summary, fields}` or the example `github` adapter that reads only a whitelist of fields), stripped of control characters and ANSI sequences, credential-screened and never forwarded verbatim; delivery is a framed untrusted-data peer message through the normal send path with the receiver-enforced control-lock flag (a paused, refusing, locked or absent target is `not delivered` and never woken); events, off, the master role and quiet hours are re-checked before every claim and every send. The github adapter uses nothing unsigned: the id is a hash of the signed body and the type comes from its shape. Text claiming the plugin's own frames or the user's authority is rejected. Optional daily `quiet` hours (IANA zone, may cross midnight) hold `info` deliveries without dropping them. Event ids are deduplicated (2000 ids, 72 h) across processes, with per-route (default 20, max 600 an hour) and global (600 an hour) caps, a 200-item queue, three attempts at 0, 1 and 5 minutes, and a 200-entry outcome log without payload text. A `work` route never dispatches by itself: it queues an item that only the master user's `approve` sends (as authorized work: the target's control lock applies); pending items cannot be approved while events are off and expire after 72 h. `test` and the read-only commands write and send nothing.

### Dashboard

- Add `/peers dashboard [--group <name>] [--stale-after <seconds>] [--panels sessions,groups,locks,tasks,decisions] [--once]`: a read-only terminal view of sessions (busy, context, jobs, quiescence, inbound and control state, pause, error turns, registry age), groups, locks, the task board and open decisions. In the TUI it is an overlay (`q`/`Esc` close, `Tab`/`Shift-Tab` panels, `r` refresh, `g` group filter, `?` help, arrow and page keys scroll) that refreshes every 5 s from a timer cleared on close; with `--once`, in RPC or print mode it returns the same panels as one text snapshot. It is read-only by construction (a five-member host view and only state readers, never a sender or writer): opening or refreshing never wakes or controls a session, and tests compare the bytes and mtimes of every state file. Missing values are `unknown`, registry rows older than `--stale-after` (default 60 s) are `[stale]`, every field is stripped of terminal escapes, screened for credentials (`(withheld)`) and capped, and transcripts, message bodies, sockets and process ids are never read or shown. There is no web view, no server and no listening socket. Adds optional `cwd`, `activeJobs`, `activeSubagents` and `isSettled` to the feature host's `PeerView`.

### Usage and cost

- Add `/peers usage on|off|status|list|set|price|unprice`: a session publishes, only after its own user runs `on`, one optional registry field `usage` made of the host's running numeric totals (`sessionManager.getUsageStatistics()`: input, output, cache read and write tokens, the host's catalog-price cost, plus the current model, whether its provider is a subscription login, and the session start). No transcript, message text or provider request is involved; totals are cumulative per session file, so restarts and duplicate registrations never double count, and subagent usage is part of its parent's totals. The master's `list` (other sessions are master-only) shows each session with separate `subscription`, `estimate` (host catalog cost, or a user-configured per-model price table, with an optional user-supplied currency rate) and `billed` (always `unknown`: the host exposes no billed amount) labels, `unknown` for sessions that published nothing or lack counters, totals that say how many sessions they cover, and `stale` rows. Private `usage.json` (64 publishers, 32 prices), `usageSummary`/`formatUsage` are pure for later digests. Adds `PeerView.usage`/`updatedAt` and `FeatureHost.usageNow()`.

### Scheduled digests

- Add opt-in `/peers digest on|off|status|set|preview|now|history|clear --yes` (private `digest.json`): the master turns the board, the pending decision inbox and the paused sessions into one bounded text (200 bytes per field, 6000 per digest, credential-looking text withheld, never transcripts, unknown stays unknown) on an hourly, daily or weekly schedule in an IANA time zone (DST gap and overlap slots fire once) for all sessions or chosen groups. A slot is claimed under the cross-process lock before it is rendered, so it produces one digest however many processes run; after a restart one `catch-up (missed N slot(s))` digest is produced for the latest missed slot if it is at most `catch-up-hours` old (default 24, 0 off), older slots are recorded `skipped: too old`, and turning it on or changing the schedule never produces a digest at once. A digest goes to the master's own next agent start (once, framed as data) or to a local notification, is kept in a 20-entry history, and is never sent to another session, so a paused session is never woken; a paused or remote-refusing master gets a notification only. `status` and `preview` are read-only and `preview` renders the exact text a real digest would contain; `off` stops delivery and discards a waiting digest. Extend the feature registry with an optional `tick` run from the master's 5 s refresh, make `agentContext` allowed to be asynchronous, and add `notify` to the feature host.

### Auto-compact

- Add opt-in `/peers autocompact on|off|status|set|add|remove|log|reset-suppression`: a session-local policy (off by default, empty eligible list; private `autocompact.json`) that compacts a listed session (stable id or `group:<name>`) through the host's `ctx.compact()` only after the main agent's whole run ended (`agent_end`, never `turn_end`), a short settle delay later, and only if the context is at or above a threshold (50-95%, default 85) while the session is idle, has no pending message, no running async job, no host auto-compaction or compaction of its own in flight, and is not paused. Loops are suppressed by a cooldown (5-1440 min, default 30), an hourly limit (1-6, default 2, failures count), and hysteresis (a compaction that leaves the context at or above the threshold suppresses further compaction until a measurement falls below it or `reset-suppression`). Unknown context usage or a missing host member (`compact`, `isIdle`, `hasPendingMessages`, `getAsyncJobSnapshot`) never compacts and is reported once per episode. `status` and `log` are read-only and `status` uses the same decision function; the bounded audit log (100 events) records fixed-vocabulary outcomes and percentages only. No tool, peer message or remote op can enable, change or trigger it. Does not replace or change the host's own auto-compaction setting.

### Watchdog

- Add opt-in `/peers watchdog on|off|status|check|set|override|clear-override|ack` (private `watchdog.json`, off by default; master-only changes): the master evaluates published session metadata every 5 s and alerts once per session and condition when a session has been busy longer than `busyMinutes` (default 30, counted from first observation and restarted after a 5 minute observation gap), has `errorTurns` (3) consecutive error-ended turns or reaches `contextPercent` (90), with a `cooldownMinutes` (30) dedupe and `ack`. Per-session overrides (or `--off`) let long legitimate tasks raise thresholds. Alerts reach the master's next agent context as ids and observed values only and, for explicit `notify` recipients (up to 5 targets, groups capped at 20), as an ordinary peer message without names; a paused recipient (authoritative pause file, fail closed), refusing or absent session is recorded as `not delivered` and never woken. Missing, stale or future-dated data is `unknown` and never alerts; `status` and `check` run the same evaluation read-only. Nothing is interrupted, restarted or resumed. Adds `Feature.tick`, the published `recentErrorTurns` registry field and `PeerView` busy/context/paused/recentErrorTurns/updatedAt.

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
