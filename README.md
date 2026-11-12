# OMP Peers

Cross-session messaging, master-session control, and model routing for [OMP](https://github.com/can1357/oh-my-pi). Run separate OMP sessions on one machine, then coordinate them from a session you designate as master.

This repository contains the OMP extension and the optional Python peer watcher. It contains no credentials, session histories, or personal model configuration.

## Install

Requires OMP 18.18.1 or newer on macOS or Linux. The extension uses Unix-domain sockets; Windows is unsupported. OMP supplies the TypeScript runtime and host APIs. No build step or separate npm dependencies are required. The optional watcher requires Python 3.

```sh
git clone https://github.com/PIIIX-org/omp-peers.git
omp plugin link ./omp-peers
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

Target a peer by its ID, exact name, or unique name/ID prefix. Use `all` to target the other peers. Targets exclude the sending session. `/peers` opens the interactive dashboard.

### Tools

- `peers_list`: list sessions, models, effort, busy/idle state, context usage, and the master.
- `peers_send`: deliver an agent-attributed message to a peer or `all`.
- `peers_control`: master-only prompt, abort, compact, model, effort, subagents, setting, rename, tail, or shutdown. `status` does not require master ownership.

A message to an idle peer can start a model turn and consume its provider quota. A master's `prompt` starts or queues user work. `abort`, `compact`, and `shutdown` affect running sessions; review your target before sending them. Status and tail inspect local state without asking a model.

### Model routing

Prompt routing defaults to enabled. The master classifies prompts as `light`, `standard`, or `heavy` using local keyword/length heuristics. It selects the corresponding model role and reasoning effort before sending work. Busy peers skip prompt model/effort routing and keep their current selection.

```text
/peers route
/peers route off
/peers do <peer-id> model openai-codex/gpt-6.1-sol
/peers do <peer-id> effort high
/peers do <peer-id> subagents task=openai-codex/gpt-6.1-sol:high,scout=google-antigravity/gemini-3.8-flash:low
/peers do <peer-id> subagents clear
```

Use the `tier: "keep"` argument of the `peers_control` prompt action to keep the peer's model/effort for one task. Direct model and effort actions apply to subsequent requests, including while a peer is busy. Set effort with its own action instead of relying on a model-selector suffix to change it.

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

Subagent auto-routing defaults to `auto-managed`: it runs while a master exists and the peer allows control. `auto` enables it without a master; `auto-off` disables it. Manual peer subagent overrides win over automatic routing and OMP operator model pins. Automatic routing respects operator pins, leaves `seance` alone, and otherwise chooses a specialist tier or the parent task's tier. Manual overrides affect future spawns and remain until cleared or the process exits.

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

The registry and tier configuration use the fixed paths above, shared across OMP profiles under the same OS home. Profile isolation alone does not isolate these peers. Print/JSON sessions do not start a peer server; child agents do not get separate peer identities. On normal shutdown, the extension removes its registry/socket and releases its master claim. Listing peers also removes entries for dead processes.

## Optional peer watcher

From this checkout:

```sh
python3 tools/watch.py
```

The watcher waits for a new/departed peer or a busy-to-idle transition that appears to need attention, prints a report, then exits. Run it as a supervised command if you want its completion to wake a coordinating session. It does not dispatch work or control peers.

It reads the default-profile session files to inspect a peer's last assistant text. It stores its snapshot in `~/.omp-peer-watch/state.json` and skipped acknowledgement excerpts in `~/.omp-peer-watch/skipped.log`. Those files can contain private text; keep them local. Add peer IDs, one per line, to `~/.omp-peer-watch/ignore.txt` to exclude them. Phrase matching is heuristic and can miss a request for attention. The watcher polls at five-second intervals and waits two seconds for a finished peer to flush its reply.

## Contributing

Follow [CONTRIBUTING.md](CONTRIBUTING.md) for the protected branch, CI, independent review, and merge-commit workflow. Every change goes through a pull request.

Keep patches scoped and verify them with isolated OMP sessions. Use a temporary OS home when testing so you cannot send control requests to your real sessions. Do not commit credentials, transcripts, registry snapshots, watcher state, or logs. Preserve PR history with merge commits; squash/rebase merges and force pushes are not accepted.

Run the integration smoke from this checkout:

```sh
python3 tests/smoke.py
```

The smoke links the plugin into a temporary home, starts two real OMP RPC processes with a keyless local-only model configuration, and exercises control gates, model switching, and watcher cleanup. It uses no real provider credentials or model turns and removes its temporary state on exit.

## License

Copyright (c) 2026 PIIIX-org contributors.

Choose either the [MIT License](LICENSE-MIT) or [Apache License, Version 2.0](LICENSE-APACHE), at your option. SPDX: `MIT OR Apache-2.0`.
