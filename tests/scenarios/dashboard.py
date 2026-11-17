# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (c) 2026 PIIIX-org contributors
"""/peers dashboard through real OMP processes (RPC mode, so the one-shot text snapshot): a busy worker, a paused
session, a held lock, a board entry, a pending decision and a group. Opening it changes nothing and wakes nothing."""
import json
import os
import re
import socketserver
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

from smoke import wait_for

USAGE = "usage: /peers dashboard [--group <name>] [--stale-after <seconds>] [--panels sessions,groups,locks,tasks,decisions] [--once]"


class HoldingGateway(BaseHTTPRequestHandler):
    """Plain replies; a HOLD-OPEN marker in the last user message keeps the turn open until released."""

    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.requests.append((self.path, body))
        last = body["messages"][-1]
        text = last["content"] if isinstance(last["content"], str) else "".join(p.get("text", "") for p in last["content"])
        if last["role"] == "user" and "HOLD-OPEN" in text:
            self.server.release.wait(timeout=150)
        common = {"id": "scripted", "object": "chat.completion.chunk", "created": 1, "model": body["model"]}
        chunks = [{**common, "choices": [{"index": 0, "delta": {"role": "assistant", "content": "Noted."}, "finish_reason": None}]},
                  {**common, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                   "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}]
        payload = ("".join("data: " + json.dumps(c) + "\n\n" for c in chunks) + "data: [DONE]\n\n").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def flat(text):
    """Continuation lines (six-space indent) joined to their row, so the check does not depend on line wrapping."""
    return re.sub(r"\n {6}", "  ", text)


def normalize(text):
    """Replace the values that change from run to run: the time of the snapshot and every age or remaining time."""
    text = re.sub(r"taken \S+;", "taken <T>;", text)
    text = re.sub(r"registry: \S+ ago", "registry: <AGE> ago", text)
    text = re.sub(r"(asked|recorded|reported) \S+ ago", r"\1 <AGE> ago", text)
    return re.sub(r"expires in [0-9hms ]+?(  |$)", r"expires in <D>\1", text, flags=re.M)


def mirror(row, me):
    """The session line the dashboard must print for this registry row: every value comes from the published row."""
    activity = row.get("activity") or {}

    def count(value):
        return "unknown" if not isinstance(value, int) or isinstance(value, bool) or value < 0 else str(value)

    def yes_no(value):
        return "unknown" if not isinstance(value, bool) else ("yes" if value else "no")

    refused = row["inbound"] == "refuse"
    control = "n/a (inbound refused)" if refused else ("open" if row["control"] else "locked")
    return (f"  {row['name']} ({row['id']})  {'busy' if row['busy'] else 'idle'}{'  [this session]' if me else ''}  "
            f"context: {row.get('context') or 'unknown'}  jobs: {count(activity.get('activeJobs'))}  agents: {count(activity.get('activeSubagents'))}  "
            f"settled: {yes_no(row.get('isSettled'))}  inbound: {'refused' if refused else 'open'}  control: {control}  "
            f"paused: {yes_no(row.get('paused'))}  error turns: {count(row.get('recentErrorTurns'))}  "
            f"dir: {os.path.basename(row['cwd'])}  registry: <AGE> ago")


def run(h):
    # A held request must not block the other sessions' requests: serve each one on its own thread.
    h.gateway.__class__ = type("ThreadedGateway", (socketserver.ThreadingMixIn, HTTPServer), {"daemon_threads": True})
    h.gateway.RequestHandlerClass = HoldingGateway
    h.gateway.release = threading.Event()
    try:
        scenario(h, h.gateway.requests)
    finally:
        h.gateway.release.set()


def scenario(h, requests):
    master, worker, other = h.start(), h.start(), h.start()
    mid, wid, oid = h.row(master)["id"], h.row(worker)["id"], h.row(other)["id"]
    assert h.say(master, "/peers master")
    h.say(master, f"/peers do {wid} rename worker-a")
    h.say(master, f"/peers do {oid} rename worker-b")
    wait_for(lambda: h.row(worker)["name"] == "worker-a" and h.row(other)["name"] == "worker-b")

    assert h.say(master, "/peers groups add frontend worker-a").startswith("added worker-a")
    assert h.say(master, "/peers groups add frontend worker-b").startswith("added worker-b")
    assert h.say(worker, "/peers locks acquire heavy-build --ttl 600 --note release build").startswith("acquired heavy-build: lease l1")
    assert h.say(master, "/peers board assign worker-a write the parser").startswith(f"assigned worker-a ({wid})")
    assert h.say(worker, "/peers inbox ask Ship the release today?") == "queued q1: Ship the release today?"
    assert h.say(other, "/peers pause waiting for review").startswith(f"paused worker-b ({oid})")
    wait_for(lambda: h.row(other).get("paused") is True)
    worker.call("prompt", message="HOLD-OPEN please")  # a real turn the gateway keeps open: the worker stays busy
    wait_for(lambda: h.row(worker)["busy"] is True)

    def fingerprint():
        return {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in sorted(h.state.rglob("*.json"))}

    time.sleep(1.0)  # let any start-up background write settle before the baseline
    assert {"groups.json", "locks.json", "board.json", "inbox.json", "pause.json"} <= set(fingerprint()), sorted(fingerprint())
    state_before = fingerprint()
    served = len(requests)
    frames = {name: len(peer.frames) for name, peer in (("worker", worker), ("other", other))}

    first = h.say(master, "/peers dashboard --once")
    rows = {name: h.row(peer) for name, peer in (("master", master), ("worker", worker), ("other", other))}
    sessions = [(rows["master"], True), (rows["worker"], False), (rows["other"], False)]
    sessions.sort(key=lambda item: (item[0]["name"].lower(), item[0]["id"]))
    # groups.json keeps members sorted by stable id, and the dashboard lists them in that order.
    members = "  ".join(f"{name} ({pid})" for pid, name in sorted([(wid, "worker-a"), (oid, "worker-b")]))
    header = [
        "peers dashboard: read-only snapshot",
        f"taken <T>; you are {rows['master']['name']} ({mid}), the master",
        "filter: none; registry rows stale after 60s; unknown = not published or unreadable",
    ]
    expected = "\n".join(header + [
        "", "== sessions (3) ==", *(mirror(row, me) for row, me in sessions),
        "", "== groups (1) ==", f"  frontend  2 member(s)  {members}",
        "", "== locks (1) ==", "  heavy-build  1 of 1 slot in use (busy)",
        f"      l1  worker-a ({wid})  expires in <D>  note: release build",
        "", "== tasks (1) ==",
        f"  worker-a ({wid})  assigned (progress unknown: nothing reported)  running  task: write the parser  recorded <AGE> ago",
        "  stale after 24h without an update (done never goes stale); statuses are unverified claims",
        "", "== decisions (1 open) ==", f"  q1  worker-a ({wid})  asked <AGE> ago  Ship the release today?",
    ])
    # The busy worker and the paused session are labeled as published, not guessed.
    assert rows["worker"]["busy"] is True and rows["other"]["paused"] is True
    actual = normalize(flat(first))
    assert actual == normalize(flat(expected)), f"\n--- actual\n{first}\n--- expected\n{expected}"
    assert f"worker-a ({wid})  busy" in actual and f"worker-b ({oid})  idle" in actual and "paused: yes" in actual
    print("PASS the dashboard prints sessions, groups, locks, tasks and decisions exactly as published")

    assert normalize(h.say(master, "/peers dashboard")) == normalize(first), "plain /peers dashboard must equal --once in a non-TUI session"
    assert normalize(h.say(master, "/peers dashboard --once")) == normalize(first), "a second snapshot differs"
    from_paused = h.say(other, "/peers dashboard --once")
    assert f"you are worker-b ({oid}), not the master" in from_paused and "== sessions (3) ==" in from_paused, from_paused
    print("PASS a second snapshot is identical, and any session (even a paused one) can open it")

    assert fingerprint() == state_before, "opening the dashboard modified a state file"
    assert len(requests) == served, requests[served:]
    time.sleep(1.0)
    for name, peer in (("worker", worker), ("other", other)):
        woke = [f for f in peer.frames[frames[name]:]
                if str(f.get("type", "")).startswith(("agent_", "turn_", "message_")) or "Message from" in json.dumps(f)]
        assert not woke, (name, woke)
    assert h.row(worker)["busy"] is True and h.row(other)["paused"] is True
    print("PASS state files keep their bytes and mtimes, the gateway saw no request and neither the busy nor the paused session was woken")

    filtered = h.say(master, "/peers dashboard --group FRONTEND --panels groups,locks")
    wanted = "\n".join([
        "peers dashboard: read-only snapshot", f"taken <T>; you are {rows['master']['name']} ({mid}), the master",
        "filter: group frontend; registry rows stale after 60s; unknown = not published or unreadable",
        "", "== groups (1) ==", f"  frontend  2 member(s)  {members}",
        "", "== locks (1) ==", "  heavy-build  1 of 1 slot in use (busy)", f"      l1  worker-a ({wid})  expires in <D>  note: release build",
    ])
    assert normalize(flat(filtered)) == normalize(flat(wanted)), filtered
    ghost = h.say(master, "/peers dashboard --group ghost --panels sessions")
    assert "no group named ghost; the filter matches nothing" in ghost and "== sessions (0) ==\n  no sessions" in ghost, ghost
    for bad, message in (("--stale-after 4", "--stale-after must be a whole number of seconds from 5 to 3600"),
                         ("--group Bad_Name!", "group name must be 1-48 characters: lower-case letters, digits, '.', '_' or '-', starting with a letter or digit"),
                         ("--panels sessions,nope", "--panels takes a comma-separated list of distinct names from sessions, groups, locks, tasks, decisions"),
                         ("--watch", 'unknown option "--watch"')):
        assert h.say(master, f"/peers dashboard {bad}") == f"error: {message}\n{USAGE}", bad
    print("PASS the group filter, panel selection and option validation print exact results")

    # A registry row nobody refreshed for ten minutes is labeled stale. Its owner republishes every 5 s, so the aged row is
    # read straight away and the attempt repeated if a refresh slipped in between.
    path = next(p for p in h.registry.glob("p*.json") if json.loads(p.read_text())["id"] == oid)
    for _attempt in range(5):
        aged = json.loads(path.read_text())
        aged["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() - 600))
        tmp = path.with_suffix(".aged")
        tmp.write_text(json.dumps(aged))
        os.replace(tmp, path)
        stale = flat(h.say(master, "/peers dashboard --once --panels sessions"))
        if f"worker-b ({oid})  idle  [stale]" in stale:
            break
    else:
        raise AssertionError(stale)
    line = next(line for line in stale.splitlines() if f"worker-b ({oid})" in line)
    assert line.endswith("registry: 10m ago"), line
    assert "[stale]" not in next(line for line in stale.splitlines() if f"worker-a ({wid})" in line)
    assert fingerprint() == state_before
    print("PASS an aged registry row is labeled [stale] with its age; fresh rows are not")
