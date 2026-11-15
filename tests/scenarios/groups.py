# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (c) 2026 PIIIX-org contributors
"""/peers groups and group:<name> targets through three real OMP processes; wakes observed at the sessions and at the loopback gateway."""
import json
import stat
import time

from scenarios.rules import injected
from smoke import wait_for

NO_ELIGIBLE = 'error: group "{}" has no eligible recipients right now'


def quiet(h, peer, start, requests):
    """Nothing woke `peer`: no agent/turn/message frames, no peer-message notice, no model request."""
    time.sleep(1.0)
    woke = [f for f in peer.frames[start:]
            if str(f.get("type", "")).startswith(("agent_", "turn_", "message_")) or "Message from" in json.dumps(f)]
    assert not woke, woke
    assert len(h.gateway.requests) == requests, h.gateway.requests[requests:]


def turn(peer, start):
    wait_for(lambda: any(f.get("type") == "agent_end" for f in peer.frames[start:]), seconds=30)


def run(h):
    master, a, b = h.start(), h.start(), h.start()
    mid, aid, bid = h.row(master)["id"], h.row(a)["id"], h.row(b)["id"]
    master_name = h.row(master)["name"]
    assert h.say(master, "/peers master")
    h.say(master, f"/peers do {aid} rename worker-a")
    h.say(master, f"/peers do {bid} rename worker-b")
    wait_for(lambda: h.row(a)["name"] == "worker-a" and h.row(b)["name"] == "worker-b")

    assert h.say(master, "/peers groups add frontend worker-a") == f"added worker-a ({aid}) to group frontend (1 member(s))"
    assert h.say(master, "/peers groups add frontend worker-b") == f"added worker-b ({bid}) to group frontend (2 member(s))"
    state = json.loads((h.state / "groups.json").read_text())
    assert state == {"version": 1, "groups": {"frontend": sorted([aid, bid])}}, state
    assert stat.S_IMODE((h.state / "groups.json").stat().st_mode) == 0o600 and stat.S_IMODE(h.state.stat().st_mode) == 0o700
    assert "worker" not in (h.state / "groups.json").read_text()
    print("PASS master adds two workers; groups.json is version 1, 0600, keyed by stable ids only")

    denied = ("error: only the master session may change the membership of other sessions; "
              "run /peers master first (a session may add or remove itself)")
    assert h.say(b, "/peers groups add frontend worker-a") == denied
    assert h.say(b, "/peers groups add side worker-b") == f"added worker-b ({bid}) to group side (1 member(s))"
    assert h.say(b, "/peers groups remove side worker-b") == f"removed worker-b ({bid}) from group side (0 member(s) left)"
    assert h.say(b, "/peers groups delete side") == "deleted group side (0 member(s)); rules scoped to it stay stored and apply to nobody"
    assert h.say(b, "/peers groups delete frontend") == denied
    print("PASS a worker may change only itself; changing another session or deleting a shared group needs the master")

    frames = {id(p): (len(p.frames), len(h.gateway.requests)) for p in (a, b)}
    assert h.say(master, "/peers groups list") == "frontend  2 member(s)"
    members = h.say(master, "/peers groups members frontend").splitlines()
    assert members[0] == "group frontend: 2 member(s)" and sorted(members[1:]) == sorted([f"  worker-a ({aid})", f"  worker-b ({bid})"]), members
    assert h.say(master, "/peers groups preview frontend") == (
        f"preview group:frontend (message), 2 member(s)\nwould receive: worker-a ({aid}), worker-b ({bid})")
    for peer in (a, b):
        quiet(h, peer, frames[id(peer)][0], frames[id(peer)][1])
    print("PASS list, members and preview reach no worker: no frames, no model request")

    assert h.say(master, f"/peers do {bid} pause") == f"worker-b ({bid}): ok (paused)"
    wait_for(lambda: h.row(b).get("paused") is True)
    expected_preview = (f"preview group:frontend (message), 2 member(s)\nwould receive: worker-a ({aid})\n"
                        "skipped: worker-b (paused)")
    assert h.say(master, "/peers groups preview frontend") == expected_preview

    a_start, b_start, requests = len(a.frames), len(b.frames), len(h.gateway.requests)
    sent = h.say(master, "/peers msg group:frontend hello frontend")
    assert sent == f"worker-a ({aid}): ok\nskipped: worker-b (paused)", sent
    turn(a, a_start)
    time.sleep(1.0)
    assert len(h.gateway.requests) == requests + 1, h.gateway.requests[requests:]
    assert json.dumps(h.gateway.requests[-1][1]).count("hello frontend") == 1
    quiet(h, b, b_start, requests + 1)  # the paused worker was not even contacted
    print("PASS a group message reaches only the live unpaused member; the paused skip is listed exactly and b received nothing")

    assert h.say(master, "/peers msg group:nope hi") == 'error: unknown group "nope"'
    h.say(master, "/peers groups add ghost worker-a")
    h.say(master, "/peers groups remove ghost worker-a")
    assert h.say(master, "/peers msg group:ghost hi") == 'error: group "ghost" is empty; add members with /peers groups add ghost <peer>'
    assert h.say(master, "/peers groups add frontend " + mid) == f"added {master_name} ({mid}) to group frontend (3 member(s))"
    a_start = len(a.frames)
    own = h.say(master, "/peers msg group:frontend again")
    skipped = sorted([f"skipped: {master_name} (this session)", "skipped: worker-b (paused)"])
    assert own == "\n".join([f"worker-a ({aid}): ok", *skipped]), own
    turn(a, a_start)
    assert h.say(master, f"/peers groups remove frontend {mid}").startswith("removed ")
    print("PASS unknown and empty groups are errors; the sender is never a recipient and is listed as skipped")

    a_start, requests = len(a.frames), len(h.gateway.requests)
    everyone = h.say(master, "/peers msg all unscoped")
    assert everyone == f"worker-a ({aid}): ok\nnot delivered: worker-b is paused; resend after its user resumes it ({bid})", everyone
    turn(a, a_start)
    print("PASS unscoped 'all' still addresses every session; the receiver gate answers for the paused one")

    assert h.say(a, "/peers lock") == "Control from master: refused"
    wait_for(lambda: h.row(a)["control"] is False)
    status = h.say(master, "/peers do group:frontend status").splitlines()
    assert [l.split("  ")[0] for l in status] == [f"worker-a ({aid}): {aid}", f"worker-b ({bid}): {bid}"], status
    prompt = h.say(master, "/peers do group:frontend prompt run the suite")
    assert prompt == "\n".join([NO_ELIGIBLE.format("frontend"), "skipped: worker-a (locked (control refused))", "skipped: worker-b (paused)"]), prompt
    assert h.say(master, "/peers groups preview frontend prompt") == "\n".join([
        "preview group:frontend (prompt), 2 member(s)", NO_ELIGIBLE.format("frontend"),
        "skipped: worker-a (locked (control refused))", "skipped: worker-b (paused)"])
    assert h.say(a, "/peers unlock") == "Control from master: allowed"
    wait_for(lambda: h.row(a)["control"] is True)
    print("PASS control actions skip locked and paused members and error when nothing is eligible; status still reaches a paused member")

    h.say(master, "/peers rules add group:backend always run lint")
    assert injected(h.ask(a, "Reply with the word ok.")) is None
    assert h.say(master, "/peers groups add backend worker-a") == f"added worker-a ({aid}) to group backend (1 member(s))"
    assert injected(h.ask(a, "Reply with the word ok.")) == ["- [r1 group:backend] always run lint"]
    assert "groups: backend, frontend" in h.say(master, "/peers rules explain worker-a")
    print("PASS a group-scoped rule starts applying to a session once it joins the group")

    assert h.say(b, "/peers resume").startswith(f"resumed worker-b ({bid})")
    wait_for(lambda: h.row(b)["paused"] is False)
    a_start, b_start = len(a.frames), len(b.frames)
    both = h.say(master, "/peers msg group:frontend after resume")
    assert both == f"worker-a ({aid}): ok\nworker-b ({bid}): ok", both
    turn(a, a_start)
    turn(b, b_start)
    print("PASS after resume both members receive the group message")
