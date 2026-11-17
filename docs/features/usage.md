# Usage and estimated cost

Per-session token counters and an estimated cost, shown to the master. Private by default: a session publishes nothing until its own user runs `/peers usage on`. Unknown counters stay unknown, never zero. Nothing here calls a provider, wakes a session or reads a transcript.

## Commands

```text
/peers usage status                          this session: publishing or not, its live host counters, the configuration
/peers usage on | off                        publish (or stop publishing) THIS session's counters
/peers usage list [group:<name>|<peer>]      master: the usage of the running sessions that publish (read-only)
/peers usage set currency <CODE> [<rate>]    display currency label; any code except USD needs your USD multiplier
/peers usage set pricing <catalog|custom>    where estimates come from (default catalog)
/peers usage set groups <name>... | all      limit the default listing to members of these groups (default all)
/peers usage price <model> <in> <out> [<cacheRead> <cacheWrite>]   custom price, USD per million tokens
/peers usage unprice <model>                 remove a custom price
```

`on` and `off` act only on the session you type them in. Nothing, including the master, can turn publishing on or off for another session; each user decides for each session. The setting is keyed by the stable session id, so a restarted or resumed session keeps it. `list` and `status` are read-only: they never write state, send a message, wake a session or make a model request.

## Private by default

- A session that never ran `/peers usage on` writes no `usage` field into its registry row `~/.omp/run/peers/<id>.json`, and its counters are not even read. The master lists it as `unknown (nothing published)`.
- `/peers usage status` shows the live host counters of the session you type it in, locally. They are not shared unless you ran `on`.
- If `usage.json` cannot be read, is invalid or is a symlink, nothing is published (the failure mode is private) and nothing is overwritten.
- Published values are numbers, one boolean and short labels: no message text, tool output, prompt, name or credential.

## Who sees what

Registry rows are files in the user's own `~/.omp/run/peers/` (mode `0600`); every session of that OS user could read them. This feature adds a conservative rule on top: only the master session lists other sessions' usage. Any other session sees only its own row; `/peers usage list <peer>` and `list group:<name>` from a non-master session are refused (`only the master session lists other sessions' usage; run /peers master first`). Changing the shared configuration (`set`, `price`, `unprice`) is open to every session of the user: it only changes how numbers are presented, never what is published.

## Where the numbers come from (what the host exposes)

Investigated in `@oh-my-pi/pi-coding-agent` 18.18.1:

| need | host surface | used |
| --- | --- | --- |
| token and cost totals | `ctx.sessionManager.getUsageStatistics()`, part of the read-only session-manager type: `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, orchestration counters, `premiumRequests`, `cost`, `subagentCost` (plain numbers, maintained incrementally by the host's entry index) | `input`, `output`, `cacheRead`, `cacheWrite`, `cost` |
| subscription or API billing | `ctx.modelRegistry.isUsingSubscription(model)`: whether the provider's stored credentials are an OAuth login or an opted-in login key | yes, for the current model's provider |
| the model | `ctx.models.current()` (`provider`, `id`) | yes |
| session start | `ctx.sessionManager.getHeader()`: `timestamp` and whether the session has a `parentSession` | timestamp and a boolean only |
| model prices | each call's `usage.cost` is computed by the host from the catalog `Model.cost` (USD per million tokens) at call time | only through the running `cost` total |
| `getSessionStats()` | exists on the host's agent session, NOT on the extension context | not available |
| a billed amount | none: the only monetary number is the host's `cost` total, which is a catalog-price calculation except that for OpenRouter and Cline-pass the host overwrites a call's cost with the provider-reported charge | `billed` is therefore always `unknown` |

No message, tool result or prompt is read, no transcript is iterated and no provider request is made: the counters are numbers the host already maintains. A host without `getUsageStatistics` publishes nothing and shows `unknown`.

### What the counters cover

- **Cumulative per session file, not per process.** The host rebuilds the totals from the session file when it is resumed, so a restart, `/resume` or a crash-and-resume of one session gives the same totals again (the real-OMP scenario restarts a session and checks this). They replace the earlier figures under the same stable id; nothing is ever added to a previous value. This is the only source used for a session, so a restart cannot double count. `since` is the session header's creation time, i.e. where the cumulative totals begin.
- **Subagent usage is included, not a separate row.** The host adds the usage of completed `task` results to the parent's totals (this is what `subagentCost` splits out). Subagents never publish their own row and are never counted separately.
- **Compaction and `/clear` do not reduce them**: the host's running totals count every entry of the file, including discarded turns it keeps as usage-only entries (read from the host source; not exercised by the scenario).
- **Forks.** A fork starts from a copy of its parent's history, so its totals include tokens copied from the parent; the parent may also be listed. Such a row is flagged `forked: includes history copied from its parent` and the listing adds a note. Whether a fork also inherits cost depends on how the host created it. The same applies to `/new` in a process: it is a new logical session with new totals.
- **Mixed models.** `cost` is accumulated call by call with each call's own model price, so a session that switched models is priced correctly under `catalog`. The published `model` and `subscription` flag describe the model in use when the row was written: a session that switched provider or login type mid-way is labelled by its latest model.
- **Orchestration tokens** (provider-side, billed but outside the four counters) are in the host's `cost` and are not shown as a counter.

## What is published

With `on`, the registry row gains one optional field:

```json
"usage": {
  "input": 600, "output": 200, "cacheRead": 400, "cacheWrite": 0,
  "catalogCost": 0.00492,
  "model": "smoke/first", "subscription": false,
  "basis": "host-session-totals", "since": "2026-11-17T09:19:25.306Z"
}
```

`input` is the non-cached prompt tokens the provider bills as new input; `cacheRead` and `cacheWrite` are cache tokens; `output` includes reasoning tokens. `catalogCost` is the host's running catalog-price cost in USD. `forked: true` is added for a fork. Numbers are validated when published and again by every reader: only finite numbers from 0 to 1e15 (cost to 1e15 as well) count; strings, negatives, NaN, infinities and larger values make that field `unknown`. A row whose `basis` is not `host-session-totals`, or that has no valid counter, is unknown. A counter that is missing stays `unknown` in the listing, never `0`; a real zero is published and shown as `0`.

## Cost: `subscription`, `estimate`, `billed`

Every row carries three separate labels:

- `subscription: yes (no per-token bill)`, `subscription: no` or `subscription: unknown`: whether the host says the session's current provider is used through a subscription login. A subscription has no per-token bill, so its amount is shown only as `estimate: ... (catalog-price equivalent, not a charge)`.
- `estimate: <amount> <currency> (<source>)`: computed from published numbers. With `catalog` pricing (default) it is the host's running cost, which uses the catalog price of the model of each call (including tiered, time-based and cache-TTL prices the host applies). With `custom` pricing the reader multiplies the published counters by your price table for the published model: `input`, `output`, `cacheRead`, `cacheWrite` tokens times the per-million prices, divided by 1,000,000. A model without a custom price, a missing counter or a missing cache price for a non-zero cache counter gives `estimate: unknown (<reason>)`, never a guess or zero. A catalog price of `0` or a model with no catalog price makes the host report cost `0`; the host cannot distinguish those cases, so with `catalog` pricing a cost of 0 beside any non-zero token counter is shown as `estimate: unknown (host catalog cost is 0 for non-zero tokens (no catalog price, or a free model))` and the session is not counted as known in cost totals (use `custom` pricing with `/peers usage price` for such a model). A zero cost with all counters zero is a known zero.
- `billed: unknown (...)`: always unknown. The host exposes no provider-billed amount (see the table above); an amount is never labelled billed, including for OpenRouter whose reported charge is folded into the host's `cost`.

Estimation assumptions: prices are USD per million tokens; amounts are shown with four decimals (`0.0049 USD`, so anything under 0.00005 shows `0.0000`); custom prices apply to all of a session's counters at the model it currently uses, so a session that switched models is mispriced under `custom` (use `catalog` for such sessions); orchestration tokens and cache-TTL premiums are not in `custom` arithmetic; estimates over 1e15 are shown as unknown.

### Currency

All stored amounts and custom prices are USD. `set currency EUR 0.92` labels every displayed amount `EUR` and multiplies by your rate (USD to EUR). There is no network lookup and no built-in rate: any code except `USD` requires a rate, `USD` takes none, and a rate must be a plain decimal above 0 and at most 1,000,000. Changing the currency changes only the display.

## The listing

```text
usage (all sessions; basis host-session-totals: cumulative per session file; pricing catalog; currency USD; read 2026-11-17T09:20:00.000Z)
p0123...  worker-a  tokens: input 600 output 200 cacheRead 400 cacheWrite 0  subscription: no  estimate: 0.0049 USD (catalog)  billed: unknown  model: smoke/first  since 2026-11-17T09:19:25.306Z
p4567...  worker-b  unknown (nothing published)
total of 1 of 2 session(s); 1 unknown
tokens: input 600 output 200 cacheRead 400 cacheWrite 0 (covered sessions only)
estimate: 0.0049 USD (catalog) over 1 of 2 session(s)
billed: unknown (host aggregates do not separate billed amounts from estimates)
```

- Rows are sorted by name, then id. Names and models are one line, control characters removed, names capped at 48 and models at 80 characters (cut with `…`).
- Sessions that published nothing are `unknown` and are counted in `N unknown`, never as zero. A total says how many sessions it covers (`total of 3 of 5 session(s); 2 unknown`). A session with some counters missing is shown with what it has, flagged `partial`, and is not added to the token totals (its estimate is still counted when it is computable). If nothing is published at all the listing says `nothing is published: no listed session has run /peers usage on (usage is private by default)`.
- A row last written more than 60 seconds ago is flagged `[stale]`; exactly 60 seconds is not stale. A registry row is rewritten about every 5 seconds while a session runs, so a stale row means a session that stopped refreshing; its last figures are still shown and counted.
- The `estimate:` total sums computable estimates and, when some are subscription equivalents, says how much of it is not a charge.

### Scope

By default the master lists every running session. `set groups web api` limits the default listing to sessions that belong to one of those groups (group membership is the one `/peers groups` keeps); `set groups all` clears it. `list group:<name>` narrows a single listing and `list <peer>` (stable id or exact name) shows one session. Unknown names and ambiguous names are errors.

## Duplicates and restarts

- One logical session counts once. The listing uses the same host roster as groups and boards: duplicate registrations of one session (`duplicate-session`) are reduced to its proven writer, and `usageSummary` itself never counts an id twice: if an id appears several times, the row with figures and then the newest `updatedAt` is used.
- A logical session whose duplicate registrations have no proven writer is not in the roster and therefore not listed or counted at all; `/peers list` shows it.
- A restart or resume reads the cumulative totals from the session file (see above) and republishes them under the same id: totals are replaced, never added.

## Limits

| item | limit |
| --- | --- |
| sessions with publishing on | 64; when full, entries for sessions that are no longer running are dropped before refusing |
| custom prices | 32 (replacing one at the limit is allowed); model selector 1-128 characters, no whitespace or control characters |
| price or rate | plain decimal: up to 15 integer and 12 fractional digits, no sign, exponent or separator; price 0 to 1,000,000 per million tokens; rate above 0 up to 1,000,000 |
| scope groups | 16, valid group names |
| counters in a registry row | finite, 0 to 1e15 |
| staleness | more than 60 s since the row was written |

## Digests

`usageSummary(peers, config, now)` and `formatUsage(...)` in `lib/features/usage.ts` are pure functions over registry rows; a later digest can reuse them. This feature is not integrated with digests.

## Files and privacy

State is `~/.omp/agent/peer-state/usage.json` (`version: 1`; directory `0700`, file `0600`, atomic replace, symlinks refused, concurrent updates serialised with a kernel file lock). It holds the stable ids of publishing sessions, the currency (and rate), the pricing source, custom prices and the scope groups: no names and no figures. The figures exist only in the publishing session's own registry row. `/peers usage off` removes them from the row at once (the command republishes immediately; otherwise within about 5 seconds).

## Known limits

- Usage is read from the host's totals at the moment the row is written; a turn in progress is counted when the host records it.
- The scenario and tests use a loopback gateway; a real provider's reported usage fields (cache buckets in particular) vary by provider, and the counters are whatever the host derived.
- If the host later exposes provider-reported billed amounts as a separate number, `billed` can be filled from it; today it is never filled.
