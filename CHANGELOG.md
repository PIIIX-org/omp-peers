# Changelog

## Unreleased

- Require branch-based pull requests, independent review as wafa, passing CI, and merge commits before updating `main`.
- Add hosted CI for TypeScript checks, Python verification, publication leak checks, and isolated plugin smoke coverage.
- Document the contribution workflow and add a pull request template.
- Release displaced master locks during claims and periodic refresh without removing a live legacy master's claim; recover without restarting the displaced peer. Cover non-restoring and auto-restoring masters with isolated real-OMP lock probes.
- Keep session models and effort on default peer dispatch; persist a local `/peers unpin` automatic-routing opt-in and re-pin explicit master overrides. Report old/new selections and routing reasons, fail unavailable requests without dispatch/partial effort changes, and respect operator task pins before peer subagent overrides.

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
- Add optional explicit report kinds to `peers_send` and `/peers report`. Acknowledged delivery to the current master suppresses only that session/turn's redundant watcher notice; reports keep their immediate delivery route. Use metadata-only journals, not transcript reads or message-word heuristics.
- Cover report routing, exact turn/destination correlation, late receipts, digest cadence and v1 state compatibility with isolated offline regressions.
- Cancel watcher status/delivery RPCs on termination, wake polling immediately, and preserve unacknowledged events for retry instead of draining the digest during shutdown.
- Coordinate the LaunchAgent exit deadline with the installer's managed-PID lock wait; refuse unrelated manual lock holders immediately. Cover stalled status/acknowledgement cancellation and private-home managed upgrade/uninstall without real launchd services or provider calls.
- Preserve observed busy-to-idle transitions through peer departure and watcher restart, coalescing delayed lifecycle metadata without treating replacement initial-idle state as a new yield.

## 0.1.0

- Publish peer-session discovery, messaging, master control, and model/effort routing as an OMP extension.
- Include the initial optional one-shot peer watcher, dual MIT/Apache-2.0 licenses, and isolated OMP smoke scenario.
