# SPDX-License-Identifier: MIT OR Apache-2.0
"""Fast checks of the existing exit-on-event watcher CLI in a disposable home."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

WATCHER = Path(__file__).resolve().parents[1] / "tools" / "watch.py"


class WatcherCLI(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="omp-watch-test-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.registry = self.home / ".omp" / "run" / "peers"
        self.registry.mkdir(parents=True)
        self.state_dir = self.home / ".omp-peer-watch"
        self.state_dir.mkdir()
        self.write_json(self.state_dir / "state.json", {})

    @staticmethod
    def write_json(path, value):
        path.write_text(json.dumps(value), encoding="utf-8")

    def peer(self, peer_id, name="fixture-worker", busy=False, sid="fixture-session"):
        self.write_json(self.registry / f"{peer_id}.json", {
            "id": peer_id, "name": name, "busy": busy,
            "sessionId": sid, "context": "fixture",
        })

    def previous(self, peers):
        self.write_json(self.state_dir / "state.json", peers)

    def assistant(self, text):
        sessions = self.home / ".omp" / "agent" / "sessions" / "fixture-project"
        sessions.mkdir(parents=True)
        # Match the host's compact JSONL representation, including mixed content.
        (sessions / "fixture-session.jsonl").write_text(json.dumps({
            "message": {"role": "assistant", "content": [
                {"type": "thinking", "thinking": "not visible"},
                {"type": "text", "text": text},
            ]},
        }, separators=(",", ":")) + "\n", encoding="utf-8")

    def run_watcher(self):
        env = {"HOME": str(self.home), "PATH": os.environ.get("PATH", ""),
               "PYTHONIOENCODING": "utf-8"}
        result = subprocess.run(
            [sys.executable, str(WATCHER)], env=env, cwd=self.home,
            capture_output=True, text=True, timeout=8,
        )
        self.assertEqual(result.returncode, 0, "Watcher failed in disposable fixture home")
        self.assertEqual(result.stderr, "")
        return result.stdout

    def test_new_peer_ignores_master_ignored_and_malformed_registry(self):
        self.peer("p111111")
        self.peer("p222222", name="fixture-master")
        self.peer("p333333", name="fixture-ignored")
        self.write_json(self.registry / "master.json", {"id": "p222222"})
        (self.state_dir / "ignore.txt").write_text("p333333\n", encoding="utf-8")
        (self.registry / "p444444.json").write_text("not json", encoding="utf-8")
        report = self.run_watcher()
        self.assertIn("1 event(s)", report)
        self.assertIn("fixture-worker (p111111): NEW session", report)
        self.assertNotIn("fixture-master", report)
        self.assertNotIn("fixture-ignored", report)
        self.assertEqual(set(json.loads((self.state_dir / "state.json").read_text())), {"p111111"})

    def test_departed_peer_reports_and_persists_empty_snapshot(self):
        self.previous({"p111111": {"name": "fixture-worker", "busy": False}})
        self.assertIn("fixture-worker (p111111): session GONE", self.run_watcher())
        self.assertEqual(json.loads((self.state_dir / "state.json").read_text()), {})

    def test_busy_to_idle_with_visible_question_wakes(self):
        self.previous({"p111111": {"name": "fixture-worker", "busy": True}})
        self.peer("p111111")
        self.assistant("Which option needs approval?")
        self.assertIn("finished its turn (busy -> idle)", self.run_watcher())
        self.assertFalse((self.state_dir / "skipped.log").exists())

    def test_acknowledgement_is_skipped_while_departure_still_wakes(self):
        self.previous({
            "p111111": {"name": "fixture-worker", "busy": True},
            "p222222": {"name": "fixture-departed", "busy": False},
        })
        self.peer("p111111")
        self.assistant("No reply needed. Nothing to decide.")
        report = self.run_watcher()
        self.assertNotIn("finished its turn", report)
        self.assertIn("fixture-departed (p222222): session GONE", report)
        self.assertIn("1 acknowledgement-only idles skipped", report)
        self.assertIn("No reply needed", (self.state_dir / "skipped.log").read_text())

    def test_missing_assistant_text_wakes_conservatively(self):
        self.previous({"p111111": {"name": "fixture-worker", "busy": True}})
        self.peer("p111111", sid="")
        self.assertIn("finished its turn (busy -> idle)", self.run_watcher())


if __name__ == "__main__":
    unittest.main()
