// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

/**
 * The local event spool: the primary, network-free ingress. A producer (the `omp-peers-event` command, or any
 * program running as the same user) drops one small JSON file into a private directory; the master's periodic
 * tick reads and removes it. Authentication is filesystem ownership: the directory is 0700 and owned by the user,
 * and a file that is not owned by the user or is writable by anyone else is rejected, never read.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { MAX_EVENT_BYTES, NAME_RE, openRegular, parseJsonBytes, readBounded, validateGeneric, type EventPayload, type RejectReason } from "./events-ingest";

/** Files handled per tick. */
export const MAX_SPOOL_FILES = 20;
/** Directory entries looked at per tick, so a directory full of junk cannot stall the tick. */
export const MAX_SPOOL_SCAN = 200;
/** A spool file older than this (by modification time) is dropped unread: events expire after 72 hours everywhere else too. */
export const MAX_SPOOL_AGE_MS = 72 * 3_600_000;
const FILE_RE = /^ev-\d{13}-[0-9a-f]{16}\.json$/;

/**
 * `<home>/.omp/agent/peer-state/events-spool`, the same root as `stateRoot(home)`. Spelled out here because the
 * producer command imports this module and must not pull in the state store (it needs the host's native lock library).
 * A test pins the two together.
 */
export const spoolDir = (home: string) => path.join(home, ".omp", "agent", "peer-state", "events-spool");

const currentUid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);

/** Why `dir` must not be used as the spool, or undefined when it is a real directory owned by the user and closed to everyone else. */
export function spoolProblem(dir: string, uid: number | undefined = currentUid()): string | undefined {
	let info: fs.Stats;
	try {
		info = fs.lstatSync(dir);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "spool directory does not exist" : "spool directory cannot be read";
	}
	if (info.isSymbolicLink() || !info.isDirectory()) return "spool path is not a directory";
	if (uid !== undefined && info.uid !== uid) return "spool directory is not owned by the user";
	if ((info.mode & 0o077) !== 0) return "spool directory is accessible to other users";
	return undefined;
}

/** The envelope a spool file holds. */
export interface SpoolEnvelope {
	source: string;
	event: EventPayload;
}

export type WriteResult = { ok: true; file: string } | { ok: false; error: string; code: 1 | 2 };

/**
 * Producer side: validate `raw` as a generic event and drop it into the spool for `source`. Written to a hidden
 * temporary name (O_EXCL, 0600) and renamed, so the master never reads half a file. Refuses a spool that is
 * missing, not owned by the user or open to others, and any payload carrying the delivery prefix.
 */
export function writeSpoolEvent(home: string, source: string, raw: unknown, now: number = Date.now()): WriteResult {
	if (!NAME_RE.test(source)) return { ok: false, error: "source must be 1-32 characters: lower-case letters, digits, '_' or '-', starting with a letter or digit", code: 1 };
	const parsed = validateGeneric(raw);
	if (!parsed.ok) return { ok: false, error: `event rejected: ${parsed.reason}`, code: 2 };
	const dir = spoolDir(home);
	const problem = spoolProblem(dir);
	if (problem) return { ok: false, error: `${problem}${problem.endsWith("not exist") ? "; run /peers events on cli in the master session first" : ""}`, code: 1 };
	const body = `${JSON.stringify({ source, event: parsed.event } satisfies SpoolEnvelope)}\n`;
	if (Buffer.byteLength(body) > MAX_EVENT_BYTES) return { ok: false, error: "event rejected: too large", code: 2 };
	const name = `ev-${String(now).padStart(13, "0")}-${randomBytes(8).toString("hex")}.json`;
	const tmp = path.join(dir, `.tmp-${randomBytes(8).toString("hex")}`);
	try {
		const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
		try {
			fs.writeFileSync(fd, body);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(tmp, path.join(dir, name));
	} catch (error) {
		fs.rmSync(tmp, { force: true });
		return { ok: false, error: `cannot write the spool file (${(error as NodeJS.ErrnoException).code ?? "error"})`, code: 1 };
	}
	return { ok: true, file: name };
}

/** One spool file the master looked at: either bytes to process or the reason it must be rejected. */
export type SpoolEntry = { name: string; body: Buffer } | { name: string; reject: RejectReason } | { name: string; expired: true };

/**
 * Master side: look at up to MAX_SPOOL_SCAN directory entries and read up to MAX_SPOOL_FILES eligible files. Only
 * names the producer writes are considered; symlinks, FIFOs, directories and everything else are ignored (counted,
 * never followed or removed). A regular file that is oversize, foreign-owned or writable by group or others is
 * returned as a rejection without being read, and one whose modification time is 72 hours or more before `now` is
 * reported as expired without being read.
 */
export function scanSpool(dir: string, uid: number | undefined = currentUid(), now: number = Date.now()): { entries: SpoolEntry[]; ignored: number } {
	const entries: SpoolEntry[] = [];
	let ignored = 0;
	const names: string[] = [];
	const handle = fs.opendirSync(dir);
	try {
		for (let seen = 0; seen < MAX_SPOOL_SCAN; seen++) {
			const item = handle.readSync();
			if (!item) break;
			if (FILE_RE.test(item.name)) names.push(item.name);
			else ignored++;
		}
	} finally {
		handle.closeSync();
	}
	for (const name of names.sort()) {
		if (entries.length >= MAX_SPOOL_FILES) break;
		const opened = openRegular(path.join(dir, name));
		if ("error" in opened) {
			ignored++;
			continue;
		}
		try {
			if (uid !== undefined && opened.stat.uid !== uid) entries.push({ name, reject: "file not owned by user" });
			else if ((opened.stat.mode & 0o022) !== 0) entries.push({ name, reject: "file mode unsafe" });
			else if (now - opened.stat.mtimeMs >= MAX_SPOOL_AGE_MS) entries.push({ name, expired: true });
			else if (opened.stat.size > MAX_EVENT_BYTES) entries.push({ name, reject: "too large" });
			else entries.push({ name, body: Buffer.from(readBounded(opened.fd, MAX_EVENT_BYTES)) });
		} finally {
			fs.closeSync(opened.fd);
		}
	}
	return { entries, ignored };
}

/** Remove a spool file once its outcome is recorded. A file that is already gone is fine. */
export function removeSpoolFile(dir: string, name: string): void {
	fs.rmSync(path.join(dir, name), { force: true });
}

/** Parse a spool file's bytes: strict envelope `{ source, event }`, the event in the generic shape. */
export function parseEnvelope(body: Uint8Array): { ok: true; source: string; raw: unknown } | { ok: false; reason: RejectReason; source?: string } {
	const json = parseJsonBytes(body);
	if (!json.ok) return json;
	const value = json.value as Record<string, unknown> | null;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, reason: "bad envelope" };
	const source = typeof value.source === "string" && NAME_RE.test(value.source) ? value.source : undefined;
	if (Object.keys(value).some(key => key !== "source" && key !== "event")) return { ok: false, reason: "unknown key", ...(source ? { source } : {}) };
	if (!source || value.event === undefined) return { ok: false, reason: "bad envelope" };
	return { ok: true, source, raw: value.event };
}

/** The command-line producer: `omp-peers-event --source <name> [--file <json>]` (stdin when no file). Returns the exit code. */
export function runCli(argv: string[], home: string, stdin: () => Uint8Array, out: (line: string) => void): number {
	const usage = "usage: omp-peers-event --source <name> [--file <event.json>]   (the event JSON is read from the file or stdin: {\"id\", \"type\", \"summary\", \"fields\"?})";
	let source: string | undefined;
	let file: string | undefined;
	for (let i = 0; i < argv.length; i += 2) {
		if (argv[i] === "--source" && source === undefined && argv[i + 1]) source = argv[i + 1];
		else if (argv[i] === "--file" && file === undefined && argv[i + 1]) file = argv[i + 1];
		else {
			out(usage);
			return 1;
		}
	}
	if (!source) {
		out(usage);
		return 1;
	}
	let bytes: Uint8Array;
	if (file) {
		const opened = openRegular(file);
		if ("error" in opened) {
			out(`cannot read ${file}: ${opened.error}`);
			return 1;
		}
		try {
			bytes = readBounded(opened.fd, MAX_EVENT_BYTES + 1);
		} finally {
			fs.closeSync(opened.fd);
		}
	} else bytes = stdin();
	const json = parseJsonBytes(bytes);
	if (!json.ok) {
		out(`event rejected: ${json.reason}`);
		return 2;
	}
	const written = writeSpoolEvent(home, source, json.value);
	out(written.ok ? `queued ${written.file}` : written.error);
	return written.ok ? 0 : written.code;
}
