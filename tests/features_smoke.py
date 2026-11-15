#!/usr/bin/env python3
# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (c) 2026 PIIIX-org contributors
"""Run each tests/scenarios/<name>.py against real OMP processes in a disposable HOME.

A scenario module defines `run(h)` taking a `Harness`: an isolated HOME with the plugin linked and
a keyless loopback gateway (`h.gateway.requests`) standing in for the model provider. Pass scenario
names as arguments to run a subset.
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from http.server import HTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parent))
from routing_smoke import FakeGateway
from smoke import OMP, Peer, REPO, wait_for

SCENARIOS = Path(__file__).resolve().parent / "scenarios"


class Harness:
    def __init__(self, root):
        self.root = Path(root)
        self.home = self.root
        self.agent = self.home / ".omp/agent"
        self.registry = self.home / ".omp/run/peers"
        self.state = self.agent / "peer-state"
        self.peers = []
        self.agent.mkdir(parents=True)
        self.gateway = HTTPServer(("127.0.0.1", 0), FakeGateway)
        self.gateway.requests = []
        self.serving = threading.Thread(target=self.gateway.serve_forever,
                                        kwargs={"poll_interval": 0.05}, daemon=True)
        self.serving.start()
        (self.agent / "config.yml").write_text(
            "autoResume: false\nsetupVersion: 2\nstartup:\n  setupWizard: false\n"
            "  checkUpdate: false\nrecap:\n  enabled: false\nproviders:\n  cacheWarming: off\n"
        )
        (self.agent / "models.yml").write_text(
            f"providers:\n  smoke:\n    baseUrl: http://127.0.0.1:{self.gateway.server_port}/v1\n"
            "    api: openai-completions\n    auth: none\n    models:\n      - id: first\n"
        )
        self.env = {"HOME": str(self.home), "PATH": os.environ["PATH"], "TERM": "dumb",
                    "PI_CODING_AGENT_DIR": str(self.agent), "TMPDIR": str(self.home),
                    "XDG_CONFIG_HOME": str(self.home / "config"), "XDG_DATA_HOME": str(self.home / "data"),
                    "XDG_CACHE_HOME": str(self.home / "cache"), "XDG_STATE_HOME": str(self.home / "state")}
        installed = subprocess.run([OMP, "plugin", "link", str(REPO)], env=self.env, cwd=self.home,
                                   capture_output=True, text=True, timeout=60)
        assert installed.returncode == 0, installed.stdout + installed.stderr

    def start(self, resume=None):
        peer = Peer(self.env, str(self.home), resume=resume)
        self.peers.append(peer)
        peer.call("get_state")
        if resume is None:
            peer.call("new_session")
        return peer

    def row(self, peer):
        """The peer's registry row, once published."""
        def find():
            for path in self.registry.glob("p*.json"):
                row = json.loads(path.read_text())
                if row["pid"] == peer.proc.pid:
                    return row
        return wait_for(find)

    def say(self, peer, command):
        """Run a slash command in `peer`; return its notification text. Never starts a model turn."""
        start = len(peer.frames)
        peer.call("prompt", message=command)
        frame = wait_for(lambda: next((f for f in peer.frames[start:] if f.get("method") == "notify"), None))
        assert not any(f.get("type") == "agent_start" for f in peer.frames[start:]), command
        return frame["message"]

    def ask(self, peer, text):
        """Send a real prompt; return the request the loopback gateway received for it."""
        before = len(self.gateway.requests)
        start = len(peer.frames)
        peer.call("prompt", message=text)
        wait_for(lambda: any(f.get("type") == "agent_end" for f in peer.frames[start:]), seconds=30)
        assert len(self.gateway.requests) == before + 1, self.gateway.requests[before:]
        return self.gateway.requests[-1][1]

    def close(self):
        for peer in reversed(self.peers):
            if not peer.proc.stdin.closed:
                peer.close()
        self.gateway.shutdown()
        self.serving.join(timeout=5)
        self.gateway.server_close()
        assert not self.serving.is_alive(), "fake gateway thread survived cleanup"
        assert not list(self.registry.glob("p*.json")), "disposable registrations survived shutdown"
        assert not any(f.get("type") == "extension_error" for p in self.peers for f in p.frames), "extension error"


def load(path):
    spec = importlib.util.spec_from_file_location("scenario_" + path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    if not OMP:
        raise SystemExit("Install OMP before running this smoke test.")
    wanted = set(sys.argv[1:])
    paths = sorted(p for p in SCENARIOS.glob("*.py") if not p.name.startswith("_") and (not wanted or p.stem in wanted))
    assert paths, "no scenarios selected"
    for path in paths:
        # A short path keeps Unix socket names below macOS's sockaddr_un limit.
        with tempfile.TemporaryDirectory(prefix="opx-", dir="/tmp") as root:
            h = Harness(root)
            try:
                load(path).run(h)
            finally:
                h.close()
        print(f"PASS scenario {path.stem}; disposable processes, home and gateway removed")


if __name__ == "__main__":
    main()
