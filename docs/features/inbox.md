# Decision inbox

Sessions queue short questions for the user in one shared inbox. The master session presents them together, with their source, context, requested decision and state, and the user answers or defers them. Nothing is queued until a session asks, and nothing is sent until the master answers.

## Commands

```text
/peers inbox [list [--open]]
/peers inbox ask <question>
/peers inbox answer <id> <text>
/peers inbox defer <id> [note]
/peers inbox reopen <id>
/peers inbox retry <id>
```

- `list` (the default) shows every question grouped by asking session: id, state, time asked, question, context, requested decision, and for answered questions the answer and its delivery state. Each group says whether that session is currently live. `--open` shows only open questions. `list` works in any session, is read-only (it writes nothing and contacts no session beyond the normal roster lookup) and never resumes or wakes anything.
- `ask` queues a question from the current session. Use the `peers_decision` tool (below) for context and options.
- `answer`, `defer`, `reopen` and `retry` are master-only, with the same check as peer control operations (`/peers master` first). A non-master session gets a clear error and nothing changes. A sender's claimed name is never treated as authentication.
- `<id>` is `q<number>` or just the number. IDs are never reused, even after old entries are dropped.

## The `peers_decision` tool

`peers_decision` is available to the model in every session.

- `action: "ask"` with `question` (required, one line, at most 300 characters), optional `context` (at most 500), `options` (at most 8 choices, each at most 100 characters) and `key`. It returns the new id immediately; the session should keep working.
- `action: "check"` (optional `id`) returns the state, answer and delivery of this session's own questions. It reads the file only and wakes nothing. Other sessions' questions are not shown.

## Entry states

| state | meaning |
| --- | --- |
| `open` | waiting for the user |
| `answered` | the master recorded an answer (at most 500 characters) |
| `deferred` | the master postponed it, optionally with a note; nothing was sent |

`answer` works on an open or deferred question; an answered question must be `reopen`ed first. `defer` works on an open question. `reopen` returns a deferred or answered question to `open` and clears its resolution.

## Deduplication

A retry returns the existing id instead of a duplicate when the same session asks the same question while it is still unresolved (`open` or `deferred`). "Same" means either the same explicit `key`, or the same text after trimming, collapsing whitespace, lower-casing and dropping trailing `?`, `.` or `!`. Another session asking the same text creates its own entry. Once a question is answered, asking it again creates a new entry.

## Delivery of an answer

When the master answers, the extension sends one ordinary peer message to the asking session, stating the question id, the question and the decision. It uses the normal send path, so the receiver's inbound refusal, control lock and rate limit apply unchanged. A live idle session may start a turn to read it, like any peer message.

The result is stored in `delivery`:

- `delivered`: the session accepted the message.
- `pending`: the session is not live (or is the master itself). It is never resumed. The asker reads the answer with `peers_decision check`, or the master re-attempts with `/peers inbox retry <id>`.
- `undeliverable: <reason>`: the session is live but refused or could not be reached (for example refusing inbound requests, rate limited, unreachable, or `session is paused`: a paused session refuses wake-triggering messages, and the line names who may resume it, for example `paused by its user: only its user can resume it`, `paused by the master: the master or its user can resume it` or `paused after a restart: only its user can resume it`). Fix the cause and `retry`, or the session can still use `check`.

`defer` never sends anything. `retry` only applies to answered questions that are not yet delivered; a delivered answer is never sent twice by `retry`.

## Credentials

Question, context, options, answers and notes are screened with the same conservative credential patterns as [standing rules](rules.md) (token prefixes, `api_key=...` assignments, bearer tokens, private-key headers, URLs with passwords). A match is rejected with an error that does not repeat the text. This is a pattern screen, not a guarantee: describe where a secret lives instead of including it.

## Files and limits

Entries live in `~/.omp/agent/peer-state/inbox.json` (`version: 1`; directory `0700`, file `0600`, atomic replace, symlinks refused), so unresolved questions survive restarts. Each entry records its id, the asking session's stable peer id and the name it had when it asked, the question, optional context and options, the retry key, times, state, resolution and delivery. Concurrent writers (several sessions asking at once) are serialized with a kernel file lock (`inbox.json.lock`) and do not lose entries. An unreadable or invalid file is reported and never overwritten.

The inbox holds at most 500 entries. When full, a new question drops answered entries to make room: delivered answers first, then the oldest answered ones whose delivery is still pending or failed (their asker can no longer read that answer). Open and deferred entries are never dropped, so a new question is refused once all 500 are open or deferred; answer some to free room. With a master session running, the master's next agent start is told (ids and count only, never question text) that open questions exist, so it can offer to show them; this adds no wake and no instruction. A `DECISION` report is a one-off message in the report format; `peers_decision` queues a question that survives restarts and is shown together with the others.

Known limits: delivery is attempted once per `answer` or `retry`; two master-side commands racing on the same answer can deliver it twice. A delivered message is ordinary peer text, so a session that ignores it still shows the decision as `delivered`; `delivered` means accepted, not acted on. Do not publish `inbox.json`: it contains your questions and answers.
