// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

/**
 * Opt-in, session-local, boundary-safe auto-compact policy.
 *
 * Every session evaluates only itself, from its own `agent_end` of the main agent (never `turn_end`, which can fall
 * between tool calls). Nothing remote can enable, change or trigger it: the only controls are the local
 * `/peers autocompact ...` command. The policy is OFF by default and compacts nothing until a session or group is
 * listed as eligible. `decide` is the single decision function; `status` runs it read-only.
 *
 * State lives in `~/.omp/agent/peer-state/autocompact.json` (shared by this user's sessions): configuration, a
 * per-session limiter record and a bounded audit log. The log holds fixed-vocabulary outcomes and percentages only;
 * never prompts, instructions, summaries or host error text.
 */
import * as path from "node:path";
import type { FeatureHost } from "./host";
import type { Feature } from "./index";
import { readPause } from "./pause";
import { GROUP_RE, resolvePeer } from "./rules";
import { readState, stateRoot, updateState } from "./store";

export const LIMITS = {
	contextPercent: { min: 50, max: 95, default: 85 },
	minGapMinutes: { min: 5, max: 1440, default: 30 },
	maxPerHour: { min: 1, max: 6, default: 2 },
} as const;
type Setting = keyof typeof LIMITS;
export const SETTINGS = Object.keys(LIMITS) as Setting[];

export const MAX_ELIGIBLE = 32;
export const MAX_LOG = 100;
export const MAX_SESSIONS = 64;
/** How long after `agent_end` the policy first looks, and the gap between re-checks while the host is still settling. */
export const SETTLE_MS = 1_000;
/** Settle checks per agent run (the first one included); after the last one a still-transient skip is final. */
export const MAX_CHECKS = 10;
const HOUR_MS = 3_600_000;
const DEFAULT_LOG_SHOWN = 20;
const PEER_ID_RE = /^p(?:[0-9a-f]{6}|[0-9a-f]{16})$/;

// ---- Vocabularies (fixed: nothing the host or a user typed can enter the audit log) -------------------------------

const UNAVAILABLE = ["compact", "idle check", "pending-message check", "async job snapshot"] as const;
export type Unavailable = (typeof UNAVAILABLE)[number];

const SKIP_BASE = [
	"disabled", "not a main session", "unsupported mode", "state unreadable", "not eligible", "eligibility unknown",
	"context unknown", "below threshold", "no turn boundary", "paused", "pending message", "host compaction running",
	"compaction in flight", "async job running", "not idle", "suppressed: context still above threshold", "cooldown", "hourly limit",
] as const;
export type SkipReason = (typeof SKIP_BASE)[number] | `unavailable: ${Unavailable}`;
const SKIP_REASONS: readonly string[] = [...SKIP_BASE, ...UNAVAILABLE.map(what => `unavailable: ${what}`)];
/** Normal resting states: never logged, never a notice. */
const QUIET = new Set<string>(["disabled", "not a main session", "unsupported mode", "state unreadable", "not eligible", "below threshold", "no turn boundary"]);
/** Refusals that can clear on their own within moments of the boundary; re-checked a few times before they count. */
const TRANSIENT = new Set<string>(["not idle", "host compaction running"]);

const FAILED_REASONS: readonly string[] = ["compaction error"];
const CHANGE_REASONS = ["enabled", "disabled", "settings", "eligible", "suppression reset"] as const;
type ChangeReason = (typeof CHANGE_REASONS)[number];
const OUTCOMES = ["compacted", "failed", "skipped", "changed"] as const;

// ---- State ---------------------------------------------------------------------------------------------------------

export interface SessionRecord {
	/** Last time anything changed here (eviction order when more than MAX_SESSIONS sessions have records). */
	touched: number;
	/** Start times of compaction attempts in the last hour, oldest first (at most LIMITS.maxPerHour.max). */
	attempts: number[];
	/** Start (reserved) or end of the last attempt: the cooldown reference. */
	last?: number;
	/** The last compaction left the context at or above the threshold: no further compaction until a measurement falls below it. */
	suppressed?: true;
	/** The last logged skip reason; the same reason is not logged again until something else happens (one line per episode). */
	lastSkip?: string;
}

export interface LogEvent {
	at: number;
	session: string;
	outcome: (typeof OUTCOMES)[number];
	/** Fixed vocabulary (skipped / failed / changed only). */
	reason?: string;
	/** Context percent that triggered the event, when known. */
	percent?: number;
	/** Context percent after a successful compaction, when known. */
	after?: number;
}

export interface AutoConfig {
	enabled: boolean;
	contextPercent: number;
	minGapMinutes: number;
	maxPerHour: number;
}

export interface AutoState extends AutoConfig {
	version: 1;
	/** Stable session ids and `group:<name>` entries; empty means nothing is eligible. */
	eligible: string[];
	sessions: Record<string, SessionRecord>;
	log: LogEvent[];
}

export const autocompactFile = (home: string) => path.join(stateRoot(home), "autocompact.json");

const emptyState = (): AutoState => ({
	version: 1, enabled: false, contextPercent: LIMITS.contextPercent.default, minGapMinutes: LIMITS.minGapMinutes.default,
	maxPerHour: LIMITS.maxPerHour.default, eligible: [], sessions: {}, log: [],
});

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const inRange = (v: unknown, limit: { min: number; max: number }): v is number => Number.isInteger(v) && (v as number) >= limit.min && (v as number) <= limit.max;
const validEntry = (entry: string) => PEER_ID_RE.test(entry) || (entry.startsWith("group:") && GROUP_RE.test(entry.slice(6)));

function validateEvent(e: LogEvent): boolean {
	if (!e || typeof e !== "object" || !isNum(e.at) || typeof e.session !== "string" || !PEER_ID_RE.test(e.session)) return false;
	if (!(OUTCOMES as readonly unknown[]).includes(e.outcome)) return false;
	if ((e.percent !== undefined && (!isNum(e.percent) || e.percent < 0)) || (e.after !== undefined && (!isNum(e.after) || e.after < 0))) return false;
	const allowed = e.outcome === "skipped" ? SKIP_REASONS : e.outcome === "failed" ? FAILED_REASONS : e.outcome === "changed" ? CHANGE_REASONS : undefined;
	return allowed ? typeof e.reason === "string" && allowed.includes(e.reason) : e.reason === undefined;
}

function validateRecord(r: SessionRecord): boolean {
	return !!r && typeof r === "object" && isNum(r.touched) && Array.isArray(r.attempts) && r.attempts.length <= LIMITS.maxPerHour.max && r.attempts.every(isNum) &&
		(r.last === undefined || isNum(r.last)) && (r.suppressed === undefined || r.suppressed === true) &&
		(r.lastSkip === undefined || (typeof r.lastSkip === "string" && SKIP_REASONS.includes(r.lastSkip)));
}

function validate(value: unknown): AutoState {
	const s = value as Partial<AutoState> | null;
	if (!s || typeof s !== "object" || s.version !== 1) throw new Error("unsupported version (expected 1)");
	if (typeof s.enabled !== "boolean" || !inRange(s.contextPercent, LIMITS.contextPercent) || !inRange(s.minGapMinutes, LIMITS.minGapMinutes) || !inRange(s.maxPerHour, LIMITS.maxPerHour)) {
		throw new Error("malformed settings");
	}
	const { eligible, sessions, log } = s;
	if (!Array.isArray(eligible) || eligible.length > MAX_ELIGIBLE || !eligible.every(e => typeof e === "string" && validEntry(e)) || new Set(eligible).size !== eligible.length) {
		throw new Error(`malformed eligible list (at most ${MAX_ELIGIBLE} valid, unique entries)`);
	}
	if (!sessions || typeof sessions !== "object" || Array.isArray(sessions) || Object.keys(sessions).length > MAX_SESSIONS) throw new Error("malformed session records");
	for (const [id, record] of Object.entries(sessions)) if (!PEER_ID_RE.test(id) || !validateRecord(record)) throw new Error("malformed session record");
	if (!Array.isArray(log) || log.length > MAX_LOG || !log.every(validateEvent)) throw new Error(`malformed log (at most ${MAX_LOG} events)`);
	return s as AutoState;
}

const recordOf = (state: AutoState, id: string): SessionRecord => (Object.hasOwn(state.sessions, id) ? state.sessions[id] : { touched: 0, attempts: [] });

/** `state` with `id`'s record replaced and the log extended; the oldest records and events fall off at the caps. */
function updated(state: AutoState, id: string, record: SessionRecord | undefined, now: number, event?: LogEvent): AutoState {
	const sessions = { ...state.sessions };
	if (record) sessions[id] = { ...record, touched: now };
	else delete sessions[id];
	const ids = Object.keys(sessions);
	if (ids.length > MAX_SESSIONS) {
		for (const old of ids.filter(other => other !== id).sort((a, b) => sessions[a].touched - sessions[b].touched).slice(0, ids.length - MAX_SESSIONS)) delete sessions[old];
	}
	return { ...state, sessions, log: event ? [...state.log, event].slice(-MAX_LOG) : state.log };
}

const withoutKeys = (record: SessionRecord, ...keys: Array<"last" | "suppressed" | "lastSkip">): SessionRecord => {
	const next = { ...record };
	for (const key of keys) delete next[key];
	return next;
};

const pct = (p: number) => Math.round(p * 10) / 10;

// ---- The decision --------------------------------------------------------------------------------------------------

export type Eligibility = "yes" | "no" | "unknown";

/** Everything the decision depends on, gathered by the caller; `decide` itself touches nothing. */
export interface Facts {
	now: number;
	config: AutoConfig;
	record: SessionRecord;
	/** The calling context is the main agent's. */
	main: boolean;
	mode: string;
	eligibility: Eligibility;
	/** First host capability that is missing or failed; the policy never compacts without it. */
	unavailable?: Unavailable;
	/** Context percent; undefined means unknown (never guessed). */
	percent?: number;
	/** The main agent's whole run has ended and no newer one started. */
	boundary: boolean;
	paused: boolean;
	pending: boolean;
	idle: boolean;
	jobs: boolean;
	hostCompacting: boolean;
	inFlight: boolean;
}

export type Decision = { compact: true } | { compact: false; reason: SkipReason };

/** Whether this session may be compacted now, and if not the first reason why. The only decision function: status calls it too. */
export function decide(f: Facts): Decision {
	const skip = (reason: SkipReason): Decision => ({ compact: false, reason });
	if (!f.config.enabled) return skip("disabled");
	if (!f.main) return skip("not a main session");
	if (f.mode === "print" || f.mode === "json") return skip("unsupported mode");
	if (f.eligibility === "no") return skip("not eligible");
	if (f.eligibility === "unknown") return skip("eligibility unknown");
	if (f.unavailable) return skip(`unavailable: ${f.unavailable}`);
	if (f.percent === undefined) return skip("context unknown");
	if (f.percent < f.config.contextPercent) return skip("below threshold");
	if (!f.boundary) return skip("no turn boundary");
	if (f.paused) return skip("paused");
	if (f.pending) return skip("pending message");
	if (f.hostCompacting) return skip("host compaction running");
	if (f.inFlight) return skip("compaction in flight");
	if (f.jobs) return skip("async job running");
	if (!f.idle) return skip("not idle");
	if (f.record.suppressed) return skip("suppressed: context still above threshold");
	if (f.record.last !== undefined && f.now - f.record.last < f.config.minGapMinutes * 60_000) return skip("cooldown");
	if (f.record.attempts.filter(t => t > f.now - HOUR_MS).length >= f.config.maxPerHour) return skip("hourly limit");
	return { compact: true };
}

export function eligibility(entries: readonly string[], self: string, groupsOf: () => string[]): Eligibility {
	if (entries.includes(self)) return "yes";
	const wanted = entries.filter(entry => entry.startsWith("group:"));
	if (!wanted.length) return "no";
	let mine: string[];
	try {
		mine = groupsOf();
	} catch {
		return "unknown";
	}
	return wanted.some(entry => mine.includes(entry.slice(6))) ? "yes" : "no";
}

// ---- Host seam -----------------------------------------------------------------------------------------------------

/** The slice of the host's extension context this policy uses. Members are optional so an older host shows up as `unavailable`. */
export interface AutoCompactCtx {
	mode: string;
	agent: { kind: string };
	getContextUsage?: () => { percent?: number | null } | undefined;
	getAsyncJobSnapshot?: () => { running: readonly unknown[] } | null;
	compact?: (options: { onComplete?: () => void; onError?: (error: Error) => void }) => Promise<void>;
	isIdle?: () => boolean;
	hasPendingMessages?: () => boolean;
	setTimeout: (callback: () => unknown, ms: number) => unknown;
	clearTimer: (timer: never) => void;
	ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}

type ReadOnlyMember = "getContextUsage" | "getAsyncJobSnapshot" | "isIdle" | "hasPendingMessages";
type Probe = { ok: true; value: unknown } | { ok: false };

/** Call a read-only host member (as a method, so `this` is the host's); a missing member or a throw is `ok: false`. */
function probe(ctx: AutoCompactCtx, name: ReadOnlyMember): Probe {
	const read = ctx[name];
	if (typeof read !== "function") return { ok: false };
	try {
		return { ok: true, value: (read as () => unknown).call(ctx) };
	} catch {
		return { ok: false };
	}
}

/** Context percent, or undefined when the host reports nothing usable. */
function measure(ctx: AutoCompactCtx): number | undefined {
	const usage = probe(ctx, "getContextUsage");
	const percent = usage.ok && usage.value && typeof usage.value === "object" ? (usage.value as { percent?: unknown }).percent : undefined;
	return typeof percent === "number" && Number.isFinite(percent) && percent >= 0 ? percent : undefined;
}

/** Whether compaction is in flight or finishing on its own is tracked by the runtime; everything else is read here. */
function gather(host: FeatureHost, ctx: AutoCompactCtx, state: AutoState, flags: { boundary: boolean; hostCompacting: boolean; inFlight: boolean }): Facts {
	const self = host.self().id;
	const idle = probe(ctx, "isIdle");
	const pending = probe(ctx, "hasPendingMessages");
	const jobs = probe(ctx, "getAsyncJobSnapshot");
	// A snapshot is null (no job manager) or an object listing the running jobs; anything else is not trusted.
	const running = jobs.ok && jobs.value && typeof jobs.value === "object" && Array.isArray((jobs.value as { running?: unknown }).running)
		? (jobs.value as { running: unknown[] }).running.length : jobs.ok && jobs.value === null ? 0 : undefined;
	const unavailable: Unavailable | undefined =
		typeof ctx.compact !== "function" ? "compact" :
		!idle.ok || typeof idle.value !== "boolean" ? "idle check" :
		!pending.ok || typeof pending.value !== "boolean" ? "pending-message check" :
		running === undefined ? "async job snapshot" : undefined;
	return {
		now: host.now(),
		config: state,
		record: recordOf(state, self),
		main: ctx.agent.kind === "main",
		mode: ctx.mode,
		eligibility: eligibility(state.eligible, self, () => host.groupsOf(self)),
		unavailable,
		percent: measure(ctx),
		boundary: flags.boundary,
		// An unreadable pause file reads as paused: when the state is unknown nothing is acted on.
		paused: readPause(host.home, self).paused,
		pending: pending.ok ? pending.value !== false : true,
		idle: idle.ok ? idle.value === true : false,
		jobs: (running ?? 0) > 0,
		hostCompacting: flags.hostCompacting,
		inFlight: flags.inFlight,
	};
}

/** One `compact()` call, settled exactly once whether the host reports through `onComplete`/`onError`, the promise, or a throw. */
function runCompact(ctx: AutoCompactCtx): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	try {
		ctx.compact!({ onComplete: () => resolve(true), onError: () => resolve(false) }).then(() => resolve(true), () => resolve(false));
	} catch {
		resolve(false);
	}
	return promise;
}

export type Outcome =
	| { kind: "compacted"; percent: number; after?: number }
	| { kind: "failed"; percent: number }
	| { kind: "skipped"; reason: SkipReason; retry: boolean };

// ---- Runtime (one per extension process) ---------------------------------------------------------------------------

export class AutoCompactRuntime {
	private ctx?: AutoCompactCtx;
	private boundary = false;
	private hostCompacting = false;
	private inFlight = false;
	private timer: unknown;
	private checks = 0;
	/** Bumped on every agent start/end and session change: a check that started under an older epoch must not compact. */
	private epoch = 0;

	/** The main agent's context, for `status`. */
	bind(ctx: AutoCompactCtx): void {
		if (ctx.agent.kind === "main") this.ctx = ctx;
	}

	private cancel(ctx: AutoCompactCtx): void {
		if (this.timer !== undefined) ctx.clearTimer(this.timer as never);
		this.timer = undefined;
	}

	/** A new agent run starts: the boundary is gone and any pending check is moot. */
	onAgentStart(ctx: AutoCompactCtx): void {
		if (ctx.agent.kind !== "main") return;
		this.epoch++;
		this.boundary = false;
		this.cancel(ctx);
	}

	/** The host's own auto-compaction began or ended (tracked so the two never overlap). */
	onHostCompaction(active: boolean): void {
		this.hostCompacting = active;
	}

	/** Session switched or shut down: drop everything pending. */
	onSessionChange(ctx: AutoCompactCtx): void {
		this.epoch++;
		this.boundary = false;
		this.hostCompacting = false;
		this.cancel(ctx);
	}

	/** The main agent's whole run ended: the only place the policy is evaluated. */
	onAgentEnd(ctx: AutoCompactCtx, host: FeatureHost): void {
		if (ctx.agent.kind !== "main" || ctx.mode === "print" || ctx.mode === "json") return;
		// Off (the default), or an unreadable file: do nothing at all, not even a timer, for every run end.
		try {
			if (!readState(autocompactFile(host.home), emptyState, validate).enabled) return;
		} catch {
			return;
		}
		this.epoch++;
		this.boundary = true;
		this.checks = 0;
		this.cancel(ctx);
		this.schedule(ctx, host, this.epoch);
	}

	private schedule(ctx: AutoCompactCtx, host: FeatureHost, epoch: number): void {
		this.timer = ctx.setTimeout(() => {
			this.timer = undefined;
			return this.tick(ctx, host, epoch);
		}, SETTLE_MS);
	}

	private async tick(ctx: AutoCompactCtx, host: FeatureHost, epoch: number): Promise<void> {
		if (epoch !== this.epoch || !this.boundary) return;
		const final = ++this.checks >= MAX_CHECKS;
		try {
			const out = await this.evaluate(host, ctx, epoch, final);
			if (out.kind === "skipped" && out.retry && !final && epoch === this.epoch) this.schedule(ctx, host, epoch);
		} catch (error) {
			ctx.ui.notify(`auto-compact: not evaluated: ${(error as Error).message}`, "warning");
		}
	}

	/**
	 * One evaluation at a boundary. Compacts only when `decide` allows it twice: once from a fresh read, and again
	 * under the state lock after the attempt is reserved, with the live facts re-read immediately before `compact()`.
	 * `final` logs a transient refusal; before that it is retried instead.
	 */
	async evaluate(host: FeatureHost, ctx: AutoCompactCtx, epoch: number, final: boolean): Promise<Outcome> {
		const self = host.self().id;
		const file = autocompactFile(host.home);
		let state: AutoState;
		try {
			state = readState(file, emptyState, validate);
		} catch {
			return { kind: "skipped", reason: "state unreadable", retry: false };
		}
		const live = () => ({ boundary: this.boundary && this.epoch === epoch, hostCompacting: this.hostCompacting, inFlight: this.inFlight });
		const facts = gather(host, ctx, state, live());
		const first = decide(facts);
		if (!first.compact) {
			const retry = TRANSIENT.has(first.reason);
			await this.recordSkip(host, file, self, first.reason, facts.percent, retry && !final);
			return { kind: "skipped", reason: first.reason, retry };
		}
		const percent = pct(facts.percent!);
		const reserved = await updateState<AutoState, { reason: SkipReason } | { at: number; previousLast?: number }>(file, emptyState, validate, current => {
			const now = host.now();
			const record = recordOf(current, self);
			const again = decide({ ...facts, config: current, record, now });
			if (!again.compact) return { result: { reason: again.reason } };
			const attempts = [...record.attempts.filter(t => t > now - HOUR_MS), now].slice(-LIMITS.maxPerHour.max);
			return { state: updated(current, self, withoutKeys({ ...record, attempts, last: now }, "lastSkip"), now), result: { at: now, previousLast: record.last } };
		});
		if ("reason" in reserved) {
			await this.recordSkip(host, file, self, reserved.reason, facts.percent, false);
			return { kind: "skipped", reason: reserved.reason, retry: false };
		}
		// The window between the first read and the reservation spans awaits: re-read the live facts now, with no await before `compact()`.
		const again = decide(gather(host, ctx, state, live()));
		if (!again.compact) {
			await this.releaseReservation(host, file, self, reserved);
			const retry = TRANSIENT.has(again.reason);
			await this.recordSkip(host, file, self, again.reason, facts.percent, retry && !final);
			return { kind: "skipped", reason: again.reason, retry };
		}
		this.inFlight = true;
		let ok: boolean;
		try {
			ok = await runCompact(ctx);
		} finally {
			this.inFlight = false;
		}
		const after = ok ? measure(ctx) : undefined;
		const afterRounded = after === undefined ? undefined : pct(after);
		const outcome: Outcome = ok ? { kind: "compacted", percent, ...(afterRounded === undefined ? {} : { after: afterRounded }) } : { kind: "failed", percent };
		try {
			await updateState<AutoState, void>(file, emptyState, validate, current => {
				const now = host.now();
				const record = withoutKeys(recordOf(current, self), "lastSkip", "suppressed");
				const stillHigh = ok && after !== undefined && after >= current.contextPercent;
				const event: LogEvent = ok
					? { at: now, session: self, outcome: "compacted", percent, ...(afterRounded === undefined ? {} : { after: afterRounded }) }
					: { at: now, session: self, outcome: "failed", reason: "compaction error", percent };
				return { state: updated(current, self, { ...record, last: now, ...(stillHigh ? { suppressed: true as const } : {}) }, now, event), result: undefined };
			});
		} catch (error) {
			ctx.ui.notify(`auto-compact: outcome not recorded in the audit log: ${(error as Error).message}`, "warning");
		}
		ctx.ui.notify(
			ok
				? `auto-compact: compacted at ${percent}% (now ${afterRounded === undefined ? "unknown" : `${afterRounded}%`})`
				: `auto-compact: compaction failed at ${percent}%; no retry before the ${state.minGapMinutes}-minute cooldown, at most ${state.maxPerHour} attempt(s) per hour`,
			ok ? "info" : "warning",
		);
		return outcome;
	}

	/** Undo the reservation made for an attempt that the live re-check refused; the cooldown reference goes back to what it was. */
	private async releaseReservation(host: FeatureHost, file: string, self: string, reservation: { at: number; previousLast?: number }): Promise<void> {
		await updateState<AutoState, void>(file, emptyState, validate, current => {
			const record = withoutKeys(recordOf(current, self), "last");
			const restored: SessionRecord = { ...record, attempts: record.attempts.filter(t => t !== reservation.at), ...(reservation.previousLast === undefined ? {} : { last: reservation.previousLast }) };
			return { state: updated(current, self, restored, host.now()), result: undefined };
		});
	}

	/** Log a refusal once per episode; a measurement below the threshold ends the episode and the suppression. Quiet reasons write nothing. */
	private async recordSkip(host: FeatureHost, file: string, self: string, reason: SkipReason, percent: number | undefined, defer: boolean): Promise<void> {
		if (defer) return;
		if (reason !== "below threshold" && QUIET.has(reason)) return;
		await updateState<AutoState, void>(file, emptyState, validate, current => {
			const record = recordOf(current, self);
			const now = host.now();
			if (reason === "below threshold") {
				if (!record.lastSkip && !record.suppressed) return { result: undefined };
				return { state: updated(current, self, withoutKeys(record, "lastSkip", "suppressed"), now), result: undefined };
			}
			if (record.lastSkip === reason) return { result: undefined };
			const event: LogEvent = { at: now, session: self, outcome: "skipped", reason, ...(percent === undefined ? {} : { percent: pct(percent) }) };
			return { state: updated(current, self, { ...record, lastSkip: reason }, now, event), result: undefined };
		});
	}

	// ---- Commands (the local user typing here is the only authorization) ----

	async command(args: string[], host: FeatureHost): Promise<string> {
		const [sub, ...rest] = args;
		try {
			switch (sub) {
				case "status":
					return rest.length ? USAGE : this.status(host);
				case "on":
				case "off":
					return rest.length ? USAGE : await this.enable(host, sub === "on");
				case "set":
					return rest.length === 2 ? await this.set(host, rest[0], rest[1]) : USAGE;
				case "add":
				case "remove":
					return rest.length === 1 ? await this.edit(host, sub, rest[0]) : USAGE;
				case "log":
					return rest.length <= 1 ? this.log(host, rest[0]) : USAGE;
				case "reset-suppression":
					return rest.length ? USAGE : await this.resetSuppression(host);
				default:
					return USAGE;
			}
		} catch (error) {
			return `error: ${(error as Error).message}`;
		}
	}

	private async enable(host: FeatureHost, on: boolean): Promise<string> {
		const state = await updateState<AutoState, AutoState>(autocompactFile(host.home), emptyState, validate, current => {
			if (current.enabled === on) return { result: current };
			return { ...change(host, current, on ? "enabled" : "disabled", { ...current, enabled: on }), result: { ...current, enabled: on } };
		});
		if (!on) return "auto-compact is off: no session will be compacted by this policy";
		return state.eligible.length
			? `auto-compact is on: eligible sessions are compacted at a safe turn boundary above ${state.contextPercent}% context (see /peers autocompact status)`
			: "auto-compact is on, but the eligible list is empty, so nothing will be compacted; add a session or group with /peers autocompact add <session|group:<name>>";
	}

	private async set(host: FeatureHost, name: string, raw: string): Promise<string> {
		if (!(SETTINGS as string[]).includes(name)) return `error: unknown setting "${name.slice(0, 40)}"; settings: ${SETTINGS.join(", ")}`;
		const limit = LIMITS[name as Setting];
		const value = /^[0-9]{1,5}$/.test(raw) ? Number(raw) : Number.NaN;
		if (!inRange(value, limit)) return `error: ${name} must be a whole number from ${limit.min} to ${limit.max}`;
		await updateState<AutoState, void>(autocompactFile(host.home), emptyState, validate, current => {
			if (current[name as Setting] === value) return { result: undefined };
			return { ...change(host, current, "settings", { ...current, [name]: value }), result: undefined };
		});
		return `${name} = ${value}`;
	}

	private async edit(host: FeatureHost, action: "add" | "remove", spec: string): Promise<string> {
		let entry: string;
		if (spec.toLowerCase().startsWith("group:")) {
			entry = spec.toLowerCase();
			if (!GROUP_RE.test(entry.slice(6))) return "error: group name must be 1-48 characters: letters, digits, '.', '_' or '-'";
		} else {
			const peer = await resolvePeer(host, spec, action === "remove");
			if (!peer.id) return `error: ${peer.error}`;
			entry = peer.id;
		}
		const result = await updateState<AutoState, string>(autocompactFile(host.home), emptyState, validate, current => {
			const has = current.eligible.includes(entry);
			if (action === "add") {
				if (has) return { result: `${entry} is already eligible` };
				if (current.eligible.length >= MAX_ELIGIBLE) return { result: `error: eligible list is full (${MAX_ELIGIBLE} entries); remove one first` };
				return { ...change(host, current, "eligible", { ...current, eligible: [...current.eligible, entry] }), result: `${entry} is now eligible (${current.eligible.length + 1} of ${MAX_ELIGIBLE})` };
			}
			if (!has) return { result: `error: ${entry} is not in the eligible list` };
			return { ...change(host, current, "eligible", { ...current, eligible: current.eligible.filter(e => e !== entry) }), result: `${entry} is no longer eligible` };
		});
		return result;
	}

	private async resetSuppression(host: FeatureHost): Promise<string> {
		const self = host.self().id;
		return updateState<AutoState, string>(autocompactFile(host.home), emptyState, validate, current => {
			if (!Object.hasOwn(current.sessions, self)) return { result: "nothing to reset for this session" };
			const next = updated(current, self, undefined, host.now());
			return { ...change(host, current, "suppression reset", next), result: "cleared this session's suppression, cooldown, hourly count and logged-skip memory" };
		});
	}

	private log(host: FeatureHost, raw: string | undefined): string {
		const n = raw === undefined ? DEFAULT_LOG_SHOWN : /^[0-9]{1,4}$/.test(raw) ? Number(raw) : Number.NaN;
		if (!Number.isInteger(n) || n < 1 || n > MAX_LOG) return `error: n must be a whole number from 1 to ${MAX_LOG}`;
		const state = readState(autocompactFile(host.home), emptyState, validate);
		if (!state.log.length) return "auto-compact log is empty";
		const self = host.self().id;
		return state.log.slice(-n).map(e => `${new Date(e.at).toISOString()} ${e.session}${e.session === self ? " (this session)" : ""} ${describeEvent(e)}`).join("\n");
	}

	/** Read-only: reads state, host facts and the pause file; writes nothing, compacts nothing, wakes nothing. */
	private status(host: FeatureHost): string {
		const self = host.self();
		const state = readState(autocompactFile(host.home), emptyState, validate);
		const lines = [
			`auto-compact: ${state.enabled ? "on" : "off (default)"}; threshold ${state.contextPercent}% context, cooldown ${state.minGapMinutes} min, at most ${state.maxPerHour} per hour per session`,
			state.eligible.length ? `eligible (${state.eligible.length} of ${MAX_ELIGIBLE}): ${state.eligible.join(", ")}` : "eligible: none, so nothing is compacted",
		];
		const ctx = this.ctx;
		if (!ctx) return [...lines, "this session: no session context yet; nothing to evaluate"].join("\n");
		const facts = gather(host, ctx, state, { boundary: true, hostCompacting: this.hostCompacting, inFlight: this.inFlight });
		const record = facts.record;
		const recent = record.attempts.filter(t => t > facts.now - HOUR_MS).length;
		lines.push(
			`this session: ${self.name} (${self.id}); eligible: ${facts.eligibility}`,
			facts.unavailable ? `host: unavailable: ${facts.unavailable}; nothing is compacted` : "host: compact, idle, pending-message and async job checks available",
			`context: ${facts.percent === undefined ? "unknown (never guessed; nothing is compacted)" : `${pct(facts.percent)}%`}`,
			`this session's limiter: ${record.last === undefined ? "no attempt yet" : `last attempt ${new Date(record.last).toISOString()}`}; ${recent} attempt(s) in the last hour${record.suppressed ? "; SUPPRESSED until the context falls below the threshold (or /peers autocompact reset-suppression)" : ""}`,
		);
		const decision = decide(facts);
		lines.push(decision.compact ? "would compact at the next safe turn boundary: yes" : `would compact at the next safe turn boundary: no (${decision.reason})`);
		return lines.join("\n");
	}
}

/** A configuration change by the local user, recorded in the audit log. */
function change(host: FeatureHost, current: AutoState, reason: ChangeReason, next: AutoState): { state: AutoState } {
	const event: LogEvent = { at: host.now(), session: host.self().id, outcome: "changed", reason };
	return { state: { ...next, log: [...current.log, event].slice(-MAX_LOG) } };
}

function describeEvent(e: LogEvent): string {
	const at = e.percent === undefined ? "" : ` at ${e.percent}%`;
	switch (e.outcome) {
		case "compacted": return `compacted${at}${e.after === undefined ? "" : ` -> ${e.after}%`}`;
		case "failed": return `failed: ${e.reason}${at}`;
		case "skipped": return `skipped: ${e.reason}${at}`;
		case "changed": return `changed: ${e.reason}`;
	}
}

const USAGE = `usage: /peers autocompact on | off | status | set <${SETTINGS.join("|")}> <n> | add <session|group:<name>> | remove <session|group:<name>> | log [n] | reset-suppression`;

export const autoCompactRuntime = new AutoCompactRuntime();

export const autocompact: Feature = {
	name: "autocompact",
	command: (args, host) => autoCompactRuntime.command(args, host),
};
