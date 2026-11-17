// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

/**
 * Shared session task board: one entry per stable logical session, fed only by explicit assignments,
 * explicit status commands and structured reports. Nothing here scrapes histories, watches idle
 * transitions, sends a message or wakes a session; every listing is read-only.
 *
 * Writers are not authenticated: `updatedBy` is the id the writer claimed (a report's `from`), and
 * every rendering says "claimed by".
 */
import * as path from "node:path";
import type { Report } from "../reports";
import type { FeatureHost, PeerView } from "./host";
import type { Feature } from "./index";
import { looksLikeSecret as screenText } from "./secrets";
import { readRegularFile, readState, stateRoot, updateState } from "./store";

export const STATUSES = ["assigned", "in-progress", "blocked", "waiting", "decision", "done", "unknown"] as const;
export type BoardStatus = (typeof STATUSES)[number];
export type BoardSource = "assignment" | "report";

export interface BoardEntry {
	/** Stable logical session id (the stable peer id derived from the session), never a per-process value. */
	session: string;
	/** Last known display name; never used for matching writes. */
	name: string;
	task?: string;
	/** Free-text note from `set`. */
	note?: string;
	status: BoardStatus;
	/** `report` when the current status came from a structured report; `assignment` when a user command recorded it. */
	source: BoardSource;
	/** Unit named by the last structured report. */
	unit?: string;
	updatedAt: number;
	/** Stable id the writer CLAIMED; not authenticated. */
	updatedBy: string;
}

export interface BoardState {
	version: 1;
	entries: BoardEntry[];
}

export const DEFAULT_STALE_HOURS = 24;
const MAX_STALE_HOURS = 8760;
const MAX_TASK = 200;
const MAX_NAME = 48;
/** Hard ceiling of the stored board; the effective cap is `board.maxEntries` (default 200, 10 to 1000). */
const HARD_MAX_ENTRIES = 1000;
export const DEFAULT_MAX_ENTRIES = 200;
const MIN_MAX_ENTRIES = 10;
/** Finished (and not-running unknown) entries older than this are pruned on the next board write; 0 disables the age rule. */
export const DEFAULT_PRUNE_DAYS = 7;
const MAX_PRUNE_DAYS = 3650;
const PEER_ID_RE = /^p(?:[0-9a-f]{6}|[0-9a-f]{16})$/;
const MASTER_ONLY = "only the master session may assign tasks; run /peers master first";
const NOT_ALLOWED = "only the master session or the session itself may change this entry";
const REPORT_STATUS: Record<Report["kind"], BoardStatus> = { DONE: "done", BLOCKED: "blocked", WAITING: "waiting", DECISION: "decision" };

export const boardFile = (home: string) => path.join(stateRoot(home), "board.json");

const emptyState = (): BoardState => ({ version: 1, entries: [] });

function validateState(value: unknown): BoardState {
	const state = value as Partial<BoardState> | null;
	if (!state || typeof state !== "object" || state.version !== 1 || !Array.isArray(state.entries)) throw new Error("unsupported version or malformed fields");
	if (state.entries.length > HARD_MAX_ENTRIES) throw new Error("too many entries");
	const seen = new Set<string>();
	for (const entry of state.entries as BoardEntry[]) {
		const text = (field: unknown, max: number) => field === undefined || (typeof field === "string" && field.length <= max);
		const ok = entry && typeof entry === "object" && typeof entry.session === "string" && PEER_ID_RE.test(entry.session) &&
			typeof entry.name === "string" && entry.name.length <= MAX_NAME && text(entry.task, MAX_TASK) && text(entry.note, MAX_TASK) && text(entry.unit, MAX_TASK) &&
			(STATUSES as readonly string[]).includes(entry.status) && (entry.source === "assignment" || entry.source === "report") &&
			Number.isFinite(entry.updatedAt) && typeof entry.updatedBy === "string" && PEER_ID_RE.test(entry.updatedBy);
		if (!ok || seen.has(entry.session)) throw new Error("malformed or duplicate entry");
		seen.add(entry.session);
	}
	return state as BoardState;
}

/** The board as stored; a missing file is an empty board. Never writes. */
export function readBoard(host: Pick<FeatureHost, "home">): BoardState {
	return readState(boardFile(host.home), emptyState, validateState);
}

// ---- Configuration -----------------------------------------------------------------------------

export interface StaleConfig {
	hours: number;
	/** Set when the configured value was unusable and the default applies. */
	warning?: string;
}

function parseHours(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_STALE_HOURS ? value : undefined;
}

/** `board.staleHours` from `~/.omp/agent/peers.json`; a missing key or file means the default. */
export function staleConfig(home: string): StaleConfig {
	const file = path.join(home, ".omp", "agent", "peers.json");
	let text: string;
	try {
		text = readRegularFile(file);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { hours: DEFAULT_STALE_HOURS };
		if (code === "NOT_REGULAR") return { hours: DEFAULT_STALE_HOURS, warning: `peers.json is not a regular file; using ${DEFAULT_STALE_HOURS}h` };
		return { hours: DEFAULT_STALE_HOURS, warning: `peers.json could not be read (${code ?? "error"}); using ${DEFAULT_STALE_HOURS}h` };
	}
	let config: unknown;
	try {
		config = JSON.parse(text);
	} catch {
		return { hours: DEFAULT_STALE_HOURS, warning: `peers.json is not valid JSON; board.staleHours ignored, using ${DEFAULT_STALE_HOURS}h` };
	}
	const board = (config as { board?: { staleHours?: unknown } } | null)?.board;
	if (board === undefined || board === null || typeof board !== "object" || board.staleHours === undefined) return { hours: DEFAULT_STALE_HOURS };
	const hours = parseHours(board.staleHours);
	return hours === undefined
		? { hours: DEFAULT_STALE_HOURS, warning: `board.staleHours must be a number above 0 and at most ${MAX_STALE_HOURS}; using ${DEFAULT_STALE_HOURS}h` }
		: { hours };
}

export interface PruneConfig {
	maxEntries: number;
	pruneDays: number;
	/** Unusable configured values, each naming the default that applies. */
	warnings: string[];
}

/** `board.maxEntries` and `board.pruneDays` from `~/.omp/agent/peers.json`; a missing key or file means the defaults. Never throws. */
export function pruneConfig(home: string): PruneConfig {
	const config: PruneConfig = { maxEntries: DEFAULT_MAX_ENTRIES, pruneDays: DEFAULT_PRUNE_DAYS, warnings: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readRegularFile(path.join(home, ".omp", "agent", "peers.json")));
	} catch (error) {
		const code = error instanceof Error && "code" in error ? String(error.code) : "";
		if (code && code !== "ENOENT") config.warnings.push(`peers.json could not be read; board prune settings use their defaults`);
		else if (!code) config.warnings.push("peers.json is not valid JSON; board prune settings use their defaults");
		return config;
	}
	const board = typeof parsed === "object" && parsed !== null && "board" in parsed ? parsed.board : undefined;
	if (typeof board !== "object" || board === null) return config;
	if ("maxEntries" in board) {
		const value = board.maxEntries;
		if (typeof value === "number" && Number.isInteger(value) && value >= MIN_MAX_ENTRIES && value <= HARD_MAX_ENTRIES) config.maxEntries = value;
		else config.warnings.push(`board.maxEntries must be an integer from ${MIN_MAX_ENTRIES} to ${HARD_MAX_ENTRIES}; using ${DEFAULT_MAX_ENTRIES}`);
	}
	if ("pruneDays" in board) {
		const value = board.pruneDays;
		if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_PRUNE_DAYS) config.pruneDays = value;
		else config.warnings.push(`board.pruneDays must be a number from 0 (never by age) to ${MAX_PRUNE_DAYS}; using ${DEFAULT_PRUNE_DAYS}`);
	}
	return config;
}

/** Statuses that mean work is still owed: such an entry is never pruned, whether or not its session is running. */
const PENDING: ReadonlySet<BoardStatus> = new Set(["assigned", "in-progress", "blocked", "waiting", "decision"]);

/**
 * Whether `entry` may be dropped to keep the board small: it is finished (`done`), or its status is `unknown` and its session is
 * not running. `running` undefined (liveness could not be read) leaves only finished entries prunable. An entry whose session is
 * running and has not finished is active and never pruned.
 */
export function isPrunable(entry: BoardEntry, running: ReadonlySet<string> | undefined): boolean {
	if (PENDING.has(entry.status)) return false;
	if (entry.status === "done") return true;
	return running !== undefined && !running.has(entry.session);
}

export interface PruneInput {
	now: number;
	running: ReadonlySet<string> | undefined;
	maxEntries: number;
	pruneDays: number;
	/** The session being written; it is never pruned, and a new one needs room under the cap. */
	incoming: string;
}

/**
 * Entries to drop before a write. First every prunable entry at least `pruneDays` old (0 disables); then, only while a NEW session
 * would exceed `maxEntries`, the oldest prunable entries (ties by session id). Pending and running entries are never returned.
 */
export function pruneCandidates(entries: readonly BoardEntry[], input: PruneInput): BoardEntry[] {
	const prunable = entries.filter(entry => entry.session !== input.incoming && isPrunable(entry, input.running));
	const ageMs = input.pruneDays * 86_400_000;
	const drop = new Set<BoardEntry>(input.pruneDays > 0 ? prunable.filter(entry => input.now - entry.updatedAt >= ageMs) : []);
	if (!entries.some(entry => entry.session === input.incoming)) {
		const oldestFirst = prunable.filter(entry => !drop.has(entry)).sort((a, b) => a.updatedAt - b.updatedAt || (a.session < b.session ? -1 : 1));
		let size = entries.length - drop.size;
		for (const entry of oldestFirst) {
			if (size < input.maxEntries) break;
			drop.add(entry);
			size--;
		}
	}
	return entries.filter(entry => drop.has(entry));
}

// ---- Text --------------------------------------------------------------------------------------

function cleanName(raw: unknown): string {
	return typeof raw === "string" ? raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME) : "";
}

function normalizeText(raw: string, what: string): { text?: string; error?: string } {
	const text = raw.trim().replace(/\s+/g, " ");
	if (!text) return { error: `${what} is empty` };
	if (text.length > MAX_TASK) return { error: `${what} is longer than ${MAX_TASK} characters` };
	if (/[\p{Cc}\p{Cf}]/u.test(text)) return { error: `${what} contains control characters` };
	if (screenText(text)) return { error: `${what} looks like a credential or token; the board is stored in plain text. Describe where the secret lives instead of including it` };
	return { text };
}

/** A report's unit for storage: one line, bounded, and dropped entirely when it looks like a credential. */
function storableUnit(unit: string): string | undefined {
	const text = unit.replace(/\s+/g, " ").trim();
	return text && !screenText(text) ? text.slice(0, MAX_TASK) : undefined;
}

// ---- Peer resolution ---------------------------------------------------------------------------

interface Resolved {
	id?: string;
	error?: string;
}

/** Live sessions first (exact id or exact name), then board entries by id or last known name. Never guesses on ambiguity. */
function resolve(spec: string, live: PeerView[], entries: BoardEntry[]): Resolved {
	const s = spec.toLowerCase();
	const tier = (rows: Array<{ id: string; name: string }>): Resolved | undefined => {
		const byId = rows.find(row => row.id === s);
		if (byId) return { id: byId.id };
		const named = rows.filter(row => row.name.toLowerCase() === s);
		if (named.length === 1) return { id: named[0].id };
		if (named.length > 1) return { error: `"${spec}" is ambiguous: ${named.map(row => row.id).join(", ")}; use an explicit stable ID` };
	};
	return tier(live) ?? tier(entries.map(entry => ({ id: entry.session, name: entry.name }))) ?? { error: `no live session or board entry matches "${spec}"; use its stable ID or exact name` };
}

// ---- Operations --------------------------------------------------------------------------------

export type BoardResult = { ok: true; entry: BoardEntry; /** Old finished entries dropped by this write. */ pruned?: number } | { ok: false; error: string };

function upsert(entries: BoardEntry[], entry: BoardEntry): BoardEntry[] {
	return entries.some(e => e.session === entry.session) ? entries.map(e => (e.session === entry.session ? entry : e)) : [...entries, entry];
}

/** The entries that remain after pruning for a write to `incoming`, and how many were dropped. */
function pruned(entries: BoardEntry[], config: PruneConfig, incoming: string, now: number, running: ReadonlySet<string> | undefined): { entries: BoardEntry[]; dropped: number } {
	const drop = new Set(pruneCandidates(entries, { now, running, maxEntries: config.maxEntries, pruneDays: config.pruneDays, incoming }));
	return { entries: drop.size ? entries.filter(entry => !drop.has(entry)) : entries, dropped: drop.size };
}

const fullMessage = (cap: number) => `board limit reached (${cap} entries) and no finished entry can be pruned; clear an entry first`;

/** Master only. Records the assignment; sends nothing and wakes nobody. */
export async function assignTask(host: FeatureHost, spec: string, rawTask: string): Promise<BoardResult> {
	if (!host.isMaster()) return { ok: false, error: MASTER_ONLY };
	const { text, error } = normalizeText(rawTask, "task");
	if (!text) return { ok: false, error: error! };
	const live = await host.peers();
	const target = resolve(spec, live, readBoard(host).entries);
	if (!target.id) return { ok: false, error: target.error! };
	const id = target.id;
	const name = cleanName(live.find(peer => peer.id === id)?.name);
	const updatedAt = host.now();
	const updatedBy = host.self().id;
	const config = pruneConfig(host.home);
	const running = new Set(live.map(peer => peer.id));
	return updateState<BoardState, BoardResult>(boardFile(host.home), emptyState, validateState, current => {
		const existing = current.entries.find(e => e.session === id);
		const kept = pruned(current.entries, config, id, updatedAt, running);
		if (!existing && kept.entries.length >= config.maxEntries) return { result: { ok: false, error: fullMessage(config.maxEntries) } };
		const entry: BoardEntry = { session: id, name: name || existing?.name || "", task: text, status: "assigned", source: "assignment", updatedAt, updatedBy };
		return { state: { version: 1, entries: upsert(kept.entries, entry) }, result: { ok: true, entry, ...(kept.dropped ? { pruned: kept.dropped } : {}) } };
	});
}

/** Master, or the session itself for its own entry. The entry must already exist. */
export async function setStatus(host: FeatureHost, spec: string, status: string, rawNote?: string): Promise<BoardResult> {
	const next = status.toLowerCase();
	if (!(STATUSES as readonly string[]).includes(next)) return { ok: false, error: `status must be one of ${STATUSES.join(", ")}` };
	let note: string | undefined;
	if (rawNote !== undefined && rawNote.trim()) {
		const parsed = normalizeText(rawNote, "note");
		if (!parsed.text) return { ok: false, error: parsed.error! };
		note = parsed.text;
	}
	const live = await host.peers();
	const target = resolve(spec, live, readBoard(host).entries);
	if (!target.id) return { ok: false, error: target.error! };
	const id = target.id;
	const self = host.self();
	if (id !== self.id && !host.isMaster()) return { ok: false, error: NOT_ALLOWED };
	const liveName = cleanName(live.find(peer => peer.id === id)?.name);
	const updatedAt = host.now();
	const config = pruneConfig(host.home);
	const running = new Set(live.map(peer => peer.id));
	return updateState<BoardState, BoardResult>(boardFile(host.home), emptyState, validateState, current => {
		const existing = current.entries.find(e => e.session === id);
		if (!existing) return { result: { ok: false, error: `no board entry for ${id}; assign it a task first` } };
		const kept = pruned(current.entries, config, id, updatedAt, running);
		const entry: BoardEntry = { ...existing, name: liveName || existing.name, status: next as BoardStatus, source: "assignment", updatedAt, updatedBy: self.id };
		// A note describes one status; a new status starts without the previous note.
		if (note) entry.note = note;
		else delete entry.note;
		return { state: { version: 1, entries: upsert(kept.entries, entry) }, result: { ok: true, entry, ...(kept.dropped ? { pruned: kept.dropped } : {}) } };
	});
}

/** Master, or the session itself for its own entry. */
export async function clearEntry(host: FeatureHost, spec: string): Promise<BoardResult> {
	const target = resolve(spec, await host.peers(), readBoard(host).entries);
	if (!target.id) return { ok: false, error: target.error! };
	const id = target.id;
	if (id !== host.self().id && !host.isMaster()) return { ok: false, error: NOT_ALLOWED };
	return updateState<BoardState, BoardResult>(boardFile(host.home), emptyState, validateState, current => {
		const existing = current.entries.find(e => e.session === id);
		if (!existing) return { result: { ok: false, error: `no board entry for ${id}` } };
		return { state: { version: 1, entries: current.entries.filter(e => e !== existing) }, result: { ok: true, entry: existing } };
	});
}

/**
 * A structured report the receiver accepted. The sender's own entry is updated (created when missing)
 * with the status the report kind maps to. The sender id is a claim, not an authenticated identity.
 */
export async function recordReport(host: FeatureHost, report: Report, from: { id: string; name: string }): Promise<void> {
	if (!PEER_ID_RE.test(from.id)) return;
	const status = REPORT_STATUS[report.kind];
	const unit = storableUnit(report.unit);
	const name = cleanName(from.name);
	const updatedAt = host.now();
	const config = pruneConfig(host.home);
	let running: Set<string> | undefined;
	try {
		running = new Set((await host.peers()).map(peer => peer.id));
	} catch {
		running = undefined; // liveness unknown: only finished entries may be pruned
	}
	await updateState<BoardState, void>(boardFile(host.home), emptyState, validateState, current => {
		const existing = current.entries.find(e => e.session === from.id);
		const kept = pruned(current.entries, config, from.id, updatedAt, running);
		if (!existing && kept.entries.length >= config.maxEntries) throw new Error(`${fullMessage(config.maxEntries)}; report from ${from.id} not recorded`);
		const entry: BoardEntry = {
			session: from.id,
			name: name || existing?.name || "",
			...(existing?.task ? { task: existing.task } : {}),
			status,
			source: "report",
			...(unit ? { unit } : {}),
			updatedAt,
			updatedBy: from.id,
		};
		return { state: { version: 1, entries: upsert(kept.entries, entry) }, result: undefined };
	});
}

// ---- Presentation ------------------------------------------------------------------------------

export function formatAge(ms: number): string {
	const minutes = Math.floor(Math.max(0, ms) / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** Done entries never go stale: a finished task not changing is expected. Everything else is stale once its last update is at least `hours` old. */
export function isStale(entry: BoardEntry, now: number, hours: number): boolean {
	return entry.status !== "done" && now - entry.updatedAt >= hours * 3_600_000;
}

function statusLabel(entry: BoardEntry, now: number, hours: number): string {
	const age = formatAge(now - entry.updatedAt);
	const progress = entry.status === "assigned" ? "; progress unknown: nothing reported" : "";
	if (isStale(entry, now, hours)) return `stale (${entry.status}, no update for ${age}${progress})`;
	return entry.status === "assigned" ? "assigned (progress unknown: nothing reported)" : entry.status;
}

function renderEntries(entries: BoardEntry[], live: PeerView[], now: number, hours: number): string[] {
	const running = new Map(live.map(peer => [peer.id, peer.name]));
	const known = new Map(entries.map(entry => [entry.session, entry.name]));
	const who = (id: string) => {
		const name = running.get(id) ?? known.get(id);
		return name ? `${name} (${id})` : id;
	};
	const sorted = [...entries].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || (a.session < b.session ? -1 : 1));
	return sorted.flatMap(entry => {
		const liveName = running.get(entry.session);
		return [
			`  ${who(entry.session)}  ${statusLabel(entry, now, hours)}  ${liveName === undefined ? "not running" : "running"}`,
			...(entry.task ? [`      task: ${entry.task}`] : []),
			...(entry.unit ? [`      unit: ${entry.unit}`] : []),
			...(entry.note ? [`      note: ${entry.note}`] : []),
			`      ${entry.source === "report" ? "report" : "recorded"} ${formatAge(now - entry.updatedAt)} ago, claimed by ${who(entry.updatedBy)}`,
		];
	});
}

const prunedNote = (result: { pruned?: number }) => (result.pruned ? `; pruned ${result.pruned} old finished entr${result.pruned === 1 ? "y" : "ies"}` : "");

const USAGE = "usage: /peers board [list] | assign <peer> <task> | set <peer> <status> [note] | clear <peer> | stale [<hours>]";

async function command(args: string[], host: FeatureHost): Promise<string> {
	const [sub = "list", ...rest] = args;
	try {
		switch (sub) {
			case "list": {
				if (rest.length) return USAGE;
				const { hours, warning } = staleConfig(host.home);
				const entries = readBoard(host).entries;
				const header = `${entries.length} board entr${entries.length === 1 ? "y" : "ies"}; stale after ${hours}h without an update (done never goes stale); statuses are claims by the writer, not verified`;
				if (!entries.length) return [warning ?? "", "no board entries"].filter(Boolean).join("\n");
				return [header, ...(warning ? [warning] : []), ...renderEntries(entries, await host.peers(), host.now(), hours)].join("\n");
			}
			case "assign": {
				const [peer, ...task] = rest;
				if (!peer || !task.length) return USAGE;
				const result = await assignTask(host, peer, task.join(" "));
				if (!result.ok) return `error: ${result.error}`;
				return `assigned ${result.entry.name ? `${result.entry.name} ` : ""}(${result.entry.session}): ${result.entry.task}; recorded only: nothing was sent to that session${prunedNote(result)}`;
			}
			case "set": {
				const [peer, status, ...note] = rest;
				if (!peer || !status) return USAGE;
				const result = await setStatus(host, peer, status, note.join(" "));
				if (!result.ok) return `error: ${result.error}`;
				return `set ${result.entry.name ? `${result.entry.name} ` : ""}(${result.entry.session}) to ${result.entry.status}; recorded only: nothing was sent to that session${prunedNote(result)}`;
			}
			case "clear": {
				if (rest.length !== 1) return USAGE;
				const result = await clearEntry(host, rest[0]);
				return result.ok ? `cleared ${result.entry.name ? `${result.entry.name} ` : ""}(${result.entry.session})` : `error: ${result.error}`;
			}
			case "stale": {
				if (rest.length > 1) return USAGE;
				const config = staleConfig(host.home);
				let hours = config.hours;
				if (rest.length) {
					hours = /^\d+(?:\.\d+)?$/.test(rest[0]) ? Number(rest[0]) : NaN;
					if (parseHours(hours) === undefined) return `error: hours must be a number above 0 and at most ${MAX_STALE_HOURS}`;
				}
				const now = host.now();
				const stale = readBoard(host).entries.filter(entry => isStale(entry, now, hours));
				const warning = rest.length ? undefined : config.warning;
				if (!stale.length) return [warning ?? "", `no stale entries (threshold ${hours}h; done never goes stale)`].filter(Boolean).join("\n");
				return [`${stale.length} stale entr${stale.length === 1 ? "y" : "ies"} (no update for ${hours}h or more; done never goes stale)`, ...(warning ? [warning] : []),
					...renderEntries(stale, await host.peers(), now, hours)].join("\n");
			}
			default:
				return USAGE;
		}
	} catch (error) {
		return `error: ${(error as Error).message}`;
	}
}

export const board: Feature = {
	name: "board",
	command,
	onReport: (report, from, host) => recordReport(host, report, from),
};
