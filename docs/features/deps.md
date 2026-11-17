# Report-driven task dependencies

Opt-in rules of the form "when session A reports DONE for unit X, prompt session B with Y". A rule fires only from an explicit structured `DONE` report that the master session accepted. Nothing is stored, queued or sent until you add a rule, and nothing is sent without your approval unless you added that rule with `--auto`.

## Commands

```text
/peers deps [list]
/peers deps add <from> <unit...> -> <to> <prompt...> [--auto] [--once|--repeat]
/peers deps remove <rule-id>
/peers deps enable <rule-id>
/peers deps disable <rule-id>
/peers deps preview <rule-id | trigger-id | from unit...>
/peers deps pending
/peers deps approve <trigger-id>
/peers deps reject <trigger-id>
/peers deps ledger
```

- `list`, `preview`, `pending` and `ledger` are read-only. They never write the file, never create the state directory, never send anything and never wake a session. They work from any session.
- `add`, `remove`, `enable`, `disable`, `approve` and `reject` are master-only (the same check as peer control operations; run `/peers master` first). They are slash commands typed by the user. There is no LLM tool for them, and a prompt sent to a session cannot run them (OMP does not run extension commands from a delivered prompt), so an agent cannot approve its own dispatch.
- `add` takes the words between `<from>` and the first `->` as the unit and the first word after `->` as the target; everything after that is the prompt. The flags `--auto`, `--once` and `--repeat` are recognised only as the last words. The reply repeats the rule and shows its full preview, so an `--auto` rule is always shown before it can fire.
- `<from>` and `<to>` are a live session's stable ID or exact name (case-sensitive). Ambiguous names are refused; use the ID. Rules store the stable IDs resolved at add time, so a later rename or restart of the session changes nothing.
- `preview d1` shows a rule; `preview worker-a Parser rewrite` shows the rules for that source and unit; `preview t3` shows an existing trigger. A preview shows the trigger id the next firing would get, the target, the exact message text, and whether delivery would be attempted or why it is blocked. It is computed with the same text, blocker and approval checks as the real dispatch, so for the same state the approved message is character-for-character the previewed one.

## Rules

| Field | Meaning |
| --- | --- |
| `id` | `d<number>`, never reused |
| `from` | stable ID of the session whose report fires it |
| `unit` | the report's `unit`, compared exactly after collapsing whitespace (case-sensitive), at most 120 characters |
| `on` | `DONE` only. `BLOCKED`, `WAITING` and `DECISION` never trigger |
| `to` | stable ID of the session that receives the prompt |
| `prompt` | one line, at most 400 characters |
| `mode` | `confirm` (default) or `auto` |
| `once` | `--once` (default) or `--repeat` |
| `enabled` | `disable` stops new triggers |

Validation at `add`: both sessions must be live and resolve; a session cannot depend on itself; the same `from`/`unit`/`to` cannot be added twice; the rule graph must stay acyclic; at most 64 rules in total and 8 outgoing rules per source session. The graph is conservative: its nodes are sessions and its edges are `from -> to`, so `A.x -> B` followed by `B.y -> A` is refused as a cycle even though the units differ. Disabled rules still count. A refused cycle shows its path, for example `worker-c (...) -> worker-a (...) -> worker-b (...) -> worker-c (...)`. The unit and the prompt are one line (whitespace is collapsed, control characters are rejected) and are screened like standing-rule text: anything that looks like a credential is rejected without being repeated. Lengths count characters as JavaScript string length (UTF-16 code units).

## What fires a rule

Only a structured `DONE` report that the **master session** accepts, through the existing report hook. Not idle transitions, not text messages, not a `BLOCKED`/`WAITING`/`DECISION` report, and never a subagent's report (the receiver skips every report hook for those). The report's sender is the id the report claimed; peer messages are not authenticated, so any local process that can reach the master's socket could send a forged `DONE`. That is why confirm mode is the default and `--auto` is an explicit opt-in.

- Only the master acts, so several receivers never fire the same trigger. A report accepted by a non-master session triggers nothing and is not queued for a later master. With no master claimed, nothing fires.
- A master that refuses inbound requests receives no report. A master that is control-locked ignores reports for this purpose (the same condition under which it hides its agent context), so nothing fires and nothing is queued while locked. A paused master never sees reports either: the pause gate refuses the message before any feature hook runs, so nothing fires and nothing is queued while it is paused.
- Firing records one **trigger** in the ledger per matching enabled rule. A trigger is identified by `t<number>` (never reused).
- **Event key.** A report's identity is a hash of (sender id, unit, kind, evidence description, evidence references). An exact re-send has the same key and cannot fire the same rule twice, including after a restart of any session and across processes. A genuinely new `DONE` for the same unit (different evidence description or references) is a different event and can fire a `--repeat` rule again. Only the 16-hex-digit hash is stored; evidence text is never written.
- **`--once` (default).** The rule disables itself when it fires its first trigger (when the trigger is recorded, not when it is delivered). Later `DONE` reports for the unit, even with new evidence, do nothing. `enable` turns it back on if you want it to fire again; removing and re-adding it also works.

## Confirm and auto

- **confirm (default).** The trigger is recorded as `pending` and nothing is sent. `/peers deps pending` lists it with the rule, source, target and prompt. The master's agent also gets one context line at its next user-started turn: the number of triggers awaiting approval and their ids (at most 8 shown), never prompt text, and only when this session is the master and accepts remote requests. Nothing is sent until you run `/peers deps approve <trigger-id>`, which dispatches exactly one message. `reject` closes the trigger without sending.
- **auto (`--auto`).** The trigger is recorded, the sender is acknowledged, and the dispatch then runs in the background (it is never awaited inside the report hook, so a slow or hung target cannot make the reporter time out and resend). The ledger claim guarantees at most one send per trigger. The add reply shows the preview, including any current blocker; a refused or unreachable target leaves the trigger `not delivered` and re-approvable. The dispatched text contains only stable ids and the rule's own fields, never a session's current name.

## Dispatch

A dispatch is one ordinary peer message sent with the same path as `/peers msg`, from the master session, so the receiving session shows it as a message from the master (attributed to an agent, not the user). It is not the master-only `prompt` operation. The text is exactly:

```text
Dependency trigger <t-id> (rule <d-id>, authorized by the user at the master session): session <source stable id> reported DONE for unit "<unit>" (the sender identity is claimed, not authenticated).
Task: <prompt>
```

The target's own rules apply unchanged: a paused session refuses (and is never resumed by a dependency; the line says who may resume it, see [pause.md](pause.md)), a session that refuses inbound requests refuses, and the receiver's rate limit (20 messages a minute per sender) applies. A target with `/peers lock` set (control refused) is also not messaged: a dependency trigger is authorized work, so it respects the target's refusal of control (`not delivered: target locked (control refused)`, re-approvable after `/peers unlock`). Before sending, the dispatcher also checks what it can see (target not running, target refuses inbound, target control-locked, target paused, an unreadable pause state which fails closed, target is the dispatching session itself) and records those without sending; the preview lists the same reasons. A dispatch to a session that is not running never resumes it.

## Outcomes and the ledger

Each trigger carries one outcome:

| Outcome | Meaning |
| --- | --- |
| `pending` | waiting for `approve` or `reject` |
| `delivered` | the target accepted the message; never sent again |
| `not delivered: <reason>` | nothing reached the target (paused, refuses, not running, rate limited, ...). Re-approvable: `approve` retries once per command; there are no automatic retries |
| `unknown: <reason>` | the send ended without proof either way (timeout, connection closed, unreadable reply, a socket error other than connection refused or a missing socket). The message may have arrived, so it is not retried; `reject` closes it |
| `sending` | a dispatch is in flight. After 60 s it is treated as an interrupted dispatch with an unknown outcome |
| `rejected` | closed by `reject`; its report event still counts as seen |
| `cancelled: rule removed` | its rule was removed while it was waiting |

**Duplicate prevention.** There is at most one ledger entry per (rule, sender, report event key), and a dispatch claims the entry (`sending`) under the cross-process state lock before anything is sent, so two processes cannot both deliver it. A re-sent report never re-queues or retries a trigger whatever its outcome. `disable` stops new triggers but leaves queued ones until you approve or reject them. `remove` cancels a rule's waiting triggers.

The ledger keeps at most 500 entries. When it is full, the oldest `delivered`, `rejected`, `cancelled` and `unknown` entries are dropped to make room; entries that are `pending`, `not delivered` or in flight are never dropped. If the ledger is full of those, a new matching report is not queued and the receiving session shows a warning. An exact re-send of a report whose entry has been dropped can fire a `--repeat` rule again. `/peers deps ledger` shows the newest 50 entries.

## Files and privacy

State is `~/.omp/agent/peer-state/deps.json` (`version: 1`; directory `0700`, file `0600`, atomic replace, symlinks refused). Every change is a locked read-modify-write (`deps.json.lock`), so concurrent updates from several OMP processes never overwrite each other. An unreadable or invalid file is reported and never overwritten. The file holds rules (including their prompts, which you typed), session IDs, event-key hashes and outcomes; it holds no evidence, blockers, transcripts or credentials.

## Limits

- 64 rules; 8 outgoing rules per source session; unit 120 and prompt 400 characters; 500 ledger entries.
- Only `DONE` triggers, only the master fires, and only when it accepts remote requests.
- Sessions must be live when a rule is added.
- One dispatch is one message to one session; there is no fan-out and no chaining beyond what a worker's own later reports trigger.
- A report cannot be proven to come from the session it names (see above).
