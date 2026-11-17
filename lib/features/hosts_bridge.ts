// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

/**
 * The remote end of `/peers hosts`: one request in, one reply out, no daemon, no listener, no outbound
 * connection to any host. `scripts/omp-peers-remote.ts` runs `serve()` once per sshd-started forced command.
 *
 * Authentication and integrity come from the SSH channel (host key verified by the client, the peer's key
 * restricted to this command by the server). The envelope is not signed; this module adds strict schema checks,
 * a hard operation whitelist (`hello`, `list`, `message`), loop prevention (`hops` must be 0, delivered messages
 * carry `hops: 1`) and a persisted replay cache. Sessions apply their own pause, refusal and rate rules.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type { Readable, Writable } from "node:stream";
import { FileLock } from "@oh-my-pi/pi-natives";
import { identifyPeers, logicalId, matchesWriter } from "../identity";
import {
	BRIDGE_VERSION, HOST_ID_RE, MAX_REQUEST_BYTES, MAX_SESSIONS_LISTED, MAX_TEXT_BYTES, PEER_ID_RE, REMOTE_OPS, REPLAY_MAX, REPLAY_TTL_MS, REQUEST_ID_RE,
	SKEW_MS, STDIN_TIMEOUT_MS, ensureHostId, hasOnlyKeys, hasPeerMessageMarker, hostLabel, isRecord, safeName, type Reason, type RemoteOp,
} from "./hosts_wire";
import { stateRoot, updateState } from "./store";

export type Reply = { v: 1; id?: string; ok: true; hostId: string; bridge: number; [key: string]: unknown } | { v: 1; id?: string; ok: false; hostId?: string; error: Reason };

export interface BridgeEnv {
	home: string;
	now(): number;
	/** Per-session socket round-trip cap. */
	callTimeoutMs?: number;
}

const peerRoot = (home: string) => path.join(home, ".omp", "run", "peers");
const MAX_ROW_BYTES = 64 * 1024;
const MAX_ROWS = 256;
const CALL_TIMEOUT_MS = 8_000;
const MAX_REPLY_BYTES = 256 * 1024;

// ---- Reading one request line ------------------------------------------------------------------

export type LineResult = { ok: true; text: string } | { ok: false; error: Reason };

/**
 * Read exactly one newline-terminated line of at most `maxBytes` bytes (newline included). Oversize,
 * a missing newline before the deadline, bytes after the newline in the same chunk, and invalid UTF-8 are errors.
 */
export function readRequestLine(stream: Readable, maxBytes = MAX_REQUEST_BYTES, timeoutMs = STDIN_TIMEOUT_MS): Promise<LineResult> {
	const { promise, resolve } = Promise.withResolvers<LineResult>();
	const chunks: Buffer[] = [];
	let size = 0;
	let done = false;
	const finish = (result: LineResult) => {
		if (done) return;
		done = true;
		clearTimeout(timer);
		stream.off("data", onData);
		stream.off("end", onEnd);
		stream.off("error", onError);
		resolve(result);
	};
	const onData = (chunk: Buffer | string) => {
		const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		const newline = bytes.indexOf(0x0a);
		const lineEnd = newline < 0 ? bytes.length : newline + 1;
		if (size + lineEnd > maxBytes) return finish({ ok: false, error: "request too large" });
		chunks.push(bytes.subarray(0, lineEnd));
		size += lineEnd;
		if (newline < 0) return;
		if (lineEnd < bytes.length) return finish({ ok: false, error: "bad request" });
		try {
			finish({ ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)).slice(0, -1) });
		} catch {
			finish({ ok: false, error: "bad request" });
		}
	};
	const onEnd = () => finish({ ok: false, error: "bad request" });
	const onError = () => finish({ ok: false, error: "bad request" });
	const timer = setTimeout(() => finish({ ok: false, error: "request timed out" }), timeoutMs);
	stream.on("data", onData);
	stream.on("end", onEnd);
	stream.on("error", onError);
	return promise;
}

// ---- Replay cache ------------------------------------------------------------------------------

interface ReplayState {
	version: 1;
	seen: Array<{ id: string; at: number }>;
}

export const replayFile = (home: string) => path.join(stateRoot(home), "hosts-replay.json");

function validateReplay(value: unknown): ReplayState {
	if (!isRecord(value) || value.version !== 1 || !hasOnlyKeys(value, ["version", "seen"]) || !Array.isArray(value.seen) || value.seen.length > REPLAY_MAX) throw new Error("malformed fields");
	for (const entry of value.seen) {
		if (!isRecord(entry) || !hasOnlyKeys(entry, ["id", "at"]) || typeof entry.id !== "string" || !REQUEST_ID_RE.test(entry.id) || typeof entry.at !== "number" || !Number.isFinite(entry.at)) throw new Error("malformed entry");
	}
	return value as unknown as ReplayState;
}

/**
 * Remember `id` for REPLAY_TTL_MS from `at` (default `now`); at most REPLAY_MAX ids are kept. Atomic across processes: of any
 * number of concurrent requests with one id exactly one is accepted. A full cache refuses new ids (fails closed) until entries
 * expire. The caller passes `at = max(now, request timestamp)`: a request stamped up to SKEW_MS in the future stays valid until
 * its timestamp + SKEW_MS, which must lie inside the remembered window (REPLAY_TTL_MS > SKEW_MS), or the id could be replayed
 * after it expired while its timestamp is still accepted.
 */
export async function claimRequestId(home: string, id: string, now: number, at: number = now): Promise<"accepted" | "duplicate" | "full"> {
	return updateState<ReplayState, "accepted" | "duplicate" | "full">(replayFile(home), () => ({ version: 1, seen: [] }), validateReplay, current => {
		const live = current.seen.filter(entry => now - entry.at < REPLAY_TTL_MS);
		const pruned = live.length !== current.seen.length;
		if (live.some(entry => entry.id === id)) return { ...(pruned ? { state: { version: 1 as const, seen: live } } : {}), result: "duplicate" };
		if (live.length >= REPLAY_MAX) return { ...(pruned ? { state: { version: 1 as const, seen: live } } : {}), result: "full" };
		return { state: { version: 1, seen: [...live, { id, at }] }, result: "accepted" };
	});
}

// ---- Sessions on this machine ------------------------------------------------------------------

interface Row {
	id: string;
	name: string;
	sessionId: string;
	pid: number;
	instance: string;
	sock: string;
	busy?: boolean;
	paused?: boolean;
	inbound?: string;
}

function readRow(file: string): unknown {
	let fd: number;
	try {
		fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	} catch {
		return undefined;
	}
	try {
		const info = fs.fstatSync(fd);
		if (!info.isFile() || info.size > MAX_ROW_BYTES) return undefined;
		return JSON.parse(fs.readFileSync(fd, "utf8"));
	} catch {
		return undefined;
	} finally {
		fs.closeSync(fd);
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Live registrations, read-only (no cleanup of stale rows). A row is trusted only when its file name, id and socket path agree. */
function scanRows(home: string): Row[] {
	const root = peerRoot(home);
	let files: string[];
	try {
		files = fs.readdirSync(root).filter(file => /^p(?:[0-9a-f]{6}|[0-9a-f]{16})\.json$/.test(file)).slice(0, MAX_ROWS);
	} catch {
		return [];
	}
	const rows: Row[] = [];
	for (const file of files) {
		const raw = readRow(path.join(root, file));
		if (!isRecord(raw) || raw.id !== file.slice(0, -5) || typeof raw.pid !== "number" || !Number.isInteger(raw.pid) || raw.pid <= 0 || typeof raw.name !== "string") continue;
		if (raw.sock !== path.join(root, `${raw.id}.sock`) || !alive(raw.pid)) continue;
		rows.push({
			id: raw.id, name: raw.name, pid: raw.pid, sock: raw.sock,
			sessionId: typeof raw.sessionId === "string" ? raw.sessionId : "",
			instance: typeof raw.instance === "string" ? raw.instance : "",
			busy: typeof raw.busy === "boolean" ? raw.busy : undefined,
			paused: typeof raw.paused === "boolean" ? raw.paused : undefined,
			inbound: typeof raw.inbound === "string" ? raw.inbound : undefined,
		});
	}
	return rows;
}

/** One request line to a session socket, one reply line back (same framing as the extension's own `call`). */
function callSocket(sock: string, request: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	let buf = "";
	let done = false;
	const finish = (value: Record<string, unknown>) => {
		if (done) return;
		done = true;
		clearTimeout(timer);
		conn.destroy();
		resolve(value);
	};
	const conn = net.createConnection(sock);
	const timer = setTimeout(() => finish({ ok: false, error: "timeout" }), timeoutMs);
	conn.on("connect", () => conn.write(`${JSON.stringify(request)}\n`));
	conn.on("data", chunk => {
		buf += chunk.toString();
		if (buf.length > MAX_REPLY_BYTES) return finish({ ok: false, error: "response too large" });
		const newline = buf.indexOf("\n");
		if (newline < 0) return;
		try {
			const parsed: unknown = JSON.parse(buf.slice(0, newline));
			finish(isRecord(parsed) ? parsed : { ok: false, error: "bad response" });
		} catch {
			finish({ ok: false, error: "bad response" });
		}
	});
	conn.on("error", error => finish({ ok: false, error: `unreachable (${(error as NodeJS.ErrnoException).code ?? "error"})` }));
	conn.on("close", () => finish({ ok: false, error: "connection closed" }));
	return promise;
}

/** The live logical sessions, resolved like `/peers list`: a duplicate registration counts only for its proven writer. */
async function liveSessions(env: BridgeEnv): Promise<Array<Row & { key: string }>> {
	const timeout = env.callTimeoutMs ?? CALL_TIMEOUT_MS;
	const roster = await identifyPeers(scanRows(env.home), async peer => {
		const lockPath = path.join(peerRoot(env.home), `${peer.id}.lock`);
		if (!FileLock.isHeld(lockPath)) return false;
		const response = await callSocket(peer.sock, { op: "status" }, Math.min(timeout, 1_000));
		return matchesWriter(peer, response, FileLock.isHeld(lockPath));
	});
	return roster.filter(peer => !peer.duplicateSession.length || peer.canonicalId === peer.id).map(peer => ({ ...peer, key: logicalId(peer) }));
}

// ---- Operations --------------------------------------------------------------------------------

const BASE_KEYS = ["v", "id", "ts", "hops", "origin", "op"] as const;
const ENVELOPE_OPTIONAL = ["expect"] as const;
const MESSAGE_KEYS = ["to", "text", "from"] as const;

const refuse = (error: Reason, hostId: string, id?: string): Reply => ({ v: 1, ...(id ? { id } : {}), ok: false, hostId, error });

/** Map a session socket answer to a fixed bridge reason; free text from the session is never forwarded. */
function deliveryReason(response: Record<string, unknown>): Reason {
	if (response.paused === true) return "session paused";
	const error = typeof response.error === "string" ? response.error : "";
	if (error === "peer refuses inbound requests") return "session refuses inbound";
	if (error === "rate limited") return "session rate limited";
	if (error === "timeout" || error === "connection closed" || error === "bad response" || error === "response too large") return "delivery unknown";
	if (error.startsWith("unreachable")) return "session unreachable";
	return "delivery failed";
}

/**
 * Validate and answer one request line. Order: JSON shape, version, hops, operation whitelist (a refused
 * operation never reads state or touches a session), strict keys, field formats, host pin, clock skew, replay
 * cache, then the operation.
 */
export async function handleLine(env: BridgeEnv, hostId: string, line: string): Promise<Reply> {
	let req: unknown;
	try {
		req = JSON.parse(line);
	} catch {
		return refuse("bad request", hostId);
	}
	if (!isRecord(req)) return refuse("bad request", hostId);
	if (req.v !== 1) return refuse("unsupported version", hostId);
	if (req.hops !== 0) return refuse("hops not zero", hostId);
	if (typeof req.op !== "string" || !(REMOTE_OPS as readonly string[]).includes(req.op)) return refuse("operation not allowed", hostId);
	const op = req.op as RemoteOp;
	if (!hasOnlyKeys(req, op === "message" ? [...BASE_KEYS, ...MESSAGE_KEYS] : BASE_KEYS, ENVELOPE_OPTIONAL)) return refuse("bad request", hostId);
	const { id, ts, origin, expect } = req;
	if (typeof id !== "string" || !REQUEST_ID_RE.test(id)) return refuse("bad request", hostId);
	if (typeof ts !== "number" || !Number.isInteger(ts)) return refuse("bad request", hostId, id);
	if (!isRecord(origin) || !hasOnlyKeys(origin, ["hostId", "name"]) || typeof origin.hostId !== "string" || !HOST_ID_RE.test(origin.hostId) || origin.name !== hostLabel(origin.hostId)) {
		return refuse("bad request", hostId, id);
	}
	if (expect !== undefined && !(typeof expect === "string" && HOST_ID_RE.test(expect))) return refuse("bad request", hostId, id);
	let message: { to: string; text: string; from: { id: string; name: string } } | undefined;
	if (op === "message") {
		const { to, text, from } = req;
		if (typeof to !== "string" || !PEER_ID_RE.test(to) || typeof text !== "string" || !text.trim()) return refuse("bad request", hostId, id);
		if (!isRecord(from) || !hasOnlyKeys(from, ["id", "name"]) || typeof from.id !== "string" || !PEER_ID_RE.test(from.id) || typeof from.name !== "string") return refuse("bad request", hostId, id);
		if (Buffer.byteLength(text) > MAX_TEXT_BYTES) return refuse("message too large", hostId, id);
		// A message that is itself a peer message header is a forwarded message: never relayed through a bridge either.
		if (hasPeerMessageMarker(text)) return refuse("relayed message refused", hostId, id);
		message = { to, text, from: { id: from.id, name: safeName(from.name) } };
	}
	if (expect !== undefined && expect !== hostId) return refuse("host identity mismatch", hostId, id);
	if (Math.abs(env.now() - ts) > SKEW_MS) return refuse("stale or future timestamp", hostId, id);
	const claim = await claimRequestId(env.home, id, env.now(), Math.max(env.now(), ts));
	if (claim === "duplicate") return refuse("duplicate request", hostId, id);
	if (claim === "full") return refuse("replay cache full", hostId, id);
	const ok = (extra: Record<string, unknown> = {}): Reply => ({ v: 1, id, ok: true, hostId, bridge: BRIDGE_VERSION, ...extra });
	if (op === "hello") return ok();
	if (op === "list") {
		// A whitelist: nothing but these fields leaves this machine. Unknown stays unknown (the field is omitted).
		const sessions = (await liveSessions(env)).slice(0, MAX_SESSIONS_LISTED).map(peer => {
			return {
				id: peer.key,
				name: safeName(peer.name),
				...(peer.busy === undefined ? {} : { busy: peer.busy }),
				...(peer.paused === undefined ? {} : { paused: peer.paused }),
				...(peer.inbound === "accept" || peer.inbound === "refuse" ? { inbound: peer.inbound } : {}),
			};
		});
		return ok({ sessions });
	}
	const { to, text, from } = message!;
	const target = (await liveSessions(env)).find(peer => peer.key === to);
	if (!target) return refuse("session offline", hostId, id);
	// Same request shape as a local sender; `origin: "remote"` and `hops: 1` make the receiver mark it and keep it informational.
	const response = await callSocket(target.sock, {
		op: "message",
		text,
		from: { id: `${hostLabel(origin.hostId)}:${from.id}`, name: from.name },
		origin: "remote",
		hops: 1,
	}, env.callTimeoutMs ?? CALL_TIMEOUT_MS);
	return response.ok === true ? ok({ status: "delivered" }) : refuse(deliveryReason(response), hostId, id);
}

/** Answer one request read from `input` on `output`. Never throws and never writes anything but one JSON line. */
export async function serve(env: BridgeEnv, input: Readable, output: Writable): Promise<void> {
	let reply: Reply;
	try {
		const hostId = await ensureHostId(env.home);
		const line = await readRequestLine(input);
		reply = line.ok ? await handleLine(env, hostId, line.text) : refuse(line.error, hostId);
	} catch {
		reply = { v: 1, ok: false, error: "bridge unavailable" };
	}
	const { promise, resolve } = Promise.withResolvers<void>();
	output.write(`${JSON.stringify(reply)}\n`, () => resolve());
	await promise;
}
