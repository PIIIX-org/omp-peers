// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FEATURES } from "../../lib/features";
import type { FeatureHost, PeerView, SendResult } from "../../lib/features/host";
import {
	agentContext, evaluate, MAX_ALERTS, MAX_OVERRIDES, readWatchdog, renderCheck, renderStatus, STALE_MS, tick, watchdog, watchdogFile,
	type AlertRecord, type WatchdogState,
} from "../../lib/features/watchdog";

const MASTER = "p00000000000000aa";
const A = "p00000000000000a1";
const B = "p00000000000000b2";
const C = "p00000000000000c3";
const T0 = 1_700_000_000_000;
const MIN = 60_000;

let home: string;
let now: number;
let isMaster: boolean;
let acceptsRemote: boolean;
let live: PeerView[];
let metrics: Record<string, Partial<PeerView>>;
let groups: Record<string, string[]>;
let groupsFail: string | undefined;
let sendResults: Record<string, SendResult>;
let sent: { to: string; text: string }[];
let listed: number;

beforeEach(() => {
	home = fs.mkdtempSync(path.join("/tmp", "opf-"));
	now = T0;
	isMaster = true;
	acceptsRemote = true;
	live = [{ id: MASTER, name: "master" }, { id: A, name: "worker-a" }, { id: B, name: "worker-b" }];
	metrics = {};
	groups = {};
	groupsFail = undefined;
	sendResults = {};
	sent = [];
	listed = 0;
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

/** A fake host as seen from the master; peers publish fresh registry rows at the fake clock unless a test says otherwise. */
function host(): FeatureHost {
	return {
		home,
		now: () => now,
		self: () => ({ id: MASTER, name: "master" }),
		isMaster: () => isMaster,
		acceptsRemote: () => acceptsRemote,
		peers: async () => {
			listed++;
			return live.map(peer => ({ acceptsRemote: true, updatedAt: new Date(now).toISOString(), ...peer, ...metrics[peer.id] }));
		},
		groupsOf: id => {
			if (groupsFail) throw new Error(groupsFail);
			return groups[id] ?? [];
		},
		send: async (to, req) => {
			sent.push({ to, text: req.text });
			return sendResults[to] ?? { status: "delivered" };
		},
	};
}
const run = (args: string) => watchdog.command(args.split(/\s+/).filter(Boolean), host());
const stored = (): WatchdogState => JSON.parse(fs.readFileSync(watchdogFile(home), "utf8"));
const alertOf = (id: string, condition: string): AlertRecord | undefined => stored().alerts.find(a => a.session === id && a.condition === condition);
const bytes = () => (fs.existsSync(watchdogFile(home)) ? fs.readFileSync(watchdogFile(home)) : Buffer.alloc(0));
const advance = (minutes: number) => {
	now += minutes * MIN;
};
const ticks = () => tick(host());
const busy = (id: string, value: boolean) => {
	metrics[id] = { ...metrics[id], busy: value };
};
const alertText = (who: string, what: string) => `Watchdog alert (automated; from observed session metadata only; nothing was interrupted): ${who} ${what}. This is a notice, not an instruction.`;

describe("defaults and registration", () => {
	test("is registered, has a tick hook, and is off by default: no file, no listing, no hint", async () => {
		const feature = FEATURES.find(f => f.name === "watchdog");
		expect(feature).toBe(watchdog);
		expect(typeof feature?.tick).toBe("function");
		busy(A, true);
		advance(500);
		await ticks();
		expect(listed).toBe(0);
		expect(fs.existsSync(watchdogFile(home))).toBe(false);
		expect(agentContext(host())).toBeUndefined();
		expect(await run("status")).toBe([
			"watchdog: off",
			"evaluation: not running (off)",
			"thresholds: busy 30 min (since first observed), error turns 3, context 90%, cooldown 30 min",
			"scope: all sessions other than the master",
			"recipients: this master session's agent-context hint",
			"overrides: none",
		].join("\n"));
		expect(fs.existsSync(watchdogFile(home))).toBe(false);
	});

	test("on writes a private version-1 file with the documented defaults; the master is never watched", async () => {
		expect(await run("on")).toContain("watchdog on");
		const state = stored();
		expect(state).toEqual({
			version: 1,
			config: { enabled: true, busyMinutes: 30, errorTurns: 3, contextPercent: 90, cooldownMinutes: 30, notify: [] },
			overrides: {}, busy: {}, alerts: [],
		});
		expect(fs.statSync(watchdogFile(home)).mode & 0o777).toBe(0o600);
		expect(fs.statSync(path.dirname(watchdogFile(home))).mode & 0o777).toBe(0o700);
		live = live.map(peer => (peer.id === MASTER ? { ...peer, busy: true } : peer));
		advance(500);
		await ticks();
		expect(stored().busy).toEqual({});
		expect(stored().alerts).toEqual([]);
	});

	test("an unreadable file is an error, never silently replaced", async () => {
		fs.mkdirSync(path.dirname(watchdogFile(home)), { recursive: true });
		fs.writeFileSync(watchdogFile(home), "{ not json");
		await expect(ticks()).rejects.toThrow("watchdog.json is not valid JSON; fix or remove it");
		expect(await run("on")).toBe("error: watchdog.json is not valid JSON; fix or remove it");
		fs.writeFileSync(watchdogFile(home), JSON.stringify({ version: 2 }));
		expect(await run("status")).toBe("error: watchdog.json is invalid: unsupported version (expected 1)");
		expect(JSON.parse(bytes().toString())).toEqual({ version: 2 });
	});
});

describe("master-only configuration", () => {
	test("on, off, set, override, clear-override and ack refuse a non-master and write nothing", async () => {
		isMaster = false;
		const denied = "error: only the master session may change watchdog settings; run /peers master first";
		for (const args of ["on", "off", "set busyMinutes 10", "override worker-a --off", "clear-override worker-a", "ack worker-a busy"]) expect(await run(args)).toBe(denied);
		expect(fs.existsSync(watchdogFile(home))).toBe(false);
	});

	test("status and check work from a non-master and say evaluation is the master's job", async () => {
		await run("on");
		isMaster = false;
		expect(await run("status")).toContain("evaluation: runs only in the master session; this session is not the master");
		expect(await run("check")).toContain("this session is not the master: the periodic evaluation runs only in the master session; this previews it");
	});

	test("tick does nothing in a non-master session even when on and a session is far over a threshold", async () => {
		await run("on");
		busy(A, true);
		advance(500);
		isMaster = false;
		await ticks();
		expect(listed).toBe(0);
		expect(stored().alerts).toEqual([]);
		expect(stored().busy).toEqual({});
	});
});

describe("range validation", () => {
	test("every threshold rejects values outside its range and non-integers with the exact text, and keeps the file", async () => {
		await run("on");
		const cases: [string, string[], string[]][] = [
			["busyMinutes", ["0", "1441", "-1", "1.5", "abc", "", "100000"], ["010", "1", "1440"]],
			["errorTurns", ["1", "51", "x"], ["2", "50"]],
			["contextPercent", ["49", "100", "9e1"], ["50", "99"]],
			["cooldownMinutes", ["0", "1441"], ["1", "1440"]],
		];
		const text: Record<string, string> = {
			busyMinutes: "busyMinutes must be a whole number from 1 to 1440",
			errorTurns: "errorTurns must be a whole number from 2 to 50",
			contextPercent: "contextPercent must be a whole number from 50 to 99",
			cooldownMinutes: "cooldownMinutes must be a whole number from 1 to 1440",
		};
		for (const [key, bad, good] of cases) {
			const before = bytes();
			for (const value of bad) expect(await run(`set ${key} ${value}`)).toBe(value ? `error: ${text[key]}` : "usage: /peers watchdog on | off | status | check | set <busyMinutes|errorTurns|contextPercent|cooldownMinutes|scope|notify> <value...> | override <peer> [--busy-minutes N] [--context-percent N] [--error-turns N] [--off] | clear-override <peer> | ack <peer> <busy|context|errors>");
			expect(bytes().equals(before)).toBe(true);
			for (const value of good) expect(await run(`set ${key} ${value}`)).toBe(`${key} set to ${Number(value)}`);
		}
		expect(stored().config).toMatchObject({ busyMinutes: 1440, errorTurns: 50, contextPercent: 99, cooldownMinutes: 1440 });
		expect(await run("set busyMinutes 5 6")).toBe("error: busyMinutes must be a whole number from 1 to 1440");
		expect(await run("set nothing 5")).toBe('error: unknown key "nothing"; keys: busyMinutes, errorTurns, contextPercent, cooldownMinutes, scope, notify');
	});

	test("override options validate the same ranges and reject unknown, repeated-off and mixed forms", async () => {
		const before = bytes();
		expect(await run("override worker-a --busy-minutes 0")).toBe("error: --busy-minutes must be a whole number from 1 to 1440");
		expect(await run("override worker-a --busy-minutes")).toBe("error: --busy-minutes must be a whole number from 1 to 1440");
		expect(await run("override worker-a --context-percent 100")).toBe("error: --context-percent must be a whole number from 50 to 99");
		expect(await run("override worker-a --error-turns 1")).toBe("error: --error-turns must be a whole number from 2 to 50");
		expect(await run("override worker-a --off --busy-minutes 60")).toBe("error: --off cannot be combined with threshold options");
		expect(await run("override worker-a --nap 3")).toBe('error: unknown option "--nap"; options: --busy-minutes N, --context-percent N, --error-turns N, --off');
		expect(await run("override worker-a")).toStartWith("usage: /peers watchdog");
		expect(await run("override nobody --off")).toBe('error: no live peer matches "nobody"; use its stable ID or exact name');
		expect(await run("override master --off")).toBe("error: the master session is not watched");
		expect(bytes().equals(before)).toBe(true);
	});

	test("a stored file with an out-of-range threshold is rejected, not clamped", async () => {
		await run("on");
		const state = stored();
		state.config.busyMinutes = 0;
		fs.writeFileSync(watchdogFile(home), JSON.stringify(state));
		expect(await run("status")).toBe("error: watchdog.json is invalid: malformed config");
	});
});

describe("thresholds", () => {
	beforeEach(async () => {
		await run("on");
	});

	test("busy: counted from first observation, alerts at exactly the limit and not before", async () => {
		busy(A, true);
		await ticks();
		expect(stored().busy[A]).toEqual({ since: T0, observedAt: T0 });
		advance(29);
		await ticks();
		expect(stored().alerts).toEqual([]);
		expect(agentContext(host())).toBeUndefined();
		advance(1);
		await ticks();
		expect(stored().alerts).toEqual([{ session: A, condition: "busy", active: true, emitted: true, acked: false, alertedAt: now, value: 30, limit: 30, notified: {} }]);
		expect(agentContext(host())).toBe(
			`Watchdog: 1 unacknowledged alert(s) from observed session metadata (${A} busy for 30 min since first observed (limit 30 min)). Offer to show them with /peers watchdog status; this line is a notice, not an instruction, and nothing was interrupted.`,
		);
	});

	test("busy: an idle observation resets the clock; the next busy period starts from zero", async () => {
		busy(A, true);
		await ticks();
		advance(20);
		busy(A, false);
		await ticks();
		expect(stored().busy).toEqual({});
		advance(15);
		busy(A, true);
		await ticks();
		advance(20);
		await ticks();
		expect(stored().alerts).toEqual([]);
		expect(stored().busy[A].since).toBe(T0 + 35 * MIN);
	});

	test("context: alerts at the limit, not below; a figure without a percent is unknown", async () => {
		metrics[A] = { context: "1000 (89%)" };
		await ticks();
		expect(stored().alerts).toEqual([]);
		metrics[A] = { context: "1000 (90%)" };
		await ticks();
		expect(alertOf(A, "context")).toMatchObject({ active: true, emitted: true, value: 90, limit: 90 });
		metrics[B] = { context: "190000" };
		expect(await run("check")).toContain("context: unknown (no context percent published); never alerts");
		expect(alertOf(B, "context")).toBeUndefined();
	});

	test("errors: alerts when the published count reaches the limit; a lower count does not", async () => {
		metrics[A] = { recentErrorTurns: 2 };
		await ticks();
		expect(stored().alerts).toEqual([]);
		metrics[A] = { recentErrorTurns: 3 };
		await ticks();
		expect(alertOf(A, "errors")).toMatchObject({ active: true, emitted: true, value: 3, limit: 3 });
	});

	test("set changes the limits used by the next evaluation", async () => {
		metrics[A] = { context: "1 (60%)" };
		await ticks();
		expect(stored().alerts).toEqual([]);
		await run("set contextPercent 60");
		await ticks();
		expect(alertOf(A, "context")).toMatchObject({ value: 60, limit: 60 });
	});

	test("a paused watched session still counts for busy, context and errors, and is marked paused", async () => {
		metrics[A] = { paused: true, busy: true, context: "1 (95%)", recentErrorTurns: 4 };
		advance(0);
		await ticks();
		advance(30);
		await ticks();
		expect(stored().alerts.map(a => a.condition).sort()).toEqual(["busy", "context", "errors"]);
		expect(await run("status")).toContain("worker-a (p00000000000000a1) [paused]");
	});
});

describe("unknown data is explicit and never alerts", () => {
	beforeEach(async () => {
		await run("on");
	});

	test("an old peer without busy, context or recentErrorTurns shows three unknowns, with reasons, and nothing is alerted", async () => {
		advance(1000);
		await ticks();
		expect(stored().alerts).toEqual([]);
		const status = await run("status");
		expect(status).toContain([
			"  worker-a (p00000000000000a1)",
			"    busy: unknown (busy state not published); never alerts",
			"    context: unknown (no context percent published); never alerts",
			"    errors: unknown (peer does not publish recentErrorTurns (older plugin version)); never alerts",
		].join("\n"));
	});

	test("a stale registry entry makes every condition unknown, keeps the busy record, and keeps an existing alert", async () => {
		busy(A, true);
		await ticks();
		advance(30);
		await ticks();
		expect(alertOf(A, "busy")?.active).toBe(true);
		const staleAt = new Date(now - STALE_MS - 5000).toISOString();
		metrics[A] = { busy: true, context: "1 (99%)", recentErrorTurns: 9, updatedAt: staleAt };
		live = live.map(peer => (peer.id === A ? { ...peer, updatedAt: staleAt } : peer));
		await ticks();
		expect(alertOf(A, "busy")).toMatchObject({ active: true, emitted: true });
		expect(alertOf(A, "context")).toBeUndefined();
		expect(alertOf(A, "errors")).toBeUndefined();
		expect(stored().busy[A].since).toBe(T0);
		expect(await run("check")).toContain("busy: unknown (registry entry not updated for 65 s); never alerts");
	});

	test("unknown does not clear an alert; a known ok does", async () => {
		metrics[A] = { recentErrorTurns: 3 };
		await ticks();
		expect(alertOf(A, "errors")?.active).toBe(true);
		metrics[A] = {};
		await ticks();
		expect(alertOf(A, "errors")).toMatchObject({ active: true, emitted: true });
		metrics[A] = { recentErrorTurns: 0 };
		await ticks();
		expect(alertOf(A, "errors")).toMatchObject({ active: false, emitted: false });
	});

	test("a session that is not running is not evaluated; its busy record and alerts end, and status lists no row for it", async () => {
		busy(A, true);
		await ticks();
		advance(30);
		await ticks();
		live = live.filter(peer => peer.id !== A);
		await ticks();
		expect(stored().busy).toEqual({});
		expect(alertOf(A, "busy")).toMatchObject({ active: false });
		expect(agentContext(host())).toBeUndefined();
		expect(await run("status")).not.toContain("worker-a");
	});
});

describe("deduplication, cooldown and re-arm", () => {
	beforeEach(async () => {
		await run("on");
		await run("set cooldownMinutes 60");
	});

	test("a continuing condition alerts exactly once however long it lasts", async () => {
		await run("set notify worker-b");
		metrics[A] = { recentErrorTurns: 5 };
		for (let i = 0; i < 20; i++) {
			await ticks();
			advance(10);
		}
		expect(sent).toHaveLength(1);
		expect(alertOf(A, "errors")?.alertedAt).toBe(T0);
	});

	test("it re-arms only after the condition clears, and a re-trigger inside the cooldown waits for the cooldown to pass", async () => {
		await run("set notify worker-b");
		metrics[A] = { recentErrorTurns: 3 };
		await ticks();
		expect(sent).toHaveLength(1);
		advance(5);
		metrics[A] = { recentErrorTurns: 0 };
		await ticks();
		advance(5);
		metrics[A] = { recentErrorTurns: 3 };
		await ticks();
		expect(sent).toHaveLength(1);
		expect(alertOf(A, "errors")).toMatchObject({ active: true, emitted: false, alertedAt: T0 });
		expect(agentContext(host())).toBeUndefined();
		expect(await run("check")).toContain(`errors: 3 consecutive error turns (limit 3): triggered again; no alert until ${new Date(T0 + 60 * MIN).toISOString()} (cooldown)`);
		advance(49);
		await ticks();
		expect(sent).toHaveLength(1);
		advance(1);
		await ticks();
		expect(sent).toHaveLength(2);
		expect(alertOf(A, "errors")).toMatchObject({ active: true, emitted: true, acked: false, alertedAt: now });
	});

	test("after the cooldown a cleared and re-triggered condition alerts again immediately", async () => {
		metrics[A] = { recentErrorTurns: 3 };
		await ticks();
		advance(61);
		metrics[A] = { recentErrorTurns: 0 };
		await ticks();
		metrics[A] = { recentErrorTurns: 4 };
		await ticks();
		expect(alertOf(A, "errors")).toMatchObject({ active: true, emitted: true, alertedAt: now, value: 4 });
	});

	test("different sessions and different conditions alert independently", async () => {
		metrics[A] = { recentErrorTurns: 3, context: "1 (91%)" };
		metrics[B] = { recentErrorTurns: 3 };
		await ticks();
		expect(stored().alerts.map(a => `${a.session}:${a.condition}`).sort()).toEqual([`${A}:context`, `${A}:errors`, `${B}:errors`]);
	});
});

describe("acknowledge", () => {
	beforeEach(async () => {
		await run("on");
		metrics[A] = { recentErrorTurns: 3 };
		await ticks();
	});

	test("ack silences the hint until the condition clears and triggers again", async () => {
		expect(agentContext(host())).toContain(`${A} 3 consecutive assistant turns ended in an error (limit 3)`);
		expect(await run("ack worker-a errors")).toBe(`acknowledged ${A} errors: no further alert until it clears and triggers again`);
		expect(agentContext(host())).toBeUndefined();
		expect(await run("status")).toContain("alerted " + new Date(T0).toISOString() + ", acknowledged; still active, no further alert until it clears");
		expect(await run("ack worker-a errors")).toBe(`error: ${A} errors is already acknowledged`);
		advance(31);
		await ticks();
		expect(agentContext(host())).toBeUndefined();
		metrics[A] = { recentErrorTurns: 0 };
		await ticks();
		metrics[A] = { recentErrorTurns: 3 };
		await ticks();
		expect(alertOf(A, "errors")).toMatchObject({ acked: false, emitted: true });
		expect(agentContext(host())).toContain(A);
	});

	test("ack needs an active, alerted condition and a known condition name", async () => {
		expect(await run("ack worker-a busy")).toBe(`error: no active alert for ${A} busy to acknowledge`);
		expect(await run("ack worker-a disk")).toBe("error: condition must be one of busy, context, errors");
		expect(await run("ack worker-a")).toStartWith("usage: /peers watchdog");
	});
});

describe("per-session overrides", () => {
	beforeEach(async () => {
		await run("on");
	});

	test("a long legitimate task: raising busy minutes for one session keeps it quiet while the others still alert", async () => {
		expect(await run("override worker-a --busy-minutes 240")).toBe(`override for ${A}: busy 240 min (replaces any earlier override for it)`);
		busy(A, true);
		busy(B, true);
		await ticks();
		advance(100);
		await ticks();
		expect(stored().alerts.map(a => `${a.session}:${a.condition}`)).toEqual([`${B}:busy`]);
		advance(140);
		await ticks();
		expect(alertOf(A, "busy")).toMatchObject({ value: 240, limit: 240 });
		expect(await run("status")).toContain(`worker-a (${A}) [override: busy 240 min]`);
	});

	test("--off stops watching the session entirely, drops its busy record and ends its alerts", async () => {
		metrics[A] = { busy: true, recentErrorTurns: 9, context: "1 (99%)" };
		advance(0);
		await ticks();
		advance(40);
		await ticks();
		expect(stored().alerts.filter(a => a.active)).toHaveLength(3);
		await run("override worker-a --off");
		await ticks();
		expect(stored().alerts.filter(a => a.active)).toHaveLength(0);
		expect(stored().busy).toEqual({});
		const status = await run("status");
		expect(status).toContain("busy: not evaluated (override --off)");
		expect(status).toContain("[override: off (not watched)]");
		expect(agentContext(host())).toBeUndefined();
	});

	test("overrides replace, apply per threshold, clear, and key on the stable id across a rename", async () => {
		await run("override worker-a --context-percent 70 --error-turns 5");
		await run("override worker-a --context-percent 80");
		expect(stored().overrides).toEqual({ [A]: { contextPercent: 80 } });
		metrics[A] = { context: "1 (80%)", recentErrorTurns: 3 };
		live = live.map(peer => (peer.id === A ? { ...peer, name: "renamed" } : peer));
		await ticks();
		expect(stored().alerts.map(a => a.condition)).toEqual(["context", "errors"]);
		expect(await run(`clear-override ${A}`)).toBe(`override for ${A} cleared; the global thresholds apply again`);
		expect(stored().overrides).toEqual({});
		expect(await run(`clear-override ${A}`)).toBe(`error: no override for ${A}`);
	});

	test("an override can be set for a session that is not running (by stable id) and shows as not running", async () => {
		expect(await run(`override ${C} --off`)).toBe(`override for ${C}: off (not watched) (replaces any earlier override for it)`);
		expect(await run("status")).toContain(`${C} (not running): off (not watched)`);
	});

	test("at most MAX_OVERRIDES overrides", async () => {
		const state = stored();
		for (let i = 0; i < MAX_OVERRIDES; i++) state.overrides[`p${(0x100000 + i).toString(16)}`] = { off: true };
		fs.writeFileSync(watchdogFile(home), JSON.stringify(state));
		expect(await run("override worker-a --off")).toBe(`error: too many overrides (${MAX_OVERRIDES}); clear one first`);
		expect(await run(`override p100000 --busy-minutes 5`)).toStartWith("override for p100000");
	});
});

describe("recipients", () => {
	beforeEach(async () => {
		await run("on");
		metrics[A] = { busy: true };
	});

	const fire = async () => {
		await ticks();
		advance(30);
		await ticks();
	};

	test("default recipient is the master's own hint only: no message is sent", async () => {
		await fire();
		expect(alertOf(A, "busy")?.emitted).toBe(true);
		expect(sent).toEqual([]);
		expect(alertOf(A, "busy")?.notified).toEqual({});
	});

	test("a notify peer gets one metadata-only message through host.send, and the outcome is recorded", async () => {
		expect(await run("set notify worker-b")).toBe(`notify set to ${B}: each alert is also sent as an ordinary peer message (a live idle recipient may start a turn; a paused one gets nothing)`);
		await fire();
		expect(sent).toEqual([{ to: B, text: alertText(`worker-a (${A})`, "busy for 30 min since first observed (limit 30 min)") }]);
		expect(alertOf(A, "busy")?.notified).toEqual({ [B]: "delivered" });
	});

	test("a paused recipient gets nothing and the status says not delivered; it is not tried again for a still-active alert", async () => {
		await run("set notify worker-b");
		metrics[B] = { paused: true };
		await fire();
		expect(sent).toEqual([]);
		expect(alertOf(A, "busy")?.notified).toEqual({ [B]: "not delivered: worker-b is paused (only its user can resume it)" });
		const status = await run("status");
		expect(status).toContain(`notify ${B}: not delivered: worker-b is paused (only its user can resume it)`);
		advance(200);
		metrics[B] = { paused: false };
		await ticks();
		expect(sent).toEqual([]);
	});

	test("a recipient that refuses remote requests, is gone, or fails is reported as not delivered with the reason", async () => {
		await run(`set notify ${B} ${C}`);
		metrics[B] = { acceptsRemote: false };
		await fire();
		expect(sent).toEqual([]);
		expect(alertOf(A, "busy")?.notified).toEqual({ [B]: "not delivered: worker-b does not accept remote requests", [C]: "not delivered: session is not live" });
		metrics[B] = { acceptsRemote: true };
		metrics[A] = { busy: false };
		await ticks();
		metrics[A] = { busy: true };
		advance(100);
		sendResults[B] = { status: "failed", reason: "rate limited\nretry later" };
		await ticks();
		advance(30);
		await ticks();
		expect(alertOf(A, "busy")?.notified[B]).toBe("not delivered: rate limited retry later");
		sendResults[B] = { status: "offline" };
		metrics[A] = { busy: false };
		await ticks();
		metrics[A] = { busy: true };
		advance(100);
		await ticks();
		advance(30);
		await ticks();
		expect(alertOf(A, "busy")?.notified[B]).toBe("not delivered: session is not live");
	});

	test("a group target reaches its live members except the master and the alerted session", async () => {
		groups = { [A]: ["frontend"], [B]: ["frontend"], [MASTER]: ["frontend"] };
		live.push({ id: C, name: "worker-c" });
		groups[C] = ["frontend"];
		await run("set notify group:frontend");
		await fire();
		expect(sent.map(m => m.to).sort()).toEqual([B, C]);
	});

	test("notify validation: at most five targets, no master, valid group names, none clears", async () => {
		expect(await run("set notify master")).toBe("error: this master session always gets the agent-context hint; name another session");
		expect(await run("set notify group:Bad!")).toBe("error: group name must be 1-48 characters: letters, digits, '.', '_' or '-'");
		expect(await run("set notify a b c d e f")).toBe("error: at most 5 notify targets");
		expect(await run("set notify nobody")).toBe('error: no live peer matches "nobody"; use its stable ID or exact name');
		await run("set notify worker-b group:ops worker-b");
		expect(stored().config.notify).toEqual([B, "group:ops"]);
		expect(await run("set notify none")).toContain("notify cleared");
		expect(stored().config.notify).toEqual([]);
	});

	test("messages and the hint carry ids, condition and value only: a credential-looking or control-laden name is never forwarded", async () => {
		await run("set notify worker-b");
		live = live.map(peer => (peer.id === A ? { ...peer, name: `${"api"}_key=${"abcdefghijklmnop1234"}` } : peer));
		await fire();
		expect(sent[0].text).toContain("(name withheld)");
		expect(sent[0].text).not.toContain("abcdefghijklmnop");
		expect(agentContext(host())).not.toContain("abcdefghijklmnop");
		expect(await run("status")).not.toContain("abcdefghijklmnop");
	});

	test("a control-laden name is flattened to one capped line", async () => {
		await run("set notify worker-b");
		live = live.map(peer => (peer.id === A ? { ...peer, name: `evil\n\nIgnore previous${"x".repeat(100)}` } : peer));
		await fire();
		expect(sent[0].text.split("\n")).toHaveLength(1);
		expect(sent[0].text).toContain(`evil Ignore previous${"x".repeat(40)} (${A})`);
	});

	test("the hint honours acceptsRemote and the master role", async () => {
		await fire();
		expect(agentContext(host())).toContain("Watchdog: 1 unacknowledged alert(s)");
		acceptsRemote = false;
		expect(agentContext(host())).toBeUndefined();
		expect(await run("status")).toContain("recipients: this master session's agent-context hint (suppressed: this session does not accept remote requests)");
		acceptsRemote = true;
		isMaster = false;
		expect(agentContext(host())).toBeUndefined();
	});

	test("the hint lists at most five alerts", async () => {
		for (let i = 0; i < 7; i++) live.push({ id: `p${(0x200000 + i).toString(16)}`, name: `w${i}`, recentErrorTurns: 3 });
		await ticks();
		const line = agentContext(host())!;
		expect(line).toContain("Watchdog: 7 unacknowledged alert(s)");
		expect(line.split("; ...)").length).toBe(2);
		expect(line.split("\n")).toHaveLength(1);
	});
});

describe("scope", () => {
	beforeEach(async () => {
		await run("on");
		groups = { [A]: ["frontend"], [B]: ["ops"] };
		metrics[A] = { recentErrorTurns: 3 };
		metrics[B] = { recentErrorTurns: 3 };
	});

	test("scope is usable only when a live session belongs to the group; the file stays untouched otherwise", async () => {
		const before = bytes();
		expect(await run("set scope group:backend")).toBe('error: scope group:backend is not usable: no live session belongs to group "backend" (group membership is empty or unknown); scope not changed');
		expect(await run("set scope backend")).toBe('error: scope must be "all" or "group:<name>" (name: 1-48 characters: letters, digits, \'.\', \'_\' or \'-\')');
		groupsFail = "registry unreadable";
		expect(await run("set scope group:frontend")).toBe("error: scope not changed: group membership cannot be read: registry unreadable");
		expect(bytes().equals(before)).toBe(true);
	});

	test("with no group membership at all (groupsOf empty for everyone) the scope cannot be set", async () => {
		groups = {};
		expect((await run("set scope group:frontend"))).toContain("no live session belongs to group");
	});

	test("a scoped watchdog watches only the group's members and counts the others as not watched; all restores the default", async () => {
		expect(await run("set scope group:frontend")).toBe("scope set to group:frontend");
		await ticks();
		expect(stored().alerts.map(a => a.session)).toEqual([A]);
		const status = await run("status");
		expect(status).toContain("scope: group:frontend");
		expect(status).toContain("1 live session(s) outside the scope are not watched");
		expect(status).not.toContain("worker-b (");
		expect(await run("set scope all")).toBe("scope set to all sessions other than the master");
		await ticks();
		expect(stored().alerts.map(a => a.session).sort()).toEqual([A, B]);
	});

	test("a session that leaves the scope has its busy record and alerts ended", async () => {
		await run("set scope group:frontend");
		await ticks();
		expect(alertOf(A, "errors")?.active).toBe(true);
		groups[A] = ["elsewhere"];
		groups[C] = ["frontend"];
		live.push({ id: C, name: "worker-c" });
		await ticks();
		expect(alertOf(A, "errors")?.active).toBe(false);
	});

	test("when membership cannot be read the evaluation watches nothing and says why", async () => {
		await run("set scope group:frontend");
		await ticks();
		groupsFail = "registry unreadable";
		await ticks();
		expect(await run("status")).toContain("scope cannot be evaluated: group membership cannot be read: registry unreadable; nothing is watched");
		// unknown membership is not evidence that the condition cleared
		expect(alertOf(A, "errors")?.active).toBe(true);
	});
});

describe("status and check are read-only and mirror the real evaluation", () => {
	beforeEach(async () => {
		await run("on");
		await run("set notify worker-b");
		busy(A, true);
		metrics[A] = { busy: true, context: "1 (95%)" };
		metrics[B] = { paused: true };
		advance(0);
	});

	test("check previews exactly what the next tick alerts, sends nothing and leaves the file byte-identical", async () => {
		const before = bytes();
		const out = await run("check");
		expect(sent).toEqual([]);
		expect(bytes().equals(before)).toBe(true);
		expect(out).toContain("watchdog check (read-only: nothing is sent and no state is written)");
		expect(out).toContain("context: context 95% (limit 90%): WOULD ALERT now");
		expect(out).toContain(`would alert: worker-a (${A}) context at 95% (limit 90%)`);
		expect(out).toContain(`would notify worker-b (${B}): not delivered: worker-b is paused (only its user can resume it)`);
		expect(out).toContain("busy: busy 0 min since first observed " + new Date(T0).toISOString() + " (limit 30 min), ok");
		expect(stored().busy).toEqual({});
		await ticks();
		expect(stored().alerts.map(a => `${a.session}:${a.condition}`)).toEqual([`${A}:context`]);
		expect(await run("check")).toContain("would alert: nothing");
	});

	test("status never writes, never sends and never contacts anyone beyond listing the roster", async () => {
		await ticks();
		const before = bytes();
		const out = await run("status");
		expect(bytes().equals(before)).toBe(true);
		expect(sent).toEqual([]);
		expect(out).toContain("watchdog: on");
		expect(out).toContain("evaluation: runs in this session (the master) every 5 s");
		expect(out).toContain("recipients: this master session's agent-context hint; peer message to worker-b (p00000000000000b2)");
		expect(out).toContain(`alerted ${new Date(T0).toISOString()}; still active, no further alert until it clears`);
		expect(out).toContain(`notify ${B}: not delivered: worker-b is paused (only its user can resume it)`);
		expect(out.endsWith("active alerts: 1 (1 unacknowledged)")).toBe(true);
		expect(await renderStatus(host())).toBe(out);
	});

	test("the very first status shows a triggered condition as due at the next evaluation, mirroring the tick that follows", async () => {
		const out = await run("status");
		expect(out).toContain("context: context 95% (limit 90%): TRIGGERED; the alert is due at the next evaluation (within 5 s)");
		expect(fs.readFileSync(watchdogFile(home), "utf8")).not.toContain(`"session"`);
	});

	test("check and status do not create state when the watchdog was never turned on, and evaluate does not mutate its input", async () => {
		fs.rmSync(watchdogFile(home));
		expect(await renderCheck(host())).toContain("watchdog is off: the periodic evaluation does nothing; this previews the current settings");
		expect(fs.existsSync(watchdogFile(home))).toBe(false);
		const state = readWatchdog(host());
		const copy = structuredClone(state);
		const evaluation = evaluate({ ...state, config: { ...state.config, enabled: true } }, await host().peers(), now, MASTER, () => []);
		expect(evaluation.emitted.length).toBe(1);
		expect(state).toEqual(copy);
	});
});

describe("evaluate is pure", () => {
	test("refreshing a busy record, ending an alert and emitting one never touch the input state", async () => {
		await run("on");
		busy(A, true);
		metrics[B] = { recentErrorTurns: 3 };
		await ticks();
		advance(5);
		metrics[B] = { recentErrorTurns: 0 };
		metrics[A] = { busy: true, recentErrorTurns: 3 };
		const state = readWatchdog(host());
		const copy = structuredClone(state);
		const evaluation = evaluate(state, await host().peers(), now, MASTER, () => []);
		expect(state).toEqual(copy);
		expect(evaluation.next.busy[A].observedAt).toBe(now);
		expect(evaluation.next.alerts.find(a => a.session === B)?.active).toBe(false);
		expect(evaluation.emitted.map(e => `${e.session}:${e.condition}`)).toEqual([`${A}:errors`]);
	});
});

describe("persistence across a master restart", () => {
	test("busy-since survives a reload of the state and the next evaluation continues from it", async () => {
		await run("on");
		busy(A, true);
		await ticks();
		advance(25);
		await ticks();
		// restart: every in-memory object is gone, only the file remains
		const onDisk = fs.readFileSync(watchdogFile(home), "utf8");
		expect(JSON.parse(onDisk).busy[A].since).toBe(T0);
		advance(10);
		await ticks();
		expect(alertOf(A, "busy")).toMatchObject({ value: 35, active: true, emitted: true });
		expect(await run("status")).toContain(`busy: busy 35 min since first observed ${new Date(T0).toISOString()} (limit 30 min)`);
	});

	test("an unchanged busy session does not rewrite the file every tick, and observedAt refreshes about once a minute", async () => {
		await run("on");
		busy(A, true);
		await ticks();
		const first = fs.statSync(watchdogFile(home)).mtimeMs;
		const text = bytes();
		now += 5000;
		await ticks();
		expect(bytes().equals(text)).toBe(true);
		expect(fs.statSync(watchdogFile(home)).mtimeMs).toBe(first);
		now += 60_000;
		await ticks();
		expect(stored().busy[A]).toEqual({ since: T0, observedAt: now });
	});

	test("off clears observations and alerts, stops all evaluation, and a later on starts from nothing", async () => {
		await run("on");
		busy(A, true);
		await ticks();
		advance(40);
		await ticks();
		expect(agentContext(host())).toContain(A);
		expect(await run("off")).toBe("watchdog off: evaluation stopped; observed busy durations and alerts were cleared");
		expect(stored()).toMatchObject({ config: { enabled: false }, busy: {}, alerts: [] });
		const calls = listed;
		advance(500);
		await ticks();
		expect(listed).toBe(calls);
		expect(agentContext(host())).toBeUndefined();
		await run("on");
		await ticks();
		expect(stored().busy[A].since).toBe(now);
		expect(stored().alerts).toEqual([]);
	});

	test("off keeps thresholds, scope, recipients and overrides", async () => {
		await run("on");
		await run("set busyMinutes 5");
		await run("set notify worker-b");
		await run("override worker-a --off");
		await run("off");
		expect(stored().config).toMatchObject({ enabled: false, busyMinutes: 5, notify: [B] });
		expect(stored().overrides).toEqual({ [A]: { off: true } });
	});
});

describe("bounds", () => {
	test("alerts are bounded: inactive records go first, then the oldest active ones", async () => {
		await run("on");
		const state = stored();
		state.alerts = Array.from({ length: MAX_ALERTS }, (_, i): AlertRecord => ({
			session: `p${(0x300000 + i).toString(16)}`, condition: "errors", active: i % 2 === 0, emitted: i % 2 === 0, acked: false, alertedAt: T0 - i, value: 3, limit: 3, notified: {},
		}));
		fs.writeFileSync(watchdogFile(home), JSON.stringify(state));
		live.push(...state.alerts.map(alert => ({ id: alert.session, name: "w" })));
		metrics[A] = { recentErrorTurns: 3 };
		await ticks();
		const alerts = stored().alerts;
		expect(alerts).toHaveLength(MAX_ALERTS);
		expect(alerts.some(a => a.session === A)).toBe(true);
		expect(alerts.some(a => a.session === "p300001")).toBe(false);
		expect(alerts.some(a => a.session === "p300000")).toBe(true);
	});

	test("a file with more than MAX_ALERTS alerts is rejected as invalid", async () => {
		await run("on");
		const state = stored();
		state.alerts = Array.from({ length: MAX_ALERTS + 1 }, (_, i): AlertRecord => ({
			session: `p${(0x300000 + i).toString(16)}`, condition: "busy", active: false, emitted: false, acked: false, alertedAt: T0, value: 1, limit: 1, notified: {},
		}));
		fs.writeFileSync(watchdogFile(home), JSON.stringify(state));
		expect(await run("status")).toBe("error: watchdog.json is invalid: malformed alerts");
	});
});

describe("concurrency across real processes", () => {
	const spawn = (id: string, rounds: number) =>
		Bun.spawn([process.execPath, path.join(import.meta.dir, "child_watchdog.ts"), home, MASTER, id, String(rounds)], { stdout: "pipe", stderr: "pipe" });

	test("two processes overriding different sessions while this process ticks lose no update and leave a valid file", async () => {
		await run("on");
		const children = [spawn(A, 10), spawn(B, 10)];
		for (let i = 0; i < 10; i++) {
			busy(C, true);
			live = [...live.filter(peer => peer.id !== C), { id: C, name: "worker-c" }];
			await ticks();
		}
		const codes = await Promise.all(children.map(child => child.exited));
		const errors = await Promise.all(children.map(child => new Response(child.stderr).text()));
		expect(errors).toEqual(["", ""]);
		expect(codes).toEqual([0, 0]);
		await ticks();
		const state = readWatchdog(host());
		expect(state.overrides).toEqual({ [A]: { contextPercent: 77 }, [B]: { contextPercent: 77 } });
		expect(state.config.enabled).toBe(true);
		expect(state.busy[C]?.since).toBe(T0);
	});
});
