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
    def run_harness(self, script, *args, returncode=0):
        bun = shutil.which("bun")
        self.assertIsNotNone(bun, "Install Bun and npm ci --ignore-scripts before running the routing regression")
        with tempfile.TemporaryDirectory(prefix="opn-", dir="/tmp") as root:
            home = Path(root)
            env = {"HOME": root, "PATH": os.environ["PATH"], "TERM": "dumb", "TMPDIR": root,
                   "PI_CODING_AGENT_DIR": str(home / ".omp/agent"),
                   "XDG_CONFIG_HOME": str(home / "config"), "XDG_DATA_HOME": str(home / "data"),
                   "XDG_CACHE_HOME": str(home / "cache"), "XDG_STATE_HOME": str(home / "state")}
            # Launched from Python, so the spawn wrapper does not apply: preload the outbound-network guard explicitly.
            result = subprocess.run([bun, "--preload", str(REPO / "tests" / "netguard.ts"), str(REPO / "tests" / script), *args],
                                    env=env, cwd=root, capture_output=True, text=True, timeout=45)
            self.assertEqual(result.returncode, returncode, result.stdout + result.stderr)
            self.assertNotIn("network guard: refused", result.stderr)
            return result

    def test_ordinary_peer_route_and_exact_turn_receipts(self):
        result = self.run_harness("notifications.ts")
        self.assertIn("PASS offline notification routing", result.stdout)

    def test_lifecycle_pins_identity_and_persists_minimal_metadata(self):
        result = self.run_harness("lifecycle.ts")
        self.assertIn("PASS lifecycle", result.stdout)
        self.assertNotIn("MaxListenersExceededWarning", result.stderr)

    def test_restart_rule_and_resume_policy_through_the_extension(self):
        result = self.run_harness("restart_rule.ts")
        self.assertIn("PASS restart rule and resume policy", result.stdout)

    def test_only_a_normal_exit_marks_the_run_clean(self):
        """A nonzero exit (a crash path) leaves `clean: false`, so the next start is treated as a blackout; exit code 0 is a clean exit."""
        crashed = self.run_harness("exit_clean.ts", "1", returncode=1)
        self.assertIn('"clean":false', crashed.stdout)
        normal = self.run_harness("exit_clean.ts", "0")
        self.assertIn('"clean":true', normal.stdout)


if __name__ == "__main__":
    unittest.main()