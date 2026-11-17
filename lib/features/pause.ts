// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

/**
 * Explicit, persisted pause for a logical session, and the one wake gate that enforces it.
 *
 * Pause state is keyed by the stable peer id in `~/.omp/agent/peer-state/pause.json`, so a restart
 * of the same session is still paused. Each pause records WHO paused (`by`): the session's own user, the
 * master, or the restart rule. That record is what the resume rule is enforced from: the master may clear
 * only a pause it set itself; every other pause is cleared by the session's own user with `/peers resume`.
 * The receiving session applies `wakeGate` to every inbound request, so every sender (master dispatch,
 * peers_send, the completion watcher, future digests, adapters and triggers) is held by the same decision table.
 */
import * as path from "node:path";
import type { FeatureHost } from "./host";
import type { Feature } from "./index";
import { screenText } from "./rules";
import { readState, stateRoot, updateState } from "./store";

/** Who paused a session. `restart` is set by the restart rule (see `restartDecision`), never by a request. */
export type PauseBy = "user" | "master" | "restart";
const PAUSE_BY: readonly PauseBy[] = ["user", "master", "restart"];

export interface PauseEntry {
	/** Epoch milliseconds when the pause began. */
	since: number;
	/** Who paused. Entries written by older versions (no `by`, or a peer id) read as `user`, so only the session's own user can resume them. */
	by: PauseBy;
	/** Optional single-line note (at most MAX_REASON characters); stored locally, never published to the registry. */
	reason?: string;
}

export interface PauseState {
	version: 1;
	sessions: Record<string, PauseEntry>;
}

/** What the gate needs to know. `since` etc. are present only when the state came from a readable file. */
export interface PauseView {
	paused: boolean;
	since?: number;
	by?: PauseBy;
	reason?: string;
	/** Set when the state file could not be read; the session is then treated as paused (fail closed). */
	error?: string;
}

export const MAX_REASON = 120;
/** Longest `by` text accepted from the file: an older version stored a peer id (at most 17 bytes) there. */
export const MAX_BY_BYTES = 64;
/** Reason recorded by the restart rule. */
export const RESTART_REASON = "not working for the master before the restart";
const PEER_ID_RE = /^p(?:[0-9a-f]{6}|[0-9a-f]{16})$/;

/**
 * Ops that never start an agent turn and stay available while paused. `compact` is here on purpose:
 * it makes one summarisation request over the session's own history and does not start a turn or
 * deliver any peer content. `pause` and `resume` are listed so the table is the whole truth; the receiver
 * still requires the master for both, and `resume` additionally only clears a pause the master set itself.
 */
export const NON_WAKE_OPS: readonly string[] = [
	"status", "tail", "abort", "rename", "compact", "model", "effort", "subagents", "setting", "shutdown", "pause", "resume",
];

export const PAUSED_ERROR = "session is paused";

export type PausedRefusal = {
	ok: false;
	/** `deferred`: informational traffic the sender may retry after resume. `refused`: a dispatch that is not retained anywhere. */
	status: "deferred" | "refused";
	paused: true;
	error: typeof PAUSED_ERROR;
};
export type GateDecision = { allow: true } | { allow: false; result: PausedRefusal };

/**
 * The decision table, as a pure function. While paused:
 * - `message` is deferred and every other op that is not in NON_WAKE_OPS is refused, so an op this table
 *   has never heard of (a future trigger or adapter) fails closed instead of waking the session;
 * - NON_WAKE_OPS pass.
 * When not paused every op passes.
 */
export function wakeGate(view: Pick<PauseView, "paused">, op: string): GateDecision {
	if (!view.paused || NON_WAKE_OPS.includes(op)) return { allow: true };
	return { allow: false, result: { ok: false, status: op === "message" ? "deferred" : "refused", paused: true, error: PAUSED_ERROR } };
}

export const pauseFile = (home: string) => path.join(stateRoot(home), "pause.json");

const emptyState = (): PauseState => ({ version: 1, sessions: {} });

interface RawEntry {
	since?: unknown;
	by?: unknown;
	reason?: unknown;
}

function validateState(value: unknown): PauseState {
	const state = value as { version?: unknown; sessions?: unknown } | null;
	if (!state || typeof state !== "object" || state.version !== 1) throw new Error("unsupported version (expected 1)");
	const raw = state.sessions;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("malformed fields");
	const sessions: Record<string, PauseEntry> = {};
	for (const [id, entry] of Object.entries(raw)) {
		const e: RawEntry | null = entry;
		if (!PEER_ID_RE.test(id) || !e || typeof e !== "object" || typeof e.since !== "number" || !Number.isFinite(e.since)) throw new Error("malformed pause entry");
		if (e.by !== undefined && (typeof e.by !== "string" || Buffer.byteLength(e.by) > MAX_BY_BYTES)) throw new Error("malformed pause entry");
		if (e.reason !== undefined && (typeof e.reason !== "string" || e.reason.length > MAX_REASON)) throw new Error("malformed pause entry");
		// Anything that is not a known provenance (no field, or the peer id an older version stored) is the user's: only the user may resume it.
		sessions[id] = { since: e.since, by: PAUSE_BY.find(known => known === e.by) ?? "user", ...(e.reason === undefined ? {} : { reason: e.reason }) };
	}
	return { version: 1, sessions };
}

/**
 * Current pause state of `peerId`, read fresh from disk. An unreadable or invalid file is treated as
 * paused: when the state is unknown nothing may be woken. A missing file means not paused.
 */
export function readPause(home: string, peerId: string): PauseView {
	try {
		const entry = readState(pauseFile(home), emptyState, validateState).sessions[peerId];
		return entry ? { paused: true, since: entry.since, by: entry.by, reason: entry.reason } : { paused: false };
	} catch (error) {
		return { paused: true, error: (error as Error).message };
	}
}

export function normalizeReason(raw: string): { reason?: string; error?: string } {
	const reason = raw.replace(/\s+/g, " ").trim();
	if (!reason) return {};
	if (reason.length > MAX_REASON) return { error: `reason is longer than ${MAX_REASON} characters` };
	if (/[\p{Cc}\p{Cf}]/u.test(reason)) return { error: "reason contains control characters" };
	if (screenText(reason)) return { error: "reason looks like a credential or token; describe it instead of including it" };
	return { reason };
}

export type PauseResult = { ok: true; entry: PauseEntry; already: boolean; upgraded: boolean } | { ok: false; error: string };

/**
 * Pause `peerId`. Already paused: nothing changes (the original start time and reason stay), with one exception:
 * the user pausing a session the master paused takes the pause over (`by` becomes `user`, `upgraded` is true), so
 * the master can no longer clear it. A pause by the master or the restart rule never changes an existing entry.
 */
export async function pauseSession(home: string, peerId: string, by: PauseBy, now: number, rawReason = ""): Promise<PauseResult> {
	if (!PEER_ID_RE.test(peerId)) return { ok: false, error: "session identity unavailable" };
	const { reason, error } = normalizeReason(rawReason);
	if (error) return { ok: false, error };
	return updateState<PauseState, PauseResult>(pauseFile(home), emptyState, validateState, current => {
		const existing = current.sessions[peerId];
		if (existing) {
			if (by !== "user" || existing.by !== "master") return { result: { ok: true, entry: existing, already: true, upgraded: false } };
			const entry: PauseEntry = { ...existing, by: "user" };
			return { state: { ...current, sessions: { ...current.sessions, [peerId]: entry } }, result: { ok: true, entry, already: true, upgraded: true } };
		}
		const entry: PauseEntry = { since: now, by, ...(reason ? { reason } : {}) };
		return { state: { ...current, sessions: { ...current.sessions, [peerId]: entry } }, result: { ok: true, entry, already: false, upgraded: false } };
	});
}

/** The receiver's refusal of a resume request that a subagent sent (a claim set by the sender's tool; resume is never a subagent action). */
export const SUBAGENT_RESUME_ERROR = "resume is not available to subagents";

/** Fixed refusals naming who may resume, by the provenance of the pause that stays. */
export const RESUME_REFUSED: Record<Exclude<PauseBy, "master">, string> = {
	user: "paused by its user: only that user can resume it with /peers resume",
	restart: "paused after a restart because it was idle: only its user can resume it",
};

export type ResumeResult = { ok: true; cleared?: PauseEntry } | { ok: false; error: string };

/** Who is resuming. The master's request is only honoured while `stillAuthorized` (checked inside the locked update) returns undefined; otherwise its text is the refusal. */
export type ResumeCaller = "user" | { stillAuthorized: () => string | undefined };

/**
 * Resume `peerId`. The session's own user clears any pause. The master clears only an entry whose provenance is
 * `master`; any other entry stays and the fixed refusal says who may resume it. Not paused: `ok` with nothing
 * cleared. The decision runs under the state lock, so a user pause that lands first always wins, and the master's
 * authority is re-read there, so a handoff or lock that happened while the call waited for the lock is honoured.
 */
export async function resumeSession(home: string, peerId: string, caller: ResumeCaller): Promise<ResumeResult> {
	return updateState<PauseState, ResumeResult>(pauseFile(home), emptyState, validateState, current => {
		// The master's authority is re-read here, under the lock: a handoff or lock that happened while this call waited for it is honoured.
		const denied = caller === "user" ? undefined : caller.stillAuthorized();
		if (denied) return { result: { ok: false, error: denied } };
		const entry = current.sessions[peerId];
		if (!entry) return { result: { ok: true } };
		if (caller !== "user" && entry.by !== "master") return { result: { ok: false, error: RESUME_REFUSED[entry.by] } };
		const rest = { ...current.sessions };
		delete rest[peerId];
		return { state: { ...current, sessions: rest }, result: { ok: true, cleared: entry } };
	});
}

const RESUME_HINT: Record<PauseBy, string> = {
	user: "paused by its user: only its user can resume it",
	restart: "paused after a restart: only its user can resume it",
	master: "paused by the master: the master or its user can resume it",
};
/** Shown when who paused the session is not known (a registry flag without the pause file, an unreadable file). */
export const NEUTRAL_RESUME_HINT = "resume policy: see /peers pause status";

/** Who may resume a session paused by `by`; neutral text when that is not known. */
export const resumeHintFor = (by: PauseBy | undefined): string => (by ? RESUME_HINT[by] : NEUTRAL_RESUME_HINT);

/** Who may resume `peerId`, from the pause file read fresh; neutral text when it is not paused or cannot be read. Never wakes anything. */
export const resumeHint = (home: string, peerId: string): string => resumeHintFor(readPause(home, peerId).by);

// ---- Restart rule -------------------------------------------------------------------------------

/** What a session records about its last run so the next start can tell a blackout from a clean exit. */
export interface SavedRun {
	/** True when the previous process shut down cleanly, false while it ran. Absent on files from older versions. */
	clean?: unknown;
	/** True when, at its last save, a turn started by a master request was running. */
	managed?: unknown;
}

/**
 * The restart rule, as a pure function: `pause` only for a session whose previous run did not end cleanly
 * (`clean === false`), that was not working under the master's management, and that is not already paused.
 * No saved record (a new session), a clean exit, a record from an older version (no `clean`), a managed
 * session (the master may continue it) and an existing pause (its provenance stays) all give `none`.
 */
export function restartDecision(saved: SavedRun | undefined, current: Pick<PauseView, "paused">): "pause" | "none" {
	if (!saved || saved.clean !== false || saved.managed === true || current.paused) return "none";
	return "pause";
}

/** Pause an unclean-restart session on behalf of the restart rule; an existing pause is left as it is. */
export const pauseAfterRestart = (home: string, peerId: string, now: number): Promise<PauseResult> => pauseSession(home, peerId, "restart", now, RESTART_REASON);

/** The one line shown to the session's user at start, never sent to another session. */
export const restartNotice = (name: string, id: string): string =>
	`${name} (${id}) was paused automatically: the previous run did not shut down cleanly and the session was not working for the master. Nothing automatic can wake it and the master cannot resume it; run /peers resume to continue`;

// ---- Commands (act on this session; the user typing here is the authorization) ----------------

const WHAT = "wake-triggering messages and prompts are refused until /peers resume; a running turn is not interrupted (abort is separate)";

const WHO: Record<PauseBy, string> = {
	user: "its user",
	master: "the master",
	restart: "the restart rule",
};
const RESUMABLE_BY: Record<PauseBy, string> = {
	master: "the master (/peers do <peer> resume) or its user (/peers resume)",
	user: "only its user (/peers resume)",
	restart: "only its user (/peers resume)",
};

function pauseStatus(host: FeatureHost): string {
	const self = host.self();
	const view = readPause(host.home, self.id);
	if (view.error) return `pause state unreadable (${view.error}); ${self.name} (${self.id}) is treated as paused until the file is fixed`;
	if (!view.paused || !view.by || view.since === undefined) return `${self.name} (${self.id}) is not paused`;
	const note = view.reason ? ` (${view.reason})` : "";
	return `${self.name} (${self.id}) is paused since ${new Date(view.since).toISOString()} by ${WHO[view.by]}${note}; resumable by ${RESUMABLE_BY[view.by]}`;
}

async function pauseCommand(args: string[], host: FeatureHost): Promise<string> {
	if (args.length === 1 && args[0] === "status") return pauseStatus(host);
	const self = host.self();
	try {
		const result = await pauseSession(host.home, self.id, "user", host.now(), args.join(" "));
		if (!result.ok) return `error: ${result.error}`;
		const note = result.entry.reason ? ` (${result.entry.reason})` : "";
		if (result.upgraded) return `${self.name} (${self.id}) was paused by the master and is now paused by its user${note}: only /peers resume clears it`;
		return result.already
			? `${self.name} (${self.id}) is already paused since ${new Date(result.entry.since).toISOString()} by ${WHO[result.entry.by]}${note}; use /peers resume to clear it`
			: `paused ${self.name} (${self.id})${note}: ${WHAT}`;
	} catch (error) {
		return `error: ${(error as Error).message}`;
	}
}

async function resumeCommand(args: string[], host: FeatureHost): Promise<string> {
	if (args.length) return "usage: /peers resume";
	const self = host.self();
	try {
		const result = await resumeSession(host.home, self.id, "user");
		if (!result.ok) return `error: ${result.error}`;
		return result.cleared
			? `resumed ${self.name} (${self.id}) (it was paused by ${WHO[result.cleared.by]}): wake-triggering messages and prompts are accepted again`
			: `${self.name} (${self.id}) is not paused`;
	} catch (error) {
		return `error: ${(error as Error).message}`;
	}
}

export const pause: Feature = {
	name: "pause",
	command: pauseCommand,
};

export const resume: Feature = {
	name: "resume",
	command: resumeCommand,
};
