#!/usr/bin/env python3
# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (c) 2026 PIIIX-org contributors
"""Exercise the installed plugin in two real OMP processes, without provider credentials."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import queue
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time

REPO = Path(__file__).resolve().parents[1]
OMP = shutil.which("omp")

# Only probes the native lock in the disposable HOME; never edits the master claim.
MASTER_LOCK_FIXTURE = r'''
import { FileLock } from "@oh-my-pi/pi-natives";
import * as os from "node:os";
import * as path from "node:path";
export default function fixture(pi) {
    pi.registerCommand("master-lock-smoke", {
        description: "Disposable master lock probe",
        handler: async (_args, ctx) => {
            const lock = FileLock.tryAcquire(path.join(os.homedir(), ".omp/run/peers/master.lock"));
            const acquired = lock.acquired;
            if (acquired) lock.release();
            ctx.ui.notify(acquired ? "master-lock:available" : "master-lock:busy", "info");
        }
    });
}
'''


class Peer:
    def __init__(self, env, cwd, resume=None):
        self.frames = []
        self.responses = queue.Queue()
        session_args = ["--session", resume] if resume else []
        self.proc = subprocess.Popen(
            [OMP, "--mode", "rpc", "--no-title", "--no-tools",
             "--no-skills", "--no-rules", "--no-context-files", "--no-lsp",
             "--model", "smoke/first", "--system-prompt", "Offline plugin smoke.",
             *session_args],
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
        return notices

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


class LegacyPeer:
    """Trusted same-user legacy writer; messages terminate locally, never at a model."""

    def __init__(self, registry, template, peer_id, session_id, name):
        self.row = {**template, "id": peer_id, "sessionId": session_id, "name": name,
                    "pid": os.getpid(), "instance": "legacy-fixture",
                    "sock": str(registry / (peer_id + ".sock"))}
        self.path = registry / (peer_id + ".json")
        self.requests = []
        self.stop = threading.Event()
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(self.row["sock"])
        os.chmod(self.row["sock"], 0o600)
        self.server.listen()
        self.server.settimeout(0.1)
        self.path.write_text(json.dumps(self.row))
        self.path.chmod(0o600)
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def serve(self):
        while not self.stop.is_set():
            try:
                conn, _ = self.server.accept()
            except socket.timeout:
                continue
            with conn:
                conn.settimeout(2)
                data = b""
                while b"\n" not in data:
                    part = conn.recv(65536)
                    if not part:
                        break
                    data += part
                if not data:
                    continue
                request = json.loads(data.split(b"\n", 1)[0])
                self.requests.append(request)
                response = {"ok": True}
                if request["op"] == "status":
                    response["info"] = self.row
                conn.sendall((json.dumps(response) + "\n").encode())

    def close(self):
        self.stop.set()
        self.thread.join(timeout=5)
        self.server.close()
        assert not self.thread.is_alive(), "legacy fixture did not stop"
        self.path.unlink(missing_ok=True)
        Path(self.row["sock"]).unlink(missing_ok=True)


def duplicate_identity_scenario(master, worker, registry, master_id, worker_id, row, env, root, peers):
    """Real OMP command consumers plus local-only legacy socket delivery."""
    fixtures = []
    worker_start = len(worker.frames)
    try:
        template = row(worker_id)
        duplicate = LegacyPeer(registry, template, "p000001", "distinct-legacy", "smoke-worker")
        fixtures.append(duplicate)
        roster = master.command("/peers list", "duplicate-name:")
        roster_text = json.dumps(roster)
        assert worker_id in roster_text and duplicate.row["id"] in roster_text
        assert "canonical" in roster_text
        ambiguous = master.command("/peers msg smoke-worker never-delivered", "ambiguous")
        assert worker_id in json.dumps(ambiguous) and duplicate.row["id"] in json.dumps(ambiguous)
        assert not duplicate.requests, "ambiguous name delivered to legacy peer"
        master.command("/peers msg p000001 explicit-only", "ok")
        assert [req["text"] for req in duplicate.requests] == ["explicit-only"]
        master.command(f"/peers do {worker_id} status", "smoke-worker")

        # Another peer's name may literally equal an explicit target ID.
        duplicate.row["name"] = worker_id
        duplicate.path.write_text(json.dumps(duplicate.row))
        master.command(f"/peers do {worker_id} status", "smoke-worker")
        assert len(duplicate.requests) == 1, "literal name stole exact ID delivery"

        # The stable live writer, not the alias's row order/name, is canonical.
        duplicate.row.update(sessionId=template["sessionId"], name="smoke-worker",
                             startedAt="1900-01-01T00:00:00.000Z")
        duplicate.path.write_text(json.dumps(duplicate.row))
        roster = master.command("/peers list", "duplicate-session:")
        assert f"canonical:{worker_id}" in json.dumps(roster)
        assert duplicate.path.exists(), "listing deleted a live alias"
        broadcast = master.command("/peers do all status", "smoke-worker")
        assert json.dumps(broadcast).count(f"smoke-worker ({worker_id}):") == 1
        assert "p000001):" not in json.dumps(broadcast)
        assert len(duplicate.requests) == 1, "broadcast also delivered to canonical writer's alias"

        # A restart cannot promote an old live alias to canonical ownership.
        old_instance = row(worker_id)["instance"]
        old_pid = worker.proc.pid
        session_file = worker.call("get_state")["sessionFile"]
        assert not any(frame.get("type") in ("agent_start", "extension_error")
                       for frame in worker.frames[worker_start:])
        worker.close()
        worker = Peer(env, root, resume=session_file)
        peers.append(worker)
        worker.call("get_state")
        worker_start = 0
        wait_for(lambda: row(worker_id) and row(worker_id)["pid"] == worker.proc.pid)
        assert row(worker_id)["instance"] != old_instance
        roster = master.command("/peers list", f"canonical:{worker_id}")
        assert duplicate.path.exists()
        master.command("/peers do all status", "smoke-worker")
        assert len(duplicate.requests) == 1
        stale = registry / "p000003.json"
        stale_socket = registry / "p000003.sock"
        stale.write_text(json.dumps({**template, "id": "p000003", "pid": old_pid,
                                     "sock": str(stale_socket)}))
        stale_socket.touch()
        master.command("/peers list", worker_id)
        assert not stale.exists() and not stale_socket.exists()
        assert duplicate.path.exists(), "stale cleanup removed a live alias"

        # Two live legacy writers with no stable lock owner require an explicit choice.
        duplicate.row.update(sessionId="unproved", name="Legacy A")
        duplicate.path.write_text(json.dumps(duplicate.row))
        second = LegacyPeer(registry, template, "p000002", "unproved", "Legacy B")
        fixtures.append(second)
        roster = master.command("/peers list", "canonical:unknown")
        assert "p000001" in json.dumps(roster) and "p000002" in json.dumps(roster)
        blocked = master.command("/peers do all status", "broadcast not sent")
        assert "p000001" in json.dumps(blocked) and "p000002" in json.dumps(blocked)
        assert len(duplicate.requests) == 1 and not second.requests
        master.command("/peers msg p000002 exact-legacy-choice", "ok")
        assert [req["text"] for req in second.requests] == ["exact-legacy-choice"]

        # Sender aliases must not reintroduce the sender into an ordinary broadcast.
        duplicate.row.update(sessionId=row(master_id)["sessionId"], name="Sender alias")
        duplicate.path.write_text(json.dumps(duplicate.row))
        second.row.update(sessionId="other", name="Other")
        second.path.write_text(json.dumps(second.row))
        master.command("/peers do all status", "smoke-worker")
        assert len(duplicate.requests) == 1
        assert [req["op"] for req in second.requests] == ["message", "status"]
        assert not any(frame.get("type") in ("agent_start", "extension_error")
                       for frame in worker.frames[worker_start:])
        print("PASS duplicate roster, proven writer, ambiguity, exact IDs and safe broadcasts; local socket messages only")
        return worker
    finally:
        for fixture in reversed(fixtures):
            fixture.close()


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
        extensions = agent / "extensions"
        extensions.mkdir()
        (extensions / "master-lock-smoke.ts").write_text(MASTER_LOCK_FIXTURE)
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
                peer.call("new_session")
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
            # Persist names through the host API; no user prompts or provider turns.
            master.call("set_session_name", name="smoke-master")
            worker.command("/peers master", "master already held")
            master_file = master.call("get_state")["sessionFile"]
            worker_file = worker.call("get_state")["sessionFile"]

            def row(peer_id):
                try:
                    return json.loads((registry / (peer_id + ".json")).read_text())
                except (OSError, ValueError):
                    return None

            worker = duplicate_identity_scenario(master, worker, registry, master_id, worker_id, row,
                                                 env, root, peers)

            def legacy_displacement():
                worker.command("/master-lock-smoke", "master-lock:busy")
                claim_path = registry / "master.json"
                legacy_claim = json.dumps({"id": worker_id, "pid": worker.proc.pid}) + "\n"
                claim_path.write_text(legacy_claim)
                # Observe two timer publications without issuing any command to
                # the displaced master, so its first refresh has finished.
                for _ in range(2):
                    updated = row(master_id)["updatedAt"]
                    wait_for(lambda: row(master_id)["updatedAt"] != updated)
                assert claim_path.read_text() == legacy_claim
                worker.command("/master-lock-smoke", "master-lock:available")
                assert claim_path.read_text() == legacy_claim
                master.command(f"/peers do {worker_id} rename forbidden", "Not the master")
                assert claim_path.read_text() == legacy_claim
                assert master.proc.poll() is None and worker.proc.poll() is None
                return claim_path

            # Plain claims must shed stale locks on the timer even without restore.
            legacy_displacement().unlink()
            worker.command("/peers master", "now the master")
            master.command("/peers master", "master already held")
            worker.command("/peers release", "released")
            print("PASS legacy overwrite: timer releases non-restoring master's lock; live owner preserved; another upgraded peer reclaims")

            master.command("/peers master --restore", "Restore on resume enabled")
            legacy_displacement().unlink()
            wait_for(lambda: row("master") and row("master")["id"] == master_id)
            assert row("master")["pid"] == master.proc.pid
            worker.command("/master-lock-smoke", "master-lock:busy")
            worker.command("/peers master", "master already held")
            print("PASS legacy release: displaced master auto-restores on timer without restart or manual release")

            first_instance = row(master_id)["instance"]
            master.close()
            master = Peer(env, root, resume=master_file)
            peers.append(master)
            master.call("get_state")
            wait_for(lambda: row(master_id) and row(master_id)["pid"] == master.proc.pid)
            wait_for(lambda: row("master") and row("master")["id"] == master_id)
            assert row(master_id)["instance"] != first_instance
            assert row(master_id)["name"] == "smoke-master"
            worker.command(f"/peers do {master_id} status", "smoke-master")
            print("PASS clean restart: stable master address/name; new incarnation; role restored")

            worker.close()
            worker = Peer(env, root, resume=worker_file)
            peers.append(worker)
            worker.call("get_state")
            wait_for(lambda: row(worker_id) and row(worker_id)["pid"] == worker.proc.pid)
            master.command(f"/peers do {worker_id} status", "smoke-worker")
            duplicate = Peer(env, root, resume=worker_file)
            peers.append(duplicate)
            duplicate.call("get_state")
            duplicate.command("/peers master", "session already owned")
            assert row(worker_id)["pid"] == worker.proc.pid
            assert row("master")["id"] == master_id
            duplicate.close()
            master.command(f"/peers do {worker_id} status", "smoke-worker")
            print("PASS duplicate writer denied without replacing owner or master")
            print("PASS worker restart: original ID and name still route")

            # A crash leaves stale registry/socket/claim files; kernel locks must recover.
            master.proc.kill()
            master.proc.wait(timeout=10)
            master.close()
            worker.command("/peers master", "now the master")
            master = Peer(env, root, resume=master_file)
            peers.append(master)
            master.call("get_state")
            wait_for(lambda: row(master_id) and row(master_id)["pid"] == master.proc.pid)
            master.command("/peers master --restore", "master already held")
            assert json.loads((registry / "master.json").read_text())["id"] == worker_id
            worker.command("/peers release", "released")
            wait_for(lambda: row("master") and row("master")["id"] == master_id)
            master.command(f"/peers do {worker_id} status", "smoke-worker")
            print("PASS crash recovery: stale claim replaced; live master not stolen; restore retries")

            master.command("/peers release", "restore on resume disabled")
            master.close()
            master = Peer(env, root, resume=master_file)
            peers.append(master)
            master.call("get_state")
            wait_for(lambda: row(master_id) and row(master_id)["pid"] == master.proc.pid)
            assert not (registry / "master.json").exists()
            master.command("/peers master", "now the master")
            print("PASS release persists opt-out across restart")
            # Switching to a new logical session must drop the old live claim.
            result = master.call("new_session")
            assert not result.get("cancelled")
            new_session = master.call("get_state")["sessionId"]
            wait_for(lambda: not (registry / (master_id + ".json")).exists())
            assert not (registry / "master.json").exists()
            master.call("switch_session", sessionPath=master_file)
            assert master.call("get_state")["sessionId"] != new_session
            master.command("/peers list", master_id)
            assert not (registry / "master.json").exists()
            master.command("/peers master", "now the master")
            print("PASS session switch changes logical identity and releases old master claim")
            master.command("/peers release", "released")
            candidates = [master, worker]
            starts = [len(peer.frames) for peer in candidates]
            with ThreadPoolExecutor(max_workers=2) as executor:
                attempts = [executor.submit(peer.call, "prompt", message="/peers master")
                            for peer in candidates]
                for attempt in attempts:
                    attempt.result(timeout=15)
            notices = wait_for(lambda: [
                [frame for frame in peer.frames[start:] if frame.get("method") == "notify"]
                for peer, start in zip(candidates, starts)
            ] if all(any(frame.get("method") == "notify" for frame in peer.frames[start:])
                     for peer, start in zip(candidates, starts)) else None)
            assert sum("now the master" in json.dumps(frames) for frames in notices) == 1
            winner = master if row("master")["id"] == master_id else worker
            winner.command("/peers release", "released")
            master.command("/peers master", "now the master")
            saved_dir = agent / "peer-sessions"
            assert saved_dir.stat().st_mode & 0o777 == 0o700
            assert all(file.stat().st_mode & 0o777 == 0o600 for file in saved_dir.glob("*.json"))
            print("PASS simultaneous claims elect one master; durable metadata remains private")
            # Refuse inbound messages so an unexpected notification cannot start
            # a provider turn in this integration smoke.
            master.command("/peers refuse", "refuse")
            watcher = subprocess.Popen(
                [sys.executable, str(REPO / "tools" / "watch.py"),
                 "--home", root, "--interval", "0.05"],
                env=env, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            state_path = home / ".omp-peer-watch" / "completions.json"

            def watcher_state():
                try:
                    state = json.loads(state_path.read_text())
                    return state if len(state.get("sessions", {})) == 2 else None
                except (OSError, ValueError):
                    return None

            wait_for(watcher_state)
            assert watcher.poll() is None
            assert watcher_state()["outbox"] == [], "initial idle is not a completion"
            worker.close()
            wait_for(lambda: not (registry / (worker_id + ".json")).exists())
            assert watcher.poll() is None, "persistent watcher exited on a departed peer"
            assert watcher_state()["outbox"] == [], "departure is not a completion"
            watcher.terminate()
            report, errors = watcher.communicate(timeout=10)
            assert watcher.returncode == 0, (report, errors)
            assert "WATCHER_READY" in report and "WATCHER_STOPPED" in report, (report, errors)
            assert "WATCHER_DELIVERED" not in report, report
            assert state_path.stat().st_mode & 0o777 == 0o600
            assert (home / ".omp-peer-watch").stat().st_mode & 0o777 == 0o700
            print("PASS persistent watcher: initial idle/departure silent; clean shutdown")
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
                try:
                    watcher.communicate(timeout=10)
                except subprocess.TimeoutExpired:
                    watcher.kill()
                    watcher.communicate(timeout=5)
            for peer in peers:
                peer.close()
    print("PASS temporary home removed; no real sessions or credentials used")


if __name__ == "__main__":
    main()
