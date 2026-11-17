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
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
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

/**
 * Look-alike letters (Cyrillic, Greek, dotless/dotted i and a few more) folded to Latin; NFKD already folds full-width and accented
 * forms. Shared by every reserved-text check (events content, peer-message headers relayed through `/peers hosts`).
 */
export const CONFUSABLES: Record<string, string> = {
	"а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "і": "i", "ј": "j", "у": "y", "х": "x", "ѕ": "s", "һ": "h", "ԁ": "d", "ԛ": "q", "ԝ": "w",
	"α": "a", "ε": "e", "ο": "o", "ρ": "p", "ι": "i", "ν": "v", "υ": "u", "κ": "k", "τ": "t", "η": "n", "χ": "x", "β": "b", "ɡ": "g", "ӏ": "l",
	"μ": "m", "м": "m", "ԍ": "g", "ɑ": "a", "г": "r",
	// Dotless and other i look-alikes (a capital dotted İ decomposes to I plus a mark, which is stripped).
	"ı": "i", "ɩ": "i", "ɪ": "i", "ǐ": "i", "ⅰ": "i", "ꭵ": "i",
};
/** Lower-case, strip accents and fold look-alikes. */
const foldLetters = (text: string): string => [...text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()].map(char => CONFUSABLES[char] ?? char).join("");
/**
 * The words of `text` as lower-case Latin tokens: accents stripped, look-alikes folded, anything but letters, digits and `_`
 * a separator. Underscores keep identifiers whole, so `message_from_peer_session_count` and `messageFromPeerSession` are one
 * token each and never read as the four words `message from peer session`.
 */
export const foldTokens = (text: string): string[] => foldLetters(text).split(/[^a-z0-9_]+/).filter(Boolean);
const RESERVED_PHRASES = [DELIVERY_PREFIX, "event work dispatch", "authorized by the user"];
/** Lower-case, strip accents, fold look-alikes and drop everything but letters and digits: spacing, punctuation and zero-width tricks vanish. */
export const foldAll = (text: string): string => foldLetters(text).replace(/[^a-z0-9[]/g, "");
/** Same, without the opening bracket: brackets inside a phrase must not break its match. */
const foldPlain = (text: string): string => foldAll(text).replace(/\[/g, "");
// The delivery prefix keeps its `[` (plain "external event" is ordinary text); the other phrases ignore brackets altogether.
const FOLDED_RESERVED: Array<[string, boolean]> = RESERVED_PHRASES.map((phrase, index) => [index === 0 ? foldAll(phrase) : foldPlain(phrase), index === 0]);
/** Whether `text` contains a phrase the plugin's own frames start with or use to claim authority; such text is never accepted as event content. */
const containsReserved = (text: string): boolean => {
	const all = foldAll(text);
	const plain = foldPlain(text);
	return FOLDED_RESERVED.some(([phrase, bracketed]) => (bracketed ? all : plain).includes(phrase));
};

/**
 * Render markdown and HTML structure as plain text, so event content can neither hide a reserved phrase behind link
 * syntax nor reach the receiving model as a clickable link, image, code fence or emphasis: `[text](url)` and
 * `[text][ref]` become `text`, HTML tags and comments vanish, backslash escapes are resolved, and backticks, `*`, `~` and
 * emphasis underscores at word edges are removed (snake_case words keep theirs). It repeats until nothing changes any
 * more, however deeply the constructs are nested. That terminates: every round that changes the text removes
 * characters (whitespace is already collapsed on input), so a text of n characters takes at most n + 1 rounds; the loop
 * is bounded by exactly that. Applying it to its own output changes nothing.
 */
export function neutralize(text: string): string {
	let current = text;
	for (let round = 0; round <= text.length + 1; round++) {
		const next = current
			.replace(/<[^>\n]*>/g, "")
			.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
			.replace(/\\([!-/:-@[-`{-~])/g, "$1")
			.replace(/[`*~]/g, "")
			.replace(/(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])/g, "")
			.replace(/\s+/g, " ")
			.trim();
		if (next === current) return next;
		current = next;
	}
	return current;
}

/** The text the receiving session sees for one content string: control characters and ANSI gone, markdown neutralised. */
const content = (raw: string): string => neutralize(cleanText(raw));

/** A reserved phrase in `text` as written or once markdown is rendered as plain text. */
export const hasReserved = (text: string): boolean => containsReserved(text) || containsReserved(neutralize(text));

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
	if (hasReserved(id) || hasReserved(type)) return reject("reserved text");
	if (typeof summary !== "string" || !summary || Buffer.byteLength(summary) > MAX_SUMMARY_BYTES) return reject("bad summary");
	if (hasReserved(cleanText(summary))) return reject("reserved text");
	const cleanSummary = content(summary);
	if (!cleanSummary) return reject("bad summary");
	const out: Record<string, FieldValue> = {};
	if (fields !== undefined) {
		if (!isPlain(fields)) return reject("bad fields");
		const entries = Object.entries(fields);
		if (entries.length > MAX_FIELDS) return reject("bad fields");
		for (const [key, raw] of entries) {
			if (!KEY_RE.test(key)) return reject("bad fields");
			if (hasReserved(key)) return reject("reserved text");
			if (typeof raw === "string") {
				if (!raw || Buffer.byteLength(raw) > MAX_FIELD_VALUE_BYTES) return reject("bad fields");
				if (hasReserved(cleanText(raw))) return reject("reserved text");
				const clean = content(raw);
				if (!clean) return reject("bad fields");
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

/** Payload shape -> GitHub event name, in priority order. The type comes from the SIGNED body, never from a header. */
const GITHUB_KINDS: Array<[(body: Record<string, unknown>) => boolean, string]> = [
	// Most specific first: a payload often carries the objects of the more general kinds (a deployment_status holds a
	// deployment and often a workflow_run; a review thread holds a pull_request).
	// `since` is required on every deployment_review and appears in no other event. Keyed on it alone: GitHub documents
	// `workflow_run` as an object or null there, and `reviewers` is optional on approved/rejected.
	[b => typeof b.since === "string", "deployment_review"],
	[b => isPlain(b.deployment_status), "deployment_status"],
	// A workflow_job for a job that deploys carries a top-level `deployment`: it stays a workflow_job.
	[b => isPlain(b.workflow_job), "workflow_job"],
	[b => isPlain(b.deployment), "deployment"],
	[b => isPlain(b.pull_request) && isPlain(b.thread), "pull_request_review_thread"],
	[b => isPlain(b.pull_request) && isPlain(b.review), "pull_request_review"],
	[b => isPlain(b.pull_request) && isPlain(b.comment), "pull_request_review_comment"],
	[b => isPlain(b.pull_request), "pull_request"],
	[b => isPlain(b.issue) && isPlain(b.comment), "issue_comment"],
	[b => isPlain(b.issue), "issues"],
	[b => isPlain(b.discussion) && isPlain(b.comment), "discussion_comment"],
	[b => isPlain(b.discussion), "discussion"],
	[b => isPlain(b.workflow_run), "workflow_run"],
	[b => isPlain(b.check_run), "check_run"],
	[b => isPlain(b.check_suite), "check_suite"],
	[b => isPlain(b.release), "release"],
	[b => typeof b.ref === "string" && Array.isArray(b.commits) && isPlain(b.pusher), "push"],
	[b => typeof b.zen === "string" && b.hook_id !== undefined, "ping"],
];

/**
 * Pure mapping from a signed GitHub webhook body to the generic shape. NOTHING unsigned is used: the event id is a
 * hash of the raw signed bytes (so a replayed or re-delivered body is a duplicate, and altering `X-GitHub-Delivery`
 * or `X-GitHub-Event` can neither burn another event's id nor change its type), and the type is derived from the
 * body's own structure (`github.<kind>`, or `github.event` when the shape is not recognised). Only a whitelist of body
 * fields is read (repository.full_name, action, sender.login, number, title, html_url, each looked up at the top
 * level and under pull_request or issue); anything else in the body is ignored, never forwarded. The result goes
 * through the same strict validation and sanitising as every other event.
 */
export function githubToEvent(body: unknown, raw: Uint8Array): Parsed {
	if (!isPlain(body)) return reject("bad github event");
	const kind = GITHUB_KINDS.find(([matches]) => matches(body))?.[1] ?? "event";
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
	const summary = capBytes(`${kind}${action ? ` ${action}` : ""}${repository ? ` in ${repository}` : ""}${sender ? ` by ${sender}` : ""}`, MAX_SUMMARY_BYTES);
	return validateGeneric({ id: `gh-${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`, type: `github.${kind}`, summary, fields });
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
