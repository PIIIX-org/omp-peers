#!/usr/bin/env python3
# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (c) 2026 PIIIX-org contributors
"""Real OMP/socket routing proof; model turns terminate at a loopback fake gateway."""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
import socket
from pathlib import Path
import subprocess
import sys
import tempfile
import threading

from smoke import OMP, Peer, REPO, wait_for

sys.path.insert(0, str(REPO / "tools"))
from watch import peer_rpc


class FakeGateway(BaseHTTPRequestHandler):
    """Capture the real transport's upstream restriction, without external calls."""

    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.requests.append((self.path, body))
        common = {"id": "offline-proof", "object": "chat.completion.chunk",
                  "created": 1, "model": body["model"]}
        chunks = [
            {**common, "choices": [{"index": 0, "delta": {
                "role": "assistant", "content": "Offline proof."}, "finish_reason": None}]},
            {**common, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
             "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
        ]
        payload = "".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks)
        payload = (payload + "data: [DONE]\n\n").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def main():
    if not OMP:
        raise SystemExit("Install OMP before running this smoke test.")
    peers = []
    with tempfile.TemporaryDirectory(prefix="opr-", dir="/tmp") as root:
        home = Path(root)
        agent = home / ".omp/agent"
        agent.mkdir(parents=True)
        gateway = HTTPServer(("127.0.0.1", 0), FakeGateway)
        gateway.requests = []
        serving = threading.Thread(target=gateway.serve_forever,
                                   kwargs={"poll_interval": 0.05}, daemon=True)
        serving.start()
        (agent / "config.yml").write_text(
            "autoResume: false\nsetupVersion: 2\nstartup:\n  setupWizard: false\n"
            "  checkUpdate: false\nrecap:\n  enabled: false\nproviders:\n  cacheWarming: off\n"
        )
        (agent / "models.yml").write_text(
            "providers:\n  smoke:\n    baseUrl: http://127.0.0.1:9/v1\n"
            "    api: openai-completions\n    auth: none\n    models:\n"
            "      - id: first\n        reasoning: true\n"
            "      - id: second\n        reasoning: true\n"
            f"  openrouter:\n    baseUrl: http://127.0.0.1:{gateway.server_port}/v1\n"
            "    api: openai-completions\n    auth: none\n    models:\n"
            "      - id: offline-route\n        reasoning: true\n"
        )
        env = {"HOME": root, "PATH": os.environ["PATH"], "TERM": "dumb",
               "PI_CODING_AGENT_DIR": str(agent), "TMPDIR": root,
               "XDG_CONFIG_HOME": str(home / "config"), "XDG_DATA_HOME": str(home / "data"),
               "XDG_CACHE_HOME": str(home / "cache"), "XDG_STATE_HOME": str(home / "state")}
        registry = home / ".omp/run/peers"
        try:
            installed = subprocess.run([OMP, "plugin", "link", str(REPO)], env=env, cwd=root,
                                       capture_output=True, text=True, timeout=60)
            assert installed.returncode == 0, installed.stdout + installed.stderr
            for _ in range(2):
                peer = Peer(env, root)
                peers.append(peer)
                peer.call("get_state")
                peer.call("new_session")

            def identities():
                rows = [json.loads(p.read_text()) for p in registry.glob("p*.json")]
                return {p["pid"]: p for p in rows} if len(rows) == 2 else None

            rows = wait_for(identities)
            master, worker = peers
            sender, receiver = rows[master.proc.pid], rows[worker.proc.pid]
            master.command("/peers master", "now the master")
            status = lambda: peer_rpc(receiver, {"op": "status"})["info"]
            assert status()["routingPolicy"] == "keep"
            worker.command("/peers unpin", "policy: auto")
            assert status()["routingPolicy"] == "auto"
            master.command(f"/peers do {receiver['id']} effort high", "explicit master override")
            master.command(f"/peers do {receiver['id']} model smoke/second", "smoke/first -> smoke/second")
            changed = status()
            assert changed["model"] == "smoke/second" and changed["effort"] == "high", changed
            assert changed["routingPolicy"] == "keep", changed
            wait_for(lambda: any(f.get("method") == "notify" and "smoke/first -> smoke/second" in json.dumps(f)
                                 for f in worker.frames))
            messages = worker.call("get_messages")["messages"]
            assert any(m.get("customType") == "peer-routing" and m.get("display") is True
                       and "smoke/first -> smoke/second" in str(m.get("content")) for m in messages), messages
            # Notification RPC intentionally rejects negative acknowledgements; inspect this failure directly.
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(2)
                connection.connect(receiver["sock"])
                connection.sendall(json.dumps({"op": "prompt", "from": {"id": sender["id"]},
                                               "text": "Must never dispatch", "tier": "heavy", "overridePin": True,
                                               "model": "nonexistent/model", "effort": "max"}).encode() + b"\n")
                with connection.makefile("rb") as source:
                    response = json.loads(source.readline())
            assert response["ok"] is False and "unavailable model" in response["error"], response
            after = status()
            assert (after["model"], after["effort"], after["routingPolicy"]) == (
                changed["model"], changed["effort"], changed["routingPolicy"]), after
            previous = changed["model"]
            for index, upstream in enumerate(("cerebras", "sambanova"), 1):
                selected = f"openrouter/offline-route@{upstream}"
                transition = f"{previous} -> {selected}"
                start = len(worker.frames)
                master.command(f"/peers do {receiver['id']} model {selected}", transition)
                wait_for(lambda: any(f.get("method") == "notify" and transition in json.dumps(f)
                                     for f in worker.frames[start:]))
                messages = worker.call("get_messages")["messages"]
                assert any(m.get("customType") == "peer-routing" and m.get("display") is True
                           and transition in str(m.get("content")) for m in messages), messages
                assert status()["model"] == selected, status()
                start = len(worker.frames)
                worker.call("prompt", message="Reply using the offline fake gateway.")
                wait_for(lambda: any(f.get("type") == "agent_end" for f in worker.frames[start:]))
                assert len(gateway.requests) == index, gateway.requests
                route, request = gateway.requests[-1]
                assert route == "/v1/chat/completions", route
                assert request["model"] == "offline-route", request
                assert request.get("provider", {}).get("only") == [upstream], request
                assert status()["model"] == selected, status()
                print(f"PASS sender + receiver visible {transition}; status.model={selected}; "
                      f"loopback request provider.only=[{upstream}]")
                previous = selected
            # Local opt-in survives an actual host resume; explicit controls re-pin above.
            worker.command("/peers unpin", "policy: auto")
            session_file = worker.call("get_state")["sessionFile"]
            worker.close()
            worker = Peer(env, root, resume=session_file)
            peers.append(worker)
            worker.call("get_state")
            receiver = wait_for(lambda: next((json.loads(p.read_text()) for p in registry.glob("p*.json")
                                             if json.loads(p.read_text())["pid"] == worker.proc.pid), None))
            assert status()["routingPolicy"] == "auto"
            worker.command("/peers pin", "policy: keep")
            assert status()["routingPolicy"] == "keep"
            assert not any(f.get("type") == "extension_error" for peer in peers for f in peer.frames)
            assert not any(f.get("type") == "agent_start" for f in master.frames)
            assert sum(f.get("type") == "agent_start" for f in peers[1].frames) == 2
            print("PASS actual OMP pin, unavailable failure, upstream-only reports/status/transport and resume; no external provider calls")
        finally:
            for peer in reversed(peers):
                if not peer.proc.stdin.closed:
                    peer.close()
            gateway.shutdown()
            serving.join(timeout=5)
            gateway.server_close()
            assert not serving.is_alive(), "fake gateway thread survived cleanup"
        assert not list(registry.glob("p*.json")), "disposable registrations survived shutdown"
    print("PASS disposable OMP processes, homes and runtime state removed")


if __name__ == "__main__":
    main()
