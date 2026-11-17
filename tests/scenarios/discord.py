# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (c) 2026 PIIIX-org contributors
"""/peers discord through two real OMP processes and a fake Discord on 127.0.0.1 (never the real network).

The plugin has no endpoint override: the master is started with an extra, test-only extension (`-e _discord_endpoint_ext.ts`) that
imports the plugin's own module and calls its test setter with http://127.0.0.1:<port> (so the module instance is shared with the
plugin: a post reaching the fake server proves it). Every credential is a fake
value written into a private file under the disposable home. Checks: off by default, bot and webhook posting with exact
bodies and headers, redaction, empty allowed_mentions, no resend, a subagent report never bridged, no credential in any
file or output, read-only inbound commands from an allowlisted user only (a prompt command reaches no session), a 401
stopping the bridge, and `off` stopping all traffic.

Time is the 5 s bridge tick (one post per tick) and the 15 s poll interval, so the scenario overlaps them instead of sleeping: the
peers start together, negative checks use state and one exact ledger of every post instead of fixed sleeps, `off` then `on` makes the
first poll after the baseline immediate (the cursor is kept), and a 401 is provoked with `test`, which posts synchronously.
"""
import json
import os
import socket
import stat
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from smoke import wait_for

DISCORD_EPOCH = 1420070400000
CHANNEL = "111111111111111111"
USER = "222222222222222222"
STRANGER = "333333333333333333"
WEBHOOK_ID = "987654321098765432"
WEBHOOK_TOKEN = "wh" * 8 + "-TESTONLY-" + "x" * 20
BOT_TOKEN = ".".join(["MTIzNDU2Nzg5MDEyMzQ1Njc4", "Gx0abc", "fake" * 8])
DENIED = "error: only the master session may change or run the Discord bridge; run /peers master first"
UNKNOWN = "unknown command; try !peers help"
HELP = "read-only commands: !peers status, !peers list, !peers help"
FIXED_TEST = "omp-peers bridge test"


class FakeDiscord:
    """Records every request; answers like the Discord endpoints this plugin uses."""

    def __init__(self):
        self.requests = []
        self.messages = []
        self.post_status = 200
        self.counter = 0
        self.lock = threading.Lock()
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def record(self, body):
                with fake.lock:
                    fake.requests.append({"method": self.command, "path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()},
                                          "body": body})

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", "0"))).decode()
                self.record(body)
                self.send_response(fake.post_status)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

            def do_GET(self):
                self.record("")
                path, _, query = self.path.partition("?")
                params = dict(part.split("=", 1) for part in query.split("&") if "=" in part)
                with fake.lock:
                    messages = sorted(fake.messages, key=lambda m: int(m["id"]))
                    if "after" in params:
                        messages = [m for m in messages if int(m["id"]) > int(params["after"])][:int(params["limit"])]
                    else:
                        messages = messages[-int(params["limit"]):]
                payload = json.dumps(list(reversed(messages))).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()

    def say(self, author, content, bot=False):
        with self.lock:
            self.counter += 1
            ms = int(time.time() * 1000)
            message = {"id": str(((ms - DISCORD_EPOCH) << 22) | self.counter), "content": content,
                       "author": {"id": author, **({"bot": True} if bot else {})}}
            self.messages.append(message)
        return message

    def posts(self):
        with self.lock:
            return [r for r in self.requests if r["method"] == "POST"]

    def gets(self):
        with self.lock:
            return [r for r in self.requests if r["method"] == "GET"]

    def close(self):
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def rpc(row, request):
    """Speak the peer socket protocol directly, as any other sender would."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
        conn.settimeout(10)
        conn.connect(row["sock"])
        conn.sendall(json.dumps(request).encode() + b"\n")
        data = b""
        while not data.endswith(b"\n"):
            chunk = conn.recv(65536)
            assert chunk, "peer closed without a reply"
            data += chunk
    return json.loads(data)


def run(h):
    discord = FakeDiscord()
    try:
        scenario(h, discord)
    finally:
        discord.close()


def scenario(h, discord):
    ext = Path(__file__).resolve().parent / "_discord_endpoint_ext.ts"
    # HTTPS_PROXY points at a closed port: a request that missed the fake server (https goes to the proxy) fails closed instead of reaching the real Discord.
    env = {"OMP_PEERS_SCENARIO_DISCORD_ORIGIN": f"http://127.0.0.1:{discord.port}", "HTTPS_PROXY": "http://127.0.0.1:1"}
    with ThreadPoolExecutor(2) as pool:  # two OMP processes take seconds each to start: start them together
        starting = [pool.submit(h.start, env=env, args=["-e", str(ext)]), pool.submit(h.start)]
        master, worker = [f.result() for f in starting]
    master_row, worker_row = h.row(master), h.row(worker)
    mid, wid = master_row["id"], worker_row["id"]
    state_file = h.state / "discord.json"
    secrets = h.root / "secrets"
    secrets.mkdir(mode=0o700)

    def write_secret(name, content, mode=0o600):
        file = secrets / name
        file.write_text(content + "\n")
        file.chmod(mode)
        return file

    def state():
        return json.loads(state_file.read_text())

    def contents():
        """The text of every post the fake Discord received, in order: the ledger every phase is checked against."""
        return [json.loads(p["body"])["content"] for p in discord.posts()]

    def report(unit, description, sender=worker):
        body = {"kind": "DONE", "unit": unit, "evidence": {"description": description}}
        sent = h.say(sender, f"/peers report {mid} " + json.dumps(body))
        assert sent.endswith(f"({mid}): ok"), sent

    def settle_master():
        """A report makes the master take a model turn; wait until it is idle again."""
        wait_for(lambda: h.row(master).get("busy") is False, seconds=30)

    def notices(peer, command, count):
        """Run a slash command and return its first `count` notification texts (a stop notice and the command's own reply are separate)."""
        start = len(peer.frames)
        peer.call("prompt", message=command)
        found = wait_for(lambda: [f for f in peer.frames[start:] if f.get("method") == "notify"]
                         if len([f for f in peer.frames[start:] if f.get("method") == "notify"]) >= count else None)
        assert not any(f.get("type") == "agent_start" for f in peer.frames[start:]), command
        return [f["message"] for f in found][:count]

    def one_tick_passed(peer):
        """Wait for the periodic 5 s refresh (which runs the bridge tick right after it) to publish again, once the session is quiet."""
        settle_master()
        time.sleep(0.3)
        seen = h.row(peer)["updatedAt"]
        wait_for(lambda: h.row(peer)["updatedAt"] != seen, seconds=15)
        time.sleep(0.5)

    assert h.say(master, "/peers master")

    # ---- Off by default ----------------------------------------------------------------------------------
    status = h.say(master, "/peers discord status")
    assert status.splitlines()[0] == "discord bridge: off (opt-in; /peers discord on enables it)", status
    assert h.say(worker, "/peers discord on") == DENIED
    assert h.say(worker, f"/peers discord set channel {CHANNEL}") == DENIED
    assert h.say(master, "/peers discord on") == "error: not configured: set webhook-file <path>, or set bot-token-file <path> and set channel <id>"
    report("Quiet unit", "Nothing is bridged while off")
    # Nothing is queued while off (no state file at all); the exact post ledger below proves it was never sent later either.
    assert discord.requests == [] and not state_file.exists()
    print("PASS off by default: no state file, no request, a report is not queued, non-master changes are refused")

    # ---- Credentials -------------------------------------------------------------------------------------
    loose = write_secret("loose", BOT_TOKEN, 0o644)
    assert h.say(master, f"/peers discord set bot-token-file {loose}") == (
        f"error: secret file {loose} must not be accessible to group or others (chmod 600)")
    link = secrets / "link"
    link.symlink_to(loose)
    assert h.say(master, f"/peers discord set bot-token-file {link}") == f"error: secret file {link} is a symlink; refusing to read it"
    bot_file = write_secret("bot", BOT_TOKEN)
    assert h.say(master, f"/peers discord set bot-token-file {bot_file}") == "set bot-token-file"
    assert h.say(master, "/peers discord on") == "error: not configured: set webhook-file <path>, or set bot-token-file <path> and set channel <id>"
    assert h.say(master, f"/peers discord set channel {CHANNEL}") == "set channel"
    assert stat.S_IMODE(state_file.stat().st_mode) == 0o600 and stat.S_IMODE(h.state.stat().st_mode) == 0o700
    raw = state_file.read_text()
    assert str(bot_file) in raw and BOT_TOKEN not in raw
    on = h.say(master, "/peers discord on")
    assert on.startswith("discord bridge on (bot): the master posts each report it accepts to the configured channel; nothing is sent to any session. "), on
    assert on.endswith("Stop: /peers discord off, then delete the credential file and revoke it in Discord"), on
    print("PASS credential files are checked (0644 and symlink refused), only the path is stored, bot mode turns on")

    # ---- Bot post, with redaction --------------------------------------------------------------------------
    report("Redaction check", "Ping @everyone and <@123456789012345678> see https://example.test/x in /etc/hosts today")
    posts = wait_for(lambda: discord.posts() or None, seconds=30)
    assert len(posts) == 1, posts
    post = posts[0]
    assert post["path"] == f"/api/v10/channels/{CHANNEL}/messages", post["path"]
    assert post["headers"]["authorization"] == f"Bot {BOT_TOKEN}"
    assert post["headers"]["content-type"] == "application/json"
    assert post["headers"]["user-agent"].startswith("omp-peers (https://github.com/PIIIX-org/omp-peers, "), post["headers"]
    redacted = f"**DONE** {wid}: Redaction check: Ping @\u200beveryone and <\u200b@\u200b123456789012345678\\> see (link removed) in (path removed) today"
    assert json.loads(post["body"]) == {"content": redacted, "allowed_mentions": {"parse": []}}, post["body"]
    # The same tick that sent the post would have polled had inbound been on: inbound is a separate switch and is off.
    assert not discord.gets()
    assert h.say(master, "/peers discord status").count("sent: 1; dropped: 0") == 1
    print("PASS bot mode: exact URL, Authorization, body, redaction (mention, link, path) and empty allowed_mentions; inbound off means no poll")

    # ---- A subagent's report is never bridged; inbound is switched on -----------------------------------------
    discord.say(USER, "!peers list")  # history before inbound is switched on: must never run
    assert h.say(master, f"/peers discord set inbound-users {USER}") == "set inbound-users"
    assert h.say(master, "/peers discord set inbound on").startswith("set inbound on: read-only !peers status|list|help from allowlisted users only")
    child = {"kind": "BLOCKED", "unit": "Child task", "blocker": "Waiting for a fixture", "nextAction": "Ask the parent"}
    assert rpc(master_row, {"op": "message", "report": child, "from": {"id": wid, "name": "worker-b"}, "subagent": True})["ok"] is True
    wait_for(lambda: discord.gets(), seconds=30)
    assert discord.gets()[0]["path"] == f"/api/v10/channels/{CHANNEL}/messages?limit=1", discord.gets()[0]["path"]
    assert discord.gets()[0]["headers"]["authorization"] == f"Bot {BOT_TOKEN}"
    cursor = wait_for(lambda: state().get("cursor"), seconds=10)
    assert len(discord.posts()) == 1
    settle_master()  # the subagent report made the master take a turn; the list below needs it idle
    worker_frames = len(worker.frames)
    asks = len(h.gateway.requests)

    # ---- Inbound ------------------------------------------------------------------------------------------
    discord.say(STRANGER, "!peers list")
    discord.say(USER, "!peers list", bot=True)
    discord.say(USER, "!peers list")
    discord.say(USER, "!peers prompt do something")
    discord.say(USER, f"!peers msg {wid} hello")
    # Turning the bridge off and on keeps the cursor and makes the next tick poll at once instead of 15 s after the baseline.
    assert h.say(master, "/peers discord off").startswith("discord bridge off: sending and polling stopped; 0 queued message(s) discarded")
    assert state()["cursor"] == cursor
    assert h.say(master, "/peers discord on").startswith("discord bridge on (bot):")
    assert state()["cursor"] == cursor
    wait_for(lambda: len(discord.posts()) >= 4, seconds=40)
    ledger = contents()
    lines = ledger[1].split("\n")
    assert lines[0] == "sessions: 2" and sorted(lines[1:]) == sorted([f"{mid} idle", f"{wid} idle"]), ledger[1]
    assert discord.gets()[1]["path"] == f"/api/v10/channels/{CHANNEL}/messages?limit=20&after={cursor}", discord.gets()[1]["path"]
    # The ledger is exact: the redacted report, then one reply per allowlisted command in order. The pre-existing command, the stranger, the bot
    # and the subagent's report produced nothing, and nothing was re-sent.
    assert ledger == [redacted, ledger[1], UNKNOWN, UNKNOWN], ledger
    assert all(json.loads(p["body"])["allowed_mentions"] == {"parse": []} and p["path"] == f"/api/v10/channels/{CHANNEL}/messages" for p in discord.posts())
    # The only frames a quiet session emits are its own periodic status-bar updates: no turn, no message, no notice, no error.
    received = [f for f in worker.frames[worker_frames:] if not (f.get("type") == "extension_ui_request" and f.get("method") == "setStatus")]
    assert received == [], received
    assert h.row(worker).get("paused") is not True
    assert len(h.gateway.requests) == asks, "a Discord command reached a model"
    print("PASS inbound: history, a stranger and a bot ignored; list answered once; prompt and msg get the fixed unknown reply; no session or model was reached; exact post ledger")

    # ---- Webhook mode and off from a non-master session --------------------------------------------------------
    assert h.say(worker, "/peers discord off").startswith("discord bridge off: sending and polling stopped; 0 queued message(s) discarded")
    gets = len(discord.gets())
    report("Late unit", "Nothing should go out after off")
    assert state()["enabled"] is False and state()["queue"] == [], state()
    assert h.say(master, "/peers discord test") == "not delivered: the bridge is off; nothing was sent"
    assert h.say(master, "/peers discord set bot-token-file none") == "set bot-token-file"
    assert h.say(master, "/peers discord set channel none") == "set channel"
    assert state()["config"]["inbound"] is False
    hook_file = write_secret("webhook", f"https://discord.com/api/webhooks/{WEBHOOK_ID}/{WEBHOOK_TOKEN}")
    assert h.say(master, f"/peers discord set webhook-file {hook_file}") == "set webhook-file"
    assert h.say(master, "/peers discord set inbound on").startswith("error: inbound needs bot mode")
    assert h.say(master, "/peers discord on").startswith("discord bridge on (webhook):")
    status = h.say(master, "/peers discord status")
    assert f"credential: readable (…/webhooks/{WEBHOOK_ID}/<redacted>)" in status and WEBHOOK_TOKEN not in status, status
    report("Webhook unit", "Offline checks passed")
    wait_for(lambda: len(discord.posts()) >= 5, seconds=30)
    post = discord.posts()[4]
    assert post["path"] == f"/api/webhooks/{WEBHOOK_ID}/{WEBHOOK_TOKEN}", post["path"]
    assert "authorization" not in post["headers"]
    assert json.loads(post["body"]) == {"content": f"**DONE** {wid}: Webhook unit: Offline checks passed", "allowed_mentions": {"parse": []}}
    assert h.say(master, "/peers discord test") == "test message delivered"
    assert json.loads(discord.posts()[5]["body"])["content"] == FIXED_TEST
    # The off-time report was never queued, so it is not in the ledger; and with the bridge off or in webhook mode nothing polls.
    assert contents() == ledger + [f"**DONE** {wid}: Webhook unit: Offline checks passed", FIXED_TEST]
    assert len(discord.gets()) == gets
    print("PASS off from a non-master session: nothing queued, test refuses; webhook mode: exact path, no Authorization, exact body, fixed test message, no polling")

    # ---- 401 stops the bridge --------------------------------------------------------------------------------
    assert h.say(worker, "/peers discord off").startswith("discord bridge off:")
    assert h.say(master, "/peers discord on").startswith("discord bridge on (webhook):")
    discord.post_status = 401
    stop, answer = notices(master, "/peers discord test", 2)
    assert stop == "discord: auth failed: bridge stopped (http 401); check the credential, then /peers discord on", stop
    assert answer == "not delivered: auth failed: bridge stopped (http 401)", answer
    assert state()["enabled"] is False and state()["queue"] == [] and state()["stopped"] == "auth failed: bridge stopped"
    report("After stop", "Nothing should go out now")
    assert state()["queue"] == [], "a report was queued while the bridge was stopped"
    posts_now, gets_now = len(discord.posts()), len(discord.gets())
    assert posts_now == 7  # the six ledger posts and the refused 401 test post
    assert h.say(master, "/peers discord status").splitlines()[:2] == ["discord bridge: off (opt-in; /peers discord on enables it)", "stopped: auth failed: bridge stopped"]
    one_tick_passed(master)
    assert len(discord.posts()) == posts_now and len(discord.gets()) == gets_now
    print("PASS HTTP 401: visible notice, bridge stopped, queue discarded, nothing queued or sent afterwards across a bridge tick")

    # ---- No credential anywhere --------------------------------------------------------------------------------
    secrets_found = [BOT_TOKEN.encode(), WEBHOOK_TOKEN.encode()]
    for root, _dirs, files in os.walk(h.home):
        if root.startswith(str(secrets)):
            continue
        for name in files:
            path = os.path.join(root, name)
            if os.path.islink(path) or not os.path.isfile(path):
                continue
            try:
                data = open(path, "rb").read()
            except OSError:
                continue
            for secret in secrets_found:
                assert secret not in data, f"a credential was written to {path}"
    for peer in (master, worker):
        text = json.dumps(peer.frames)
        for secret in secrets_found:
            assert secret.decode() not in text, "a credential appeared in an RPC frame or notice"
    print("PASS no credential in any file under the home (outside the secrets directory) or in any notice or frame")
