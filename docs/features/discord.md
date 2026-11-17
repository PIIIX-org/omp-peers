# Discord bridge

An optional, opt-in bridge that posts the structured reports the master session accepts to one Discord channel, and (separately, off by default) lets a short list of Discord users run three read-only commands. Nothing is configured, stored, polled or sent until you set it up and run `/peers discord on`. Ordinary plugin use never touches Discord.

It uses only documented Discord HTTP APIs: an **incoming webhook**, or a **bot account** with the `Bot` token scheme. It never automates a user account (a user-account token is unsupported and forbidden; see [Credentials](#credentials)), never opens the Discord gateway (websocket) and never scrapes anything.

## Commands

```text
/peers discord status
/peers discord log
/peers discord on | off
/peers discord test
/peers discord clear-queue
/peers discord set webhook-file <absolute path> | none
/peers discord set bot-token-file <absolute path> | none
/peers discord set channel <channel id> | none
/peers discord set include-names on | off
/peers discord set rate-limit <1-120>
/peers discord set inbound on | off
/peers discord set inbound-users <user id>... | none
```

`on`, `set`, `test` and `clear-queue` are master only (`/peers master` first). `status` and `log` are read-only and work in any session. **`off` works in any session**: stopping is never gated.

- `status` and `log` only read the state file (they never post or write). `status` shows the mode, the credential file path and whether it is readable (for a webhook `…/webhooks/<id>/<redacted>`), the queue, counts, the circuit breaker and the role. `log` shows the last 20 events (sent, retry, failed, dropped, breaker, stop) with no message content.
- `test` posts exactly one fixed message, `omp-peers bridge test`, right now, only when you run it in the master session. It is refused (`not delivered: <reason>; nothing was sent`) while the bridge is off, while the circuit breaker is open, when another send is in progress or when the hourly rate limit is reached; its request counts toward the rate limit and a failed test is reported (`not delivered: http 500`) and not retried.
- `clear-queue` discards the queued messages and leaves the bridge on. `off` discards them too.

## Threat model

| Concern | What the bridge does |
| --- | --- |
| A leaked credential posts or reads as you | The webhook URL or bot token lives in a file **you** keep outside the repository (mode 0600, owned by you). The plugin stores only the file's path, reads the file when it needs the credential and never keeps, logs, echoes, queues or writes it. Revoke it in Discord to cut access completely. |
| Private data in a post | A post is built from a fixed template and a few structured report fields. It never contains a transcript, prompt, tool output, cwd, reference list or session content. Fields are screened for credentials, links and absolute paths, and mentions and markdown are neutralised. See [What is sent](#what-is-sent). |
| A post pings people | Every request carries `"allowed_mentions": {"parse": []}`, and `@`/`<` are neutralised in the text as a second layer. Nothing can ping a user, role or `@everyone`. |
| Discord is used to control sessions | Inbound is a separate switch, off even when the bridge is on, bot mode only, and limited to `status`, `list` and `help`. No command can prompt, message, dispatch, pause, resume, approve, lock, rename or change any setting, so it cannot bypass pause, lock, refuse, master or acceptance rules. |
| A stranger posts commands in the channel | Only message authors on an explicit allowlist of at most 8 user ids are heard. Bots, webhooks and everyone else are ignored without a reply. An empty allowlist accepts nothing. |
| Loops and floods | The bridge never forwards anything that came from Discord (replies are not reports) and never reports its own notices. Queue, rate, retries, backoff, timeouts, response size, poll rate and per-user command rate are all bounded; see [Exact limits](#exact-limits). |
| A redirect or look-alike host steals the credential | A webhook URL must match `https://discord.com/api/webhooks/<id>/<token>` (or `discordapp.com`) exactly: no other host, no `http`, no userinfo, port, query, fragment or extra path. Redirects are never followed: a 3xx is a failure. |
| A wrong or revoked credential keeps retrying | HTTP 401/403 stops the bridge, discards the queue and shows `auth failed: bridge stopped`. Five consecutive failures open a circuit breaker for 30 minutes. |
| Another local program changes the settings | The state file is private (directory 0700, file 0600). A secret file must be owned by you with no group or other bits, must not be a symlink or a FIFO, and must be outside the plugin directory. Anything that can run as you can read your credential file anyway: this is not a defence against a hostile same-user process. |

Sender identity in a report (`from`) is a claim made by the sending session, not an authenticated fact; the post says so by showing the id exactly as claimed (and `?` when it is not a well-formed session id).

## Setup

### Option A: webhook (post only; the simplest and least powerful)

1. In Discord: Server Settings, Integrations, Webhooks, New Webhook. Pick **one channel** and copy the webhook URL. Anyone who has the URL can post to that channel, so treat it like a password.
2. Save the URL, and nothing else, in a private file outside the repository, for example:

   ```text
   umask 077; mkdir -p ~/.config/omp-peers-discord; printf '%s\n' '<paste the webhook URL>' > ~/.config/omp-peers-discord/webhook
   ```

   The file must be 0600 (or stricter) and owned by you.
3. In the master session:

   ```text
   /peers master
   /peers discord set webhook-file /absolute/path/to/webhook
   /peers discord on
   /peers discord test
   ```

A webhook cannot read messages, so inbound is not available in webhook mode.

### Option B: bot (post, and optionally read the channel for inbound commands)

1. Discord Developer Portal: New Application, Bot. Copy the bot token once (Reset Token if you lost it) into a private 0600 file outside the repository as above. Turn **Public Bot off**. Leave every privileged intent off unless you want inbound commands (see below).
2. Add the bot to your server with the OAuth2 URL generator, scope `bot` only, and **no permissions** (permissions 0). Then, in the one channel you chose, give the bot's role exactly these channel-level permissions:
   - **View Channel** and **Send Messages** (outbound);
   - **Read Message History**, only if you enable inbound.

   Do **not** grant Administrator, any Manage permission, Mention Everyone, Embed Links, Attach Files, or any server-wide permission. The bridge sends plain text only and never mentions anyone, so it needs nothing else.
3. In the master session:

   ```text
   /peers master
   /peers discord set bot-token-file /absolute/path/to/bot-token
   /peers discord set channel <channel id>
   /peers discord on
   /peers discord test
   ```

   (Developer Mode, then right-click the channel, Copy Channel ID.)

### Inbound commands (optional, bot mode only)

```text
/peers discord set inbound-users <your user id> [<another user id> ...]
/peers discord set inbound on
```

Users in the allowlist can then type, in the configured channel:

| Command | Reply |
| --- | --- |
| `!peers status` | `discord bridge: on; mode bot; queued N; requests in last hour N/LIMIT; breaker closed` |
| `!peers list` | up to 10 live sessions: id (and name only if `include-names` is on), `busy`/`idle`/`unknown`, `paused`; then `… N more` |
| `!peers help` | `read-only commands: !peers status, !peers list, !peers help` |
| anything else | `unknown command; try !peers help` |

The command must be exactly `!peers <word>`: the prefix `!peers ` with one space, one word, no arguments, at most 200 bytes in total. Longer messages, other prefixes, and messages from anyone not on the allowlist (or from a bot or webhook) are ignored. Replies go through the same outbound path as reports: same redaction, same queue, same rate limit.

How it listens: the master polls `GET /channels/<id>/messages` every 15 seconds (no gateway). The first poll after `inbound on` only records the newest message id and runs nothing, so history is never executed. The id of the last examined message is persisted, so a message is never executed twice, also across restarts and across `off` and `on`. A command older than 5 minutes (by its message id's timestamp) or more than 60 seconds in the future is skipped, so a long outage or an `off` period never replays old commands. Switching `inbound` off, or changing the channel, forgets the position (the next poll records it afresh).

**Message content.** Discord withholds the `content` of messages (REST as well as gateway) from bots that do not have the privileged **Message Content intent**, except messages that mention the bot, direct messages and the bot's own messages. To make `!peers ...` visible you must turn on **Message Content Intent** for the bot in the Developer Portal (Bot, Privileged Gateway Intents). The bridge does not use the gateway, so no gateway connection is made, but the portal setting is what governs the REST `content` field. **This could not be verified against real Discord here**: if inbound commands never answer, check this setting first. A message that mentions the bot starts with `<@id>` and therefore does not match the `!peers ` prefix, so mentions do not work as commands.

## What is sent

Reports only: when a structured report (`/peers report`, or `peers_send` with `report`) reaches the master and the master accepts it, one post is queued:

```text
**<KIND>** <session id>: <unit>: <detail>
```

`KIND` is `DONE`, `BLOCKED`, `WAITING` or `DECISION`. `detail` is the DONE evidence description, the BLOCKED blocker, the WAITING next action or the DECISION question. DONE references, background flags and every other field are not sent. With `set include-names on` the session name, as the session claims it (cut to 40 bytes, same screen), appears before the id: `**DONE** worker-a (p…): …`. The default is ids only.

The text after the id (unit and detail together) goes through, in order:

1. ANSI escape sequences and control, format and line-separator characters become spaces; whitespace collapses to one line.
2. If anything looks like a credential (the shared patterns, a Discord bot-token shape, a Discord webhook URL) the whole field becomes `(withheld)`.
3. URLs (`scheme://…`, `www.…`, `discord.com/…`, `discord.gg/…`) become `(link removed)`; absolute paths (`/…`, `~/…`, `C:\…`, `\\host\…`) become `(path removed)`. Relative paths such as `src/app.ts` and bare domain names are not detected and stay.
4. `@` and `<` are followed by a zero-width space (so `@everyone`, `@here`, `<@id>`, `<@&id>`, `<#id>`, `<t:…>`, `</cmd:…>` and custom emoji cannot take effect) and the markdown characters `\ * _ ~ ` | > [ ]` are backslash-escaped.
5. The result is cut to 300 bytes (`Buffer.byteLength`, never inside a character or an escape pair, an ellipsis `…` included).

Reports are bridged only when the **master** accepts them: a report sent to another session is not seen, a report to a paused master is refused by the pause gate before the bridge sees it (nothing is woken), and a report from a subagent never reaches any feature. A report is posted once per acceptance; the bridge does not deduplicate two identical reports sent separately. Digest and watchdog alerts are separate features and are **not** forwarded (a limitation).

The bridge sends nothing to any session and never causes a model turn.

## Credentials

- Keep the webhook URL or bot token in a file outside the repository and outside the plugin directory (a path inside the plugin directory is refused). The file must be a regular file owned by you, mode 0600 or stricter, not a symlink (the final path component is never followed), 16 to 256 bytes after one trailing newline is removed. A FIFO or other special file is refused without blocking.
- **Limits of the file check.** It inspects the opened file only. It does not check the parent directories: a symlink in a parent directory (for example a link to another location) is followed, and a directory that others can write to would let them replace the file between checks. It does not detect a hard link: a second name for the same inode, in a place other people can read, exposes the same content. Keep the file in a directory only you can write to, created by you, and do not hard-link it.
- Only the **path** is stored in `peer-state/discord.json`. `status` shows the path and, for a webhook, `…/webhooks/<id>/<redacted>`; the token is shown nowhere: not in state, the log, command output, notices or any file.
- The credential is read when a request is made, so rotating it is replacing the file. A file that becomes unreadable, wrong-shaped or too permissive makes the request fail (and count toward the breaker) without sending anything.
- **Bot tokens only.** The bot request uses `Authorization: Bot <token>`. A user-account token (self-botting) violates Discord's terms, is unsupported, and the bridge cannot detect one: do not use it. The `Bot` scheme makes Discord reject a user token.
- A wrong or revoked credential (HTTP 401 or 403) stops the bridge.

## Stop procedure

1. `/peers discord off` (any session). Sending and polling stop at once and queued messages are discarded; the inbound position is kept.
2. Delete the credential file.
3. Revoke or rotate the credential in Discord: delete the webhook (Server Settings, Integrations, Webhooks), or reset the bot token / remove the bot from the server. Only this makes access impossible for anything that copied the file.
4. Optionally delete `~/.omp/agent/peer-state/discord.json` (it holds paths, ids and a short log, no secrets).

The bridge also stops itself on HTTP 401/403 and pauses for 30 minutes after 5 consecutive failures.

## Exact limits

| Limit | Value |
| --- | --- |
| Queue | 100 messages; when full the oldest unclaimed one is dropped and counted (`dropped` in `status`) |
| Request rate | `rate-limit` requests per rolling hour, default 30, allowed 1 to 120; every request counts, retries and `test` included |
| Sending | at most one request per 5 s tick, one message per request |
| Timeout | 10 s per request; responses over 512 KiB are a failure; redirects never followed |
| Attempts | 4 per message (the first plus 3 retries) |
| Backoff | 30 s, 2 min, 10 min after attempts 1, 2, 3 |
| 5xx, network error, timeout | retried on the schedule above |
| HTTP 429 | waits `Retry-After` (header or `retry_after` in the body; without a usable value the backoff step for that attempt), at least 1 s, at most 10 min; counts as an attempt. **All sending and polling stop for that wait**, not only the message that was refused (`status` shows `discord rate-limit hold`); `on` clears it |
| 4xx other than 401/403/429, 3xx | the message is dropped and logged as `failed: http <code>`; no retry |
| 401, 403 | bridge stops (`auth failed: bridge stopped`), queue discarded |
| Circuit breaker | 5 consecutive failed requests (sends and polls) pause all requests for 30 min and show a notice; a success resets the count |
| Message text | summary 300 bytes, name 40 bytes, whole post well under Discord's 2000-character limit |
| Poll | every 15 s, 20 messages per request, bot mode with inbound on only |
| Inbound commands | 3 (`status`, `list`, `help`); 200 bytes per message; 6 per user per minute (extra ones are ignored without a reply); allowlist of at most 8 users; commands older than 5 min or more than 60 s in the future skipped |
| `list` | 10 sessions, then `… N more` |
| Log | last 20 entries (`/peers discord log`), no message content |

A crash between starting a request and recording its result can make the next process send that one message again after its 30 s lease expires (delivery is at least once). A message whose 4 attempts have all been started is never started again: if the 4th attempt never reported back (crash, handoff) the message is dropped, counted in `dropped` and logged as `gave up after 4 attempts (no result recorded)`.

## Concurrency

One cross-process-locked state file. A send or poll is claimed under the lock before any network request, so two processes ticking at once (for example during a master handover) send each message once and poll once per interval. Only the master ticks.

## Test-only seam

The Discord endpoint is fixed: `https://discord.com/api/v10` for a bot, and the host of the validated webhook URL for a webhook. **No environment variable, setting, command, tool or remote operation changes it**, so a credential cannot be redirected by what a session inherits or by anything configured at run time (setting `OMP_PEERS_DISCORD_API_BASE` has no effect; a test proves it).

The plugin's own tests replace the endpoint through code, not configuration: unit tests inject a fake HTTP client, and the real-OMP scenario starts its master with an extra, test-only extension (`tests/scenarios/_discord_endpoint_ext.ts`, not shipped) that calls the module's exported `setTestEndpoint`. That function accepts exactly `http://127.0.0.1:<port>` (anything else throws) and the value is re-validated on every read. Only code running inside the OMP process can call it, which already has everything the plugin has. The scenario also points `HTTPS_PROXY` at a closed port so that any request missing the fake server fails closed.

## What this does not do

- No gateway/websocket, slash commands, buttons, reactions, embeds, attachments, threads, DMs or voice.
- No user-account automation, no multiple channels or servers, no per-user permissions beyond the allowlist.
- No inbound command can change anything; to act on sessions use the normal peer controls in OMP.
- Digest and watchdog alerts, transcripts and prompts are never posted.
- Behaviour against real Discord (Message Content visibility over REST, `Retry-After` shapes, the `after` paging order of the messages endpoint) is based on Discord's documentation as understood here and was tested only against a local fake server.
