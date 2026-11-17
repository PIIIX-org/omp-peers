// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FEATURES } from "../../lib/features";
import type { FeatureHost } from "../../lib/features/host";
import { MAX_REASON, NON_WAKE_OPS, pause, pauseFile, pauseSession, readPause, resume, resumeSession, wakeGate, type PauseState } from "../../lib/features/pause";

const A = "p00000000000000a1";
const B = "p00000000000000b2";
const NAMES: Record<string, string> = { [A]: "worker-a", [B]: "worker-b" };
const NOW = 1_700_000_000_000;

let home: string;
beforeEach(() => {
	home = fs.mkdtempSync(path.join("/tmp", "opf-"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function host(self: string): FeatureHost {
	return {
		home,
		now: () => NOW,
		self: () => ({ id: self, name: NAMES[self] }),
		isMaster: () => false,
		acceptsRemote: () => true,
		peers: async () => [],
		groupsOf: () => [],
		notify: () => {},
		resolveGroup: async () => ({ recipients: [], skipped: [] }), // not exercised by this suite
		resolveModel: async () => ({ ok: false, error: "not exercised by this suite" }), applyModel: async () => ({ ok: false, error: "not exercised by this suite" }),
		send: async () => ({ status: "offline" }),
	};
}
const stored = (): PauseState => JSON.parse(fs.readFileSync(pauseFile(home), "utf8"));
const say = (feature: typeof pause, args: string, self = A) => feature.command(args.split(/\s+/).filter(Boolean), host(self));

describe("wake gate decision table", () => {
	const paused = { paused: true };
	const free = { paused: false };

	test("not paused: every op passes", () => {
		for (const op of ["message", "prompt", ...NON_WAKE_OPS, "unheard-of"]) expect(wakeGate(free, op)).toEqual({ allow: true });
	});

	test("paused: message is deferred and prompt is refused, both structured and without a sender-visible failure text", () => {
		expect(wakeGate(paused, "message")).toEqual({ allow: false, result: { ok: false, status: "deferred", paused: true, error: "session is paused" } });
		expect(wakeGate(paused, "prompt")).toEqual({ allow: false, result: { ok: false, status: "refused", paused: true, error: "session is paused" } });
	});

	test("paused: every non-wake op stays available; resume is not an op at all", () => {
		for (const op of ["status", "tail", "abort", "rename", "compact", "model", "effort", "subagents", "setting", "shutdown", "pause"]) {
			expect(wakeGate(paused, op)).toEqual({ allow: true });
		}
		expect([...NON_WAKE_OPS].sort()).toEqual(["abort", "compact", "effort", "model", "pause", "rename", "setting", "shutdown", "status", "subagents", "tail"]);
		expect(wakeGate(paused, "resume")).toEqual({ allow: false, result: { ok: false, status: "refused", paused: true, error: "session is paused" } });
	});

	test("paused: an op the table has never heard of fails closed", () => {
		for (const op of ["digest", "trigger", "adapter", "", "PROMPT", "Message"]) {
			const decision = wakeGate(paused, op);
			expect(decision.allow).toBe(false);
			expect(decision.allow === false && decision.result.status).toBe("refused");
		}
	});
});

describe("persistence", () => {
	test("pause survives a reload; the file is private, versioned and keyed by stable peer id", async () => {
		expect(readPause(home, A)).toEqual({ paused: false });
		const result = await pauseSession(home, A, A, NOW, "  waiting   for review ");
		expect(result).toEqual({ ok: true, already: false, entry: { since: NOW, by: A, reason: "waiting for review" } });
		// readPause always goes to disk: a new process would see exactly this.
		expect(readPause(home, A)).toEqual({ paused: true, since: NOW, by: A, reason: "waiting for review" });
		expect(readPause(home, B)).toEqual({ paused: false });
		expect(fs.statSync(pauseFile(home)).mode & 0o777).toBe(0o600);
		expect(fs.statSync(path.dirname(pauseFile(home))).mode & 0o777).toBe(0o700);
		expect(stored()).toEqual({ version: 1, sessions: { [A]: { since: NOW, by: A, reason: "waiting for review" } } });
		expect(JSON.stringify(stored())).not.toContain("worker-a");
	});

	test("only an explicit resume clears it, and only for that session", async () => {
		await pauseSession(home, A, A, NOW);
		await pauseSession(home, B, A, NOW + 1);
		// Reads, repeated pauses and other sessions' resumes change nothing.
		expect(readPause(home, A).paused).toBe(true);
		await pauseSession(home, A, B, NOW + 5, "other reason");
		expect(readPause(home, A)).toEqual({ paused: true, since: NOW, by: A, reason: undefined });
		await resumeSession(home, B);
		expect(readPause(home, A).paused).toBe(true);
		expect(readPause(home, B).paused).toBe(false);
		expect((await resumeSession(home, A)).cleared?.since).toBe(NOW);
		expect(readPause(home, A).paused).toBe(false);
		expect(stored().sessions).toEqual({});
		expect(await resumeSession(home, A)).toEqual({});
	});

	test("an unreadable pause file fails closed and is never overwritten", async () => {
		fs.mkdirSync(path.dirname(pauseFile(home)), { recursive: true, mode: 0o700 });
		fs.writeFileSync(pauseFile(home), "{ not json");
		const view = readPause(home, A);
		expect(view.paused).toBe(true);
		expect(view.error).toContain("not valid JSON");
		expect(wakeGate(view, "message").allow).toBe(false);
		expect(wakeGate(view, "status").allow).toBe(true);
		await expect(pauseSession(home, A, A, NOW)).rejects.toThrow("not valid JSON");
		await expect(resumeSession(home, A)).rejects.toThrow("not valid JSON");
		expect(await say(resume, "")).toContain("error:");
		expect(fs.readFileSync(pauseFile(home), "utf8")).toBe("{ not json");
		for (const bad of [{ version: 2, sessions: {} }, { version: 1, sessions: { nope: { since: 1, by: "x" } } }, { version: 1, sessions: { [A]: { since: "1", by: "x" } } }]) {
			fs.writeFileSync(pauseFile(home), JSON.stringify(bad));
			expect(readPause(home, A).paused).toBe(true);
			expect(readPause(home, A).error).toContain("pause.json is invalid");
		}
	});

	test("a symlinked pause file is refused, not followed", () => {
		fs.mkdirSync(path.dirname(pauseFile(home)), { recursive: true, mode: 0o700 });
		const elsewhere = path.join(home, "elsewhere.json");
		fs.writeFileSync(elsewhere, JSON.stringify({ version: 1, sessions: {} }));
		fs.symlinkSync(elsewhere, pauseFile(home));
		const view = readPause(home, A);
		expect(view.paused).toBe(true);
		expect(view.error).toContain("symlink");
	});
});

describe("pause and resume commands act on this session", () => {
	test("registered as /peers pause and /peers resume", () => {
		expect(FEATURES.map(f => f.name)).toEqual(expect.arrayContaining(["pause", "resume"]));
	});

	test("pause then resume round-trips through the command text", async () => {
		const out = await say(pause, "waiting for the release branch");
		expect(out).toContain("paused worker-a (" + A + ") (waiting for the release branch)");
		expect(out).toContain("a running turn is not interrupted");
		expect(readPause(home, A).reason).toBe("waiting for the release branch");
		expect(readPause(home, B).paused).toBe(false);
		expect(await say(resume, "")).toBe(`resumed worker-a (${A}): wake-triggering messages and prompts are accepted again`);
		expect(readPause(home, A).paused).toBe(false);
		expect(await say(resume, "")).toBe(`worker-a (${A}) is not paused`);
	});

	test("pausing twice keeps the first start time and reason and says so", async () => {
		await pauseSession(home, A, A, NOW, "first");
		const out = await pause.command(["second"], { ...host(A), now: () => NOW + 60_000 });
		expect(out).toContain(`already paused since ${new Date(NOW).toISOString()} (first)`);
		expect(stored().sessions[A]).toEqual({ since: NOW, by: A, reason: "first" });
	});

	test("one session's command never touches another session's state", async () => {
		await say(pause, "", B);
		await say(resume, "", A);
		expect(readPause(home, B).paused).toBe(true);
		expect(readPause(home, A).paused).toBe(false);
	});

	test("resume rejects arguments; there is no target other than this session", async () => {
		await say(pause, "");
		expect(await say(resume, B)).toBe("usage: /peers resume");
		expect(readPause(home, A).paused).toBe(true);
	});

	test("reasons are validated: length, control characters, credential-looking text, blank", async () => {
		expect(MAX_REASON).toBe(120);
		expect(await pauseSession(home, A, A, NOW, "x".repeat(121))).toEqual({ ok: false, error: "reason is longer than 120 characters" });
		const ok = await pauseSession(home, A, A, NOW, "y".repeat(120));
		expect(ok.ok && ok.entry.reason).toHaveLength(120);
		await resumeSession(home, A);
		const noisy = await pauseSession(home, A, A, NOW, "a\u202eb\u0007c");
		expect(noisy).toEqual({ ok: false, error: "reason contains control characters" });
		const value = "abcd1234" + "efgh5678";
		const secret = await pauseSession(home, A, A, NOW, "api_" + "key=" + value);
		expect(secret.ok).toBe(false);
		expect(JSON.stringify(secret)).not.toContain(value);
		expect(readPause(home, A).paused).toBe(false);
		const blank = await pauseSession(home, A, A, NOW, "   \n\t ");
		expect(blank.ok && blank.entry).toEqual({ since: NOW, by: A });
	});

	test("a malformed session identity is rejected rather than stored", async () => {
		expect(await pauseSession(home, "not-an-id", "x", NOW)).toEqual({ ok: false, error: "session identity unavailable" });
		expect(fs.existsSync(pauseFile(home))).toBe(false);
	});
});

describe("concurrency across real processes", () => {
	const spawn = (id: string, rounds: number) => Bun.spawn([process.execPath, path.join(import.meta.dir, "child_pause.ts"), home, id, String(rounds)], { stdout: "pipe", stderr: "pipe" });

	test("two processes pausing and resuming different sessions lose no update", async () => {
		const codes = await Promise.all([spawn(A, 12), spawn(B, 12)].map(child => child.exited));
		expect(codes).toEqual([0, 0]);
		expect(Object.keys(stored().sessions).sort()).toEqual([A, B]);
		expect(readPause(home, A).reason).toBe("final");
	});

	test("racing pauses of one session leave exactly one entry; in-process calls interleave with a child", async () => {
		const child = spawn(A, 10);
		const results = await Promise.all(Array.from({ length: 10 }, (_, i) => pauseSession(home, B, B, NOW + i, `local ${i}`)));
		expect(await child.exited).toBe(0);
		expect(results.filter(r => r.ok && !r.already)).toHaveLength(1);
		const winner = results.find(r => r.ok && !r.already);
		if (!winner?.ok) throw new Error("no pause won the race");
		expect(stored().sessions[B]).toEqual(winner.entry);
		expect(Object.keys(stored().sessions).sort()).toEqual([A, B]);
	});
});
