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
import * as fs from "node:fs";
import * as path from "node:path";
import type { Report } from "../reports";
import type { FeatureHost, PeerView } from "./host";
import type { Feature } from "./index";
import { screenText } from "./rules";
import { readState, stateRoot, updateState } from "./store";

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
const MAX_ENTRIES = 200;
const PEER_ID_RE = /^p(?:[0-9a-f]{6}|[0-9a-f]{16})$/;
const MASTER_ONLY = "only the master session may assign tasks; run /peers master first";
const NOT_ALLOWED = "only the master session or the session itself may change this entry";
const REPORT_STATUS: Record<Report["kind"], BoardStatus> = { DONE: "done", BLOCKED: "blocked", WAITING: "waiting", DECISION: "decision" };

export const boardFile = (home: string) => path.join(stateRoot(home), "board.json");

const emptyState = (): BoardState => ({ version: 1, entries: [] });

function validateState(value: unknown): BoardState {
	const state = value as Partial<BoardState> | null;
	if (!state || typeof state !== "object" || state.version !== 1 || !Array.isArray(state.entries)) throw new Error("unsupported version or malformed fields");
	if (state.entries.length > MAX_ENTRIES) throw new Error("too many entries");
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

function readBoard(host: FeatureHost): BoardState {
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
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { hours: DEFAULT_STALE_HOURS };
		return { hours: DEFAULT_STALE_HOURS, warning: `peers.json could not be read (${(error as NodeJS.ErrnoException).code ?? "error"}); using ${DEFAULT_STALE_HOURS}h` };
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

export type BoardResult = { ok: true; entry: BoardEntry } | { ok: false; error: string };

function upsert(entries: BoardEntry[], entry: BoardEntry): BoardEntry[] {
	return entries.some(e => e.session === entry.session) ? entries.map(e => (e.session === entry.session ? entry : e)) : [...entries, entry];
}

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
	return updateState<BoardState, BoardResult>(boardFile(host.home), emptyState, validateState, current => {
		const existing = current.entries.find(e => e.session === id);
		if (!existing && current.entries.length >= MAX_ENTRIES) return { result: { ok: false, error: `board limit reached (${MAX_ENTRIES} entries); clear an entry first` } };
		const entry: BoardEntry = { session: id, name: name || existing?.name || "", task: text, status: "assigned", source: "assignment", updatedAt, updatedBy };
		return { state: { version: 1, entries: upsert(current.entries, entry) }, result: { ok: true, entry } };
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
	return updateState<BoardState, BoardResult>(boardFile(host.home), emptyState, validateState, current => {
		const existing = current.entries.find(e => e.session === id);
		if (!existing) return { result: { ok: false, error: `no board entry for ${id}; assign it a task first` } };
		const entry: BoardEntry = { ...existing, name: liveName || existing.name, status: next as BoardStatus, source: "assignment", updatedAt, updatedBy: self.id };
		// A note describes one status; a new status starts without the previous note.
		if (note) entry.note = note;
		else delete entry.note;
		return { state: { version: 1, entries: upsert(current.entries, entry) }, result: { ok: true, entry } };
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
	await updateState<BoardState, void>(boardFile(host.home), emptyState, validateState, current => {
		const existing = current.entries.find(e => e.session === from.id);
		if (!existing && current.entries.length >= MAX_ENTRIES) throw new Error(`board limit reached (${MAX_ENTRIES} entries); report from ${from.id} not recorded`);
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
		return { state: { version: 1, entries: upsert(current.entries, entry) }, result: undefined };
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
				return `assigned ${result.entry.name ? `${result.entry.name} ` : ""}(${result.entry.session}): ${result.entry.task}; recorded only: nothing was sent to that session`;
			}
			case "set": {
				const [peer, status, ...note] = rest;
				if (!peer || !status) return USAGE;
				const result = await setStatus(host, peer, status, note.join(" "));
				if (!result.ok) return `error: ${result.error}`;
				return `set ${result.entry.name ? `${result.entry.name} ` : ""}(${result.entry.session}) to ${result.entry.status}; recorded only: nothing was sent to that session`;
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
