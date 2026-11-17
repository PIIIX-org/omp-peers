# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (c) 2026 PIIIX-org contributors
"""/peers audit through two real OMP processes: master controls are recorded privately, with no content."""
import json
import socket
import stat
import time

from smoke import wait_for

PROMPT = "SENTINEL-PROMPT-BODY please reply with the word ok"
VALUE = "SENTINEL-SETTING-VALUE"
SELECTOR = "smoke/first"
HEX = "ab" * 16
STATUS_OFF = "audit: off (opt-in; /peers audit on enables it)"


def raw_call(sock_path, request):
    """Talk to a session's socket directly, as any local process running as this user could."""
    with socket.socket(socket.AF_UNIX) as conn:
        conn.settimeout(10)
        conn.connect(sock_path)
        conn.sendall((json.dumps(request) + "\n").encode())
        data = b""
        while not data.endswith(b"\n"):
            chunk = conn.recv(65536)
            if not chunk:
                break
            data += chunk
    return json.loads(data)


def shape(record):
    return (record["side"], record["phase"], record["op"], record.get("outcome"), record.get("reason"))


def run(h):
    master, worker = h.start(), h.start()
    mrow, wrow = h.row(master), h.row(worker)
    mid, wid = mrow["id"], wrow["id"]
    log, config = h.state / "audit.jsonl", h.state / "audit-config.json"
    assert h.say(master, "/peers master")

    # Off by default: a control op leaves no log and no audit state at all.
    assert h.say(master, "/peers audit") == STATUS_OFF + "\n" + \
        "files: ~/.omp/agent/peer-state/audit.jsonl absent; previous absent\nrecords: 0\noldest: none\nnewest: none\n" \
        "limits: maxBytes 1048576, maxAgeDays 30 (~/.omp/agent/peers.json \"audit\"); at most one previous file is kept\n" \
        "last write error (this session): none"
    assert h.say(master, f"/peers do {wid} rename worker-a") == f"{wrow['name']} ({wid}): ok"
    wait_for(lambda: h.row(worker)["name"] == "worker-a")
    assert not log.exists() and not config.exists()
    print("PASS audit is off by default: a control op writes no log and no audit state")

    assert h.say(master, "/peers audit on").startswith("audit log on: master control attempts and outcomes are recorded locally in ")
    assert h.say(master, "/peers audit tail") == "no audit records"

    # Master controls, including a real worker turn from the sentinel prompt.
    start = len(worker.frames)
    reply = h.say(master, f"/peers do {wid} prompt {PROMPT}")
    assert reply.splitlines()[-1] == f"worker-a ({wid}): ok (kept model=smoke/first, effort=undefined; reason=session pin (default; /peers unpin opts in))", reply
    wait_for(lambda: any(f.get("type") == "agent_end" for f in worker.frames[start:]), seconds=30)
    assert h.say(master, f"/peers do {wid} model {SELECTOR}").startswith("worker-a (" + wid + "): ok")
    set_reply = h.say(master, "/peers set " + wid + ' set task.agentModelOverrides {"task":"@' + VALUE + '"}')
    assert set_reply.startswith("worker-a (" + wid + "): task.agentModelOverrides = "), set_reply
    assert h.say(master, f"/peers do {wid} effort bogus") == f"worker-a ({wid}): failed: effort must be one of off, minimal, low, medium, high, xhigh, max"
    assert "protected and cannot be changed remotely" in h.say(master, f"/peers set {wid} get auth.broker.url")
    assert h.say(master, f"/peers do {wid} tail 3").startswith("worker-a (" + wid + "):")
    assert h.say(master, f"/peers do {wid} rename worker-b") == f"worker-a ({wid}): ok"
    wait_for(lambda: h.row(worker)["name"] == "worker-b")

    # Refusals reach the receiver: locked, inbound refused; and a non-master claim over the raw socket.
    assert h.say(worker, "/peers lock") == "Control from master: refused"
    assert h.say(master, f"/peers do {wid} abort") == f"worker-b ({wid}): failed: peer is locked (control refused)"
    assert h.say(worker, "/peers unlock") == "Control from master: allowed"
    assert h.say(worker, "/peers refuse") == "Inbound peer requests: refuse"
    assert h.say(master, f"/peers do {wid} abort") == f"worker-b ({wid}): failed: peer refuses inbound requests"
    assert h.say(worker, "/peers accept") == "Inbound peer requests: accept"
    forged = raw_call(wrow["sock"], {"op": "abort", "from": {"id": "p00000000000000ff", "name": "imposter"}, "request": HEX})
    assert forged == {"ok": False, "error": "sender is not the master session"}, forged
    anonymous = raw_call(wrow["sock"], {"op": "rename", "text": PROMPT, "request": "../not-a-request-id"})
    assert anonymous == {"ok": False, "error": "sender is not the master session"}, anonymous
    # Status and plain messages are not control ops and are not recorded.
    h.say(master, f"/peers do {wid} status")

    # --- the file ---
    assert stat.S_IMODE(h.state.stat().st_mode) == 0o700, oct(h.state.stat().st_mode)
    assert stat.S_IMODE(log.stat().st_mode) == 0o600, oct(log.stat().st_mode)
    raw = log.read_text()
    for sentinel in ("SENTINEL", PROMPT, VALUE):
        assert sentinel not in raw, sentinel
    records = [json.loads(line) for line in raw.splitlines()]
    assert all(r["v"] == 1 and r["event"] and len(r["event"]) == 32 for r in records)
    assert len({r["event"] for r in records}) == len(records)
    assert all(len(line.encode()) < 4096 for line in raw.splitlines())

    by_request = {}
    for r in records:
        by_request.setdefault(r["request"], []).append(r)
    pair = [("sender", "attempted"), ("receiver", "attempted"), ("receiver", "completed"), ("sender", "completed")]
    ordered = [group for group in by_request.values() if len(group) == 4]
    assert [[(r["side"], r["phase"]) for r in group] for group in ordered] == [pair] * 9, by_request
    assert [(group[0]["op"], group[3]["outcome"], group[3].get("reason")) for group in ordered] == [
        ("prompt", "ok", None), ("model", "ok", None), ("setting", "ok", None), ("effort", "failed", "invalid-argument"),
        ("setting", "refused", "protected-setting"), ("tail", "ok", None), ("rename", "ok", None),
        ("abort", "refused", "locked"), ("abort", "refused", "inbound-refused"),
    ]
    for group in ordered:
        sender_att, receiver_att, receiver_done, sender_done = group
        assert shape(sender_att) == ("sender", "attempted", sender_att["op"], None, None)
        # Both sides see the same logical actor and target; the receiver's outcome equals what the sender was told.
        for r in group:
            assert r["actorClaim"] == mid and r["actorClaimName"] == mrow["name"], r
            assert r["targetId"] == wid and r["targetName"] in ("worker-a", "worker-b"), r
        assert (receiver_done["outcome"], receiver_done.get("reason")) == (sender_done["outcome"], sender_done.get("reason"))
        assert "masterChecked" not in sender_att and "masterChecked" not in sender_done and "masterChecked" not in receiver_att
        assert sender_att["ts"] <= receiver_att["ts"] <= receiver_done["ts"] <= sender_done["ts"]
        # Locked and inbound-refused sessions stop before the master comparison; the others passed it.
        expected = None if receiver_done.get("reason") in ("locked", "inbound-refused") else True
        assert receiver_done.get("masterChecked") == expected, receiver_done

    sent = [group[0].get("params") for group in ordered]
    assert sent == [
        {"textLength": len(PROMPT.encode())}, {"selector": SELECTOR}, {"mode": "set", "key": "task.agentModelOverrides"},
        {"effort": "bogus"}, {"mode": "get", "key": "auth.broker.url"}, {"n": 3}, {"textLength": len("worker-b")}, None, None,
    ], sent
    # The receiver also sees the tier the master's automatic routing attached to the prompt.
    received = ordered[0][1]["params"]
    assert received["textLength"] == len(PROMPT.encode()) and received["tier"] in ("light", "standard", "heavy"), received
    assert [group[1].get("params") for group in ordered[1:]] == sent[1:]

    # Raw-socket claims: only the receiver records them, as claims, with a failed master comparison.
    forged_pair = by_request[HEX]
    assert [shape(r) for r in forged_pair] == [("receiver", "attempted", "abort", None, None), ("receiver", "completed", "abort", "refused", "not-master")]
    assert forged_pair[1]["masterChecked"] is False
    assert forged_pair[0]["actorClaim"] == "p00000000000000ff" and forged_pair[0]["actorClaimName"] == "imposter"
    assert forged_pair[0]["targetId"] == wid and "actorId" not in forged_pair[0]
    loose = [group for group in by_request.values() if len(group) == 2 and group is not forged_pair]
    assert len(loose) == 1 and loose[0][0]["request"] != "../not-a-request-id" and len(loose[0][0]["request"]) == 32
    assert loose[0][0]["actorClaim"] == "unknown" and "actorClaimName" not in loose[0][0]
    assert loose[0][0]["params"] == {"textLength": len(PROMPT.encode())}
    assert len(records) == len(ordered) * 4 + 4
    print("PASS attempted+completed pairs share request ids across sender and receiver; refusals recorded; claims kept as claims")
    print("PASS no prompt text or setting value appears in the audit file; file 0600 in a 0700 directory")

    # Inspection is read-only (h.say fails if a turn starts) and redacted.
    tail = h.say(master, "/peers audit tail 5").split("\n")
    assert tail[0] == "last 5 of %d record(s), oldest first (actors are sender claims, not authenticated):" % len(records)
    assert len(tail) == 6 and all(" req=" in line for line in tail[1:])
    assert "SENTINEL" not in "\n".join(tail) and any('claimed-actor=p00000000000000ff "imposter"' in line for line in tail)
    status = h.say(worker, "/peers audit status").split("\n")
    assert status[0] == "audit: on (/peers audit off stops recording)" and status[2] == f"records: {len(records)}", status
    assert status[-1] == "last write error (this session): none"
    assert h.say(master, "/peers audit tail 51") == "error: tail shows at most 50 records"
    print("PASS audit tail and status are read-only, redacted and bounded")

    assert "--yes" in h.say(master, "/peers audit clear") and log.exists()
    assert h.say(worker, "/peers audit clear --yes") == "audit log cleared: removed 1 file(s)"
    assert not log.exists()
    assert h.say(master, "/peers audit tail") == "no audit records"
    assert h.say(master, f"/peers do {wid} abort") == f"worker-b ({wid}): ok"
    assert len(log.read_text().splitlines()) == 4 and stat.S_IMODE(log.stat().st_mode) == 0o600

    # A log that cannot be written safely never breaks or blocks the control op: the session warns once and status says why.
    problem = "audit.jsonl is accessible to group or others; chmod 600 it or delete it"
    log.chmod(0o644)
    start = len(master.frames)
    master.call("prompt", message=f"/peers do {wid} abort")
    wait_for(lambda: sum(f.get("method") == "notify" for f in master.frames[start:]) >= 2)
    shown = [f["message"] for f in master.frames[start:] if f.get("method") == "notify"]
    assert shown == [f"peers audit: control not recorded ({problem}); see /peers audit status", f"worker-b ({wid}): ok"], shown
    assert h.say(worker, "/peers audit status").splitlines()[-1].startswith(f"last write error (this session): {problem} at ")
    assert h.say(master, "/peers audit tail") == f"error: {problem}"
    assert len(log.read_text().splitlines()) == 4
    log.chmod(0o600)
    assert h.say(master, f"/peers do {wid} abort") == f"worker-b ({wid}): ok"
    assert len(log.read_text().splitlines()) == 8
    assert h.say(master, "/peers audit status").splitlines()[-1] == "last write error (this session): none"
    assert h.say(master, "/peers audit off").startswith("audit log off: nothing more is recorded")
    assert h.say(master, f"/peers do {wid} abort") == f"worker-b ({wid}): ok"
    assert len(log.read_text().splitlines()) == 8
    print("PASS audit clear needs --yes and deletes the log; recording resumes while on and stops when off")
    print("PASS an unwritable log warns once, shows in status and tail, and never blocks the control op")

    # Pause, a broadcast and a shutdown, on a fresh log. A third session joins; it is named while auditing is still off.
    worker2 = h.start()
    w2row = h.row(worker2)
    w2id = w2row["id"]
    assert h.say(master, f"/peers do {w2id} rename worker-c") == f"{w2row['name']} ({w2id}): ok"
    wait_for(lambda: h.row(worker2)["name"] == "worker-c")
    assert h.say(master, "/peers audit clear --yes") == "audit log cleared: removed 1 file(s)"
    assert h.say(master, "/peers audit on").startswith("audit log on: ")

    reason = "SENTINEL-PAUSE-REASON waiting for review"
    assert h.say(master, f"/peers do {wid} pause {reason}") == f"worker-b ({wid}): ok (paused)"
    not_delivered = f"not delivered: worker-b is paused; resend after its user resumes it ({wid})"
    assert h.say(master, f"/peers do {wid} prompt run the suite").splitlines()[-1] == not_delivered
    assert h.say(worker, "/peers resume") == f"resumed worker-b ({wid}) (it was paused by the master): wake-triggering messages and prompts are accepted again"
    wait_for(lambda: h.row(worker)["paused"] is False)

    start = len(master.frames)
    master.call("prompt", message="/peers do all compact")
    wait_for(lambda: any(f.get("method") == "notify" for f in master.frames[start:]))
    broadcast = next(f["message"] for f in master.frames[start:] if f.get("method") == "notify")
    assert sorted(broadcast.splitlines()) == sorted([f"worker-b ({wid}): ok", f"worker-c ({w2id}): ok"]), broadcast

    assert h.say(master, f"/peers do {w2id} shutdown") == f"worker-c ({w2id}): ok"
    # In RPC mode the host acts on a requested shutdown when the next input frame arrives (after the 150 ms timer).
    time.sleep(0.5)
    worker2.proc.stdin.write(json.dumps({"type": "get_state", "id": "wake"}) + "\n")
    worker2.proc.stdin.flush()
    wait_for(lambda: worker2.proc.poll() is not None, seconds=30)

    raw = log.read_text()
    assert "SENTINEL" not in raw
    records = [json.loads(line) for line in raw.splitlines()]
    assert len(records) == 20, len(records)
    groups = {}
    for r in records:
        groups.setdefault(r["request"], []).append(r)
    assert len(groups) == 5 and all([(r["side"], r["phase"]) for r in g] == pair for g in groups.values()), groups
    ordered = sorted(groups.values(), key=lambda g: g[0]["ts"])
    assert [(g[0]["op"], g[0]["targetId"]) for g in ordered[:2]] == [("pause", wid), ("prompt", wid)]
    assert [(g[3]["outcome"], g[3].get("reason")) for g in ordered[:2]] == [("ok", None), ("refused", "paused")]
    assert [(g[2]["outcome"], g[2].get("reason"), g[2]["masterChecked"]) for g in ordered[:2]] == [("ok", None, True), ("refused", "paused", True)]
    assert ordered[0][0]["params"] == {"textLength": len(reason.encode())} and ordered[1][0]["params"] == {"textLength": len("run the suite")}
    broadcasts = ordered[2:4]
    assert {g[0]["op"] for g in broadcasts} == {"compact"} and {g[0]["targetId"] for g in broadcasts} == {wid, w2id}
    assert len({g[0]["request"] for g in broadcasts}) == 2
    assert all(g[3]["outcome"] == "deferred" and "reason" not in g[3] for g in broadcasts)
    final = ordered[4]
    assert (final[0]["op"], final[0]["targetId"], final[0]["targetName"]) == ("shutdown", w2id, "worker-c")
    assert [(r["outcome"] if r["phase"] == "completed" else None) for r in final] == [None, None, "deferred", "deferred"]
    print("PASS a paused refusal is recorded as refused/paused; pause carries only its reason length")
    print("PASS a broadcast compact records one pair per target with distinct request ids; shutdown is recorded before the session exits")
