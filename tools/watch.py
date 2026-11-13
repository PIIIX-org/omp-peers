#!/usr/bin/env python3
# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (c) 2026 PIIIX-org contributors
"""Persist peer turn-ended notifications without reading transcripts or calling a provider.

Delivery uses the current master's message RPC, which can start a model turn there.
Busy/idle and agent_end do not establish task completion or background quiescence.
"""
import argparse
import datetime
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import socket
import stat
import sys
import tempfile
import time


def read_json(path):
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def private_directory(path):
    path = Path(path)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError("runtime directory must be an owned directory, not a symlink")
    path.chmod(0o700)
    return path


def private_open(path):
    """Open an owned regular runtime file without following a final symlink."""
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            raise ValueError("runtime file must be an owned regular file without hard links")
        os.fchmod(fd, 0o600)
        return os.fdopen(fd, "r+")
    except BaseException:
        os.close(fd)
        raise


def atomic_json(path, value):
    fd, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as out:
            json.dump(value, out, separators=(",", ":"))
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def alive(pid):
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def peer_rpc(peer, request):
    """Use peers_send's newline-delimited local Unix-socket protocol."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
        conn.settimeout(2)
        conn.connect(peer["sock"])
        conn.sendall(json.dumps(request).encode() + b"\n")
        data = bytearray()
        while b"\n" not in data:
            chunk = conn.recv(65536)
            if not chunk:
                raise ConnectionError("peer closed before acknowledgement")
            data.extend(chunk)
            if len(data) > 256 * 1024:
                raise ConnectionError("peer response too large")
        response = json.loads(data.split(b"\n", 1)[0])
        if not isinstance(response, dict) or response.get("ok") is not True:
            # Peer error text can contain private content. Do not copy it into logs.
            raise ConnectionError("peer refused notification")
        return response


class Watcher:
    def __init__(self, home, state_dir, interval=1):
        self.home = Path(home).expanduser().absolute()
        self.registry = self.home / ".omp/run/peers"
        self.log_dir = self.home / ".omp/logs"
        self.state_dir = private_directory(state_dir)
        self.state_file = self.state_dir / "completions.json"
        self.state = None  # Load only after acquiring the singleton lock.
        self.interval = interval
        self.next_send = 0
        self.stopping = False
        self.last_error = None
        self.dirty = False

    def load(self):
        with private_open(self.state_file) as source:
            text = source.read()
        if text:
            value = json.loads(text)
            if (not isinstance(value, dict) or value.get("version") != 1
                    or not isinstance(value.get("since"), (float, int))
                    or not all(isinstance(value.get(k), dict) for k in ("sessions", "cursors"))
                    or not all(isinstance(value.get(k), list) for k in ("seen", "outbox"))):
                raise ValueError("unsupported watcher state; preserve it before resetting")
            self.state = value
        else:
            self.state = {"version": 1, "since": time.time(), "sessions": {},
                          "cursors": {}, "seen": [], "outbox": []}
            self.dirty = True

    def save(self):
        if self.dirty:
            atomic_json(self.state_file, self.state)
            self.dirty = False

    def snapshot(self):
        # Stable session + process identity survives peer-ID rotation. Prefer each
        # process's newest registration, then combine live processes conservatively.
        by_process = {}
        for path in sorted(self.registry.glob("p*.json")):
            peer = read_json(path)
            sid = peer.get("sessionId")
            if (not isinstance(sid, str) or not sid or not alive(peer.get("pid"))
                    or not isinstance(peer.get("sock"), str) or not peer["sock"]):
                continue
            key = peer["pid"]
            if str(peer.get("updatedAt", "")) >= str(by_process.get(key, {}).get("updatedAt", "")):
                by_process[key] = peer
        sessions = {}
        for peer in by_process.values():
            sessions.setdefault(peer["sessionId"], []).append(peer)
        return sessions

    def master(self):
        claim = read_json(self.registry / "master.json")
        identity = claim.get("id")
        # Registry IDs are filenames, not arbitrary paths supplied by the claim.
        if not isinstance(identity, str) or not identity.startswith("p") or Path(identity).name != identity:
            return None
        peer = read_json(self.registry / (identity + ".json"))
        if (peer.get("id") == identity and peer.get("pid") == claim.get("pid")
                and alive(peer.get("pid")) and isinstance(peer.get("sock"), str) and peer["sock"]):
            return peer
        return None

    def enqueue(self, sid, name, key, kind, detail):
        event_id = hashlib.sha256((sid + "/" + key).encode()).hexdigest()[:20]
        if event_id in self.state["seen"]:
            return
        self.state["seen"].append(event_id)
        self.state["seen"] = self.state["seen"][-8192:]
        self.state["outbox"].append({"event": event_id, "session": sid,
                                     "name": str(name)[:160], "kind": kind, "detail": detail})
        self.dirty = True

    def lifecycle(self, sid, peers, record, baseline=False, notify=True):
        for pid in sorted({peer["pid"] for peer in peers}):
            for path in sorted(self.log_dir.glob("omp.*." + str(pid) + ".log")):
                try:
                    info = path.stat()
                    cursor = self.state["cursors"].get(str(path))
                    if cursor is None:
                        # Existing startup logs establish a baseline, not a replay.
                        position = info.st_size if baseline else 0
                    else:
                        position = cursor[1] if cursor[0] == info.st_ino and cursor[1] <= info.st_size else 0
                    with path.open("rb") as source:
                        source.seek(position)
                        for _ in range(2000):
                            start = source.tell()
                            line = source.readline(1024 * 1024)
                            if not line:
                                break
                            if not line.endswith(b"\n"):
                                source.seek(start)
                                break
                            if b"agent_end maintenance routing" not in line:
                                continue
                            try:
                                item = json.loads(line)
                                if (not isinstance(item, dict)
                                        or item.get("message") != "agent_end maintenance routing"
                                        or item.get("route") != "entered" or item.get("sessionId") != sid):
                                    continue
                                stamp = item.get("timestamp", "")
                                ended = datetime.datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()
                                if not math.isfinite(ended) or ended < self.state["since"]:
                                    continue
                            except (ValueError, TypeError, AttributeError, OverflowError):
                                continue
                            record.setdefault("log_times", []).append(ended)
                            record["log_times"] = record["log_times"][-256:]
                            self.dirty = True
                            if not notify or any(start <= ended <= edge for start, edge in record.get("notified_edges", [])):
                                continue
                            reason = item.get("stopReason")
                            if reason not in ("stop", "length", "toolUse", "error", "aborted"):
                                reason = "unknown"
                            self.enqueue(sid, peers[0].get("name", sid), "agent_end/" + str(ended),
                                         "agent_end", "agent loop ended; stopReason=" + reason)
                        new_cursor = [info.st_ino, source.tell()]
                    if cursor != new_cursor:
                        self.state["cursors"][str(path)] = new_cursor
                        self.dirty = True
                except OSError as error:
                    self.report_error("lifecycle metadata unavailable: " + type(error).__name__)

    def observe(self, baseline=False):
        sessions = self.snapshot()
        master = self.master()
        master_sid = master.get("sessionId") if master else None
        now = time.time()
        for sid, peers in sessions.items():
            busy = any(p.get("busy") is True for p in peers)
            record = self.state["sessions"].get(sid)
            if record is None:
                record = {"busy": busy, "active_since": now if busy else 0}
                self.state["sessions"][sid] = record
                self.dirty = True
            processes = sorted({str(p["pid"]) + ":" + str(p.get("startedAt", "")) for p in peers})
            previous = record.get("processes", processes)
            if not set(previous).intersection(processes):
                # A replacement process establishes its own baseline. Its initial
                # idle state cannot finish the previous process's abandoned turn.
                record.update(busy=busy, active_since=now if busy else 0, edges=[])
                self.dirty = True
            if previous != processes or "processes" not in record:
                record["processes"] = processes
                self.dirty = True
            is_master = sid == master_sid
            self.lifecycle(sid, peers, record, baseline=baseline,
                           notify=not is_master and not record.get("was_master", False))
            if is_master or record.get("was_master", False):
                # Consume master lifecycle metadata without reflecting watcher-
                # triggered master turns back into the notification queue.
                values = {"busy": busy, "active_since": record.get("active_since", 0) if busy else 0,
                          "edges": [], "was_master": is_master}
                if any(record.get(key) != value for key, value in values.items()):
                    record.update(values)
                    self.dirty = True
                continue
            if busy and not record["busy"]:
                record["active_since"] = now
                self.dirty = True
            if not busy and record["busy"]:
                record.setdefault("edges", []).append([record.get("active_since", 0), now])
                self.dirty = True
            if record["busy"] != busy:
                record["busy"] = busy
                self.dirty = True
            waiting = []
            for start, edge in record.get("edges", []):
                if now - edge < 2:
                    waiting.append([start, edge])
                    continue
                # Give the lifecycle logger time to flush, then coalesce the log
                # and registry observations into one event for the same turn.
                if not any(start <= ended <= edge for ended in record.get("log_times", [])):
                    self.enqueue(sid, peers[0].get("name", sid), "idle/" + str(edge),
                                 "idle_transition", "observed active -> idle")
                    record.setdefault("notified_edges", []).append([start, edge])
                    record["notified_edges"] = record["notified_edges"][-256:]
                self.dirty = True
            record["edges"] = waiting
        # Missing registrations do not prove task completion. Retain pending work.
        self.save()
        return sessions

    def describe(self, event, sessions):
        peers = sessions.get(event["session"], [])
        states = []
        for peer in peers:
            try:
                info = peer_rpc(peer, {"op": "status"}).get("info")
                if isinstance(info, dict):
                    states.append(info)
            except (OSError, ValueError, KeyError, ConnectionError):
                continue
        yielded = "agent yielded; " if event["kind"] in ("agent_end", "idle_transition") else ""
        if not states:
            live = yielded + "live state unavailable; background/task completion UNKNOWN"
        else:
            activities = [s["activity"] if isinstance(s.get("activity"), dict) else {} for s in states]
            def count(key):
                values = [activity.get(key) for activity in activities]
                if len(states) == len(peers) and all(type(v) is int and v >= 0 for v in values):
                    # Registrations describe the same logical session, not additive workers.
                    return str(max(values))
                return "?"

            counts = "jobs=" + count("activeJobs") + "; active subagents=" + count("activeSubagents")
            active = any(s.get("busy") is True for s in states)
            work = any(s.get("hasPendingAsyncWork") is True or any(
                type(value) is int and value > 0
                for value in (activity.get("activeJobs"), activity.get("activeSubagents"))
            ) for s, activity in zip(states, activities))
            if work:
                live = "background work pending; NOT task-complete"
            elif (not active and len(states) == len(peers)
                  and all(s.get("busy") is False and s.get("isSettled") is True
                          and s.get("hasPendingAsyncWork") is False for s in states)):
                live = "session reports quiescence (settled; no pending wake work); task completion unverified"
            else:
                live = "live=" + ("active" if active else "idle/unknown")
                live += "; background/task completion UNKNOWN (quiescence unavailable)"
            live = yielded + live + "; " + counts
        return json.dumps({**event, "live": live}, ensure_ascii=True)

    def deliver(self, sessions):
        if not self.state["outbox"] or time.monotonic() < self.next_send:
            return
        master = self.master()  # Re-resolve the current owner on every attempt.
        if not master:
            return
        outbox = self.state["outbox"]
        filtered = [e for e in outbox if e["session"] != master.get("sessionId")]
        if len(filtered) != len(outbox):
            self.state["outbox"] = outbox = filtered
            self.dirty = True
            self.save()
        batch = outbox[:20]
        if not batch:
            return
        text = "PEER_COMPLETION_WATCHER\n" + "\n".join(self.describe(e, sessions) for e in batch)
        text += ("\nMetadata notification only. No parked project is authorized to resume. "
                 "Deduplicate by event ID; turn ended/idle is not task done. Background work may remain.")
        self.next_send = time.monotonic() + 3.2  # Below the peer's 20 messages/minute limit.
        try:
            peer_rpc(master, {"op": "message", "from": {"id": "completion-watcher", "name": "Completion watcher"}, "text": text})
        except (OSError, ValueError, ConnectionError) as error:
            self.report_error("notification pending retry: " + type(error).__name__)
            return
        ids = {e["event"] for e in batch}
        self.state["outbox"] = [e for e in outbox if e["event"] not in ids]
        self.dirty = True
        self.save()
        self.last_error = None
        print("WATCHER_DELIVERED " + json.dumps({"master": master["id"], "events": sorted(ids),
                                               "kinds": [e["kind"] for e in batch]}), flush=True)

    def report_error(self, text):
        if text != self.last_error:
            print("WATCHER_WARNING " + text, file=sys.stderr, flush=True)
            self.last_error = text

    def run(self, test_message=None):
        with private_open(self.state_dir / "completion.lock") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise SystemExit("A completion watcher already holds the singleton lock")
            lock.seek(0)
            lock.truncate()
            lock.write(str(os.getpid()))
            lock.flush()
            self.load()
            for sig in (signal.SIGTERM, signal.SIGINT):
                signal.signal(sig, lambda *_: setattr(self, "stopping", True))
            sessions = self.observe(baseline=True)
            if test_message:
                self.enqueue("", "WATCHER_TEST", test_message, "test", "operator notification test")
                self.save()
            print("WATCHER_READY " + json.dumps({"pid": os.getpid(), "sessions": len(sessions)}), flush=True)
            while not self.stopping:
                try:
                    sessions = self.observe()
                    self.deliver(sessions)
                except (OSError, ValueError, KeyError, TypeError, ConnectionError) as error:
                    self.report_error("watch loop recovered: " + type(error).__name__)
                time.sleep(self.interval)
            self.save()
            print("WATCHER_STOPPED", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=Path.home(), help="OS home containing .omp/run/peers and .omp/logs")
    parser.add_argument("--state-dir", type=Path, help="private runtime directory (default: HOME/.omp-peer-watch)")
    parser.add_argument("--interval", type=float, default=1)
    parser.add_argument("--notify-test", help="deduplication key for an operator test; may start a master model turn")
    args = parser.parse_args()
    if not math.isfinite(args.interval) or args.interval <= 0:
        parser.error("--interval must be finite and positive")
    home = args.home.expanduser().absolute()
    state_dir = (args.state_dir or home / ".omp-peer-watch").expanduser().absolute()
    try:
        Watcher(home, state_dir, args.interval).run(args.notify_test)
    except (OSError, ValueError) as error:
        raise SystemExit("Watcher startup failed: " + type(error).__name__) from None


if __name__ == "__main__":
    main()
