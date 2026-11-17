#!/usr/bin/env python3
# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (c) 2026 PIIIX-org contributors
"""The watcher's file readers must not hang on a FIFO planted by a same-user process."""
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "tools"))
import watch


def within(seconds, call):
    """Run `call` on a thread; fail (instead of hanging the suite) if it does not return."""
    outcome = {}

    def target():
        try:
            outcome["value"] = call()
        except BaseException as error:  # noqa: BLE001 - reported to the caller
            outcome["error"] = error

    thread = threading.Thread(target=target, daemon=True)
    thread.start()
    thread.join(seconds)
    assert not thread.is_alive(), "the read blocked on a FIFO"
    if "error" in outcome:
        raise outcome["error"]
    return outcome["value"]


class FifoReadTests(unittest.TestCase):
    def test_read_json_returns_empty_for_a_fifo_and_still_reads_regular_files(self):
        with tempfile.TemporaryDirectory() as root:
            fifo = Path(root) / "master.json"
            os.mkfifo(fifo)
            self.assertEqual(within(5, lambda: watch.read_json(fifo)), {})
            regular = Path(root) / "peer.json"
            regular.write_text(json.dumps({"id": "p1"}))
            self.assertEqual(watch.read_json(regular), {"id": "p1"})
            self.assertEqual(watch.read_json(Path(root) / "missing.json"), {})
            regular.write_text("[1]")
            self.assertEqual(watch.read_json(regular), {})

    def test_open_regular_refuses_a_fifo_with_oserror_and_opens_files(self):
        with tempfile.TemporaryDirectory() as root:
            fifo = Path(root) / "n.jsonl"
            os.mkfifo(fifo)
            with self.assertRaises(OSError):
                within(5, lambda: watch.open_regular(fifo))
            regular = Path(root) / "ok.jsonl"
            regular.write_bytes(b"line\n")
            with watch.open_regular(regular) as source:
                self.assertEqual(source.readline(), b"line\n")


if __name__ == "__main__":
    unittest.main()
