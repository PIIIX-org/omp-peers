# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (c) 2026 PIIIX-org contributors
"""The resume policy through real OMP processes: who paused a session decides who may resume it, and a blackout (kill -9)
pauses a session that was idle while a session working under the master's management is left as it was. The model is a
loopback gateway that can hold one turn open."""
import json
import socket
import socketserver
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

from smoke import wait_for

USER_PAUSED = "paused by its user: only that user can resume it with /peers resume"
RESTART_PAUSED = "paused after a restart because it was idle: only its user can resume it"
SUBAGENT = "resume is not available to subagents"
NOT_MASTER = "sender is not the master session"
NOT_DELIVERED = "not delivered: worker-r is paused; resend after its user resumes it"


class HoldGateway(BaseHTTPRequestHandler):
    """Plain replies; a prompt containing HOLD-OPEN keeps its request open until `release` is set."""

    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.requests.append((self.path, body))
        last = body["messages"][-1]
        text = last["content"] if isinstance(last["content"], str) else "".join(p.get("text", "") for p in last["content"])
        if last["role"] == "user" and "HOLD-OPEN" in text:
            self.server.release.wait(timeout=60)
        common = {"id": "held", "object": "chat.completion.chunk", "created": 1, "model": body["model"]}
        chunks = [{**common, "choices": [{"index": 0, "delta": {"role": "assistant", "content": "Noted."}, "finish_reason": None}]},
                  {**common, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                   "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}]
        payload = ("".join("data: " + json.dumps(c) + "\n\n" for c in chunks) + "data: [DONE]\n\n").encode()
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except OSError:
            pass  # the held turn's process was killed


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


def pause_entry(h, peer_id):
    path = h.state / "pause.json"
    return json.loads(path.read_text())["sessions"].get(peer_id) if path.exists() else None


def run(h):
    h.gateway.__class__ = type("ThreadedGateway", (socketserver.ThreadingMixIn, HTTPServer), {"daemon_threads": True})
    h.gateway.RequestHandlerClass = HoldGateway
    h.gateway.release = threading.Event()
    try:
        scenario(h)
    finally:
        h.gateway.release.set()


def scenario(h):
    master, worker, busy = h.start(), h.start(), h.start()
    wid, bid, mid = h.row(worker)["id"], h.row(busy)["id"], h.row(master)["id"]
    assert h.say(master, "/peers master")
    h.say(master, f"/peers do {wid} rename worker-r")
    h.say(master, f"/peers do {bid} rename worker-h")
    wait_for(lambda: h.row(worker)["name"] == "worker-r" and h.row(busy)["name"] == "worker-h")
    h.ask(worker, "Reply with the word ok.")  # materialise the session files used for the restarts below
    h.ask(busy, "Reply with the word ok.")
    assert "audit log on" in h.say(master, "/peers audit on")

    # 1. The master clears a pause it set itself.
    assert h.say(master, f"/peers do {wid} pause maintenance window") == f"worker-r ({wid}): ok (paused)"
    wait_for(lambda: h.row(worker).get("paused") is True)
    assert h.row(worker)["pausedBy"] == "master"
    entry = pause_entry(h, wid)
    assert entry["by"] == "master" and entry["reason"] == "maintenance window", entry
    assert any(wid in line and "paused:master" in line for line in h.say(master, "/peers list").splitlines())
    assert "by the master (maintenance window); resumable by the master (/peers do <peer> resume) or its user" in h.say(worker, "/peers pause status")
    assert h.say(master, f"/peers do {wid} resume") == f"worker-r ({wid}): ok (resumed)"
    wait_for(lambda: h.row(worker)["paused"] is False)
    assert pause_entry(h, wid) is None
    assert h.say(master, f"/peers do {wid} resume") == f"worker-r ({wid}): ok (was not paused)"
    print("PASS the master resumes a session it paused itself, and resuming a session that is not paused is a no-op")

    # 2. The master never overrides a pause its user set, nor one the user took over.
    assert h.say(worker, "/peers pause my own call").startswith(f"paused worker-r ({wid}) (my own call)")
    wait_for(lambda: h.row(worker).get("paused") is True)
    assert h.row(worker)["pausedBy"] == "user"
    start, requests = len(worker.frames), len(h.gateway.requests)
    assert h.say(master, f"/peers do {wid} resume") == f"worker-r ({wid}): failed: {USER_PAUSED}"
    assert h.say(master, f"/peers do {wid} pause again") == f"worker-r ({wid}): ok (paused)"
    assert pause_entry(h, wid)["by"] == "user", "a master pause does not turn the user's pause into the master's"
    assert h.say(master, f"/peers do {wid} resume") == f"worker-r ({wid}): failed: {USER_PAUSED}"
    assert h.row(worker)["paused"] is True
    assert h.say(master, f"/peers msg {wid} hi") == f"{NOT_DELIVERED} ({wid})"
    assert "by its user (my own call); resumable by only its user" in h.say(worker, "/peers pause status")
    assert h.say(worker, "/peers resume").startswith(f"resumed worker-r ({wid}) (it was paused by its user)")
    wait_for(lambda: h.row(worker)["paused"] is False)
    assert h.say(master, f"/peers do {wid} pause maintenance") == f"worker-r ({wid}): ok (paused)"
    wait_for(lambda: h.row(worker).get("paused") is True)
    assert "was paused by the master and is now paused by its user" in h.say(worker, "/peers pause")
    assert pause_entry(h, wid)["by"] == "user"
    assert h.say(master, f"/peers do {wid} resume") == f"worker-r ({wid}): failed: {USER_PAUSED}"
    assert h.row(worker)["paused"] is True and h.row(worker)["pausedBy"] == "user"
    assert [f for f in worker.frames[start:] if str(f.get("type", "")).startswith(("agent_", "turn_"))] == []
    assert len(h.gateway.requests) == requests
    print("PASS a user pause (or a master pause the user repeated) is refused with the exact error and stays paused; nothing woke")

    # 3. Other callers cannot resume at all, and a locked session refuses the master too.
    row = h.row(worker)
    assert rpc(row, {"op": "resume", "from": {"id": "completion-watcher", "name": "Completion watcher"}}) == {"ok": False, "error": NOT_MASTER}
    assert rpc(row, {"op": "resume"}) == {"ok": False, "error": NOT_MASTER}
    assert rpc(row, {"op": "resume", "from": {"id": mid, "name": "master"}, "subagent": True}) == {"ok": False, "error": SUBAGENT}
    assert h.say(worker, "/peers resume").startswith("resumed")
    assert h.say(master, f"/peers do {wid} pause x") == f"worker-r ({wid}): ok (paused)"
    assert rpc(row, {"op": "resume", "from": {"id": mid, "name": "master"}, "subagent": True}) == {"ok": False, "error": SUBAGENT}
    assert h.row(worker)["paused"] is True and pause_entry(h, wid)["by"] == "master"
    h.say(worker, "/peers lock")
    assert h.say(master, f"/peers do {wid} resume") == f"worker-r ({wid}): failed: peer is locked (control refused)"
    h.say(worker, "/peers unlock")
    assert h.say(master, f"/peers do {wid} resume") == f"worker-r ({wid}): ok (resumed)"
    wait_for(lambda: h.row(worker)["paused"] is False)
    print("PASS forged, unauthenticated, subagent and locked attempts are refused; the master's own pause is cleared")

    # 4. The audit log records the refusal like any other control outcome.
    records = [json.loads(line) for line in (h.state / "audit.jsonl").read_text().splitlines()]
    resumes = [r for r in records if r["op"] == "resume" and r["phase"] == "completed" and r["targetId"] == wid]
    refused = [r for r in resumes if r["outcome"] == "refused" and r["reason"] == "not-resumable"]
    assert {r["side"] for r in refused} == {"sender", "receiver"} and len(refused) >= 4, resumes
    assert any(r["outcome"] == "ok" for r in resumes)
    assert "only that user" not in json.dumps(records), "error text is never stored"
    print("PASS the audit log records resume attempts (outcome refused, reason not-resumable) without the error text")

    # 5. A blackout (kill -9) while idle: the session comes back paused by the restart rule; only its user resumes it.
    session_file = worker.call("get_state")["sessionFile"]
    worker.proc.kill()
    worker.proc.wait(timeout=10)
    worker = h.start(resume=session_file)
    assert h.row(worker)["id"] == wid
    row = wait_for(lambda: h.row(worker) if h.row(worker).get("paused") is True else None)
    assert row["pausedBy"] == "restart", row
    entry = pause_entry(h, wid)
    assert entry["by"] == "restart" and entry["reason"] == "idle before the restart", entry
    wait_for(lambda: any(f.get("method") == "notify" and "was paused automatically" in str(f.get("message", "")) for f in worker.frames))
    start, requests = len(worker.frames), len(h.gateway.requests)
    assert h.say(master, f"/peers do {wid} resume") == f"worker-r ({wid}): failed: {RESTART_PAUSED}"
    assert h.say(master, f"/peers msg {wid} anybody home?") == f"{NOT_DELIVERED} ({wid})"
    assert rpc(h.row(worker), {"op": "prompt", "text": "x", "from": {"id": mid, "name": "master"}})["status"] == "refused"
    time.sleep(0.5)
    assert [f for f in worker.frames[start:] if str(f.get("type", "")).startswith(("agent_", "turn_", "message_")) or "Message from" in json.dumps(f)] == []
    assert len(h.gateway.requests) == requests
    assert "by the restart rule (idle before the restart); resumable by only its user" in h.say(worker, "/peers pause status")
    assert pause_entry(h, wid)["by"] == "restart"
    print("PASS an idle session killed with -9 comes back paused (restart); the master cannot resume it and nothing wakes it")
    assert h.say(worker, "/peers resume").startswith(f"resumed worker-r ({wid}) (it was paused by the restart rule)")
    wait_for(lambda: h.row(worker)["paused"] is False)

    # 6. A normal close and reopen is not a blackout.
    session_file = worker.call("get_state")["sessionFile"]
    worker.close()
    worker = h.start(resume=session_file)
    assert h.row(worker)["id"] == wid and h.row(worker)["paused"] is False and pause_entry(h, wid) is None
    print("PASS a clean shutdown and reopen is unchanged: not paused")

    # 7. A blackout while working on the master's prompt: left as it was, still reachable by the master.
    busy_file = busy.call("get_state")["sessionFile"]
    requests = len(h.gateway.requests)
    dispatched = h.say(master, f"/peers do {bid} prompt HOLD-OPEN please")
    assert f"worker-h ({bid}): ok" in dispatched, dispatched
    wait_for(lambda: len(h.gateway.requests) > requests)
    wait_for(lambda: h.row(busy)["busy"] is True)
    saved = h.home / ".omp/agent/peer-sessions" / f"{bid}.json"
    wait_for(lambda: json.loads(saved.read_text()).get("managed") is True)
    assert json.loads(saved.read_text())["clean"] is False
    busy.proc.kill()
    busy.proc.wait(timeout=10)
    h.gateway.release.set()
    busy = h.start(resume=busy_file)
    assert h.row(busy)["id"] == bid
    assert h.row(busy)["paused"] is False and pause_entry(h, bid) is None, h.row(busy)
    assert not any("was paused automatically" in str(f.get("message", "")) for f in busy.frames)
    start = len(busy.frames)
    sent = h.say(master, f"/peers msg {bid} back online?")
    assert sent.endswith(": ok"), sent
    wait_for(lambda: any(f.get("type") == "agent_end" for f in busy.frames[start:]), seconds=30)
    print("PASS a session killed while working on the master's prompt comes back unpaused and the master can still reach it")

    # 8. Working on its own user's turn is not management: killed while busy, it comes back paused.
    h.gateway.release.clear()
    own_file = busy.call("get_state")["sessionFile"]
    requests = len(h.gateway.requests)
    busy.call("prompt", message="HOLD-OPEN on my own")
    wait_for(lambda: len(h.gateway.requests) > requests)
    wait_for(lambda: h.row(busy)["busy"] is True)
    assert json.loads(saved.read_text())["managed"] is False
    busy.proc.kill()
    busy.proc.wait(timeout=10)
    h.gateway.release.set()
    busy = h.start(resume=own_file)
    row = wait_for(lambda: h.row(busy) if h.row(busy).get("paused") is True else None)
    assert row["pausedBy"] == "restart" and pause_entry(h, bid)["by"] == "restart"
    print("PASS a session killed during its own user's turn is not 'managed': it comes back paused")
