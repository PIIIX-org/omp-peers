#!/usr/bin/env python3
# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (c) 2026 PIIIX-org contributors
"""Run the extension's consumer-level local-socket regression without OMP/provider turns."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]


class NotificationRoutingChecks(unittest.TestCase):
    def test_ordinary_peer_route_and_exact_turn_receipts(self):
        bun = shutil.which("bun")
        self.assertIsNotNone(bun, "Install Bun and npm ci --ignore-scripts before running the routing regression")
        with tempfile.TemporaryDirectory(prefix="opn-", dir="/tmp") as root:
            home = Path(root)
            env = {"HOME": root, "PATH": os.environ["PATH"], "TERM": "dumb", "TMPDIR": root,
                   "PI_CODING_AGENT_DIR": str(home / ".omp/agent"),
                   "XDG_CONFIG_HOME": str(home / "config"), "XDG_DATA_HOME": str(home / "data"),
                   "XDG_CACHE_HOME": str(home / "cache"), "XDG_STATE_HOME": str(home / "state")}
            result = subprocess.run([bun, str(REPO / "tests/notifications.ts")],
                                    env=env, cwd=root, capture_output=True, text=True, timeout=45)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("PASS offline notification routing", result.stdout)


if __name__ == "__main__":
    unittest.main()
