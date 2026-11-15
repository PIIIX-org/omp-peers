# Shared locks and semaphores

Sessions that compete for a scarce shared resource (a build slot, a test environment, a rate-limited service) can take a named lock first. A lock is a semaphore with a fixed number of slots; capacity 1 is a mutex. Nothing is created until a session acquires one, and nothing here waits, wakes a session or runs on a timer.

The command is `/peers locks`. (`/peers lock` is the existing "refuse control" switch and is unrelated.)

## Commands

```text
/peers locks acquire <name> [--capacity N] [--ttl S] [--note T]
/peers locks renew <name> [--ttl S]
/peers locks release <name>
/peers locks status [<name>]
/peers locks force-release <name> <owner|lease-id> [--yes-live]
```

- **Names** are lower-case `a-z`, `0-9`, `.`, `_`, `-`, start with a letter or digit, up to 48 characters, for example `heavy-build`. Pick names for your own resources; the plugin defines none.
- **Capacity** is the number of slots, 1 to 64. The first acquire of a name fixes it (default 1). A later acquire that names a different `--capacity` is refused and shows the current value; omitting `--capacity` accepts the existing one. The capacity is fixed only while some lease on the name exists: once every lease has been released or has expired and been reclaimed, the next acquire chooses it again.
- **TTL** is the lease length in seconds, 10 to 86400 (default 600). `acquire` and `renew` set the expiry to now plus the TTL.
- **Note** is optional, one line, at most 80 characters, shown to other sessions. It is screened with the same credential patterns as [standing rules](rules.md) and rejected on a match.
- `status` works in any session, is read-only (the file is not written, reclaimed or created) and wakes nothing. It lists each resource with how many slots are in use, and each lease with its id, owner (display name and stable session id) and time remaining. Expired leases are marked `EXPIRED`, shown and ignored (they do not count toward capacity).
- `force-release` is master-only (`/peers master` first, the same check as peer control operations). `<owner>` is the holder's stable session id or a lease id (`l<number>`) from `status`.

## The `peers_lock` tool

`peers_lock` is available to the model in every session, with `action` `acquire`, `renew`, `release` or `status` and the same `name`, `capacity`, `ttl_seconds` and `note` rules. It has no force-release. `status` omits `name` to list everything.

## Outcomes

| outcome | meaning |
| --- | --- |
| `acquired` | one new slot is held. A session holds at most one slot per name. |
| `busy` | every slot is held by an unexpired lease. The reply names each holder and when the earliest slot frees. Nothing is queued or waited for; do other work and try again later. |
| `refused` | bad name, capacity, TTL or note (including a credential-looking note), capacity mismatch, a bound reached, an acquire by a session that already holds the name (its lease must be extended with `renew`), a release/renew by a session that does not hold the lease, or a non-master force-release. Nothing changed. |
| `renewed` / `released` | the session's own lease got a new expiry / was removed. |

Through the tool, `refused` is an error result and `busy` is a normal one.

## Ownership, expiry and recovery

- A lease belongs to a logical session (its stable session id). Only that session may `renew` or `release` it. The recorded process instance and display name are informational: a session restarted from the same saved session has the same id, so it can renew or release its own lease at once, and `status` marks it `earlier instance` until it does.
- An unexpired lease is never taken over by another session, including after its owner crashed, was killed or restarted. Recovery from a dead owner happens by expiry: after the bounded TTL the slot is free. A long job renews before the TTL runs out.
- A session that already holds a lease on a name cannot `acquire` it again: the attempt is refused with `this session already holds <name> (lease <id>), possibly via another of its agents; renew to extend it or release it when done`. Subagents act as their parent session in this plugin, so two parallel agents of one session share one lease: the second is told it is held instead of both proceeding and one release freeing the slot under the other. Extend with `renew`; release when the work is done.
- Expired leases are reclaimed lazily: the next `acquire`, `renew` or `release` removes every expired lease in the same atomic update. A lease that has expired cannot be renewed; acquire it again.
- Acquisition is one atomic cross-process update (kernel file lock `locks.json.lock`), so two processes racing for the last slot cannot both win.
- `force-release` removes one named lease. An expired lease is removed freely. An unexpired lease is refused unless `--yes-live` is given, because it can let two sessions use a resource that the original holder still believes it holds. Use it only when you know the holder is gone.

## Files, limits and privacy

State is `~/.omp/agent/peer-state/locks.json` (`version: 1`; directory `0700`, file `0600`, atomic replace, symlinks refused). Each lease stores `id`, `owner` (stable session id), the owner's display name, `instance`, `acquiredAt`, `expiresAt` and the optional note. At most 64 names and 256 leases exist at once; an acquire beyond either bound is refused (expired leases are reclaimed first). Lease ids (`l1`, `l2`, ...) are never reused. An unreadable or invalid file is reported and never overwritten. Do not publish `locks.json`: it shows what your sessions are working on.

Known limits: a lock is advisory, since it only coordinates sessions that ask for it. Expiry compares wall-clock times from the machine's clock; if the clock jumps, leases expire early or late by the same amount. A holder that is stuck or has silently lost its lease cannot be detected until the TTL ends.
