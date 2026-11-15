# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (c) 2026 PIIIX-org contributors
"""/peers inbox and the peers_decision tool through real OMP processes; the model is a scripted loopback gateway."""
import json
import stat
import time
from http.server import BaseHTTPRequestHandler

from smoke import wait_for

RECEIVED = "Decision for your inbox question"


class ScriptedGateway(BaseHTTPRequestHandler):
    """Plain text replies, except that a prompt carrying a marker makes the model call peers_decision once."""

    CALLS = {
        "QUEUE-DECISION": {"action": "ask", "question": "Which release channel?", "context": "Both channels are green.",
                           "options": ["stable", "beta"]},
        "CHECK-DECISION": {"action": "check"},
    }

    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.requests.append((self.path, body))
        last = body["messages"][-1]
        text = last["content"] if isinstance(last["content"], str) else "".join(p.get("text", "") for p in last["content"])
        call = next((args for marker, args in self.CALLS.items() if last["role"] == "user" and marker in text), None)
        common = {"id": "scripted", "object": "chat.completion.chunk", "created": 1, "model": body["model"]}
        if call:
            delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": "call_1", "type": "function",
                                                           "function": {"name": "peers_decision", "arguments": json.dumps(call)}}]}
            finish = "tool_calls"
        else:
            delta, finish = {"role": "assistant", "content": "Noted."}, "stop"
        chunks = [{**common, "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                  {**common, "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
                   "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}]
        payload = ("".join("data: " + json.dumps(c) + "\n\n" for c in chunks) + "data: [DONE]\n\n").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def dump(body):
    return json.dumps(body["messages"])


def run(h):
    h.gateway.RequestHandlerClass = ScriptedGateway
    requests = h.gateway.requests

    def received(question_id):
        """Gateway requests whose conversation carries the delivered decision for `question_id`."""
        return [b for _, b in requests if f"{RECEIVED} {question_id}" in dump(b)]

    def turn(peer, text):
        """A real model turn; returns the requests the gateway served for it."""
        before, start = len(requests), len(peer.frames)
        peer.call("prompt", message=text)
        wait_for(lambda: any(f.get("type") == "agent_end" for f in peer.frames[start:]), seconds=30)
        return [b for _, b in requests[before:]]

    master, worker = h.start(), h.start()
    worker_row = h.row(worker)
    h.row(master)
    assert h.say(master, "/peers master")
    h.say(master, f"/peers do {worker_row['id']} rename worker-a")
    wait_for(lambda: h.row(worker)["name"] == "worker-a")

    first = h.say(worker, "/peers inbox ask Ship the release today?")
    assert first == "queued q1: Ship the release today?", first
    assert "q1 is already queued (open)" in h.say(worker, "/peers inbox ask   ship the RELEASE today")
    served = turn(worker, "QUEUE-DECISION please")
    assert any("queued q2" in dump(b) for b in served), [dump(b)[-300:] for b in served]
    assert any(t["function"]["name"] == "peers_decision" for b in served for t in b.get("tools", [])), "tool not offered to the model"
    print("PASS worker queues via command and tool; the retry deduplicates to the same id")

    credential = h.say(worker, "/peers inbox ask use password=" + "abcd1234" + "efgh5678 for deploy?")
    assert credential.startswith("error:") and "credential" in credential and "abcd1234" not in credential, credential
    print("PASS a credential-looking question is rejected")

    file = h.state / "inbox.json"
    before = (file.read_bytes(), file.stat().st_mtime_ns)
    served_before = len(requests)
    listing = h.say(master, "/peers inbox")
    for expected in ("inbox: 2 open", "from worker-a (" + worker_row["id"] + ") [live]", "q1  open", "question: Ship the release today?",
                     "q2  open", "question: Which release channel?", "context: Both channels are green.",
                     "requested decision: choose one of: stable | beta"):
        assert expected in listing, (expected, listing)
    assert (file.read_bytes(), file.stat().st_mtime_ns) == before, "listing modified the store"
    assert "q1  open" in h.say(worker, "/peers inbox list")
    time.sleep(0.5)
    assert len(requests) == served_before, "listing started a model turn"
    print("PASS the master lists questions grouped by source; listing writes nothing and wakes nobody")

    # The master is told (count and ids only) that questions are open; other sessions are not.
    line = "Decision inbox: 2 open question(s) from other sessions (q1, q2)."
    master_turn = turn(master, "Reply with the word ok.")
    assert any(line in dump(b) for b in master_turn), [dump(b)[-300:] for b in master_turn]
    assert not any("Ship the release today" in dump(b) and line in dump(b) for b in master_turn)
    assert not any("Decision inbox:" in dump(b) for b in turn(worker, "Reply with the word ok."))
    print("PASS the master's next agent start carries only the open count and ids; other sessions get nothing")

    denied = h.say(worker, "/peers inbox answer q1 yes")
    assert denied == "error: only the master session may answer, defer, reopen or retry inbox questions; run /peers master first", denied
    assert json.loads(file.read_text())["entries"][0]["state"] == "open"
    print("PASS a non-master session cannot answer")

    answered = h.say(master, "/peers inbox answer q1 yes, ship it")
    assert "q1 answered; the answer was delivered to worker-a" in answered, answered
    wait_for(lambda: len(received("q1")) >= 1, seconds=30)
    time.sleep(1)
    assert len(received("q1")) == 1 and "Decision: yes, ship it" in dump(received("q1")[0]), len(received("q1"))
    assert "delivery: delivered" in h.say(master, "/peers inbox list")
    assert "already delivered" in h.say(master, "/peers inbox retry q1")
    print("PASS the answer reaches the live source exactly once and delivery is recorded")

    served_before = len(requests)
    assert "q2 deferred; nothing was sent" in h.say(master, "/peers inbox defer q2 revisit next week")
    time.sleep(0.5)
    assert len(requests) == served_before and not received("q2")
    print("PASS deferring sends nothing")

    assert h.say(worker, "/peers inbox ask Rotate the logs?") == "queued q3: Rotate the logs?"
    session_file = worker.call("get_state")["sessionFile"]
    worker.close()
    wait_for(lambda: not any(p["id"] == worker_row["id"] for p in map(lambda f: json.loads(f.read_text()), h.registry.glob("p*.json"))))
    listing = h.say(master, "/peers inbox list --open")
    assert "from worker-a (" + worker_row["id"] + ") [not live]" in listing and "q3  open" in listing and "q2" not in listing, listing
    offline = h.say(master, "/peers inbox answer q3 yes, rotate them")
    assert "delivery is pending" in offline, offline
    assert not any(json.loads(f.read_text())["id"] == worker_row["id"] for f in h.registry.glob("p*.json")), "answering resumed the parked session"
    print("PASS an offline source keeps the answer pending and is never resumed")

    worker = h.start(resume=session_file)
    assert h.row(worker)["id"] == worker_row["id"]
    assert not received("q3")
    state = json.loads(file.read_text())
    assert [(e["id"], e["state"], e["delivery"]) for e in state["entries"]] == [
        ("q1", "answered", "delivered"), ("q2", "deferred", "pending"), ("q3", "answered", "pending")], state
    served = turn(worker, "CHECK-DECISION please")
    assert any("q3 answered: yes, rotate them" in dump(b) for b in served), [dump(b)[-400:] for b in served]
    assert any("q2 deferred by the user: revisit next week" in dump(b) for b in served)
    print("PASS after a restart the asker reads its resolutions with peers_decision check")

    retried = h.say(master, "/peers inbox retry q3")
    assert "delivered to worker-a" in retried, retried
    wait_for(lambda: len(received("q3")) >= 1, seconds=30)
    time.sleep(1)
    assert len(received("q3")) == 1
    print("PASS retry delivers the pending answer to the restarted session once")

    raw = file.read_text()
    assert stat.S_IMODE(h.state.stat().st_mode) == 0o700 and stat.S_IMODE(file.stat().st_mode) == 0o600
    assert json.loads(raw)["version"] == 1 and "abcd1234" not in raw
    print("PASS inbox.json is version 1, 0600 in a 0700 directory, without the rejected credential")
