# Changelog

## Unreleased

- Require branch-based pull requests, independent review as wafa, passing CI, and merge commits before updating `main`.
- Add hosted CI for TypeScript checks, Python verification, publication leak checks, and isolated plugin smoke coverage.
- Document the contribution workflow and add a pull request template.

### Persistent watcher

- Replace the exit-on-event watcher with a persistent singleton that queues turn-ended notifications for the current master and preserves session/event deduplication across restarts. Initial idle registrations and peer departures do not count as completions.
- Read lifecycle metadata instead of assistant transcripts. Idle and turn-ended events do not prove task completion or background-work quiescence. Master notifications can start a model turn and consume provider quota.
- Add a configurable macOS LaunchAgent template and install/uninstall tooling that preserves state by default and refuses unmanaged installations.
- Add offline watcher/installer tests and adapt the keyless integration smoke for persistent startup, silent idle/departure handling, and shutdown.

## 0.1.0

- Publish peer-session discovery, messaging, master control, and model/effort routing as an OMP extension.
- Include the initial optional one-shot peer watcher, dual MIT/Apache-2.0 licenses, and isolated OMP smoke scenario.
