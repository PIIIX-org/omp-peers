# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (c) 2026 PIIIX-org contributors
"""FIFOs planted where the plugin WRITES must not hang a session.

Opening a FIFO for writing blocks until a reader appears. The registry row used to be written through the guessable temp
name `<row>.<pid>.tmp`, and the notifications journal was opened without O_NONBLOCK; a same-user FIFO at either path froze
the event loop. The temp file now has a random name created with O_EXCL; the journal open fails fast.
"""
import hashlib
import os
import time


def run(h):
    worker = h.start()
    row = h.row(worker)
    pid = row["pid"]
    registry_file = h.registry / f"{row['id']}.json"
    session_id = row["sessionId"]

    legacy_tmp = h.registry / f"{row['id']}.json.{pid}.tmp"
    journal_dir = h.registry / "notifications"
    journal_dir.mkdir(parents=True, exist_ok=True)
    journal = journal_dir / f"{hashlib.sha256(session_id.encode()).hexdigest()}.jsonl"
    planted = [legacy_tmp, journal]
    for path in planted:
        path.unlink(missing_ok=True)
        os.mkfifo(path, 0o600)
    try:
        before = registry_file.stat().st_mtime_ns
        time.sleep(6.5)  # at least one 5 s refresh rewrites the registry row
        assert registry_file.stat().st_mtime_ns > before, "the registry row was not rewritten: the refresh is blocked"
        assert row["id"] in h.say(worker, "/peers list")
        # A turn writes to the journal (agent start/end): it must complete although the journal path is a FIFO.
        reply = h.ask(worker, "hello")
        assert reply is not None
        assert h.row(worker)["id"] == row["id"]
        stray = [p.name for p in h.registry.iterdir() if p.name.endswith(".tmp") and p != legacy_tmp]
        assert stray == [], f"temp files were left behind: {stray}"
        print("PASS FIFOs at the old temp name and at the notifications journal do not hang refresh, list or a model turn")
    finally:
        for path in planted:
            path.unlink(missing_ok=True)
