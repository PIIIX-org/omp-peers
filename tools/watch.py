#!/usr/bin/env python3
# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (c) 2026 PIIIX-org contributors
"""Peer watcher: exits (waking the master session) on the first peer state change worth a turn.
Events: busy->idle whose last message asks for input or reports a merge/push/failure, new peer, peer gone.
Plain acknowledgements are logged to skipped.log instead of waking the master."""
import json, glob, os, time, sys, datetime, re
D = os.path.expanduser("~/.omp/run/peers")
STATE = os.path.expanduser("~/.omp-peer-watch/state.json")
os.makedirs(os.path.dirname(STATE), mode=0o700, exist_ok=True)
def master():
    try: return json.load(open(os.path.join(D, "master.json")))["id"]
    except Exception: return None
IGN = os.path.expanduser("~/.omp-peer-watch/ignore.txt")
def ignored():
    try: return set(l.strip() for l in open(IGN) if l.strip())
    except FileNotFoundError: return set()
def snap():
    out = {}
    me = master()
    ign = ignored()
    for f in glob.glob(os.path.join(D, "p*.json")):
        try: j = json.load(open(f))
        except Exception: continue
        if j.get("id") == me or j.get("id") in ign: continue
        out[j["id"]] = {"name": j.get("name", ""), "busy": bool(j.get("busy")), "ctx": j.get("context", ""), "sid": j.get("sessionId", "")}
    return out
SKIP = os.path.expanduser("~/.omp-peer-watch/skipped.log")
QUIET = re.compile(r"nothing (else )?needs (a |your |master'?s? )?(decision|input|answer)|no (decision|reply|answer|input) (is )?needed|nothing to (decide|act on)|no reply needed", re.I)
WAKE = re.compile(r"\?|decision|decide|need(s|ed)? (your|an? |the )?(input|answer|approval|owner|master)|blocked|waiting (on|for) (you|master|owner)|merged|landed|pushed|fail|error|broke|red\b|installed|screenshot|approv|changes requested|question|owner", re.I)
def last_text(sid):
    """Last assistant text of a peer's session file ('' if unreadable)."""
    fs = glob.glob(os.path.expanduser(f"~/.omp/agent/sessions/*/*{sid}.jsonl")) if sid else []
    if not fs: return ""
    with open(fs[0], "rb") as f:
        f.seek(0, 2); f.seek(max(0, f.tell() - 400_000)); lines = f.read().decode("utf-8", "replace").splitlines()
    for l in reversed(lines):
        if '"role":"assistant"' not in l: continue
        try: m = json.loads(l)["message"]
        except Exception: continue
        t = "\n".join(c.get("text", "") for c in m.get("content", []) if c.get("type") == "text").strip()
        if t: return t
    return ""
def worth_waking(sid):
    t = last_text(sid)
    if not t: return True, ""
    if re.match(r"(still )?(nothing new|no change|no news)", t, re.I) and len(t) < 1200: return False, t
    return bool(WAKE.search(QUIET.sub("", t))), t
prev = None
if os.path.exists(STATE):
    try: prev = json.load(open(STATE))
    except Exception: prev = None
if prev is None:
    prev = snap(); json.dump(prev, open(STATE, "w"))
while True:
    cur = snap()
    ev = []
    for pid, c in cur.items():
        p = prev.get(pid)
        if p is None: ev.append((pid, c["name"], "NEW session"))
        elif p["busy"] and not c["busy"]:
            time.sleep(2)  # let the peer flush its final message
            wake, t = worth_waking(c["sid"])
            if wake: ev.append((pid, c["name"], "finished its turn (busy -> idle): check whether it needs input"))
            else:
                with open(SKIP, "a") as f: f.write(f"{datetime.datetime.now(datetime.timezone.utc):%Y-%m-%d %H:%M:%SZ} {pid} {c['name']}: {t[:300]!r}\n")
    for pid, p in prev.items():
        if pid not in cur: ev.append((pid, p["name"], "session GONE"))
    if ev:
        json.dump(cur, open(STATE, "w"))
        now = datetime.datetime.now(datetime.timezone.utc).strftime("%H:%M:%SZ")
        try: nskip = sum(1 for _ in open(SKIP))
        except FileNotFoundError: nskip = 0
        print(f"PEER WATCHER {now}: {len(ev)} event(s). Tail each peer below with peers_control, act, then re-arm the watcher. ({nskip} acknowledgement-only idles skipped so far, see {SKIP})")
        for pid, name, why in ev:
            print(f"- {name} ({pid}): {why}")
        busy = [c["name"] for c in cur.values() if c["busy"]]
        print("still busy: " + (", ".join(busy) if busy else "none"))
        sys.exit(0)
    # keep state current for busy transitions idle->busy (so a later busy->idle is caught)
    changed = any(prev.get(k, {}).get("busy") != v["busy"] for k, v in cur.items())
    if changed or set(prev) != set(cur):
        prev = cur; json.dump(prev, open(STATE, "w"))
    time.sleep(5)
