// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

/**
 * Private local audit log of master control operations.
 *
 * Opt-in (`/peers audit on`). One JSON object per line in `~/.omp/agent/peer-state/audit.jsonl`
 * (directory 0700, file 0600, append-only). Nothing is ever sent anywhere; this module has no network code.
 *
 * Content policy: no tokens, prompt bodies, transcripts, setting values, model messages or free text.
 * Every string is control-character free, length capped and screened for credentials; `reason` comes from a
 * fixed vocabulary. The actor is a sender CLAIM (`from` on the request); it is never authenticated.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { FeatureHost } from "./host";
import type { Feature } from "./index";
import { RESUME_REFUSED, SUBAGENT_RESUME_ERROR } from "./pause";
import { screenText } from "./rules";
import { acquire, privateDir, readRegularFile, readState, stateRoot, updateState } from "./store";

export const MAX_LINE_BYTES = 4096;
export const DEFAULT_MAX_BYTES = 1024 * 1024;
export const MIN_MAX_BYTES = 64 * 1024;
export const MAX_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_AGE_DAYS = 30;
export const MIN_MAX_AGE_DAYS = 1;
export const MAX_MAX_AGE_DAYS = 3650;
export const TAIL_DEFAULT = 10;
export const TAIL_MAX = 50;
/** Audit appends wait this long for the cross-process lock before giving up (the control op never waits on it longer). */
export const LOCK_WAIT_MS = 2000;

const DAY_MS = 86_400_000;
const NAME_MAX = 60;
const SELECTOR_MAX = 80;
const KEY_MAX = 80;
const REDACTED = "[redacted]";
const INVALID = "[invalid]";
const READ_LIMIT = MAX_MAX_BYTES * 2;
const PEER_ID_RE = /^p(?:[0-9a-f]{6}|[0-9a-f]{16})$/;
const HEX32_RE = /^[0-9a-f]{32}$/;
const OP_RE = /^[a-z][a-z-]{0,23}$/;
const SELECTOR_RE = /^[A-Za-z0-9@:._/+-]+$/;
const KEY_RE = /^[A-Za-z0-9_.-]+$/;
const CONTROL_CHARS = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;
const SETTING_MODES = ["get", "set", "clear", "list"];
const SUBAGENT_MODES = ["auto", "auto-off", "auto-managed", "clear"];
const TIERS = ["light", "standard", "heavy", "keep"];

export type Phase = "attempted" | "completed";
export type Side = "sender" | "receiver";
export type Outcome = "ok" | "refused" | "failed" | "unreachable" | "deferred" | "unknown";
/** The only reason texts that are ever stored. */
export const REASONS = [
	"not-master", "locked", "inbound-refused", "not-ready", "protected-setting", "invalid-argument", "unavailable-model",
	"no-credentials", "busy", "paused", "not-resumable", "error", "unreachable", "timeout", "connection-closed", "bad-response", "response-too-large",
] as const;
export type Reason = (typeof REASONS)[number];

/** What is kept about the arguments of a control op. Never bodies, values or transcript text. */
export interface AuditParams {
	/** UTF-8 bytes of the prompt / new name / subagent spec / pause reason text. */
	textLength?: number;
	/** Requested model selector (screened, at most 80 characters). */
	selector?: string;
	/** Requested effort level (screened, at most 80 characters). */
	effort?: string;
	/** Setting id (name only, never a value). */
	key?: string;
	/** `setting` mode, or the `subagents` keyword (`spec` for anything else). */
	mode?: string;
	tier?: string;
	overridePin?: true;
	/** Requested tail length. */
	n?: number;
}

export interface AuditRecord {
	v: 1;
	/** Milliseconds since the epoch. */
	ts: number;
	/** Random id of this record. */
	event: string;
	/** Random id correlating the attempted and completed records, and the sender and receiver records. */
	request: string;
	side: Side;
	phase: Phase;
	/** The sender's CLAIMED stable peer id (`unknown` when absent). Not authenticated. */
	actorClaim: string;
	actorClaimName?: string;
	/** The session the control targets: a stable peer id. */
	targetId: string;
	targetName?: string;
	op: string;
	params?: AuditParams;
	/** Receiver completed records: whether the claimed id equalled the receiver's master id at the check. Absent when no check ran. */
	masterChecked?: boolean;
	/** Completed records only. */
	outcome?: Outcome;
	reason?: Reason;
}

/** Untrusted arguments of a control request. */
export interface ControlArgs {
	text?: unknown;
	key?: unknown;
	tier?: unknown;
	overridePin?: unknown;
	n?: unknown;
}

export interface AuditInput {
	request: string;
	side: Side;
	phase: Phase;
	actor: { id?: unknown; name?: unknown };
	target: { id?: unknown; name?: unknown };
	op: string;
	args: ControlArgs;
	masterChecked?: boolean;
	/** Completed records only. */
	result?: { outcome: Outcome; reason?: Reason };
}

export class AuditError extends Error {}

export const newRequestId = (): string => randomBytes(16).toString("hex");
/** A request id received from a sender is kept only if it has the exact random-id shape. */
export const validRequestId = (value: unknown): string | undefined => (typeof value === "string" && HEX32_RE.test(value) ? value : undefined);

// ---- Redaction ---------------------------------------------------------------------------------

/** Credential-shaped (same families as standing rules) or a long unbroken base64/hex run. */
function looksSecret(text: string): boolean {
	return screenText(text) !== undefined || /[A-Za-z0-9+/]{32,}/.test(text);
}

function displayName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.slice(0, 512).replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
	if (!text) return undefined;
	return looksSecret(text) ? REDACTED : [...text].slice(0, NAME_MAX).join("").trim();
}

/** A logical stable peer id, `unknown` when absent, `[invalid]` for anything else. */
function peerId(value: unknown): string {
	if (value === undefined || value === null) return "unknown";
	return typeof value === "string" && (PEER_ID_RE.test(value) || value === "unknown") ? value : INVALID;
}

function selector(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	if (!text) return undefined;
	if (text.length > 512 || !SELECTOR_RE.test(text) || looksSecret(text)) return REDACTED;
	return text.slice(0, SELECTOR_MAX);
}

function settingKey(value: unknown): string | undefined {
	if (typeof value !== "string" || !value) return undefined;
	return value.length > KEY_MAX || !KEY_RE.test(value) || looksSecret(value) ? REDACTED : value;
}

const byteLength = (value: unknown): number => (typeof value === "string" ? Buffer.byteLength(value) : 0);

/** The recorded form of a control op's arguments. */
export function describeParams(op: string, args: ControlArgs): AuditParams | undefined {
	const text = typeof args.text === "string" ? args.text : "";
	let params: AuditParams = {};
	switch (op) {
		case "prompt": {
			const tier = typeof args.tier === "string" && TIERS.includes(args.tier) ? args.tier : undefined;
			params = { textLength: byteLength(text), ...(tier ? { tier } : {}), ...(args.overridePin === true ? { overridePin: true as const } : {}) };
			break;
		}
		case "model":
		case "effort": {
			const chosen = selector(text);
			if (chosen) params = op === "model" ? { selector: chosen } : { effort: chosen };
			break;
		}
		case "rename":
			params = { textLength: byteLength(text) };
			break;
		case "pause":
			if (text) params = { textLength: byteLength(text) };
			break;
		case "subagents":
			params = { mode: !text ? "clear" : SUBAGENT_MODES.includes(text) ? text : "spec", ...(text ? { textLength: byteLength(text) } : {}) };
			break;
		case "setting": {
			const key = settingKey(args.key);
			params = { mode: !text ? "get" : SETTING_MODES.includes(text) ? text : INVALID, ...(key ? { key } : {}) };
			break;
		}
		case "tail":
			if (typeof args.n === "number" && Number.isSafeInteger(args.n) && args.n > 0) params = { n: Math.min(args.n, 1_000_000) };
			break;
	}
	return Object.keys(params).length ? params : undefined;
}

// ---- Outcomes ----------------------------------------------------------------------------------

/**
 * Map a peer response (or transport failure) to an outcome and a fixed-vocabulary reason. The response text is
 * only matched against known prefixes; it is never stored.
 */
export function classifyResponse(op: string, response: Record<string, unknown>): { outcome: Outcome; reason?: Reason } {
	if (response.ok === true) {
		const deferred = op === "compact" || op === "shutdown" || (op === "prompt" && response.queued === true);
		return { outcome: deferred ? "deferred" : "ok" };
	}
	const error = typeof response.error === "string" ? response.error : "";
	if (error.startsWith("peer is locked")) return { outcome: "refused", reason: "locked" };
	if (error.startsWith("sender is not the master")) return { outcome: "refused", reason: "not-master" };
	if (error.startsWith("peer refuses inbound")) return { outcome: "refused", reason: "inbound-refused" };
	// The receiver's fixed resume refusals (a pause the master did not set) and the subagent refusal.
	if (Object.values(RESUME_REFUSED).includes(error)) return { outcome: "refused", reason: "not-resumable" };
	if (error === SUBAGENT_RESUME_ERROR) return { outcome: "refused", reason: "not-master" };
	// A paused receiver refuses wake-triggering dispatches with a structured refusal (no free text is kept).
	if (response.paused === true) return { outcome: "refused", reason: "paused" };
	if (error.includes("is protected and cannot be changed remotely")) return { outcome: "refused", reason: "protected-setting" };
	if (error.startsWith("session not ready")) return { outcome: "failed", reason: "not-ready" };
	if (error.startsWith("unreachable")) return { outcome: "unreachable", reason: "unreachable" };
	// The sender cannot know whether the receiver executed the op in these cases.
	if (error === "timeout") return { outcome: "unknown", reason: "timeout" };
	if (error === "connection closed") return { outcome: "unknown", reason: "connection-closed" };
	if (error === "bad response") return { outcome: "unknown", reason: "bad-response" };
	if (error === "response too large") return { outcome: "unknown", reason: "response-too-large" };
	if (/^(empty |missing |invalid effort|effort must|unknown setting|unknown op|overridePin requires)/.test(error)) return { outcome: "failed", reason: "invalid-argument" };
	if (error.startsWith("unavailable model")) return { outcome: "failed", reason: "unavailable-model" };
	if (error.startsWith("no credentials")) return { outcome: "failed", reason: "no-credentials" };
	if (error.startsWith("peer busy")) return { outcome: "failed", reason: "busy" };
	return { outcome: "failed", reason: "error" };
}

// ---- Records -----------------------------------------------------------------------------------

export function buildRecord(input: AuditInput, now: number): AuditRecord {
	if (!HEX32_RE.test(input.request)) throw new AuditError("invalid request id");
	const actorName = displayName(input.actor.name);
	const targetName = displayName(input.target.name);
	const params = describeParams(input.op, input.args);
	const completed = input.phase === "completed" && input.result;
	return {
		v: 1,
		ts: now,
		event: newRequestId(),
		request: input.request,
		side: input.side,
		phase: input.phase,
		actorClaim: peerId(input.actor.id),
		...(actorName ? { actorClaimName: actorName } : {}),
		targetId: peerId(input.target.id),
		...(targetName ? { targetName } : {}),
		op: OP_RE.test(input.op) ? input.op : INVALID,
		...(params ? { params } : {}),
		...(input.masterChecked !== undefined ? { masterChecked: input.masterChecked } : {}),
		...(completed ? { outcome: input.result!.outcome, ...(input.result!.reason ? { reason: input.result!.reason } : {}) } : {}),
	};
}

function serialize(record: AuditRecord): Buffer {
	const line = Buffer.from(`${JSON.stringify(record)}\n`);
	if (line.length > MAX_LINE_BYTES) throw new AuditError("audit record exceeds the line size limit");
	return line;
}

const TOP_KEYS = new Set(["v", "ts", "event", "request", "side", "phase", "actorClaim", "actorClaimName", "targetId", "targetName", "op", "params", "masterChecked", "outcome", "reason"]);
const PARAM_KEYS = new Set(["textLength", "selector", "effort", "key", "mode", "tier", "overridePin", "n"]);
const OUTCOMES = new Set<string>(["ok", "refused", "failed", "unreachable", "deferred", "unknown"]);

function validParams(value: unknown): value is AuditParams {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const params = value as Record<string, unknown>;
	if (!Object.keys(params).every(key => PARAM_KEYS.has(key))) return false;
	const isInt = (x: unknown) => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
	return (params.textLength === undefined || isInt(params.textLength)) &&
		(params.n === undefined || (isInt(params.n) && (params.n as number) > 0)) &&
		(params.overridePin === undefined || params.overridePin === true) &&
		(params.selector === undefined || (typeof params.selector === "string" && selector(params.selector) === params.selector)) &&
		(params.effort === undefined || (typeof params.effort === "string" && selector(params.effort) === params.effort)) &&
		(params.key === undefined || (typeof params.key === "string" && settingKey(params.key) === params.key)) &&
		(params.mode === undefined || (typeof params.mode === "string" && (SETTING_MODES.includes(params.mode) || SUBAGENT_MODES.includes(params.mode) || params.mode === "spec" || params.mode === INVALID))) &&
		(params.tier === undefined || (typeof params.tier === "string" && TIERS.includes(params.tier)));
}

/** Strictly parse one log line. A line that is not exactly the v1 shape (including any tampered text) is rejected. */
export function parseRecord(line: string): AuditRecord | undefined {
	if (line.length > MAX_LINE_BYTES) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const r = value as Record<string, unknown>;
	if (!Object.keys(r).every(key => TOP_KEYS.has(key))) return undefined;
	const idOk = (x: unknown) => typeof x === "string" && (PEER_ID_RE.test(x) || x === "unknown" || x === INVALID);
	const nameOk = (x: unknown) => x === undefined || (typeof x === "string" && displayName(x) === x);
	const ok = r.v === 1 && typeof r.ts === "number" && Number.isFinite(r.ts) && r.ts >= 0 &&
		typeof r.event === "string" && HEX32_RE.test(r.event) && typeof r.request === "string" && HEX32_RE.test(r.request) &&
		(r.side === "sender" || r.side === "receiver") && (r.phase === "attempted" || r.phase === "completed") &&
		idOk(r.actorClaim) && idOk(r.targetId) && nameOk(r.actorClaimName) && nameOk(r.targetName) &&
		typeof r.op === "string" && (OP_RE.test(r.op) || r.op === INVALID) &&
		(r.params === undefined || validParams(r.params)) && (r.masterChecked === undefined || typeof r.masterChecked === "boolean") &&
		(r.phase === "completed" ? typeof r.outcome === "string" && OUTCOMES.has(r.outcome) : r.outcome === undefined && r.reason === undefined) &&
		(r.reason === undefined || (REASONS as readonly string[]).includes(r.reason as string));
	return ok ? (r as unknown as AuditRecord) : undefined;
}

// ---- Settings ----------------------------------------------------------------------------------

export interface AuditSettings {
	maxBytes: number;
	maxAgeDays: number;
	/** Why a configured value was ignored. */
	warnings: string[];
}

export const peersConfigFile = (home: string) => path.join(home, ".omp", "agent", "peers.json");

/** Retention limits from `~/.omp/agent/peers.json` `audit`; invalid values fall back to the default and are reported. Never throws. */
export function loadSettings(home: string): AuditSettings {
	const settings: AuditSettings = { maxBytes: DEFAULT_MAX_BYTES, maxAgeDays: DEFAULT_MAX_AGE_DAYS, warnings: [] };
	let text: string;
	try {
		text = readRegularFile(peersConfigFile(home));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "NOT_REGULAR") settings.warnings.push("peers.json is not a regular file; audit limits use their defaults");
		else if (code !== "ENOENT") settings.warnings.push("peers.json is unreadable; audit limits use their defaults");
		return settings;
	}
	let section: unknown;
	try {
		section = (JSON.parse(text) as { audit?: unknown } | null)?.audit;
	} catch {
		settings.warnings.push("peers.json is not valid JSON; audit limits use their defaults");
		return settings;
	}
	if (section === undefined) return settings;
	if (!section || typeof section !== "object" || Array.isArray(section)) {
		settings.warnings.push("peers.json audit must be an object; audit limits use their defaults");
		return settings;
	}
	const cfg = section as Record<string, unknown>;
	const pick = (name: "maxBytes" | "maxAgeDays", min: number, max: number) => {
		const value = cfg[name];
		if (value === undefined) return;
		if (typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max) settings[name] = value;
		else settings.warnings.push(`audit.${name} ignored: must be an integer from ${min} to ${max}`);
	};
	pick("maxBytes", MIN_MAX_BYTES, MAX_MAX_BYTES);
	pick("maxAgeDays", MIN_MAX_AGE_DAYS, MAX_MAX_AGE_DAYS);
	return settings;
}

interface AuditConfig {
	version: 1;
	enabled: boolean;
}

export const auditConfigFile = (home: string) => path.join(stateRoot(home), "audit-config.json");
const validateConfig = (value: unknown): AuditConfig => {
	const config = value as Partial<AuditConfig> | null;
	if (!config || typeof config !== "object" || config.version !== 1 || typeof config.enabled !== "boolean") throw new Error("expected {version:1, enabled:boolean}");
	return config as AuditConfig;
};
const disabledConfig = (): AuditConfig => ({ version: 1, enabled: false });

/** Disabled unless `/peers audit on` was run. An unreadable config counts as disabled and carries the reason. */
export function readEnabled(home: string): { enabled: boolean; error?: string } {
	try {
		return { enabled: readState(auditConfigFile(home), disabledConfig, validateConfig).enabled };
	} catch (error) {
		return { enabled: false, error: (error as Error).message };
	}
}

// ---- Files -------------------------------------------------------------------------------------

export interface AuditPaths {
	dir: string;
	live: string;
	prev: string;
}
export function auditPaths(home: string): AuditPaths {
	const dir = stateRoot(home);
	return { dir, live: path.join(dir, "audit.jsonl"), prev: path.join(dir, "audit.jsonl.1") };
}

const errno = (error: unknown) => (error as NodeJS.ErrnoException).code;

/**
 * Open an audit file without following a symlink, then refuse anything that is not a regular, single-link file
 * owned by this user with no group/other access. The checks run on the open descriptor, so they cannot race.
 */
function openChecked(file: string, flags: number): number {
	const name = path.basename(file);
	let fd: number;
	try {
		// O_NONBLOCK: opening a FIFO planted at this path must not hang; the type check below then refuses it before any I/O.
		fd = fs.openSync(file, flags | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
	} catch (error) {
		if (errno(error) === "ELOOP") throw new AuditError(`${name} is a symlink; refusing to use it`);
		throw error;
	}
	try {
		const info = fs.fstatSync(fd);
		if (!info.isFile()) throw new AuditError(`${name} is not a regular file; refusing to use it`);
		if (info.nlink !== 1) throw new AuditError(`${name} has several hard links; refusing to use it`);
		if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new AuditError(`${name} is owned by another user; refusing to use it`);
		if (info.mode & 0o077) throw new AuditError(`${name} is accessible to group or others; chmod 600 it or delete it`);
	} catch (error) {
		fs.closeSync(fd);
		throw error;
	}
	return fd;
}

function openIfPresent(file: string): number | undefined {
	try {
		return openChecked(file, fs.constants.O_RDONLY);
	} catch (error) {
		if (errno(error) === "ENOENT") return undefined;
		throw error;
	}
}

function firstTimestamp(fd: number): number | undefined {
	const buf = Buffer.alloc(MAX_LINE_BYTES + 1);
	const read = fs.readSync(fd, buf, 0, buf.length, 0);
	const end = buf.subarray(0, read).indexOf(0x0a);
	return end < 0 ? undefined : parseRecord(buf.toString("utf8", 0, end))?.ts;
}

function readLines(file: string): string[] | undefined {
	const fd = openIfPresent(file);
	if (fd === undefined) return undefined;
	try {
		if (fs.fstatSync(fd).size > READ_LIMIT) throw new AuditError(`${path.basename(file)} is larger than ${READ_LIMIT} bytes; delete it`);
		return fs.readFileSync(fd, "utf8").split("\n").filter(line => line.length > 0);
	} finally {
		fs.closeSync(fd);
	}
}

function replaceFile(file: string, content: string): void {
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
		try {
			fs.writeFileSync(fd, content);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(tmp, file);
	} catch (error) {
		fs.rmSync(tmp, { force: true });
		throw error;
	}
}

/** Drop records older than `cutoff` (and lines that cannot be parsed, whose age is unknown) from the previous file. */
function prunePrevious(paths: AuditPaths, cutoff: number): void {
	const lines = readLines(paths.prev);
	if (!lines) return;
	const kept = lines.filter(line => (parseRecord(line)?.ts ?? -1) >= cutoff);
	if (kept.length === lines.length) return;
	if (kept.length === 0) fs.rmSync(paths.prev, { force: true });
	else replaceFile(paths.prev, `${kept.join("\n")}\n`);
}

/**
 * A live file whose first line cannot be parsed (a crashed write fragment, hand editing) has an unknown age. Repair it in
 * place under the append lock: keep only parseable, unexpired records. It is never rotated over the previous file, so
 * archived records that have not expired survive.
 */
function repairLive(paths: AuditPaths, cutoff: number): void {
	const lines = readLines(paths.live);
	if (!lines) return;
	const kept = lines.filter(line => (parseRecord(line)?.ts ?? -1) >= cutoff);
	if (kept.length === 0) fs.rmSync(paths.live, { force: true });
	else replaceFile(paths.live, `${kept.join("\n")}\n`);
}

function inspectLive(paths: AuditPaths): { size: number; first: number | undefined } {
	const fd = openIfPresent(paths.live);
	if (fd === undefined) return { size: 0, first: undefined };
	try {
		const size = fs.fstatSync(fd).size;
		return { size, first: size > 0 ? firstTimestamp(fd) : undefined };
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Under the lock, before an append: repair an unparseable live file, then rotate when the log would exceed `maxBytes` or
 * its oldest record has expired. Rotation atomically replaces the single previous file and then prunes expired records.
 */
function maintain(paths: AuditPaths, settings: AuditSettings, incoming: number, now: number): void {
	const cutoff = now - settings.maxAgeDays * DAY_MS;
	let { size, first } = inspectLive(paths);
	if (size > 0 && first === undefined) {
		repairLive(paths, cutoff);
		({ size, first } = inspectLive(paths));
	}
	if (size > 0 && (size + incoming > settings.maxBytes || (first !== undefined && first < cutoff))) {
		fs.renameSync(paths.live, paths.prev);
		prunePrevious(paths, cutoff);
		return;
	}
	// The previous file holds older records than the live one, in order: if its first record is still fresh, all of it is.
	const prevFd = openIfPresent(paths.prev);
	if (prevFd === undefined) return;
	let oldest: number | undefined;
	try {
		oldest = firstTimestamp(prevFd);
	} finally {
		fs.closeSync(prevFd);
	}
	if (oldest === undefined || oldest < cutoff) prunePrevious(paths, cutoff);
}

/**
 * Cut an unterminated trailing fragment (a crashed or short earlier write) back to the last newline, so the next
 * record starts on its own line. Returns the file length after trimming.
 */
function trimTornTail(fd: number): number {
	const size = fs.fstatSync(fd).size;
	const chunk = Buffer.alloc(Math.min(size, MAX_LINE_BYTES + 1));
	for (let end = size; end > 0; end -= chunk.length) {
		const start = Math.max(0, end - chunk.length);
		const read = fs.readSync(fd, chunk, 0, end - start, start);
		const newline = chunk.subarray(0, read).lastIndexOf(0x0a);
		if (newline < 0) continue;
		const keep = start + newline + 1;
		if (keep !== size) fs.ftruncateSync(fd, keep);
		return keep;
	}
	if (size > 0) fs.ftruncateSync(fd, 0);
	return 0;
}

export type LineWriter = (fd: number, line: Buffer) => number;

/** Append one record. Takes the cross-process lock so appends never interleave with rotation. Throws on any problem. */
export async function appendRecord(home: string, settings: AuditSettings, record: AuditRecord, now: number, writeLine: LineWriter = fs.writeSync): Promise<void> {
	const paths = auditPaths(home);
	const line = serialize(record);
	privateDir(paths.dir);
	const lock = await acquire(`${paths.live}.lock`, LOCK_WAIT_MS);
	try {
		maintain(paths, settings, line.length, now);
		const fd = openChecked(paths.live, fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT);
		try {
			const length = trimTornTail(fd);
			try {
				if (writeLine(fd, line) !== line.length) throw new AuditError("short write to the audit log");
			} catch (error) {
				// Put the file back as it was; if even that fails, the next append cuts the fragment off.
				try {
					fs.ftruncateSync(fd, length);
				} catch {}
				throw error;
			}
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
	} finally {
		lock.release();
	}
}

function describeError(error: unknown): string {
	if (error instanceof AuditError) return error.message;
	const code = errno(error);
	if (typeof code === "string") return `${code}: the audit file could not be written`;
	// readState/store errors carry fixed text naming only a file basename.
	const message = (error as Error)?.message;
	return typeof message === "string" && /^(audit-config\.json|audit\.jsonl[.\w]*|peer-state|\.omp|agent) /.test(message) ? message : "unexpected error";
}

/**
 * Per-process recorder. `record` never throws and never blocks a control op on a failure: it remembers the last
 * failure for `/peers audit status` and warns once per session.
 */
export class AuditLog {
	lastError: { at: number; message: string } | undefined;
	private warned = false;

	constructor(private readonly writeLine: LineWriter = fs.writeSync) {}

	async record(home: string, now: number, input: AuditInput, warn?: (text: string) => void): Promise<void> {
		try {
			const config = readEnabled(home);
			if (config.error) throw new AuditError(config.error);
			if (!config.enabled) return;
			await appendRecord(home, loadSettings(home), buildRecord(input, now), now, this.writeLine);
			this.lastError = undefined;
		} catch (error) {
			const message = describeError(error);
			this.lastError = { at: now, message };
			if (warn && !this.warned) {
				this.warned = true;
				try {
					warn(`peers audit: control not recorded (${message}); see /peers audit status`);
				} catch {}
			}
		}
	}
}

export const auditLog = new AuditLog();

// ---- Inspection and deletion -------------------------------------------------------------------

interface LogView {
	records: AuditRecord[];
	invalid: number;
	bytes: number;
}

function readLog(file: string): LogView | undefined {
	const lines = readLines(file);
	if (!lines) return undefined;
	const records: AuditRecord[] = [];
	for (const line of lines) {
		const record = parseRecord(line);
		if (record) records.push(record);
	}
	return { records, invalid: lines.length - records.length, bytes: fs.statSync(file).size };
}

const iso = (ts: number) => new Date(ts).toISOString();
const DISPLAY_FILE = "~/.omp/agent/peer-state/audit.jsonl";

function viewOf(file: string): { view?: LogView; problem?: string } {
	try {
		return { view: readLog(file) };
	} catch (error) {
		return { problem: describeError(error) };
	}
}

export function statusText(home: string, log: AuditLog = auditLog): string {
	const paths = auditPaths(home);
	const config = readEnabled(home);
	const settings = loadSettings(home);
	const live = viewOf(paths.live);
	const prev = viewOf(paths.prev);
	const out = [config.error ? `audit: off (unknown: ${config.error})` : config.enabled ? "audit: on (/peers audit off stops recording)" : "audit: off (opt-in; /peers audit on enables it)"];
	const problems = [live.problem && `audit.jsonl: ${live.problem}`, prev.problem && `audit.jsonl.1: ${prev.problem}`].filter(Boolean);
	const size = (v: { view?: LogView }) => (v.view ? `${v.view.bytes} bytes` : "absent");
	out.push(`files: ${DISPLAY_FILE} ${live.problem ? "unreadable" : size(live)}; previous ${prev.problem ? "unreadable" : size(prev)}`);
	if (problems.length) out.push(`records: unknown (${problems.join("; ")})`);
	else {
		const all = [...(prev.view?.records ?? []), ...(live.view?.records ?? [])];
		const invalid = (prev.view?.invalid ?? 0) + (live.view?.invalid ?? 0);
		out.push(`records: ${all.length}${invalid ? ` (${invalid} unreadable line(s) skipped)` : ""}`);
		out.push(all.length ? `oldest: ${iso(Math.min(...all.map(r => r.ts)))}\nnewest: ${iso(Math.max(...all.map(r => r.ts)))}` : "oldest: none\nnewest: none");
	}
	out.push(`limits: maxBytes ${settings.maxBytes}, maxAgeDays ${settings.maxAgeDays} (~/.omp/agent/peers.json "audit"); at most one previous file is kept`);
	for (const warning of settings.warnings) out.push(`config: ${warning}`);
	out.push(log.lastError ? `last write error (this session): ${log.lastError.message} at ${iso(log.lastError.at)}` : "last write error (this session): none");
	return out.join("\n");
}

function renderParams(params: AuditParams | undefined): string {
	return params ? ` ${Object.entries(params).map(([k, v]) => `${k}=${String(v)}`).join(" ")}` : "";
}

export function renderRecord(r: AuditRecord): string {
	const who = (id: string, name?: string) => `${id}${name ? ` ${JSON.stringify(name)}` : ""}`;
	const check = r.masterChecked === undefined ? "" : ` master-claim-${r.masterChecked ? "matched" : "mismatch"}`;
	const result = r.phase === "completed" ? ` => ${r.outcome}${r.reason ? ` (${r.reason})` : ""}` : "";
	return `${iso(r.ts)} ${r.side} ${r.phase} req=${r.request} claimed-actor=${who(r.actorClaim, r.actorClaimName)} target=${who(r.targetId, r.targetName)} ${r.op}${renderParams(r.params)}${check}${result}`;
}

export function tailText(home: string, count: number): string {
	const paths = auditPaths(home);
	try {
		const all = [...(readLog(paths.prev)?.records ?? []), ...(readLog(paths.live)?.records ?? [])];
		if (!all.length) return "no audit records";
		const shown = all.slice(-count);
		return [`last ${shown.length} of ${all.length} record(s), oldest first (actors are sender claims, not authenticated):`, ...shown.map(renderRecord)].join("\n");
	} catch (error) {
		return `error: ${describeError(error)}`;
	}
}

/** Delete the live and previous log files. Takes the append lock so no record is written mid-delete. */
export async function clearLog(home: string): Promise<number> {
	const paths = auditPaths(home);
	if (!fs.existsSync(paths.dir)) return 0;
	const lock = await acquire(`${paths.live}.lock`, LOCK_WAIT_MS);
	try {
		let removed = 0;
		for (const file of [paths.live, paths.prev]) {
			try {
				fs.unlinkSync(file);
				removed++;
			} catch (error) {
				if (errno(error) !== "ENOENT") throw error;
			}
		}
		return removed;
	} finally {
		lock.release();
	}
}

async function setEnabled(home: string, enabled: boolean): Promise<void> {
	await updateState(auditConfigFile(home), disabledConfig, validateConfig, () => ({ state: { version: 1, enabled }, result: undefined }));
}

const USAGE = "usage: /peers audit [status] | on | off | tail [n (1-50, default 10)] | clear --yes";

export async function auditCommand(args: string[], host: FeatureHost, log: AuditLog = auditLog): Promise<string> {
	const [sub = "status", ...rest] = args;
	try {
		switch (sub) {
			case "status":
				return rest.length ? USAGE : statusText(host.home, log);
			case "on":
			case "off":
				if (rest.length) return USAGE;
				await setEnabled(host.home, sub === "on");
				return sub === "on"
					? `audit log on: master control attempts and outcomes are recorded locally in ${DISPLAY_FILE} (0600). Prompt text, setting values and transcripts are never stored. Nothing is uploaded.`
					: `audit log off: nothing more is recorded. The existing log is kept; delete it with /peers audit clear --yes.`;
			case "tail": {
				if (rest.length > 1 || (rest[0] !== undefined && !/^[1-9][0-9]*$/.test(rest[0]))) return USAGE;
				const count = rest[0] === undefined ? TAIL_DEFAULT : Number(rest[0]);
				if (count > TAIL_MAX) return `error: tail shows at most ${TAIL_MAX} records`;
				return tailText(host.home, count);
			}
			case "clear": {
				if (rest.length !== 1 || rest[0] !== "--yes") return "clear deletes the audit log and its one previous file on this machine; run /peers audit clear --yes to confirm";
				const removed = await clearLog(host.home);
				return removed ? `audit log cleared: removed ${removed} file(s)` : "audit log: nothing to clear";
			}
			default:
				return USAGE;
		}
	} catch (error) {
		return `error: ${describeError(error)}`;
	}
}

export const audit: Feature = {
	name: "audit",
	command: (args, host) => auditCommand(args, host),
};
