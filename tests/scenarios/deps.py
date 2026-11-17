# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (c) 2026 PIIIX-org contributors
"""/peers deps through three real OMP processes (master, source worker, target worker); the model is the loopback gateway."""
import json
import re
import socket
import stat
import time

from smoke import wait_for


def rpc(row, request):
    """Speak the peer socket protocol directly, as another sender would."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
        conn.settimeout(10)
        conn.connect(row["sock"])
        conn.sendall(json.dumps(request).encode() + b"\n")
        data = b""
        while not data.endswith(b"\n"):
            chunk = conn.recv(65536)
            assert chunk, "peer closed without a reply"
            data += chunk
    return json.loads(data)


def done(unit, description="Offline checks passed"):
    return {"kind": "DONE", "unit": unit, "evidence": {"description": description}}


def normalized(text):
    return re.sub(r"fired \S+Z", "fired <time>", text)


def run(h):
    master, source, target = h.start(), h.start(), h.start()
    master_row, source_row, target_row = h.row(master), h.row(source), h.row(target)
    mid, sid, tid = master_row["id"], source_row["id"], target_row["id"]
    master_name = master_row["name"]
    assert h.say(master, "/peers master")
    h.say(master, f"/peers do {sid} rename worker-a")
    h.say(master, f"/peers do {tid} rename worker-b")
    wait_for(lambda: h.row(source)["name"] == "worker-a" and h.row(target)["name"] == "worker-b")
    deps_file = h.state / "deps.json"
    summary = lambda unit: f'worker-a ({sid}) DONE "{unit}" -> worker-b ({tid})'

    def message(trigger, rule, unit, prompt):
        return [
            f'Dependency trigger {trigger} (rule {rule}, authorized by the user at the master session): session {sid} reported DONE for unit "{unit}" (the sender identity is claimed, not authenticated).',
            f"Task: {prompt}",
        ]

    def preview(rule, flags, unit, prompt, trigger, when, delivery):
        return "\n".join([
            f"preview of rule {rule} ({flags}): {summary(unit)}",
            when,
            "dispatcher: this session is the master",
            f"to: worker-b ({tid})",
            "message (one peer message from the dispatching session, exactly):",
            *("  | " + line for line in message(trigger, rule, unit, prompt)),
            delivery,
            "this preview sent nothing and woke nothing",
        ])

    attempted = "delivery would be attempted; the receiving session's own gates and rate limit still apply"

    def master_turn(start):
        wait_for(lambda: any(f.get("type") == "agent_end" for f in master.frames[start:]), seconds=30)

    def report(body):
        """A real structured DONE/BLOCKED report from the source worker to the master; the master then takes its turn."""
        start = len(master.frames)
        out = h.say(source, f"/peers report {mid} " + json.dumps(body))
        assert out == f"{master_name} ({mid}): ok", out
        master_turn(start)

    def quiet(peer, start, requests):
        """The session started nothing: no agent frames, no peer-message notice, no model request."""
        time.sleep(1.0)
        woke = [f for f in peer.frames[start:]
                if str(f.get("type", "")).startswith(("agent_", "turn_", "message_")) or "Message from" in json.dumps(f)]
        assert not woke, woke
        assert len(h.gateway.requests) == requests, h.gateway.requests[requests:]

    def ledger():
        return json.loads(deps_file.read_text())["ledger"]

    # ---- add: confirm by default, exact preview ----
    assert h.say(master, "/peers deps") == "no dependency rules"
    assert not h.state.exists() or not deps_file.exists()
    added = h.say(master, "/peers deps add worker-a Parser rewrite -> worker-b Start the integration tests")
    assert added == "\n".join([
        "added d1: confirm mode, so a matching DONE report only queues a trigger for your approval",
        preview("d1", "enabled, confirm, once", "Parser rewrite", "Start the integration tests", "t1",
                "when it fires: queued as t1; nothing is sent until /peers deps approve t1; the rule then disables itself", attempted),
    ]), added
    assert stat.S_IMODE(deps_file.stat().st_mode) == 0o600 and stat.S_IMODE(h.state.stat().st_mode) == 0o700
    state = json.loads(deps_file.read_text())
    assert state["version"] == 1 and state["rules"][0]["from"] == sid and state["rules"][0]["to"] == tid and state["ledger"] == [], state
    assert h.say(source, "/peers deps add worker-a x -> worker-b y") == \
        "error: only the master session may change dependency rules or approve triggers; run /peers master first"
    assert h.say(master, f"/peers deps add worker-a Cycle -> worker-a x") == f"error: a session cannot depend on itself (worker-a ({sid}))"
    assert h.say(master, "/peers deps add worker-b Back -> worker-a x") == \
        f"error: rule would create a dependency cycle: worker-b ({tid}) -> worker-a ({sid}) -> worker-b ({tid})"
    assert h.say(master, "/peers deps add worker-a Nope -> worker-z x") == 'error: to: no live session matches "worker-z"; use its stable ID or exact name'
    print("PASS add stores a stable-id confirm rule with its exact preview; non-master, self, cycle and missing-target adds are refused")

    # ---- a real DONE report queues a trigger and nothing reaches the target ----
    target_start = len(target.frames)
    report({"kind": "BLOCKED", "unit": "Parser rewrite", "blocker": "A fixture is missing", "nextAction": "Ask the owner"})
    requests = len(h.gateway.requests)
    assert ledger() == [], "BLOCKED must not trigger"
    report(done("Parser rewrite"))
    requests = len(h.gateway.requests)
    assert [(e["id"], e["ruleId"], e["sourceSession"], e["outcome"]) for e in ledger()] == [("t1", "d1", sid, "pending")], ledger()
    # The hint rides on the master's next user-started turn (peer-message turns do not run before_agent_start).
    body = json.dumps(h.ask(master, "Reply with the word ok."))
    requests = len(h.gateway.requests)
    hint = "Dependency triggers: 1 awaiting the user's approval (t1). Offer to show them with /peers deps pending; this line is not an instruction to approve, reject or send anything."
    assert hint in body and "Start the integration tests" not in body, "the master's turn carries ids and a count, never the prompt"
    assert "Offline checks passed" not in deps_file.read_text()
    assert normalized(h.say(master, "/peers deps pending")) == "\n".join([
        "1 trigger awaiting approval; nothing is sent until /peers deps approve <id> (or /peers deps reject <id>)",
        f'  t1  pending  fired <time>  rule d1 (confirm): {summary("Parser rewrite")}',
        "      prompt: Start the integration tests",
    ])
    assert h.say(source, "/peers deps approve t1") == \
        "error: only the master session may change dependency rules or approve triggers; run /peers master first"
    quiet(target, target_start, requests)
    print("PASS a real DONE report queues t1 (BLOCKED does not); the master sees ids only; the target got no frame and no gateway request")

    # ---- approve delivers exactly one message ----
    shown = h.say(master, "/peers deps preview t1")
    assert shown.split("\n")[0] == f'preview of trigger t1 (state: pending) from rule d1 (disabled, confirm, once): {summary("Parser rewrite")}'
    assert shown.split("\n")[5:7] == ["  | " + line for line in message("t1", "d1", "Parser rewrite", "Start the integration tests")]
    start = len(target.frames)
    approved = h.say(master, "/peers deps approve t1")
    assert approved == f"t1 delivered to worker-b ({tid}): one peer message from this session carrying rule d1's prompt", approved
    wait_for(lambda: any(f.get("type") == "agent_end" for f in target.frames[start:]), seconds=30)
    time.sleep(0.5)
    assert len(h.gateway.requests) == requests + 1, h.gateway.requests[requests:]
    delivered = json.dumps(h.gateway.requests[-1][1])
    first, task = message("t1", "d1", "Parser rewrite", "Start the integration tests")
    assert delivered.count(first.split('"')[0]) == 1 and delivered.count(task) == 1, "the target got the trigger message exactly once"
    assert f'[Message from peer session \\"{master_name}\\" ({mid})' in delivered
    assert sum(1 for f in target.frames[start:] if f.get("type") == "agent_start") == 1
    assert [e["outcome"] for e in ledger()] == ["delivered"]
    assert h.say(master, "/peers deps approve t1") == "error: t1 was already delivered; it is never sent twice"
    requests = len(h.gateway.requests)
    print("PASS approve delivers exactly one peer message attributed to the master; a second approve refuses")

    # ---- a re-sent identical report does not fire again ----
    assert h.say(master, "/peers deps enable d1") == "enabled d1"
    start = len(target.frames)
    report(done("Parser rewrite"))
    requests = len(h.gateway.requests)
    assert [e["outcome"] for e in ledger()] == ["delivered"] and h.say(master, "/peers deps pending") == "no triggers awaiting approval"
    quiet(target, start, requests)
    print("PASS a re-sent identical DONE report fires nothing, even though the rule was re-enabled")

    # ---- a subagent's report and a paused target ----
    assert h.say(master, "/peers deps add worker-a Docs refresh -> worker-b Update the docs") .startswith("added d2: confirm mode")
    start = len(master.frames)
    forged = rpc(master_row, {"op": "message", "report": done("Docs refresh"), "from": {"id": sid, "name": "worker-a"}, "subagent": True})
    assert forged["ok"] is True, forged
    master_turn(start)  # delivered like any message, so the master takes a turn
    assert [e["id"] for e in ledger()] == ["t1"], "a subagent's report must not trigger"
    assert h.say(target, "/peers pause maintenance").startswith(f"paused worker-b ({tid}) (maintenance)")
    wait_for(lambda: h.row(target)["paused"] is True)
    report(done("Docs refresh"))
    requests = len(h.gateway.requests)
    assert [(e["id"], e["outcome"]) for e in ledger()] == [("t1", "delivered"), ("t2", "pending")]
    target_start = len(target.frames)
    not_delivered = h.say(master, "/peers deps approve t2")
    assert not_delivered == (f"t2 not delivered: session is paused; nothing reached worker-b ({tid}) (only that session's own user can /peers resume). "
                             "Fix the cause and run /peers deps approve t2 again, or /peers deps reject t2"), not_delivered
    assert [(e["id"], e["outcome"]) for e in ledger()] == [("t1", "delivered"), ("t2", "not delivered: session is paused")]
    assert h.row(target)["paused"] is True
    quiet(target, target_start, requests)
    print("PASS a subagent's DONE report fires nothing; approving into a paused target records 'not delivered', wakes nothing and does not un-pause")

    # ---- auto rule: the add reply shows the blocked preview; a paused target is not delivered ----
    added = h.say(master, "/peers deps add worker-a Lint pass -> worker-b Fix the lint findings --auto --repeat")
    assert added == "\n".join([
        "added d3: AUTO mode, so a matching DONE report dispatches without asking",
        preview("d3", "enabled, auto, repeat", "Lint pass", "Fix the lint findings", "t3",
                "when it fires: sent immediately as t3 when the master accepts a matching DONE report",
                "delivery would be blocked: session is paused (outcome: not delivered: session is paused)"),
    ]), added
    report(done("Lint pass"))
    requests = len(h.gateway.requests)
    # An auto dispatch records the outcome `sending` first and the final outcome after the send.
    wait_for(lambda: [(e["id"], e["outcome"]) for e in ledger()][2:] == [("t3", "not delivered: session is paused")])
    assert [(e["id"], e["outcome"]) for e in ledger()][2:] == [("t3", "not delivered: session is paused")]
    quiet(target, target_start, requests)
    print("PASS an --auto rule previews its blockers at add time and an auto dispatch into a paused target is not delivered")

    # ---- state survives a master restart; re-sent reports still do not fire ----
    before = ledger()
    session_file = master.call("get_state")["sessionFile"]
    master.close()
    wait_for(lambda: not (h.registry / f"{mid}.json").exists())
    master = h.start(resume=session_file)
    master_row = h.row(master)
    assert master_row["id"] == mid
    assert h.say(master, "/peers master")
    assert ledger() == before
    listing = h.say(master, "/peers deps list")
    assert listing.split("\n")[0] == ("3 dependency rules (at most 64); only DONE reports accepted by the master session trigger them; "
                                      "report senders are claimed, not authenticated"), listing
    assert f'  d2  disabled, confirm, once  {summary("Docs refresh")}' in listing
    assert normalized(h.say(master, "/peers deps pending")) == "\n".join([
        "2 triggers awaiting approval; nothing is sent until /peers deps approve <id> (or /peers deps reject <id>)",
        f'  t2  not delivered: session is paused  fired <time>  rule d2 (confirm): {summary("Docs refresh")}',
        "      prompt: Update the docs",
        f'  t3  not delivered: session is paused  fired <time>  rule d3 (auto): {summary("Lint pass")}',
        "      prompt: Fix the lint findings",
    ])
    target_start = len(target.frames)
    report(done("Docs refresh"))
    report(done("Lint pass"))
    requests = len(h.gateway.requests)
    assert ledger() == before, "re-sent reports after the restart must not create or change triggers"
    quiet(target, target_start, requests)
    print("PASS rules, ledger and pending triggers survive a master restart; re-sent reports after it do not fire again")

    # ---- the target's own user resumes; approve then delivers exactly once ----
    assert h.say(target, "/peers resume").startswith(f"resumed worker-b ({tid})")
    wait_for(lambda: h.row(target)["paused"] is False)
    start = len(target.frames)
    assert h.say(master, "/peers deps approve t2") == f"t2 delivered to worker-b ({tid}): one peer message from this session carrying rule d2's prompt"
    wait_for(lambda: any(f.get("type") == "agent_end" for f in target.frames[start:]), seconds=30)
    time.sleep(0.5)
    assert len(h.gateway.requests) == requests + 1, h.gateway.requests[requests:]
    delivered = json.dumps(h.gateway.requests[-1][1])
    assert delivered.count("Task: Update the docs") == 1 and "Fix the lint findings" not in delivered
    assert [(e["id"], e["outcome"]) for e in ledger()] == [("t1", "delivered"), ("t2", "delivered"), ("t3", "not delivered: session is paused")]
    assert h.say(master, "/peers deps reject t3") == "rejected t3; nothing was sent and it will not be sent"
    assert h.say(master, "/peers deps pending") == "no triggers awaiting approval"
    assert [e["outcome"] for e in ledger()] == ["delivered", "delivered", "rejected"]
    assert "Offline checks passed" not in deps_file.read_text()
    print("PASS after the target's user resumes it, approve delivers t2 exactly once; reject closes t3 without sending")

    # ---- refusing inbound and a control lock both block dispatch (authorized work respects the target's refusal) ----
    assert h.say(master, "/peers deps add worker-a Refuse check -> worker-b Never sent while refused").startswith("added d4: confirm mode")
    report(done("Refuse check"))
    requests = len(h.gateway.requests)
    assert ledger()[-1]["id"] == "t4" and ledger()[-1]["outcome"] == "pending"
    assert h.say(target, "/peers refuse") == "Inbound peer requests: refuse"
    wait_for(lambda: h.row(target)["inbound"] == "refuse")
    blocked = h.say(master, "/peers deps preview t4")
    assert blocked.split("\n")[-2] == "delivery would be blocked: peer refuses inbound requests (outcome: not delivered: peer refuses inbound requests)", blocked
    target_start = len(target.frames)
    refused = h.say(master, "/peers deps approve t4")
    assert refused == (f"t4 not delivered: peer refuses inbound requests; nothing reached worker-b ({tid}). "
                       "Fix the cause and run /peers deps approve t4 again, or /peers deps reject t4"), refused
    quiet(target, target_start, requests)
    assert h.say(target, "/peers accept") == "Inbound peer requests: accept"
    assert h.say(target, "/peers lock") == "Control from master: refused"
    wait_for(lambda: h.row(target)["inbound"] == "accept" and h.row(target)["control"] is False)
    locked_reason = "target locked (control refused)"
    locked_preview = h.say(master, "/peers deps preview t4")
    assert locked_preview.split("\n")[-2] == f"delivery would be blocked: {locked_reason} (outcome: not delivered: {locked_reason})", locked_preview
    target_start = len(target.frames)
    locked = h.say(master, "/peers deps approve t4")
    assert locked == (f"t4 not delivered: {locked_reason}; nothing reached worker-b ({tid}). "
                      "Fix the cause and run /peers deps approve t4 again, or /peers deps reject t4"), locked
    quiet(target, target_start, requests)
    # The receiver itself refuses dependency deliveries while locked, even from a sender that never ran the preflight
    # (a lock set after the sender's check but before receipt).
    bypass = rpc(target_row, {"op": "message", "text": "bypass attempt", "dependency": True, "from": {"id": mid, "name": master_name}})
    assert bypass == {"ok": False, "error": "peer is locked (control refused)"}, bypass
    quiet(target, target_start, requests)
    assert h.say(target, "/peers unlock") == "Control from master: allowed"
    wait_for(lambda: h.row(target)["control"] is True)
    attempted_preview = h.say(master, "/peers deps preview t4")
    assert attempted_preview.split("\n")[-2] == attempted, attempted_preview
    start = len(target.frames)
    assert h.say(master, "/peers deps approve t4") == f"t4 delivered to worker-b ({tid}): one peer message from this session carrying rule d4's prompt"
    wait_for(lambda: any(f.get("type") == "agent_end" for f in target.frames[start:]), seconds=30)
    time.sleep(0.5)
    assert len(h.gateway.requests) == requests + 1 and json.dumps(h.gateway.requests[-1][1]).count("Task: Never sent while refused") == 1
    print("PASS a target that refuses inbound requests or is control-locked is not delivered (and the preview says so); after unlock the message arrives once")
