# SPDX-License-Identifier: MIT OR Apache-2.0
"""Synthetic scanner fixtures are assembled so the tests contain no real secrets."""
import contextlib
import io
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from scripts import leak_scan


class LeakScanner(unittest.TestCase):
    def test_credentials_and_identifiers(self):
        cases = [
            ("credential", "sk-" + "x" * 24),
            ("credential", "ghp_" + "x" * 24),
            ("credential", "github_pat_" + "x" * 24),
            ("credential", "-----BEGIN " + "PRIVATE KEY-----"),
            ("credential assignment", '"apiKey": "' + "x" * 24 + '"'),
            ("credential assignment", '"refresh_token": "' + "x" * 24 + '"'),
            ("authorization", "Bearer " + "x" * 24),
            ("email", "private-person" + "@" + "example.test"),
            ("session identifier", "12345678-" + "1234-4234-" + "8234-123456789abc"),
            ("personal path", "/Us" + "ers/fixture-person/project"),
            ("personal path", "/ho" + "me/fixture-person/project"),
            ("personal path", "C:" + "\\Users\\fixture-person\\project"),
            ("runtime artifact path", "~/.omp/agent/sessions/" + "private-session.jsonl"),
            ("nonloopback IP", "192.0." + "2.1"),
            ("nonloopback IP", ":".join(("2001", "db8", "", "1"))),
        ]
        for category, fixture in cases:
            with self.subTest(category=category):
                self.assertIn(category, leak_scan.line_findings(fixture))

    def test_loopback_license_and_public_package_specifiers_are_safe(self):
        for value in (
            "http://127.0.0.1:9/v1", "http://[::1]:9/v1", "127.10.20.30",
            "@oh-my-pi/pi-coding-agent", "npm:@eslint/js@9.39.5",
            "SPDX-License-Identifier: MIT OR Apache-2.0",
            "https://www.apache.org/licenses/LICENSE-2.0",
            "~/.omp/agent/sessions/*/*{sid}.jsonl",
            "~/.omp-peer-watch/state.json", "~/.omp-peer-watch/skipped.log",
            "~/.omp/run/peers/master.json",
            "$HOME/.omp-peer-watch/watch.py",
        ):
            with self.subTest(kind="public metadata"):
                self.assertEqual(leak_scan.line_findings(value), set())

    def test_private_artifact_paths(self):
        for value in (
            ".env", ".env.local", "backup/auth.json", "logs/output.txt",
            "dump.jsonl", "transcripts/reply.txt", ".omp/run/peers/fixture.json",
            ".omp-peer-watch/state.json", "provider.key",
        ):
            with self.subTest(kind="private artifact"):
                self.assertTrue(leak_scan.path_findings(value))

    def test_scan_covers_tracked_and_nonignored_files_without_following_links(self):
        with tempfile.TemporaryDirectory(prefix="omp-leak-test-") as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "--quiet", directory], check=True)
            (root / ".gitignore").write_text("ignored.txt\n", encoding="utf-8")
            token = "ghp_" + "x" * 24
            (root / "tracked.txt").write_text(token, encoding="utf-8")
            subprocess.run(["git", "add", "tracked.txt"], cwd=root, check=True)
            (root / "untracked.txt").write_text(token, encoding="utf-8")
            (root / "ignored.txt").write_text(token, encoding="utf-8")
            (root / "binary.dat").write_bytes(b"\0private")
            (root / "link.txt").symlink_to("ignored.txt")
            categories = [category for _, _, category in leak_scan.scan(root)]
            self.assertEqual(categories.count("credential"), 2)
            self.assertIn("unscannable binary", categories)
            self.assertIn("symbolic link", categories)

    def test_failure_output_is_redacted(self):
        output = io.StringIO()
        with patch.object(leak_scan, "scan", return_value=[(3, 7, "credential")]):
            with contextlib.redirect_stderr(output):
                self.assertEqual(leak_scan.main(), 1)
        self.assertEqual(output.getvalue(),
                         "Leak scan: file #3, line 7: credential (value/path redacted)\n")


if __name__ == "__main__":
    unittest.main()
