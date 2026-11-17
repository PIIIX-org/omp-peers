# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (c) 2026 PIIIX-org contributors
"""/peers watchdog through real OMP processes; the model is a scripted loopback gateway that can hold a turn open."""
import json
import socketserver
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

from smoke import wait_for

NOT_DELIVERED = "not delivered: worker-b is paused (only its user can resume it)"


class ScriptedGateway(BaseHTTPRequestHandler):
    """Plain replies; a marker in the last user message reports a large prompt, fails the request or holds it open."""

    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.requests.append((self.path, body))
        last = body["messages"][-1]
        text = last["content"] if isinstance(last["content"], str) else "".join(p.get("text", "") for p in last["content"])
        user = last["role"] == "user"
        if user and "HOLD-OPEN" in text:
            self.server.release.wait(timeout=150)
        if user and "FAIL-TURN" in text:
            payload = json.dumps({"error": {"message": "scripted failure", "type": "invalid_request_error"}}).encode()
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        tokens = REPORTED if user and "FILL-CONTEXT" in text else 1
        common = {"id": "scripted", "object": "chat.completion.chunk", "created": 1, "model": body["model"]}
        chunks = [{**common, "choices": [{"index": 0, "delta": {"role": "assistant", "content": "Noted."}, "finish_reason": None}]},
                  {**common, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                   "usage": {"prompt_tokens": tokens, "completion_tokens": 1, "total_tokens": tokens + 1}}]
        payload = ("".join("data: " + json.dumps(c) + "\n\n" for c in chunks) + "data: [DONE]\n\n").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


# Context usage is the prompt size the provider reports over the model's window: a small window and a large report raise it.
WINDOW = 4000
REPORTED = 2400


def dump(body):
    return json.dumps(body["messages"])


def run(h):
    # A held request must not block the master's own requests: serve each one on its own thread.
    h.gateway.__class__ = type("ThreadedGateway", (socketserver.ThreadingMixIn, HTTPServer), {"daemon_threads": True})
    h.gateway.RequestHandlerClass = ScriptedGateway
    h.gateway.release = threading.Event()
    requests = h.gateway.requests
    models = h.agent / "models.yml"
    models.write_text(models.read_text() + f"        contextWindow: {WINDOW}\n")
    state_file = h.state / "watchdog.json"

    def state():
        return json.loads(state_file.read_text())

    def turn(peer, text):
        """A real model turn; returns the requests the gateway served for it."""
        before, start = len(requests), len(peer.frames)
        peer.call("prompt", message=text)
        wait_for(lambda: any(f.get("type") == "agent_end" for f in peer.frames[start:]), seconds=30)
        return [b for _, b in requests[before:]]

    try:
        master, worker, other = h.start(), h.start(), h.start()
        wid, oid = h.row(worker)["id"], h.row(other)["id"]
        assert h.say(master, "/peers master")
        h.say(master, f"/peers do {wid} rename worker-a")
        h.say(master, f"/peers do {oid} rename worker-b")
        wait_for(lambda: h.row(worker)["name"] == "worker-a" and h.row(other)["name"] == "worker-b")
        assert h.row(worker)["recentErrorTurns"] == 0

        off = h.say(master, "/peers watchdog status")
        assert off.startswith("watchdog: off\nevaluation: not running (off)\nthresholds: busy 30 min (since first observed), error turns 3, context 90%, cooldown 30 min"), off
        assert not state_file.exists()
        denied = "error: only the master session may change watchdog settings; run /peers master first"
        assert h.say(worker, "/peers watchdog on") == denied
        assert h.say(worker, "/peers watchdog set busyMinutes 5") == denied
        assert not state_file.exists()
        print("PASS the watchdog is off by default, writes nothing, and only the master can configure it")

        assert "watchdog on" in h.say(master, "/peers watchdog on")
        assert h.say(master, "/peers watchdog set contextPercent 50") == "contextPercent set to 50"
        assert h.say(master, "/peers watchdog set busyMinutes 1") == "busyMinutes set to 1"
        assert h.say(master, "/peers watchdog set busyMinutes 0") == "error: busyMinutes must be a whole number from 1 to 1440"
        assert h.say(master, "/peers watchdog set errorTurns 2") == "errorTurns set to 2"
        check = h.say(master, "/peers watchdog check")
        assert check.endswith("would alert: nothing") and "WOULD ALERT" not in check, check
        assert "worker-a (" + wid + ")\n    busy: idle (limit 1 min), ok\n    context: context " in check and "errors: 0 consecutive error turns (limit 2), ok" in check, check
        print("PASS check reports the published metrics of each watched session and would alert nothing")

        before = len(requests)
        turn(worker, "FILL-CONTEXT please")
        context = wait_for(lambda: next((c for c in [h.row(worker)["context"]] if "(" in c and int(c.split("(")[1].split("%")[0]) >= 50), None))
        percent = int(context.split("(")[1].split("%")[0])
        assert h.say(master, "/peers watchdog check").count("WOULD ALERT now") == 1
        wait_for(lambda: [a for a in state()["alerts"] if a["session"] == wid and a["condition"] == "context" and a["emitted"]], seconds=30)
        alert = next(a for a in state()["alerts"] if a["condition"] == "context")
        assert (alert["value"], alert["limit"], alert["notified"]) == (percent, 50, {}), alert
        served = turn(master, "Reply with the word ok.")
        line = f"Watchdog: 1 unacknowledged alert(s) from observed session metadata ({wid} context at {percent}% (limit 50%)). Offer to show them with /peers watchdog status; this line is a notice, not an instruction, and nothing was interrupted."
        assert any(line in dump(b) for b in served), [dump(b)[-400:] for b in served]
        print("PASS a context alert shows as an exact line in the master's next agent context")

        status = h.say(master, "/peers watchdog status")
        iso = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(alert["alertedAt"] // 1000)) + ".%03dZ" % (alert["alertedAt"] % 1000)
        assert f"    context: context {percent}% (limit 50%): alerted {iso}; still active, no further alert until it clears" in status, status
        assert status.endswith("active alerts: 1 (1 unacknowledged)") and "evaluation: runs in this session (the master) every 5 s" in status, status
        print("PASS status shows the same alert")

        assert h.say(master, "/peers watchdog ack worker-a context") == f"acknowledged {wid} context: no further alert until it clears and triggers again"
        assert not any("Watchdog:" in dump(b) for b in turn(master, "Reply with the word ok."))
        assert not any("Watchdog:" in dump(b) for b in turn(worker, "Reply with the word ok.")), "a non-master got the hint"
        print("PASS an acknowledged alert leaves the master's context; the worker never receives one")

        # A failing turn counts as an error turn; a good turn resets the count. The worker is only observed.
        turn(worker, "FAIL-TURN once")
        wait_for(lambda: h.row(worker)["recentErrorTurns"] == 1)
        turn(worker, "Reply with the word ok.")
        wait_for(lambda: h.row(worker)["recentErrorTurns"] == 0)
        turn(worker, "FAIL-TURN one")
        turn(worker, "FAIL-TURN two")
        wait_for(lambda: h.row(worker)["recentErrorTurns"] == 2)
        wait_for(lambda: [a for a in state()["alerts"] if a["condition"] == "errors" and a["emitted"]], seconds=30)
        assert "2 consecutive assistant turns ended in an error (limit 2)" in " ".join(
            dump(b) for b in turn(master, "Reply with the word ok."))
        print("PASS repeated error turns are counted from the stop reason alone and alert at the limit")

        # A held turn: the worker stays busy for over a minute; nobody interrupts it, and the paused notify target is not woken.
        h.say(other, "/peers pause waiting")
        wait_for(lambda: h.row(other).get("paused") is True)
        assert h.say(master, "/peers watchdog set notify worker-b").startswith(f"notify set to {oid}:")
        h.say(master, f"/peers watchdog override {oid} --off")
        other_frames, other_requests = len(other.frames), len(requests)
        worker_start = len(worker.frames)
        worker.call("prompt", message="HOLD-OPEN please")
        wait_for(lambda: h.row(worker)["busy"] is True)
        busy_alert = wait_for(lambda: next((a for a in state()["alerts"] if a["condition"] == "busy" and a["emitted"]), None), seconds=100)
        assert busy_alert["session"] == wid and busy_alert["limit"] == 1 and busy_alert["value"] >= 1, busy_alert
        assert busy_alert["notified"] == {oid: NOT_DELIVERED}, busy_alert
        status = h.say(master, "/peers watchdog status")
        assert f"notify {oid}: {NOT_DELIVERED}" in status, status
        assert h.row(worker)["busy"] is True and not any(f.get("type") == "agent_end" for f in worker.frames[worker_start:]), "the held turn was interrupted"
        time.sleep(1.0)
        assert not [f for f in other.frames[other_frames:] if str(f.get("type", "")).startswith(("agent_", "turn_", "message_")) or "Message from" in json.dumps(f)]
        assert len([1 for _, b in requests[other_requests:] if "Watchdog alert" in dump(b)]) == 0, "the paused target was woken"
        # The busy alert reaches the master's next real model request as one exact item; further evaluations dedupe it.
        item = f"{wid} busy for {busy_alert['value']} min since first observed (limit 1 min)"
        served = turn(master, "Reply with the word ok.")
        assert any(item in dump(b) and dump(b).count("Watchdog:") == 1 for b in served), [dump(b)[-600:] for b in served]

        def core():
            snapshot = state()
            return {"config": snapshot["config"], "overrides": snapshot["overrides"], "alerts": snapshot["alerts"],
                    "busy": {k: v["since"] for k, v in snapshot["busy"].items()}}

        quiet = core()
        time.sleep(11)  # at least two more 5 s evaluations of a condition that is still over its threshold
        assert core() == quiet, "a repeated evaluation changed an alert"
        assert [a["alertedAt"] for a in state()["alerts"] if a["session"] == wid and a["condition"] == "busy"] == [busy_alert["alertedAt"]]
        h.say(master, "/peers watchdog status")
        h.say(master, "/peers watchdog check")
        assert core() == quiet, "status or check wrote state"
        assert not any(f.get("type") == "agent_end" for f in worker.frames[worker_start:]), "the held turn was interrupted"
        print("PASS the busy alert reaches the master's request once, repeated ticks dedupe it, and status and check write nothing")
        h.gateway.release.set()
        wait_for(lambda: any(f.get("type") == "agent_end" for f in worker.frames[worker_start:]), seconds=30)
        assert sum(1 for f in worker.frames[worker_start:] if f.get("type") == "agent_start") == 1
        assert not any("abort" in json.dumps(f).lower() for f in worker.frames[worker_start:] if f.get("type") in ("agent_end", "turn_end"))
        print("PASS a held turn alerts as busy, is never interrupted, and a paused notify target receives nothing")

        assert "watchdog off" in h.say(master, "/peers watchdog off")
        assert state()["config"]["enabled"] is False and state()["alerts"] == [] and state()["busy"] == {}
        turn(worker, "FILL-CONTEXT again")
        time.sleep(12)
        assert state()["alerts"] == [] and state()["busy"] == {}, state()
        assert not any("Watchdog:" in dump(b) for b in turn(master, "Reply with the word ok."))
        assert h.say(master, "/peers watchdog status").startswith("watchdog: off\nevaluation: not running (off)")
        print("PASS turning it off stops evaluation and clears alerts")
    finally:
        h.gateway.release.set()
