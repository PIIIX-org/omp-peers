# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (c) 2026 PIIIX-org contributors
"""/peers discord through two real OMP processes and a fake Discord on 127.0.0.1 (never the real network).

The master is started with the test-only OMP_PEERS_DISCORD_API_BASE=http://127.0.0.1:<port>; every credential is a fake
value written into a private file under the disposable home. Checks: off by default, bot and webhook posting with exact
bodies and headers, redaction, empty allowed_mentions, no resend, a subagent report never bridged, no credential in any
file or output, read-only inbound commands from an allowlisted user only (a prompt command reaches no session), a 401
stopping the bridge, and `off` stopping all traffic.
"""
import json
import os
import socket
import stat
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

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
    master = h.start(env={"OMP_PEERS_DISCORD_API_BASE": f"http://127.0.0.1:{discord.port}"})
    worker = h.start()
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

    def posts_total():
        return len(discord.posts())

    def report(unit, description, sender=worker):
        body = {"kind": "DONE", "unit": unit, "evidence": {"description": description}}
        sent = h.say(sender, f"/peers report {mid} " + json.dumps(body))
        assert sent.endswith(f"({mid}): ok"), sent

    def settle_master():
        """A report makes the master take a model turn; wait until it is idle again."""
        wait_for(lambda: h.row(master).get("busy") is False, seconds=30)

    assert h.say(master, "/peers master")
    h.say(master, f"/peers do {wid} rename worker-b")
    wait_for(lambda: h.row(worker)["name"] == "worker-b")

    # ---- Off by default ----------------------------------------------------------------------------------
    status = h.say(master, "/peers discord status")
    assert status.splitlines()[0] == "discord bridge: off (opt-in; /peers discord on enables it)", status
    assert h.say(worker, "/peers discord on") == DENIED
    assert h.say(worker, f"/peers discord set channel {CHANNEL}") == DENIED
    assert h.say(master, "/peers discord on") == "error: not configured: set webhook-file <path>, or set bot-token-file <path> and set channel <id>"
    report("Quiet unit", "Nothing is bridged while off")
    settle_master()
    time.sleep(7)  # more than one 5 s tick
    assert discord.requests == [] and not state_file.exists()
    print("PASS off by default: no state file, no request, a report is not bridged, non-master changes are refused")

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

    # ---- Bot post ----------------------------------------------------------------------------------------
    report("Parser rewrite", "Offline checks passed")
    posts = wait_for(lambda: discord.posts() if posts_total() >= 1 else None, seconds=30)
    assert len(posts) == 1, posts
    post = posts[0]
    assert post["path"] == f"/api/v10/channels/{CHANNEL}/messages", post["path"]
    assert post["headers"]["authorization"] == f"Bot {BOT_TOKEN}"
    assert post["headers"]["content-type"] == "application/json"
    assert post["headers"]["user-agent"].startswith("omp-peers (https://github.com/PIIIX-org/omp-peers, "), post["headers"]
    assert json.loads(post["body"]) == {"content": f"**DONE** {wid}: Parser rewrite: Offline checks passed", "allowed_mentions": {"parse": []}}, post["body"]
    settle_master()
    time.sleep(12)  # two more ticks and a poll interval: the delivered message is never re-sent
    assert posts_total() == 1 and not discord.gets()
    assert h.say(master, "/peers discord status").count("sent: 1; dropped: 0") == 1
    print("PASS bot mode: exact URL, Authorization, body and empty allowed_mentions; delivered once, never re-sent")

    # ---- Redaction ---------------------------------------------------------------------------------------
    report("Redaction check", "Ping @everyone and <@123456789012345678> see https://example.test/x in /etc/hosts today")
    wait_for(lambda: posts_total() >= 2, seconds=30)
    body = json.loads(discord.posts()[1]["body"])
    assert body == {"content": f"**DONE** {wid}: Redaction check: Ping @\u200beveryone and <\u200b@\u200b123456789012345678\\> see (link removed) in (path removed) today",
                    "allowed_mentions": {"parse": []}}, body
    settle_master()
    print("PASS redaction: mentions neutralised, link and absolute path removed, allowed_mentions empty")

    # ---- A subagent's report is never bridged -------------------------------------------------------------
    before = posts_total()
    start = len(master.frames)
    child = {"kind": "BLOCKED", "unit": "Child task", "blocker": "Waiting for a fixture", "nextAction": "Ask the parent"}
    assert rpc(master_row, {"op": "message", "report": child, "from": {"id": wid, "name": "worker-b"}, "subagent": True})["ok"] is True
    wait_for(lambda: any(f.get("type") == "agent_end" for f in master.frames[start:]), seconds=30)
    time.sleep(7)
    assert posts_total() == before, discord.posts()[before:]
    print("PASS a subagent's report is delivered to the master but never bridged")

    # ---- Inbound -------------------------------------------------------------------------------------------
    discord.say(USER, "!peers list")  # history before inbound is switched on: must never run
    assert h.say(master, f"/peers discord set inbound-users {USER}") == "set inbound-users"
    assert h.say(master, "/peers discord set inbound on").startswith("set inbound on: read-only !peers status|list|help from allowlisted users only")
    wait_for(lambda: discord.gets(), seconds=30)
    assert discord.gets()[0]["path"] == f"/api/v10/channels/{CHANNEL}/messages?limit=1", discord.gets()[0]["path"]
    assert discord.gets()[0]["headers"]["authorization"] == f"Bot {BOT_TOKEN}"
    before = posts_total()
    wait_for(lambda: state().get("cursor"), seconds=10)
    assert posts_total() == before
    worker_frames = len(worker.frames)
    asks = len(h.gateway.requests)

    discord.say(STRANGER, "!peers list")
    discord.say(USER, "!peers list", bot=True)
    discord.say(USER, "!peers list")
    settle_master()
    wait_for(lambda: posts_total() >= before + 1, seconds=40)
    time.sleep(6)
    new = discord.posts()[before:]
    assert len(new) == 1, new
    reply = json.loads(new[0]["body"])
    lines = reply["content"].split("\n")
    assert lines[0] == "sessions: 2" and sorted(lines[1:]) == sorted([f"{mid} idle", f"{wid} idle"]), reply
    assert reply["allowed_mentions"] == {"parse": []} and new[0]["path"] == f"/api/v10/channels/{CHANNEL}/messages"
    print("PASS inbound: the pre-existing command never ran; a stranger and a bot are ignored; the allowlisted user's !peers list got one exact reply")

    before = posts_total()
    for word in ("prompt do something", "msg worker-b hello", "pause"):
        discord.say(USER, f"!peers {word}")
    wait_for(lambda: posts_total() >= before + 3, seconds=60)
    time.sleep(6)
    replies = [json.loads(p["body"])["content"] for p in discord.posts()[before:]]
    assert replies == [UNKNOWN] * 3, replies
    # The only frames a quiet session emits are its own periodic status-bar updates: no turn, no message, no notice, no error.
    received = [f for f in worker.frames[worker_frames:] if not (f.get("type") == "extension_ui_request" and f.get("method") == "setStatus")]
    assert received == [], received
    assert h.row(worker).get("paused") is not True
    assert len(h.gateway.requests) == asks, "a Discord command reached a model"
    print("PASS inbound prompt/msg/pause get the fixed unknown reply; no session received anything and no model was asked")

    # ---- 401 stops the bridge --------------------------------------------------------------------------------
    before = posts_total()
    discord.post_status = 401
    start = len(master.frames)
    report("Unauthorized unit", "This post is refused by Discord")
    wait_for(lambda: any("auth failed: bridge stopped (http 401)" in json.dumps(f) for f in master.frames[start:]), seconds=40)
    assert posts_total() == before + 1
    assert state()["enabled"] is False and state()["queue"] == [] and state()["stopped"] == "auth failed: bridge stopped"
    settle_master()
    gets = len(discord.gets())
    report("After stop", "Nothing should go out now")
    settle_master()
    time.sleep(7)
    assert posts_total() == before + 1 and len(discord.gets()) == gets
    assert h.say(master, "/peers discord status").splitlines()[:2] == ["discord bridge: off (opt-in; /peers discord on enables it)", "stopped: auth failed: bridge stopped"]
    print("PASS HTTP 401: visible notice, bridge stopped, queue discarded, no further request of any kind")

    # ---- Webhook mode ------------------------------------------------------------------------------------------
    discord.post_status = 200
    assert h.say(master, "/peers discord set bot-token-file none") == "set bot-token-file"
    assert h.say(master, "/peers discord set channel none") == "set channel"
    assert state()["config"]["inbound"] is False
    hook_file = write_secret("webhook", f"https://discord.com/api/webhooks/{WEBHOOK_ID}/{WEBHOOK_TOKEN}")
    assert h.say(master, f"/peers discord set webhook-file {hook_file}") == "set webhook-file"
    assert h.say(master, "/peers discord set inbound on").startswith("error: inbound needs bot mode")
    assert h.say(master, "/peers discord on").startswith("discord bridge on (webhook):")
    status = h.say(master, "/peers discord status")
    assert f"credential: readable (…/webhooks/{WEBHOOK_ID}/<redacted>)" in status and WEBHOOK_TOKEN not in status, status
    before, gets = posts_total(), len(discord.gets())
    report("Webhook unit", "Offline checks passed")
    wait_for(lambda: posts_total() >= before + 1, seconds=30)
    post = discord.posts()[before]
    assert post["path"] == f"/api/webhooks/{WEBHOOK_ID}/{WEBHOOK_TOKEN}", post["path"]
    assert "authorization" not in post["headers"]
    assert json.loads(post["body"]) == {"content": f"**DONE** {wid}: Webhook unit: Offline checks passed", "allowed_mentions": {"parse": []}}
    assert h.say(master, "/peers discord test") == "test message delivered"
    assert json.loads(discord.posts()[before + 1]["body"])["content"] == FIXED_TEST
    assert len(discord.gets()) == gets
    print("PASS webhook mode: exact path, no Authorization header, exact body; test posts the one fixed message; nothing is polled")

    # ---- Off stops traffic -------------------------------------------------------------------------------------
    settle_master()
    assert h.say(worker, "/peers discord off").startswith("discord bridge off: sending and polling stopped; 0 queued message(s) discarded")
    before, gets = posts_total(), len(discord.gets())
    report("Late unit", "Nothing should go out after off")
    settle_master()
    time.sleep(7)
    assert posts_total() == before and len(discord.gets()) == gets
    assert h.say(master, "/peers discord test") == "not delivered: the bridge is off; nothing was sent"
    print("PASS off (from a non-master session) stops all traffic; test refuses while off")

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
