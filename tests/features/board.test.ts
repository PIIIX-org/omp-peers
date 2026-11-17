// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FEATURES } from "../../lib/features";
import { assignTask, board, boardFile, clearEntry, formatAge, isStale, recordReport, setStatus, staleConfig, type BoardState, type BoardStatus } from "../../lib/features/board";
import type { FeatureHost, PeerView } from "../../lib/features/host";
import type { Report } from "../../lib/reports";
import { stateRoot } from "../../lib/features/store";

const MASTER = "p00000000000000aa";
const A = "p00000000000000a1";
const B = "p00000000000000b2";
const C = "p00000000000000c3";
const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

let home: string;
let now: number;
let live: PeerView[];
let listed: number;
beforeEach(() => {
	home = fs.mkdtempSync(path.join("/tmp", "opf-"));
	now = T0;
	listed = 0;
	live = [{ id: MASTER, name: "master" }, { id: A, name: "worker-a" }, { id: B, name: "worker-b" }];
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

/** A fake host as seen from `self`; `master` says whether that session holds the master role. */
function host(self: string, master = self === MASTER): FeatureHost {
	return {
		home,
		now: () => now,
		self: () => live.find(peer => peer.id === self) ?? { id: self, name: "gone" },
		isMaster: () => master,
		acceptsRemote: () => true,
		peers: async () => {
			listed++;
			return live;
		},
		groupsOf: () => [],
		usageNow: () => undefined,
		resolveGroup: async () => ({ recipients: [], skipped: [] }),
		resolveModel: async () => ({ ok: false, error: "not exercised by this suite" }), applyModel: async () => ({ ok: false, error: "not exercised by this suite" }),
		send: async () => ({ status: "offline" }),
	};
}
const master = () => host(MASTER);
const stored = (): BoardState => JSON.parse(fs.readFileSync(boardFile(home), "utf8"));
const entry = (id: string) => stored().entries.find(e => e.session === id);
const run = (args: string, h = master()) => board.command(args.split(/\s+/).filter(Boolean), h);
const ok = async <T extends { ok: boolean }>(result: Promise<T>): Promise<Extract<T, { ok: true }>> => {
	const value = await result;
	if (!value.ok) throw new Error(JSON.stringify(value));
	return value as Extract<T, { ok: true }>;
};
const done: Report = { kind: "DONE", unit: "Consumer validation", evidence: { description: "Offline checks passed" } };

describe("registry", () => {
	test("is registered as /peers board with a report hook", () => {
		const feature = FEATURES.find(f => f.name === "board");
		expect(feature).toBe(board);
		expect(typeof feature?.onReport).toBe("function");
	});
});

describe("stable keying", () => {
	test("entries key on the stable session id: restart, rename and name reuse never fork or hijack an entry", async () => {
		await ok(assignTask(master(), "worker-a", "build the parser"));
		expect(entry(A)).toMatchObject({ session: A, name: "worker-a", task: "build the parser", status: "assigned", source: "assignment", updatedBy: MASTER });

		// The session restarts under a new name: same stable id, so a report updates the same single entry.
		live = [{ id: MASTER, name: "master" }, { id: A, name: "worker-a2" }, { id: B, name: "worker-b" }];
		now += HOUR;
		await board.onReport!(done, { id: A, name: "worker-a2" }, host(A));
		expect(stored().entries).toHaveLength(1);
		expect(entry(A)).toMatchObject({ name: "worker-a2", task: "build the parser", status: "done", source: "report", unit: "Consumer validation" });

		// A different session now uses the old name: it must not inherit or overwrite A's entry.
		live = [{ id: MASTER, name: "master" }, { id: C, name: "worker-a2" }, { id: B, name: "worker-b" }];
		expect(await setStatus(master(), "worker-a2", "blocked")).toEqual({ ok: false, error: `no board entry for ${C}; assign it a task first` });
		expect(entry(A)?.status).toBe("done");
	});

	test("the master changing does not move or lose entries", async () => {
		await ok(assignTask(master(), "worker-a", "task one"));
		const newMaster = host(B, true);
		expect((await ok(setStatus(newMaster, A, "in-progress"))).entry.updatedBy).toBe(B);
		expect(entry(A)).toMatchObject({ task: "task one", status: "in-progress" });
		expect(await assignTask(host(MASTER, false), "worker-a", "ex master")).toEqual({ ok: false, error: "only the master session may assign tasks; run /peers master first" });
	});

	test("an ambiguous name is refused instead of guessed", async () => {
		live.push({ id: C, name: "Worker-A" });
		const result = await assignTask(master(), "worker-a", "x");
		expect(result).toMatchObject({ ok: false });
		expect((result as { error: string }).error).toContain("ambiguous");
		expect(fs.existsSync(boardFile(home))).toBe(false);
	});

	test("a stopped session is still addressable by id or last known name", async () => {
		await ok(assignTask(master(), "worker-b", "long task"));
		live = [{ id: MASTER, name: "master" }];
		expect((await ok(setStatus(master(), "worker-b", "waiting", "needs review"))).entry).toMatchObject({ session: B, name: "worker-b", status: "waiting", note: "needs review" });
		expect((await ok(setStatus(master(), B, "in-progress"))).entry.note).toBeUndefined();
	});
});

describe("authorization", () => {
	test("assign is master only and writes nothing otherwise", async () => {
		expect(await assignTask(host(A), "worker-b", "task")).toEqual({ ok: false, error: "only the master session may assign tasks; run /peers master first" });
		expect(await run("assign worker-b task", host(A))).toBe("error: only the master session may assign tasks; run /peers master first");
		expect(fs.existsSync(boardFile(home))).toBe(false);
	});

	test("set and clear: master or the session itself for its own entry, nobody else", async () => {
		await ok(assignTask(master(), "worker-a", "task a"));
		await ok(assignTask(master(), "worker-b", "task b"));
		const denied = { ok: false as const, error: "only the master session or the session itself may change this entry" };
		expect(await setStatus(host(A), "worker-b", "done")).toEqual(denied);
		expect(await clearEntry(host(A), "worker-b")).toEqual(denied);
		expect(entry(B)).toMatchObject({ status: "assigned", updatedBy: MASTER });

		const own = await ok(setStatus(host(A), "worker-a", "in-progress", "halfway"));
		expect(own.entry).toMatchObject({ status: "in-progress", note: "halfway", updatedBy: A, source: "assignment" });
		expect((await ok(setStatus(master(), "worker-a", "blocked"))).entry).toMatchObject({ status: "blocked", updatedBy: MASTER });
		await ok(clearEntry(host(A), "worker-a"));
		expect(stored().entries.map(e => e.session)).toEqual([B]);
		await ok(clearEntry(master(), "worker-b"));
		expect(stored().entries).toEqual([]);
	});

	test("set needs an existing entry and a valid status; clear needs an entry", async () => {
		expect(await setStatus(master(), "worker-a", "done")).toEqual({ ok: false, error: `no board entry for ${A}; assign it a task first` });
		await ok(assignTask(master(), "worker-a", "task"));
		expect(await setStatus(master(), "worker-a", "finished")).toEqual({ ok: false, error: "status must be one of assigned, in-progress, blocked, waiting, decision, done, unknown" });
		expect((await ok(setStatus(master(), "worker-a", "UNKNOWN"))).entry.status).toBe("unknown");
		await ok(clearEntry(master(), A));
		expect(await clearEntry(master(), A)).toMatchObject({ ok: false });
	});

	test("task text: one bounded line, no credentials", async () => {
		expect((await ok(assignTask(master(), "worker-a", "  fix   the\ttests  "))).entry.task).toBe("fix the tests");
		expect((await ok(assignTask(master(), "worker-a", "x".repeat(200)))).entry.task).toHaveLength(200);
		expect(await assignTask(master(), "worker-a", "x".repeat(201))).toEqual({ ok: false, error: "task is longer than 200 characters" });
		expect(await assignTask(master(), "worker-a", "   ")).toEqual({ ok: false, error: "task is empty" });
		expect(await assignTask(master(), "worker-a", "line\u0007bell")).toEqual({ ok: false, error: "task contains control characters" });
		const value = "abcd1234" + "efgh5678";
		const secret = await assignTask(master(), "worker-a", `use api_key=${value}`);
		expect(secret.ok).toBe(false);
		expect(JSON.stringify(secret)).not.toContain(value);
		expect(await setStatus(master(), "worker-a", "waiting", `Bearer ${"a".repeat(24)}`)).toMatchObject({ ok: false });
		expect(fs.readFileSync(boardFile(home), "utf8")).not.toContain(value);
	});
});

describe("reports feed the board", () => {
	const reports: Array<[Report, BoardStatus]> = [
		[done, "done"],
		[{ kind: "BLOCKED", unit: "Consumer validation", blocker: "Approval is missing", nextAction: "Request the approval" }, "blocked"],
		[{ kind: "WAITING", unit: "Consumer validation", background: "pending", nextAction: "Check back later" }, "waiting"],
		[{ kind: "DECISION", unit: "Consumer validation", question: "Which option should proceed?" }, "decision"],
	];

	test.each(reports)("%j maps to %s with the unit and a claimed-by sender", async (report, status) => {
		await board.onReport!(report, { id: A, name: "worker-a" }, master());
		expect(entry(A)).toEqual({ session: A, name: "worker-a", status, source: "report", unit: "Consumer validation", updatedAt: T0, updatedBy: A });
		expect(JSON.stringify(stored())).not.toContain("Approval is missing");
	});

	test("a report keeps the assigned task, replaces a manual note and a later report replaces the status", async () => {
		await ok(assignTask(master(), "worker-a", "build it"));
		await ok(setStatus(master(), "worker-a", "in-progress", "started"));
		now += 5 * 60_000;
		await recordReport(master(), reports[1][0], { id: A, name: "worker-a" });
		expect(entry(A)).toMatchObject({ task: "build it", status: "blocked", source: "report", unit: "Consumer validation", updatedAt: now, updatedBy: A });
		expect(entry(A)?.note).toBeUndefined();
		await recordReport(master(), done, { id: A, name: "worker-a" });
		expect(entry(A)?.status).toBe("done");
		expect(stored().entries).toHaveLength(1);
	});

	test("re-sending the same report refreshes its time, so a still-valid WAITING stops being stale; a sender claiming another id writes only that id", async () => {
		const waiting: Report = { kind: "WAITING", unit: "Consumer validation", background: "pending", nextAction: "Wait for results" };
		await recordReport(master(), waiting, { id: A, name: "worker-a" });
		now += 25 * HOUR;
		expect(isStale(entry(A)!, now, 24)).toBe(true);
		await recordReport(host(B), waiting, { id: A, name: "worker-a" });
		expect(entry(A)).toMatchObject({ status: "waiting", updatedAt: now });
		expect(isStale(entry(A)!, now, 24)).toBe(false);
		await recordReport(host(B), done, { id: C, name: "claimed" });
		expect(stored().entries.map(e => [e.session, e.updatedBy])).toEqual([[A, A], [C, C]]);
	});

	test("unusable senders and credential-looking units are not recorded verbatim", async () => {
		await recordReport(master(), done, { id: "?", name: "unknown" });
		await recordReport(master(), done, { id: "not-a-peer", name: "x" });
		expect(fs.existsSync(boardFile(home))).toBe(false);
		const value = "abcd1234" + "efgh5678";
		await recordReport(master(), { ...done, unit: `Deploy with token=${value}` }, { id: A, name: "bad\nname\u202e" });
		expect(entry(A)).toMatchObject({ status: "done", name: "bad name" });
		expect(entry(A)?.unit).toBeUndefined();
		expect(fs.readFileSync(boardFile(home), "utf8")).not.toContain(value);
	});

	test("there is no way to feed the board except commands and reports", () => {
		expect(Object.keys(board).sort()).toEqual(["command", "name", "onReport"]);
	});
});

describe("stale and unknown rendering", () => {
	test("never-reported entries stay 'progress unknown'; not running is labelled; stale shows the age", async () => {
		await ok(assignTask(master(), "worker-a", "task a"));
		await ok(assignTask(master(), "worker-b", "task b"));
		await recordReport(master(), done, { id: A, name: "worker-a" });
		live = [{ id: MASTER, name: "master" }, { id: B, name: "worker-b" }];
		now += 25 * HOUR;
		const text = await run("list");
		expect(text).toBe([
			"2 board entries; stale after 24h without an update (done never goes stale); statuses are claims by the writer, not verified",
			`  worker-a (${A})  done  not running`,
			"      task: task a",
			"      unit: Consumer validation",
			`      report 25h ago, claimed by worker-a (${A})`,
			`  worker-b (${B})  stale (assigned, no update for 25h; progress unknown: nothing reported)  running`,
			"      task: task b",
			`      recorded 25h ago, claimed by master (${MASTER})`,
		].join("\n"));
		// The entry still exists after the session stopped.
		expect(entry(A)?.status).toBe("done");
	});

	test("fresh unreported assignment reads 'assigned (progress unknown)', never in-progress", async () => {
		await ok(assignTask(master(), "worker-a", "task a"));
		expect(await run("list")).toContain(`worker-a (${A})  assigned (progress unknown: nothing reported)  running`);
	});

	test("threshold boundary is inclusive and the stale command lists only stale entries", async () => {
		await ok(assignTask(master(), "worker-a", "task a"));
		await ok(setStatus(master(), "worker-a", "in-progress"));
		now += 24 * HOUR - 1;
		expect(await run("stale")).toBe("no stale entries (threshold 24h; done never goes stale)");
		now += 1;
		const text = await run("stale");
		expect(text.split("\n")[0]).toBe("1 stale entry (no update for 24h or more; done never goes stale)");
		expect(text).toContain(`worker-a (${A})  stale (in-progress, no update for 24h)  running`);
		expect(await run("stale 25")).toBe("no stale entries (threshold 25h; done never goes stale)");
		expect(await run("stale 0.5")).toContain("1 stale entry");
	});

	test("stale hours validation: command argument and peers.json board.staleHours", async () => {
		await ok(assignTask(master(), "worker-a", "task a"));
		for (const bad of ["0", "-1", "abc", "8761", "1e3", "NaN"]) expect(await run(`stale ${bad}`)).toBe("error: hours must be a number above 0 and at most 8760");
		const cfg = path.join(home, ".omp", "agent", "peers.json");
		fs.mkdirSync(path.dirname(cfg), { recursive: true });
		const write = (value: unknown) => fs.writeFileSync(cfg, typeof value === "string" ? value : JSON.stringify(value));
		expect(staleConfig(home)).toEqual({ hours: 24 });
		write({ subagentTiers: {} });
		expect(staleConfig(home)).toEqual({ hours: 24 });
		write({ board: { staleHours: 2 } });
		expect(staleConfig(home)).toEqual({ hours: 2 });
		now += 3 * HOUR;
		expect(await run("list")).toContain("stale after 2h");
		expect(await run("list")).toContain("stale (assigned, no update for 3h; progress unknown: nothing reported)");
		for (const bad of [0, -3, "5", null, 9000, true]) {
			write({ board: { staleHours: bad } });
			expect(staleConfig(home)).toEqual({ hours: 24, warning: "board.staleHours must be a number above 0 and at most 8760; using 24h" });
		}
		write("{not json");
		expect(staleConfig(home).warning).toContain("not valid JSON");
		const listed = await run("list");
		expect(listed).toContain("stale after 24h");
		expect(listed).toContain("peers.json is not valid JSON");
	});

	test("age formatting", () => {
		expect([0, 59_999, 60_000, 59 * 60_000, 60 * 60_000, 47 * HOUR, 48 * HOUR, 100 * HOUR, -5].map(formatAge)).toEqual(["0m", "0m", "1m", "59m", "1h", "47h", "2d", "4d", "0m"]);
	});
});

describe("read-only paths", () => {
	test("list and stale never create or touch the file or its directory", async () => {
		expect(await run("list")).toBe("no board entries");
		expect(await run("stale")).toBe("no stale entries (threshold 24h; done never goes stale)");
		expect(await run("")).toBe("no board entries");
		expect(fs.existsSync(stateRoot(home))).toBe(false);

		await ok(assignTask(master(), "worker-a", "task a"));
		const file = boardFile(home);
		const before = { bytes: fs.readFileSync(file), stat: fs.statSync(file), dir: fs.readdirSync(stateRoot(home)).sort() };
		now += 100 * HOUR;
		await run("list");
		await run("stale");
		await run("stale 1");
		await board.command(["list"], host(A));
		const after = fs.statSync(file);
		expect(fs.readFileSync(file).equals(before.bytes)).toBe(true);
		expect(after.mtimeMs).toBe(before.stat.mtimeMs);
		expect(after.ino).toBe(before.stat.ino);
		expect(fs.readdirSync(stateRoot(home)).sort()).toEqual(before.dir);
		expect(listed).toBeGreaterThan(0);
	});

	test("an unreadable board is reported, never overwritten by a read", async () => {
		fs.mkdirSync(stateRoot(home), { recursive: true });
		fs.writeFileSync(boardFile(home), "{broken");
		expect(await run("list")).toBe("error: board.json is not valid JSON; fix or remove it");
		expect(await run("assign worker-a task")).toBe("error: board.json is not valid JSON; fix or remove it");
		expect(fs.readFileSync(boardFile(home), "utf8")).toBe("{broken");
		fs.writeFileSync(boardFile(home), JSON.stringify({ version: 2, entries: [] }));
		expect(await run("list")).toContain("board.json is invalid");
	});

	test("usage text for malformed commands", async () => {
		const usage = "usage: /peers board [list] | assign <peer> <task> | set <peer> <status> [note] | clear <peer> | stale [<hours>]";
		for (const args of ["bogus", "list extra", "assign", "assign worker-a", "set worker-a", "clear", "clear a b", "stale 1 2"]) expect(await run(args)).toBe(usage);
	});
});

describe("command output", () => {
	test("assign and set say they only record", async () => {
		expect(await run("assign worker-a write the docs")).toBe(`assigned worker-a (${A}): write the docs; recorded only: nothing was sent to that session`);
		expect(await run("set worker-a done all merged")).toBe(`set worker-a (${A}) to done; recorded only: nothing was sent to that session`);
		expect(entry(A)).toMatchObject({ status: "done", note: "all merged" });
		expect(await run("list")).toContain("      note: all merged");
		expect(await run("clear worker-a")).toBe(`cleared worker-a (${A})`);
	});

	test("the board is capped and a full board rejects new entries without losing old ones", async () => {
		const entries = Array.from({ length: 200 }, (_, i) => ({ session: `p${String(i).padStart(16, "0")}`, name: `s${i}`, status: "done", source: "report", updatedAt: T0, updatedBy: A }));
		fs.mkdirSync(stateRoot(home), { recursive: true });
		fs.writeFileSync(boardFile(home), JSON.stringify({ version: 1, entries }));
		expect(await assignTask(master(), "worker-a", "one more")).toEqual({ ok: false, error: "board limit reached (200 entries); clear an entry first" });
		await expect(recordReport(master(), done, { id: A, name: "worker-a" })).rejects.toThrow("board limit reached");
		expect(stored().entries).toHaveLength(200);
	});
});

describe("persistence and storage", () => {
	test("survives reload with a fresh host, stored privately and without transcripts", async () => {
		await ok(assignTask(master(), "worker-a", "persist me"));
		await recordReport(master(), done, { id: A, name: "worker-a" });
		const file = boardFile(home);
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		expect(fs.statSync(stateRoot(home)).mode & 0o777).toBe(0o700);
		const raw = fs.readFileSync(file, "utf8");
		expect(JSON.parse(raw).version).toBe(1);
		expect(raw).not.toContain("Offline checks passed");
		now += HOUR;
		const text = await board.command(["list"], host(B));
		expect(text).toContain(`worker-a (${A})  done  running`);
		expect(text).toContain("task: persist me");
		expect(fs.readdirSync(stateRoot(home)).filter(f => f.endsWith(".tmp"))).toEqual([]);
	});
});

describe("concurrency across real processes", () => {
	const spawn = (tag: string, count: number) => Bun.spawn([process.execPath, path.join(import.meta.dir, "child_board.ts"), home, tag, String(count)], { stdout: "pipe", stderr: "pipe" });

	test("two processes updating different entries never overwrite each other", async () => {
		await ok(assignTask(master(), "worker-a", "untouched by the children"));
		const children = [spawn("0a", 10), spawn("0b", 10)];
		expect(await Promise.all(children.map(child => child.exited))).toEqual([0, 0]);
		const entries = stored().entries;
		expect(entries).toHaveLength(21);
		for (const tag of ["0a", "0b"]) {
			for (let i = 0; i < 10; i++) {
				const found = entries.find(e => e.session === `p${tag}${String(i).padStart(14, "0")}`);
				expect(found).toMatchObject({ status: "waiting", unit: `${tag} unit ${i} second`, name: `${tag}-${i}` });
			}
		}
		expect(entry(A)).toMatchObject({ task: "untouched by the children", status: "assigned" });
	});
});
