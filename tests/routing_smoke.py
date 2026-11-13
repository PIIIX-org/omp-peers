#!/usr/bin/env python3
# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (c) 2026 PIIIX-org contributors
"""Real OMP/socket pin reports and failure atomicity, without successful prompt turns.

Successful prompts are exercised by the consumer regression; this actual host proof
uses model/effort controls and rejected prompts so no provider request is possible.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from smoke import OMP, Peer, REPO, wait_for

sys.path.insert(0, str(REPO / "tools"))
from watch import peer_rpc


def main():
    if not OMP:
        raise SystemExit("Install OMP before running this smoke test.")
    peers = []
    with tempfile.TemporaryDirectory(prefix="opr-", dir="/tmp") as root:
        home = Path(root)
        agent = home / ".omp/agent"
        agent.mkdir(parents=True)
        (agent / "config.yml").write_text(
            "autoResume: false\nsetupVersion: 2\nstartup:\n  setupWizard: false\n"
            "  checkUpdate: false\nrecap:\n  enabled: false\nproviders:\n  cacheWarming: off\n"
        )
        (agent / "models.yml").write_text(
            "providers:\n  smoke:\n    baseUrl: http://127.0.0.1:9/v1\n"
            "    api: openai-completions\n    auth: none\n    models:\n"
            "      - id: first\n        reasoning: true\n"
            "      - id: second\n        reasoning: true\n"
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
            response = peer_rpc(receiver, {"op": "prompt", "from": {"id": sender["id"]},
                                          "text": "Must never dispatch", "tier": "heavy", "overridePin": True,
                                          "model": "nonexistent/model", "effort": "max"})
            assert response["ok"] is False and "unavailable model" in response["error"], response
            after = status()
            assert (after["model"], after["effort"], after["routingPolicy"]) == (
                changed["model"], changed["effort"], changed["routingPolicy"]), after
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
            assert not any(f.get("type") in ("agent_start", "extension_error") for peer in peers for f in peer.frames)
            print("PASS actual OMP visible old/new routing, pin policy, unavailable failure and resume; no provider turns")
        finally:
            for peer in reversed(peers):
                if not peer.proc.stdin.closed:
                    peer.close()
        assert not list(registry.glob("p*.json")), "disposable registrations survived shutdown"
    print("PASS disposable OMP processes, homes and runtime state removed")


if __name__ == "__main__":
    main()
