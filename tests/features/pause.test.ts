// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FEATURES } from "../../lib/features";
import type { FeatureHost } from "../../lib/features/host";
import {
	MAX_BY_BYTES, MAX_REASON, NON_WAKE_OPS, RESTART_REASON, RESUME_REFUSED, SUBAGENT_RESUME_ERROR, pause, pauseAfterRestart, pauseFile, pauseSession, readPause,
	restartDecision, restartNotice, resume, resumeSession, wakeGate, type PauseBy, type PauseState,
} from "../../lib/features/pause";

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
		usageNow: () => undefined,
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

	test("paused: every non-wake op stays available, resume included (the receiver, not the gate, enforces who may clear a pause)", () => {
		for (const op of ["status", "tail", "abort", "rename", "compact", "model", "effort", "subagents", "setting", "shutdown", "pause", "resume"]) {
			expect(wakeGate(paused, op)).toEqual({ allow: true });
		}
		expect([...NON_WAKE_OPS].sort()).toEqual(["abort", "compact", "effort", "model", "pause", "rename", "resume", "setting", "shutdown", "status", "subagents", "tail"]);
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
		const result = await pauseSession(home, A, "user", NOW, "  waiting   for review ");
		expect(result).toEqual({ ok: true, already: false, upgraded: false, entry: { since: NOW, by: "user", reason: "waiting for review" } });
		// readPause always goes to disk: a new process would see exactly this.
		expect(readPause(home, A)).toEqual({ paused: true, since: NOW, by: "user", reason: "waiting for review" });
		expect(readPause(home, B)).toEqual({ paused: false });
		expect(fs.statSync(pauseFile(home)).mode & 0o777).toBe(0o600);
		expect(fs.statSync(path.dirname(pauseFile(home))).mode & 0o777).toBe(0o700);
		expect(stored()).toEqual({ version: 1, sessions: { [A]: { since: NOW, by: "user", reason: "waiting for review" } } });
		expect(JSON.stringify(stored())).not.toContain("worker-a");
	});

	test("only an explicit resume clears it, and only for that session", async () => {
		await pauseSession(home, A, "user", NOW);
		await pauseSession(home, B, "user", NOW + 1);
		// Reads, repeated pauses and other sessions' resumes change nothing.
		expect(readPause(home, A).paused).toBe(true);
		await pauseSession(home, A, "user", NOW + 5, "other reason");
		expect(readPause(home, A)).toEqual({ paused: true, since: NOW, by: "user", reason: undefined });
		await resumeSession(home, B, "user");
		expect(readPause(home, A).paused).toBe(true);
		expect(readPause(home, B).paused).toBe(false);
		expect(await resumeSession(home, A, "user")).toMatchObject({ ok: true, cleared: { since: NOW } });
		expect(readPause(home, A).paused).toBe(false);
		expect(stored().sessions).toEqual({});
		expect(await resumeSession(home, A, "user")).toEqual({ ok: true });
	});

	test("an unreadable pause file fails closed and is never overwritten", async () => {
		fs.mkdirSync(path.dirname(pauseFile(home)), { recursive: true, mode: 0o700 });
		fs.writeFileSync(pauseFile(home), "{ not json");
		const view = readPause(home, A);
		expect(view.paused).toBe(true);
		expect(view.error).toContain("not valid JSON");
		expect(wakeGate(view, "message").allow).toBe(false);
		expect(wakeGate(view, "status").allow).toBe(true);
		await expect(pauseSession(home, A, "user", NOW)).rejects.toThrow("not valid JSON");
		await expect(resumeSession(home, A, "user")).rejects.toThrow("not valid JSON");
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
		expect(await say(resume, "")).toBe(`resumed worker-a (${A}) (it was paused by its user): wake-triggering messages and prompts are accepted again`);
		expect(readPause(home, A).paused).toBe(false);
		expect(await say(resume, "")).toBe(`worker-a (${A}) is not paused`);
	});

	test("pausing twice keeps the first start time and reason and says so", async () => {
		await pauseSession(home, A, "user", NOW, "first");
		const out = await pause.command(["second"], { ...host(A), now: () => NOW + 60_000 });
		expect(out).toContain(`already paused since ${new Date(NOW).toISOString()} by its user (first)`);
		expect(stored().sessions[A]).toEqual({ since: NOW, by: "user", reason: "first" });
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
		expect(await pauseSession(home, A, "user", NOW, "x".repeat(121))).toEqual({ ok: false, error: "reason is longer than 120 characters" });
		const ok = await pauseSession(home, A, "user", NOW, "y".repeat(120));
		expect(ok.ok && ok.entry.reason).toHaveLength(120);
		await resumeSession(home, A, "user");
		const noisy = await pauseSession(home, A, "user", NOW, "a\u202eb\u0007c");
		expect(noisy).toEqual({ ok: false, error: "reason contains control characters" });
		const value = "abcd1234" + "efgh5678";
		const secret = await pauseSession(home, A, "user", NOW, "api_" + "key=" + value);
		expect(secret.ok).toBe(false);
		expect(JSON.stringify(secret)).not.toContain(value);
		expect(readPause(home, A).paused).toBe(false);
		const blank = await pauseSession(home, A, "user", NOW, "   \n\t ");
		expect(blank.ok && blank.entry).toEqual({ since: NOW, by: "user" });
	});

	test("a malformed session identity is rejected rather than stored", async () => {
		expect(await pauseSession(home, "not-an-id", "user", NOW)).toEqual({ ok: false, error: "session identity unavailable" });
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
		const results = await Promise.all(Array.from({ length: 10 }, (_, i) => pauseSession(home, B, "user", NOW + i, `local ${i}`)));
		expect(await child.exited).toBe(0);
		expect(results.filter(r => r.ok && !r.already)).toHaveLength(1);
		const winner = results.find(r => r.ok && !r.already);
		if (!winner?.ok) throw new Error("no pause won the race");
		expect(stored().sessions[B]).toEqual(winner.entry);
		expect(Object.keys(stored().sessions).sort()).toEqual([A, B]);
	});
});

const write = (sessions: Record<string, unknown>) => {
	fs.mkdirSync(path.dirname(pauseFile(home)), { recursive: true, mode: 0o700 });
	fs.writeFileSync(pauseFile(home), JSON.stringify({ version: 1, sessions }), { mode: 0o600 });
};

describe("pause provenance", () => {
	test("every path records who paused: the user's command, the master's op and the restart rule", async () => {
		await say(pause, "mine");
		expect(readPause(home, A)).toMatchObject({ paused: true, by: "user", reason: "mine" });
		expect(await pauseSession(home, B, "master", NOW, "by the master")).toEqual({ ok: true, already: false, upgraded: false, entry: { since: NOW, by: "master", reason: "by the master" } });
		const C = "p00000000000000c3";
		expect(await pauseAfterRestart(home, C, NOW + 7)).toEqual({ ok: true, already: false, upgraded: false, entry: { since: NOW + 7, by: "restart", reason: RESTART_REASON } });
		expect(RESTART_REASON).toBe("idle before the restart");
		expect(stored().sessions).toEqual({
			[A]: { since: NOW, by: "user", reason: "mine" },
			[B]: { since: NOW, by: "master", reason: "by the master" },
			[C]: { since: NOW + 7, by: "restart", reason: "idle before the restart" },
		});
	});

	test("an entry from an older version reads as the user's: no `by`, or the peer id an older version stored there", async () => {
		write({ [A]: { since: NOW, by: B }, [B]: { since: NOW + 1 }, p00000000000000c3: { since: NOW + 2, by: "master-ish", reason: "kept" } });
		expect(readPause(home, A)).toEqual({ paused: true, since: NOW, by: "user", reason: undefined });
		expect(readPause(home, B)).toEqual({ paused: true, since: NOW + 1, by: "user", reason: undefined });
		expect(readPause(home, "p00000000000000c3")).toMatchObject({ by: "user", reason: "kept" });
		// The master cannot clear any of them; the user can.
		for (const id of [A, B, "p00000000000000c3"]) expect(await resumeSession(home, id, "master")).toEqual({ ok: false, error: RESUME_REFUSED.user });
		expect(await resumeSession(home, A, "user")).toMatchObject({ ok: true, cleared: { by: "user" } });
		// Any later write keeps them as the user's.
		expect(stored().sessions[B]).toEqual({ since: NOW + 1, by: "user" });
	});

	test("the `by` text read from the file is capped in bytes: exactly MAX_BY_BYTES is read, one more is invalid", () => {
		expect(MAX_BY_BYTES).toBe(64);
		write({ [A]: { since: NOW, by: "p".repeat(MAX_BY_BYTES) } });
		expect(readPause(home, A)).toMatchObject({ paused: true, by: "user" });
		write({ [A]: { since: NOW, by: "p".repeat(MAX_BY_BYTES + 1) } });
		expect(readPause(home, A).error).toContain("pause.json is invalid");
		// Multi-byte text counts in bytes, not characters: 33 two-byte characters are 66 bytes.
		write({ [A]: { since: NOW, by: "é".repeat(33) } });
		expect(readPause(home, A).error).toContain("pause.json is invalid");
		write({ [A]: { since: NOW, by: "é".repeat(32) } });
		expect(readPause(home, A).paused).toBe(true);
		write({ [A]: { since: NOW, by: 5 } });
		expect(readPause(home, A).error).toContain("pause.json is invalid");
	});

	test("the file stays private after provenance writes", async () => {
		await pauseSession(home, A, "master", NOW);
		await resumeSession(home, A, "master");
		await pauseAfterRestart(home, B, NOW);
		expect(fs.statSync(pauseFile(home)).mode & 0o777).toBe(0o600);
		expect(fs.statSync(path.dirname(pauseFile(home))).mode & 0o777).toBe(0o700);
	});
});

describe("master resume", () => {
	const FRESH = "p00000000000000c3";

	test("clears a pause the master set itself, and says what was cleared", async () => {
		await pauseSession(home, A, "master", NOW, "hold");
		expect(await resumeSession(home, A, "master")).toEqual({ ok: true, cleared: { since: NOW, by: "master", reason: "hold" } });
		expect(readPause(home, A)).toEqual({ paused: false });
		expect(stored().sessions).toEqual({});
	});

	test("refuses every other pause with a fixed text naming who may resume, and changes nothing", async () => {
		await pauseSession(home, A, "user", NOW, "mine");
		await pauseAfterRestart(home, B, NOW);
		const before = fs.readFileSync(pauseFile(home), "utf8");
		expect(await resumeSession(home, A, "master")).toEqual({ ok: false, error: "paused by its user: only that user can resume it with /peers resume" });
		expect(await resumeSession(home, B, "master")).toEqual({ ok: false, error: "paused after a restart because it was idle: only its user can resume it" });
		expect(fs.readFileSync(pauseFile(home), "utf8")).toBe(before);
		expect(readPause(home, A).paused && readPause(home, B).paused).toBe(true);
		// The session's own user clears either.
		expect(await resumeSession(home, B, "user")).toMatchObject({ ok: true, cleared: { by: "restart" } });
		expect(await resumeSession(home, A, "user")).toMatchObject({ ok: true, cleared: { by: "user" } });
	});

	test("a session that is not paused is a harmless no-op, and writes nothing", async () => {
		expect(await resumeSession(home, FRESH, "master")).toEqual({ ok: true });
		expect(fs.existsSync(pauseFile(home))).toBe(false);
	});

	test("an unreadable pause file is an error, never a guess, and is left alone", async () => {
		fs.mkdirSync(path.dirname(pauseFile(home)), { recursive: true, mode: 0o700 });
		fs.writeFileSync(pauseFile(home), "{ not json");
		await expect(resumeSession(home, A, "master")).rejects.toThrow("not valid JSON");
		expect(fs.readFileSync(pauseFile(home), "utf8")).toBe("{ not json");
	});

	test("the user pausing a master-paused session takes it over: the master can no longer clear it", async () => {
		await pauseSession(home, A, "master", NOW, "maintenance");
		const out = await say(pause, "");
		expect(out).toBe(`worker-a (${A}) was paused by the master and is now paused by its user (maintenance): only /peers resume clears it`);
		expect(stored().sessions[A]).toEqual({ since: NOW, by: "user", reason: "maintenance" });
		expect(await resumeSession(home, A, "master")).toEqual({ ok: false, error: RESUME_REFUSED.user });
		expect(readPause(home, A).paused).toBe(true);
	});

	test("the other pause orders never weaken a pause: master over user, master over restart, user over restart", async () => {
		await pauseSession(home, A, "user", NOW);
		expect(await pauseSession(home, A, "master", NOW + 1)).toMatchObject({ ok: true, already: true, upgraded: false, entry: { by: "user" } });
		await pauseAfterRestart(home, B, NOW);
		expect(await pauseSession(home, B, "master", NOW + 1)).toMatchObject({ already: true, upgraded: false, entry: { by: "restart" } });
		expect(await pauseSession(home, B, "user", NOW + 2)).toMatchObject({ already: true, upgraded: false, entry: { by: "restart" } });
		expect(await pauseAfterRestart(home, A, NOW + 3)).toMatchObject({ already: true, entry: { by: "user" } });
		expect(readPause(home, A).by).toBe("user");
		expect(readPause(home, B).by).toBe("restart");
	});

	test("the refusal texts are fixed and name the right party", () => {
		expect(RESUME_REFUSED).toEqual({
			user: "paused by its user: only that user can resume it with /peers resume",
			restart: "paused after a restart because it was idle: only its user can resume it",
		});
		expect(SUBAGENT_RESUME_ERROR).toBe("resume is not available to subagents");
	});

	test("a user pause and a master resume racing end consistently (decided under the lock)", async () => {
		for (let round = 0; round < 20; round++) {
			await resumeSession(home, A, "user");
			await pauseSession(home, A, "master", NOW);
			const [userPause, masterResume] = await Promise.all([pauseSession(home, A, "user", NOW + 1), resumeSession(home, A, "master")]);
			// Either the resume won (it cleared the master's pause, then the user's pause is new) or the user's pause won first
			// (the entry became the user's and the resume was refused); never a user-owned pause that the master cleared.
			if (masterResume.ok && masterResume.cleared) expect(userPause.ok && userPause.already).toBe(false);
			else expect(masterResume).toEqual({ ok: false, error: RESUME_REFUSED.user });
			expect(readPause(home, A)).toMatchObject({ paused: true, by: "user" });
		}
	});
});

describe("pause status", () => {
	test("shows who paused and who may resume, read-only", async () => {
		expect(await say(pause, "status")).toBe(`worker-a (${A}) is not paused`);
		await pauseSession(home, A, "master", NOW, "maintenance");
		const iso = new Date(NOW).toISOString();
		expect(await say(pause, "status")).toBe(`worker-a (${A}) is paused since ${iso} by the master (maintenance); resumable by the master (/peers do <peer> resume) or its user (/peers resume)`);
		await resumeSession(home, A, "user");
		await pauseSession(home, A, "user", NOW);
		expect(await say(pause, "status")).toBe(`worker-a (${A}) is paused since ${iso} by its user; resumable by only its user (/peers resume)`);
		await resumeSession(home, A, "user");
		await pauseAfterRestart(home, A, NOW);
		expect(await say(pause, "status")).toBe(`worker-a (${A}) is paused since ${iso} by the restart rule (${RESTART_REASON}); resumable by only its user (/peers resume)`);
		expect(await say(resume, "")).toBe(`resumed worker-a (${A}) (it was paused by the restart rule): wake-triggering messages and prompts are accepted again`);
	});

	test("an unreadable file is reported, not guessed, and not written", async () => {
		fs.mkdirSync(path.dirname(pauseFile(home)), { recursive: true, mode: 0o700 });
		fs.writeFileSync(pauseFile(home), "{ not json");
		expect(await say(pause, "status")).toContain("pause state unreadable");
		expect(fs.readFileSync(pauseFile(home), "utf8")).toBe("{ not json");
	});

	test("`pause status` is read-only: it never creates the file", async () => {
		await say(pause, "status");
		expect(fs.existsSync(pauseFile(home))).toBe(false);
	});
});

describe("restart rule", () => {
	type Case = { name: string; saved: Parameters<typeof restartDecision>[0]; paused: boolean; expected: "pause" | "none" };
	const cases: Case[] = [
		{ name: "no saved record (a brand-new session)", saved: undefined, paused: false, expected: "none" },
		{ name: "clean exit, idle", saved: { clean: true, managed: false }, paused: false, expected: "none" },
		{ name: "clean exit, flagged managed (cannot happen, ignored)", saved: { clean: true, managed: true }, paused: false, expected: "none" },
		{ name: "record from an older version (no clean)", saved: {}, paused: false, expected: "none" },
		{ name: "record with clean of the wrong type", saved: { clean: "false", managed: false }, paused: false, expected: "none" },
		{ name: "unclean, idle or on its own user's turn", saved: { clean: false, managed: false }, paused: false, expected: "pause" },
		{ name: "unclean, `managed` missing", saved: { clean: false }, paused: false, expected: "pause" },
		{ name: "unclean, managed of the wrong type", saved: { clean: false, managed: "true" }, paused: false, expected: "pause" },
		{ name: "unclean, working under the master's management", saved: { clean: false, managed: true }, paused: false, expected: "none" },
		{ name: "unclean, idle, already paused", saved: { clean: false, managed: false }, paused: true, expected: "none" },
		{ name: "unclean, managed, already paused", saved: { clean: false, managed: true }, paused: true, expected: "none" },
		{ name: "clean, already paused", saved: { clean: true, managed: false }, paused: true, expected: "none" },
	];
	for (const c of cases) test(`${c.name} -> ${c.expected}`, () => expect(restartDecision(c.saved, { paused: c.paused })).toBe(c.expected));

	test("the decision is pure: the same input always gives the same answer and no file is touched", () => {
		for (let i = 0; i < 3; i++) expect(restartDecision({ clean: false, managed: false }, { paused: false })).toBe("pause");
		expect(fs.existsSync(pauseFile(home))).toBe(false);
	});

	test("simulated restart: an unclean idle session is paused as `restart`, a managed one is left alone, a clean one is unchanged", async () => {
		const [idle, managed, clean, previouslyPaused, fresh] = ["p00000000000000d1", "p00000000000000d2", "p00000000000000d3", "p00000000000000d4", "p00000000000000d5"];
		const saved: Record<string, Parameters<typeof restartDecision>[0]> = {
			[idle]: { clean: false, managed: false }, [managed]: { clean: false, managed: true }, [clean]: { clean: true, managed: false },
			[previouslyPaused]: { clean: false, managed: false }, [fresh]: undefined,
		};
		await pauseSession(home, previouslyPaused, "master", NOW - 5, "paused earlier");
		for (const id of Object.keys(saved)) {
			if (restartDecision(saved[id], readPause(home, id)) === "pause") await pauseAfterRestart(home, id, NOW);
		}
		expect(readPause(home, idle)).toEqual({ paused: true, since: NOW, by: "restart", reason: "idle before the restart" });
		for (const id of [managed, clean, fresh]) expect(readPause(home, id)).toEqual({ paused: false });
		// An earlier pause keeps its own provenance: the master can still clear it.
		expect(readPause(home, previouslyPaused)).toMatchObject({ by: "master", reason: "paused earlier" });
		expect(await resumeSession(home, idle, "master")).toEqual({ ok: false, error: RESUME_REFUSED.restart });
		expect(await resumeSession(home, previouslyPaused, "master")).toMatchObject({ ok: true, cleared: { by: "master" } });
		// Only the user clears the restart pause; a second restart of a resumed session pauses it again.
		expect(await resumeSession(home, idle, "user")).toMatchObject({ ok: true, cleared: { by: "restart" } });
		expect(restartDecision({ clean: false, managed: false }, readPause(home, idle))).toBe("pause");
	});

	test("the notice is one line, names the session and says only its user can resume", () => {
		const text = restartNotice("worker-a", A);
		expect(text).not.toContain("\n");
		expect(text).toContain(`worker-a (${A}) was paused automatically`);
		expect(text).toContain("the master cannot resume it; run /peers resume to continue");
	});
});

describe("concurrency of provenance writes across real processes", () => {
	const spawn = (id: string, rounds: number) => Bun.spawn([process.execPath, path.join(import.meta.dir, "child_pause.ts"), home, id, String(rounds)], { stdout: "pipe", stderr: "pipe" });

	test("a child's pause and resume loop and in-process master/restart/user writes on other sessions lose no update", async () => {
		const child = spawn(A, 10);
		const kinds: PauseBy[] = ["master", "restart", "user"];
		const ids = Array.from({ length: 9 }, (_, i) => `p00000000000000e${i}`);
		const results = await Promise.all(ids.map((id, i) => pauseSession(home, id, kinds[i % 3], NOW + i)));
		expect(await child.exited).toBe(0);
		expect(results.every(r => r.ok && !r.already)).toBe(true);
		const sessions = stored().sessions;
		expect(Object.keys(sessions).sort()).toEqual([A, ...ids].sort());
		ids.forEach((id, i) => expect(sessions[id].by).toBe(kinds[i % 3]));
	});
});
