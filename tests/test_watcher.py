#!/usr/bin/env python3
# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (c) 2026 PIIIX-org contributors
"""Offline watcher/installer checks. No OMP process, launchctl job, or provider call."""
import argparse
import contextlib
import datetime
import fcntl
import io
import json
import os
from pathlib import Path
import plistlib
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from smoke import wait_for

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "tools"))
import watch
import install_watcher


def state_ready(path):
    try:
        value = json.loads(path.read_text())
        return value if value.get("version") == 1 else None
    except (OSError, ValueError):
        return None


class WatcherChecks(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="opw-", dir="/tmp")
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)
        self.registry = self.home / ".omp/run/peers"
        self.registry.mkdir(parents=True)
        self.logs = self.home / ".omp/logs"
        self.logs.mkdir(parents=True)
        self.now = 2000000000.0
        self.processes = {}
        live = patch.object(watch, "alive", return_value=True)
        live.start()
        self.addCleanup(live.stop)
        clock = patch.object(watch.time, "time", side_effect=lambda: self.now)
        clock.start()
        self.addCleanup(clock.stop)
        self.watcher = watch.Watcher(self.home, self.home / "watcher", digest_interval=0)
        self.watcher.load()

    def peer(self, identity="pworker", sid="worker-session", busy=False, **extra):
        pid = self.processes.setdefault(sid, os.getpid() + len(self.processes))
        row = {"id": identity, "pid": pid, "sessionId": sid,
               "sock": str(self.home / (identity + ".sock")), "name": "worker",
               "busy": busy, "startedAt": "process-start", "updatedAt": str(self.now), **extra}
        (self.registry / (identity + ".json")).write_text(json.dumps(row))
        return row

    def master(self, identity="pmaster", sid="master-session"):
        row = self.peer(identity, sid)
        (self.registry / "master.json").write_text(json.dumps({"id": identity, "pid": row["pid"]}))
        return row

    def lifecycle(self, sid="worker-session", stamp=None, **extra):
        timestamp = stamp or datetime.datetime.fromtimestamp(self.now, datetime.timezone.utc).isoformat()
        row = {"message": "agent_end maintenance routing", "route": "entered",
               "sessionId": sid, "timestamp": timestamp, "stopReason": "stop", **extra}
        path = self.logs / ("omp.test." + str(self.processes.get(sid, os.getpid())) + ".log")
        with path.open("a") as target:
            target.write(json.dumps(row) + "\n")
        return path

    def tick(self, seconds=1):
        self.now += seconds
        return self.watcher.observe()

    def test_initial_idle_new_idle_and_departure_do_not_complete_tasks(self):
        self.peer()
        self.lifecycle()
        self.watcher.observe(baseline=True)
        self.tick()
        self.peer("pnew", "new-session")
        self.tick()
        (self.registry / "pworker.json").unlink()
        self.tick()
        self.assertEqual(self.watcher.state["outbox"], [])

    def test_stale_alias_of_previous_session_does_not_consume_current_logs(self):
        old = self.peer("pold", "previous-session", busy=True)
        self.watcher.observe(baseline=True)
        self.now += 1
        self.peer("pnew", "current-session", pid=old["pid"])
        self.processes["current-session"] = old["pid"]
        sessions = self.watcher.observe()
        self.assertEqual(set(sessions), {"current-session"})
        self.now += 1
        self.lifecycle(sid="current-session")
        self.watcher.observe()
        self.assertEqual([e["session"] for e in self.watcher.state["outbox"]], ["current-session"])

    def test_busy_idle_persists_and_deduplicates_stable_session(self):
        self.peer(busy=True)
        self.watcher.observe(baseline=True)
        self.now += 1
        self.peer("protated", busy=False)
        self.tick()
        self.tick(3)
        events = self.watcher.state["outbox"]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["kind"], "idle_transition")
        restored = watch.Watcher(self.home, self.home / "watcher")
        restored.load()
        restored.observe(baseline=True)
        self.assertEqual(restored.state["outbox"], events)
        restored.enqueue(events[0]["session"], "worker", "idle/" + str(self.now - 3), "idle_transition", "duplicate")
        self.assertEqual(len(restored.state["outbox"]), 1)

    def test_process_replacement_does_not_finish_abandoned_busy_turn(self):
        self.peer(busy=True)
        self.watcher.observe(baseline=True)
        self.peer(busy=False, startedAt="replacement-process")
        self.tick()
        self.tick(3)
        self.assertEqual(self.watcher.state["outbox"], [])

    def test_short_turn_lifecycle_and_registry_edge_are_one_event(self):
        self.peer(busy=True)
        self.watcher.observe(baseline=True)
        self.now += 1
        self.lifecycle()
        self.peer(busy=False)
        self.watcher.observe()
        self.tick(3)
        self.assertEqual([e["kind"] for e in self.watcher.state["outbox"]], ["agent_end"])
        # A duplicate log registration or replay cannot re-enqueue the same event.
        self.lifecycle(stamp=datetime.datetime.fromtimestamp(self.now - 3, datetime.timezone.utc).isoformat())
        self.tick()
        self.assertEqual(len(self.watcher.state["outbox"]), 1)

    def test_short_turn_between_polls_uses_metadata_only(self):
        self.peer()
        self.watcher.observe(baseline=True)
        self.now += 1
        log = self.lifecycle(stopReason="private transcript text", content="private transcript text")
        self.watcher.observe()
        self.assertEqual(len(self.watcher.state["outbox"]), 1)
        self.assertNotIn("private transcript text", self.watcher.state_file.read_text())
        # Malformed metadata must not pin the cursor ahead of a later valid event.
        with log.open("a") as target:
            target.write('{"message":"agent_end maintenance routing",broken}\n')
        self.now += 1
        self.lifecycle()
        self.watcher.observe()
        self.assertEqual(len(self.watcher.state["outbox"]), 2)

    def test_partial_log_line_waits_for_newline(self):
        self.peer()
        self.watcher.observe(baseline=True)
        self.now += 1
        log = self.lifecycle()
        raw = log.read_bytes()
        log.write_bytes(raw[:-1])
        self.watcher.observe()
        self.assertEqual(self.watcher.state["outbox"], [])
        with log.open("ab") as target:
            target.write(b"\n")
        self.watcher.observe()
        self.assertEqual(len(self.watcher.state["outbox"]), 1)

    def test_late_lifecycle_suppresses_duplicate_idle_notification(self):
        self.peer(busy=True)
        self.watcher.observe(baseline=True)
        self.now += 1
        ended = self.now
        self.peer(busy=False)
        self.watcher.observe()
        self.tick(3)
        self.lifecycle(stamp=datetime.datetime.fromtimestamp(ended, datetime.timezone.utc).isoformat())
        self.watcher.observe()
        self.assertEqual([e["kind"] for e in self.watcher.state["outbox"]], ["idle_transition"])

    def test_current_master_is_excluded_and_does_not_feedback(self):
        self.master()
        self.watcher.observe(baseline=True)
        self.now += 1
        self.lifecycle(sid="master-session")
        self.watcher.observe()
        self.assertEqual(self.watcher.state["outbox"], [])

    def test_delivery_uses_new_master_after_retry_and_preserves_event_id(self):
        self.master("pmaster1", "master-one")
        self.watcher.enqueue("worker-session", "worker", "turn-1", "agent_end", "agent loop ended")
        self.watcher.save()
        original = self.watcher.state["outbox"][0]["event"]
        calls = []

        def rpc(peer, request):
            calls.append((peer["id"], request))
            if peer["id"] == "pmaster1":
                raise ConnectionError("private error text")
            return {"ok": True}

        with patch.object(watch, "peer_rpc", side_effect=rpc):
            self.watcher.deliver({})
            self.assertEqual(self.watcher.state["outbox"][0]["event"], original)
            self.master("pmaster2", "master-two")
            self.watcher.next_send = 0
            self.watcher.deliver({})
        self.assertEqual([p for p, _ in calls], ["pmaster1", "pmaster2"])
        self.assertIn(original, calls[-1][1]["text"])
        self.assertIn("turn ended/idle is not task done", calls[-1][1]["text"])
        self.assertIn("background/task completion UNKNOWN", calls[-1][1]["text"])
        self.assertEqual(self.watcher.state["outbox"], [])
        self.assertEqual(state_ready(self.watcher.state_file)["outbox"], [])

    def test_no_master_retains_pending_notifications(self):
        self.watcher.enqueue("worker-session", "worker", "turn-1", "agent_end", "agent loop ended")
        with patch.object(watch, "peer_rpc") as rpc:
            self.watcher.deliver({})
            rpc.assert_not_called()
        self.assertEqual(len(self.watcher.state["outbox"]), 1)

    def test_live_state_does_not_invent_quiescence(self):
        peer = self.peer()
        event = {"session": "worker-session", "event": "example", "name": "worker", "kind": "agent_end", "detail": "ended"}
        for info, expected in (({"busy": False}, "UNKNOWN"),
                               ({"busy": False, "isSettled": True}, "UNKNOWN"),
                               ({"busy": False, "hasPendingAsyncWork": True}, "NOT task-complete"),
                               ({"busy": False, "isSettled": True, "hasPendingAsyncWork": False}, "task completion unverified")):
            with self.subTest(info=info), patch.object(watch, "peer_rpc", return_value={"ok": True, "info": info}):
                self.assertIn(expected, self.watcher.describe(event, {"worker-session": [peer]}))

    def notification(self, kind="end", sid="worker-session", turn="turn-one", **extra):
        directory = self.registry / "notifications"
        directory.mkdir(exist_ok=True)
        path = directory / "worker.jsonl"
        item = {"version": 1, "sessionId": sid, "turnId": turn,
                "timestamp": self.now, "type": kind, **extra}
        with path.open("a") as target:
            target.write(json.dumps(item) + "\n")
        return path

    def test_report_suppresses_only_exact_turn_session_and_current_destination(self):
        self.master()
        self.peer(notificationVersion=1)
        self.watcher.observe(baseline=True)
        for report in ("DONE", "BLOCKED", "WAITING", "DECISION"):
            with self.subTest(report=report):
                self.now += 1
                self.notification("report", turn=report, report=report,
                                  destinationSessionId="master-session", destinationId="pmaster")
                self.notification(turn=report)
                self.watcher.observe()
                with patch.object(watch, "peer_rpc") as rpc:
                    self.watcher.deliver({})
                rpc.assert_not_called()
                self.assertEqual(self.watcher.state["outbox"], [])
        for index, (sid, destination, identity, prior) in enumerate((
                ("worker-session", "master-session", "pmaster", True),
                ("unrelated-session", "master-session", "pmaster", False),
                ("worker-session", "another-session", "pother", False),
                ("worker-session", "master-session", "poldmaster", False))):
            with self.subTest(receipt=(sid, destination, identity, prior)):
                self.now += 1
                turn = "unreported-" + str(index)
                self.notification("report", sid=sid, turn="prior-turn" if prior else turn, report="DONE",
                                  destinationSessionId=destination, destinationId=identity)
                self.notification(turn=turn)
                self.watcher.observe()
                self.watcher.next_send = 0
                with patch.object(watch, "peer_rpc", return_value={"ok": True}) as rpc:
                    self.watcher.deliver({})
                self.assertEqual(rpc.call_count, 1)
                self.assertEqual(self.watcher.state["outbox"], [])

    def test_wrong_destination_and_prior_turn_do_not_suppress(self):
        self.master()
        self.peer(notificationVersion=1)
        self.watcher.observe(baseline=True)
        self.now += 1
        self.notification("report", turn="previous", report="DONE",
                          destinationSessionId="master-session", destinationId="pmaster")
        self.notification("report", turn="current", report="WAITING",
                          destinationSessionId="other-session", destinationId="pother")
        self.notification(turn="current")
        self.watcher.observe()
        with patch.object(watch, "peer_rpc", return_value={"ok": True}) as rpc:
            self.watcher.deliver({})
        self.assertEqual(rpc.call_count, 1)
        self.assertIn("turn=current", rpc.call_args.args[1]["text"])

    def test_report_to_previous_master_does_not_suppress_new_master_digest(self):
        self.master("pold", "old-master")
        self.peer(notificationVersion=1)
        self.watcher.observe(baseline=True)
        self.now += 1
        self.notification("report", report="DECISION",
                          destinationSessionId="old-master", destinationId="pold")
        self.notification()
        self.watcher.observe()
        self.master("pnew", "new-master")
        with patch.object(watch, "peer_rpc", return_value={"ok": True}) as rpc:
            self.watcher.deliver({})
        self.assertEqual(rpc.call_args.args[0]["id"], "pnew")
        self.assertIn("turn=turn-one", rpc.call_args.args[1]["text"])

    def test_journal_registry_and_host_log_coalesce_by_exact_turn(self):
        self.peer(busy=True, notificationVersion=1, notificationTurnId="turn-one")
        self.watcher.observe(baseline=True)
        self.now += 1
        self.notification()
        self.lifecycle()
        self.peer(busy=False, notificationVersion=1, notificationTurnId="turn-one")
        self.watcher.observe()
        self.tick(3)
        self.assertEqual(len(self.watcher.state["outbox"]), 1)
        self.assertEqual(self.watcher.state["outbox"][0]["turn"], "turn-one")
        self.notification()
        self.watcher.observe()
        self.assertEqual(len(self.watcher.state["outbox"]), 1)

    def test_startup_keeps_active_turn_receipt_without_replaying_historical_ends(self):
        self.master()
        self.peer(busy=True, notificationVersion=1, notificationTurnId="active-turn")
        self.notification(turn="historical-turn", timestamp=self.now - 2)
        self.notification("report", turn="active-turn", timestamp=self.now - 1, report="DONE",
                          destinationSessionId="master-session", destinationId="pmaster")
        self.watcher.observe(baseline=True)
        self.assertEqual(self.watcher.state["outbox"], [])
        self.now += 1
        self.notification(turn="active-turn")
        self.watcher.observe()
        with patch.object(watch, "peer_rpc") as rpc:
            self.watcher.deliver({})
        rpc.assert_not_called()
        self.assertEqual(self.watcher.state["outbox"], [])

    def test_journal_failure_fallback_does_not_replay_healthy_host_log_ends(self):
        self.peer(notificationVersion=1)
        self.watcher.observe(baseline=True)
        self.now += 1
        self.notification(turn="healthy-turn")
        self.lifecycle()
        self.watcher.observe()
        self.assertEqual(len(self.watcher.state["outbox"]), 1)
        self.now += 1
        self.peer()
        self.lifecycle()
        self.watcher.observe()
        events = self.watcher.state["outbox"]
        self.assertEqual(len(events), 2)
        self.assertEqual(sum(event.get("turn") == "healthy-turn" for event in events), 1)
        self.assertEqual(sum("turn" not in event for event in events), 1)

    def test_late_report_and_pending_turn_survive_restart(self):
        self.master()
        self.peer(notificationVersion=1)
        self.watcher.observe(baseline=True)
        self.now += 1
        self.notification()
        self.watcher.observe()
        self.assertEqual(len(self.watcher.state["outbox"]), 1)
        self.notification("report", report="BLOCKED",
                          destinationSessionId="master-session", destinationId="pmaster")
        self.watcher = watch.Watcher(self.home, self.home / "watcher")
        self.watcher.load()
        self.watcher.observe(baseline=True)
        with patch.object(watch, "peer_rpc") as rpc:
            self.watcher.deliver({})
        rpc.assert_not_called()
        self.assertEqual(self.watcher.state["outbox"], [])

    def test_digest_batches_and_persists_cadence_retry_and_event_ids(self):
        self.master()
        self.watcher.digest_interval = 60
        self.watcher.enqueue("one", "First worker", "one", "agent_end", "agent loop ended")
        self.now += 30
        self.watcher.enqueue("two", "Second worker", "two", "idle_transition", "observed active -> idle")
        self.watcher.save()
        with patch.object(watch, "peer_rpc") as rpc:
            self.watcher.deliver({})
        rpc.assert_not_called()
        self.watcher = watch.Watcher(self.home, self.home / "watcher", digest_interval=60)
        self.watcher.load()
        ids = [e["event"] for e in self.watcher.state["outbox"]]
        self.now += 30
        with patch.object(watch, "peer_rpc", side_effect=ConnectionError):
            self.watcher.deliver({})
        self.assertEqual([e["event"] for e in self.watcher.state["outbox"]], ids)
        self.watcher.next_send = 0
        with patch.object(watch, "peer_rpc", return_value={"ok": True}) as rpc:
            self.watcher.deliver({})
        self.assertEqual(rpc.call_count, 1)
        text = rpc.call_args.args[1]["text"]
        self.assertIn("digest (2 transitions)", text)
        self.assertIn("First worker", text)
        self.assertIn("Second worker", text)
        self.assertTrue(all(identity in text for identity in ids))
        self.assertEqual(self.watcher.state["outbox"], [])
        self.assertEqual(state_ready(self.watcher.state_file)["next_digest_at"], self.now + 60)

    def test_legacy_v1_outbox_remains_deliverable_without_turn_metadata(self):
        self.master()
        pending = {"event": "legacy-event", "session": "worker-session", "name": "worker",
                   "kind": "agent_end", "detail": "agent loop ended"}
        state = {"version": 1, "since": self.now - 100, "sessions": {},
                 "cursors": {}, "seen": ["legacy-event"], "outbox": [pending]}
        watch.atomic_json(self.watcher.state_file, state)
        self.watcher.load()
        self.assertEqual(self.watcher.state["outbox"], [pending])
        with patch.object(watch, "peer_rpc", side_effect=ConnectionError):
            self.watcher.deliver({})
        self.assertEqual(state_ready(self.watcher.state_file)["outbox"], [pending])
        self.watcher.next_send = 0
        with patch.object(watch, "peer_rpc", return_value={"ok": True}) as rpc:
            self.watcher.deliver({})
        self.assertIn("legacy-event", rpc.call_args.args[1]["text"])
        self.assertEqual(state_ready(self.watcher.state_file)["outbox"], [])

    def test_metadata_partial_line_and_invalid_report_cannot_hide_notice(self):
        self.master()
        self.peer(notificationVersion=1)
        self.watcher.observe(baseline=True)
        self.now += 1
        path = self.notification("report", report="ordinary-message",
                                 destinationSessionId="master-session", destinationId="pmaster")
        self.notification()
        raw = path.read_bytes()
        path.write_bytes(raw[:-1])
        self.watcher.observe()
        self.assertEqual(self.watcher.state["outbox"], [])
        with path.open("ab") as target:
            target.write(b"\n")
        self.watcher.observe()
        with patch.object(watch, "peer_rpc", return_value={"ok": True}) as rpc:
            self.watcher.deliver({})
        self.assertEqual(rpc.call_count, 1)

    def test_registry_fallback_cannot_borrow_a_prior_turn_receipt(self):
        self.master()
        self.peer(busy=True, notificationVersion=1, notificationTurnId="current")
        self.watcher.observe(baseline=True)
        self.now += 1
        self.notification("report", turn="prior", report="DONE",
                          destinationSessionId="master-session", destinationId="pmaster")
        self.peer(busy=False, notificationVersion=1, notificationTurnId="current")
        self.watcher.observe()
        self.tick(3)
        self.assertEqual([event["turn"] for event in self.watcher.state["outbox"]], ["current"])
        with patch.object(watch, "peer_rpc", return_value={"ok": True}) as rpc:
            self.watcher.deliver({})
        self.assertEqual(rpc.call_count, 1)

    def test_restart_reads_new_journal_created_while_watcher_was_stopped(self):
        self.peer(notificationVersion=1)
        self.watcher.observe(baseline=True)
        self.now += 1
        self.notification()
        self.watcher = watch.Watcher(self.home, self.home / "watcher")
        self.watcher.load()
        self.watcher.observe(baseline=True)
        self.assertEqual([event["turn"] for event in self.watcher.state["outbox"]], ["turn-one"])

    def test_backlog_waits_a_full_cadence_between_persisted_batches(self):
        self.master()
        self.watcher.digest_interval = 30
        for index in range(21):
            self.watcher.enqueue("worker", "worker", str(index), "agent_end", "agent loop ended")
        self.now += 30
        with patch.object(watch, "peer_rpc", return_value={"ok": True}) as rpc:
            self.watcher.deliver({})
        self.assertEqual(rpc.call_count, 1)
        self.assertEqual(len(self.watcher.state["outbox"]), 1)
        self.watcher = watch.Watcher(self.home, self.home / "watcher", digest_interval=30)
        self.watcher.load()
        self.now += 29
        with patch.object(watch, "peer_rpc") as rpc:
            self.watcher.deliver({})
        rpc.assert_not_called()
        self.now += 1
        with patch.object(watch, "peer_rpc", return_value={"ok": True}) as rpc:
            self.watcher.deliver({})
        self.assertEqual(rpc.call_count, 1)
        self.assertEqual(self.watcher.state["outbox"], [])

    def test_yield_pending_jobs_then_quiescence_are_distinct_live_labels(self):
        peer = self.peer()
        event = {"session": "worker-session", "event": "yield", "name": "worker",
                 "kind": "agent_end", "detail": "agent loop ended"}
        snapshots = [
            ({"busy": False, "hasPendingAsyncWork": True, "isSettled": False,
              "activity": {"activeJobs": 1, "activeSubagents": 0}}, "NOT task-complete", "jobs=1"),
            ({"busy": False, "hasPendingAsyncWork": True, "isSettled": False,
              "activity": {"activeJobs": 0, "activeSubagents": 0}}, "NOT task-complete", "jobs=0"),
            ({"busy": False, "hasPendingAsyncWork": False, "isSettled": True,
              "activity": {"activeJobs": 0, "activeSubagents": 0}}, "reports quiescence", "jobs=0"),
            # Known work overrides contradictory settled flags from another host.
            ({"busy": False, "hasPendingAsyncWork": False, "isSettled": True,
              "activity": {"activeJobs": 0, "activeSubagents": 1}}, "NOT task-complete", "active subagents=1"),
            ({"busy": False, "hasPendingAsyncWork": None, "isSettled": None,
              "activity": {"activeJobs": None, "activeSubagents": None}}, "UNKNOWN", "jobs=?"),
            ({"busy": True, "hasPendingAsyncWork": False, "isSettled": True}, "UNKNOWN", "jobs=?"),
            ({"busy": False, "activity": "old incompatible schema"}, "UNKNOWN", "jobs=?"),
        ]
        for info, expected, counts in snapshots:
            with self.subTest(info=info), patch.object(watch, "peer_rpc", return_value={"ok": True, "info": info}):
                live = self.watcher.describe(event, {"worker-session": [peer]})
                self.assertIn("agent yielded", live)
                self.assertIn(expected, live)
                self.assertIn(counts, live)
                self.assertNotIn("task done", live)

    def test_partial_or_mixed_host_status_does_not_establish_quiescence(self):
        first = self.peer()
        second = self.peer("palias")
        event = {"session": "worker-session", "event": "yield", "name": "worker",
                 "kind": "idle_transition", "detail": "observed active -> idle"}
        known = {"busy": False, "isSettled": True, "hasPendingAsyncWork": False,
                 "activity": {"activeJobs": 0, "activeSubagents": 0}}
        for replies in (({"info": known}, {"info": {"busy": False}}),
                        ({"info": known}, ConnectionError("unavailable"))):
            with self.subTest(replies=replies), patch.object(watch, "peer_rpc", side_effect=replies):
                live = self.watcher.describe(event, {"worker-session": [first, second]})
                self.assertIn("UNKNOWN", live)
                self.assertIn("jobs=?", live)

    def test_runtime_permissions_and_symlink_rejection(self):
        self.watcher.save()
        self.assertEqual(stat.S_IMODE(self.watcher.state_dir.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.watcher.state_file.stat().st_mode), 0o600)
        victim = self.home / "victim"
        victim.write_text("untouched")
        link = self.watcher.state_dir / "unsafe"
        link.symlink_to(victim)
        with self.assertRaises(OSError):
            watch.private_open(link)
        self.assertEqual(victim.read_text(), "untouched")


class SocketChecks(unittest.TestCase):
    def test_real_local_rpc_frames(self):
        with tempfile.TemporaryDirectory(prefix="opw-", dir="/tmp") as root:
            path = str(Path(root) / "peer.sock")
            captured = []
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
                server.bind(path)
                server.listen(1)
                server.settimeout(5)

                def respond():
                    with server.accept()[0] as conn:
                        conn.settimeout(5)
                        captured.append(json.loads(conn.makefile("rb").readline()))
                        conn.sendall(b'{"ok":true}\n')

                reader = threading.Thread(target=respond)
                reader.start()
                try:
                    result = watch.peer_rpc({"sock": path}, {"op": "message", "text": "metadata test"})
                finally:
                    reader.join(timeout=5)
                self.assertFalse(reader.is_alive())
                self.assertEqual(result, {"ok": True})
                self.assertEqual(captured, [{"op": "message", "text": "metadata test"}])


class ProcessChecks(unittest.TestCase):
    def test_digest_interval_rejects_nonpositive_and_nonfinite_values(self):
        for value in ("0", "-1", "nan", "inf"):
            with self.subTest(value=value), tempfile.TemporaryDirectory(prefix="opw-", dir="/tmp") as root:
                argv = ["watch.py", "--home", root, "--digest-interval", value]
                with patch.object(sys, "argv", argv), contextlib.redirect_stderr(io.StringIO()):
                    with self.assertRaises(SystemExit) as stopped:
                        watch.main()
                self.assertEqual(stopped.exception.code, 2)
                self.assertFalse((Path(root) / ".omp-peer-watch").exists())

    def test_persistent_start_without_omp_singleton_and_shutdown(self):
        with tempfile.TemporaryDirectory(prefix="opw-", dir="/tmp") as root:
            home = Path(root)
            command = [sys.executable, str(REPO / "tools/watch.py"), "--home", root, "--interval", "0.05"]
            process = subprocess.Popen(command, env={"HOME": root, "PATH": os.environ["PATH"]},
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                state = home / ".omp-peer-watch/completions.json"
                wait_for(lambda: state_ready(state), seconds=5)
                duplicate = subprocess.run(command, capture_output=True, text=True, timeout=5)
                self.assertNotEqual(duplicate.returncode, 0)
                self.assertIn("singleton lock", duplicate.stderr)
                self.assertIsNone(process.poll())
                self.assertEqual(state_ready(state)["outbox"], [])
            finally:
                process.terminate()
                try:
                    report, errors = process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    report, errors = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 0, (report, errors))
            self.assertIn("WATCHER_READY", report)
            self.assertIn("WATCHER_STOPPED", report)
            self.assertNotIn("WATCHER_DELIVERED", report)
            self.assertEqual(stat.S_IMODE((home / ".omp-peer-watch/completion.lock").stat().st_mode), 0o600)


class InstallerChecks(unittest.TestCase):
    def test_label_validation_and_plist_escaping(self):
        for label in ("org.example.peer-watcher", "local.OMP_peers.worker2"):
            self.assertEqual(install_watcher.valid_label(label), label)
        for label in ("", "oneword", "../escape", "org..watcher", "org.watch er", "-org.watcher", "org.watcher/other"):
            with self.subTest(label=label), self.assertRaises(argparse.ArgumentTypeError):
                install_watcher.valid_label(label)
        home = Path("/portable home & team")
        data = install_watcher.render_plist(REPO / "tools/launchd/peer-watcher.plist.in", home,
                                           home / "runtime", Path("/python location/bin/python3"), "org.example.watcher", 42.5)
        document = plistlib.loads(data)
        self.assertEqual(document["ProgramArguments"][3], str(home))
        self.assertEqual(document["Label"], "org.example.watcher")
        self.assertIs(document["RunAtLoad"], True)
        self.assertIs(document["KeepAlive"], True)
        self.assertEqual(document["Umask"], 0o077)
        self.assertEqual(document["ProgramArguments"][-2:], ["--digest-interval", "42.5"])

    def test_install_uninstall_keeps_state_and_purge_removes_known_files(self):
        with tempfile.TemporaryDirectory(prefix="opw-", dir="/tmp") as root:
            home = Path(root)
            runtime = home / "runtime"
            label = "org.example.watcher"
            with patch.object(install_watcher, "launchctl") as ctl:
                ctl.return_value.returncode = 0
                install_watcher.install(home, runtime, label, Path(sys.executable))
                ctl.assert_called_with("bootstrap", "gui/" + str(os.getuid()), str(home / "Library/LaunchAgents" / (label + ".plist")))
                watch.atomic_json(runtime / "completions.json", {"retained": True})
                install_watcher.uninstall(home, runtime, label)
                self.assertTrue((runtime / "completions.json").exists())
                self.assertFalse((runtime / "watch.py").exists())
                install_watcher.install(home, runtime, label, Path(sys.executable))
                install_watcher.uninstall(home, runtime, label, purge=True)
                self.assertFalse(runtime.exists())

    def test_managed_upgrade_and_uninstall_wait_for_kernel_lock_release(self):
        for action in ("upgrade", "uninstall"):
            with self.subTest(action=action), tempfile.TemporaryDirectory(prefix="opw-", dir="/tmp") as root:
                home = Path(root)
                runtime = home / "runtime"
                label = "org.example.watcher"
                with patch.object(install_watcher, "launchctl") as ctl:
                    ctl.return_value.returncode = 0
                    install_watcher.install(home, runtime, label, Path(sys.executable))
                child = subprocess.Popen(
                    [sys.executable, "-c",
                     "import fcntl,sys,time; f=open(sys.argv[1],'a+'); "
                     "fcntl.flock(f,fcntl.LOCK_EX); print('LOCKED',flush=True); "
                     "sys.stdin.readline(); time.sleep(0.1); f.close()",
                     str(runtime / "completion.lock")],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
                )
                try:
                    self.assertEqual(child.stdout.readline().strip(), "LOCKED")

                    def stop_before_exit(*arguments, **_kwargs):
                        if arguments[0] == "bootout":
                            child.stdin.write("stop\n")
                            child.stdin.flush()
                        return subprocess.CompletedProcess(arguments, 0)

                    with patch.object(install_watcher, "launchctl", side_effect=stop_before_exit):
                        if action == "upgrade":
                            install_watcher.install(home, runtime, label, Path(sys.executable))
                            self.assertTrue((runtime / "watch.py").exists())
                        else:
                            install_watcher.uninstall(home, runtime, label, purge=True)
                            self.assertFalse(runtime.exists())
                    self.assertEqual(child.wait(timeout=5), 0)
                finally:
                    if child.poll() is None:
                        child.terminate()
                        child.wait(timeout=5)
                    child.stdin.close()
                    child.stdout.close()

    def test_installer_refuses_unmanaged_or_running_watcher(self):
        with tempfile.TemporaryDirectory(prefix="opw-", dir="/tmp") as root:
            home = Path(root)
            runtime = watch.private_directory(home / "runtime")
            script = runtime / "watch.py"
            script.write_text("do not replace")
            with patch.object(install_watcher, "launchctl") as ctl:
                with self.assertRaisesRegex(ValueError, "unmanaged"):
                    install_watcher.install(home, runtime, "org.example.watcher", Path(sys.executable))
                self.assertEqual(script.read_text(), "do not replace")
                ctl.assert_not_called()
                script.unlink()
                with watch.private_open(runtime / "completion.lock") as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    with self.assertRaisesRegex(RuntimeError, "still running"):
                        install_watcher.install(home, runtime, "org.example.watcher", Path(sys.executable))
                self.assertFalse(script.exists())
                ctl.assert_not_called()


if __name__ == "__main__":
    unittest.main()
