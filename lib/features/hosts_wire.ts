// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

/**
 * Wire format and limits shared by the local `/peers hosts` client and the remote bridge
 * (`scripts/omp-peers-remote.ts`). Pure validation plus the per-machine host label; no network.
 */
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { foldAll, foldTokens, neutralize } from "./events-ingest";
import { looksLikeSecret } from "./secrets";
import { stateRoot, updateState } from "./store";

export const BRIDGE_VERSION = 1;
/** The only remote command argument the client sends. A restricted authorized_keys line ignores it; an unrestricted account just fails to find it. */
export const BRIDGE_COMMAND = "omp-peers-remote";

export const MAX_HOSTS = 16;
export const MAX_TEXT_BYTES = 4000;
export const MAX_NAME_BYTES = 40;
export const MAX_REQUEST_BYTES = 64 * 1024;
export const STDIN_TIMEOUT_MS = 5_000;
export const SKEW_MS = 5 * 60_000;
export const REPLAY_TTL_MS = 10 * 60_000;
export const REPLAY_MAX = 2000;
export const MAX_SESSIONS_LISTED = 64;

export const PEER_ID_RE = /^p(?:[0-9a-f]{6}|[0-9a-f]{16})$/;
export const HOST_ID_RE = /^[0-9a-f]{16}$/;
export const REQUEST_ID_RE = /^[0-9a-f]{32}$/;
export const HOST_NAME_RE = /^[a-z0-9-]{1,24}$/;
/** A remote sender id as the receiving session sees it: `<origin label>:<sender's own stable id>`. A claim, never authentication. */
const REMOTE_SENDER_RE = /^host-[0-9a-f]{8}:p(?:[0-9a-f]{6}|[0-9a-f]{16})$/;

/** Operations a remote request may name. Everything else is refused with `operation not allowed` before any session is touched. */
export const REMOTE_OPS = ["hello", "list", "message"] as const;
export type RemoteOp = (typeof REMOTE_OPS)[number];

/** Every error text a bridge reply may carry. The local side accepts only these; anything else is `unrecognized`. */
export const REASONS = [
	"bad request",
	"unsupported version",
	"hops not zero",
	"request too large",
	"request timed out",
	"stale or future timestamp",
	"duplicate request",
	"replay cache full",
	"operation not allowed",
	"host identity mismatch",
	"message too large",
	"session offline",
	"session unreachable",
	"session paused",
	"session refuses inbound",
	"session rate limited",
	"delivery unknown",
	"delivery failed",
	"relayed message refused",
	"bridge unavailable",
] as const;
export type Reason = (typeof REASONS)[number];
export const isReason = (value: unknown): value is Reason => typeof value === "string" && (REASONS as readonly string[]).includes(value);

const CONTROL_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** `text` cut to at most `max` UTF-8 bytes at a code point boundary. */
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

/** A name with control/format characters turned to spaces, `"`, `[` and `]` (which could fake a message header) turned to `'` and whitespace collapsed; not yet cut. */
function normaliseName(raw: string): string {
	return raw.replace(CONTROL_CHARS, " ").replace(/["[\]]/g, "'").replace(/\s+/g, " ").trim();
}

/** A display name from another machine: see `normaliseName`, then at most MAX_NAME_BYTES bytes. */
export function cleanName(raw: string): string {
	return capBytes(normaliseName(raw), MAX_NAME_BYTES).trim() || "unnamed";
}

/** Shown instead of a name that looks like a credential. */
export const WITHHELD = "[withheld]";

/**
 * `cleanName`, except that a name which looks like a credential becomes WITHHELD. The credential screen sees every form of the
 * WHOLE name BEFORE the byte cap: the raw text, its whitespace-collapsed form and the fully cleaned form (cleaning turns `[`
 * into `'`, which can complete a pattern such as `[token]=...`), so a secret that straddles the cut is still caught. The
 * placeholder itself maps to itself.
 */
export function safeName(raw: string): string {
	if (raw === WITHHELD) return WITHHELD;
	const cleaned = normaliseName(raw);
	const forms = [raw, raw.replace(CONTROL_CHARS, " ").replace(/\s+/g, " "), cleaned];
	if (forms.some(looksLikeSecret)) return WITHHELD;
	const shown = cleanName(raw);
	return looksLikeSecret(shown) ? WITHHELD : shown;
}

const HEADER_WORDS = ["message", "from", "peer", "session"];
const hasHeaderWords = (tokens: string[]): boolean => tokens.some((_, i) => HEADER_WORDS.every((word, k) => tokens[i + k] === word));
/** `[external event`, the delivery prefix of the events feature, with any run of `[` allowed between its letters (squashed text keeps only `[`, letters and digits). */
const EVENT_PREFIX = new RegExp(`\\[${[..."externalevent"].join("\\[*")}`);

/**
 * Whether `text` contains a header a receiving session puts on a message it delivers, however it is dressed: the peer-message
 * header's words `Message from peer session` in order, or the events delivery prefix `[external event`. Tolerated: any case,
 * spacing, punctuation; zero-width, soft-hyphen and other format characters; full-width forms, accents and look-alike letters
 * (Cyrillic, Greek, dotless i); markdown or HTML that renders to the words (`p[e]()er`, `[peer](url)`, `pe<i></i>er`); and stray
 * brackets anywhere inside or between the words (`[Mes[sage from peer session`). The text is folded in several ways: as written,
 * with markdown rendered as plain text, and with format characters deleted (they join letters) or turned to spaces (they separate
 * words), brackets kept, deleted or turned to spaces. Words are matched whole, so identifiers such as
 * `message_from_peer_session_count` or `messageFromPeerSession` are not the header; prose that contains the four words in a row is
 * refused too. The text that is sent or delivered is always the original.
 */
export function hasPeerMessageMarker(text: string): boolean {
	const bare = text.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ");
	for (const variant of [bare.replace(/\p{Cf}/gu, ""), bare.replace(/\p{Cf}/gu, " ")]) {
		for (const base of [variant, neutralize(variant)]) {
			if (EVENT_PREFIX.test(foldAll(base))) return true;
			for (const form of [base, base.replace(/[[\]］［]/g, ""), base.replace(/[[\]］［]/g, " ")]) if (hasHeaderWords(foldTokens(form))) return true;
		}
	}
	return false;
}

/** The label a machine puts in front of its sessions' ids: derived from its host id, so the claimed label and id cannot disagree. */
export const hostLabel = (hostId: string): string => `host-${hostId.slice(0, 8)}`;

export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Whether `value` has exactly the keys in `allowed` (extras are errors; `optional` keys may be absent). */
export function hasOnlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
	const keys = Object.keys(value);
	return required.every(key => Object.hasOwn(value, key)) && keys.every(key => required.includes(key) || optional.includes(key));
}

export interface RemoteSender {
	id: string;
	name: string;
}

/**
 * The receiving session's check of a message that arrived through the bridge. Remote-origin messages are
 * informational only: they carry `hops: 1`, a `<label>:<id>` sender and nothing that could trigger work
 * (no report, dependency flag, subagent flag or audit request id).
 */
export function readRemoteMessage(req: { from?: unknown; hops?: unknown; report?: unknown; dependency?: unknown; subagent?: unknown; request?: unknown; event?: unknown; text?: unknown }):
	{ ok: true; from: RemoteSender } | { ok: false; error: string } {
	if (req.hops !== 1) return { ok: false, error: "remote message must carry hops 1" };
	if (req.report !== undefined || req.dependency !== undefined || req.subagent !== undefined || req.request !== undefined || req.event !== undefined) {
		return { ok: false, error: "remote messages cannot be reports, dependency triggers or control requests" };
	}
	if (typeof req.text !== "string" || Buffer.byteLength(req.text) > MAX_TEXT_BYTES) return { ok: false, error: `remote message text is longer than ${MAX_TEXT_BYTES} bytes` };
	if (hasPeerMessageMarker(req.text)) return { ok: false, error: "remote message text is itself a peer message" };
	const from = req.from;
	if (!isRecord(from) || typeof from.id !== "string" || typeof from.name !== "string" || !REMOTE_SENDER_RE.test(from.id) || (from.name !== WITHHELD && (cleanName(from.name) !== from.name || looksLikeSecret(from.name)))) {
		return { ok: false, error: "remote message has an invalid sender" };
	}
	return { ok: true, from: { id: from.id, name: from.name } };
}

// ---- This machine's host id --------------------------------------------------------------------

interface HostIdState {
	version: 1;
	hostId?: string;
}

export const hostIdFile = (home: string) => path.join(stateRoot(home), "host-id.json");

function validateHostId(value: unknown): HostIdState {
	if (!isRecord(value) || value.version !== 1 || !hasOnlyKeys(value, ["version"], ["hostId"])) throw new Error("malformed fields");
	if (value.hostId !== undefined && !(typeof value.hostId === "string" && HOST_ID_RE.test(value.hostId))) throw new Error("malformed host id");
	return value as unknown as HostIdState;
}

/**
 * This machine's host id: 16 random hex characters generated once and kept in `peer-state/host-id.json` (0600).
 * It is a label that lets a peer notice that a destination changed; it is not a secret and proves nothing by itself.
 */
export async function ensureHostId(home: string): Promise<string> {
	return updateState<HostIdState, string>(hostIdFile(home), () => ({ version: 1 }), validateHostId, current => {
		if (current.hostId) return { result: current.hostId };
		const hostId = randomBytes(8).toString("hex");
		return { state: { version: 1, hostId }, result: hostId };
	});
}
