// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

/**
 * Opt-in watchdog: alerts the coordinator about sessions that look stuck or unhealthy. Off by default.
 *
 * Only the master session evaluates, from the extension's 5 s refresh (`Feature.tick`). The inputs are
 * metadata the registry already publishes (busy, context usage text, the peer's own count of consecutive
 * error-ended turns, pause, last update time); transcripts and message bodies are never read. A busy
 * duration is tracked here, per stable session id, and persisted so a master restart does not lose it.
 *
 * An alert is a one-line hint in the master's next agent context plus, for explicit recipients, an
 * ordinary peer message. Nothing here interrupts, restarts, aborts, pauses or resumes anything. `status`
 * and `check` run the same evaluation as the periodic tick on a copy of the state and write nothing.
 */
import * as path from "node:path";
import type { FeatureHost, PeerView } from "./host";
import type { Feature } from "./index";
import { resolvePeer } from "./rules";
import { looksLikeSecret } from "./secrets";
import { readState, stateRoot, updateState } from "./store";

export type Condition = "busy" | "context" | "errors";
export const CONDITIONS: readonly Condition[] = ["busy", "context", "errors"];

export interface Config {
	enabled: boolean;
	/** Minutes a session has been busy, counted from when the watchdog first observed it busy. */
	busyMinutes: number;
	/** Consecutive assistant turns that ended in an error. */
	errorTurns: number;
	/** Context window usage in percent. */
	contextPercent: number;
	/** Minimum time between two alerts for the same session and condition. */
	cooldownMinutes: number;
	/** Group name that limits which sessions are watched; absent means all other sessions. */
	scope?: string;
	/** Extra recipients of a real peer message: stable peer ids or `group:<name>`. */
	notify: string[];
}

/** Per-session override, keyed by stable id. `off` stops watching the session; otherwise only the given thresholds change. */
export interface Override {
	off?: true;
	busyMinutes?: number;
	errorTurns?: number;
	contextPercent?: number;
}

export interface BusyRecord {
	/** When the watchdog first observed the session busy (epoch ms). Not when the turn started. */
	since: number;
	/** Last time this record was refreshed (epoch ms; refreshed at most once a minute). */
	observedAt: number;
}

export interface AlertRecord {
	session: string;
	condition: Condition;
	/** The condition currently holds. */
	active: boolean;
	/** The current activation has been alerted. False while a re-trigger is held back by the cooldown. */
	emitted: boolean;
	acked: boolean;
	/** When the last alert for this session and condition was emitted (epoch ms). */
	alertedAt: number;
	/** The observed value and the threshold at the last alert. */
	value: number;
	limit: number;
	/** Outcome per notify recipient (stable id): `delivered` or `not delivered: <reason>`. */
	notified: Record<string, string>;
}

export interface WatchdogState {
	version: 1;
	config: Config;
	overrides: Record<string, Override>;
	busy: Record<string, BusyRecord>;
	alerts: AlertRecord[];
}

export const RANGES = {
	busyMinutes: [1, 1440],
	errorTurns: [2, 50],
	contextPercent: [50, 99],
	cooldownMinutes: [1, 1440],
} as const;
export type Threshold = keyof typeof RANGES;

export const MAX_ALERTS = 200;
export const MAX_OVERRIDES = 100;
export const MAX_NOTIFY = 5;
/** Group expansion of a notify target reaches at most this many sessions. */
export const MAX_GROUP_RECIPIENTS = 20;
/** A registry entry older than this is treated as unknown rather than believed. */
export const STALE_MS = 60_000;
/** Busy records are refreshed at most this often so an unchanged busy session does not rewrite the file every tick. */
const OBSERVE_REFRESH_MS = 60_000;
const MAX_NAME = 60;
const MAX_REASON = 120;
const GROUP_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const PEER_ID_RE = /^p(?:[0-9a-f]{6}|[0-9a-f]{16})$/;
const MASTER_ONLY = "only the master session may change watchdog settings; run /peers master first";
const MINUTE = 60_000;

export const watchdogFile = (home: string) => path.join(stateRoot(home), "watchdog.json");

export const defaultConfig = (): Config => ({ enabled: false, busyMinutes: 30, errorTurns: 3, contextPercent: 90, cooldownMinutes: 30, notify: [] });
const emptyState = (): WatchdogState => ({ version: 1, config: defaultConfig(), overrides: {}, busy: {}, alerts: [] });

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const inRange = (key: Threshold, value: unknown): value is number => Number.isInteger(value) && (value as number) >= RANGES[key][0] && (value as number) <= RANGES[key][1];
const isTarget = (value: unknown): value is string => typeof value === "string" && (PEER_ID_RE.test(value) || (value.startsWith("group:") && GROUP_RE.test(value.slice(6))));

function validateState(value: unknown): WatchdogState {
	if (!isRecord(value) || value.version !== 1) throw new Error("unsupported version (expected 1)");
	const { config, overrides, busy, alerts } = value;
	if (!isRecord(config) || typeof config.enabled !== "boolean" || !(Object.keys(RANGES) as Threshold[]).every(key => inRange(key, config[key])) ||
		(config.scope !== undefined && !(typeof config.scope === "string" && GROUP_RE.test(config.scope))) ||
		!Array.isArray(config.notify) || config.notify.length > MAX_NOTIFY || !config.notify.every(isTarget)) throw new Error("malformed config");
	if (!isRecord(overrides) || Object.keys(overrides).length > MAX_OVERRIDES) throw new Error("malformed overrides");
	for (const [id, entry] of Object.entries(overrides)) {
		const ok = PEER_ID_RE.test(id) && isRecord(entry) && (entry.off === undefined || entry.off === true) &&
			(["busyMinutes", "errorTurns", "contextPercent"] as const).every(key => entry[key] === undefined || inRange(key, entry[key]));
		if (!ok) throw new Error("malformed override");
	}
	if (!isRecord(busy)) throw new Error("malformed busy records");
	for (const [id, entry] of Object.entries(busy)) {
		if (!(PEER_ID_RE.test(id) && isRecord(entry) && Number.isFinite(entry.since) && Number.isFinite(entry.observedAt))) throw new Error("malformed busy record");
	}
	if (!Array.isArray(alerts) || alerts.length > MAX_ALERTS) throw new Error("malformed alerts");
	const seen = new Set<string>();
	for (const entry of alerts as unknown[]) {
		const ok = isRecord(entry) && typeof entry.session === "string" && PEER_ID_RE.test(entry.session) && CONDITIONS.includes(entry.condition as Condition) &&
			typeof entry.active === "boolean" && typeof entry.emitted === "boolean" && typeof entry.acked === "boolean" &&
			Number.isFinite(entry.alertedAt) && Number.isFinite(entry.value) && Number.isFinite(entry.limit) &&
			isRecord(entry.notified) && Object.entries(entry.notified).every(([id, text]) => PEER_ID_RE.test(id) && typeof text === "string" && text.length <= 200);
		const key = ok ? `${entry.session}:${entry.condition}` : "";
		if (!ok || seen.has(key)) throw new Error("malformed or duplicate alert");
		seen.add(key);
	}
	return value as unknown as WatchdogState;
}

/** The stored state; a missing file is the defaults (off). Never writes. */
export function readWatchdog(host: FeatureHost): WatchdogState {
	return readState(watchdogFile(host.home), emptyState, validateState);
}

// ---- Evaluation --------------------------------------------------------------------------------

export type RowStatus = "ok" | "triggered" | "unknown" | "off";
/** What the periodic evaluation does with a triggered condition. */
export type RowAction = "none" | "alert" | "already" | "acked" | "cooldown";

export interface ConditionRow {
	condition: Condition;
	status: RowStatus;
	/** The observed value; absent when unknown or not evaluated. */
	value?: number;
	limit: number;
	/** One line of evidence, or the reason the value is unknown. */
	detail: string;
	action: RowAction;
	alertedAt?: number;
	cooldownUntil?: number;
	notified?: Record<string, string>;
}

export interface SessionRow {
	id: string;
	name: string;
	paused: boolean;
	/** The per-session override that applies, if any. */
	override?: Override;
	conditions: ConditionRow[];
}

export interface Emission {
	session: string;
	name: string;
	condition: Condition;
	value: number;
	limit: number;
	alertedAt: number;
}

export interface Evaluation {
	next: WatchdogState;
	rows: SessionRow[];
	/** Sessions that are live but outside the configured scope. */
	unwatched: number;
	/** Why the scope could not be evaluated; nothing is watched then. */
	scopeError?: string;
	emitted: Emission[];
}

const isoOf = (ms: number) => new Date(ms).toISOString();

/** One-line, control-free, length-capped session name; a credential-looking name is withheld. */
export function safeName(name: string): string {
	const text = name.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
	return !text || looksLikeSecret(text) ? "(name withheld)" : text;
}

export function describe(condition: Condition, value: number, limit: number): string {
	switch (condition) {
		case "busy": return `busy for ${value} min since first observed (limit ${limit} min)`;
		case "context": return `context at ${value}% (limit ${limit}%)`;
		default: return `${value} consecutive assistant turns ended in an error (limit ${limit})`;
	}
}

const contextPercentOf = (context: string | undefined): number | undefined => {
	const match = /\((\d{1,3})%\)\s*$/.exec(context ?? "");
	return match ? Number(match[1]) : undefined;
};

const limitsFor = (config: Config, override: Override | undefined): Record<Condition, number> => ({
	busy: override?.busyMinutes ?? config.busyMinutes,
	context: override?.contextPercent ?? config.contextPercent,
	errors: override?.errorTurns ?? config.errorTurns,
});

function deactivate(alerts: AlertRecord[], session: string): void {
	for (const alert of alerts) if (alert.session === session && alert.active) Object.assign(alert, { active: false, emitted: false, acked: false });
}

/** Drop the oldest inactive records, then the oldest active ones, until at most MAX_ALERTS remain. */
function bound(alerts: AlertRecord[]): AlertRecord[] {
	const kept = alerts.slice();
	while (kept.length > MAX_ALERTS) {
		const index = kept.findIndex(alert => !alert.active);
		kept.splice(index < 0 ? 0 : index, 1);
	}
	return kept;
}

/**
 * The single evaluation behind the periodic tick, `status` and `check`. Pure: it never touches the input
 * state, the files or any session. A condition with no usable data is `unknown`: it never alerts and never
 * clears an alert. A triggered condition alerts once per activation; it can alert again only after it has
 * cleared (observed false) and the cooldown since the last alert has passed.
 */
export function evaluate(state: WatchdogState, peers: PeerView[], now: number, selfId: string, groupsOf: (id: string) => string[]): Evaluation {
	const { config } = state;
	const cooldownMs = config.cooldownMinutes * MINUTE;
	const live = peers.filter(peer => peer.id !== selfId);
	let watched = live;
	let scopeError: string | undefined;
	if (config.scope) {
		const scope = config.scope;
		try {
			watched = live.filter(peer => groupsOf(peer.id).includes(scope));
		} catch (error) {
			watched = [];
			scopeError = `group membership cannot be read: ${(error as Error).message}`;
		}
	}
	const busy: Record<string, BusyRecord> = { ...state.busy };
	const alerts: AlertRecord[] = state.alerts.map(alert => ({ ...alert, notified: { ...alert.notified } }));
	const watchedIds = new Set(watched.map(peer => peer.id));
	// A session that is gone or no longer watched has no condition to hold: its busy record and alerts end.
	// Unreadable group membership is not evidence of anything: leave every record as it is then.
	if (!scopeError) {
		for (const id of Object.keys(busy)) if (!watchedIds.has(id)) delete busy[id];
		for (const alert of alerts) if (alert.active && !watchedIds.has(alert.session)) deactivate(alerts, alert.session);
	}

	const rows: SessionRow[] = [];
	const emitted: Emission[] = [];
	for (const peer of watched) {
		const override = state.overrides[peer.id];
		const limits = limitsFor(config, override);
		const row: SessionRow = { id: peer.id, name: peer.name, paused: peer.paused === true, ...(override ? { override } : {}), conditions: [] };
		rows.push(row);
		if (override?.off) {
			delete busy[peer.id];
			deactivate(alerts, peer.id);
			for (const condition of CONDITIONS) row.conditions.push({ condition, status: "off", limit: limits[condition], detail: "not evaluated (override --off)", action: "none" });
			continue;
		}
		const updated = peer.updatedAt === undefined ? NaN : Date.parse(peer.updatedAt);
		const staleSeconds = Number.isFinite(updated) && now - updated > STALE_MS ? Math.round((now - updated) / 1000) : undefined;
		const stale = staleSeconds === undefined ? undefined : `registry entry not updated for ${staleSeconds} s`;

		const found: Record<Condition, { status: "ok" | "triggered" | "unknown"; value?: number; detail: string }> = {
			busy: { status: "unknown", detail: "busy state not published" },
			context: { status: "unknown", detail: "no context percent published" },
			errors: { status: "unknown", detail: "peer does not publish recentErrorTurns (older plugin version)" },
		};
		if (stale) {
			for (const condition of CONDITIONS) found[condition] = { status: "unknown", detail: stale };
		} else {
			if (peer.busy === false) {
				delete busy[peer.id];
				found.busy = { status: "ok", value: 0, detail: "idle" };
			} else if (peer.busy === true) {
				const record = { ...(busy[peer.id] ?? { since: now, observedAt: now }) };
				if (now - record.observedAt >= OBSERVE_REFRESH_MS) record.observedAt = now;
				busy[peer.id] = record;
				const minutes = Math.floor((now - record.since) / MINUTE);
				found.busy = { status: minutes >= limits.busy ? "triggered" : "ok", value: minutes, detail: `busy ${minutes} min since first observed ${isoOf(record.since)}` };
			}
			const percent = contextPercentOf(peer.context);
			if (percent !== undefined) found.context = { status: percent >= limits.context ? "triggered" : "ok", value: percent, detail: `context ${percent}%` };
			if (peer.recentErrorTurns !== undefined) {
				found.errors = { status: peer.recentErrorTurns >= limits.errors ? "triggered" : "ok", value: peer.recentErrorTurns, detail: `${peer.recentErrorTurns} consecutive error turns` };
			}
		}
		for (const condition of CONDITIONS) {
			const f = found[condition];
			const limit = limits[condition];
			const out: ConditionRow = { condition, status: f.status, ...(f.value === undefined ? {} : { value: f.value }), limit, detail: f.detail, action: "none" };
			row.conditions.push(out);
			let record = alerts.find(alert => alert.session === peer.id && alert.condition === condition);
			if (f.status === "ok") {
				if (record?.active) Object.assign(record, { active: false, emitted: false, acked: false });
				continue;
			}
			if (f.status !== "triggered") continue;
			const value = f.value!;
			const emit = (rec: AlertRecord) => {
				Object.assign(rec, { active: true, emitted: true, acked: false, alertedAt: now, value, limit, notified: {} });
				emitted.push({ session: peer.id, name: peer.name, condition, value, limit, alertedAt: now });
				out.action = "alert";
			};
			if (!record) {
				record = { session: peer.id, condition, active: true, emitted: false, acked: false, alertedAt: now, value, limit, notified: {} };
				alerts.push(record);
				emit(record);
			} else {
				if (!record.active) Object.assign(record, { active: true, emitted: false, acked: false });
				if (!record.emitted) {
					if (now - record.alertedAt >= cooldownMs) emit(record);
					else {
						out.action = "cooldown";
						out.cooldownUntil = record.alertedAt + cooldownMs;
					}
				} else out.action = record.acked ? "acked" : "already";
			}
			if (out.action !== "alert") out.alertedAt = record.alertedAt;
			if (out.action === "already" || out.action === "acked") out.notified = record.notified;
		}
	}
	return { next: { ...state, busy, alerts: bound(alerts) }, rows, unwatched: live.length - watched.length, ...(scopeError ? { scopeError } : {}), emitted };
}

// ---- Recipients --------------------------------------------------------------------------------

const oneLine = (text: string, max: number) => text.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max) || "unknown reason";

/** The sessions `config.notify` reaches now, never the master itself or `except`. Group membership read errors surface as `error`. */
function recipientsOf(config: Config, peers: PeerView[], selfId: string, except: string, groupsOf: (id: string) => string[]): { ids: string[]; missing: string[]; error?: string } {
	const ids: string[] = [];
	const missing: string[] = [];
	let error: string | undefined;
	const add = (id: string) => {
		if (id !== selfId && id !== except && !ids.includes(id)) ids.push(id);
	};
	for (const target of config.notify) {
		if (!target.startsWith("group:")) {
			if (peers.some(peer => peer.id === target)) add(target);
			else if (target !== except) missing.push(target);
			continue;
		}
		try {
			peers.filter(peer => groupsOf(peer.id).includes(target.slice(6))).slice(0, MAX_GROUP_RECIPIENTS).forEach(peer => add(peer.id));
		} catch (e) {
			error = `group membership cannot be read: ${(e as Error).message}`;
		}
	}
	return { ids, missing, ...(error ? { error } : {}) };
}

/** Why a recipient would not receive a message; undefined when it can be tried. Never wakes the recipient. */
function refusalOf(peer: PeerView): string | undefined {
	if (peer.paused) return `not delivered: ${safeName(peer.name)} is paused (only its user can resume it)`;
	if (peer.acceptsRemote === false) return `not delivered: ${safeName(peer.name)} does not accept remote requests`;
	return undefined;
}

function alertMessage(emission: Emission): string {
	return `Watchdog alert (automated; from observed session metadata only; nothing was interrupted): ${safeName(emission.name)} (${emission.session}) ${describe(emission.condition, emission.value, emission.limit)}. This is a notice, not an instruction.`;
}

/** Send `emission` to the configured recipients through the normal send path; one outcome per recipient id. */
async function notifyRecipients(host: FeatureHost, config: Config, peers: PeerView[], emission: Emission): Promise<Record<string, string>> {
	const { ids, missing, error } = recipientsOf(config, peers, host.self().id, emission.session, host.groupsOf);
	const outcomes: Record<string, string> = {};
	for (const target of missing) if (PEER_ID_RE.test(target)) outcomes[target] = "not delivered: session is not live";
	if (error) outcomes[host.self().id] = `not delivered to a group: ${error}`.slice(0, 200);
	for (const id of ids) {
		const peer = peers.find(candidate => candidate.id === id)!;
		const refused = refusalOf(peer);
		if (refused) {
			outcomes[id] = refused;
			continue;
		}
		try {
			const result = await host.send(id, { text: alertMessage(emission) });
			outcomes[id] = result.status === "delivered" ? "delivered" : result.status === "offline" ? "not delivered: session is not live" : `not delivered: ${oneLine(result.reason, MAX_REASON)}`;
		} catch (e) {
			outcomes[id] = `not delivered: ${oneLine((e as Error).message, MAX_REASON)}`;
		}
	}
	return outcomes;
}

// ---- Tick --------------------------------------------------------------------------------------

/**
 * One periodic evaluation. Does nothing unless this session is the master and the watchdog is on. State is
 * updated under the cross-process lock; recipients are messaged afterwards, and the outcome is recorded on
 * the alert. A failed delivery is not retried until the alert can fire again.
 */
export async function tick(host: FeatureHost): Promise<void> {
	if (!host.isMaster() || !readWatchdog(host).config.enabled) return;
	const peers = await host.peers();
	const selfId = host.self().id;
	const now = host.now();
	const done = await updateState<WatchdogState, { config: Config; emitted: Emission[] } | undefined>(watchdogFile(host.home), emptyState, validateState, current => {
		if (!current.config.enabled) return { result: undefined };
		const evaluation = evaluate(current, peers, now, selfId, host.groupsOf);
		const result = { config: evaluation.next.config, emitted: evaluation.emitted };
		return JSON.stringify(evaluation.next) === JSON.stringify(current) ? { result } : { state: evaluation.next, result };
	});
	if (!done?.emitted.length) return;
	const outcomes = new Map<Emission, Record<string, string>>();
	for (const emission of done.emitted) {
		const sent = await notifyRecipients(host, done.config, peers, emission);
		if (Object.keys(sent).length) outcomes.set(emission, sent);
	}
	if (!outcomes.size) return;
	await updateState<WatchdogState, void>(watchdogFile(host.home), emptyState, validateState, current => {
		const alerts = current.alerts.map(alert => {
			const match = [...outcomes].find(([emission]) => emission.session === alert.session && emission.condition === alert.condition && emission.alertedAt === alert.alertedAt);
			return match ? { ...alert, notified: { ...alert.notified, ...match[1] } } : alert;
		});
		return { state: { ...current, alerts }, result: undefined };
	});
}

// ---- Presentation ------------------------------------------------------------------------------

const overrideText = (override: Override): string => override.off ? "off (not watched)" : [
	override.busyMinutes === undefined ? "" : `busy ${override.busyMinutes} min`,
	override.contextPercent === undefined ? "" : `context ${override.contextPercent}%`,
	override.errorTurns === undefined ? "" : `error turns ${override.errorTurns}`,
].filter(Boolean).join(", ");

const label = (peer: { id: string; name: string }) => `${safeName(peer.name)} (${peer.id})`;

function renderCondition(row: ConditionRow, preview: boolean): string {
	const head = `    ${row.condition}: `;
	switch (row.status) {
		case "off": return `${head}${row.detail}`;
		case "unknown": return `${head}unknown (${row.detail}); never alerts`;
		case "ok": return `${head}${row.detail} (limit ${row.limit}${row.condition === "context" ? "%" : row.condition === "busy" ? " min" : ""}), ok`;
		default: {
			const evidence = `${row.detail} (limit ${row.limit}${row.condition === "context" ? "%" : row.condition === "busy" ? " min" : ""})`;
			switch (row.action) {
				case "alert": return `${head}${evidence}: ${preview ? "WOULD ALERT now" : "TRIGGERED; the alert is due at the next evaluation (within 5 s)"}`;
				case "cooldown": return `${head}${evidence}: triggered again; no alert until ${isoOf(row.cooldownUntil!)} (cooldown)`;
				default: {
					const delivery = Object.entries(row.notified ?? {}).map(([id, text]) => `\n      notify ${id}: ${text}`).join("");
					return `${head}${evidence}: alerted ${isoOf(row.alertedAt!)}${row.action === "acked" ? ", acknowledged" : ""}; still active, no further alert until it clears${delivery}`;
				}
			}
		}
	}
}

function renderSessions(evaluation: Evaluation, preview: boolean): string[] {
	const lines: string[] = [];
	if (evaluation.scopeError) lines.push(`  scope cannot be evaluated: ${evaluation.scopeError}; nothing is watched`);
	for (const row of evaluation.rows) {
		lines.push(`  ${label(row)}${row.paused ? " [paused]" : ""}${row.override ? ` [override: ${overrideText(row.override)}]` : ""}`);
		for (const condition of row.conditions) lines.push(renderCondition(condition, preview));
	}
	if (!evaluation.rows.length && !evaluation.scopeError) lines.push("  (no sessions to watch)");
	if (evaluation.unwatched) lines.push(`  ${evaluation.unwatched} live session(s) outside the scope are not watched`);
	return lines;
}

const thresholdsLine = (config: Config) =>
	`thresholds: busy ${config.busyMinutes} min (since first observed), error turns ${config.errorTurns}, context ${config.contextPercent}%, cooldown ${config.cooldownMinutes} min`;

async function nameOf(host: FeatureHost): Promise<(id: string) => string> {
	let names: Map<string, string>;
	try {
		names = new Map((await host.peers()).map(peer => [peer.id, label(peer)]));
	} catch {
		names = new Map();
	}
	return id => names.get(id) ?? `${id} (not running)`;
}

/** Everything the watchdog is configured to do and what it sees now. Read-only. */
export async function renderStatus(host: FeatureHost): Promise<string> {
	const state = readWatchdog(host);
	const { config } = state;
	const master = host.isMaster();
	const lines = [`watchdog: ${config.enabled ? "on" : "off"}`];
	lines.push(!config.enabled ? "evaluation: not running (off)" : master ? "evaluation: runs in this session (the master) every 5 s" : "evaluation: runs only in the master session; this session is not the master");
	lines.push(thresholdsLine(config), `scope: ${config.scope ? `group:${config.scope}` : "all sessions other than the master"}`);
	const hint = !config.enabled ? "" : master && !host.acceptsRemote() ? " (suppressed: this session does not accept remote requests)" : "";
	const name = await nameOf(host);
	lines.push(`recipients: this master session's agent-context hint${hint}${config.notify.length ? `; peer message to ${config.notify.map(target => target.startsWith("group:") ? target : name(target)).join(", ")}` : ""}`);
	const overrides = Object.entries(state.overrides);
	lines.push(overrides.length ? "overrides:" : "overrides: none");
	for (const [id, override] of overrides) lines.push(`  ${name(id)}: ${overrideText(override)}`);
	if (!config.enabled) return lines.join("\n");
	let evaluation: Evaluation;
	try {
		evaluation = evaluate(state, await host.peers(), host.now(), host.self().id, host.groupsOf);
	} catch (error) {
		return [...lines, `sessions: unknown (cannot list live sessions: ${(error as Error).message})`].join("\n");
	}
	lines.push("sessions:", ...renderSessions(evaluation, false));
	const active = state.alerts.filter(alert => alert.active && alert.emitted);
	lines.push(`active alerts: ${active.length} (${active.filter(alert => !alert.acked).length} unacknowledged)`);
	return lines.join("\n");
}

/** What the next periodic evaluation would alert, from the published registry right now. Read-only: nothing is sent and no state is written. */
export async function renderCheck(host: FeatureHost): Promise<string> {
	const state = readWatchdog(host);
	const peers = await host.peers();
	const evaluation = evaluate(state, peers, host.now(), host.self().id, host.groupsOf);
	const lines = ["watchdog check (read-only: nothing is sent and no state is written)"];
	if (!state.config.enabled) lines.push("watchdog is off: the periodic evaluation does nothing; this previews the current settings");
	else if (!host.isMaster()) lines.push("this session is not the master: the periodic evaluation runs only in the master session; this previews it");
	lines.push(thresholdsLine(state.config), "sessions:", ...renderSessions(evaluation, true));
	if (!evaluation.emitted.length) lines.push("would alert: nothing");
	for (const emission of evaluation.emitted) {
		lines.push(`would alert: ${label({ id: emission.session, name: emission.name })} ${describe(emission.condition, emission.value, emission.limit)}`);
		const { ids, missing, error } = recipientsOf(state.config, peers, host.self().id, emission.session, host.groupsOf);
		for (const target of missing) lines.push(`  would not notify ${target}: not delivered: session is not live`);
		if (error) lines.push(`  would not notify a group: ${error}`);
		for (const id of ids) {
			const peer = peers.find(candidate => candidate.id === id)!;
			lines.push(`  would notify ${label(peer)}: ${refusalOf(peer) ?? "would be sent"}`);
		}
	}
	return lines.join("\n");
}

// ---- Commands ----------------------------------------------------------------------------------

const USAGE = "usage: /peers watchdog on | off | status | check | set <busyMinutes|errorTurns|contextPercent|cooldownMinutes|scope|notify> <value...> | override <peer> [--busy-minutes N] [--context-percent N] [--error-turns N] [--off] | clear-override <peer> | ack <peer> <busy|context|errors>";
const OVERRIDE_FLAGS: Record<string, "busyMinutes" | "contextPercent" | "errorTurns"> = { "--busy-minutes": "busyMinutes", "--context-percent": "contextPercent", "--error-turns": "errorTurns" };

const rangeError = (what: string, key: Threshold) => `${what} must be a whole number from ${RANGES[key][0]} to ${RANGES[key][1]}`;

function parseThreshold(raw: string | undefined, key: Threshold, what: string): { value?: number; error?: string } {
	const value = raw !== undefined && /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
	return inRange(key, value) ? { value } : { error: rangeError(what, key) };
}

const checkMaster = (host: FeatureHost): string | undefined => (host.isMaster() ? undefined : MASTER_ONLY);

type Change = (state: WatchdogState) => WatchdogState | string;

/** Apply `change` under the lock; a string result is the refusal and leaves the file untouched. */
async function mutate(host: FeatureHost, change: Change): Promise<string | undefined> {
	return updateState<WatchdogState, string | undefined>(watchdogFile(host.home), emptyState, validateState, current => {
		const next = change(current);
		return typeof next === "string" ? { result: next } : { state: next, result: undefined };
	});
}

async function setCommand(host: FeatureHost, [key, ...values]: string[]): Promise<string> {
	if (!key || !values.length) return USAGE;
	if (key in RANGES) {
		const { value, error } = parseThreshold(values.length === 1 ? values[0] : undefined, key as Threshold, key);
		if (error) return `error: ${error}`;
		const refused = await mutate(host, state => ({ ...state, config: { ...state.config, [key]: value } }));
		return refused ? `error: ${refused}` : `${key} set to ${value}`;
	}
	if (key === "scope") {
		const spec = values.length === 1 ? values[0].toLowerCase() : "";
		if (spec === "all") {
			const refused = await mutate(host, state => ({ ...state, config: { ...state.config, scope: undefined } }));
			return refused ? `error: ${refused}` : "scope set to all sessions other than the master";
		}
		if (!spec.startsWith("group:") || !GROUP_RE.test(spec.slice(6))) return "error: scope must be \"all\" or \"group:<name>\" (name: 1-48 characters: letters, digits, '.', '_' or '-')";
		const group = spec.slice(6);
		try {
			if (!(await host.peers()).some(peer => host.groupsOf(peer.id).includes(group))) return `error: scope ${spec} is not usable: no live session belongs to group "${group}" (group membership is empty or unknown); scope not changed`;
		} catch (error) {
			return `error: scope not changed: group membership cannot be read: ${(error as Error).message}`;
		}
		const refused = await mutate(host, state => ({ ...state, config: { ...state.config, scope: group } }));
		return refused ? `error: ${refused}` : `scope set to ${spec}`;
	}
	if (key === "notify") {
		const targets: string[] = [];
		if (!(values.length === 1 && values[0] === "none")) {
			if (values.length > MAX_NOTIFY) return `error: at most ${MAX_NOTIFY} notify targets`;
			for (const spec of values) {
				let target: string;
				if (spec.toLowerCase().startsWith("group:")) {
					target = spec.toLowerCase();
					if (!isTarget(target)) return "error: group name must be 1-48 characters: letters, digits, '.', '_' or '-'";
				} else {
					const peer = await resolvePeer(host, spec, true);
					if (!peer.id) return `error: ${peer.error}`;
					if (peer.id === host.self().id) return "error: this master session always gets the agent-context hint; name another session";
					target = peer.id;
				}
				if (!targets.includes(target)) targets.push(target);
			}
		}
		const refused = await mutate(host, state => ({ ...state, config: { ...state.config, notify: targets } }));
		return refused ? `error: ${refused}` : targets.length ? `notify set to ${targets.join(", ")}: each alert is also sent as an ordinary peer message (a live idle recipient may start a turn; a paused one gets nothing)` : "notify cleared: alerts go to this master session's agent-context hint only";
	}
	return `error: unknown key "${key}"; keys: busyMinutes, errorTurns, contextPercent, cooldownMinutes, scope, notify`;
}

async function overrideCommand(host: FeatureHost, [spec, ...flags]: string[]): Promise<string> {
	if (!spec) return USAGE;
	const peer = await resolvePeer(host, spec, true);
	if (!peer.id) return `error: ${peer.error}`;
	if (peer.id === host.self().id) return "error: the master session is not watched";
	const override: Override = {};
	for (let i = 0; i < flags.length; i++) {
		const flag = flags[i];
		if (flag === "--off") {
			override.off = true;
			continue;
		}
		const key = OVERRIDE_FLAGS[flag];
		if (!key) return `error: unknown option "${flag}"; options: --busy-minutes N, --context-percent N, --error-turns N, --off`;
		const { value, error } = parseThreshold(flags[++i], key, flag);
		if (error) return `error: ${error}`;
		override[key] = value;
	}
	if (!Object.keys(override).length) return USAGE;
	if (override.off && Object.keys(override).length > 1) return "error: --off cannot be combined with threshold options";
	const id = peer.id;
	const refused = await mutate(host, state => {
		if (!state.overrides[id] && Object.keys(state.overrides).length >= MAX_OVERRIDES) return `too many overrides (${MAX_OVERRIDES}); clear one first`;
		return { ...state, overrides: { ...state.overrides, [id]: override } };
	});
	return refused ? `error: ${refused}` : `override for ${id}: ${overrideText(override)} (replaces any earlier override for it)`;
}

async function clearOverride(host: FeatureHost, [spec, ...extra]: string[]): Promise<string> {
	if (!spec || extra.length) return USAGE;
	const peer = await resolvePeer(host, spec, true);
	if (!peer.id) return `error: ${peer.error}`;
	const id = peer.id;
	const refused = await mutate(host, state => {
		if (!state.overrides[id]) return `no override for ${id}`;
		const overrides = { ...state.overrides };
		delete overrides[id];
		return { ...state, overrides };
	});
	return refused ? `error: ${refused}` : `override for ${id} cleared; the global thresholds apply again`;
}

async function ackCommand(host: FeatureHost, args: string[]): Promise<string> {
	if (args.length !== 2) return USAGE;
	const condition = args[1].toLowerCase() as Condition;
	if (!CONDITIONS.includes(condition)) return `error: condition must be one of ${CONDITIONS.join(", ")}`;
	const peer = await resolvePeer(host, args[0], true);
	if (!peer.id) return `error: ${peer.error}`;
	const id = peer.id;
	const refused = await mutate(host, state => {
		const alert = state.alerts.find(candidate => candidate.session === id && candidate.condition === condition);
		if (!alert?.active || !alert.emitted) return `no active alert for ${id} ${condition} to acknowledge`;
		if (alert.acked) return `${id} ${condition} is already acknowledged`;
		return { ...state, alerts: state.alerts.map(candidate => (candidate === alert ? { ...candidate, acked: true } : candidate)) };
	});
	return refused ? `error: ${refused}` : `acknowledged ${id} ${condition}: no further alert until it clears and triggers again`;
}

async function command(args: string[], host: FeatureHost): Promise<string> {
	const [sub = "status", ...rest] = args;
	try {
		switch (sub) {
			case "status":
				return rest.length ? USAGE : await renderStatus(host);
			case "check":
				return rest.length ? USAGE : await renderCheck(host);
			case "on":
			case "off": {
				if (rest.length) return USAGE;
				const denied = checkMaster(host);
				if (denied) return `error: ${denied}`;
				const on = sub === "on";
				const refused = await mutate(host, state => ({
					...state,
					config: { ...state.config, enabled: on },
					// Turning it off forgets observations and alerts, so a later `on` starts from nothing.
					...(on ? {} : { busy: {}, alerts: [] }),
				}));
				if (refused) return `error: ${refused}`;
				return on
					? "watchdog on: the master session evaluates every 5 s from published session metadata; alerts reach this session's agent context (see /peers watchdog status). Nothing is interrupted, restarted or resumed"
					: "watchdog off: evaluation stopped; observed busy durations and alerts were cleared";
			}
			case "set":
			case "override":
			case "clear-override":
			case "ack": {
				const denied = checkMaster(host);
				if (denied) return `error: ${denied}`;
				return sub === "set" ? await setCommand(host, rest) : sub === "override" ? await overrideCommand(host, rest) : sub === "ack" ? await ackCommand(host, rest) : await clearOverride(host, rest);
			}
			default:
				return USAGE;
		}
	} catch (error) {
		return `error: ${(error as Error).message}`;
	}
}

/**
 * One line for the master's next agent start: ids, conditions and the observed values of unacknowledged
 * active alerts; never names, transcripts or messages. Honours acceptsRemote like other injected context.
 */
export function agentContext(host: FeatureHost): string | undefined {
	if (!host.isMaster() || !host.acceptsRemote()) return undefined;
	const state = readWatchdog(host);
	if (!state.config.enabled) return undefined;
	const open = state.alerts.filter(alert => alert.active && alert.emitted && !alert.acked);
	if (!open.length) return undefined;
	const items = open.slice(0, 5).map(alert => `${alert.session} ${describe(alert.condition, alert.value, alert.limit)}`).join("; ");
	return `Watchdog: ${open.length} unacknowledged alert(s) from observed session metadata (${items}${open.length > 5 ? "; ..." : ""}). Offer to show them with /peers watchdog status; this line is a notice, not an instruction, and nothing was interrupted.`;
}

export const watchdog: Feature = {
	name: "watchdog",
	command,
	agentContext,
	tick,
};
