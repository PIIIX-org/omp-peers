#!/usr/bin/env python3
# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (c) 2026 PIIIX-org contributors
"""Install/uninstall the per-user macOS launchd peer watcher. Never requires sudo."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import tempfile

from watch import private_directory, private_open

DEFAULT_LABEL = "org.omp-peers.watcher"
LABEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)+\Z")


def valid_label(value):
    if not LABEL.fullmatch(value) or len(value) > 200:
        raise argparse.ArgumentTypeError("label must be dot-separated alphanumeric/hyphen/underscore components (max 200 characters)")
    return value


def render_plist(template, home, state_dir, python, label):
    replacements = {"__LABEL__": valid_label(label), "__PYTHON__": str(python),
                    "__WATCHER__": str(state_dir / "watch.py"), "__HOME__": str(home),
                    "__STATE_DIR__": str(state_dir), "__STDOUT__": str(state_dir / "watcher.stdout.log"),
                    "__STDERR__": str(state_dir / "watcher.stderr.log")}
    document = plistlib.loads(template.read_bytes())

    def replace(value):
        if isinstance(value, str):
            return replacements.get(value, value)
        if isinstance(value, list):
            return [replace(item) for item in value]
        if isinstance(value, dict):
            return {key: replace(item) for key, item in value.items()}
        return value

    return plistlib.dumps(replace(document), sort_keys=False)


def write_private(path, content):
    fd, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as target:
            target.write(content)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def manifest_for(state_dir, label, plist):
    path = state_dir / "install.json"
    if not path.exists() and not path.is_symlink():
        return None
    with private_open(path) as source:
        manifest = json.load(source)
    expected = {"installer": "omp-peers-watcher-v1", "label": label, "plist": str(plist)}
    if manifest != expected:
        raise ValueError("runtime belongs to another installation; use its original label and state directory")
    return expected


def launchctl(*arguments, check=True):
    return subprocess.run(["launchctl", *arguments], check=check, capture_output=True, text=True)


def install(home, state_dir, label, python):
    state_dir = private_directory(state_dir)
    agents = home / "Library/LaunchAgents"
    agents.mkdir(mode=0o700, parents=True, exist_ok=True)
    if agents.is_symlink() or not agents.is_dir() or agents.stat().st_uid != os.getuid():
        raise ValueError("LaunchAgents must be an owned directory, not a symlink")
    plist = agents / (label + ".plist")
    manifest = manifest_for(state_dir, label, plist)
    script = state_dir / "watch.py"
    if manifest is None and (script.exists() or script.is_symlink() or plist.exists() or plist.is_symlink()):
        raise ValueError("refusing to overwrite an unmanaged watcher or launch agent")
    domain = "gui/" + str(os.getuid())
    service = domain + "/" + label
    if manifest is not None:
        bootout = launchctl("bootout", service, check=False)
        if bootout.returncode and launchctl("print", service, check=False).returncode == 0:
            raise RuntimeError("could not stop the installed launch agent")
    # Do not replace files used by a manually launched or operational watcher.
    with private_open(state_dir / "completion.lock") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("a watcher is still running; stop it before installing") from None
        source = Path(__file__).resolve().parent
        rendered = render_plist(source / "launchd/peer-watcher.plist.in", home, state_dir, python, label)
        for name in ("watcher.stdout.log", "watcher.stderr.log"):
            with private_open(state_dir / name):
                pass
        write_private(script, (source / "watch.py").read_bytes())
        write_private(plist, rendered)
        write_private(state_dir / "install.json", json.dumps({"installer": "omp-peers-watcher-v1",
                      "label": label, "plist": str(plist)}, separators=(",", ":")).encode())
    # RunAtLoad/KeepAlive do not depend on OMP, a registry, or an existing master.
    launchctl("bootstrap", domain, str(plist))
    print("Installed " + label + "; launchd starts and supervises the watcher at login.")
    print("Runtime: " + str(state_dir))


def uninstall(home, state_dir, label, purge=False):
    if not state_dir.exists():
        raise ValueError("no installation at that state directory")
    state_dir = private_directory(state_dir)
    plist = home / "Library/LaunchAgents" / (label + ".plist")
    if manifest_for(state_dir, label, plist) is None:
        raise ValueError("refusing to remove an unmanaged watcher")
    service = "gui/" + str(os.getuid()) + "/" + label
    result = launchctl("bootout", service, check=False)
    if result.returncode and launchctl("print", service, check=False).returncode == 0:
        raise RuntimeError("could not stop the installed launch agent")
    with private_open(state_dir / "completion.lock") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("a watcher is still running; stop it before uninstalling") from None
        for path in (plist, state_dir / "watch.py", state_dir / "install.json"):
            path.unlink(missing_ok=True)
        if purge:
            for name in ("completions.json", "watcher.stdout.log", "watcher.stderr.log"):
                (state_dir / name).unlink(missing_ok=True)
            (state_dir / "completion.lock").unlink(missing_ok=True)
    if purge:
        try:
            state_dir.rmdir()
        except OSError:
            pass  # Preserve any unrelated or older watcher files.
    print("Uninstalled " + label + ("; removed known runtime files." if purge else "; retained private state/logs."))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("install", "uninstall"))
    parser.add_argument("--label", type=valid_label, default=DEFAULT_LABEL)
    parser.add_argument("--state-dir", type=Path, help="default: HOME/.omp-peer-watch")
    parser.add_argument("--python", type=Path, default=Path(sys.executable), help="absolute Python 3 interpreter for launchd")
    parser.add_argument("--purge", action="store_true", help="uninstall: also remove known state/log files")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("launchd installation requires macOS; run tools/watch.py in the foreground on Linux")
    if args.purge and args.action != "uninstall":
        parser.error("--purge applies only to uninstall")
    home = Path.home().absolute()
    state_dir = (args.state_dir or home / ".omp-peer-watch").expanduser().absolute()
    python = args.python.expanduser().absolute()
    if args.action == "install" and (not python.is_file() or not os.access(python, os.X_OK)):
        parser.error("--python must identify an executable Python 3 interpreter")
    try:
        if args.action == "install":
            install(home, state_dir, args.label, python)
        else:
            uninstall(home, state_dir, args.label, args.purge)
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        raise SystemExit("Watcher " + args.action + " failed: " + str(error)) from None


if __name__ == "__main__":
    main()
