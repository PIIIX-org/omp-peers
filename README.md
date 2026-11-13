# OMP Peers

Cross-session messaging, master-session control, and model routing for [OMP](https://github.com/can1357/oh-my-pi). Run separate OMP sessions on one machine, then coordinate them from a session you designate as master.

This repository contains the OMP extension and the optional Python peer watcher. It contains no credentials, session histories, or personal model configuration.

## Install

Requires OMP 18.18.1 or newer on macOS or Linux, plus npm for installation. The extension uses Unix-domain sockets and OMP's native `FileLock` library; Windows is unsupported. OMP supplies the TypeScript runtime and host APIs. No build step is required. The optional watcher requires Python 3.

```sh
git clone https://github.com/PIIIX-org/omp-peers.git
cd omp-peers
npm ci --omit=dev --ignore-scripts
omp plugin link .
```

Start new OMP sessions after linking. For a one-session trial without installing:

```sh
omp --extension ./omp-peers
```

If you already load a standalone `peers.ts` from `~/.omp/agent/extensions`, choose either that copy or this plugin before starting new sessions. Loading both creates duplicate commands and sockets. Installing this package does not change existing sessions.

## Use

Open two OMP sessions. In the coordinating session:

```text
/peers list
/peers master
/peers msg <peer-id> Please report the current blocker.
/peers do <peer-id> status
/peers do <peer-id> tail 6
/peers do <peer-id> rename API worker
/peers release
```

Target a peer by its stable ID, exact name, or unique name/ID prefix. Exact IDs take precedence over another peer's name. Use `all` to target the other logical sessions. Targets exclude the sending logical session, including its legacy aliases. `/peers` opens the interactive dashboard.

### Session identity and master restoration

Resume the same saved OMP session (`omp --session <session-file>` or OMP's resume picker) to keep its peer ID and name. Each ID derives from the host's session ID; PID and random `instance` identify the current process incarnation. Starting a new session or branching creates a new logical peer. Sessions without saved files cannot resume after exit.

To remember master ownership for this session:

```text
/peers master --restore
```

`/peers master` claims the role without enabling restoration. The extension checks remembered ownership on startup and every five seconds. It waits while another live master owns the role; it does not replace that master. `/peers release` releases ownership and disables restoration for the current logical session, including after restart. Until you release it, closing or crashing a remembered master preserves that preference.

Kernel-backed locks permit one plugin writer per logical session and one master. A second process opening the same session cannot publish a server, send peer requests or claim master; it reports `session already owned`. Close that process and resume it after the owner exits. The host may also reject duplicate sessions through its own session lease. Process exit releases the locks, including after a crash. A live legacy master also blocks a new claim, but legacy versions cannot honor the new lock protocol; upgrade all peers before relying on concurrent master claims.

If a legacy peer overwrites a live upgraded master's claim, the displaced peer drops its kernel lock on the next five-second refresh without deleting the legacy claim. Other upgraded peers can claim after the legacy master releases; a displaced `--restore` session retries automatically. This recovery also applies when restoration is disabled, but does not make concurrent legacy claims safe.

The extension stores names and restore preferences under `~/.omp/agent/peer-sessions` (`0700` directory, `0600` files), with lock/registry files under `~/.omp/run/peers`. Preserve this metadata when moving a saved session to another home. Do not publish it. The first upgrade changes the old process-only peer ID once; new peers still discover legacy six-hex IDs. Restart upgraded sessions to obtain stable addresses. Deleting a session's metadata forgets its restore preference and fallback name, but its session-derived ID stays the same.

Duplicate registrations remain visible; listing never deletes a live duplicate. Roster flags show `duplicate-name:<ids>` and `duplicate-session:<ids>`. Same-name sessions with different logical identities are each legitimate. Duplicate-name sends fail with candidate IDs: retry with the exact intended ID.

`canonical` identifies a stable registration whose live socket confirms its current PID, instance, logical session ID and owned session lock. Other aliases show `canonical:<id>`. Timestamps, name ordering and a held lock alone do not establish ownership. Unreachable, refusing or legacy writers without that proof show `canonical:unknown (use explicit ID)`; exact IDs still work subject to ordinary inbound/control gates.

Broadcasts deliver once per logical session, using its proved canonical writer when aliases exist. If any duplicate logical session has no proved writer, the entire broadcast fails before delivery and lists actionable IDs; send to an explicit ID instead. Unique legacy sessions and same-name distinct sessions continue to receive ordinary broadcasts.

### Tools

- `peers_list`: list sessions, models, effort, busy/idle state, background job/subagent counts, settled state, context usage, and the master.
- `peers_send`: deliver an agent-attributed message to a peer or `all`. Set optional `report: "DONE" | "BLOCKED" | "WAITING" | "DECISION"` for an explicit report. The body takes the ordinary route immediately; a successful same-turn delivery to the current master can suppress a redundant watcher notice. Use `/peers report <peer|all> <kind> <text>` from the command interface.
- `peers_control`: master-only prompt, abort, compact, model, effort, subagents, setting, rename, tail, or shutdown. `status` does not require master ownership.

A message to an idle peer can start a model turn and consume its provider quota. A master's `prompt` starts or queues user work. `abort`, `compact`, and `shutdown` affect running sessions; review your target before sending them. Status and tail inspect local state without asking a model.

### Background activity and quiescence

Peer registry JSON and the read-only `status` RPC expose:

| Field | Meaning |
| --- | --- |
| `activity.activeJobs` | Running background jobs owned by this session or descendant agents. Includes task jobs; excludes foreground-backed jobs. |
| `activity.activeSubagents` | Descendant subagents with a live streaming session. Excludes idle/parked agents, advisors and unrelated session trees. |
| `activity.unknownReasons` | Fixed capability/reliability reason codes; no job labels, commands, output or transcript content. |
| `hasPendingAsyncWork` | The host's owner-scoped async-wake predicate, including pending delivery and delivered results awaiting injection. |
| `isSettled` | Conservative tree quiescence at observation time. `true` means no observed running jobs/agents, queued/admitted input, async/IRC wake, post-prompt work or advisor review backlog, and autonomous scheduling proven disabled. It does not mean the task passed its acceptance criteria. |

Counts and predicates use `null` for unavailable capabilities. Older registrations may omit these fields. Neither case means zero or settled. Text status uses `jobs:? agents:? settled:unknown`. Job and subagent counts overlap for task-backed workers; do not add them together.

Status reads current host metadata on each request; the registry refreshes on lifecycle events and at most five seconds after completion/cancellation. A running job prevents `isSettled: true` even if its automatic delivery is suppressed. Cancellation removes the running count; completion may leave pending wake work after the count reaches zero.

OMP 18.18.1 exports the read-only `AgentRegistry` under `@oh-my-pi/pi-coding-agent/registry/agent-registry`. The plugin validates its own registry ref against the current session ID before reading that local session's public `getAsyncJobTree()`, `hasPendingAsyncWork()`, queue/admission and wake-state APIs. It checks `getAdvisorStatusOverview().advisors[].backlog` for queued or in-flight reviews in the root and live descendants; unavailable advisor state keeps settlement unknown. It walks metadata parent links and uses `registry.isRunning()` to count streaming children. It does not scan transcripts, count OS processes as jobs, or revive parked agents.

The host's scheduled-turn probe belongs to mode owners, so active/paused autonomous modes retain `isSettled: null` with `autonomous_scheduler_unavailable` unless known work already makes it `false`. TUI status needs `ctx.sessionModes.getState()` to prove goal/loop/vibe modes inactive. RPC status needs the local session's public `getGoalModeState()` to prove no goal mode. Unsupported mode/host capabilities remain unknown.


### Model routing

Prompt classification defaults to enabled on the sender, but **receivers keep their current model and effort by default**. OMP 18.18.1 exposes the current model, not top-level operator-selection provenance, so the plugin conservatively treats every session as pinned. Normal prompts still dispatch; only automatic model/effort changes require a local opt-in. Status/registry show `routing:keep` or `routing:auto`.

```text
/peers route
/peers route off
/peers do <peer-id> model openai-codex/gpt-6.1-sol
/peers do <peer-id> effort high
/peers do <peer-id> subagents task=openai-codex/gpt-6.1-sol:high,scout=google-antigravity/gemini-3.8-flash:low
/peers do <peer-id> subagents clear
```

On the receiving session, `/peers unpin` opts in to automatic prompt tiering; `/peers pin` restores the safe default. This policy is saved per logical session under `~/.omp/agent/peer-sessions` and survives resume; it is not a host model pin and does not change OMP configuration. A later local `/model` selection does not revoke the explicit `unpin` opt-in: run `/peers pin` before delegating if that selection must remain fixed. Sender `/peers route off` disables its automatic proposals, not receiver pins.

`tier: "keep"` always preserves both model and effort. Other tiers alone do not bypass pins. An authorized master can explicitly override with `peers_control` `{action:"prompt", to:"<peer-id>", text:"...", tier:"heavy", overridePin:true}`; direct `model` and `effort` actions are also explicit overrides. Successful explicit changes pin the resulting selection again. Set effort with its own action instead of relying on a model-selector suffix. Control still requires the existing master authorization and receiver unlock.

Busy sessions queue ordinary prompts without automatic model/effort changes. Explicit prompt/model/effort overrides fail while busy, without dispatch or mutation; retry after the current turn ends. Unavailable requested models (including failed credentials) fail before effort changes or prompt dispatch; no replacement model is selected. Configured role aliases retain OMP's operator-configured priority-list semantics and the resolved identity is reported. Every applied route reports old/new model, old/new effort and reason to the sender and in a visible receiver notice/history entry; retained routes explain the pin or busy reason to the sender.

Default prompt tiers:

| Tier | Model role | Effort |
| --- | --- | --- |
| light | `@smol` | minimal |
| standard | `@default` | medium |
| heavy | `@slow` | high |

Define the OMP roles with models you can access. The plugin does not create provider logins or choose a paid plan. If a newly authenticated provider appears in `omp models` but a peer reports `unknown model`, check that peer's authenticated availability; a fresh CLI listing and a running session can have different refresh timing.

To override tiers, create `~/.omp/agent/peers.json`:

```json
{
  "tiers": {
    "light": { "model": "@smol", "effort": "low" },
    "standard": { "model": "@default", "effort": "medium" },
    "heavy": { "model": "@slow", "effort": "high" }
  },
  "subagentTiers": {
    "scout": "light",
    "sonic": "light",
    "task": "standard",
    "reviewer": "heavy"
  }
}
```

Subagent auto-routing defaults to `auto-managed`: it runs while a master exists and the peer allows control. `auto` enables it without a master; `auto-off` disables it. **OMP operator `task.agentModelOverrides` pins win over both manual peer overrides and automatic routing.** To deliberately replace an operator task pin, the operator must edit/clear that setting explicitly (or authorize the master's existing `setting` action); ordinary peer subagent overrides cannot bypass it. If the host cannot expose task-pin settings, the plugin leaves the host selection intact. Otherwise manual peer overrides beat automatic tiering, and automatic routing leaves `seance` alone. Overrides affect future spawns until cleared or process exit. Unavailable plugin-selected models block the spawn instead of falling back; applied replacements include old/new selectors and their routing reason in the host's visible route note.

Supported API evidence: the pinned 18.18.1 package declares `ExtensionContext.model`, `ctx.models.current()/list()`, `ExtensionAPI.setModel(): Promise<boolean>` and `setThinkingLevel()`, but no top-level pin-provenance field. Its public `AgentSession.setModel(model, role?, {selector?, thinkingLevel?, persist?})` and `setModelTemporary()` are setters, not evidence that an existing selection is unpinned. The public `config/model-resolver` function `resolveModelRoleValue()` returns the selected model, role effort and selector warnings; the plugin rejects warnings rather than accepting a malformed-selector fallback. The settings registry exposes `task.agentModelOverrides`, and `before_subagent_spawn` exposes original `patterns` plus a visible result `note` and `block/reason`. The plugin uses these supported APIs rather than inventing host pin metadata.

### Runtime settings

The master can inspect or override non-protected OMP settings on another peer:

```text
/peers set <peer-id> get modelRoles
/peers set <peer-id> set defaultThinkingLevel "high"
/peers set <peer-id> clear defaultThinkingLevel
```

These overrides live in memory and do not save configuration files. The extension rejects protected settings such as credentials, provider transports, trust, and approval policy. Setting support requires the host's settings-registry API.

## Local trust and privacy

The trust boundary is the OS account. Peers share `~/.omp/run/peers` with a `0700` directory and `0600` sockets/registry files. The extension checks master identity for control requests, but a process running as the same OS user can read the registry, claim that identity, or alter the files. This is coordination between trusted local processes, not an authentication boundary against same-user malware.

Registry files expose session names, working directories, models, session IDs, and busy/context metadata. Tail requests can expose transcript text. The plugin sends no telemetry itself; model turns and OMP's own services follow your OMP configuration.

```text
/peers lock
/peers unlock
/peers refuse
/peers accept
```

`lock` rejects master control while permitting messages and status. `refuse` rejects all inbound requests. Set `OMP_PEERS_INBOUND=refuse` before launching a session to refuse inbound requests from startup. A new process starts unlocked unless configured to refuse.

The registry and tier configuration use the fixed paths above, shared across OMP profiles under the same OS home. Profile isolation alone does not isolate these peers. Print/JSON sessions do not start a peer server; child agents share the main session's identity. On normal shutdown or a session switch, the extension removes its registry/socket and releases its live master claim; remembered master preferences remain until `/peers release`. Listing peers also removes entries for dead processes after acquiring their identity lock.

## Optional persistent peer watcher

Run from this checkout with Python 3.9 or newer:

```sh
python3 tools/watch.py
```

The watcher keeps running without OMP or a master. It queues metadata-only turn-ended transitions and sends a readable digest to the current master through the local message RPC, at most once per five minutes by default (`--digest-interval 300`). Explicit reports keep their immediate ordinary delivery route. **Delivery can start a model turn in the master and consume provider quota.** A turn-ended or idle event does not prove task completion. Notifications distinguish an agent yield from live quiescence, report available background counts, and retain `UNKNOWN` on older or unavailable hosts.

The watcher deduplicates by stable session and event IDs, keeps a version-1-compatible outbox across restarts, and excludes the current master's events to prevent feedback. It suppresses an empty notice only after an acknowledged explicit report for the same logical session, agent-loop turn and current master destination. Initial idle peers, replacement-process initial idle states and departures do not count as completions. It reads peer registry, plugin notification metadata and selected legacy lifecycle-log metadata, never session transcripts. State lives under `$HOME/.omp-peer-watch` with a `0700` directory and `0600` files; state and logs still contain private session metadata. Only one watcher may use a runtime directory.

For macOS startup independent of OMP:

```sh
python3 tools/install_watcher.py install
```

The installer renders a portable LaunchAgent template with `RunAtLoad` and `KeepAlive`. It accepts `--label`, `--state-dir`, `--python` and `--digest-interval`; it refuses to overwrite an unmanaged watcher. Use `python3 tools/install_watcher.py uninstall` to stop and remove the default installation, or add `--purge` to remove its known state/log files. [Installation, migration, privacy and completion semantics](docs/watcher.md) cover custom labels and runtime directories, Linux foreground use, delivery limitations, and offline checks.

## Contributing

Follow [CONTRIBUTING.md](CONTRIBUTING.md) for the protected branch, CI, independent review, and merge-commit workflow. Every change goes through a pull request.

Keep patches scoped and verify them with isolated OMP sessions. Use a temporary OS home when testing so you cannot send control requests to your real sessions. Do not commit credentials, transcripts, registry snapshots, watcher state, or logs. Preserve PR history with merge commits; squash/rebase merges and force pushes are not accepted.

Run the integration smoke from this checkout:

```sh
python3 tests/smoke.py
```

```sh
npm run test:activity
npm run test:identity
npm run test:activity-smoke
npm run test:routing
npm run test:routing-smoke
```

Activity regressions cover job completion/cancellation, delivery gaps, streaming versus parked agents and unavailable capabilities. The activity smoke registers real session-owned jobs in a disposable OMP process and checks both socket status and registry refresh. It acknowledges a completion before delivery to avoid a model wake; it does not connect to a provider.

The routing regression loads the extension with deterministic host callbacks in a disposable home and exercises its real Unix socket, authorization, prompt dispatch, pins, unavailable credentials and subagent hook. The routing smoke uses real OMP processes for visible old/new reports, pin policy, unavailable prompt rejection and resume persistence. It sends no successful user prompt to the actual host, so neither scenario needs a provider turn.


The smoke links the plugin into a temporary home and runs real OMP RPC processes with a keyless local-only model configuration. It exercises control gates, model switching, saved-session restarts, crash recovery, master contention/restore opt-out, legacy-overwrite lock recovery with and without auto-restore, duplicate-name and logical-alias rosters, exact-ID/name collisions, deduplicated and blocked broadcasts, and watcher cleanup. Legacy fixture sockets receive explicit-ID messages locally without waking a model. It uses no real provider credentials or model turns and removes its temporary state on exit.

## License

Copyright (c) 2026 PIIIX-org contributors.

Choose either the [MIT License](LICENSE-MIT) or [Apache License, Version 2.0](LICENSE-APACHE), at your option. SPDX: `MIT OR Apache-2.0`.
