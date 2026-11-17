// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

/**
 * Pure ingestion helpers for external events: strict payload validation, sanitisation, the GitHub example
 * adapter, HMAC verification and secret-file checks. Nothing here writes state or sends anything.
 *
 * Payload text is never forwarded verbatim. An event is accepted only in the strict generic shape; every
 * string that survives is stripped of control characters and ANSI sequences, screened for credentials and
 * measured in bytes (`Buffer.byteLength`), so the stored and delivered text is bounded and printable.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import { looksLikeSecret } from "./secrets";

export const MAX_EVENT_BYTES = 65_536;
export const MAX_ID = 128;
export const MAX_TYPE = 64;
export const MAX_SUMMARY_BYTES = 200;
export const MAX_FIELDS = 8;
export const MAX_FIELD_KEY = 32;
export const MAX_FIELD_VALUE_BYTES = 120;
export const MIN_SECRET_BYTES = 16;
export const MAX_SECRET_BYTES = 256;
/** The text every delivered event starts with; an event whose own text contains it is refused so plugin messages can never be re-ingested. */
export const DELIVERY_PREFIX = "[external event";
export const WITHHELD = "(withheld)";

export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const TYPE_RE = /^[A-Za-z0-9._:-]{1,64}$/;
export const KEY_RE = /^[a-z0-9][a-z0-9_]{0,31}$/;

/** Source names the plugin's own features use: an event claiming one of them could be mistaken for plugin output. */
export const RESERVED_SOURCES: readonly string[] = [
	"peers", "peer", "omp", "omp-peers", "events", "event", "system", "master", "self", "plugin",
	"rules", "inbox", "board", "pause", "resume", "locks", "groups", "audit", "deps", "templates", "watchdog", "autocompact",
];

/** Every reason an event can be rejected, in one place: the audit log only ever records these. */
export const REJECT_REASONS = [
	"malformed json", "bad envelope", "unknown key", "missing field", "bad id", "bad type", "bad summary", "bad fields",
	"secret-like id or type", "reserved text", "too large", "bad github event", "unknown source", "source disabled",
	"no matching route", "route limit", "global rate limit", "bad signature", "secret file unusable", "file not owned by user", "file mode unsafe",
	"spool directory unsafe",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export type FieldValue = string | number | boolean;
export interface EventPayload {
	id: string;
	type: string;
	summary: string;
	fields: Record<string, FieldValue>;
}
export type Parsed = { ok: true; event: EventPayload } | { ok: false; reason: RejectReason };

const reject = (reason: RejectReason): Parsed => ({ ok: false, reason });
const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// ---- Text --------------------------------------------------------------------------------------

/** Remove ANSI escape sequences, control and format characters; whitespace runs collapse to one space. */
export function cleanText(raw: string): string {
	/* eslint-disable no-control-regex -- matching escape sequences is the point of this function */
	return raw
		.replace(/[\n\r\t\u2028\u2029]/g, " ")
		.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b./g, "")
		.replace(/[\p{Cc}\p{Cf}]/gu, "")
		.replace(/\s+/g, " ")
		.trim();
}
/* eslint-enable no-control-regex */

/** Cut `text` to at most `max` UTF-8 bytes without splitting a character. */
export function capBytes(text: string, max: number): string {
	if (Buffer.byteLength(text) <= max) return text;
	let out = "";
	let size = 0;
	for (const char of text) {
		const bytes = Buffer.byteLength(char);
		if (size + bytes > max) break;
		out += char;
		size += bytes;
	}
	return out;
}

const containsDeliveryPrefix = (text: string): boolean => text.replace(/\s+/g, "").toLowerCase().includes(DELIVERY_PREFIX.replace(/\s+/g, ""));

// ---- Strict generic validation -----------------------------------------------------------------

/**
 * The generic event shape: `{ id, type, summary, fields? }` and nothing else. Size limits apply to the raw
 * values (an over-long value is rejected, never truncated); the accepted strings are then cleaned and screened.
 */
export function validateGeneric(value: unknown): Parsed {
	if (!isPlain(value)) return reject("bad envelope");
	for (const key of Object.keys(value)) if (!["id", "type", "summary", "fields"].includes(key)) return reject("unknown key");
	const { id, type, summary, fields } = value;
	if (id === undefined || type === undefined || summary === undefined) return reject("missing field");
	if (typeof id !== "string" || !ID_RE.test(id)) return reject("bad id");
	if (typeof type !== "string" || !TYPE_RE.test(type)) return reject("bad type");
	if (looksLikeSecret(id) || looksLikeSecret(type)) return reject("secret-like id or type");
	if (typeof summary !== "string" || !summary || Buffer.byteLength(summary) > MAX_SUMMARY_BYTES) return reject("bad summary");
	const cleanSummary = cleanText(summary);
	if (!cleanSummary) return reject("bad summary");
	if (containsDeliveryPrefix(cleanSummary)) return reject("reserved text");
	const out: Record<string, FieldValue> = {};
	if (fields !== undefined) {
		if (!isPlain(fields)) return reject("bad fields");
		const entries = Object.entries(fields);
		if (entries.length > MAX_FIELDS) return reject("bad fields");
		for (const [key, raw] of entries) {
			if (!KEY_RE.test(key)) return reject("bad fields");
			if (typeof raw === "string") {
				if (!raw || Buffer.byteLength(raw) > MAX_FIELD_VALUE_BYTES) return reject("bad fields");
				const clean = cleanText(raw);
				if (!clean) return reject("bad fields");
				if (containsDeliveryPrefix(clean)) return reject("reserved text");
				out[key] = looksLikeSecret(clean) || looksLikeSecret(`${key}=${clean}`) || looksLikeSecret(`${key}: ${clean}`) ? WITHHELD : clean;
			} else if (typeof raw === "boolean" || (typeof raw === "number" && Number.isFinite(raw))) {
				out[key] = raw;
			} else return reject("bad fields");
		}
	}
	return { ok: true, event: { id, type, summary: looksLikeSecret(cleanSummary) ? WITHHELD : cleanSummary, fields: out } };
}

/** Parse request or file bytes as JSON. Invalid UTF-8 and oversize input are rejected before parsing. */
export function parseJsonBytes(bytes: Uint8Array): { ok: true; value: unknown } | { ok: false; reason: RejectReason } {
	if (bytes.length > MAX_EVENT_BYTES) return { ok: false, reason: "too large" };
	try {
		return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)) };
	} catch {
		return { ok: false, reason: "malformed json" };
	}
}

// ---- GitHub example adapter --------------------------------------------------------------------

const textOf = (value: unknown, max: number): string | undefined => (typeof value === "string" && value ? capBytes(cleanText(value), max) || undefined : undefined);
const pick = (...values: unknown[]): unknown => values.find(value => value !== undefined && value !== null);

/**
 * Pure mapping from a GitHub webhook (`X-GitHub-Event`, `X-GitHub-Delivery`, JSON body) to the generic shape. Only
 * a whitelist of body fields is read (repository.full_name, action, sender.login, number, title, html_url, each
 * looked up at the top level and under pull_request or issue); anything else in the body is ignored, never
 * forwarded. The result goes through the same strict validation and sanitising as every other event.
 */
export function githubToEvent(headers: { event?: string; delivery?: string }, body: unknown): Parsed {
	if (typeof headers.event !== "string" || !/^[a-z_]{1,32}$/.test(headers.event) || !isPlain(body)) return reject("bad github event");
	const nested = (key: string): Record<string, unknown> => (isPlain(body[key]) ? (body[key] as Record<string, unknown>) : {});
	const pull = nested("pull_request");
	const issue = nested("issue");
	const fields: Record<string, FieldValue> = {};
	const repository = textOf(nested("repository").full_name, MAX_FIELD_VALUE_BYTES);
	const action = textOf(body.action, MAX_FIELD_VALUE_BYTES);
	const sender = textOf(nested("sender").login, MAX_FIELD_VALUE_BYTES);
	const title = textOf(pick(pull.title, issue.title, body.title), 120);
	const number = pick(body.number, pull.number, issue.number);
	const url = pick(pull.html_url, issue.html_url, body.html_url);
	if (repository) fields.repository = repository;
	if (action) fields.action = action;
	if (sender) fields.sender = sender;
	if (typeof number === "number" && Number.isSafeInteger(number) && number >= 0) fields.number = number;
	if (title) fields.title = title;
	if (typeof url === "string" && /^https:\/\/[!-~]{1,112}$/.test(url)) fields.url = url;
	const summary = capBytes(`${headers.event}${action ? ` ${action}` : ""}${repository ? ` in ${repository}` : ""}${sender ? ` by ${sender}` : ""}`, MAX_SUMMARY_BYTES);
	return validateGeneric({ id: headers.delivery, type: `github.${headers.event}`, summary, fields });
}

// ---- HMAC verification -------------------------------------------------------------------------

/**
 * Whether `header` is `sha256=<hex>` of the HMAC-SHA256 of the raw `body` under `secret` (the GitHub scheme). The
 * comparison is constant time; hex case is irrelevant. A missing header, another prefix or a malformed digest fail.
 * `compare` is injectable so tests can prove the constant-time path is the one used.
 */
export function verifySignature(secret: Buffer, body: Uint8Array, header: string | undefined, compare: (a: Buffer, b: Buffer) => boolean = timingSafeEqual): boolean {
	const match = typeof header === "string" ? /^sha256=([0-9a-fA-F]{64})$/.exec(header) : null;
	if (!match) return false;
	const expected = createHmac("sha256", secret).update(body).digest();
	return compare(expected, Buffer.from(match[1], "hex"));
}

// ---- Files owned by the user -------------------------------------------------------------------

/** Open a path for a bounded read of a regular file without following a symlink or blocking on a FIFO. */
export function openRegular(file: string): { fd: number; stat: fs.Stats } | { error: "symlink" | "not a regular file" | "missing" | "unreadable" } {
	let fd: number;
	try {
		fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return { error: code === "ELOOP" ? "symlink" : code === "ENOENT" ? "missing" : code === "ENXIO" ? "not a regular file" : "unreadable" };
	}
	const stat = fs.fstatSync(fd);
	if (!stat.isFile()) {
		fs.closeSync(fd);
		return { error: "not a regular file" };
	}
	return { fd, stat };
}

/** Read at most `max` bytes from `fd` from the start. */
export function readBounded(fd: number, max: number): Buffer {
	const buffer = Buffer.alloc(max);
	const size = fs.readSync(fd, buffer, 0, max, 0);
	return buffer.subarray(0, size);
}

const currentUid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);

/**
 * Read a webhook secret from `file`. The file must be absolute, a regular file (never a symlink or FIFO), owned by
 * the user and readable by nobody else (mode 0600 or stricter), and hold 16 to 256 bytes once one trailing newline
 * is removed. The secret is returned to the caller only; no message ever contains it.
 */
export function readSecretFile(file: string, uid: number | undefined = currentUid()): { ok: true; secret: Buffer } | { ok: false; error: string } {
	if (!file || file.length > 512 || !file.startsWith("/") || /[\p{Cc}\p{Cf}\s]/u.test(file)) return { ok: false, error: "secret file path must be an absolute path without spaces or control characters" };
	const opened = openRegular(file);
	if ("error" in opened) return { ok: false, error: opened.error === "symlink" ? "secret file is a symlink; refusing to read it" : opened.error === "missing" ? "secret file does not exist" : opened.error === "unreadable" ? "secret file cannot be read" : "secret file is not a regular file" };
	try {
		if (uid !== undefined && opened.stat.uid !== uid) return { ok: false, error: "secret file is not owned by the user running this session" };
		if ((opened.stat.mode & 0o177) !== 0) return { ok: false, error: "secret file must be mode 0600 or stricter (readable by its owner only); run chmod 600 on it" };
		if (opened.stat.size > MAX_SECRET_BYTES + 2) return { ok: false, error: `secret file is larger than ${MAX_SECRET_BYTES} bytes` };
		let bytes = readBounded(opened.fd, MAX_SECRET_BYTES + 3);
		if (bytes.at(-1) === 0x0a) bytes = bytes.subarray(0, bytes.at(-2) === 0x0d ? -2 : -1);
		if (bytes.length < MIN_SECRET_BYTES || bytes.length > MAX_SECRET_BYTES) return { ok: false, error: `secret must be ${MIN_SECRET_BYTES} to ${MAX_SECRET_BYTES} bytes` };
		return { ok: true, secret: Buffer.from(bytes) };
	} finally {
		fs.closeSync(opened.fd);
	}
}
