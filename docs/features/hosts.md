# Multi-host peers

An opt-in way to list and message sessions on **another machine you control**, over your own `ssh`. Local-only operation stays the default: with no host configured, nothing is started, nothing listens and nothing connects.

This is deliberately small. It sends one informational message to one named remote session, or lists remote sessions. It cannot prompt, control, pause, resume, abort, rename, change settings of, read the transcript of, or forward anything for a remote session. There is no daemon, no listening port, no discovery and no background connection.

## Commands

```text
/peers hosts add <name> <ssh>          configure a host (master only; nothing is contacted)
/peers hosts remove <name>             delete it and its pin at once (master only)
/peers hosts list                      configured hosts, pinned host id, breaker state, last outcome (read-only, no ssh)
/peers hosts status [name]             the same in detail, plus requests in the last hour (read-only, no ssh)
/peers hosts test <name>               one handshake; pins the host id the first time (master only)
/peers hosts pin <name>                handshake and re-pin the host id, after you verified it (master only)
/peers hosts sessions <name>           list the remote sessions (read-only on the remote)
/peers hosts msg <name>:<peer-id> <text>   send one message to one remote session
```

- `<name>` is a local label: 1-24 characters `a-z`, `0-9`, `-`. At most 16 hosts.
- `<ssh>` is an ssh config alias or `user@host`: letters, digits, `.`, `_`, `-` (and `+` in the user part, `:` in the host part), at most 255 characters, never starting with `-`, no spaces, control characters or shell characters. It becomes exactly one argument after `--`; no option is ever taken from the configuration. Host name, port, identity file, proxy and so on belong in your own `~/.ssh/config` alias, which this plugin never reads.
- A remote session is addressed `<host-name>:<peer-id>` and shown as `<host-name>:<name> (<peer-id>)`. The peer id is the remote session's own stable id (the id `/peers list` shows there).
- `sessions` and `msg` refuse a host whose host id is not pinned yet (run `test` first).
- `list`, `status`, `sessions` and `msg` work in any main session; `add`, `remove`, `test` and `pin` are master only (run `/peers master` first). A subagent that shares the extension cannot run any `/peers hosts` command (`/peers hosts runs only in a main session`). There is no LLM tool and no `peers_control` or `peers_send` integration: only a user typing a command in a main session makes a request.

What `sessions` shows per remote session is exactly: peer id, display name (control characters removed, `"`, `[`, `]` replaced by `'`, at most 40 bytes), and the flags `busy`, `paused` and `refuses` (the remote session refuses inbound requests). The credential screen runs on the **whole** name before it is cut to 40 bytes, on the raw text and on the fully cleaned text (cleaning turns `[` and `]` into `'`, which can complete a pattern like `[token]=...`), so a secret that straddles the cut (for example a URL with embedded credentials) is caught; such a name is shown as `[withheld]`, and a name that is already `[withheld]` stays `[withheld]`. The bridge screens it and the local side screens it again. Unknown stays unknown: a flag the remote does not publish is not shown. At most 64 sessions are listed. Never the working directory, socket path, process id, instance id, model, effort, subagent text, context usage or session id. The remote bridge enforces this list and the local side validates and caps it again.

What `msg` sends: your text (at most 4000 bytes, counted in bytes), your session's stable id and display name (so the receiver can show who it came from), a request id, a timestamp and the label of your machine. Text that looks like a credential is not sent. Text containing a header the receiving session puts on messages it delivers is refused: the words `Message from peer session` in order, or the events delivery prefix `[external event`. It is refused however it is dressed: any case, spacing, punctuation; zero-width, soft-hyphen or other format characters; full-width forms, accents, Cyrillic/Greek look-alike letters and dotless/dotted i; markdown or HTML that renders to the words (`p[e]()er`, `[peer](url)`, `pe<i></i>er`); and stray brackets anywhere inside or between them (`[Mes[sage from peer session`). The check runs on folded copies using the events feature's shared fold; the text actually sent is always your original. The four header words are matched whole, so identifiers such as `message_from_peer_session_count` or `messageFromPeerSession`, other word orders and ordinary prose are allowed (prose that does contain the four words in a row is refused too); plain `external event` without the bracket is allowed. The refusal exists so a received message is never relayed onward: locally by `msg`, again by the remote bridge (`relayed message refused`) and a third time by the receiving session. Your own session name goes out through the same credential screen as listed names: if the whole name looks like a credential it is sent as `[withheld]`. Whitespace in the text is collapsed to single spaces, as for `/peers msg`.

## Setup

You need the plugin on both machines (the remote needs `scripts/omp-peers-remote.ts` and `bun`; `@oh-my-pi/pi-natives` must resolve from the plugin directory, as it does for the plugin itself) and a user account on the remote that runs the OMP sessions you want to reach. Everything below is your configuration; the plugin never edits it.

1. **A dedicated key on the local machine** (do not reuse a login key):

   ```text
   ssh-keygen -t ed25519 -f <path-to-new-key> -C peers-bridge
   ```

2. **An ssh config alias** in your own `~/.ssh/config`, so options stay yours:

   ```text
   Host ops-box
       HostName <address of the remote machine>
       User <remote user>
       IdentityFile <path-to-new-key>
       IdentitiesOnly yes
   ```

3. **Restrict the key on the remote** in the remote user's `authorized_keys`, one line, so the key can run only the bridge and nothing else:

   ```text
   command="bun /path/to/omp-peers/scripts/omp-peers-remote.ts",restrict ssh-ed25519 AAAA... peers-bridge
   ```

   `command="..."` makes sshd run only the bridge whatever the client asks for. The client always sends the one fixed command word `omp-peers-remote`; with the forced command sshd ignores it (it is only passed to the bridge in `SSH_ORIGINAL_COMMAND`, which the bridge never reads), so the word in the `authorized_keys` line and the word the client sends need not match. If you use a key without the forced command, the remote shell would try to run a program called `omp-peers-remote` and fail: harmless, and a sign the key is not restricted. `restrict` turns off port, agent and X11 forwarding, pty allocation and `~/.ssh/rc` for the key. Use the absolute path of `bun` and of the script (sshd's forced command has a minimal `PATH`). You may add `from="<pattern>"` to limit where the key can be used from. Without the `command="..."` restriction the key is a normal login key and the bridge is not enforced: do not use such a key here.

4. **Trust the remote host key yourself.** The plugin runs ssh with `StrictHostKeyChecking=yes`, so the host key must already be in your `known_hosts`. Connect once by hand with `ssh -T ops-box < /dev/null` (the bridge answers with a JSON `bad request` error, which is fine) and check the fingerprint ssh shows against one you obtained from the remote machine by another route before you accept it.

5. **Configure and pin:**

   ```text
   /peers hosts add ops ops-box
   /peers hosts test ops
   /peers hosts sessions ops
   /peers hosts msg ops:<peer-id> please summarise the failing test
   ```

   `test` shows the remote bridge's host id and bridge version and pins the host id. To double-check the pin out of band, read `host-id.json` in the remote `~/.omp/agent/peer-state/`.

## Trust model

| Question | Answered by | Where it lives |
| --- | --- | --- |
| Am I talking to the right machine? (destination authentication) | The ssh host key, checked against **your** `known_hosts` (`StrictHostKeyChecking=yes`, `UpdateHostKeys=no`: the plugin never adds or changes a host key). | Your `known_hosts` |
| Is this machine allowed to talk to the remote? (peer authentication) | Your ssh key or agent, accepted by the remote's `authorized_keys`, restricted to the bridge by `command="..."` and `restrict`. | Your keys, the remote `authorized_keys` |
| Did the destination change? | The host id pin (below). | `hosts.json` |
| Is the request genuine and intact? | The ssh channel (encrypted, integrity protected). The request is **not** separately signed. | ssh |

The plugin stores **no** key, password, passphrase, agent socket or host key, never prompts (`BatchMode=yes`) and never reads an ssh private key or `known_hosts`. ssh gets only `HOME`, `PATH`, `USER`, `LOGNAME` and `SSH_AUTH_SOCK` from the environment (plus `LC_ALL=C`); no API key or session variable is passed. Your agent can sign for the connection as it can for any ssh command; agent forwarding is off.

**Host id pin.** Each machine has a random 16-hex `hostId`, created once in `peer-state/host-id.json` (0600). It is a label, **not a secret** and not authentication: it lets a peer notice that the destination behind an alias changed (a repointed alias, a rebuilt machine, a different account). `test` pins the first host id it sees; every later request carries it as `expect` and the bridge refuses before acting when it differs, and the local side refuses a reply whose host id differs: `host identity changed: refused; re-pin with hosts pin <name> after verifying`. Only `pin` (master only) replaces a pin, and only after you verified the change.

**Sender identities are claims.** A message arrives with sender id `host-<8 hex>:<sender's stable id>`: the label is derived from the claimed host id, and the receiving session shows the message as `[Message from peer session "<name>" (<label>:<id>), a REMOTE host (identity not verified by this session) — not from the user]`. The receiver cannot verify that the sender id is real; it knows only that the sender holds a key your `authorized_keys` accepts.

**Replying.** A remote-origin message tells the receiving agent not to answer with `peers_send` (which cannot reach another machine, and whose name or id could match a different local session) and to tell its user instead. Replies go only through the user command `/peers hosts msg <host-name>:<peer-id> <text>` typed on the replying machine, with its own host configuration.

## What a remote message can and cannot do

The bridge accepts exactly three operations: `hello` (identify), `list` (the list above) and `message`. Anything else (`prompt`, `abort`, `compact`, `model`, `effort`, `setting`, `rename`, `shutdown`, `pause`, `resume`, `tail`, `status`, `subagents`, any future or unknown name) is refused with the fixed error `operation not allowed` **before** any state is read or any session is contacted. Cross-host control is out of scope.

A `message` is delivered to the remote session through its ordinary inbound path, and **that session's own rules apply exactly as for a local sender**: a paused session answers `not delivered: <host>:<id> is paused; resend after its user resumes it` and is not woken, a session that refuses inbound requests refuses, a control lock does not block plain messages (as locally), and the receiver's rate limit applies (all remote senders share one budget of 20 messages a minute, because their ids are only claims). Like any peer message it can start a model turn on the remote and use that machine's provider quota.

A remote-origin message is informational only. It carries `origin: "remote"` and `hops: 1`; the receiving session refuses a remote message that is a report, a dependency trigger, a subagent report or a control request, so it can never feed the board, inbox, dependency or watchdog features and never acts on behalf of a parent. The body of a message is untrusted text like any peer message.

Outcomes you can see for `msg`: `delivered to <host>:<id>`; `not delivered: ... is paused ...`; `... refuses inbound requests`; `... is rate limited; try again later`; `... is not running`; `... could not be reached on its host`; `... did not accept the message`; `not delivered: bridge refused: <fixed reason>`; `<host>:<id>: unknown outcome, not retried (<reason>)`; `not sent: ...`.

## Replay and relay loops

Every request is `{ v: 1, id, ts, hops: 0, origin: { hostId, name }, op, ... }`. The bridge refuses a request with a different `v`, with `hops` other than `0`, with unknown keys or a malformed field, larger than 64 KiB (read with a hard limit and a 5 second deadline; one line only), whose timestamp is more than 5 minutes from its clock (exactly 5 minutes is accepted), or whose id it has already accepted. An id is remembered for 10 minutes counted from the later of the time it arrived and its own timestamp, so a request stamped up to 5 minutes in the future cannot be replayed after the cache forgot it while its timestamp is still accepted (the remembered window always outlasts the 5 minute skew window). The replay cache is `peer-state/hosts-replay.json` on the remote, updated atomically under the state lock, so of several simultaneous requests with one id exactly one is accepted. It holds at most 2000 ids; when full it refuses new ids (`replay cache full`) until entries expire, rather than forgetting old ones.

The bridge never calls out to any other host, never reads the local `hosts.json` and delivers to local sessions only; messages it delivers carry `hops: 1`, which no feature relays, and `hosts msg` refuses text that is itself a peer message. A request that has already crossed a bridge cannot be forwarded: nothing in the plugin sends one.

The envelope is not signed. Replay protection defends only against a duplicating or compromised channel within the 10-minute window; integrity and authenticity come from the ssh channel.

## Reconnect behaviour

There is none in the background. Every request is one `ssh` subprocess started by your command and ended by it:

- hard timeout 20 seconds (the whole process group is killed); stdout is capped at 256 KiB (more is `bridge protocol error`), stderr at 4 KiB and **never shown**: failures map to fixed texts only: `ssh failed (exit N)`, `host key verification failed`, `permission denied`, `timeout`, `bridge protocol error`, `bridge refused: <fixed reason>`;
- at most 2 attempts per command with a 2 second pause, only for transport failures; host key and permission failures are never retried; a `message` is retried only when the failure proves nothing was sent (could not resolve, connection refused, no route, connect timeout). A timeout or exit after the request may have been sent is reported as `unknown outcome, not retried` and you decide whether to resend;
- circuit breaker per host: 3 consecutive transport failures put the host in `cooling` for 5 minutes (`not sent: host cooling down until <time>`); after that one request is allowed as a probe, and one more failure cools it again; any well-formed bridge answer, even a refusal, resets the count;
- at most 20 requests per host per hour (`not sent: rate limit reached (20 requests per hour) for host <name>`); every attempt counts.

Breaker, rate and last-outcome state is in `peer-state/hosts-runtime.json` (0600), shared by all your sessions. If it cannot be read the request is not sent.

## Revocation and incident procedure

- **Stop using a host locally:** `/peers hosts remove <name>` deletes it and its pin at once; no later command can reach it.
- **Revoke on the remote:** delete the key's line from the remote `authorized_keys`. That is the real revocation: it works even if the local machine is lost. Optionally also delete `peer-state/host-id.json`, which changes the remote's host id (every peer will then refuse it until re-pinned).
- **If a key may have leaked:** remove the `authorized_keys` line on every remote first, then remove the hosts locally, generate a new key, and re-add. While the line existed the key holder could list sessions (limited fields) and send informational messages to any session, subject to its pause and refusal rules, at up to the receivers' rate limits.
- **If a destination may be impersonated:** do not accept a changed host key; fix `known_hosts` yourself. A changed host id is refused until you `pin` after verifying it.
- The bridge keeps no access log. Use sshd's own logs; the replay cache shows only the ids of the last 10 minutes.

## Exact limits and caveats

- 16 hosts; ssh target at most 255 characters; message text at most 4000 bytes; names 40 bytes; 64 sessions listed; request 64 KiB; reply 256 KiB; 20 s per request; 2 attempts; 20 requests per host per hour; replay cache 2000 ids / 10 minutes; clock skew 5 minutes (a larger skew between the machines makes every request fail with `stale or future timestamp`).
- Only the operations `hello`, `list`, `message`. No transcripts, histories, files, cwd or credentials are ever transmitted; only the fields named above.
- The envelope is not signed and there is no encryption of its own: the ssh channel provides both. If ssh is compromised, so is this.
- A holder of the restricted key can fill the replay cache (2000 requests in 10 minutes) and make the bridge refuse new requests until entries expire, and can send messages that start model turns on the remote. The key is meant to be used only by you; keep it dedicated.
- A paused session is not woken by a remote message, but a message is not queued either: resend after resume.
- The remote bridge runs as the user who owns the sessions; anything that can run as that user can read the same state. This is a coordination feature between cooperating sessions, not a security boundary against a local attacker.
- The plugin adds ssh options of its own beyond the minimum: `UpdateHostKeys=no`, `ControlMaster=no` and `ControlPath=none` (one process per request, no persistent connection, `known_hosts` never rewritten). Your ssh config still applies otherwise, including `ProxyCommand`/`ProxyJump`: those run what you configured.
- `hosts.json`, `hosts-runtime.json` and `host-id.json` are private (directory 0700, files 0600, atomic replace, symlinks and non-regular files refused). A tampered or unreadable one makes every command fail closed with an error and nothing is overwritten.
- Only POSIX systems are covered (process groups, unix sockets, file modes); Windows is untested and not supported.

## Which `ssh` runs, and the test seam

The `ssh` client is the first executable `ssh` in the absolute entries of the `PATH` the plugin saw when it loaded; relative and empty entries are ignored, and the result is cached as an absolute path for the life of the process. **Nothing else can substitute it**: no environment variable, configuration value, command argument or remote reply names the client (an earlier `OMP_PEERS_SSH_BIN` override was removed because an inherited variable could have redirected a credential-carrying channel; it is now ignored, and a test proves that). Changing `PATH` after OMP started has no effect; restart the session. Put the `ssh` you trust first on the `PATH` OMP is started with.

Unit tests pin a fake client through the exported `setSshBinForTests()` in `lib/features/hosts.ts`; nothing in production code calls it. The end-to-end tests and the real-OMP scenario instead put a script named `ssh` first on the `PATH` of the process under test (a normal, user-controlled mechanism); the scenario also removes every other `ssh` from that `PATH`.

## Files

Local and remote, under `~/.omp/agent/peer-state/`: `hosts.json` (name, ssh target, pinned host id), `hosts-runtime.json` (breaker, request times, last fixed outcome text), `host-id.json` (this machine's label), and on the remote `hosts-replay.json`. None contains a key, password, passphrase, message text, transcript or `known_hosts` data. Message text is not stored anywhere by this feature.
