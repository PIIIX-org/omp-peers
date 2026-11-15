# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (c) 2026 PIIIX-org contributors
"""/peers pause and resume through real OMP processes; wakes are observed at the session and at the loopback gateway."""
import json
import socket
import stat
import time

from smoke import wait_for


def rpc(row, request):
    """Speak the peer socket protocol directly, as a watcher or any other sender would."""
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


def assert_not_woken(h, peer, start, requests):
    """The paused session started nothing: no agent frames, no peer-message notice, no model request."""
    time.sleep(1.0)
    woke = [f for f in peer.frames[start:]
            if str(f.get("type", "")).startswith(("agent_", "turn_", "message_")) or "Message from" in json.dumps(f)]
    assert not woke, woke
    assert len(h.gateway.requests) == requests, h.gateway.requests[requests:]


def run(h):
    master, worker = h.start(), h.start()
    worker_row = h.row(worker)
    wid = worker_row["id"]
    assert h.say(master, "/peers master")
    h.say(master, f"/peers do {wid} rename worker-b")
    wait_for(lambda: h.row(worker)["name"] == "worker-b")
    assert h.row(worker)["paused"] is False
    h.ask(worker, "Reply with the word ok.")  # materialises the session file used for the restart below

    out = h.say(worker, "/peers pause waiting for review")
    assert out.startswith(f"paused worker-b ({wid}) (waiting for review)") and "not interrupted" in out, out
    row = wait_for(lambda: h.row(worker) if h.row(worker).get("paused") is True else None)
    assert row["pausedSince"].endswith("Z") and "waiting" not in json.dumps(row), row
    pause_file = h.state / "pause.json"
    assert stat.S_IMODE(pause_file.stat().st_mode) == 0o600 and stat.S_IMODE(h.state.stat().st_mode) == 0o700
    state = json.loads(pause_file.read_text())
    assert state["version"] == 1 and list(state["sessions"]) == [wid] and state["sessions"][wid]["reason"] == "waiting for review", state
    assert "already paused" in h.say(worker, "/peers pause again")
    print("PASS /peers pause persists a private version-1 entry and publishes paused/pausedSince without the reason")

    start, requests = len(worker.frames), len(h.gateway.requests)
    listed = h.say(master, "/peers list")
    assert any(wid in line and "paused" in line for line in listed.splitlines()), listed
    status = h.say(master, f"/peers do {wid} status")
    assert "paused" in status, status
    assert h.row(worker)["paused"] is True and h.row(worker)["pausedSince"]
    tail = h.say(master, f"/peers do {wid} tail 2")  # read-only ops still work
    assert "Reply with the word ok." in tail and "paused" not in tail, tail
    assert_not_woken(h, worker, start, requests)
    print("PASS list, status and tail show the pause and wake nothing")

    msg = h.say(master, f"/peers msg {wid} anyone there?")
    assert msg == f"deferred: worker-b is paused ({wid})", msg
    dispatched = h.say(master, f"/peers do {wid} prompt run the suite")
    assert dispatched.endswith(f"refused: worker-b is paused ({wid})"), dispatched
    assert h.say(master, "/peers msg all still nobody").startswith("deferred: worker-b is paused")
    forged = rpc(row, {"op": "message", "text": "from an unknown sender", "from": {"id": "completion-watcher", "name": "Completion watcher"}})
    assert forged == {"ok": False, "status": "deferred", "paused": True, "error": "session is paused"}, forged
    assert rpc(row, {"op": "prompt", "text": "x", "from": {"id": h.row(master)["id"], "name": "master"}})["status"] == "refused"
    assert rpc(row, {"op": "digest-from-the-future"}) == {"ok": False, "status": "refused", "paused": True, "error": "session is paused"}
    assert_not_woken(h, worker, start, requests)
    print("PASS master message and prompt, a raw watcher-style message and an unknown op are refused; the worker received nothing")

    denied = rpc(row, {"op": "resume", "from": {"id": "completion-watcher", "name": "Completion watcher"}})
    assert denied == {"ok": False, "error": "sender is not the master session"}, denied
    assert rpc(row, {"op": "resume"}) == {"ok": False, "error": "sender is not the master session"}
    assert rpc(row, {"op": "status"})["info"]["paused"] is True
    h.say(worker, "/peers lock")
    assert h.say(master, f"/peers do {wid} resume").endswith("failed: peer is locked (control refused)")
    h.say(worker, "/peers unlock")
    assert h.row(worker)["paused"] is True
    print("PASS nothing but the master or the session's own user can resume: forged, unauthenticated and locked attempts leave it paused")

    session_file = worker.call("get_state")["sessionFile"]
    worker.close()
    worker = h.start(resume=session_file)
    assert h.row(worker)["id"] == wid
    row = wait_for(lambda: h.row(worker) if h.row(worker).get("paused") is True else None)
    start, requests = len(worker.frames), len(h.gateway.requests)
    assert h.say(master, f"/peers msg {wid} after restart") == f"deferred: worker-b is paused ({wid})"
    assert_not_woken(h, worker, start, requests)
    print("PASS a restarted session (same session file) is still paused and still receives nothing")

    assert h.say(master, f"/peers do {wid} resume") == f"worker-b ({wid}): ok (resumed)"
    wait_for(lambda: h.row(worker)["paused"] is False)
    assert wid not in json.loads((h.state / "pause.json").read_text())["sessions"]
    assert h.say(master, f"/peers do {wid} pause second window") == f"worker-b ({wid}): ok (paused)"
    wait_for(lambda: h.row(worker)["paused"] is True)
    assert h.say(worker, "/peers resume").startswith(f"resumed worker-b ({wid})")
    wait_for(lambda: h.row(worker)["paused"] is False)
    assert h.say(worker, "/peers resume").endswith("is not paused")
    print("PASS master pause/resume of another session and the session's own /peers resume both clear and set the state")

    requests = len(h.gateway.requests)
    start = len(worker.frames)
    sent = h.say(master, f"/peers msg {wid} hello after resume")
    assert sent.endswith(": ok") and "paused" not in sent, sent
    wait_for(lambda: any(f.get("type") == "agent_end" for f in worker.frames[start:]), seconds=30)
    time.sleep(1.0)
    assert len(h.gateway.requests) == requests + 1, h.gateway.requests[requests:]
    body = json.dumps(h.gateway.requests[-1][1])
    assert body.count("hello after resume") == 1 and "after restart" not in body and "anyone there" not in body and "still nobody" not in body
    assert sum(1 for f in worker.frames[start:] if f.get("type") == "agent_start") == 1
    print("PASS after resume the message is delivered exactly once; nothing refused earlier was queued")

    master_row = h.row(master)
    assert h.say(master, "/peers pause maintenance").startswith("paused ")
    wait_for(lambda: h.row(master)["paused"] is True)
    start, requests = len(master.frames), len(h.gateway.requests)
    watcher = rpc(master_row, {"op": "message", "text": "digest", "from": {"id": "completion-watcher", "name": "Completion watcher"}})
    assert watcher["status"] == "deferred" and watcher["paused"] is True and watcher["ok"] is False, watcher
    assert rpc(master_row, {"op": "status"})["ok"] is True
    assert_not_woken(h, master, start, requests)
    h.say(master, "/peers resume")
    wait_for(lambda: h.row(master)["paused"] is False)
    start = len(master.frames)
    assert rpc(master_row, {"op": "message", "text": "digest after resume", "from": {"id": "completion-watcher", "name": "Completion watcher"}})["ok"] is True
    wait_for(lambda: any(f.get("type") == "agent_end" for f in master.frames[start:]), seconds=30)
    print("PASS a paused master refuses the watcher's message RPC the same way, and accepts it after resume")
