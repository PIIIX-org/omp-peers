# Standing rules

Store an instruction once with a scope and have OMP add it to every matching session's context, instead of repeating it in each prompt. Nothing is stored or injected until you add a rule.

## Commands

```text
/peers rules add <scope> [--key <label>] <text>
/peers rules remove <id>
/peers rules list [--effective <peer>]
/peers rules explain <peer>
```

- Scope is `global`, `group:<name>` or `session:<peer>`. A session is given by stable ID or exact name and is stored as the stable ID, so renaming it later does not move the rule. Names containing spaces must be given by ID. Groups are lower-case names (`a-z`, `0-9`, `.`, `_`, `-`, up to 48 characters).
- `add` prints the stable rule ID (`r1`, `r2`, ...). IDs are never reused after removal.
- `--key` labels a rule so that rules for the same topic can conflict visibly (see below). Labels use the same characters as group names, up to 32.
- Text is one line, up to 400 characters. Surrounding quotes are removed and whitespace is collapsed.
- `list` shows every rule in precedence order and flags rules that conflict. `list --effective <peer>` and `explain <peer>` show what applies to one session. `<peer>` is a stable ID, an exact name, or (for these read-only commands) the stable ID of a session that is not running.

## Who may change rules

A session may add and remove rules scoped to itself (`session:<itself>`). Anything that reaches other sessions (`global`, `group:*`, another session) needs the master session, using the same check as peer control operations. Reading, `list` and `explain` are open to every session. A sender's claimed name is never treated as authentication.

## Matching and precedence

A rule applies to a peer when its scope is `global`, `group:<g>` for a group the peer belongs to, or `session:<peer id>`. Order is deterministic:

1. session rules (then rule ID),
2. group rules, by lexical group name, then rule ID,
3. global rules, by rule ID.

Group membership comes from the group registry (`/peers groups`, see [groups.md](groups.md)), read fresh at each agent start: a group rule starts applying to a session when it joins the group and stops when it leaves. A session in no group, or a group that does not exist, matches no group rules. If `groups.json` cannot be read, the rules are not injected for that start and a warning is shown.

### Conflicts

Two rules conflict when they share a `--key` and have different text, for example `add global --key tests run the unit suite` and `add session:worker-a --key tests run the full suite`. The first rule in the order above stays active; the others are shown as `overridden: ... conflicts with <id>` by `explain` and `list --effective`, and are not injected. `add` also prints a `conflict:` line, and `list` marks both sides with `CONFLICT with <id>`. Two rules for different sessions never conflict. Rules with the same key and the same text, or the same text under different scopes, are `redundant`: only the first is injected.

### No duplicates, no credentials

Adding a rule whose scope and text already exist is rejected and reports the existing ID. Text that looks like a credential (token prefixes, `api_key=...` style assignments, bearer tokens, private-key headers, URLs with embedded passwords) is rejected with an error that does not repeat the text. This is a conservative pattern screen, not a guarantee; rules are stored in plain text, so describe where a secret lives instead of including it.

## Injection

On each main-agent start, the extension reads the rules file, selects the rules for that session and appends them to the system prompt through OMP's documented `before_agent_start` result (`systemPrompt`). The user's prompt is not changed. The text is not stored in the conversation, so a rule you remove is gone from the next agent start and cannot linger in earlier turns. Only the main session whose stable ID matches is affected; subagents are not. When no rule applies, nothing is injected. If the rules file cannot be read, the session starts without rules and a warning says why.

Injected text lists the active rules most specific first, each tagged with its ID and scope (`- [r2 session] ...`). A session that has run `/peers lock` or `/peers refuse` (or started with `OMP_PEERS_INBOUND=refuse`) is injected only rules it added itself; rules authored by other sessions are not injected until it accepts and unlocks again. Injection is capped at 8192 bytes: when the active rules do not fit, the first rule that does not fit and every lower-precedence rule after it are omitted and one line states how many. To keep this bounded, `add` refuses past 25 rules per scope or 100 rules in total.

Limits: another extension that replaces the whole system prompt after this one can drop the rules. A host without `before_agent_start` system-prompt results is unsupported (OMP 18.18.1 is the pinned minimum); there is no fallback injection.

## Files and privacy

Rules are stored in `~/.omp/agent/peer-state/rules.json` (`version: 1`; directory `0700`, file `0600`, atomic replace, symlinks refused). Each rule records its ID, scope, text, optional key, the adding session's ID and a timestamp. Session names are not stored. Concurrent updates from several OMP processes are serialized with a kernel file lock (`rules.json.lock`), so simultaneous `add` calls do not lose entries. An unreadable or invalid file is reported and never overwritten.

Do not publish this file: it contains your instructions.
