// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

/**
 * Read-only coordination dashboard: sessions, groups, locks, task board and pending decisions in one view.
 *
 * Read-only by construction: everything here takes a `ReadOnlyView` (five host members, none of which sends,
 * dispatches or writes) and imports only the state READERS of the other features, never an updater. Opening,
 * refreshing and rendering therefore cannot wake, message, pause or change a session. Every displayed
 * free-text field is stripped of terminal escapes, screened for credentials and capped; transcripts, prompts,
 * message bodies, sockets and process ids are never read.
 */
import type { FeatureHost, PeerView } from "./host";
import type { Feature } from "./index";
import { readBoard, isStale, staleConfig, type BoardEntry, type BoardState } from "./board";
import { readGroups } from "./groups";
import { readInbox, type InboxState } from "./inbox";
import { countLive, formatDuration, live, readLocks, type LocksState } from "./locks";
import { GROUP_RE } from "./rules";
import { looksLikeSecret } from "./secrets";

export const PANELS = ["sessions", "groups", "locks", "tasks", "decisions"] as const;
export type Panel = (typeof PANELS)[number];

export const DEFAULT_STALE_SECONDS = 60;
export const MIN_STALE_SECONDS = 5;
export const MAX_STALE_SECONDS = 3600;
/** Display caps in bytes (UTF-8, ellipsis included). */
export const NAME_CAP = 40;
export const TEXT_CAP = 80;
/** Rows per panel before `… N more`; nested lines (group members, lock holders) are capped separately. */
export const ROW_CAP = 50;
export const NESTED_CAP = 10;
export const REFRESH_MS = 5000;
/** Line width of the one-shot text snapshot. */
export const ONCE_WIDTH = 100;

export const USAGE = `usage: /peers dashboard [--group <name>] [--stale-after <seconds>] [--panels ${PANELS.join(",")}] [--once]`;

/** The only host members the dashboard sees: none of them sends, dispatches or writes. */
export type ReadOnlyView = Pick<FeatureHost, "home" | "now" | "self" | "isMaster" | "peers">;

/** A copy carrying exactly the read-only members, so nothing downstream can reach `send` or the model, even by a cast. */
export function readOnlyView(host: ReadOnlyView): ReadOnlyView {
	return { home: host.home, now: host.now, self: host.self, isMaster: host.isMaster, peers: host.peers };
}

export interface Options {
	/** Show only this group's members (lower-case, validated like a group name). */
	group?: string;
	/** Registry rows older than this many seconds are marked `[stale]`. */
	staleAfter: number;
	/** Selected panels, in canonical order. */
	panels: Panel[];
}

export type Parsed = { ok: true; options: Options; once: boolean } | { ok: false; error: string };

export function parseOptions(args: string[]): Parsed {
	const fail = (message: string): Parsed => ({ ok: false, error: `error: ${message}\n${USAGE}` });
	const options: Options = { staleAfter: DEFAULT_STALE_SECONDS, panels: [...PANELS] };
	let once = false;
	const seen = new Set<string>();
	for (let i = 0; i < args.length; i++) {
		const flag = args[i];
		if (flag !== "--group" && flag !== "--stale-after" && flag !== "--panels" && flag !== "--once") return fail(`unknown option "${safe(flag, NAME_CAP)}"`);
		if (seen.has(flag)) return fail(`${flag} given twice`);
		seen.add(flag);
		if (flag === "--once") {
			once = true;
			continue;
		}
		const value = args[++i];
		if (value === undefined || value.startsWith("--")) return fail(`${flag} needs a value`);
		if (flag === "--group") {
			const group = value.toLowerCase();
			if (!GROUP_RE.test(group)) return fail("group name must be 1-48 characters: lower-case letters, digits, '.', '_' or '-', starting with a letter or digit");
			options.group = group;
		} else if (flag === "--stale-after") {
			const seconds = /^[0-9]{1,5}$/.test(value) ? Number(value) : Number.NaN;
			if (!(seconds >= MIN_STALE_SECONDS && seconds <= MAX_STALE_SECONDS)) return fail(`--stale-after must be a whole number of seconds from ${MIN_STALE_SECONDS} to ${MAX_STALE_SECONDS}`);
			options.staleAfter = seconds;
		} else {
			const names = value.split(",");
			const known = names.every(name => (PANELS as readonly string[]).includes(name));
			if (!known || new Set(names).size !== names.length) return fail(`--panels takes a comma-separated list of distinct names from ${PANELS.join(", ")}`);
			options.panels = PANELS.filter(panel => names.includes(panel));
		}
	}
	return { ok: true, options, once };
}

// ---- Text safety and width ---------------------------------------------------------------------

// OSC / DCS-style strings, CSI sequences, then any other escape (a final byte after optional intermediates).
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[PX^_][^\u001b]*\u001b\\|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[ -/]*[0-~]/g;
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * A displayable one-line field: terminal escapes and control characters removed, whitespace collapsed,
 * `(withheld)` instead of anything that looks like a credential, cut to `cap` bytes (the `…` included) on a
 * character boundary. Empty input stays empty.
 */
export function safe(raw: unknown, cap: number): string {
	if (typeof raw !== "string") return "";
	const text = raw.replace(ANSI, " ").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
	if (!text) return "";
	if (looksLikeSecret(text)) return "(withheld)";
	if (Buffer.byteLength(text) <= cap) return text;
	let out = "";
	let bytes = 0;
	for (const ch of text) {
		const size = Buffer.byteLength(ch);
		if (bytes + size + 3 > cap) break;
		out += ch;
		bytes += size;
	}
	return `${out.trimEnd()}…`;
}

/** Terminal columns of one character, counted conservatively: East Asian wide and emoji-like symbols take 2. */
function columns(ch: string): number {
	const cp = ch.codePointAt(0)!;
	const wide = (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2300 && cp <= 0x23ff) || (cp >= 0x2600 && cp <= 0x27bf) || (cp >= 0x2b00 && cp <= 0x2bff) ||
		(cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
		(cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || cp >= 0x1f000;
	return wide ? 2 : 1;
}

export function displayWidth(text: string): number {
	let total = 0;
	for (const ch of text) total += columns(ch);
	return total;
}

/** `text` cut to at most `width` columns, ending in `…` when something was dropped. */
export function fit(text: string, width: number): string {
	if (width <= 0) return "";
	if (displayWidth(text) <= width) return text;
	let out = "";
	let used = 0;
	for (const ch of text) {
		const size = columns(ch);
		if (used + size > width - 1) break;
		out += ch;
		used += size;
	}
	return `${out}…`;
}

/** Lines of `indent` + segments separated by two spaces, packed up to `width`; continuation lines keep the indent. */
function pack(indent: string, segments: string[], width: number): string[] {
	const lines: string[] = [];
	let line = indent;
	let empty = true;
	for (const segment of segments) {
		const piece = fit(segment, Math.max(1, width - indent.length));
		if (!empty && displayWidth(line) + 2 + displayWidth(piece) > width) {
			lines.push(line);
			line = indent;
			empty = true;
		}
		line += empty ? piece : `  ${piece}`;
		empty = false;
	}
	if (!empty) lines.push(line);
	return lines;
}

/** `lead` plus its labels on one line when they fit; otherwise `lead` alone and the labels packed on the lines below, so a narrow width never hides a state or stale marker. */
function head(lead: string, labels: string[], width: number, indent = "      "): string[] {
	const joined = [lead, ...labels].join("  ");
	return displayWidth(joined) <= width ? [joined] : [fit(lead, width), ...pack(indent, labels, width)];
}

function age(ms: number): string {
	const seconds = Math.floor(Math.max(0, ms) / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

// ---- Collecting --------------------------------------------------------------------------------

export type Loaded<T> = { ok: true; value: T } | { ok: false; error: string };

export interface BoardView extends BoardState {
	/** Stale threshold in hours (the board's own configuration). */
	hours: number;
	/** Set when the configured threshold was unusable. */
	warning?: string;
}

export interface Snapshot {
	at: number;
	self: { id: string; name: string };
	master: boolean;
	peers: Loaded<PeerView[]>;
	groups: Loaded<Record<string, string[]>>;
	/** Panels that were not selected are not read. */
	locks?: Loaded<LocksState>;
	board?: Loaded<BoardView>;
	inbox?: Loaded<InboxState>;
}

async function load<T>(read: () => T | Promise<T>): Promise<Loaded<T>> {
	try {
		return { ok: true, value: await read() };
	} catch (error) {
		return { ok: false, error: safe((error as Error).message, TEXT_CAP * 2) || "unreadable" };
	}
}

/** One read-only pass over the registry view and the shared state files. Never throws: a failed source is labeled in its panel. */
export async function collect(view: ReadOnlyView, panels: readonly Panel[]): Promise<Snapshot> {
	const self = view.self();
	return {
		at: view.now(),
		self: { id: self.id, name: self.name },
		master: view.isMaster(),
		peers: await load(() => view.peers()),
		groups: await load(() => readGroups(view.home).groups),
		locks: panels.includes("locks") ? await load(() => readLocks(view)) : undefined,
		board: panels.includes("tasks") ? await load(() => ({ ...readBoard(view), ...staleConfig(view.home) })) : undefined,
		inbox: panels.includes("decisions") ? await load(() => readInbox(view)) : undefined,
	};
}

// ---- Rendering ---------------------------------------------------------------------------------

const unknownLabel = "unknown";

interface Scope {
	/** Members of the filter group; undefined when no filter is set. */
	members?: Set<string>;
	/** Why the filter cannot be applied or matches nothing. */
	note?: string;
	/** The filter is set but its membership is unreadable: panels must not show unfiltered data. */
	unavailable?: boolean;
}

function scopeOf(snapshot: Snapshot, options: Options): Scope {
	if (options.group === undefined) return {};
	if (!snapshot.groups.ok) return { unavailable: true, note: `group filter ${options.group} cannot be applied: groups are unreadable` };
	const members = snapshot.groups.value[options.group];
	return members ? { members: new Set(members) } : { members: new Set(), note: `no group named ${options.group}; the filter matches nothing` };
}

export function renderHeader(snapshot: Snapshot, options: Options): string[] {
	const scope = scopeOf(snapshot, options);
	const who = `${safe(snapshot.self.name, NAME_CAP) || "unnamed"} (${safe(snapshot.self.id, 24)})`;
	return [
		"peers dashboard: read-only snapshot",
		`taken ${new Date(snapshot.at).toISOString().replace(/\.\d{3}Z$/, "Z")}; you are ${who}, ${snapshot.master ? "the master" : "not the master"}`,
		`filter: ${options.group === undefined ? "none" : `group ${options.group}`}; registry rows stale after ${options.staleAfter}s; unknown = not published or unreadable`,
		...(scope.note ? [scope.note] : []),
	];
}

const failed = (error: string): string[] => [`  unknown: ${error}`];
const blocked = ["  unknown: group membership is unreadable, so the filter is not applied"];

/** Blocks of lines, one block per row, capped at ROW_CAP rows with an explicit remainder line. */
function rowsOf(blocks: string[][], empty: string): string[] {
	if (!blocks.length) return [`  ${empty}`];
	const shown = blocks.slice(0, ROW_CAP).flat();
	return blocks.length > ROW_CAP ? [...shown, `  … ${blocks.length - ROW_CAP} more not shown (${ROW_CAP} shown)`] : shown;
}

const byName = (a: { name: string; id: string }, b: { name: string; id: string }): number =>
	a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const yesNo = (value: unknown): string => (typeof value === "boolean" ? (value ? "yes" : "no") : unknownLabel);
const count = (value: unknown): string => (isCount(value) ? String(value) : unknownLabel);

function directory(cwd: unknown): string {
	if (typeof cwd !== "string") return unknownLabel;
	const parts = cwd.split(/[\\/]/).filter(Boolean);
	return safe(parts[parts.length - 1] ?? "", NAME_CAP) || unknownLabel;
}

/** Collapse rows that share a stable id to the one with the freshest known registry write. */
function distinct(peers: PeerView[]): PeerView[] {
	const stamped = (peer: PeerView): number => (peer.updatedAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(peer.updatedAt) || Number.NEGATIVE_INFINITY);
	const best = new Map<string, PeerView>();
	for (const peer of peers) {
		const kept = best.get(peer.id);
		if (!kept || stamped(peer) > stamped(kept)) best.set(peer.id, peer);
	}
	return [...best.values()];
}

function control(peer: PeerView): string {
	if (peer.refusesInbound === true) return "n/a (inbound refused)";
	if (typeof peer.acceptsRemote !== "boolean" || peer.refusesInbound === undefined) return unknownLabel;
	return peer.acceptsRemote ? "open" : "locked";
}

function sessionsPanel(snapshot: Snapshot, options: Options, width: number): string[] {
	const scope = scopeOf(snapshot, options);
	if (!snapshot.peers.ok) return failed(snapshot.peers.error);
	if (scope.unavailable) return blocked;
	const peers = distinct(snapshot.peers.value).filter(peer => !scope.members || scope.members.has(peer.id));
	const named = peers.map(peer => ({ peer, name: safe(peer.name, NAME_CAP) || "unnamed", id: safe(peer.id, 24) || unknownLabel }));
	named.sort(byName);
	const blocks = named.map(({ peer, name, id }) => {
		const registered = peer.updatedAt === undefined ? Number.NaN : Date.parse(peer.updatedAt);
		const seen = Number.isNaN(registered) ? undefined : snapshot.at - registered;
		const stale = seen !== undefined && seen >= options.staleAfter * 1000;
		const state = typeof peer.busy === "boolean" ? (peer.busy ? "busy" : "idle") : "state unknown";
		return [
			...head(`  ${name} (${id})`, [state, ...(peer.id === snapshot.self.id ? ["[this session]"] : []), ...(stale ? ["[stale]"] : [])], width),
			...pack("      ", [
				`context: ${safe(peer.context, NAME_CAP) || unknownLabel}`,
				`jobs: ${count(peer.activeJobs)}`,
				`agents: ${count(peer.activeSubagents)}`,
				`settled: ${yesNo(peer.isSettled)}`,
				`inbound: ${typeof peer.refusesInbound === "boolean" ? (peer.refusesInbound ? "refused" : "open") : unknownLabel}`,
				`control: ${control(peer)}`,
				`paused: ${yesNo(peer.paused)}`,
				`error turns: ${count(peer.recentErrorTurns)}`,
				`dir: ${directory(peer.cwd)}`,
				`registry: ${seen === undefined ? "age unknown" : `${age(seen)} ago`}`,
			], width),
		];
	});
	return rowsOf(blocks, "no sessions");
}

function groupsPanel(snapshot: Snapshot, options: Options, width: number): string[] {
	if (!snapshot.groups.ok) return failed(snapshot.groups.error);
	const names = new Map(snapshot.peers.ok ? snapshot.peers.value.map(peer => [peer.id, safe(peer.name, NAME_CAP) || "unnamed"]) : []);
	const all = snapshot.groups.value;
	const wanted = Object.keys(all).filter(name => options.group === undefined || name === options.group).sort();
	const blocks = wanted.map(name => {
		const members = all[name];
		const shown = members.slice(0, NESTED_CAP).map(id => {
			const label = safe(id, 24);
			if (!snapshot.peers.ok) return `${label} (running state unknown)`;
			const running = names.get(id);
			return running === undefined ? `${label} (no running session)` : `${running} (${label})`;
		});
		if (members.length > NESTED_CAP) shown.push(`… ${members.length - NESTED_CAP} more`);
		return [...head(`  ${name}`, [`${members.length} member(s)`], width), ...pack("      ", shown, width)];
	});
	return rowsOf(blocks, options.group === undefined ? "no groups" : "no such group");
}

function whoIs(snapshot: Snapshot, id: string, fallback: string): { label: string; running?: boolean } {
	const peers = snapshot.peers.ok ? snapshot.peers.value : undefined;
	const match = peers?.find(peer => peer.id === id);
	const name = safe(match?.name ?? fallback, NAME_CAP) || "unnamed";
	return { label: `${name} (${safe(id, 24)})`, running: peers ? match !== undefined : undefined };
}

function locksPanel(snapshot: Snapshot, options: Options, width: number): string[] {
	const scope = scopeOf(snapshot, options);
	if (!snapshot.locks) return failed("not read");
	if (!snapshot.locks.ok) return failed(snapshot.locks.error);
	if (scope.unavailable) return blocked;
	const blocks: string[][] = [];
	for (const resource of snapshot.locks.value.resources) {
		const leases = resource.leases.filter(lease => !scope.members || scope.members.has(lease.owner));
		if (!leases.length) continue;
		const used = countLive(resource, snapshot.at);
		const lines = head(`  ${safe(resource.name, NAME_CAP)}`, [`${used} of ${resource.capacity} slot${resource.capacity === 1 ? "" : "s"} in use${used >= resource.capacity ? " (busy)" : ""}`], width);
		leases.sort((a, b) => a.expiresAt - b.expiresAt || a.id.localeCompare(b.id, "en", { numeric: true }));
		for (const lease of leases.slice(0, NESTED_CAP)) {
			const holder = whoIs(snapshot, lease.owner, lease.name);
			const when = live(lease, snapshot.at) ? `expires in ${formatDuration(lease.expiresAt - snapshot.at)}` : `EXPIRED ${formatDuration(snapshot.at - lease.expiresAt)} ago (not counted)`;
			const note = safe(lease.note, TEXT_CAP);
			lines.push(...head(`      ${safe(lease.id, 12)}  ${holder.label}`, [...(holder.running === false ? ["[owner not running]"] : []), when, ...(note ? [`note: ${note}`] : [])], width, "          "));
		}
		if (leases.length > NESTED_CAP) lines.push(`      … ${leases.length - NESTED_CAP} more lease(s)`);
		blocks.push(lines);
	}
	return rowsOf(blocks, "no locks held");
}

function tasksPanel(snapshot: Snapshot, options: Options, width: number): string[] {
	const scope = scopeOf(snapshot, options);
	if (!snapshot.board) return failed("not read");
	if (!snapshot.board.ok) return failed(snapshot.board.error);
	if (scope.unavailable) return blocked;
	const { entries, hours, warning } = snapshot.board.value;
	const rows = entries.filter(entry => !scope.members || scope.members.has(entry.session)).map(entry => ({ entry, name: safe(entry.name, NAME_CAP) || "unnamed", id: entry.session }));
	rows.sort(byName);
	const blocks = rows.map(({ entry, id }) => {
		const holder = whoIs(snapshot, id, entry.name);
		const since = age(snapshot.at - entry.updatedAt);
		const stale = isStale(entry, snapshot.at, hours);
		const status = entry.status === "assigned" ? "assigned (progress unknown: nothing reported)" : entry.status;
		const lines = head(`  ${holder.label}`, [`${stale ? `[stale: no update for ${since}] ` : ""}${status}`, holder.running === undefined ? "running state unknown" : holder.running ? "running" : "not running"], width);
		const task = safe(entry.task, TEXT_CAP);
		lines.push(fit(`      task: ${task || unknownLabel}`, width));
		const note = safe(entry.note, TEXT_CAP);
		if (note) lines.push(fit(`      note: ${note}`, width));
		lines.push(fit(`      ${entry.source === "report" ? "reported" : "recorded"} ${since} ago`, width));
		return lines;
	});
	const lines = rowsOf(blocks, "no board entries");
	return [...(warning ? [`  ${safe(warning, TEXT_CAP * 2)}`] : []), ...lines, `  stale after ${hours}h without an update (done never goes stale); statuses are unverified claims`];
}

function decisionsPanel(snapshot: Snapshot, options: Options, width: number): string[] {
	const scope = scopeOf(snapshot, options);
	if (!snapshot.inbox) return failed("not read");
	if (!snapshot.inbox.ok) return failed(snapshot.inbox.error);
	if (scope.unavailable) return blocked;
	const scoped = snapshot.inbox.value.entries.filter(entry => !scope.members || scope.members.has(entry.source.id));
	const open = scoped.filter(entry => entry.state === "open");
	const blocks = open.map(entry => {
		const holder = whoIs(snapshot, entry.source.id, entry.source.name);
		const question = safe(entry.question, TEXT_CAP);
		return [...head(`  ${safe(entry.id, 12)}  ${holder.label}`, [`asked ${age(snapshot.at - entry.createdAt)} ago`], width), fit(`      ${question || unknownLabel}`, width)];
	});
	const lines = rowsOf(blocks, "no open decisions");
	const deferred = scoped.filter(entry => entry.state === "deferred").length;
	const answered = scoped.filter(entry => entry.state === "answered").length;
	return deferred || answered ? [...lines, `  not listed: ${deferred} deferred, ${answered} answered`] : lines;
}

/** Number of rows a panel counts for its title: sessions, groups, resources with a visible lease, board entries or open decisions. */
function titleCount(panel: Panel, snapshot: Snapshot, options: Options): string {
	const scope = scopeOf(snapshot, options);
	if (scope.unavailable) return unknownLabel;
	const members = scope.members;
	switch (panel) {
		case "sessions":
			return snapshot.peers.ok ? String(distinct(snapshot.peers.value).filter(peer => !members || members.has(peer.id)).length) : unknownLabel;
		case "groups":
			return snapshot.groups.ok ? String(Object.keys(snapshot.groups.value).filter(name => options.group === undefined || name === options.group).length) : unknownLabel;
		case "locks":
			return snapshot.locks?.ok ? String(snapshot.locks.value.resources.filter(resource => resource.leases.some(lease => !members || members.has(lease.owner))).length) : unknownLabel;
		case "tasks":
			return snapshot.board?.ok ? String(snapshot.board.value.entries.filter((entry: BoardEntry) => !members || members.has(entry.session)).length) : unknownLabel;
		case "decisions":
			return snapshot.inbox?.ok ? `${snapshot.inbox.value.entries.filter(entry => entry.state === "open" && (!members || members.has(entry.source.id))).length} open` : unknownLabel;
	}
}

export function renderPanel(panel: Panel, snapshot: Snapshot, options: Options, width: number): string[] {
	const body = { sessions: sessionsPanel, groups: groupsPanel, locks: locksPanel, tasks: tasksPanel, decisions: decisionsPanel }[panel](snapshot, options, width);
	return [`== ${panel} (${titleCount(panel, snapshot, options)}) ==`, ...body];
}

/** Every selected panel, no line wider than `width` columns. Pure: the same snapshot renders the same text. */
export function renderSnapshot(snapshot: Snapshot, options: Options, width: number): string[] {
	const lines = [...renderHeader(snapshot, options), ...options.panels.flatMap(panel => ["", ...renderPanel(panel, snapshot, options, width)])];
	return lines.map(line => fit(line, width));
}

// ---- Keys and the overlay ----------------------------------------------------------------------

export type Key = "q" | "esc" | "tab" | "shift-tab" | "r" | "g" | "?" | "up" | "down" | "pageup" | "pagedown";

const PLAIN_KEYS: Record<string, Key> = {
	q: "q", "\u001b": "esc", "\t": "tab", "\u001b[Z": "shift-tab", r: "r", g: "g", "?": "?",
	"\u001b[A": "up", "\u001bOA": "up", "\u001b[B": "down", "\u001bOB": "down", "\u001b[5~": "pageup", "\u001b[6~": "pagedown",
};
const KITTY_CODES: Record<number, Key> = { 27: "esc", 9: "tab", 113: "q", 114: "r", 103: "g", 63: "?" };

/** The dashboard key a terminal input sequence stands for: plain bytes or a Kitty `CSI u` press; releases and other keys map to nothing. */
export function parseKey(data: string): Key | undefined {
	const plain = PLAIN_KEYS[data];
	if (plain) return plain;
	// eslint-disable-next-line no-control-regex
	const kitty = /^\u001b\[(\d+)(?:;(\d+)(?::(\d+))?)?u$/.exec(data);
	if (!kitty) return undefined;
	const key = KITTY_CODES[Number(kitty[1])];
	const modifiers = kitty[2] === undefined ? 0 : Number(kitty[2]) - 1;
	if (!key || (kitty[3] !== undefined && kitty[3] !== "1" && kitty[3] !== "2")) return undefined;
	if (key === "tab" && modifiers === 1) return "shift-tab"; // only the Shift bit
	return (modifiers & ~1) === 0 ? key : undefined;
}

/** The slice of the host TUI the overlay uses. */
export interface DashboardTui {
	terminal: { rows: number };
	requestRender(): void;
}
export interface DashboardComponent {
	render(width: number): string[];
	handleInput(data: string): void;
	/** Reserves the dashboard's keys before the host's app-wide key listeners (which would otherwise take `Esc`). */
	capturesInput(data: string): boolean;
	invalidate(): void;
	dispose(): void;
}
export interface DashboardUi {
	custom<T>(
		factory: (tui: DashboardTui, theme: unknown, keybindings: unknown, done: (result: T) => void) => DashboardComponent,
		options: { overlay: boolean; overlayOptions: { width: `${number}%`; maxHeight: `${number}%`; anchor: "center" } },
	): Promise<T>;
}
/** Host timers: the overlay's one interval is cleared when the overlay closes. */
export interface Timers {
	setInterval(callback: () => void, ms: number): unknown;
	clearTimer(timer: unknown): void;
}

const HELP = [
	"keys",
	"  q, Esc               close",
	"  Tab, Shift-Tab       next, previous panel",
	"  r                    refresh now",
	"  g                    group filter: all, then each group in turn",
	"  Up, Down, PgUp, PgDn scroll",
	"  ?                    show or hide this help",
	`The view refreshes by itself every ${REFRESH_MS / 1000} s while open and only reads: it never sends, wakes,`,
	"pauses, locks or changes anything, and it hides credentials, message text and transcripts.",
];

class Overlay implements DashboardComponent {
	private snapshot: Snapshot | undefined;
	private failure: string | undefined;
	private group: string | undefined;
	private index = 0;
	private scroll = 0;
	private help = false;
	private closed = false;
	private loading = false;
	private again = false;
	private timer: unknown;

	constructor(
		private readonly view: ReadOnlyView,
		private readonly options: Options,
		private readonly tui: DashboardTui,
		private readonly timers: Timers,
		private readonly done: () => void,
	) {
		this.group = options.group;
		this.timer = timers.setInterval(() => void this.refresh(), REFRESH_MS);
		void this.refresh();
	}

	private async refresh(): Promise<void> {
		if (this.closed) return;
		if (this.loading) {
			this.again = true;
			return;
		}
		this.loading = true;
		try {
			do {
				this.again = false;
				try {
					const snapshot = await collect(this.view, this.options.panels);
					if (this.closed) return;
					this.snapshot = snapshot;
					this.failure = undefined;
				} catch (error) {
					if (this.closed) return;
					this.failure = safe((error as Error).message, TEXT_CAP) || "unknown error";
				}
				this.tui.requestRender();
			} while (this.again && !this.closed);
		} finally {
			this.loading = false;
		}
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.dispose();
		this.done();
	}

	dispose(): void {
		this.closed = true;
		if (this.timer !== undefined) this.timers.clearTimer(this.timer);
		this.timer = undefined;
	}

	invalidate(): void {}

	capturesInput(data: string): boolean {
		return !this.closed && parseKey(data) !== undefined;
	}

	handleInput(data: string): void {
		const key = parseKey(data);
		if (!key || this.closed) return;
		const panels = this.options.panels;
		switch (key) {
			case "q":
			case "esc":
				return this.close();
			case "tab":
			case "shift-tab":
				this.index = (this.index + (key === "tab" ? 1 : panels.length - 1)) % panels.length;
				this.scroll = 0;
				break;
			case "r":
				void this.refresh();
				break;
			case "g": {
				const names = this.snapshot?.groups.ok ? Object.keys(this.snapshot.groups.value).sort() : [];
				const cycle: Array<string | undefined> = [undefined, ...names];
				const at = cycle.indexOf(this.group);
				this.group = at < 0 ? undefined : cycle[(at + 1) % cycle.length];
				this.scroll = 0;
				break;
			}
			case "?":
				this.help = !this.help;
				this.scroll = 0;
				break;
			case "up":
				this.scroll = Math.max(0, this.scroll - 1);
				break;
			case "down":
				this.scroll += 1;
				break;
			case "pageup":
				this.scroll = Math.max(0, this.scroll - this.bodyRows());
				break;
			case "pagedown":
				this.scroll += this.bodyRows();
				break;
		}
		this.tui.requestRender();
	}

	private bodyRows(): number {
		return Math.max(5, Math.floor(this.tui.terminal.rows * 0.9) - 8);
	}

	render(width: number): string[] {
		const options: Options = { ...this.options, group: this.group };
		const panel = this.options.panels[this.index];
		const tabs = this.options.panels.map(name => (name === panel ? `[${name}]` : name)).join("  ");
		const keys = "q close  Tab panel  r refresh  g group  ? help  Up/Down scroll";
		if (!this.snapshot) return [fit(this.failure ? `refresh failed: ${this.failure}` : "loading…", width), fit(keys, width)];
		const header = renderHeader(this.snapshot, options);
		const body = this.help ? HELP : renderPanel(panel, this.snapshot, options, width);
		const rows = this.bodyRows();
		this.scroll = Math.min(this.scroll, Math.max(0, body.length - rows));
		const window = body.slice(this.scroll, this.scroll + rows);
		const position = body.length > rows ? `lines ${this.scroll + 1}-${this.scroll + window.length} of ${body.length}` : "";
		const lines = [...header, tabs, ...window, "", ...(this.failure ? [`last refresh failed (${this.failure}); showing the previous snapshot`] : []), [keys, position].filter(Boolean).join("   ")];
		return lines.map(line => fit(line, width));
	}
}

/** Open the live overlay; resolves when the user closes it. The refresh timer exists only while it is open. */
export function openDashboard(ui: DashboardUi, view: ReadOnlyView, options: Options, timers: Timers): Promise<void> {
	return ui.custom<void>((tui, _theme, _keybindings, done) => new Overlay(readOnlyView(view), options, tui, timers, () => done()), {
		overlay: true,
		overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" },
	});
}

// ---- Command -----------------------------------------------------------------------------------

/** One plain-text snapshot: what a non-TUI context (RPC, print) and `--once` show. */
async function command(args: string[], host: FeatureHost): Promise<string> {
	const parsed = parseOptions(args);
	if (!parsed.ok) return parsed.error;
	const snapshot = await collect(readOnlyView(host), parsed.options.panels);
	return renderSnapshot(snapshot, parsed.options, ONCE_WIDTH).join("\n");
}

export const dashboard: Feature = {
	name: "dashboard",
	command,
};
