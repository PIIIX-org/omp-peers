# Session templates

Named, user-configured starting points for a session: an optional model, a role prompt, extra standing rules and groups. Nothing exists until you add a template; there are no built-in or seeded templates, and nothing here starts, wakes or messages a session.

A template is applied by the session it changes, after you ask for it. An interactive OMP session needs a terminal, so this feature never spawns one: `launch` prints the shell line for you to run yourself.

## Commands

```text
/peers templates add <name> [--model <selector>] [--prompt <role text>] [--rule <text>]... [--group <name>]...
/peers templates show <name>             the resolved configuration and the exact steps for this session (read-only)
/peers templates list                    stored templates (read-only)
/peers templates remove <name>           delete a stored template
/peers templates apply <name> [--yes]    without --yes: the same plan as show, nothing changes; with --yes: apply to THIS session
/peers templates launch <name>           print the shell line for a NEW terminal and the resolved configuration (read-only; starts nothing)
```

- `add` takes options after the name. A value runs until the next of the exact words `--model`, `--prompt`, `--rule`, `--group`, so a role prompt or rule may contain spaces (and other `--words`), but not those four. `--model` and `--prompt` may appear once; `--rule` and `--group` repeat. Whitespace is collapsed to single spaces and one pair of surrounding quotes is removed (the same normalisation as `/peers rules add`). A template must set at least one field. Adding an existing name is an error; `remove` it first (there is no silent overwrite).
- `show`, `list` and `launch` never write: the templates, rules and groups files and the session's model are unchanged. `apply` without `--yes` is identical to `show`.
- No LLM tool exposes templates. Only a user command, or the environment of a new session (below), applies one.

## Fields and limits

| field | rule |
| --- | --- |
| name | `a-z`, `0-9`, `.`, `_`, `-`, 1 to 48 characters, starting with a letter or digit; input is lower-cased |
| `--model` | one selector (a model id, `provider/id` or role alias), 1 to 128 characters, no whitespace or control characters, no thinking-level suffix (`:high` is refused: a template does not set effort) |
| `--prompt` | one line, at most 400 characters, no control characters, screened for credentials |
| `--rule` | at most 8 per template, each at most 400 characters, no control characters, screened for credentials |
| `--group` | at most 8 per template, the same names as `/peers groups` |
| role prompt and rules | must all differ from each other |
| templates | at most 32 |

Text that looks like a credential is refused (and never echoed); templates are stored in plain text and the rules injected into prompts. The same checks run again every time the file is read, so a hand-edited file with a bad value is rejected as invalid instead of being applied. Omitted fields do nothing: no model change, no rules, no groups.

The model is validated when you `add` the template (it must resolve to an available model with credentials, or the template is not saved) and again at every `show`, `apply` and session start, because availability changes. A selector is never replaced by another model.

## What apply does

Applying changes only the session it runs in, in this order:

1. **Model.** Switch to the resolved model through the host's model API. The thinking level is kept. A model the session already runs is left alone (`kept ... (already current)`). If automatic routing is enabled (`/peers unpin`), the master may route the session's model again later; applying does not pin it.
2. **Role prompt.** Added as a session-scoped rule with key `role`, through the same code as `/peers rules add session:<this session>`. It shows in `/peers rules list`, is removable with `/peers rules remove <id>`, and is injected like any rule at the next agent start (see [rules.md](rules.md)).
3. **Rules.** Each added as a session-scoped rule in the order given.
4. **Groups.** This session joins each group, creating it if it does not exist. A session may always add itself, so no master is needed. Joining a group makes stored rules scoped to that group apply to this session; the plan prints a `warning:` line with their count.

It never changes another session, never removes or edits existing rules, groups or memberships, and never touches the session's saved name, master claim or routing policy.

Re-applying is idempotent: a rule that already exists for this session with the same text is reported as `already present (<id>)` and not added again (the rules feature's own duplicate check), an existing membership as `already a member`, and a model already in use as `kept`. Nothing is written if every step is already satisfied.

### Plan equals result

The plan is computed read-only by the same code and checks that apply uses (rule limits, group limits, duplicate detection, model resolution), and `show` lists each step the same way apply reports it:

```text
/peers templates show web
template web
  model: prov/a -> prov/a (available, credentials found)
  role: Review carefully.  (session rule, key role)
  rule 1: Prefer small diffs  (session rule)
  groups: frontend
for this session (p0123...) apply would:
  model prov/a: switch prov/b -> prov/a
  role "Review carefully.": add as a session rule (key role)
  rule 1 "Prefer small diffs": add as a session rule
  group frontend: create and join
result: not applied yet (nothing has been changed); run /peers templates apply web --yes to apply these steps

/peers templates apply web --yes
applied template web to this session (p0123...)
  model prov/a: switched prov/b -> prov/a
  role "Review carefully.": added r1
  rule 1 "Prefer small diffs": added r2
  group frontend: created and joined
Only this session changed; other sessions, existing rules and groups were kept. Rules are injected from this session's next agent start.
```

### All or nothing

Every step is validated before any change. If any step is refused, nothing is applied, including the other steps, and the refused step says why (`refused: ...`):

- the model is unknown, unavailable, not authenticated, has no credentials, or the selector carries a thinking level;
- this session already has a rule with key `role` and different text (it would win over the new role prompt and silently hide it): remove it with `/peers rules remove <id>` first;
- adding the rules would pass 25 rules for this session or 100 in total;
- a group is full (64 members) or adding it would pass 64 groups.

A `warning:` line is printed (the template still applies) when the rules' 8192-byte injection cap would leave some of this session's active rules out of the injected text.

If a step fails after the plan was made, because another process changed the state in between, the run stops and undoes what it changed: the rules it added, the memberships it created (and a group it created), and the model. The message says `every earlier step was rolled back` or lists what could not be undone.

## New sessions from the environment

```text
OMP_PEERS_TEMPLATE=<name> OMP_PEERS_TEMPLATE_CONFIRM=yes omp
```

`launch <name>` prints this line. It runs nothing; you run it yourself in a new terminal. At session start the extension reads `OMP_PEERS_TEMPLATE` and then:

- the session must be brand new: it has no messages and no saved peer-session data for its stable ID. A resumed or continued session is never changed this way and shows `template <name> not applied: this session is not new ...`;
- without `OMP_PEERS_TEMPLATE_CONFIRM=yes` (exactly `yes`) it only shows the plan and `template <name> not applied: set OMP_PEERS_TEMPLATE_CONFIRM=yes or run /peers templates apply <name> --yes`;
- with it, the same checks as `apply --yes` run, and the result (applied or refused, nothing changed) is shown as a notification;
- an unknown name, an invalid name or an unreadable `templates.json` is reported and nothing changes. A session whose identity is held by another process (single-writer refusal) is not changed.

A new session starts with no rules or groups of its own, so each rule is added and each group joined. `launch` shows the configuration, not a per-session plan, and availability is checked again in the new session. The variables only matter at session start; they do not affect a session created later in the same process (`/new`).

## Identity

A template applies to the current logical session, identified by its stable session ID (see [groups.md](groups.md)). Rules and group memberships belong to that ID: a session resumed from its session file keeps them. It never creates or renames a session identity; to give a different identity the template, start a new session (`launch`) or run `apply` in it.

## Files and privacy

State is stored in `~/.omp/agent/peer-state/templates.json` (`version: 1`; directory `0700`, file `0600`, atomic replace, symlinks refused). It holds the template names, model selectors, texts and group names you typed; no credentials, session names or IDs. Rules and memberships created by `apply` live in `rules.json` and `groups.json` as usual. Concurrent updates from several OMP processes are serialised with a kernel file lock (`templates.json.lock`). If `templates.json` cannot be read or is invalid, every templates command reports the error and nothing is overwritten.

## Limits

- Templates are a convenience for one OS user, not a security boundary: anything that can write `templates.json` as that user can change what a template does. Credential screening is a conservative pattern check, not a guarantee.
- The model's credentials are checked with the host's credential lookup (the same check routed model changes use); a provider can still reject the key at the first request.
- No template editing: `remove` and `add` again. No per-template effort, tools, settings or working directory.
- `show` and `launch` check model credentials through the host, which may refresh an expired login as any model use would.
