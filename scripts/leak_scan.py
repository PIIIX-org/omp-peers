#!/usr/bin/env python3
# SPDX-License-Identifier: MIT OR Apache-2.0
"""Scan Git's tracked/nonignored files; never print matching text or private paths.

Runtime path templates in source/docs and public dependency/license metadata are
not private artifacts. Concrete runtime dumps, identifiers and credentials are.
"""
import ipaddress
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
TOKEN = re.compile(
    r"\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|"
    r"github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|"
    r"AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,})\b|"
    r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"
)
ASSIGNMENT = re.compile(
    r"(?i)[\"']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|"
    r"auth[_-]?token|session[_-]?token|token|client[_-]?secret|password)[\"']?\s*[:=]\s*"
    r"[\"']?([A-Za-z0-9_./+~=-]{12,})"
)
BEARER = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9_./+~=-]{16,}")
EMAIL = re.compile(r"(?<![\w@])[-\w.+]+@(?:[\w-]+\.)+[A-Za-z]{2,}(?![\w@])")
UUID = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b", re.I)
PERSONAL_PATH = re.compile(r"(?:/(?:Users|home)/[^\s/\"'<>]+|[A-Za-z]:[\\/]Users[\\/][^\s\\/\"'<>]+)")
IPV4 = re.compile(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])")
IPV6 = re.compile(r"(?<![\w:])(?:[0-9a-f]{0,4}:){2,}[0-9a-f:.]*(?:%[\w.-]+)?(?![\w:])", re.I)
# Templates (wildcards, interpolation, <placeholders>) are documentation/source,
# not a captured session path. A concrete runtime dump must not be committed.
RUNTIME_PATH = re.compile(
    r"(?:~|\$HOME)/(?:\.omp/(?:agent/(?:sessions|auth)|run/peers)|"
    r"\.omp-peer-watch)/[^\s\"'`]+"
)
ARTIFACT_DIRS = {".omp", ".omp-peer-watch", "sessions", "transcripts", "logs"}
ARTIFACT_NAMES = {"auth.json", "auth.yml", "auth.yaml", "credentials.json", "state.json", ".env"}


def path_findings(path):
    parts = PurePosixPath(path).parts
    name = parts[-1].lower()
    return {"private artifact path"} if (
        any(part.lower() in ARTIFACT_DIRS for part in parts)
        or name in ARTIFACT_NAMES or name.startswith(".env.")
        or name.endswith((".jsonl", ".log", ".sock", ".pem", ".key"))
    ) else set()


def line_findings(line):
    found = set()
    for label, pattern in (
        ("credential", TOKEN), ("credential assignment", ASSIGNMENT),
        ("authorization", BEARER), ("email", EMAIL),
        ("session identifier", UUID), ("personal path", PERSONAL_PATH),
    ):
        if pattern.search(line):
            found.add(label)
    for match in RUNTIME_PATH.finditer(line):
        value = match.group()
        if not any(marker in value for marker in ("*", "{", "<")):
            # These are the public watcher interface, not captured state.
            if value not in {
                "~/.omp-peer-watch/state.json", "~/.omp-peer-watch/skipped.log",
                "~/.omp-peer-watch/ignore.txt",
                "~/.omp/run/peers/master.json",
            }:
                found.add("runtime artifact path")
    for pattern in (IPV4, IPV6):
        for match in pattern.finditer(line):
            try:
                address = ipaddress.ip_address(match.group().split("%", 1)[0])
            except ValueError:
                continue
            if not address.is_loopback:
                found.add("nonloopback IP")
    return found


def scan(root=ROOT):
    paths = subprocess.check_output(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=root,
    ).split(b"\0")
    findings = []
    for number, raw_path in enumerate(filter(None, paths), 1):
        path = raw_path.decode("utf-8", "surrogateescape")
        file = root / path
        for category in path_findings(path):
            findings.append((number, 0, category))
        if file.is_symlink():
            # Do not follow repository links into private files outside the tree.
            findings.append((number, 0, "symbolic link"))
            continue
        data = file.read_bytes()
        if b"\0" in data:
            findings.append((number, 0, "unscannable binary"))
            continue
        for line_number, line in enumerate(data.decode("utf-8", "replace").splitlines(), 1):
            for category in sorted(line_findings(line)):
                findings.append((number, line_number, category))
    return findings


def main():
    try:
        findings = scan()
    except (OSError, subprocess.SubprocessError):
        print("Leak scan could not read repository files; no file content printed.", file=sys.stderr)
        return 2
    for number, line, category in findings:
        print(f"Leak scan: file #{number}, line {line}: {category} (value/path redacted)", file=sys.stderr)
    if findings:
        return 1
    print("Leak scan passed (working-tree files; ignored local state excluded).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
