// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FEATURES } from "../../lib/features";
import {
	AutoCompactRuntime, autocompact, autocompactFile, decide, eligibility, LIMITS, MAX_CHECKS, MAX_ELIGIBLE, MAX_LOG, MAX_SESSIONS, SETTLE_MS,
	type AutoCompactCtx, type AutoConfig, type AutoState, type Facts,
} from "../../lib/features/autocompact";
import type { FeatureHost, PeerView } from "../../lib/features/host";
import { pauseFile, pauseSession } from "../../lib/features/pause";

const A = "p00000000000000a1";
const B = "p00000000000000b2";
const NOW = 1_700_000_000_000;
const MIN = 60_000;
const FAKE_KEY = ["sk", "abcdefghijklmnopqrstuvwxyz0123"].join("-"); // assembled so the repository leak scan has nothing to flag
const NAMES: Record<string, string> = { [A]: "worker-a", [B]: "worker-b" };

let home: string;
let clock: number;
let groups: Record<string, string[] | Error>;
beforeEach(() => {
	home = fs.mkdtempSync(path.join("/tmp", "oac-"));
	clock = NOW;
	groups = {};
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const LIVE: PeerView[] = [{ id: A, name: "worker-a" }, { id: B, name: "worker-b" }];
function host(self = A, live: PeerView[] = LIVE): FeatureHost {
	return {
		home,
		now: () => clock,
		self: () => ({ id: self, name: NAMES[self] ?? "anon" }),
		isMaster: () => false,
		acceptsRemote: () => true,
		peers: async () => live,
		groupsOf: peerId => {
			const found = groups[peerId] ?? [];
			if (found instanceof Error) throw found;
			return found;
		},
		resolveModel: async () => ({ ok: false, error: "not exercised by this suite" }),
		applyModel: async () => ({ ok: false, error: "not exercised by this suite" }),
		usageNow: () => undefined,
		resolveGroup: async () => ({ recipients: [], skipped: [] }),
		send: async () => ({ status: "offline" }),
	};
}

const stored = (): AutoState => JSON.parse(fs.readFileSync(autocompactFile(home), "utf8"));
const file = () => autocompactFile(home);
const say = (line: string, rt = new AutoCompactRuntime(), self = A) => rt.command(line.split(/\s+/).filter(Boolean), host(self));

// ---- The decision function ---------------------------------------------------------------------------------------

const config: AutoConfig = { enabled: true, contextPercent: 85, minGapMinutes: 30, maxPerHour: 2 };
const base: Facts = {
	now: NOW, config, record: { touched: 0, attempts: [] }, main: true, mode: "tui", eligibility: "yes", percent: 90, boundary: true,
	paused: false, pending: false, idle: true, jobs: false, hostCompacting: false, inFlight: false,
};
const why = (patch: Partial<Facts>) => {
	const d = decide({ ...base, ...patch });
	return d.compact ? "compact" : d.reason;
};

describe("decide", () => {
	test("compacts when every condition holds", () => {
		expect(decide(base)).toEqual({ compact: true });
	});

	test("every refusal reason, in precedence order", () => {
		expect(why({ config: { ...config, enabled: false } })).toBe("disabled");
		expect(why({ main: false })).toBe("not a main session");
		expect(why({ mode: "print" })).toBe("unsupported mode");
		expect(why({ mode: "json" })).toBe("unsupported mode");
		expect(why({ eligibility: "no" })).toBe("not eligible");
		expect(why({ eligibility: "unknown" })).toBe("eligibility unknown");
		expect(why({ unavailable: "compact" })).toBe("unavailable: compact");
		expect(why({ unavailable: "idle check" })).toBe("unavailable: idle check");
		expect(why({ unavailable: "pending-message check" })).toBe("unavailable: pending-message check");
		expect(why({ unavailable: "async job snapshot" })).toBe("unavailable: async job snapshot");
		expect(why({ percent: undefined })).toBe("context unknown");
		expect(why({ percent: 10 })).toBe("below threshold");
		expect(why({ boundary: false })).toBe("no turn boundary");
		expect(why({ paused: true })).toBe("paused");
		expect(why({ pending: true })).toBe("pending message");
		expect(why({ hostCompacting: true })).toBe("host compaction running");
		expect(why({ inFlight: true })).toBe("compaction in flight");
		expect(why({ jobs: true })).toBe("async job running");
		expect(why({ idle: false })).toBe("not idle");
		expect(why({ record: { touched: 0, attempts: [], suppressed: true } })).toBe("suppressed: context still above threshold");
		expect(why({ record: { touched: 0, attempts: [NOW - MIN], last: NOW - MIN } })).toBe("cooldown");
		expect(why({ record: { touched: 0, attempts: [NOW - 40 * MIN, NOW - 35 * MIN], last: NOW - 35 * MIN } })).toBe("hourly limit");
	});

	test("a disabled or ineligible session is never compacted regardless of anything else", () => {
		expect(why({ config: { ...config, enabled: false }, percent: 99 })).toBe("disabled");
		expect(why({ eligibility: "no", percent: 99 })).toBe("not eligible");
	});

	test("threshold boundary: 84 and 84.99 wait, 85 and 86 compact", () => {
		expect(why({ percent: 84 })).toBe("below threshold");
		expect(why({ percent: 84.99 })).toBe("below threshold");
		expect(why({ percent: 85 })).toBe("compact");
		expect(why({ percent: 86 })).toBe("compact");
		expect(why({ percent: 50, config: { ...config, contextPercent: 50 } })).toBe("compact");
		expect(why({ percent: 95, config: { ...config, contextPercent: 96 as number } })).toBe("below threshold");
	});

	test("unknown context never compacts, whatever else is true", () => {
		expect(why({ percent: undefined, pending: false, idle: true })).toBe("context unknown");
	});

	test("cooldown boundary: refused until exactly minGapMinutes have passed", () => {
		const record = (at: number) => ({ touched: 0, attempts: [at], last: at });
		expect(why({ record: record(NOW - 30 * MIN + 1) })).toBe("cooldown");
		expect(why({ record: record(NOW - 30 * MIN) })).toBe("compact");
		expect(why({ record: record(NOW - 31 * MIN) })).toBe("compact");
	});

	test("hourly cap counts only attempts inside the last hour; maxPerHour 1..6 is honoured", () => {
		const attempts = (n: number, ageMin: number) => ({ touched: 0, attempts: Array.from({ length: n }, (_, i) => NOW - (ageMin + i) * MIN), last: NOW - 31 * MIN });
		expect(why({ record: attempts(1, 40) })).toBe("compact");
		expect(why({ record: attempts(2, 40) })).toBe("hourly limit");
		expect(why({ record: attempts(2, 61) })).toBe("compact"); // older than an hour: not counted
		expect(why({ record: attempts(6, 40), config: { ...config, maxPerHour: 6 } })).toBe("hourly limit");
		expect(why({ record: attempts(5, 40), config: { ...config, maxPerHour: 6 } })).toBe("compact");
	});

	test("eligibility: a stable id, or membership in a listed group; an unreadable registry is unknown", () => {
		expect(eligibility([], A, () => [])).toBe("no");
		expect(eligibility([A], A, () => { throw new Error("boom"); })).toBe("yes"); // direct id needs no registry
		expect(eligibility([B], A, () => ["x"])).toBe("no");
		expect(eligibility(["group:x"], A, () => ["x", "y"])).toBe("yes");
		expect(eligibility(["group:z"], A, () => ["x"])).toBe("no");
		expect(eligibility(["group:x"], A, () => { throw new Error("groups.json is invalid"); })).toBe("unknown");
		expect(eligibility([B], A, () => { throw new Error("never asked"); })).toBe("no"); // no group entries: registry never read
	});
});

// ---- Commands, limits and state ----------------------------------------------------------------------------------

describe("commands and limits", () => {
	test("is registered as /peers autocompact and offers no tool, no agent context and no report hook (nothing remote can reach it)", () => {
		expect(FEATURES.map(f => f.name)).toContain("autocompact");
		expect(autocompact.tools).toBeUndefined();
		expect(autocompact.agentContext).toBeUndefined();
		expect(autocompact.onReport).toBeUndefined();
	});

	test("off by default: status writes nothing and says so; no file exists until a command changes something", async () => {
		const out = await say("status");
		expect(out).toContain("auto-compact: off (default); threshold 85% context, cooldown 30 min, at most 2 per hour per session");
		expect(out).toContain("eligible: none, so nothing is compacted");
		expect(fs.existsSync(file())).toBe(false);
		expect(await say("log")).toBe("auto-compact log is empty");
		expect(fs.existsSync(file())).toBe(false);
	});

	test("on with an empty eligible list compacts nothing, and says so; the state is private and versioned", async () => {
		const out = await say("on");
		expect(out).toContain("eligible list is empty, so nothing will be compacted");
		expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
		expect(fs.statSync(path.dirname(file())).mode & 0o777).toBe(0o700);
		expect(stored()).toMatchObject({ version: 1, enabled: true, contextPercent: 85, minGapMinutes: 30, maxPerHour: 2, eligible: [], sessions: {} });
		expect(await say("on")).toContain("eligible list is empty"); // idempotent: no second log event
		expect(stored().log).toHaveLength(1);
		expect(await say("off")).toBe("auto-compact is off: no session will be compacted by this policy");
		expect(stored().enabled).toBe(false);
	});

	test("set accepts exactly each documented range and refuses one past either end", async () => {
		const cases: Array<[string, number, number]> = [["contextPercent", 50, 95], ["minGapMinutes", 5, 1440], ["maxPerHour", 1, 6]];
		for (const [name, min, max] of cases) {
			expect(await say(`set ${name} ${min}`)).toBe(`${name} = ${min}`);
			expect(await say(`set ${name} ${max}`)).toBe(`${name} = ${max}`);
			for (const bad of [min - 1, max + 1, -1, 0.5]) expect(await say(`set ${name} ${bad}`)).toBe(`error: ${name} must be a whole number from ${min} to ${max}`);
			for (const bad of ["abc", "5e1", "0x10", "", "07x", "999999"]) expect(await say(`set ${name} ${bad || "''"}`)).toContain("must be a whole number");
		}
		expect(LIMITS.contextPercent).toEqual({ min: 50, max: 95, default: 85 });
		expect(await say("set nonsense 5")).toStartWith('error: unknown setting "nonsense"');
		expect(await say("set contextPercent")).toStartWith("usage:");
		expect(stored()).toMatchObject({ contextPercent: 95, minGapMinutes: 1440, maxPerHour: 6 });
	});

	test("add accepts a stable id, a live session by exact name and group:<name>; names and ids are validated", async () => {
		const live = LIVE;
		const rt = new AutoCompactRuntime();
		expect(await rt.command(["add", B], host(A, live))).toBe(`${B} is now eligible (1 of ${MAX_ELIGIBLE})`);
		expect(await rt.command(["add", "worker-b"], host(A, live))).toBe(`${B} is already eligible`);
		expect(await rt.command(["add", "Group:Backend"], host())).toBe(`group:backend is now eligible (2 of ${MAX_ELIGIBLE})`);
		expect(await rt.command(["add", "nobody"], host())).toContain("no live peer matches");
		expect(await rt.command(["add", "group:bad name!"], host())).toContain("group name must be 1-48 characters");
		expect(await rt.command(["add", `group:${"a".repeat(49)}`], host())).toContain("group name must be 1-48 characters");
		expect(await rt.command(["add", `group:${"a".repeat(48)}`], host())).toContain("is now eligible");
		expect(await rt.command(["remove", "group:nope"], host())).toBe("error: group:nope is not in the eligible list");
		expect(await rt.command(["remove", "worker-b"], host(A, live))).toBe(`${B} is no longer eligible`);
		expect(await rt.command(["remove", B], host())).toBe(`error: ${B} is not in the eligible list`); // offline ids may be removed but it is gone
		expect(stored().eligible).toEqual(["group:backend", `group:${"a".repeat(48)}`]);
	});

	test("the eligible list holds exactly 32 entries: the 32nd is accepted, the 33rd refused, and a hand-edited 33 is rejected on read", async () => {
		for (let i = 0; i < MAX_ELIGIBLE; i++) expect(await say(`add group:g${i}`)).toContain("is now eligible");
		expect(stored().eligible).toHaveLength(32);
		expect(await say("add group:one-too-many")).toBe("error: eligible list is full (32 entries); remove one first");
		expect(stored().eligible).toHaveLength(32);
		expect(await say("remove group:g0")).toContain("no longer eligible");
		expect(await say("add group:replacement")).toContain("is now eligible");
		const tampered = { ...stored(), eligible: Array.from({ length: 33 }, (_, i) => `group:t${i}`) };
		fs.writeFileSync(file(), JSON.stringify(tampered));
		expect(await say("status")).toContain("malformed eligible list");
	});

	test("the log keeps the last 100 events, oldest dropped, and `log n` accepts 1..100 only", async () => {
		await say("on");
		for (let i = 0; i < MAX_LOG + 20; i++) await say(`set contextPercent ${60 + (i % 2)}`);
		const log = stored().log;
		expect(log).toHaveLength(MAX_LOG);
		expect(log.every(e => e.outcome === "changed" && e.reason === "settings")).toBe(true);
		expect((await say("log 100")).split("\n")).toHaveLength(100);
		expect((await say("log 1")).split("\n")).toHaveLength(1);
		expect((await say("log")).split("\n")).toHaveLength(20);
		for (const bad of ["0", "101", "-1", "x", "1.5", "99999"]) expect(await say(`log ${bad}`)).toBe("error: n must be a whole number from 1 to 100");
		expect(MAX_LOG).toBe(100);
	});

	test("a hand-edited log with a free-text reason, a bad session id or 101 events is rejected, never shown", async () => {
		await say("on");
		const good = stored();
		const event = { at: NOW, session: A, outcome: "skipped" as const, reason: "paused" };
		for (const log of [
			[{ ...event, reason: `token ${FAKE_KEY}` }],
			[{ ...event, session: "not-an-id" }],
			[{ ...event, outcome: "failed", reason: "paused" }],
			[{ ...event, outcome: "compacted" }],
			Array.from({ length: MAX_LOG + 1 }, () => event),
		]) {
			fs.writeFileSync(file(), JSON.stringify({ ...good, log }));
			expect(await say("log")).toContain("malformed log");
		}
	});

	test("session records are bounded: the 65th evicts the least recently touched", async () => {
		const sessions: AutoState["sessions"] = {};
		for (let i = 0; i < MAX_SESSIONS; i++) sessions[`p${i.toString(16).padStart(16, "0")}`] = { touched: 1000 + i, attempts: [], lastSkip: "cooldown" };
		await say("on");
		fs.writeFileSync(file(), JSON.stringify({ ...stored(), sessions }));
		await say("reset-suppression"); // removes nothing for A (no record): still 64
		expect(Object.keys(stored().sessions)).toHaveLength(MAX_SESSIONS);
		const ctx = fakeCtx();
		ctx.usage = 10;
		await say("add group:x");
		const rt = new AutoCompactRuntime();
		await say(`add ${A}`, rt);
		clock = NOW;
		// A below-threshold measurement does not write; an above-threshold skip creates A's record and evicts the oldest.
		const full = stored();
		full.enabled = true;
		fs.writeFileSync(file(), JSON.stringify(full));
		ctx.usage = 99;
		ctx.pending = true;
		rt.onAgentEnd(ctx, host());
		await ctx.fire();
		const after = stored().sessions;
		expect(Object.keys(after)).toHaveLength(MAX_SESSIONS);
		expect(after[A]).toBeDefined();
		expect(after["p0000000000000000"]).toBeUndefined();
	});

	test("reset-suppression clears only this session's limiter state, with a log entry", async () => {
		await say(`add ${A}`);
		expect(await say("reset-suppression")).toBe("nothing to reset for this session");
		const state = stored();
		fs.writeFileSync(file(), JSON.stringify({ ...state, sessions: { [A]: { touched: NOW, attempts: [NOW], last: NOW, suppressed: true }, [B]: { touched: NOW, attempts: [NOW], last: NOW } } }));
		expect(await say("reset-suppression")).toContain("cleared this session's suppression");
		expect(Object.keys(stored().sessions)).toEqual([B]);
		expect(stored().log.at(-1)).toMatchObject({ outcome: "changed", reason: "suppression reset", session: A });
	});

	test("unknown subcommands and extra arguments print the usage", async () => {
		for (const line of ["", "bogus", "on now", "status x", "add", "add a b", "remove", "log 1 2", "set contextPercent 80 x", "reset-suppression x"]) {
			expect(await say(line)).toStartWith("usage: /peers autocompact on | off | status");
		}
	});

	test("an unreadable or symlinked state file is an error, never overwritten", async () => {
		fs.mkdirSync(path.dirname(file()), { recursive: true });
		fs.writeFileSync(file(), "{ not json");
		expect(await say("on")).toContain("not valid JSON");
		expect(fs.readFileSync(file(), "utf8")).toBe("{ not json");
		fs.rmSync(file());
		fs.writeFileSync(path.join(home, "elsewhere.json"), "{}");
		fs.symlinkSync(path.join(home, "elsewhere.json"), file());
		expect(await say("on")).toContain("symlink");
		expect(fs.readFileSync(path.join(home, "elsewhere.json"), "utf8")).toBe("{}");
	});
});

// ---- Runtime: the boundary, the host seam and loop suppression ---------------------------------------------------

interface FakeCtx extends AutoCompactCtx {
	usage: number | null | undefined;
	idle: boolean;
	pending: boolean;
	jobs: number;
	calls: number;
	notes: Array<{ message: string; type?: string }>;
	timers: Array<{ callback: () => unknown; ms: number; cleared: boolean }>;
	/** What `compact()` does; the default succeeds and drops the context to `after`. */
	compactImpl: (options: { onComplete?: () => void; onError?: (error: Error) => void }) => Promise<void>;
	after: number | undefined;
	/** Run the pending timer (the settle check), awaiting everything it does. */
	fire(): Promise<void>;
	pendingTimers(): number;
}

function fakeCtx(overrides: Partial<AutoCompactCtx> = {}): FakeCtx {
	const ctx: FakeCtx = {
		mode: "tui",
		agent: { kind: "main" },
		usage: 90,
		idle: true,
		pending: false,
		jobs: 0,
		calls: 0,
		notes: [],
		timers: [],
		after: 20,
		compactImpl: async options => {
			ctx.usage = ctx.after;
			options.onComplete?.();
		},
		getContextUsage: () => (ctx.usage === undefined ? undefined : { percent: ctx.usage }),
		getAsyncJobSnapshot: () => (ctx.jobs ? { running: Array.from({ length: ctx.jobs }, () => ({})) } : { running: [] }),
		isIdle: () => ctx.idle,
		hasPendingMessages: () => ctx.pending,
		compact: options => {
			ctx.calls++;
			return ctx.compactImpl(options);
		},
		setTimeout: (callback, ms) => {
			const timer = { callback, ms, cleared: false };
			ctx.timers.push(timer);
			return timer;
		},
		clearTimer: timer => {
			const pending: FakeCtx["timers"][number] = timer; // `never` is assignable to the fake's own timer record
			pending.cleared = true;
		},
		ui: { notify: (message, type) => void ctx.notes.push({ message, type }) },
		fire: async () => {
			const timer = ctx.timers.find(t => !t.cleared);
			if (!timer) throw new Error("no pending timer");
			timer.cleared = true;
			await timer.callback();
		},
		pendingTimers: () => ctx.timers.filter(t => !t.cleared).length,
		...overrides,
	};
	return ctx;
}

async function enable(...entries: string[]) {
	await say("on");
	for (const entry of entries) await say(`add ${entry}`);
}
const runBoundary = async (rt: AutoCompactRuntime, ctx: FakeCtx, self = A) => {
	rt.onAgentEnd(ctx, host(self));
	await ctx.fire();
};
const skips = () => log().filter(l => l.startsWith("skipped"));
const tickLoop = () => new Promise<void>(resolve => setImmediate(resolve));
const log = () => stored().log.map(e => `${e.outcome}${e.reason ? `: ${e.reason}` : ""}${e.percent === undefined ? "" : ` ${e.percent}`}${e.after === undefined ? "" : ` -> ${e.after}`}`);

describe("runtime at the boundary", () => {
	test("off by default: an agent end with context at 99% schedules no timer, reads no host state and writes nothing", async () => {
		const rt = new AutoCompactRuntime();
		const ctx = fakeCtx({ setTimeout: () => { throw new Error("a disabled policy must not schedule anything"); } });
		ctx.usage = 99;
		rt.onAgentEnd(ctx, host());
		expect(ctx.pendingTimers()).toBe(0);
		expect(ctx.calls).toBe(0);
		expect(fs.existsSync(file())).toBe(false);
	});

	test("enabled but nothing eligible: nothing is compacted and the status says so", async () => {
		await enable();
		const rt = new AutoCompactRuntime();
		const ctx = fakeCtx();
		await runBoundary(rt, ctx);
		expect(ctx.calls).toBe(0);
		rt.bind(ctx);
		const out = await rt.command(["status"], host());
		expect(out).toContain("eligible: none, so nothing is compacted");
		expect(out).toContain("would compact at the next safe turn boundary: no (not eligible)");
	});

	test("compacts an eligible session above the threshold, after the settle delay; logs outcome and percentages; notifies; passes no instructions", async () => {
		await enable(A);
		const rt = new AutoCompactRuntime();
		const seen: unknown[][] = [];
		const ctx = fakeCtx({ });
		const original = ctx.compact!;
		ctx.compact = (...args: unknown[]) => { seen.push(args); return (original as (...a: unknown[]) => Promise<void>)(...args); };
		rt.onAgentEnd(ctx, host());
		expect(ctx.calls).toBe(0); // never inside the agent_end handler itself
		expect(ctx.timers.map(t => t.ms)).toEqual([SETTLE_MS]);
		await ctx.fire();
		expect(ctx.calls).toBe(1);
		expect(Object.keys(seen[0][0] as object).sort()).toEqual(["onComplete", "onError"]); // no instructions, no mode
		expect(log().at(-1)).toBe("compacted 90 -> 20");
		expect(ctx.notes).toEqual([{ message: "auto-compact: compacted at 90% (now 20%)", type: "info" }]);
		const record = stored().sessions[A];
		expect(record.attempts).toEqual([NOW]);
		expect(record.last).toBe(NOW);
		expect(record.suppressed).toBeUndefined();
	});

	test("subagents, print and json mode never schedule anything", async () => {
		await enable(A);
		const rt = new AutoCompactRuntime();
		for (const patch of [{ agent: { kind: "sub" } }, { mode: "print" }, { mode: "json" }]) {
			const ctx = fakeCtx(patch);
			rt.onAgentEnd(ctx, host());
			expect(ctx.timers).toHaveLength(0);
			expect(ctx.calls).toBe(0);
		}
	});

	test("never at a turn_end: only agent_end schedules, and a new agent start cancels the pending check", async () => {
		await enable(A);
		const rt = new AutoCompactRuntime();
		const ctx = fakeCtx();
		rt.onAgentEnd(ctx, host());
		expect(ctx.pendingTimers()).toBe(1);
		rt.onAgentStart(ctx);
		expect(ctx.pendingTimers()).toBe(0);
		expect(ctx.calls).toBe(0);
		// A sub-agent's start does not cancel the main agent's pending check.
		rt.onAgentEnd(ctx, host());
		rt.onAgentStart(fakeCtx({ agent: { kind: "sub" } }));
		expect(ctx.pendingTimers()).toBe(1);
		// A timer that was already running when a run started must not compact.
		const timer = ctx.timers.find(t => !t.cleared)!;
		rt.onAgentStart(ctx);
		await timer.callback();
		expect(ctx.calls).toBe(0);
	});

	test("a pending message wins and is recorded; the same refusal is logged once per episode, not per turn", async () => {
		await enable(A);
		const rt = new AutoCompactRuntime();
		const ctx = fakeCtx();
		ctx.pending = true;
		await runBoundary(rt, ctx);
		await runBoundary(rt, ctx);
		await runBoundary(rt, ctx);
		expect(ctx.calls).toBe(0);
		expect(log().filter(l => l.startsWith("skipped"))).toEqual(["skipped: pending message 90"]);
		// A different refusal is a new line; a measurement below the threshold ends the episode.
		ctx.pending = false;
		ctx.jobs = 1;
		await runBoundary(rt, ctx);
		expect(log().at(-1)).toBe("skipped: async job running 90");
		ctx.usage = 10;
		await runBoundary(rt, ctx);
		expect(stored().sessions[A].lastSkip).toBeUndefined();
		ctx.usage = 90;
		await runBoundary(rt, ctx);
		expect(log().filter(l => l.startsWith("skipped"))).toEqual(["skipped: pending message 90", "skipped: async job running 90", "skipped: async job running 90"]);
	});

	test("protected phases refuse: running async job, host auto-compaction, paused session (and an unreadable pause file)", async () => {
		await enable(A);
		const rt = new AutoCompactRuntime();
		const ctx = fakeCtx();
		ctx.jobs = 2;
		await runBoundary(rt, ctx);
		ctx.jobs = 0;
		rt.onHostCompaction(true);
		ctx.usage = 90;
		await runBoundary(rt, ctx); // transient: retried until the last check, only then logged
		expect(ctx.pendingTimers()).toBe(1);
		rt.onHostCompaction(false);
		await pauseSession(home, A, A, NOW);
		await ctx.fire();
		expect(ctx.calls).toBe(0);
		expect(log().filter(l => l.startsWith("skipped")).map(l => l.split(" 9")[0])).toEqual(["skipped: async job running", "skipped: paused"]);
		fs.writeFileSync(pauseFile(home), "garbage"); // unknown pause state is treated as paused
		await runBoundary(rt, ctx);
		expect(ctx.calls).toBe(0);
	});

	test("not idle is re-checked every settle delay up to MAX_CHECKS, then logged once; becoming idle in between compacts", async () => {
		await enable(A);
		const rt = new AutoCompactRuntime();
		const ctx = fakeCtx();
		ctx.idle = false;
		rt.onAgentEnd(ctx, host());
		for (let i = 0; i < MAX_CHECKS - 1; i++) {
			await ctx.fire();
			expect(ctx.pendingTimers()).toBe(1);
			expect(stored().log.filter(e => e.outcome === "skipped")).toHaveLength(0);
		}
		await ctx.fire(); // the last check
		expect(ctx.pendingTimers()).toBe(0);
		expect(log().at(-1)).toBe("skipped: not idle 90");
		expect(ctx.calls).toBe(0);

		const later = fakeCtx();
		later.idle = false;
		const rt2 = new AutoCompactRuntime();
		rt2.onAgentEnd(later, host());
		await later.fire();
		later.idle = true;
		await later.fire();
		expect(later.calls).toBe(1);
	});

	test("unavailable host members: nothing compacts, status names what is missing, one line per episode", async () => {
		await enable(A);
		for (const [member, what] of [["compact", "compact"], ["isIdle", "idle check"], ["hasPendingMessages", "pending-message check"], ["getAsyncJobSnapshot", "async job snapshot"]] as const) {
			fs.writeFileSync(file(), JSON.stringify({ ...stored(), sessions: {}, log: [] }));
			const rt = new AutoCompactRuntime();
			const ctx = fakeCtx({ [member]: undefined });
			const compactSpy = ctx.calls;
			await runBoundary(rt, ctx);
			await runBoundary(rt, ctx);
			expect(ctx.calls).toBe(compactSpy);
			expect(skips()).toEqual([`skipped: unavailable: ${what} 90`]);
			rt.bind(ctx);
			expect(await rt.command(["status"], host())).toContain(`host: unavailable: ${what}; nothing is compacted`);
		}
		// A probe that throws is just as unavailable.
		fs.writeFileSync(file(), JSON.stringify({ ...stored(), sessions: {}, log: [] }));
		const ctx = fakeCtx({ isIdle: () => { throw new Error("host gone"); } });
		await runBoundary(new AutoCompactRuntime(), ctx);
		expect(ctx.calls).toBe(0);
	});

	test("an async job snapshot of null means no jobs; a malformed snapshot is unavailable", async () => {
		await enable(A);
		const ctx = fakeCtx({ getAsyncJobSnapshot: () => null });
		await runBoundary(new AutoCompactRuntime(), ctx);
		expect(ctx.calls).toBe(1);
		fs.writeFileSync(file(), JSON.stringify({ ...stored(), sessions: {}, log: [] }));
		const bad = fakeCtx({ getAsyncJobSnapshot: (() => ({ running: "none" })) as unknown as AutoCompactCtx["getAsyncJobSnapshot"] });
		await runBoundary(new AutoCompactRuntime(), bad);
		expect(bad.calls).toBe(0);
		expect(skips()).toEqual(["skipped: unavailable: async job snapshot 90"]);
	});

	test("unknown context (missing, undefined, null, NaN, negative, wrong type): never compacts, one `context unknown` line per episode", async () => {
		await enable(A);
		const rt = new AutoCompactRuntime();
		const ctx = fakeCtx();
		for (const bad of [undefined, null, Number.NaN, Infinity, -5, "90" as unknown as number]) {
			ctx.usage = bad;
			await runBoundary(rt, ctx);
		}
		expect(ctx.calls).toBe(0);
		expect(skips()).toEqual(["skipped: context unknown"]);
		await runBoundary(rt, fakeCtx({ getContextUsage: undefined }));
		await runBoundary(rt, fakeCtx({ getContextUsage: () => { throw new Error("x"); } }));
		expect(skips()).toEqual(["skipped: context unknown"]);
		// Known and low ends the episode; the next unknown is a new one.
		ctx.usage = 10;
		await runBoundary(rt, ctx);
		ctx.usage = undefined;
		await runBoundary(rt, ctx);
		expect(skips()).toEqual(["skipped: context unknown", "skipped: context unknown"]);
		rt.bind(ctx);
		expect(await rt.command(["status"], host())).toContain("context: unknown (never guessed; nothing is compacted)");
	});

	test("group eligibility: a listed group the session belongs to; a failing registry leaves it ineligible with a reason", async () => {
		await enable("group:backend");
		const rt = new AutoCompactRuntime();
		groups[A] = ["frontend"];
		let ctx = fakeCtx();
		await runBoundary(rt, ctx);
		expect(ctx.calls).toBe(0);
		groups[A] = ["frontend", "backend"];
		await runBoundary(rt, ctx);
		expect(ctx.calls).toBe(1);
		groups[A] = new Error("groups.json is invalid");
		fs.writeFileSync(file(), JSON.stringify({ ...stored(), sessions: {} }));
		ctx = fakeCtx();
		rt.bind(ctx);
		expect(await rt.command(["status"], host())).toContain("would compact at the next safe turn boundary: no (eligibility unknown)");
		await runBoundary(rt, ctx);
		expect(ctx.calls).toBe(0);
		expect(log().at(-1)).toBe("skipped: eligibility unknown 90");
	});

	test("cooldown: a second boundary inside minGapMinutes is suppressed, and compacts again once it has passed", async () => {
		await enable(A);
		const rt = new AutoCompactRuntime();
		const ctx = fakeCtx();
		await runBoundary(rt, ctx);
		expect(ctx.calls).toBe(1);
		ctx.usage = 92;
		clock += 29 * MIN;
		await runBoundary(rt, ctx);
		expect(ctx.calls).toBe(1);
		expect(log().at(-1)).toBe("skipped: cooldown 92");
		clock += 1 * MIN;
		await runBoundary(rt, ctx);
		expect(ctx.calls).toBe(2);
	});

	test("hourly cap: maxPerHour attempts per rolling hour, then refused until the oldest ages out", async () => {
		await enable(A);
		await say("set minGapMinutes 5");
		await say("set maxPerHour 2");
		const rt = new AutoCompactRuntime();
		const ctx = fakeCtx();
		for (let i = 0; i < 2; i++) {
			ctx.usage = 90;
			await runBoundary(rt, ctx);
			clock += 6 * MIN;
		}
		expect(ctx.calls).toBe(2);
		ctx.usage = 90;
		await runBoundary(rt, ctx);
		expect(ctx.calls).toBe(2);
		expect(log().at(-1)).toBe("skipped: hourly limit 90");
		clock = NOW + 61 * MIN; // first attempt (at NOW) is out of the window; the second (NOW+6min) is not
		await runBoundary(rt, ctx);
		expect(ctx.calls).toBe(3);
	});

	test("hysteresis: a compaction that leaves the context at or above the threshold suppresses until a measurement falls below it", async () => {
		await enable(A);
		await say("set minGapMinutes 5");
		const rt = new AutoCompactRuntime();
		const ctx = fakeCtx();
		ctx.after = 85; // still at the threshold
		await runBoundary(rt, ctx);
		expect(stored().sessions[A].suppressed).toBe(true);
		expect(log().at(-1)).toBe("compacted 90 -> 85");
		clock += 120 * MIN;
		ctx.usage = 92;
		await runBoundary(rt, ctx);
		expect(ctx.calls).toBe(1);
		expect(log().at(-1)).toBe("skipped: suppressed: context still above threshold 92");
		rt.bind(ctx);
		expect(await rt.command(["status"], host())).toContain("SUPPRESSED");
		ctx.usage = 40; // below: suppression ends (and the episode)
		await runBoundary(rt, ctx);
		expect(stored().sessions[A].suppressed).toBeUndefined();
		ctx.usage = 91;
		await runBoundary(rt, ctx);
		expect(ctx.calls).toBe(2);
		// The user can also clear it explicitly.
		fs.writeFileSync(file(), JSON.stringify({ ...stored(), sessions: { [A]: { touched: NOW, attempts: [], suppressed: true } } }));
		expect(await say("reset-suppression")).toContain("cleared");
		clock += 120 * MIN;
		await runBoundary(rt, ctx);
		expect(ctx.calls).toBe(3);
	});

	test("after-percent unknown after a success: logged without it, not suppressed (cooldown and hourly cap still apply)", async () => {
		await enable(A);
		const rt = new AutoCompactRuntime();
		const ctx = fakeCtx();
		ctx.after = undefined;
		await runBoundary(rt, ctx);
		expect(log().at(-1)).toBe("compacted 90");
		expect(stored().sessions[A].suppressed).toBeUndefined();
		expect(ctx.notes.at(-1)?.message).toBe("auto-compact: compacted at 90% (now unknown)");
	});

	test("failure through onError AND a rejected promise is one failure: counted, cooldown set, no unhandled rejection, no error text kept", async () => {
		await enable(A);
		const unhandled: unknown[] = [];
		const trap = (reason: unknown) => void unhandled.push(reason);
		process.on("unhandledRejection", trap);
		try {
			const rt = new AutoCompactRuntime();
			const ctx = fakeCtx();
			ctx.compactImpl = async options => {
				const error = new Error(`401 invalid key ${FAKE_KEY} for prompt 'secret plan'`);
				options.onError?.(error);
				throw error;
			};
			await runBoundary(rt, ctx);
			await tickLoop(); // let any stray rejection surface
			expect(unhandled).toEqual([]);
			expect(ctx.calls).toBe(1);
			expect(log().at(-1)).toBe("failed: compaction error 90");
			expect(ctx.notes).toEqual([{ message: "auto-compact: compaction failed at 90%; no retry before the 30-minute cooldown, at most 2 attempt(s) per hour", type: "warning" }]);
			const text = fs.readFileSync(file(), "utf8");
			expect(text).not.toContain(FAKE_KEY);
			expect(text).not.toContain("secret plan");
			expect(stored().sessions[A].attempts).toEqual([NOW]); // the failure counted toward the hourly limit
			ctx.usage = 95;
			await runBoundary(rt, ctx); // no tight retry
			expect(ctx.calls).toBe(1);
			expect(log().at(-1)).toBe("skipped: cooldown 95");
		} finally {
			process.off("unhandledRejection", trap);
		}
	});

	test("a rejected promise alone, a synchronous throw, and onError alone each count as one failure; resolve-only counts as success", async () => {
		const cases: Array<[string, FakeCtx["compactImpl"], string]> = [
			["reject", async () => { throw new Error("nope"); }, "failed: compaction error 90"],
			["throw", (() => { throw new Error("sync"); }) as FakeCtx["compactImpl"], "failed: compaction error 90"],
			["onError", async options => { options.onError?.(new Error("x")); }, "failed: compaction error 90"],
			["resolve only", async () => {}, "compacted 90 -> 90"],
		];
		for (const [name, impl, expected] of cases) {
			fs.rmSync(file(), { force: true });
			await enable(A);
			const rt = new AutoCompactRuntime();
			const ctx = fakeCtx();
			ctx.compactImpl = impl;
			await runBoundary(rt, ctx);
			expect(`${name}: ${log().at(-1)}`).toBe(`${name}: ${expected}`);
			expect(stored().sessions[A].attempts).toHaveLength(1);
			expect(ctx.pendingTimers()).toBe(0);
		}
	});

	test("a second compaction cannot start while ours is in flight", async () => {
		await enable(A);
		const rt = new AutoCompactRuntime();
		const ctx = fakeCtx();
		const release = Promise.withResolvers<void>();
		ctx.compactImpl = async options => {
			await release.promise;
			ctx.usage = 20;
			options.onComplete?.();
		};
		rt.onAgentEnd(ctx, host());
		const first = ctx.fire();
		while (ctx.calls === 0) await tickLoop(); // compact() has started and is parked on `release`
		expect(ctx.calls).toBe(1);
		await runBoundary(rt, ctx); // another agent_end while the compaction is still running
		expect(ctx.calls).toBe(1);
		expect(log().filter(l => l.startsWith("skipped"))).toEqual(["skipped: compaction in flight 90"]);
		release.resolve();
		await first;
		expect(log().at(-1)).toBe("compacted 90 -> 20");
	});

	test("an agent start between the reservation and compact() cancels the attempt and releases the reservation", async () => {
		await enable(A);
		const rt = new AutoCompactRuntime();
		const ctx = fakeCtx();
		await say("set minGapMinutes 5");
		rt.onAgentEnd(ctx, host());
		// The run resumes the instant the check starts: the live re-check sees no boundary.
		const timer = ctx.timers.find(t => !t.cleared)!;
		const running = timer.callback();
		rt.onAgentStart(ctx);
		await running;
		expect(ctx.calls).toBe(0);
		expect(stored().sessions[A]?.attempts ?? []).toEqual([]);
		expect(stored().sessions[A]?.last).toBeUndefined();
	});

	test("a pending message that arrives after the first read but before compact() still wins, and the attempt is released", async () => {
		await enable(A);
		const rt = new AutoCompactRuntime();
		const ctx = fakeCtx();
		let reads = 0;
		ctx.hasPendingMessages = () => ++reads > 1; // clean on the first read, queued by the re-check
		await runBoundary(rt, ctx);
		expect(ctx.calls).toBe(0);
		expect(log().at(-1)).toBe("skipped: pending message 90");
		expect(stored().sessions[A].attempts).toEqual([]);
	});

	test("an unreadable state file means no compaction and no write", async () => {
		await enable(A);
		fs.writeFileSync(file(), "{ corrupt");
		const ctx = fakeCtx();
		const rt = new AutoCompactRuntime();
		rt.onAgentEnd(ctx, host());
		expect(ctx.pendingTimers()).toBe(0); // nothing is scheduled while the policy cannot be read
		expect(ctx.calls).toBe(0);
		expect(fs.readFileSync(file(), "utf8")).toBe("{ corrupt");
	});

	test("session change drops a pending check and the boundary", async () => {
		await enable(A);
		const rt = new AutoCompactRuntime();
		const ctx = fakeCtx();
		rt.onAgentEnd(ctx, host());
		rt.onSessionChange(ctx);
		expect(ctx.pendingTimers()).toBe(0);
		rt.bind(ctx);
		expect(await rt.command(["status"], host())).toContain("would compact at the next safe turn boundary: yes"); // status assumes the next boundary
	});
});

// ---- status is read-only and mirrors the decision ---------------------------------------------------------------

describe("status", () => {
	test("writes nothing (bytes and mtime unchanged), never compacts, and agrees with the real decision", async () => {
		await enable(A);
		const rt = new AutoCompactRuntime();
		const ctx = fakeCtx();
		rt.bind(ctx);
		const before = fs.readFileSync(file());
		const mtime = fs.statSync(file()).mtimeMs;
		for (const [usage, expected] of [[90, "yes"], [84, "no (below threshold)"], [undefined, "no (context unknown)"]] as const) {
			ctx.usage = usage;
			const out = await rt.command(["status"], host());
			expect(out).toContain(`would compact at the next safe turn boundary: ${expected}`);
		}
		ctx.usage = 90;
		ctx.pending = true;
		expect(await rt.command(["status"], host())).toContain("(pending message)");
		ctx.pending = false;
		ctx.idle = false;
		expect(await rt.command(["status"], host())).toContain("(not idle)");
		expect(await rt.command(["log"], host())).toContain("changed: enabled");
		expect(ctx.calls).toBe(0);
		expect(ctx.pendingTimers()).toBe(0);
		expect(fs.readFileSync(file()).equals(before)).toBe(true);
		expect(fs.statSync(file()).mtimeMs).toBe(mtime);
		// The same facts through the real path give the same answer.
		ctx.idle = true;
		const out = await rt.command(["status"], host());
		await runBoundary(rt, ctx);
		expect(out).toContain("would compact at the next safe turn boundary: yes");
		expect(ctx.calls).toBe(1);
	});

	test("shows limiter state, includes the pause refusal, and without a session context says there is nothing to evaluate", async () => {
		await enable(A);
		const rt = new AutoCompactRuntime();
		expect(await rt.command(["status"], host())).toContain("this session: no session context yet");
		const ctx = fakeCtx();
		rt.bind(ctx);
		await pauseSession(home, A, A, NOW);
		const out = await rt.command(["status"], host());
		expect(out).toContain("(paused)");
		expect(out).toContain("this session's limiter: no attempt yet; 0 attempt(s) in the last hour");
	});
});

// ---- Concurrency across real processes ---------------------------------------------------------------------------

describe("concurrency across real processes", () => {
	const spawn = (id: string, kind: string, rounds: number) =>
		Bun.spawn([process.execPath, path.join(import.meta.dir, "child_autocompact.ts"), home, id, kind, String(rounds)], { stdout: "pipe", stderr: "pipe" });
	const ids = ["p0000000000000001", "p0000000000000002", "p0000000000000003", "p0000000000000004"];

	test("four processes adding eligible entries at once lose none and never exceed the cap", async () => {
		const codes = await Promise.all(ids.map(id => spawn(id, "add", 8).exited));
		expect(codes).toEqual([0, 0, 0, 0]);
		const state = stored();
		expect(state.eligible).toHaveLength(MAX_ELIGIBLE);
		expect(new Set(state.eligible).size).toBe(MAX_ELIGIBLE);
		expect(state.log.filter(e => e.reason === "eligible")).toHaveLength(MAX_ELIGIBLE);
		const extra = Bun.spawn([process.execPath, path.join(import.meta.dir, "child_autocompact.ts"), home, "p0000000000000009", "add", "1"], { stdout: "pipe", stderr: "pipe" });
		expect(await extra.exited).toBe(1); // the 33rd is refused ("error: eligible list is full")
		expect(stored().eligible).toHaveLength(MAX_ELIGIBLE);
	});

	test("three processes racing 40 logged changes each leave a valid log of exactly 100 events", async () => {
		const codes = await Promise.all([spawn(ids[0], "toggle:60", 40), spawn(ids[1], "toggle:70", 40), spawn(ids[2], "toggle:80", 40)].map(c => c.exited));
		expect(codes).toEqual([0, 0, 0]);
		const state = stored();
		expect(state.log).toHaveLength(MAX_LOG);
		expect(state.log.every(e => e.outcome === "changed" && e.reason === "settings")).toBe(true);
		expect(state.log.map(e => e.at)).toEqual([...state.log.map(e => e.at)].sort((a, b) => a - b));
		expect(await say("status")).toContain("auto-compact: off");
	});

	test("in-process evaluations of two sessions interleaved with a child keep both limiter records", async () => {
		await say("on");
		await say(`add ${A}`);
		await say(`add ${B}`);
		const child = spawn(ids[3], "toggle:60", 20);
		for (const self of [A, B]) {
			const ctx = fakeCtx();
			await runBoundary(new AutoCompactRuntime(), ctx, self);
			expect(ctx.calls).toBe(1);
		}
		expect(await child.exited).toBe(0);
		const state = stored();
		expect(Object.keys(state.sessions).sort()).toEqual([A, B]);
		expect(state.log.filter(e => e.outcome === "compacted").map(e => e.session).sort()).toEqual([A, B]);
	});
});
