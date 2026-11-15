# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (c) 2026 PIIIX-org contributors
"""/peers rules through two real OMP processes; injected context observed at the loopback gateway."""
import json
import stat

from smoke import wait_for

HEADER = "Standing rules for this session"


def texts(body):
    """Every message the provider received, as one string per message."""
    out = []
    for message in body["messages"]:
        content = message["content"]
        if isinstance(content, list):
            content = "".join(part.get("text", "") for part in content)
        out.append(content or "")
    return out


def injected(body):
    """Rule lines the provider received, or None when the request carries none.

    Injection is appended to the system prompt for that one request, so it must appear exactly once
    there and never in conversation history (a removed rule cannot linger in earlier turns).
    """
    blocks = [(m["role"], t) for m, t in zip(body["messages"], texts(body)) if HEADER in t]
    assert all(role == "system" for role, _ in blocks) and len(blocks) <= 1, blocks
    return [l for l in blocks[0][1].splitlines() if l.startswith("- [r")] if blocks else None


def run(h):
    master, worker = h.start(), h.start()
    master_row, worker_row = h.row(master), h.row(worker)
    assert h.say(master, "/peers master")
    h.say(master, f"/peers do {worker_row['id']} rename worker-b")
    wait_for(lambda: h.row(worker)["name"] == "worker-b")

    r1 = h.say(master, "/peers rules add global --key tests run the suite with option alpha")
    assert r1.startswith("added r1 (global)"), r1
    r2 = h.say(master, "/peers rules add session:worker-b --key tests run the suite with option beta")
    assert r2.startswith("added r2 (session:" + worker_row["id"] + ")") and "conflict: r1 (global)" in r2, r2
    assert h.say(master, "/peers rules add global be concise").startswith("added r3")
    print("PASS add returns stable ids; session name resolved to the stable peer id; conflict reported")

    assert "master" in h.say(worker, "/peers rules add global sneaky change")
    assert "duplicate: r3" in h.say(master, "/peers rules add global be concise")
    value = "abcd1234" + "efgh5678"  # joined at runtime: no credential-shaped text in the repository
    secret = h.say(master, "/peers rules add global use api_" + "key=" + value + " always")
    assert secret.startswith("error:") and "credential" in secret and value not in secret, secret
    print("PASS non-master change, duplicate and credential-looking text rejected")

    rules_file = h.state / "rules.json"
    assert stat.S_IMODE(h.state.stat().st_mode) == 0o700, oct(h.state.stat().st_mode)
    assert stat.S_IMODE(rules_file.stat().st_mode) == 0o600, oct(rules_file.stat().st_mode)
    raw = rules_file.read_text()
    state = json.loads(raw)
    assert state["version"] == 1 and [r["id"] for r in state["rules"]] == ["r1", "r2", "r3"], state
    assert state["rules"][1]["scope"] == "session:" + worker_row["id"], state
    assert "sneaky" not in raw and "abcd1234" not in raw and "worker-b" not in raw, raw
    print("PASS rules.json is version 1, 0600 in a 0700 directory, with only accepted rules")

    explain = h.say(master, "/peers rules explain worker-b")
    for expected in ("precedence: session > group", "1. r2  session:" + worker_row["id"] + " (worker-b)  [key=tests]  run the suite with option beta",
                     "2. r3  global  be concise", "overridden: r1  global  [key=tests]  run the suite with option alpha  -- conflicts with r2",
                     "injection: 2 of 2 rule(s)"):
        assert expected in explain, (expected, explain)
    assert "r1  global" in h.say(master, "/peers rules list") and "CONFLICT with r2" in h.say(master, "/peers rules list")
    print("PASS explain shows precedence, the winning rule and the overridden loser")

    # Real model turns end at the loopback gateway; injection is the only way these lines reach it.
    sent = h.ask(worker, "Reply with the word ok.")
    assert injected(sent) == ["- [r2 session] run the suite with option beta", "- [r3 global] be concise"], injected(sent)
    assert sum(t.endswith("Reply with the word ok.") for t in texts(sent)) == 1, texts(sent)
    assert "alpha" not in json.dumps(sent) and "sneaky" not in json.dumps(sent)
    assert injected(h.ask(master, "Reply with the word ok.")) == [
        "- [r1 global] run the suite with option alpha", "- [r3 global] be concise"]
    print("PASS worker and master receive exactly their effective rules; the user prompt is unchanged")

    assert h.say(master, "/peers rules remove r2").startswith("removed r2")
    assert injected(h.ask(worker, "Reply with the word ok.")) == [
        "- [r1 global] run the suite with option alpha", "- [r3 global] be concise"]
    h.say(master, "/peers rules remove r1")
    h.say(master, "/peers rules remove r3")
    assert injected(h.ask(worker, "Reply with the word ok.")) is None
    assert "injection: none" in h.say(master, "/peers rules explain worker-b")
    print("PASS removed rules are absent from the next agent start; no rules injects nothing")

    assert h.say(master, "/peers rules add global survive restart").startswith("added r4")
    session_file = worker.call("get_state")["sessionFile"]
    worker.close()
    worker = h.start(resume=session_file)
    assert h.row(worker)["id"] == worker_row["id"]
    assert injected(h.ask(worker, "Reply with the word ok.")) == ["- [r4 global] survive restart"]
    print("PASS rules persist on disk and apply to the resumed session")

    # A locked session must not receive rules authored by others; its own rules still apply.
    assert h.say(worker, "/peers lock") == "Control from master: refused"
    assert injected(h.ask(worker, "Reply with the word ok.")) is None
    locked_view = h.say(worker, f"/peers rules explain {worker_row['id']}")
    assert "only rules this session added itself are injected" in locked_view and "injection: none" in locked_view, locked_view
    assert h.say(worker, f"/peers rules add session:{worker_row['id']} own rule").startswith("added r5")
    assert injected(h.ask(worker, "Reply with the word ok.")) == ["- [r5 session] own rule"]
    assert "injection: 1 of 1 rule(s)" in h.say(master, f"/peers rules explain {worker_row['id']}")
    assert h.say(worker, "/peers unlock") == "Control from master: allowed"
    assert injected(h.ask(worker, "Reply with the word ok.")) == ["- [r5 session] own rule", "- [r4 global] survive restart"]
    print("PASS a locked session is injected only its own rules, and explain agrees")
