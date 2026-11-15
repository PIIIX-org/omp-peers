# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (c) 2026 PIIIX-org contributors
"""/peers board through two real OMP processes: assignment, a structured report, restart, read-only listing."""
import json
import re
import stat
import time

from smoke import wait_for

HEADER = "statuses are claims by the writer, not verified"


def normalized(text):
    """Ages tick with wall time; everything else in a listing is exact."""
    return re.sub(r"(recorded|report) \d+[mhd] ago", r"\1 <age> ago", text)


def run(h):
    master, worker = h.start(), h.start()
    master_row, worker_row = h.row(master), h.row(worker)
    master_id, worker_id, master_name = master_row["id"], worker_row["id"], master_row["name"]
    assert h.say(master, "/peers master")
    h.say(master, f"/peers do {worker_id} rename worker-b")
    wait_for(lambda: h.row(worker)["name"] == "worker-b")
    board_file = h.state / "board.json"

    assert h.say(master, "/peers board") == "no board entries"
    assert not h.state.exists() or not board_file.exists()
    print("PASS an empty board lists nothing and writes nothing")

    worker_frames, requests = len(worker.frames), len(h.gateway.requests)
    assigned = h.say(master, "/peers board assign worker-b write the parser")
    assert assigned == f"assigned worker-b ({worker_id}): write the parser; recorded only: nothing was sent to that session", assigned
    listing = h.say(master, "/peers board list")
    assert normalized(listing) == "\n".join([
        f"1 board entry; stale after 24h without an update (done never goes stale); {HEADER}",
        f"  worker-b ({worker_id})  assigned (progress unknown: nothing reported)  running",
        "      task: write the parser",
        f"      recorded <age> ago, claimed by {master_name} ({master_id})",
    ]), listing
    time.sleep(0.5)
    assert len(worker.frames) == worker_frames and len(h.gateway.requests) == requests, (worker.frames[worker_frames:], h.gateway.requests[requests:])
    print("PASS assign records one entry keyed by the stable id; nothing reaches the worker or the gateway")

    assert h.say(worker, "/peers board assign worker-b sneaky") == "error: only the master session may assign tasks; run /peers master first"
    assert h.say(worker, f"/peers board clear {master_id}") == "error: only the master session or the session itself may change this entry"
    assert json.loads(board_file.read_text())["entries"][0]["task"] == "write the parser"
    print("PASS a non-master cannot assign or clear another session's entry")

    report = {"kind": "DONE", "unit": "Parser rewrite", "evidence": {"description": "Offline checks passed"}}
    before_turns = len(h.gateway.requests)
    start = len(master.frames)
    sent = h.say(worker, f"/peers report {master_id} " + json.dumps(report))
    assert sent == f"{master_name} ({master_id}): ok", sent
    # An accepted report is delivered like any peer message, so the master takes a real turn at the loopback gateway.
    wait_for(lambda: any(f.get("type") == "agent_end" for f in master.frames[start:]), seconds=30)
    assert len(h.gateway.requests) == before_turns + 1
    listing = h.say(master, "/peers board list")
    assert normalized(listing) == "\n".join([
        f"1 board entry; stale after 24h without an update (done never goes stale); {HEADER}",
        f"  worker-b ({worker_id})  done  running",
        "      task: write the parser",
        "      unit: Parser rewrite",
        f"      report <age> ago, claimed by worker-b ({worker_id})",
    ]), listing
    raw = board_file.read_text()
    state = json.loads(raw)
    assert state["version"] == 1 and len(state["entries"]) == 1 and state["entries"][0]["source"] == "report", state
    assert "Offline checks passed" not in raw and "sneaky" not in raw
    assert stat.S_IMODE(h.state.stat().st_mode) == 0o700 and stat.S_IMODE(board_file.stat().st_mode) == 0o600
    print("PASS a real structured DONE report marks the entry done, claimed by the sender, keeping the task")

    session_file = worker.call("get_state")["sessionFile"]
    worker.close()
    wait_for(lambda: not (h.registry / f"{worker_id}.json").exists())
    gone = h.say(master, "/peers board list")
    assert f"  worker-b ({worker_id})  done  not running" in gone, gone
    worker = h.start(resume=session_file)
    assert h.row(worker)["id"] == worker_id
    wait_for(lambda: f"  worker-b ({worker_id})  done  running" in h.say(master, "/peers board list"))
    assert "task: write the parser" in h.say(master, "/peers board list")
    print("PASS the entry survives the worker stopping and restarting from the same session file")

    stat_before, worker_frames, requests = board_file.stat(), len(worker.frames), len(h.gateway.requests)
    for command in ("/peers board", "/peers board list", "/peers board stale", "/peers board stale 1"):
        h.say(master, command)
        h.say(worker, command)
    time.sleep(0.5)
    stat_after = board_file.stat()
    assert (stat_after.st_mtime_ns, stat_after.st_ino) == (stat_before.st_mtime_ns, stat_before.st_ino)
    assert not any(f.get("type") in ("agent_start", "message_start") for f in worker.frames[worker_frames:])
    assert len(h.gateway.requests) == requests
    print("PASS listing leaves the file untouched and starts no worker turn or gateway request")

    assert h.say(master, "/peers board set worker-b blocked waiting on review") == \
        f"set worker-b ({worker_id}) to blocked; recorded only: nothing was sent to that session"
    (h.agent / "peers.json").write_text(json.dumps({"board": {"staleHours": 0.0002}}))
    time.sleep(1.2)
    stale = h.say(master, "/peers board stale")
    assert stale.split("\n")[0] == "1 stale entry (no update for 0.0002h or more; done never goes stale)", stale
    assert f"  worker-b ({worker_id})  stale (blocked, no update for 0m)  running" in stale and "note: waiting on review" in stale, stale
    assert h.say(worker, f"/peers board clear {worker_id}") == f"cleared worker-b ({worker_id})"
    assert h.say(master, "/peers board") == "no board entries"
    print("PASS a configured threshold marks the entry stale with its age; the session clears its own entry")
