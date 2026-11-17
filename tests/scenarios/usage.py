# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (c) 2026 PIIIX-org contributors
"""/peers usage through real OMP processes: opt-in publishing of the host's numeric counters, read by the master."""
import json
import re
import socket
import stat

from smoke import wait_for

BILLED = "billed: unknown (host aggregates do not separate billed amounts from estimates)"
# One loopback turn: 1000 prompt tokens of which 400 are cached, 200 completion tokens.
GATEWAY_USAGE = {"prompt_tokens": 1000, "completion_tokens": 200, "total_tokens": 1200, "prompt_tokens_details": {"cached_tokens": 400}}
TOKENS = "input 600 output 200 cacheRead 400 cacheWrite 0"


def normalize(text):
    """Blank the two time-dependent values of a listing; everything else is compared exactly."""
    text = re.sub(r"read \d{4}-\d\d-\d\dT[\d:.]+Z\)", "read <time>)", text)
    return re.sub(r"since \d{4}-\d\d-\d\dT[\d:.]+Z", "since <time>", text)


def published(h, peer):
    return wait_for(lambda: h.row(peer).get("usage"))

def rpc(row, request):
    """Speak the peer socket protocol directly, as any other session or tool could."""
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



def run(h):
    port = h.gateway.server_port
    (h.agent / "models.yml").write_text(
        f"providers:\n  smoke:\n    baseUrl: http://127.0.0.1:{port}/v1\n    api: openai-completions\n    auth: none\n"
        "    models:\n      - id: first\n        cost:\n          input: 3\n          output: 15\n"
        "          cacheRead: 0.3\n          cacheWrite: 3.75\n"
    )
    h.gateway.usage = GATEWAY_USAGE
    master, worker, quiet = h.start(), h.start(), h.start()
    mid, wid, qid = h.row(master)["id"], h.row(worker)["id"], h.row(quiet)["id"]
    mname = h.row(master)["name"]  # the working-directory name; rows are sorted by name
    assert mname < "worker-quiet", mname
    assert h.say(master, "/peers master")
    h.say(master, f"/peers do {wid} rename worker-usage")
    h.say(master, f"/peers do {qid} rename worker-quiet")
    wait_for(lambda: h.row(worker)["name"] == "worker-usage" and h.row(quiet)["name"] == "worker-quiet")

    # Private by default: a session that ran a real turn still publishes nothing, and the master lists it as unknown.
    h.ask(quiet, "Reply with the word ok.")
    assert "usage" not in h.row(quiet)
    nothing = h.say(master, "/peers usage list")
    assert normalize(nothing) == "\n".join([
        "usage (all sessions; basis host-session-totals: cumulative per session file; pricing catalog; currency USD; read <time>)",
        "nothing is published: no listed session has run /peers usage on (usage is private by default)",
        f"{mid}  {mname}  unknown (nothing published)",
        f"{qid}  worker-quiet  unknown (nothing published)",
        f"{wid}  worker-usage  unknown (nothing published)",
        "total of 0 of 3 session(s); 3 unknown",
        "estimate: unknown (no session has a computable estimate)",
        BILLED,
    ]), nothing
    assert not (h.state / "usage.json").exists()
    print("PASS by default nothing is published: a session that ran a turn is unknown, and listing created no state")

    # The worker's own status shows its live host counters locally without publishing them.
    status = h.say(worker, "/peers usage status")
    assert status.splitlines()[:2] == [
        f"usage: this session (worker-usage, {wid}) publishes nothing (private; /peers usage on publishes its counters)",
        "host counters now (not shared unless publishing): input 0 output 0 cacheRead 0 cacheWrite 0; catalog cost 0.0000 USD",
    ], status
    on = h.say(worker, "/peers usage on")
    assert on == f"worker-usage ({wid}) now publishes its token counters (numbers only, no text) to the registry; /peers usage off stops it", on
    zero = published(h, worker)
    assert zero["input"] == 0 and zero["output"] == 0 and zero["basis"] == "host-session-totals", zero

    requests = len(h.gateway.requests)
    h.ask(worker, "Reply with the word ok.")
    usage = wait_for(lambda: h.row(worker)["usage"] if h.row(worker)["usage"].get("input") == 600 else None)
    assert {k: usage[k] for k in ("input", "output", "cacheRead", "cacheWrite", "model", "subscription", "basis")} == {
        "input": 600, "output": 200, "cacheRead": 400, "cacheWrite": 0, "model": "smoke/first", "subscription": False,
        "basis": "host-session-totals"}, usage
    assert abs(usage["catalogCost"] - 0.00492) < 1e-9, usage
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT[\d:.]+Z", usage["since"]), usage
    assert set(usage) == {"input", "output", "cacheRead", "cacheWrite", "catalogCost", "model", "subscription", "basis", "since"}, usage
    assert "Reply with the word ok" not in json.dumps(h.row(worker)), "the registry row carries no message text"
    assert "usage" not in h.row(quiet) and "usage" not in h.row(master)
    state = json.loads((h.state / "usage.json").read_text())
    assert state["publishers"] == [wid] and "worker" not in json.dumps(state), state
    assert stat.S_IMODE((h.state / "usage.json").stat().st_mode) == 0o600 and stat.S_IMODE(h.state.stat().st_mode) == 0o700
    print("PASS /peers usage on publishes exactly the host's numeric counters for this session only")

    # The master reads them without waking anyone or asking a provider.
    requests = len(h.gateway.requests)
    listing = h.say(master, "/peers usage list")
    assert normalize(listing) == "\n".join([
        "usage (all sessions; basis host-session-totals: cumulative per session file; pricing catalog; currency USD; read <time>)",
        f"{mid}  {mname}  unknown (nothing published)",
        f"{qid}  worker-quiet  unknown (nothing published)",
        f"{wid}  worker-usage  tokens: {TOKENS}  subscription: no  estimate: 0.0049 USD (catalog)  billed: unknown  model: smoke/first  since <time>",
        "total of 1 of 3 session(s); 2 unknown",
        f"tokens: {TOKENS} (covered sessions only)",
        "estimate: 0.0049 USD (catalog) over 1 of 3 session(s)",
        BILLED,
    ]), listing
    one = h.say(master, f"/peers usage list {wid}")
    assert f"(session {wid};" in one and "total of 1 of 1 session(s); 0 unknown" in one and qid not in one, one
    own = h.say(worker, "/peers usage list")
    assert f"{wid}  worker-usage" in own and mid not in own and qid not in own and "this session only; other sessions are listed by the master" in own, own
    denied = h.say(worker, f"/peers usage list {qid}")
    assert denied.startswith("error: only the master session lists other sessions' usage"), denied
    live = h.say(worker, "/peers usage status")
    assert f"host counters now (not shared unless publishing): {TOKENS}; catalog cost 0.0049 USD" in live, live
    assert len(h.gateway.requests) == requests, "listing and status made no provider request"
    print("PASS the master list shows exact figures with the estimate label; the quiet session stays unknown; non-masters see only themselves")

    # A restart resumes the same session file: the host's cumulative totals are published again under the same id, not added.
    session_file = worker.call("get_state")["sessionFile"]
    worker.close()
    worker = h.start(resume=session_file)
    assert h.row(worker)["id"] == wid
    again = wait_for(lambda: h.row(worker)["usage"] if h.row(worker).get("usage", {}).get("input") == 600 else None)
    assert again["output"] == 200 and again["cacheRead"] == 400, again
    relisted = h.say(master, "/peers usage list")
    assert "total of 1 of 3 session(s); 2 unknown" in relisted and f"tokens: {TOKENS} (covered sessions only)" in relisted, relisted
    assert "estimate: 0.0049 USD (catalog) over 1 of 3 session(s)" in relisted, relisted
    print("PASS a restart of the same session republishes the same cumulative totals; nothing is double counted")

    # Custom pricing is applied by the reader; a rate without cache prices leaves the estimate unknown rather than zero.
    assert h.say(master, "/peers usage set pricing custom") == "pricing custom"
    assert h.say(master, "/peers usage price smoke/first 3 15") == "added custom price for smoke/first (USD per million tokens)"
    partial = h.say(master, "/peers usage list")
    assert "estimate: unknown (custom price for smoke/first has no cacheRead rate)" in partial, partial
    assert "estimate: unknown (no session has a computable estimate)" in partial, partial
    assert h.say(master, "/peers usage price smoke/first 3 15 0.3 3.75") == "replaced custom price for smoke/first (USD per million tokens)"
    custom = h.say(master, "/peers usage list")
    assert "estimate: 0.0049 USD (custom)  billed: unknown" in custom and "pricing custom;" in custom, custom
    assert h.say(master, "/peers usage set currency EUR 2") == "currency EUR at 2 per USD"
    assert "estimate: 0.0098 EUR (custom)" in h.say(master, "/peers usage list")
    assert h.say(master, "/peers usage set currency USD") == "currency USD"
    assert h.say(master, "/peers usage set pricing catalog") == "pricing catalog"
    print("PASS custom pricing, an incomplete price and a currency rate give exact estimates or an explicit unknown")

    # Off removes the figures from the registry; the master then sees nothing published again.
    off = h.say(worker, "/peers usage off")
    assert off == f"worker-usage ({wid}) no longer publishes usage; its registry row carries no figures", off
    wait_for(lambda: "usage" not in h.row(worker))
    after = h.say(master, "/peers usage list")
    assert "nothing is published: no listed session has run /peers usage on" in after, after
    assert f"{wid}  worker-usage  unknown (nothing published)" in after, after
    assert json.loads((h.state / "usage.json").read_text())["publishers"] == []
    assert len(h.gateway.requests) == requests, "no provider request was made after the one turn"
    print("PASS /peers usage off removes the figures from the registry row and the master lists the session as unknown again")

    # Nothing remote can enable publishing: an unknown op is refused, and a remote prompt (a real op that does reach the model) carrying
    # the command text is only text, never run as a command.
    state_bytes = (h.state / "usage.json").read_bytes()
    row = h.row(worker)
    assert rpc(row, {"op": "usage", "text": "on", "from": {"id": "completion-watcher", "name": "Completion watcher"}}) == {"ok": False, "error": 'unknown op "usage"'}
    sent = rpc(row, {"op": "prompt", "text": "/peers usage on", "from": {"id": mid, "name": "master"}})
    assert sent.get("ok") is True, sent
    wait_for(lambda: len(h.gateway.requests) > requests)  # it reaches the model as a prompt; had it run as a command there would be no request
    assert (h.state / "usage.json").read_bytes() == state_bytes and json.loads(state_bytes)["publishers"] == []
    assert "usage" not in h.row(worker)
    print("PASS no remote op or remote prompt can switch publishing on")
