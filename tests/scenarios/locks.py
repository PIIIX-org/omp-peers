# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (c) 2026 PIIIX-org contributors
"""/peers locks and the peers_lock tool through real OMP processes; the model is a scripted loopback gateway."""
import json
import re
import stat
import time
from http.server import BaseHTTPRequestHandler

from smoke import wait_for

TIME = r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z"


class ScriptedGateway(BaseHTTPRequestHandler):
    """Plain text replies, except that a prompt carrying a marker makes the model call peers_lock once."""

    CALLS = {
        "TOOL-ACQUIRE": {"action": "acquire", "name": "tool-demo", "ttl_seconds": 60, "note": "via tool"},
        "TOOL-STATUS": {"action": "status", "name": "tool-demo"},
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
                                                           "function": {"name": "peers_lock", "arguments": json.dumps(call)}}]}
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

    def turn(peer, text):
        """A real model turn; returns the requests the gateway served for it."""
        before, start = len(requests), len(peer.frames)
        peer.call("prompt", message=text)
        wait_for(lambda: any(f.get("type") == "agent_end" for f in peer.frames[start:]), seconds=30)
        return [b for _, b in requests[before:]]

    master, one, two = h.start(), h.start(), h.start()
    one_row, two_row = h.row(one), h.row(two)
    h.row(master)
    assert h.say(master, "/peers master")
    h.say(master, f"/peers do {one_row['id']} rename worker-a")
    h.say(master, f"/peers do {two_row['id']} rename worker-b")
    wait_for(lambda: h.row(one)["name"] == "worker-a" and h.row(two)["name"] == "worker-b")
    a, b = one_row["id"], two_row["id"]

    got = h.say(one, "/peers locks acquire heavy-build --ttl 120 --note nightly build")
    assert re.fullmatch(rf"acquired heavy-build: lease l1, expires in (2m|1m 59s) \({TIME}\); 1 of 1 slot in use\. "
                        r"Renew before it expires and release when done\.", got), got
    print("PASS worker-a acquires heavy-build")

    busy = h.say(two, "/peers locks acquire heavy-build")
    lines = busy.split("\n")
    assert re.fullmatch(rf"busy heavy-build: all 1 slot is held; nothing was acquired and nothing is waiting\. "
                        rf"Earliest slot frees in (2m|1m 59s|1m 58s) \({TIME}\) unless released sooner\. "
                        r"Do other work and try again later\.", lines[0]), lines[0]
    assert len(lines) == 2 and re.fullmatch(rf"  l1  worker-a \({a}\)  expires in (2m|1m \d\ds|1m \ds) \({TIME}\)  note: nightly build", lines[1]), lines
    mismatch = h.say(two, "/peers locks acquire heavy-build --capacity 3")
    assert mismatch == ("refused: capacity mismatch: heavy-build was created with capacity 1 (requested 3); "
                        "the capacity is fixed until every lease on it has ended"), mismatch
    print("PASS the second session gets busy naming the holder; a capacity mismatch is refused")

    assert h.say(two, "/peers locks release heavy-build") == "refused: this session holds no active lease on heavy-build; only the owner may release it"
    file = h.state / "locks.json"
    before = (file.read_bytes(), file.stat().st_mtime_ns)
    served = len(requests)
    status = h.say(master, "/peers locks status")
    assert status.split("\n")[0] == "heavy-build: 1 of 1 slot in use (busy)" and f"worker-a ({a})" in status, status
    assert h.say(two, "/peers locks status heavy-build") == status
    assert (file.read_bytes(), file.stat().st_mtime_ns) == before, "status modified the store"
    time.sleep(0.5)
    assert len(requests) == served, "status started a model turn"
    print("PASS only the owner releases; status is read-only and wakes nobody")

    denied = h.say(two, f"/peers locks force-release heavy-build {a} --yes-live")
    assert denied == "refused: only the master session may force-release a lease; run /peers master first", denied
    live = h.say(master, f"/peers locks force-release heavy-build {a}")
    assert live.startswith("refused: l1 held by worker-a") and "has not expired" in live and live.endswith("add --yes-live to do it anyway"), live
    assert json.loads(file.read_text())["resources"][0]["leases"][0]["owner"] == a
    print("PASS force-release is master-only and refuses a live lease without --yes-live")

    session_file = one.call("get_state")["sessionFile"]
    one.close()
    wait_for(lambda: not any(json.loads(f.read_text())["id"] == a for f in h.registry.glob("p*.json")))
    assert h.say(two, "/peers locks acquire heavy-build").startswith("busy heavy-build:"), "a parked owner's live lease was stolen"
    one = h.start(resume=session_file)
    assert h.row(one)["id"] == a
    assert f"worker-a ({a}, this session, earlier instance)" in h.say(one, "/peers locks status heavy-build")
    renewed = h.say(one, "/peers locks renew heavy-build --ttl 300")
    assert re.fullmatch(rf"renewed heavy-build: lease l1 now expires in (5m|4m 59s) \({TIME}\); 1 of 1 in use", renewed), renewed
    assert f"worker-a ({a}, this session)" in h.say(one, "/peers locks status heavy-build")
    print("PASS a restarted owner keeps its unexpired lease, renews it, and nobody else could take it")

    assert h.say(one, "/peers locks release heavy-build") == "released heavy-build: lease l1"
    got = h.say(two, "/peers locks acquire heavy-build --ttl 60")
    assert re.fullmatch(rf"acquired heavy-build: lease l2, expires in (1m|59s) \({TIME}\); 1 of 1 slot in use\. "
                        r"Renew before it expires and release when done\.", got), got
    print("PASS a release lets the waiting session acquire")

    served = turn(one, "TOOL-ACQUIRE please")
    assert any(t["function"]["name"] == "peers_lock" for b_ in served for t in b_.get("tools", [])), "tool not offered to the model"
    assert any("acquired tool-demo: lease l3, expires in" in dump(b_) for b_ in served), [dump(b_)[-300:] for b_ in served]
    served = turn(two, "TOOL-ACQUIRE please")
    assert any("busy tool-demo: all 1 slot is held; nothing was acquired and nothing is waiting." in dump(b_) and f"worker-a ({a}, this session" not in dump(b_)
               and f"worker-a ({a})" in dump(b_) for b_ in served), [dump(b_)[-500:] for b_ in served]
    served = turn(two, "TOOL-STATUS please")
    assert any("tool-demo: 1 of 1 slot in use (busy)" in dump(b_) for b_ in served)
    print("PASS the peers_lock tool acquires for one session and reports busy to the other")

    raw = file.read_text()
    assert stat.S_IMODE(h.state.stat().st_mode) == 0o700 and stat.S_IMODE(file.stat().st_mode) == 0o600
    state = json.loads(raw)
    assert state["version"] == 1 and sorted(r["name"] for r in state["resources"]) == ["heavy-build", "tool-demo"], state
    print("PASS locks.json is version 1, 0600 in a 0700 directory")
