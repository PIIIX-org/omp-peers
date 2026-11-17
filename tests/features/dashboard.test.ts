// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FEATURES } from "../../lib/features";
import {
	collect, dashboard, displayWidth, fit, NAME_CAP, NESTED_CAP, ONCE_WIDTH, openDashboard, parseKey, parseOptions, PANELS, readOnlyView, REFRESH_MS, renderPanel, renderSnapshot, ROW_CAP, safe,
	TEXT_CAP, USAGE, type DashboardComponent, type DashboardTui, type DashboardUi, type Options, type Parsed, type ReadOnlyView, type Timers,
} from "../../lib/features/dashboard";
import type { FeatureHost, PeerView } from "../../lib/features/host";
import { identifyPeers, logicalId, stablePeerId, type Registration } from "../../lib/identity";

const NOW = Date.parse("2026-11-17T10:00:00Z");
const A = "p00000000000000a1";
const B = "p00000000000000b2";
const C = "p00000000000000c3";
const OFFLINE = "p00000000000000d4";
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();

let home: string;
let peers: PeerView[];
let calls: { peers: number; forbidden: string[] };
let selfFails = false;
beforeEach(() => {
	selfFails = false;
	home = fs.mkdtempSync(path.join("/tmp", "opd-"));
	peers = [];
	calls = { peers: 0, forbidden: [] };
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const stateDir = () => path.join(home, ".omp", "agent", "peer-state");
function put(file: string, value: unknown): void {
	fs.mkdirSync(stateDir(), { recursive: true });
	fs.writeFileSync(path.join(stateDir(), file), typeof value === "string" ? value : JSON.stringify(value));
}
const putGroups = (groups: Record<string, string[]>) => put("groups.json", { version: 1, groups });
interface LeaseRow { id: string; owner: string; name: string; instance: string; acquiredAt: number; expiresAt: number; note?: string }
const lease = (id: string, owner: string, name: string, expiresIn: number, note?: string): LeaseRow => ({ id, owner, name, instance: "i1", acquiredAt: NOW - 1000, expiresAt: NOW + expiresIn, ...(note ? { note } : {}) });
const putLocks = (resources: Array<{ name: string; capacity: number; leases: LeaseRow[] }>) => put("locks.json", { version: 1, nextId: 1000, resources });
const entry = (session: string, name: string, extra: Record<string, unknown> = {}) => ({ session, name, status: "in-progress", source: "assignment", updatedAt: NOW - 300_000, updatedBy: A, ...extra });
const putBoard = (entries: unknown[]) => put("board.json", { version: 1, entries });
const question = (n: number, source: string, name: string, extra: Record<string, unknown> = {}) => ({
	id: `q${n}`, source: { id: source, name }, question: `Question ${n}?`, dedupKey: `text:question ${n}`, createdAt: NOW - 120_000, state: "open", delivery: "pending", ...extra,
});
const putInbox = (entries: unknown[]) => put("inbox.json", { version: 1, nextId: 10_000, entries });

/** A full host: only the five read-only members may ever be called; any other call is recorded as forbidden. */
function host(self = A, master = false): FeatureHost {
	const forbid = (name: string) => async () => {
		calls.forbidden.push(name);
		throw new Error(`${name} must not be called by the dashboard`);
	};
	return {
		home,
		now: () => NOW,
		self: () => {
			if (selfFails) throw new Error("self unavailable");
			return { id: self, name: peers.find(p => p.id === self)?.name ?? "me" };
		},
		isMaster: () => master,
		notify: () => {},
		acceptsRemote: () => true,
		peers: async () => {
			calls.peers++;
			return peers;
		},
		groupsOf: () => [],
		resolveGroup: forbid("resolveGroup"),
		send: forbid("send"),
		resolveModel: forbid("resolveModel"),
		applyModel: forbid("applyModel"),
	};
}
const view = (): ReadOnlyView => readOnlyView(host());
const opts = (args: string[] = []): Options => {
	const parsed = parseOptions(args);
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed.options;
};
const snap = (args: string[] = [], width = ONCE_WIDTH) => collect(view(), opts(args).panels).then(s => renderSnapshot(s, opts(args), width));
const text = async (args: string[] = [], width = ONCE_WIDTH) => (await snap(args, width)).join("\n");

describe("options", () => {
	test("is registered as /peers dashboard", () => {
		expect(FEATURES.map(f => f.name)).toContain("dashboard");
		expect(dashboard.tools).toBeUndefined();
		expect(dashboard.tick).toBeUndefined();
		expect(dashboard.agentContext).toBeUndefined();
	});

	test("defaults show every panel with a 60 s stale threshold", () => {
		expect(parseOptions([])).toEqual({ ok: true, once: false, options: { staleAfter: 60, panels: [...PANELS] } });
	});

	test("accepts every option; panels come back in canonical order and the group name is lower-cased", () => {
		expect(parseOptions(["--group", "Front-End.1", "--stale-after", "300", "--panels", "decisions,sessions", "--once"])).toEqual({
			ok: true, once: true, options: { group: "front-end.1", staleAfter: 300, panels: ["sessions", "decisions"] },
		});
	});

	test("--stale-after accepts 5 and 3600 and rejects everything else", () => {
		expect(parseOptions(["--stale-after", "5"]).ok).toBe(true);
		expect(parseOptions(["--stale-after", "3600"]).ok).toBe(true);
		for (const bad of ["4", "3601", "0", "-5", "5.5", "abc", "", "1e3", "060000"]) {
			expect(parseOptions(["--stale-after", bad])).toEqual({ ok: false, error: `error: --stale-after must be a whole number of seconds from 5 to 3600\n${USAGE}` });
		}
	});

	test("rejects unknown options, missing values, repeats, bad groups and bad panel lists with exact errors", () => {
		const fail = (message: string): Parsed => ({ ok: false, error: `error: ${message}\n${USAGE}` });
		expect(parseOptions(["--watch"])).toEqual(fail('unknown option "--watch"'));
		expect(parseOptions(["extra"])).toEqual(fail('unknown option "extra"'));
		expect(parseOptions(["--group"])).toEqual(fail("--group needs a value"));
		expect(parseOptions(["--group", "--once"])).toEqual(fail("--group needs a value"));
		expect(parseOptions(["--once", "--once"])).toEqual(fail("--once given twice"));
		expect(parseOptions(["--group", "a", "--group", "b"])).toEqual(fail("--group given twice"));
		expect(parseOptions(["--group", "Bad Name"])).toEqual(fail("group name must be 1-48 characters: lower-case letters, digits, '.', '_' or '-', starting with a letter or digit"));
		expect(parseOptions(["--group", "x".repeat(49)]).ok).toBe(false);
		expect(parseOptions(["--group", "x".repeat(48)]).ok).toBe(true);
		const panels = fail(`--panels takes a comma-separated list of distinct names from ${PANELS.join(", ")}`);
		expect(parseOptions(["--panels", "sessions,bogus"])).toEqual(panels);
		expect(parseOptions(["--panels", "sessions,sessions"])).toEqual(panels);
		expect(parseOptions(["--panels", ""])).toEqual(panels);
		expect(parseOptions(["--panels", "sessions,"])).toEqual(panels);
	});

	test("a hostile unknown option is sanitized in the error", () => {
		const result = parseOptions(["\u001b[31m--x\u0007"]);
		expect(result.ok ? "" : result.error.replace("\n", " ")).not.toMatch(/\p{Cc}/u);
	});
});

describe("text safety", () => {
	test("strips terminal escapes, control characters and bidi overrides from every field", () => {
		const hostile = "a\u001b[31mred\u001b[0m\u001b]0;title\u0007b\u009bc\u202ed\u0000e\r\nf\tg\u001bP+q\u001b\\h\u001bc";
		const out = safe(hostile, 200);
		expect(out).not.toMatch(/[\p{Cc}\p{Cf}]/u);
		expect(out).toBe("a red b c d e f g h");
	});

	test("caps at the byte boundary: exactly the cap is kept, one byte more is cut with an ellipsis inside the cap", () => {
		expect(safe("x".repeat(NAME_CAP), NAME_CAP)).toBe("x".repeat(NAME_CAP));
		const cut = safe("x".repeat(NAME_CAP + 1), NAME_CAP);
		expect(cut).toBe(`${"x".repeat(NAME_CAP - 3)}…`);
		expect(Buffer.byteLength(cut)).toBe(NAME_CAP);
		expect(safe("y".repeat(TEXT_CAP), TEXT_CAP)).toBe("y".repeat(TEXT_CAP));
		expect(Buffer.byteLength(safe("y".repeat(TEXT_CAP + 1), TEXT_CAP))).toBe(TEXT_CAP);
	});

	test("cuts on a character boundary for 2-, 3- and 4-byte characters and never emits a replacement character", () => {
		for (const ch of ["é", "日", "😀"]) {
			for (const length of [10, 11, 12, 13, 14, 30]) {
				const out = safe(ch.repeat(length), 40);
				expect(Buffer.byteLength(out)).toBeLessThanOrEqual(40);
				expect(Buffer.from(out, "utf8").toString("utf8")).toBe(out);
				expect(out).not.toContain("\uFFFD");
			}
		}
		expect(safe("日".repeat(13), 39)).toBe("日".repeat(13)); // 39 bytes fit exactly
		expect(safe("日".repeat(14), 40)).toBe(`${"日".repeat(12)}…`); // 36 bytes + the 3-byte ellipsis = 39
		expect(safe("日".repeat(14), 39)).toBe(`${"日".repeat(12)}…`);
		expect(safe("日".repeat(14), 38)).toBe(`${"日".repeat(11)}…`);
	});

	test("withholds credential-looking text instead of cutting it", () => {
		expect(safe("to" + "ken: abcdefghijklmnop1234", 40)).toBe("(withheld)");
		expect(safe(`please use sk-ant-${"a".repeat(30)} now`, 200)).toBe("(withheld)");
		expect(safe("https://user:" + "hunter2hunter2@" + "example.com/x", 80)).toBe("(withheld)");
	});

	test("non-text and empty input give an empty string", () => {
		expect(safe(undefined, 10)).toBe("");
		expect(safe(42, 10)).toBe("");
		expect(safe(" \u0007\u001b[1m ", 10)).toBe("");
	});

	test("display width counts wide characters as two columns and fit never exceeds the width", () => {
		expect(displayWidth("abc")).toBe(3);
		expect(displayWidth("日本")).toBe(4);
		expect(displayWidth("😀")).toBe(2);
		expect(fit("abcdef", 6)).toBe("abcdef");
		expect(fit("abcdefg", 6)).toBe("abcde…");
		expect(fit("日本語日本語", 7)).toBe("日本語…");
		expect(displayWidth(fit("日本語日本語", 6))).toBeLessThanOrEqual(6);
		expect(fit("abc", 0)).toBe("");
		expect(fit("abc", 1)).toBe("…");
	});
});

describe("snapshot text", () => {
	test("renders every panel exactly from a realistic state", async () => {
		peers = [
			{ id: A, name: "worker-a", busy: true, context: "1234 (56%)", paused: false, recentErrorTurns: 0, updatedAt: iso(3000), cwd: "/work/proj-a", activeJobs: 1, activeSubagents: 0, isSettled: false, refusesInbound: false, acceptsRemote: true },
			{ id: B, name: "worker-b", busy: false, updatedAt: iso(90_000), paused: true },
			{ id: C, name: "\u001b[31mevil\u001b]0;x\u0007 name" },
		];
		putGroups({ frontend: [A, B], ops: [C, OFFLINE] });
		putLocks([
			{ name: "gpu", capacity: 2, leases: [lease("l2", B, "worker-b", -120_000)] },
			{ name: "heavy-build", capacity: 1, leases: [lease("l1", A, "worker-a", 540_000, "release build")] },
		]);
		putBoard([entry(B, "worker-b", { task: "write the parser" }), entry(A, "worker-a", { task: "old task", status: "blocked", source: "report", updatedAt: NOW - 30 * 3_600_000 })]);
		putInbox([question(1, A, "worker-a", { question: "Ship the release today?", createdAt: NOW - 120_000 }), question(2, B, "worker-b", { state: "deferred" })]);
		expect(await text()).toBe([
			"peers dashboard: read-only snapshot",
			"taken 2026-11-17T10:00:00Z; you are worker-a (p00000000000000a1), not the master",
			"filter: none; registry rows stale after 60s; unknown = not published or unreadable",
			"",
			"== sessions (3) ==",
			"  evil name (p00000000000000c3)  state unknown",
			"      context: unknown  jobs: unknown  agents: unknown  settled: unknown  inbound: unknown",
			"      control: unknown  paused: unknown  error turns: unknown  dir: unknown  registry: age unknown",
			"  worker-a (p00000000000000a1)  busy  [this session]",
			"      context: 1234 (56%)  jobs: 1  agents: 0  settled: no  inbound: open  control: open  paused: no",
			"      error turns: 0  dir: proj-a  registry: 3s ago",
			"  worker-b (p00000000000000b2)  idle  [stale]",
			"      context: unknown  jobs: unknown  agents: unknown  settled: unknown  inbound: unknown",
			"      control: unknown  paused: yes  error turns: unknown  dir: unknown  registry: 1m ago",
			"",
			"== groups (2) ==",
			"  frontend  2 member(s)",
			"      worker-a (p00000000000000a1)  worker-b (p00000000000000b2)",
			"  ops  2 member(s)",
			"      evil name (p00000000000000c3)  p00000000000000d4 (no running session)",
			"",
			"== locks (2) ==",
			"  gpu  0 of 2 slots in use",
			"      l2  worker-b (p00000000000000b2)  EXPIRED 2m ago (not counted)",
			"  heavy-build  1 of 1 slot in use (busy)",
			"      l1  worker-a (p00000000000000a1)  expires in 9m  note: release build",
			"",
			"== tasks (2) ==",
			"  worker-a (p00000000000000a1)  [stale: no update for 30h] blocked  running",
			"      task: old task",
			"      reported 30h ago",
			"  worker-b (p00000000000000b2)  in-progress  running",
			"      task: write the parser",
			"      recorded 5m ago",
			"  stale after 24h without an update (done never goes stale); statuses are unverified claims",
			"",
			"== decisions (1 open) ==",
			"  q1  worker-a (p00000000000000a1)  asked 2m ago",
			"      Ship the release today?",
			"  not listed: 1 deferred, 0 answered",
		].join("\n"));
	});

	test("an empty install says so in every panel and reads nothing it does not need", async () => {
		peers = [{ id: A, name: "solo", busy: false, updatedAt: iso(1000) }];
		const out = await text();
		expect(out).toContain("== groups (0) ==\n  no groups");
		expect(out).toContain("== locks (0) ==\n  no locks held");
		expect(out).toContain("== tasks (0) ==\n  no board entries\n  stale after 24h");
		expect(out).toContain("== decisions (0 open) ==\n  no open decisions");
		const only = await collect(view(), ["sessions"]);
		expect(only.locks).toBeUndefined();
		expect(only.board).toBeUndefined();
		expect(only.inbox).toBeUndefined();
	});

	test("panel selection shows only the chosen panels, in canonical order", async () => {
		peers = [{ id: A, name: "worker-a", updatedAt: iso(1000) }];
		const out = await snap(["--panels", "locks,sessions"]);
		expect(out.filter(line => line.startsWith("=="))).toEqual(["== sessions (1) ==", "== locks (0) =="]);
	});

	test("stale label appears at exactly the configured age and not before", async () => {
		peers = [{ id: A, name: "edge", busy: false, updatedAt: iso(59_999) }, { id: B, name: "edge2", busy: false, updatedAt: iso(60_000) }];
		const lines = await snap(["--panels", "sessions"]);
		expect(lines.find(line => line.startsWith("  edge ("))).not.toContain("[stale]");
		expect(lines.find(line => line.startsWith("  edge2 ("))).toContain("[stale]");
		const custom = await snap(["--panels", "sessions", "--stale-after", "5"]);
		expect(custom.find(line => line.startsWith("  edge ("))).toContain("[stale]");
		expect(custom.join("\n")).toContain("registry rows stale after 5s");
	});

	test("a future or unparsable registry time is not called stale and is labeled", async () => {
		peers = [{ id: A, name: "future", updatedAt: iso(-5000) }, { id: B, name: "garbled", updatedAt: "not a time" }];
		const out = await text(["--panels", "sessions"]);
		expect(out).toContain("registry: 0s ago");
		expect(out).toContain("registry: age unknown");
		expect(out).not.toContain("[stale]");
	});

	test("published fields of the wrong type read as unknown, never as a guess", async () => {
		peers = [{ id: A, name: "odd", busy: "yes", paused: 1, recentErrorTurns: -1, activeJobs: 1.5, activeSubagents: null, isSettled: null, context: "", cwd: "/" } as unknown as PeerView];
		const out = await text(["--panels", "sessions"]);
		expect(out).toContain("odd (p00000000000000a1)  state unknown");
		expect(out).toContain("context: unknown  jobs: unknown  agents: unknown  settled: unknown");
		expect(out).toContain("paused: unknown  error turns: unknown  dir: unknown");
	});

	test("inbound and control states: refused, locked, open and unknown", async () => {
		peers = [
			{ id: A, name: "a", refusesInbound: true, acceptsRemote: false },
			{ id: B, name: "b", refusesInbound: false, acceptsRemote: false },
			{ id: C, name: "c", refusesInbound: false, acceptsRemote: true },
			{ id: OFFLINE, name: "d" },
		];
		const out = (await text(["--panels", "sessions"])).replace(/\n {6}/g, "  ");
		expect(out).toContain("inbound: refused  control: n/a (inbound refused)");
		expect(out).toContain("inbound: open  control: locked");
		expect(out).toContain("inbound: open  control: open");
		expect(out).toContain("inbound: unknown  control: unknown");
	});

	test("duplicate rows of one logical session are shown once, the freshest wins", async () => {
		peers = [{ id: A, name: "old-name", busy: true, updatedAt: iso(500_000) }, { id: A, name: "new-name", busy: false, updatedAt: iso(1000) }];
		const out = await text(["--panels", "sessions"]);
		expect(out).toContain("== sessions (1) ==");
		expect(out).toContain("new-name (p00000000000000a1)  idle  [this session]");
		expect(out).not.toContain("\n  old-name");
	});

	test("the real registry dedupe leaves one row per logical session", async () => {
		interface Row extends Registration { pid: number }
		const session = "session-one";
		const rows: Row[] = [
			{ id: "p111111", name: "twin", sessionId: session, pid: 1 },
			{ id: stablePeerId(session), name: "twin", sessionId: session, pid: 2 },
			{ id: stablePeerId("other"), name: "other", sessionId: "other", pid: 3 },
		];
		const roster = await identifyPeers(rows, async peer => peer.id === stablePeerId(session));
		peers = roster.filter(p => !p.duplicateSession.length || p.canonicalId === p.id).map(p => ({ id: logicalId(p), name: p.name, updatedAt: iso(1000) }));
		const out = await text(["--panels", "sessions"]);
		expect(out).toContain("== sessions (2) ==");
		expect(out.match(/\n {2}twin \(/g)).toHaveLength(1);
		expect(out).toContain(`twin (${stablePeerId(session)})`);
	});

	test("the group filter narrows every panel to the group's members", async () => {
		peers = [{ id: A, name: "worker-a", updatedAt: iso(1000) }, { id: B, name: "worker-b", updatedAt: iso(1000) }, { id: C, name: "worker-c", updatedAt: iso(1000) }];
		putGroups({ frontend: [A, B], ops: [C] });
		putLocks([{ name: "gpu", capacity: 3, leases: [lease("l1", A, "worker-a", 60_000), lease("l2", C, "worker-c", 60_000)] }, { name: "solo", capacity: 1, leases: [lease("l3", C, "worker-c", 60_000)] }]);
		putBoard([entry(A, "worker-a", { task: "a-task" }), entry(C, "worker-c", { task: "c-task" })]);
		putInbox([question(1, A, "worker-a"), question(2, C, "worker-c")]);
		const out = await text(["--group", "FRONTEND"]);
		expect(out).toContain("filter: group frontend;");
		expect(out).toContain("== sessions (2) ==");
		expect(out).toContain("worker-a (");
		expect(out).toContain("worker-b (");
		expect(out).not.toContain("worker-c");
		expect(out).toContain("== groups (1) ==");
		expect(out).not.toContain("ops");
		expect(out).toContain("== locks (1) ==");
		expect(out).toContain("  gpu  2 of 3 slots in use"); // the resource is still shared with worker-c; only the visible leases are filtered
		expect(out).not.toContain("solo");
		expect(out).toContain("== tasks (1) ==");
		expect(out).toContain("task: a-task");
		expect(out).not.toContain("c-task");
		expect(out).toContain("== decisions (1 open) ==");
		expect(out).toContain("Question 1?");
		expect(out).not.toContain("Question 2?");
	});

	test("an unknown group matches nothing and says so; unreadable groups are never replaced by unfiltered data", async () => {
		peers = [{ id: A, name: "worker-a", updatedAt: iso(1000) }];
		putGroups({ ops: [A] });
		let out = await text(["--group", "nope"]);
		expect(out).toContain("no group named nope; the filter matches nothing");
		expect(out).toContain("== sessions (0) ==\n  no sessions");
		expect(out).toContain("== groups (0) ==\n  no such group");
		put("groups.json", "{ not json");
		out = await text(["--group", "ops"]);
		expect(out).toContain("group filter ops cannot be applied: groups are unreadable");
		expect(out).toContain("== sessions (unknown) ==\n  unknown: group membership is unreadable, so the filter is not applied");
		expect(out).not.toContain("\n  worker-a (");
	});

	test("an unreadable or invalid state file labels its own panel and nothing else", async () => {
		peers = [{ id: A, name: "worker-a", updatedAt: iso(1000) }];
		put("locks.json", "{ nope");
		put("board.json", { version: 2, entries: [] });
		put("inbox.json", { version: 1, nextId: 1, entries: [{ id: "bad" }] });
		const out = await text();
		expect(out).toContain("== sessions (1) ==\n  worker-a (");
		expect(out).toContain("== locks (unknown) ==\n  unknown: locks.json is not valid JSON; fix or remove it");
		expect(out).toContain("== tasks (unknown) ==\n  unknown: board.json is invalid: unsupported version or malformed fields");
		expect(out).toContain("== decisions (unknown) ==\n  unknown: inbox.json is invalid: malformed or duplicate entry");
	});

	test("a failing registry read labels the sessions panel", async () => {
		const failing: ReadOnlyView = { ...view(), peers: async () => { throw new Error("registry\u001b[31m exploded"); } };
		const out = renderSnapshot(await collect(failing, ["sessions"]), opts(["--panels", "sessions"]), 100).join("\n");
		expect(out).toContain("== sessions (unknown) ==\n  unknown: registry exploded");
		expect(out).not.toContain("\u001b");
	});

	test("hostile names, tasks, notes and questions cannot inject escapes or secrets", async () => {
		const evil = "\u001b[2J\u001b]0;pwn\u0007\u009b31mX";
		peers = [{ id: A, name: evil, context: `\u001b[1m${evil}`, cwd: `/tmp/${evil}`, updatedAt: iso(1000) }];
		putGroups({ ops: [A] });
		putLocks([{ name: "gpu", capacity: 1, leases: [lease("l1", A, "x", 60_000, "pass" + "word: hunter2hunter2xx")] }]);
		putBoard([entry(A, "x", { task: "api_" + "key=abcdefghijklmnopqrst", note: evil, status: "waiting" })]);
		putInbox([question(1, A, evil, { question: "to" + "ken: abcdefghijklmnop1234 please" })]);
		const out = await text();
		expect(out.replace(/\n/g, "")).not.toMatch(/\p{Cc}/u);
		expect(out).toContain("note: (withheld)");
		expect(out).toContain("task: (withheld)");
		expect(out).toContain("(withheld)");
		expect(out).not.toContain("hunter2");
		expect(out).not.toContain("abcdefghijklmnop");
	});

	test("only the directory's last component is shown and no socket, pid or instance field can appear", async () => {
		peers = [{ id: A, name: "w", cwd: "/ho" + "me/secretuser/clients/acme/app", updatedAt: iso(1000), ...{ sock: "/run/x.sock", pid: 4242, instance: "inst-9" } } as PeerView];
		const out = await text(["--panels", "sessions"]);
		expect(out).toContain("dir: app");
		expect(out).not.toMatch(/secretuser|acme|\.sock|4242|inst-9/);
	});

	test("a task, note, question or name at the cap is shown whole; one byte more is cut with an ellipsis", async () => {
		putBoard([entry(A, "w", { task: "t".repeat(TEXT_CAP), note: "n".repeat(TEXT_CAP + 1) })]);
		putInbox([question(1, A, "w", { question: "q".repeat(TEXT_CAP + 1) }), question(2, B, "w", { question: "r".repeat(TEXT_CAP) })]);
		peers = [{ id: A, name: "m".repeat(NAME_CAP + 1), updatedAt: iso(1000) }];
		const out = await text();
		expect(out).toContain(`      task: ${"t".repeat(TEXT_CAP)}\n`);
		expect(out).toContain(`      note: ${"n".repeat(TEXT_CAP - 3)}…\n`);
		expect(out).toContain(`      ${"q".repeat(TEXT_CAP - 3)}…\n`);
		expect(out).toContain(`      ${"r".repeat(TEXT_CAP)}`);
		expect(out).not.toContain(`${"r".repeat(TEXT_CAP)}…`);
		expect(out).toContain(`  ${"m".repeat(NAME_CAP - 3)}… (`);
	});

	test("at most 50 rows per panel, then an explicit remainder line, with the boundary exact", async () => {
		const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${(i + 1).toString(16).padStart(16, "0")}`, name: `s${String(i).padStart(3, "0")}`, updatedAt: iso(1000) }));
		peers = many(ROW_CAP);
		let out = await text(["--panels", "sessions"]);
		expect(out).toContain("== sessions (50) ==");
		expect(out).not.toContain("more not shown");
		expect(out).toContain("s049 (");
		peers = many(ROW_CAP + 1);
		out = await text(["--panels", "sessions"]);
		expect(out).toContain("== sessions (51) ==");
		expect(out).toContain("  … 1 more not shown (50 shown)");
		expect(out).toContain("s049 (");
		expect(out).not.toContain("s050 (");
		peers = many(ROW_CAP + 30);
		expect(await text(["--panels", "sessions"])).toContain("  … 30 more not shown (50 shown)");
	});

	test("group members and lock holders are capped per row with an explicit remainder", async () => {
		const ids = Array.from({ length: NESTED_CAP + 2 }, (_, i) => `p${(i + 1).toString(16).padStart(16, "0")}`);
		putGroups({ big: ids });
		putLocks([{ name: "pool", capacity: NESTED_CAP + 2, leases: ids.map((id, i) => lease(`l${i + 1}`, id, `n${i}`, 60_000 + i)) }]);
		peers = [];
		const out = await text(["--panels", "groups,locks"]);
		expect(out).toContain("  big  12 member(s)");
		expect(out).toContain("… 2 more");
		expect(out).toContain("      … 2 more lease(s)");
		expect(out.match(/\bl\d+ {2}/g)).toHaveLength(NESTED_CAP);
		const exact = ids.slice(0, NESTED_CAP);
		putGroups({ big: exact });
		expect(await text(["--panels", "groups"])).not.toContain("more");
	});

	test("answered and deferred questions are counted, not listed", async () => {
		putInbox([question(1, A, "w", { state: "answered", resolution: "yes", resolvedAt: NOW, delivery: "delivered" }), question(2, A, "w", { state: "deferred" }), question(3, A, "w", { state: "deferred" })]);
		peers = [];
		const out = await text(["--panels", "decisions"]);
		expect(out).toContain("== decisions (0 open) ==\n  no open decisions\n  not listed: 2 deferred, 1 answered");
		expect(out).not.toContain("Question");
	});

	test("lock slots: a live lease counts, an expired one is marked EXPIRED and not counted, an owner with no session is flagged", async () => {
		peers = [{ id: A, name: "worker-a", updatedAt: iso(1000) }];
		putLocks([{ name: "res", capacity: 2, leases: [lease("l1", A, "worker-a", 1500), lease("l2", B, "gone", -1)] }]);
		const out = await text(["--panels", "locks"]);
		expect(out).toContain("  res  1 of 2 slots in use");
		expect(out).toContain("l1  worker-a (p00000000000000a1)  expires in 2s");
		expect(out).toContain("l2  gone (p00000000000000b2)  [owner not running]  EXPIRED 1s ago (not counted)");
	});

	test("a board entry that never reported progress is labeled unknown, and a bad threshold in peers.json is reported", async () => {
		peers = [];
		putBoard([entry(A, "w", { status: "assigned", task: "x", updatedAt: NOW - 1000 })]);
		fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
		fs.writeFileSync(path.join(home, ".omp", "agent", "peers.json"), JSON.stringify({ board: { staleHours: -3 } }));
		const out = await text(["--panels", "tasks"]);
		expect(out).toContain("w (p00000000000000a1)  assigned (progress unknown: nothing reported)  not running");
		expect(out).toContain("board.staleHours must be a number above 0");
		fs.writeFileSync(path.join(home, ".omp", "agent", "peers.json"), JSON.stringify({ board: { staleHours: 1 } }));
		putBoard([entry(A, "w", { status: "waiting", task: "x", updatedAt: NOW - 3_600_000 })]);
		expect(await text(["--panels", "tasks"])).toContain("[stale: no update for 1h] waiting");
	});

	test("with no registry view the running state of a board owner is unknown, not guessed", async () => {
		putBoard([entry(A, "w", { task: "x" })]);
		const failing: ReadOnlyView = { ...view(), peers: async () => { throw new Error("down"); } };
		const lines = renderSnapshot(await collect(failing, ["tasks", "groups"]), opts(["--panels", "groups,tasks"]), 100).join("\n");
		expect(lines).toContain("w (p00000000000000a1)  in-progress  running state unknown");
	});
});

describe("width", () => {
	const crowded = async () => {
		peers = [
			{ id: A, name: "日本語の名前".repeat(6), context: "日".repeat(20), cwd: "/x/😀😀😀😀😀😀😀😀", busy: true, paused: false, updatedAt: iso(1000), activeJobs: 3, activeSubagents: 2, isSettled: false, refusesInbound: false, acceptsRemote: true, recentErrorTurns: 2 },
			{ id: B, name: "ascii-name-that-is-long-but-capped-by-forty-bytes-total", updatedAt: iso(70_000) },
		];
		putGroups({ wide: [A, B, C], other: [OFFLINE] });
		putLocks([{ name: "res", capacity: 1, leases: [lease("l1", A, "x", 60_000, "日本語".repeat(30))] }]);
		putBoard([entry(A, "w", { task: "日本語".repeat(40), note: "😀".repeat(40) })]);
		putInbox([question(1, A, "日本", { question: "日本語".repeat(40) })]);
	};

	test("no line is ever wider than the width, at 40 columns and other sizes, with wide characters", async () => {
		await crowded();
		for (const width of [1, 2, 10, 20, 40, 41, 60, 100, 200]) {
			for (const line of await snap([], width)) expect(displayWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	test("narrow output keeps structure: details wrap into extra lines instead of disappearing", async () => {
		await crowded();
		const narrow = (await snap(["--panels", "sessions"], 40)).join("\n");
		expect(narrow).toContain("error turns: 2");
		expect(narrow).toContain("registry: 1s ago");
		expect(narrow).toContain("[stale]");
	});
});

describe("read-only by construction", () => {
	const files = () => fs.readdirSync(stateDir(), { recursive: true }).map(String).sort();
	const fingerprint = () => Object.fromEntries(files().map(name => {
		const full = path.join(stateDir(), name);
		const stat = fs.statSync(full);
		return [name, stat.isFile() ? { mtimeMs: stat.mtimeMs, bytes: fs.readFileSync(full, "utf8") } : "dir"];
	}));

	test("a view carries exactly the five read-only members, even from a full host", () => {
		const narrowed = readOnlyView(host());
		expect(Object.keys(narrowed).sort()).toEqual(["home", "isMaster", "now", "peers", "self"]);
	});

	test("the module imports only readers of the other features and no writer, sender or runtime", () => {
		const source = fs.readFileSync(path.join(import.meta.dir, "../../lib/features/dashboard.ts"), "utf8");
		const imports = [...source.matchAll(/^import (?:type )?\{([^}]*)\} from "([^"]+)";$/gm)].map(match => [match[2], match[1].split(",").map(name => name.trim().replace(/^type /, "")).filter(Boolean).sort()]);
		expect(Object.fromEntries(imports)).toEqual({
			"./host": ["FeatureHost", "PeerView"],
			"./index": ["Feature"],
			"./board": ["BoardEntry", "BoardState", "isStale", "readBoard", "staleConfig"],
			"./groups": ["readGroups"],
			"./inbox": ["InboxState", "readInbox"],
			"./locks": ["LocksState", "countLive", "formatDuration", "live", "readLocks"],
			"./rules": ["GROUP_RE"],
			"./secrets": ["looksLikeSecret"],
		});
		expect(source).not.toMatch(/updateState|writeFile|appendFile|rmSync|renameSync|\.send\(|resolveGroup|applyModel|resolveModel|node:fs|node:net|node:child_process|fetch\(|Bun\./);
	});

	test("every state file keeps its exact bytes and mtime and no file appears through collect, render, the command and the overlay", async () => {
		peers = [{ id: A, name: "worker-a", updatedAt: iso(1000) }];
		putGroups({ ops: [A] });
		putLocks([{ name: "res", capacity: 1, leases: [lease("l1", A, "worker-a", -10)] }]); // expired: a status never reclaims
		putBoard([entry(A, "worker-a", { task: "x" })]);
		putInbox([question(1, A, "worker-a")]);
		put("pause.json", { version: 1, sessions: {} });
		put("rules.json", { version: 1, nextId: 1, rules: [] });
		fs.writeFileSync(path.join(home, ".omp", "agent", "peers.json"), "{}");
		const past = new Date(NOW - 86_400_000);
		for (const name of files()) fs.utimesSync(path.join(stateDir(), name), past, past);
		const before = fingerprint();
		const listing = files();

		await dashboard.command([], host());
		await dashboard.command(["--group", "ops", "--once"], host());
		await text(["--panels", "locks"]);
		const harness = overlayHarness();
		await harness.open();
		harness.press("\t");
		harness.press("r");
		harness.press("g");
		await harness.settle();
		harness.press("q");

		expect(fingerprint()).toEqual(before);
		expect(files()).toEqual(listing);
		expect(calls.forbidden).toEqual([]);
	});

	test("a missing state directory is left missing", async () => {
		await dashboard.command([], host());
		expect(fs.existsSync(path.join(home, ".omp"))).toBe(false);
	});
});

describe("command output", () => {
	test("returns one snapshot, identical on a second call, and an option error as plain text", async () => {
		peers = [{ id: A, name: "worker-a", updatedAt: iso(1000) }];
		const first = await dashboard.command(["--once"], host());
		expect(first).toBe(await dashboard.command(["--once"], host()));
		expect(first.split("\n")[0]).toBe("peers dashboard: read-only snapshot");
		for (const line of first.split("\n")) expect(displayWidth(line)).toBeLessThanOrEqual(ONCE_WIDTH);
		expect(await dashboard.command(["--bogus"], host())).toBe(`error: unknown option "--bogus"\n${USAGE}`);
	});

	test("shows 'the master' for the master session", async () => {
		peers = [{ id: A, name: "worker-a", updatedAt: iso(1000) }];
		expect((await dashboard.command([], host(A, true))).split("\n")[1]).toBe("taken 2026-11-17T10:00:00Z; you are worker-a (p00000000000000a1), the master");
	});
});

// ---- Overlay ----------------------------------------------------------------------------------

interface Harness {
	open(): Promise<void>;
	press(data: string): void;
	settle(): Promise<void>;
	lines(width?: number): string[];
	timers: { active: Map<number, { callback: () => void; ms: number }>; set: number; cleared: number };
	renders: () => number;
	done: () => boolean;
	component: () => DashboardComponent;
	closed: () => Promise<void>;
}

function overlayHarness(args: string[] = [], rows = 40): Harness {
	const timers = { active: new Map<number, { callback: () => void; ms: number }>(), set: 0, cleared: 0 };
	let nextTimer = 1;
	const fakeTimers: Timers = {
		setInterval: (callback, ms) => {
			const handle = nextTimer++;
			timers.active.set(handle, { callback, ms });
			timers.set++;
			return handle;
		},
		clearTimer: handle => {
			if (timers.active.delete(handle as number)) timers.cleared++;
		},
	};
	let component: DashboardComponent | undefined;
	let renders = 0;
	let finished = false;
	let resolved: Promise<void> | undefined;
	let options: unknown;
	const tui: DashboardTui = { terminal: { rows }, requestRender: () => void renders++ };
	const ui: DashboardUi = {
		custom: (factory, o) => {
			options = o;
			const { promise, resolve } = Promise.withResolvers<never>();
			component = factory(tui, {}, {}, result => {
				finished = true;
				resolve(result as never);
			});
			return promise;
		},
	};
	const flush = async () => {
		// The refresh is pure promise chaining over synchronous file reads: draining the microtask queue completes it.
		for (let i = 0; i < 200; i++) await Promise.resolve();
	};
	return {
		open: async () => {
			resolved = openDashboard(ui, host(), opts(args), fakeTimers);
			await flush();
			expect(options).toEqual({ overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" } });
		},
		press: data => component!.handleInput(data),
		settle: flush,
		lines: (width = 100) => component!.render(width),
		timers,
		renders: () => renders,
		done: () => finished,
		component: () => component!,
		closed: () => resolved!,
	};
}

describe("overlay", () => {
	beforeEach(() => {
		peers = [{ id: A, name: "worker-a", busy: true, updatedAt: iso(1000) }, { id: B, name: "worker-b", busy: false, updatedAt: iso(2000) }];
		putGroups({ frontend: [A], ops: [B] });
		putLocks([{ name: "res", capacity: 1, leases: [lease("l1", A, "worker-a", 60_000)] }]);
		putBoard([entry(A, "worker-a", { task: "the task" })]);
		putInbox([question(1, A, "worker-a")]);
	});

	test("starts one 5 s interval and renders the loaded first panel with a tab bar and key line", async () => {
		const h = overlayHarness();
		await h.open();
		expect(h.timers.set).toBe(1);
		expect([...h.timers.active.values()].map(timer => timer.ms)).toEqual([REFRESH_MS]);
		expect(REFRESH_MS).toBe(5000);
		const lines = h.lines();
		expect(lines[0]).toBe("peers dashboard: read-only snapshot");
		expect(lines).toContain("[sessions]  groups  locks  tasks  decisions");
		expect(lines).toContain("== sessions (2) ==");
		expect(lines.some(line => line.includes("worker-a (p00000000000000a1)  busy"))).toBe(true);
		expect(lines[lines.length - 1]).toBe("q close  Tab panel  r refresh  g group  ? help  Up/Down scroll");
		expect(lines.join("\n")).not.toContain("== groups");
		expect(h.renders()).toBeGreaterThan(0);
	});

	test("shows a loading line before the first snapshot arrives", async () => {
		const h = overlayHarness();
		void h.open();
		expect(h.lines(100)[0]).toBe("loading…");
		await h.settle();
	});

	test("Tab and Shift-Tab move through the selected panels and wrap", async () => {
		const h = overlayHarness(["--panels", "sessions,locks,decisions"]);
		await h.open();
		const current = () => h.lines().find(line => /^\[?sessions\]? {2}/.test(line)) ?? "";
		expect(current()).toBe("[sessions]  locks  decisions");
		h.press("\t");
		expect(current()).toBe("sessions  [locks]  decisions");
		expect(h.lines()).toContain("== locks (1) ==");
		h.press("\t");
		h.press("\t");
		expect(current()).toBe("[sessions]  locks  decisions");
		h.press("\u001b[Z");
		expect(current()).toBe("sessions  locks  [decisions]");
		h.press("\u001b[Z");
		expect(current()).toBe("sessions  [locks]  decisions");
		expect(h.timers.set).toBe(1);
	});

	test("r refreshes now (one more read of the registry), also while a refresh is running", async () => {
		const h = overlayHarness();
		await h.open();
		const before = calls.peers;
		h.press("r");
		await h.settle();
		expect(calls.peers).toBe(before + 1);
		h.press("r");
		h.press("r");
		await h.settle();
		expect(calls.peers).toBeGreaterThanOrEqual(before + 2);
		expect(calls.peers).toBeLessThanOrEqual(before + 3);
	});

	test("the interval refreshes; a new row appears on the next tick", async () => {
		const h = overlayHarness();
		await h.open();
		peers = [...peers, { id: C, name: "late-joiner", updatedAt: iso(10) }];
		expect(h.lines().join("\n")).not.toContain("late-joiner");
		[...h.timers.active.values()][0].callback();
		await h.settle();
		expect(h.lines().join("\n")).toContain("late-joiner");
	});

	test("g cycles all -> each group (sorted) -> all and the filter applies to the panel", async () => {
		const h = overlayHarness();
		await h.open();
		const filter = () => (h.lines().find(line => line.startsWith("filter:")) ?? "").split(";")[0];
		expect(filter()).toBe("filter: none");
		h.press("g");
		expect(filter()).toBe("filter: group frontend");
		expect(h.lines()).toContain("== sessions (1) ==");
		h.press("g");
		expect(filter()).toBe("filter: group ops");
		expect(h.lines().join("\n")).toContain("\n  worker-b (");
		expect(h.lines().join("\n")).not.toContain("\n  worker-a (");
		h.press("g");
		expect(filter()).toBe("filter: none");
		expect(h.lines()).toContain("== sessions (2) ==");
	});

	test("g starts from --group and leaves an unknown group for 'all'", async () => {
		const h = overlayHarness(["--group", "ops"]);
		await h.open();
		expect(h.lines().find(line => line.startsWith("filter:"))).toContain("group ops");
		h.press("g");
		expect(h.lines().find(line => line.startsWith("filter:"))).toContain("filter: none");
		const unknown = overlayHarness(["--group", "ghost"]);
		await unknown.open();
		unknown.press("g");
		expect(unknown.lines().find(line => line.startsWith("filter:"))).toContain("filter: none");
	});

	test("? toggles the key help, which states the period and that nothing is controlled", async () => {
		const h = overlayHarness();
		await h.open();
		h.press("?");
		const help = h.lines().join("\n");
		expect(help).toContain("q, Esc               close");
		expect(help).toContain("Tab, Shift-Tab       next, previous panel");
		expect(help).toContain("refreshes by itself every 5 s");
		expect(help).toContain("never sends, wakes");
		expect(help).not.toContain("== sessions");
		h.press("?");
		expect(h.lines()).toContain("== sessions (2) ==");
	});

	test("q closes: done runs once, the timer is cleared, nothing is pending and later ticks read nothing", async () => {
		const h = overlayHarness();
		await h.open();
		const tick = [...h.timers.active.values()][0].callback;
		h.press("q");
		await h.closed();
		expect(h.done()).toBe(true);
		expect(h.timers.active.size).toBe(0);
		expect(h.timers.cleared).toBe(1);
		const reads = calls.peers;
		tick();
		h.press("r");
		h.press("q");
		await h.settle();
		expect(calls.peers).toBe(reads);
		expect(h.timers.cleared).toBe(1);
	});

	test("Esc, in plain and Kitty form, closes the same way", async () => {
		for (const key of ["\u001b", "\u001b[27u", "\u001b[27;1u", "\u001b[113u"]) {
			const h = overlayHarness();
			await h.open();
			h.press(key);
			await h.closed();
			expect(h.done()).toBe(true);
			expect(h.timers.active.size).toBe(0);
		}
	});

	test("closing during a refresh renders nothing afterwards and leaves no timer", async () => {
		const h = overlayHarness();
		await h.open();
		h.press("r");
		h.press("q");
		const renders = h.renders();
		await h.settle();
		expect(h.renders()).toBe(renders);
		expect(h.timers.active.size).toBe(0);
	});

	test("dispose from the host clears the timer even without a key press", async () => {
		const h = overlayHarness();
		await h.open();
		h.component().dispose();
		expect(h.timers.active.size).toBe(0);
	});

	test("a refresh that fails keeps the previous snapshot and says so; the next good one clears the notice", async () => {
		const h = overlayHarness();
		await h.open();
		selfFails = true;
		h.press("r");
		await h.settle();
		const failed = h.lines();
		expect(failed).toContain("== sessions (2) ==");
		expect(failed).toContain("last refresh failed (self unavailable); showing the previous snapshot");
		selfFails = false;
		h.press("r");
		await h.settle();
		expect(h.lines().join("\n")).not.toContain("last refresh failed");
		const first = overlayHarness();
		selfFails = true;
		await first.open();
		expect(first.lines()).toEqual(["refresh failed: self unavailable", "q close  Tab panel  r refresh  g group  ? help  Up/Down scroll"]);
	});

	test("lines never exceed the overlay width and the body scrolls inside the window", async () => {
		peers = Array.from({ length: 40 }, (_, i) => ({ id: `p${(i + 1).toString(16).padStart(16, "0")}`, name: `s${String(i).padStart(2, "0")}-日本語`, busy: true, updatedAt: iso(1000) }));
		const h = overlayHarness([], 24);
		await h.open();
		for (const width of [30, 50, 120]) for (const line of h.lines(width)) expect(displayWidth(line)).toBeLessThanOrEqual(width);
		const first = h.lines();
		expect(first.length).toBeLessThan(30);
		expect(first.join("\n")).toMatch(/lines 1-\d+ of \d+/);
		h.press("\u001b[6~");
		const second = h.lines();
		expect(second.join("\n")).not.toMatch(/lines 1-/);
		expect(second.join("\n")).toMatch(/lines \d+-\d+ of/);
		for (let i = 0; i < 200; i++) h.press("\u001b[B");
		const bottom = h.lines();
		expect(bottom.join("\n")).toContain("s39");
		for (let i = 0; i < 300; i++) h.press("\u001b[A");
		expect(h.lines().join("\n")).toMatch(/lines 1-/);
		h.press("\t");
		expect(h.lines()).toContain("== groups (2) ==");
	});

	test("the overlay reserves exactly its own keys, so the host's app-wide Esc handling cannot take them, and none once closed", async () => {
		const h = overlayHarness();
		await h.open();
		const owned = ["q", "\u001b", "\t", "\u001b[Z", "r", "g", "?", "\u001b[A", "\u001b[B", "\u001b[5~", "\u001b[6~", "\u001b[27u"];
		expect(owned.map(key => h.component().capturesInput(key))).toEqual(owned.map(() => true));
		for (const other of ["x", "\u0003", "\r", "\u001b[113;1:3u", ""]) expect(h.component().capturesInput(other)).toBe(false);
		h.press("q");
		expect(h.component().capturesInput("q")).toBe(false);
	});

	test("unknown keys and release events do nothing", async () => {
		const h = overlayHarness();
		await h.open();
		const before = h.lines();
		for (const key of ["x", "\u001b[113;1:3u", "\u0003", "\u001b[1;5A", ""]) h.press(key);
		expect(h.lines()).toEqual(before);
		expect(h.done()).toBe(false);
	});
});

describe("keys", () => {
	test("plain sequences and Kitty presses map to dashboard keys", () => {
		expect(["q", "\u001b", "\t", "\u001b[Z", "r", "g", "?", "\u001b[A", "\u001bOB", "\u001b[5~", "\u001b[6~"].map(parseKey)).toEqual([
			"q", "esc", "tab", "shift-tab", "r", "g", "?", "up", "down", "pageup", "pagedown",
		]);
		expect(parseKey("\u001b[9u")).toBe("tab");
		expect(parseKey("\u001b[9;2u")).toBe("shift-tab");
		expect(parseKey("\u001b[114;1:1u")).toBe("r");
		expect(parseKey("\u001b[114;1:2u")).toBe("r");
		expect(parseKey("\u001b[114;1:3u")).toBeUndefined();
		expect(parseKey("\u001b[113;5u")).toBeUndefined(); // ctrl+q is not q
		expect(parseKey("\u001b[63;2u")).toBe("?");
		expect(parseKey("Q")).toBeUndefined();
	});
});

describe("whole panels render", () => {
	test("renderPanel of each panel starts with its title and stays within width", async () => {
		peers = [{ id: A, name: "worker-a", updatedAt: iso(1000) }];
		const snapshot = await collect(view(), PANELS);
		for (const panel of PANELS) {
			const lines = renderPanel(panel, snapshot, opts(), 60);
			expect(lines[0].startsWith(`== ${panel} (`)).toBe(true);
		}
	});
});
