# Session groups

Named sets of sessions, so a reusable subset can be addressed as `group:<name>` and can share standing rules. Nothing exists until you create a group; there are no default or seeded groups, and unscoped `all` is unchanged.

## Commands

```text
/peers groups list                      group names with member counts (read-only)
/peers groups add <group> <peer>        add a running session (stable ID or exact name)
/peers groups remove <group> <peer>     remove a member (a not-running member by its stable ID)
/peers groups delete <group>            delete a group
/peers groups members <group>           stored members, shown by name when the session is running (read-only)
/peers groups preview <group> [op]      who a send would reach right now, and who is skipped and why (read-only)
```

- Group names are lower-case: `a-z`, `0-9`, `.`, `_`, `-`, 1 to 48 characters, starting with a letter or digit (the same names `rules` uses for `group:<name>` scopes). Input is lower-cased.
- A group is created by its first `add`. Removing the last member leaves an empty group until `delete`.
- `preview` takes the op a real send would use: `message` (default; what `/peers msg`, `/peers report` and `peers_send` send), `status`, or a control action (`prompt`, `abort`, `compact`, `model`, `effort`, `subagents`, `setting`, `rename`, `tail`, `shutdown`, `pause`; `resume` is not a remote operation). It runs the same resolution as a real send, so its answer is what a send would do at that instant.
- `list`, `members` and `preview` are read-only: they never send anything, never wake a session and never write state.

## Who may change groups

A session may add or remove itself. Changing the membership of any other session needs the master session, using the same check as peer control operations. `delete` needs the master unless the group is empty or contains only the deleting session. `list`, `members` and `preview` are open to every session. A sender's claimed name is never treated as authentication.

## Targeting a group

`group:<name>` is accepted wherever a target is: `/peers msg`, `/peers report`, `/peers do` (master only, as always), `/peers set`, and the `peers_send` and `peers_control` tools.

```text
/peers msg group:frontend rebase onto main
worker-a (p0123...): ok
skipped: worker-b (paused)
```

Every member of the group is either sent to or listed on a `skipped: <name> (<reason>)` line, printed after the per-recipient lines (sorted by name in code-unit order). Nothing is sent to a skipped member. Reasons:

| reason | when |
| --- | --- |
| `paused` | the session published `paused` and the op would be held by the pause gate (`message`, `prompt` and unknown ops; `status`, `tail` and the other non-wake ops are not held) |
| `refuses inbound requests` | the session ran `/peers refuse` |
| `locked (control refused)` | control actions only: the session ran `/peers lock` |
| `not running` | the stored stable ID has no live session; shown by ID because the name is unknown |
| `this session` | the sender is a member; a group target never includes the sending session |

A member with several reasons shows the first in the receiver's own order: refusing inbound, then locked, then paused.

Errors (nothing is sent; skipped members are still listed after the error):

- `unknown group "<name>"`
- `group "<name>" is empty; add members with /peers groups add <name> <peer>`
- `group "<name>" has no running members`
- `group "<name>" has no eligible recipients right now`
- `group "<name>" not sent: logical session has no proven writer: <names and IDs>; use an explicit peer ID` when a member's logical session has several registrations and none is proven to be the writer. Like `all`, the whole send fails and nothing is sent (preview shows the same error); send to an explicit peer ID, or wait until the writer is proven. Paused, refusing, locked and not-running members are not ambiguity: they are skipped and listed.
- `"group:<name>" is ambiguous: it names a group and a peer: ...` when a running session is literally named `group:<name>` and the group exists; use that session's ID. When no such group exists, a session named `group:<name>` keeps its ordinary name meaning.

A member that belongs to a logical session with duplicate registrations is addressed once, through its proven writer.

## Pause and the receiver gate

The sender pre-filters paused sessions from the `paused` flag in the published registry, so a paused member is reported as skipped instead of generating a deferred or refused reply. The pre-filter is a courtesy, not the gate: the receiving session still applies the pause gate to every request unchanged (see [pause.md](pause.md)) and stays authoritative. The registry flag can lag a pause by a moment; a request sent in that window is still held by the receiver and prints the usual `deferred: <name> is paused` line. A registration without a `paused` field (an older version) is not pre-filtered; the receiver decides.

## Membership and standing rules

Membership is stored by stable session ID, the ID a session computes from its session identity, never by a peer-instance ID. Renaming a session, restarting it, resuming it from its session file, or re-registering under a different peer ID keeps its memberships; a different session that reuses a name does not inherit them.

Group-scoped standing rules (`/peers rules add group:<name> ...`) match this membership, read fresh at every agent start: adding a session to the group makes the rule apply from its next start. See [rules.md](rules.md). Deleting a group does not delete its rules; they stay stored and apply to nobody.

## Limits

- At most 64 groups and 64 members per group; adding beyond either is an error. A file that exceeds them is rejected as invalid.
- Only running sessions are addressed; membership of sessions that are not running is kept and shown as `not running`.
- Groups are a coordination convenience between cooperating sessions of one OS user, not a security boundary: anything that can write `~/.omp/agent/peer-state/groups.json` as that user can change them. Authorization for each action is still decided by the receiving session.
- If `groups.json` cannot be read or is invalid, group commands and `group:` targets report the error, standing rules are not injected for that start, and nothing is overwritten. Fix or remove the file.

## Files and privacy

State is stored in `~/.omp/agent/peer-state/groups.json` (`version: 1`; directory `0700`, file `0600`, atomic replace, symlinks refused): group name to a sorted list of stable session IDs. Session names are not stored. Concurrent updates from several OMP processes are serialized with a kernel file lock (`groups.json.lock`).
