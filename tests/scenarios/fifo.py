# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (c) 2026 PIIIX-org contributors
"""A same-user FIFO planted where the plugin reads a file must not hang a session.

A FIFO with no writer blocks a plain read forever, which would freeze the event loop of every session that reads it:
the periodic refresh reads `master.json` every 5 s, and `/peers board` reads `peers.json`. (Registry rows are read through the same helper;
they are not planted here because this harness reads `p*.json` itself.)
"""
import os
import time

from smoke import wait_for


def run(h):
    worker = h.start()
    wid = h.row(worker)["id"]
    assert h.say(worker, "/peers master")
    assert h.row(worker)["id"] == wid

    planted = [h.registry / "master.json", h.agent / "peers.json"]
    for path in planted:
        if path.exists():
            path.unlink()
        os.mkfifo(path, 0o600)
    try:
        time.sleep(6.5)  # at least one 5 s refresh reads master.json
        # The session still answers: the event loop was never blocked by an open() or read() of a FIFO.
        listing = h.say(worker, "/peers list")
        assert wid in listing, listing
        board = h.say(worker, "/peers board list")
        assert "board" in board.lower() or "no " in board.lower(), board
        assert h.say(worker, "/peers board stale") is not None
        assert h.row(worker)["id"] == wid, "the session kept publishing its registry row"
        print("PASS FIFOs at master.json and peers.json do not hang refresh, list or board")
    finally:
        for path in planted:
            path.unlink(missing_ok=True)
    # With the FIFOs gone the session still answers and still publishes its row.
    assert wid in h.say(worker, "/peers list")
    assert h.row(worker)["id"] == wid
    print("PASS the session keeps answering once the FIFOs are removed")
