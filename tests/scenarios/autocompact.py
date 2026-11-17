# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (c) 2026 PIIIX-org contributors
"""/peers autocompact through a real OMP process; the model is a scripted loopback gateway that reports large token usage."""
import json
import re
import socket
import stat
import time
from http.server import BaseHTTPRequestHandler

from smoke import wait_for

SETTLE = 2.5  # the policy looks 1 s after agent_end; absence is checked after this much longer


class Gateway(BaseHTTPRequestHandler):
    """Plain replies. A turn reports `server.usage` prompt tokens (against a 20000-token window) after `server.delay` seconds;
    the host's own summarisation requests (system prompt starts with "Summarize") are answered at once with small usage."""

    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.requests.append((self.path, body))
        system = body["messages"][0]["content"]
        summary = isinstance(system, str) and system.startswith("Summarize")
        if not summary:
            time.sleep(self.server.delay)
        usage = 10 if summary else self.server.usage
        common = {"id": "scripted", "object": "chat.completion.chunk", "created": 1, "model": body["model"]}
        chunks = [{**common, "choices": [{"index": 0, "delta": {"role": "assistant", "content": "Offline proof."}, "finish_reason": None}]},
                  {**common, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                   "usage": {"prompt_tokens": usage, "completion_tokens": 1, "total_tokens": usage + 1}}]
        payload = ("".join("data: " + json.dumps(c) + "\n\n" for c in chunks) + "data: [DONE]\n\n").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def rpc(row, request):
    """Speak the peer socket protocol directly, as any other session or tool could."""
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


def is_summary(body):
    system = body["messages"][0]["content"]
    return isinstance(system, str) and system.startswith("Summarize")


def run(h):
    h.gateway.RequestHandlerClass = Gateway
    h.gateway.usage, h.gateway.delay = 18000, 0  # 90% of the window once a turn has reported it
    (h.agent / "models.yml").write_text(
        f"providers:\n  smoke:\n    baseUrl: http://127.0.0.1:{h.gateway.server_port}/v1\n"
        "    api: openai-completions\n    auth: none\n    models:\n      - id: first\n        contextWindow: 20000\n")
    config = h.agent / "config.yml"  # the host's own auto-compaction stays out of the way: this feature is separate
    config.write_text(config.read_text() + "compaction:\n  enabled: false\n  idleEnabled: false\n")
    requests = h.gateway.requests
    worker = h.start()
    row = h.row(worker)
    wid = row["id"]
    state_file = h.state / "autocompact.json"
    summaries = lambda: [b for _, b in requests if is_summary(b)]
    notices = lambda: [f["message"] for f in worker.frames if f.get("method") == "notify" and f["message"].startswith(("auto-compact: compacted", "auto-compact: compaction failed"))]

    def turn(text="Reply with the word ok."):
        start = len(worker.frames)
        before = len(requests)
        worker.call("prompt", message=text)
        wait_for(lambda: any(f.get("type") == "agent_end" for f in worker.frames[start:]), seconds=30)
        assert len(requests) == before + 1, requests[before:]
        return start

    def log_lines():
        return h.say(worker, "/peers autocompact log 100").splitlines()

    # 1. Off by default: nothing is stored, and a turn at 90% context compacts nothing.
    status = h.say(worker, "/peers autocompact status")
    assert status.startswith("auto-compact: off (default); threshold 85% context, cooldown 30 min, at most 2 per hour per session\neligible: none, so nothing is compacted"), status
    assert not state_file.exists()
    turn()
    time.sleep(SETTLE)
    assert not summaries() and not state_file.exists() and not notices()
    assert not any(f.get("type") == "manual_compaction_start" for f in worker.frames)
    print("PASS off by default: a turn at 90% context compacts nothing and no state file is created")

    # 2. Opt in: enabling needs an eligible entry; status is read-only and mirrors the real decision.
    assert h.say(worker, "/peers autocompact on").endswith("eligible list is empty, so nothing will be compacted; add a session or group with /peers autocompact add <session|group:<name>>")
    assert "would compact at the next safe turn boundary: no (not eligible)" in h.say(worker, "/peers autocompact status")
    assert h.say(worker, f"/peers autocompact add {wid}") == f"{wid} is now eligible (1 of 32)"
    assert stat.S_IMODE(state_file.stat().st_mode) == 0o600 and stat.S_IMODE(h.state.stat().st_mode) == 0o700
    before_bytes, before_mtime = state_file.read_bytes(), state_file.stat().st_mtime_ns
    start, count = len(worker.frames), len(requests)
    status = h.say(worker, "/peers autocompact status")
    assert f"({wid}); eligible: yes" in status, status
    assert "context: 90%" in status and "would compact at the next safe turn boundary: yes" in status, status
    time.sleep(SETTLE)  # status must not compact, even though it says it would at the next boundary
    assert state_file.read_bytes() == before_bytes and state_file.stat().st_mtime_ns == before_mtime
    assert len(requests) == count and not any(f.get("type") in ("agent_start", "manual_compaction_start") for f in worker.frames[start:])
    print("PASS enabling needs an eligible entry; status says 'would compact: yes' yet changes no byte and compacts nothing")

    # 3. A turn that reports 90%: compaction happens only after the whole run ended, never while the turn is running.
    assert h.say(worker, "/peers autocompact on").startswith("auto-compact is on: eligible sessions are compacted")
    h.gateway.delay = 3.0
    start, before = len(worker.frames), len(requests)
    worker.call("prompt", message="Reply with the word ok, slowly.")
    wait_for(lambda: len(requests) == before + 1)  # the turn's model request is in flight (held by the gateway)
    time.sleep(1.5)
    assert not summaries() and not any(f.get("type") in ("manual_compaction_start", "agent_end") for f in worker.frames[start:])
    wait_for(lambda: any(f.get("type") == "agent_end" for f in worker.frames[start:]), seconds=30)
    h.gateway.delay = 0
    done = wait_for(lambda: next((f for f in worker.frames[start:] if f.get("type") == "manual_compaction_end"), None), seconds=30)
    kinds = [f.get("type") for f in worker.frames[start:]]
    assert kinds.index("agent_end") < kinds.index("manual_compaction_start") < kinds.index("manual_compaction_end"), kinds
    assert done["aborted"] is False and summaries(), done
    wait_for(lambda: notices())
    assert re.fullmatch(r"auto-compact: compacted at 90% \(now \d+(\.\d)?%\)", notices()[-1]), notices()
    assert sum(1 for f in worker.frames[start:] if f.get("type") == "agent_start") == 1  # compaction started no further turn
    lines = log_lines()
    assert re.fullmatch(rf"\S+Z {wid} \(this session\) compacted at 90% -> \d+(\.\d)?%", lines[-1]), lines
    stored = json.loads(state_file.read_text())
    assert len(stored["sessions"][wid]["attempts"]) == 1 and "suppressed" not in stored["sessions"][wid], stored
    text = state_file.read_text()
    assert "Reply with the word ok" not in text and "Offline proof" not in text and "Summarize" not in text  # the audit trail holds no conversation
    print("PASS compaction ran once, after agent_end and not while the turn was running; the log records outcome and percentages only")

    # 4. A second turn inside the cooldown is suppressed and logged once.
    count = len(summaries())
    turn()
    wait_for(lambda: log_lines()[-1].endswith("skipped: cooldown at 90%"))
    turn()
    time.sleep(SETTLE)
    assert len(summaries()) == count, "compacted again inside the cooldown"
    lines = log_lines()
    assert [l.split("(this session) ", 1)[1] for l in lines if "skipped" in l] == ["skipped: cooldown at 90%"], lines  # once per episode, not per turn
    assert "would compact at the next safe turn boundary: no (cooldown)" in h.say(worker, "/peers autocompact status")
    print("PASS a second turn within the cooldown is suppressed, and the refusal is logged once")

    # 5. Nothing remote can change or trigger it; a pause is respected.
    state_bytes = state_file.read_bytes()
    reply = rpc(row, {"op": "autocompact", "text": "on", "from": {"id": "completion-watcher", "name": "Completion watcher"}})
    assert reply == {"ok": False, "error": 'unknown op "autocompact"'}, reply
    assert state_file.read_bytes() == state_bytes
    assert h.say(worker, "/peers autocompact reset-suppression").startswith("cleared this session's suppression")
    assert h.say(worker, "/peers pause maintenance").startswith("paused ")
    count = len(summaries())
    turn()
    wait_for(lambda: log_lines()[-1].endswith("skipped: paused at 90%"))
    time.sleep(SETTLE)
    assert len(summaries()) == count, "a paused session was compacted"
    assert h.say(worker, "/peers resume").startswith("resumed ")
    print("PASS no remote op reaches the policy; a paused session is not compacted")

    # 6. Turning it off stops everything, and the change is in the audit log.
    assert h.say(worker, "/peers autocompact off") == "auto-compact is off: no session will be compacted by this policy"
    assert log_lines()[-1].endswith("changed: disabled")
    print("PASS off stops the policy and is logged")
