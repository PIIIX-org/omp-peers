// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

/**
 * Explicit, persisted pause for a logical session, and the one wake gate that enforces it.
 *
 * Pause state is keyed by the stable peer id in `~/.omp/agent/peer-state/pause.json`, so a restart
 * of the same session is still paused. Only an explicit resume removes an entry. The receiving
 * session applies `wakeGate` to every inbound request, so every sender (master dispatch, peers_send,
 * the completion watcher, future digests, adapters and triggers) is held by the same decision table.
 */
import * as path from "node:path";
import type { FeatureHost } from "./host";
import type { Feature } from "./index";
import { screenText } from "./rules";
import { readState, stateRoot, updateState } from "./store";

export interface PauseEntry {
	/** Epoch milliseconds when the pause began. */
	since: number;
	/** Peer id that requested the pause: the session itself, or the master that paused it. */
	by: string;
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
	by?: string;
	reason?: string;
	/** Set when the state file could not be read; the session is then treated as paused (fail closed). */
	error?: string;
}

export const MAX_REASON = 120;
const PEER_ID_RE = /^p(?:[0-9a-f]{6}|[0-9a-f]{16})$/;

/**
 * Ops that never start an agent turn and stay available while paused. `compact` is here on purpose:
 * it makes one summarisation request over the session's own history and does not start a turn or
 * deliver any peer content. `pause` is listed so the table is the whole truth; the receiver still
 * requires the master for it. `resume` is deliberately not an op: it is only the local command.
 */
export const NON_WAKE_OPS: readonly string[] = [
	"status", "tail", "abort", "rename", "compact", "model", "effort", "subagents", "setting", "shutdown", "pause",
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

function validateState(value: unknown): PauseState {
	const state = value as Partial<PauseState> | null;
	if (!state || typeof state !== "object" || state.version !== 1) throw new Error("unsupported version (expected 1)");
	const sessions = state.sessions as Record<string, PauseEntry> | undefined;
	if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) throw new Error("malformed fields");
	for (const [id, entry] of Object.entries(sessions)) {
		const ok = PEER_ID_RE.test(id) && entry && typeof entry === "object" && typeof entry.since === "number" && Number.isFinite(entry.since) &&
			typeof entry.by === "string" && (entry.reason === undefined || (typeof entry.reason === "string" && entry.reason.length <= MAX_REASON));
		if (!ok) throw new Error("malformed pause entry");
	}
	return state as PauseState;
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

export type PauseResult = { ok: true; entry: PauseEntry; already: boolean } | { ok: false; error: string };

/** Pause `peerId`. Already paused: nothing changes (the original start time and reason stay). */
export async function pauseSession(home: string, peerId: string, by: string, now: number, rawReason = ""): Promise<PauseResult> {
	if (!PEER_ID_RE.test(peerId)) return { ok: false, error: "session identity unavailable" };
	const { reason, error } = normalizeReason(rawReason);
	if (error) return { ok: false, error };
	return updateState<PauseState, PauseResult>(pauseFile(home), emptyState, validateState, current => {
		const existing = current.sessions[peerId];
		if (existing) return { result: { ok: true, entry: existing, already: true } };
		const entry: PauseEntry = { since: now, by, ...(reason ? { reason } : {}) };
		return { state: { ...current, sessions: { ...current.sessions, [peerId]: entry } }, result: { ok: true, entry, already: false } };
	});
}

/** Resume `peerId`; reports the entry that was cleared, or undefined when it was not paused. */
export async function resumeSession(home: string, peerId: string): Promise<{ cleared?: PauseEntry }> {
	return updateState<PauseState, { cleared?: PauseEntry }>(pauseFile(home), emptyState, validateState, current => {
		const entry = current.sessions[peerId];
		if (!entry) return { result: {} };
		const rest = { ...current.sessions };
		delete rest[peerId];
		return { state: { ...current, sessions: rest }, result: { cleared: entry } };
	});
}

// ---- Commands (act on this session; the user typing here is the authorization) ----------------

const WHAT = "wake-triggering messages and prompts are refused until /peers resume; a running turn is not interrupted (abort is separate)";

async function pauseCommand(args: string[], host: FeatureHost): Promise<string> {
	const self = host.self();
	try {
		const result = await pauseSession(host.home, self.id, self.id, host.now(), args.join(" "));
		if (!result.ok) return `error: ${result.error}`;
		const note = result.entry.reason ? ` (${result.entry.reason})` : "";
		return result.already
			? `${self.name} (${self.id}) is already paused since ${new Date(result.entry.since).toISOString()}${note}; use /peers resume to clear it`
			: `paused ${self.name} (${self.id})${note}: ${WHAT}`;
	} catch (error) {
		return `error: ${(error as Error).message}`;
	}
}

async function resumeCommand(args: string[], host: FeatureHost): Promise<string> {
	if (args.length) return "usage: /peers resume";
	const self = host.self();
	try {
		const { cleared } = await resumeSession(host.home, self.id);
		return cleared ? `resumed ${self.name} (${self.id}): wake-triggering messages and prompts are accepted again` : `${self.name} (${self.id}) is not paused`;
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
