#!/usr/bin/env python3
# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (c) 2026 PIIIX-org contributors
"""Consumer regression runs extension globals only in a disposable, keyless HOME."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]


class PinnedRoutingChecks(unittest.TestCase):
    def test_pins_explicit_atomicity_subagents_and_busy_dispatch(self):
        bun = shutil.which("bun")
        self.assertIsNotNone(bun, "Install Bun and npm ci --ignore-scripts first")
        with tempfile.TemporaryDirectory(prefix="opr-", dir="/tmp") as root:
            home = Path(root)
            env = {"HOME": root, "PATH": os.environ["PATH"], "TERM": "dumb", "TMPDIR": root,
                   "OMP_PEERS_ROUTING_TEST": "isolated",
                   "PI_CODING_AGENT_DIR": str(home / ".omp/agent"),
                   "XDG_CONFIG_HOME": str(home / "config"), "XDG_DATA_HOME": str(home / "data"),
                   "XDG_CACHE_HOME": str(home / "cache"), "XDG_STATE_HOME": str(home / "state")}
            result = subprocess.run([bun, "test", str(REPO / "tests/routing.test.ts")],
                                    env=env, cwd=root, capture_output=True, text=True, timeout=45)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("PASS offline pinned routing", result.stdout)


if __name__ == "__main__":
    unittest.main()
