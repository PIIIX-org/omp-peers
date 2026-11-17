# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (c) 2026 PIIIX-org contributors
"""/peers templates through real OMP processes; model, rules and groups observed on disk, in get_state and at the loopback gateway."""
import json
import stat

from scenarios.rules import injected
from smoke import wait_for

NOT_AVAILABLE = "not among the available models (unknown, unauthenticated or invalid selector)"
TAIL = ("Only this session changed; other sessions, existing rules and groups were kept. "
        "Rules are injected from this session's next agent start.")
ASK = "Reply with the word ok."


def run(h):
    models = h.agent / "models.yml"
    both = models.read_text() + "      - id: second\n"
    first_only = models.read_text()
    models.write_text(both)

    def files():
        """Everything a template command could touch besides the model."""
        return {name: (h.state / name).read_text() if (h.state / name).exists() else None
                for name in ("templates.json", "rules.json", "groups.json")}

    def model(peer):
        return peer.call("get_state")["model"]["id"]

    def notice(peer, needle):
        """The session-start notification containing `needle`."""
        return wait_for(lambda: next((f["message"] for f in peer.frames
                                      if f.get("method") == "notify" and needle in f.get("message", "")), None))

    worker, other = h.start(), h.start()
    wid, oid = h.row(worker)["id"], h.row(other)["id"]
    assert model(worker) == "first"
    requests = len(h.gateway.requests)

    add = "/peers templates add web --model smoke/second --prompt Review carefully. --rule Prefer small diffs --group frontend"
    assert h.say(worker, add) == "added template web; review it with /peers templates show web"
    assert h.say(worker, "/peers templates add web --rule again") == "error: template web already exists; remove it first"
    assert h.say(worker, "/peers templates add nomodel --model smoke/missing") == (
        f"error: model smoke/missing: {NOT_AVAILABLE}; template not saved")
    assert h.say(worker, "/peers templates list") == "web  model=smoke/second  role=yes  rules=1  groups=1"
    stored = json.loads((h.state / "templates.json").read_text())
    assert stored == {"version": 1, "templates": {"web": {
        "model": "smoke/second", "prompt": "Review carefully.", "rules": ["Prefer small diffs"], "groups": ["frontend"]}}}, stored
    assert stat.S_IMODE((h.state / "templates.json").stat().st_mode) == 0o600
    print("PASS add validates the model and stores a private, versioned template; duplicates and unavailable models are refused")

    show = h.say(worker, "/peers templates show web")
    assert show == "\n".join([
        "template web",
        "  model: smoke/second -> smoke/second (available, credentials found)",
        "  role: Review carefully.  (session rule, key role)",
        "  rule 1: Prefer small diffs  (session rule)",
        "  groups: frontend",
        f"for this session ({wid}) apply would:",
        "  model smoke/second: switch smoke/first -> smoke/second",
        '  role "Review carefully.": add as a session rule (key role)',
        '  rule 1 "Prefer small diffs": add as a session rule',
        "  group frontend: create and join",
        "result: not applied yet (nothing has been changed); run /peers templates apply web --yes to apply these steps",
    ]), show
    before = files()
    launch = h.say(worker, "/peers templates launch web")
    assert "nothing was started or changed" in launch and "\n  OMP_PEERS_TEMPLATE=web OMP_PEERS_TEMPLATE_CONFIRM=yes omp\n" in launch, launch
    assert h.say(worker, "/peers templates apply web") == show
    assert files() == before and model(worker) == "first" and len(h.gateway.requests) == requests
    assert len(list(h.registry.glob("p*.json"))) == 2, "launch must not start a session"
    print("PASS show prints the exact resolved plan; launch prints the shell line; apply without --yes changes nothing")

    applied = h.say(worker, "/peers templates apply web --yes")
    assert applied == "\n".join([
        f"applied template web to this session ({wid})",
        "  model smoke/second: switched smoke/first -> smoke/second",
        '  role "Review carefully.": added r1',
        '  rule 1 "Prefer small diffs": added r2',
        "  group frontend: created and joined",
        TAIL,
    ]), applied
    assert model(worker) == "second"
    rules = json.loads((h.state / "rules.json").read_text())["rules"]
    assert [(r["id"], r["scope"], r.get("key"), r["text"], r["addedBy"]) for r in rules] == [
        ("r1", f"session:{wid}", "role", "Review carefully.", wid), ("r2", f"session:{wid}", None, "Prefer small diffs", wid)], rules
    assert json.loads((h.state / "groups.json").read_text()) == {"version": 1, "groups": {"frontend": [wid]}}
    assert "[key=role]  Review carefully." in h.say(worker, "/peers rules list")
    sent = h.ask(worker, ASK)
    assert sent["model"] == "second", sent["model"]
    assert injected(sent) == ["- [r1 session] Review carefully.", "- [r2 session] Prefer small diffs"], injected(sent)
    assert model(other) == "first" and injected(h.ask(other, ASK)) is None
    assert json.loads((h.state / "groups.json").read_text())["groups"] == {"frontend": [wid]}
    print("PASS apply --yes switches the model, adds the role and rule as session rules, joins the group; the gateway sees them; the other session is untouched")

    applied_state = files()
    again = h.say(worker, "/peers templates apply web --yes")
    assert again == "\n".join([
        f"template web is already applied to this session ({wid}); nothing changed",
        "  model smoke/second: kept smoke/second (already current)",
        '  role "Review carefully.": already present (r1)',
        '  rule 1 "Prefer small diffs": already present (r2)',
        "  group frontend: already a member",
    ]), again
    assert files() == applied_state
    print("PASS re-applying reports what is already present and changes nothing")

    # A session started with only OMP_PEERS_TEMPLATE shows the plan and applies nothing.
    unconfirmed = h.start(env={"OMP_PEERS_TEMPLATE": "web"})
    uid = h.row(unconfirmed)["id"]
    text = notice(unconfirmed, "template web")
    expected = h.say(unconfirmed, "/peers templates show web").split("\n")[:-1]
    assert text == "\n".join([*expected, "template web not applied: set OMP_PEERS_TEMPLATE_CONFIRM=yes or run /peers templates apply web --yes"]), text
    assert "  group frontend: join" in text and f"({uid})" in text
    assert files() == applied_state and model(unconfirmed) == "first"
    assert injected(h.ask(unconfirmed, ASK)) is None
    print("PASS OMP_PEERS_TEMPLATE alone only shows the plan: no rules, groups or model change")

    confirmed = h.start(env={"OMP_PEERS_TEMPLATE": "web", "OMP_PEERS_TEMPLATE_CONFIRM": "yes"})
    cid = h.row(confirmed)["id"]
    text = notice(confirmed, "applied template web")
    assert text == "\n".join([
        f"applied template web to this session ({cid})",
        "  model smoke/second: switched smoke/first -> smoke/second",
        '  role "Review carefully.": added r3',
        '  rule 1 "Prefer small diffs": added r4',
        "  group frontend: joined",
        TAIL,
    ]), text
    assert model(confirmed) == "second"
    assert injected(h.ask(confirmed, ASK)) == ["- [r3 session] Review carefully.", "- [r4 session] Prefer small diffs"]
    assert json.loads((h.state / "groups.json").read_text())["groups"] == {"frontend": sorted([wid, cid])}
    print("PASS OMP_PEERS_TEMPLATE with OMP_PEERS_TEMPLATE_CONFIRM=yes applies to the brand new session only")

    # A session that already has messages is never changed by the environment.
    used = h.start()
    h.ask(used, ASK)
    session_file = used.call("get_state")["sessionFile"]
    used.close()
    snapshot = files()
    resumed = h.start(resume=session_file, env={"OMP_PEERS_TEMPLATE": "web", "OMP_PEERS_TEMPLATE_CONFIRM": "yes"})
    text = notice(resumed, "template web not applied")
    assert text == ("template web not applied: this session is not new (it has messages or saved peer-session data); "
                    "run /peers templates apply web --yes to apply it on purpose"), text
    assert files() == snapshot and model(resumed) == "first"
    print("PASS a resumed session with messages is not changed by the environment")

    # The model disappears from the available set: nothing is applied, nothing substituted.
    models.write_text(first_only)
    bare = h.start()
    snapshot = files()
    requests = len(h.gateway.requests)
    show = h.say(bare, "/peers templates show web")
    assert f"  model: smoke/second (unavailable: {NOT_AVAILABLE})" in show and f"  model smoke/second: refused: {NOT_AVAILABLE}" in show, show
    assert show.endswith("result: cannot apply: 1 step(s) refused above; nothing would be applied")
    refused = h.say(bare, "/peers templates apply web --yes")
    assert refused.endswith("error: template web not applied: 1 step(s) refused above; nothing was changed"), refused
    assert "added r" not in refused and "joined" not in refused
    assert files() == snapshot and model(bare) == "first" and len(h.gateway.requests) == requests
    assert injected(h.ask(bare, ASK)) is None
    envbare = h.start(env={"OMP_PEERS_TEMPLATE": "web", "OMP_PEERS_TEMPLATE_CONFIRM": "yes"})
    text = notice(envbare, "template web not applied")
    assert text.endswith("template web not applied: 1 step(s) refused above; nothing was changed"), text
    assert files() == snapshot and model(envbare) == "first"
    assert "unavailable" in h.say(bare, "/peers templates launch web")
    print("PASS an unavailable model applies nothing, from the command and from the environment")

    assert h.say(bare, "/peers templates remove web") == "removed template web; sessions it was applied to keep their rules, groups and model"
    assert h.say(bare, "/peers templates list") == "no templates"
    assert json.loads((h.state / "rules.json").read_text()) == json.loads(snapshot["rules.json"])
    print("PASS removing a template leaves the sessions it was applied to as they are")
