#!/usr/bin/env python3
# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (c) 2026 PIIIX-org contributors
"""Exercise the installed plugin in two real OMP processes, without provider credentials."""
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time

REPO = Path(__file__).resolve().parents[1]
OMP = shutil.which("omp")


class Peer:
    def __init__(self, env, cwd):
        self.frames = []
        self.responses = queue.Queue()
        self.proc = subprocess.Popen(
            [OMP, "--mode", "rpc", "--no-session", "--no-title", "--no-tools",
             "--no-skills", "--no-rules", "--no-context-files", "--no-lsp",
             "--model", "smoke/first", "--system-prompt", "Offline plugin smoke."],
            env=env, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True,
        )
        self.errors = []
        self.readers = [
            threading.Thread(target=self.read, daemon=True),
            threading.Thread(target=lambda: self.errors.extend(self.proc.stderr), daemon=True),
        ]
        for reader in self.readers:
            reader.start()
        self.seq = 0

    def read(self):
        for line in self.proc.stdout:
            try:
                frame = json.loads(line)
            except ValueError:
                continue
            self.frames.append(frame)
            if frame.get("type") == "response":
                self.responses.put(frame)
        self.responses.put(None)

    def call(self, kind, **kwargs):
        self.seq += 1
        request_id = str(self.seq)
        self.proc.stdin.write(json.dumps({"type": kind, "id": request_id, **kwargs}) + "\n")
        self.proc.stdin.flush()
        deadline = time.monotonic() + 60
        while True:
            frame = self.responses.get(timeout=max(0.01, deadline - time.monotonic()))
            assert frame is not None, "OMP exited: " + "".join(self.errors)
            if frame.get("id") != request_id:
                continue
            assert frame.get("success"), frame
            return frame.get("data")

    def command(self, text, expected):
        start = len(self.frames)
        self.call("prompt", message=text)
        notices = wait_for(lambda: [
            f for f in self.frames[start:]
            if f.get("method") == "notify" and expected in json.dumps(f)
        ])
        assert not any(f.get("type") in ("agent_start", "extension_error")
                       for f in self.frames[start:]), self.frames[start:]
        print(f"PASS {text}: {expected}")

    def close(self):
        if self.proc.poll() is None:
            self.proc.stdin.close()
            try:
                self.proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait(timeout=5)
        for reader in self.readers:
            reader.join(timeout=5)
        for stream in (self.proc.stdout, self.proc.stderr):
            stream.close()


def wait_for(predicate, seconds=15):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError("Timed out waiting for plugin state")


def main():
    if not OMP:
        raise SystemExit("Install OMP before running this smoke test.")
    peers = []
    watcher = None
    # A short path keeps Unix socket names below macOS's sockaddr_un limit.
    with tempfile.TemporaryDirectory(prefix="opp-", dir="/tmp") as root:
        home = Path(root)
        agent = home / ".omp" / "agent"
        agent.mkdir(parents=True)
        (agent / "config.yml").write_text(
            "autoResume: false\nsetupVersion: 2\nstartup:\n  setupWizard: false\n"
            "  checkUpdate: false\nrecap:\n  enabled: false\n"
            "providers:\n  cacheWarming: off\n"
        )
        (agent / "models.yml").write_text(
            "providers:\n  smoke:\n    baseUrl: http://127.0.0.1:9/v1\n"
            "    api: openai-completions\n    auth: none\n    models:\n"
            "      - id: first\n        reasoning: true\n"
            "      - id: second\n        reasoning: true\n"
        )
        env = {"HOME": root, "PATH": os.environ["PATH"], "TERM": "dumb",
               "PI_CODING_AGENT_DIR": str(agent), "TMPDIR": root,
               "XDG_CONFIG_HOME": str(home / "config"),
               "XDG_DATA_HOME": str(home / "data"),
               "XDG_CACHE_HOME": str(home / "cache"),
               "XDG_STATE_HOME": str(home / "state")}
        try:
            installed = subprocess.run(
                [OMP, "plugin", "link", str(REPO)], env=env, cwd=root,
                capture_output=True, text=True, timeout=60,
            )
            assert installed.returncode == 0, installed.stdout + installed.stderr
            print("PASS OMP plugin link:", installed.stdout.strip())
            for _ in range(2):
                peer = Peer(env, root)
                peers.append(peer)
                peer.call("get_state")
            registry = home / ".omp" / "run" / "peers"

            def identities():
                rows = [json.loads(p.read_text()) for p in registry.glob("p*.json")]
                return {p["pid"]: p["id"] for p in rows} if len(rows) == 2 else None

            ids = wait_for(identities)
            master, worker = peers
            master_id, worker_id = ids[master.proc.pid], ids[worker.proc.pid]
            master.command("/peers list", worker_id)
            worker.command(f"/peers do {master_id} rename forbidden", "Not the master")
            master.command("/peers master", "now the master")
            worker.command("/peers lock", "refused")
            master.command(f"/peers do {worker_id} rename forbidden", "peer is locked")
            worker.command("/peers unlock", "allowed")
            master.command(f"/peers do {worker_id} rename smoke-worker", "ok")
            master.command(f"/peers do {worker_id} status", "smoke-worker")
            worker.command("/peers refuse", "refuse")
            master.command(f"/peers do {worker_id} status", "refuses inbound")
            worker.command("/peers accept", "accept")
            master.command(f"/peers do {worker_id} model smoke/second", "ok")
            assert worker.call("get_state")["model"]["id"] == "second"
            master.command(f"/peers do {worker_id} effort high", "effort=high")
            master.command(f"/peers do {worker_id} subagents task=smoke/second:high", "task=smoke/second:high")
            master.command(f"/peers set {worker_id} get auth.broker.url", "protected")
            watcher = subprocess.Popen(
                [sys.executable, str(REPO / "tools" / "watch.py")],
                env=env, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            wait_for(lambda: (home / ".omp-peer-watch" / "state.json").exists())
            worker.close()
            report, errors = watcher.communicate(timeout=15)
            assert watcher.returncode == 0 and "session GONE" in report, (report, errors)
            print("PASS watcher:", report.strip())
            master.command("/peers release", "released")
            master.close()
            assert not list(registry.glob("p*.json"))
            assert not list(registry.glob("*.sock"))
            assert not (registry / "master.json").exists()
            print("PASS shutdown removed disposable peer sockets, registry, and master claim")
        finally:
            if watcher is not None:
                if watcher.poll() is None:
                    watcher.terminate()
                watcher.communicate(timeout=10)
            for peer in peers:
                peer.close()
    print("PASS temporary home removed; no real sessions or credentials used")


if __name__ == "__main__":
    main()
