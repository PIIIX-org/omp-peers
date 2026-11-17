// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FEATURES } from "../../lib/features";
import type { FeatureHost, SendResult } from "../../lib/features/host";
import { agentContext, answerQuestion, askQuestion, checkQuestions, deferQuestion, inbox, inboxFile, readInbox, reopenQuestion, retryDelivery, type InboxState } from "../../lib/features/inbox";

const MASTER = "p00000000000000aa";
const A = "p00000000000000a1";
const B = "p00000000000000b2";
const NAMES: Record<string, string> = { [MASTER]: "master", [A]: "worker-a", [B]: "worker-b" };

let home: string;
let clock: number;
let sent: Array<{ to: string; text: string }>;
let outcome: SendResult;
let live: string[];
beforeEach(() => {
	home = fs.mkdtempSync(path.join("/tmp", "opi-"));
	clock = 1_700_000_000_000;
	sent = [];
	outcome = { status: "delivered" };
	live = [MASTER, A, B];
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

/** A fake host as seen from peer `self`; `master` says whether that peer holds the master role. The fake `send` records instead of delivering. */
function host(self: string, master = self === MASTER): FeatureHost {
	return {
		home,
		now: () => clock++,
		self: () => ({ id: self, name: NAMES[self] }),
		isMaster: () => master,
		acceptsRemote: () => true,
		peers: async () => live.map(id => ({ id, name: NAMES[id] })),
		groupsOf: () => [],
		usageNow: () => undefined,
		notify: () => {},
		resolveGroup: async () => ({ recipients: [], skipped: [] }),
		resolveModel: async () => ({ ok: false, error: "not exercised by this suite" }), applyModel: async () => ({ ok: false, error: "not exercised by this suite" }),
		send: async (to, req) => {
			sent.push({ to, text: req.text });
			return outcome;
		},
	};
}
const master = () => host(MASTER);
const stored = (): InboxState => JSON.parse(fs.readFileSync(inboxFile(home), "utf8"));
const ask = async (self: string, question: string, extra: Record<string, unknown> = {}) => {
	const result = await askQuestion(host(self), { question, ...extra });
	if (!result.ok) throw new Error(result.error);
	return result;
};
const run = (args: string, h = master()) => inbox.command(args.split(/\s+/), h);

describe("registry and storage", () => {
	test("is registered as /peers inbox with the peers_decision tool", () => {
		expect(FEATURES.map(f => f.name)).toContain("inbox");
		expect(inbox.tools?.().map(t => t.name)).toEqual(["peers_decision"]);
	});

	test("ids are sequential and never reused, even after an old entry is dropped from the file", async () => {
		expect((await ask(A, "one")).entry.id).toBe("q1");
		expect((await ask(A, "two")).entry.id).toBe("q2");
		// Simulate pruning of the newest entry: the counter, not the list, decides the next id.
		const state = stored();
		state.entries.pop();
		fs.writeFileSync(inboxFile(home), JSON.stringify(state));
		expect((await ask(A, "three")).entry.id).toBe("q3");
		expect(stored().entries.map(e => e.id)).toEqual(["q1", "q3"]);
	});

	test("stores a version 1 entry privately with source, limits and no stray fields, and reloads after a restart", async () => {
		const { entry } = await ask(A, "  Which   database?  ", { context: "migration plan", options: ["postgres", "sqlite"], key: "Db-Choice" });
		expect(fs.statSync(inboxFile(home)).mode & 0o777).toBe(0o600);
		expect(fs.statSync(path.dirname(inboxFile(home))).mode & 0o777).toBe(0o700);
		expect(stored().version).toBe(1);
		expect(stored().entries[0]).toEqual({
			id: "q1", source: { id: A, name: "worker-a" }, question: "Which database?", context: "migration plan", options: ["postgres", "sqlite"],
			key: "db-choice", dedupKey: "key:db-choice", createdAt: entry.createdAt, state: "open", delivery: "pending",
		});
		// A fresh host over the same disk state models a process restart.
		expect(readInbox(host(B)).entries.map(e => e.id)).toEqual(["q1"]);
		expect(await run("list", host(B))).toContain("question: Which database?");
	});

	test("enforces the documented length limits", async () => {
		expect(await askQuestion(host(A), { question: "x".repeat(301) })).toEqual({ ok: false, error: "question is longer than 300 characters" });
		expect(await askQuestion(host(A), { question: "ok", context: "y".repeat(501) })).toEqual({ ok: false, error: "context is longer than 500 characters" });
		expect((await askQuestion(host(A), { question: "ok", options: Array.from({ length: 9 }, (_, i) => `o${i}`) })).ok).toBe(false);
		expect((await askQuestion(host(A), { question: "ok", options: Array.from({ length: 8 }, (_, i) => `o${i}`) })).ok).toBe(true);
		expect((await askQuestion(host(A), { question: "" })).ok).toBe(false);
		expect((await askQuestion(host(A), { question: "multi\u0000line" })).ok).toBe(false);
		const long = await answerQuestion(master(), "q1", "z".repeat(501));
		expect(long).toEqual({ ok: false, error: "answer is longer than 500 characters" });
	});

	test("a corrupt file is reported and never overwritten", async () => {
		fs.mkdirSync(path.dirname(inboxFile(home)), { recursive: true });
		fs.writeFileSync(inboxFile(home), "garbage");
		expect(await run("ask anything")).toContain("not valid JSON");
		expect(() => readInbox(master())).toThrow("not valid JSON");
		expect(fs.readFileSync(inboxFile(home), "utf8")).toBe("garbage");
	});

	test("a file that violates the schema is rejected", async () => {
		fs.mkdirSync(path.dirname(inboxFile(home)), { recursive: true });
		fs.writeFileSync(inboxFile(home), JSON.stringify({ version: 1, nextId: 1, entries: [{ id: "q1" }] }));
		expect(await run("list")).toContain("malformed or duplicate entry");
	});
});

describe("deduplication", () => {
	test("a retry of an open question returns the same id; whitespace, case and trailing punctuation are normalized", async () => {
		const first = await ask(A, "Ship it now?");
		const retry = await ask(A, "  ship   IT now ");
		expect(retry.duplicate).toBe(true);
		expect(retry.entry.id).toBe(first.entry.id);
		expect(stored().entries).toHaveLength(1);
	});

	test("the same text from another session is a different question", async () => {
		expect((await ask(A, "Ship it?")).entry.id).toBe("q1");
		expect((await ask(B, "Ship it?")).entry.id).toBe("q2");
	});

	test("an explicit key dedups across different wording but not across sessions", async () => {
		const first = await ask(A, "Which database?", { key: "db" });
		expect((await ask(A, "Postgres or sqlite?", { key: "DB" })).entry.id).toBe(first.entry.id);
		expect((await ask(B, "Which database?", { key: "db" })).entry.id).not.toBe(first.entry.id);
		expect((await askQuestion(host(A), { question: "q", key: "bad key" })).ok).toBe(false);
	});

	test("a deferred question still deduplicates; an answered one does not", async () => {
		const first = await ask(A, "Ship it?");
		await deferQuestion(master(), first.entry.id, "later");
		expect((await ask(A, "Ship it?")).entry.id).toBe(first.entry.id);
		await reopenQuestion(master(), first.entry.id);
		expect((await answerQuestion(master(), first.entry.id, "yes")).ok).toBe(true);
		const again = await ask(A, "Ship it?");
		expect(again.duplicate).toBe(false);
		expect(again.entry.id).toBe("q2");
	});
});

describe("authorization", () => {
	test("any session may ask, list and check; only the master may answer, defer, reopen or retry", async () => {
		await ask(A, "Ship it?");
		const worker = host(B, false);
		for (const result of [await answerQuestion(worker, "q1", "yes"), await deferQuestion(worker, "q1", ""), await reopenQuestion(worker, "q1"), await retryDelivery(worker, "q1")]) {
			expect(result).toEqual({ ok: false, error: expect.stringContaining("only the master session may answer, defer, reopen or retry") });
		}
		expect(await run("answer q1 yes", worker)).toContain("run /peers master first");
		expect(stored().entries[0].state).toBe("open");
		expect(sent).toEqual([]);
		expect(await run("list", worker)).toContain("q1  open");
		expect(checkQuestions(host(A), undefined).ok).toBe(true);
	});

	test("a session that is not master cannot answer its own question", async () => {
		await ask(A, "Ship it?");
		const result = await answerQuestion(host(A, false), "q1", "yes");
		expect(result.ok).toBe(false);
		expect(stored().entries[0].state).toBe("open");
	});
});

describe("listing is read-only", () => {
	test("list and check leave the store byte-for-byte and mtime unchanged, and send nothing", async () => {
		await ask(A, "Ship it?", { context: "release" });
		await ask(B, "Rename the module?");
		await answerQuestion(master(), "q2", "no");
		sent = [];
		const file = inboxFile(home);
		const before = { bytes: fs.readFileSync(file, "utf8"), mtime: fs.statSync(file).mtimeMs, files: fs.readdirSync(path.dirname(file)).sort() };
		const text = await run("list");
		await run("list --open");
		await run("");
		checkQuestions(host(A));
		expect(text).toContain("from worker-a (" + A + ") [live]");
		expect(text).toContain("context: release");
		expect(fs.readFileSync(file, "utf8")).toBe(before.bytes);
		expect(fs.statSync(file).mtimeMs).toBe(before.mtime);
		expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(before.files);
		expect(sent).toEqual([]);
	});

	test("listing a missing inbox creates nothing", async () => {
		expect(await run("list")).toBe("inbox is empty");
		expect(fs.existsSync(path.join(home, ".omp"))).toBe(false);
	});

	test("groups by source, shows state, requested decision and whether the source is live", async () => {
		await ask(A, "Ship it?", { options: ["yes", "no"] });
		await ask(B, "Rename?");
		await ask(A, "Second from a?");
		live = [MASTER, B];
		const text = await run("list");
		expect(text.indexOf("from worker-a")).toBeLessThan(text.indexOf("from worker-b"));
		expect(text.match(/from worker-a/g)).toHaveLength(1);
		expect(text).toContain(`from worker-a (${A}) [not live]`);
		expect(text).toContain(`from worker-b (${B}) [live]`);
		expect(text).toContain("requested decision: choose one of: yes | no");
		expect(text).toContain("inbox: 3 open, 0 deferred, 0 answered");
		await deferQuestion(master(), "q3", "");
		expect(await run("list --open")).not.toContain("q3");
		expect(await run("list")).toContain("deferred (no note)");
	});
});

describe("answer delivery", () => {
	test("a live source gets exactly one message naming the id and the decision; delivery is recorded", async () => {
		await ask(A, "Ship it?");
		const out = await run("answer q1 yes, ship it");
		expect(out).toContain("q1 answered; the answer was delivered to worker-a");
		expect(sent).toHaveLength(1);
		expect(sent[0].to).toBe(A);
		expect(sent[0].text).toContain("q1");
		expect(sent[0].text).toContain("Question: Ship it?");
		expect(sent[0].text).toContain("Decision: yes, ship it");
		const entry = stored().entries[0];
		expect([entry.state, entry.delivery, entry.resolution]).toEqual(["answered", "delivered", "yes, ship it"]);
		expect(entry.resolvedAt).toBeGreaterThan(entry.createdAt);
		expect(await run("retry q1")).toContain("already delivered");
		expect(await run("answer q1 again")).toContain("already answered");
		expect(sent).toHaveLength(1);
	});

	test("a refusal is recorded as the reason and retry re-attempts", async () => {
		await ask(A, "Ship it?");
		outcome = { status: "failed", reason: "peer refuses inbound requests" };
		expect(await run("answer q1 yes")).toContain("undeliverable: peer refuses inbound requests");
		expect(stored().entries[0].delivery).toBe("undeliverable: peer refuses inbound requests");
		outcome = { status: "delivered" };
		expect(await run("retry q1")).toContain("delivered to worker-a");
		expect(stored().entries[0].delivery).toBe("delivered");
		expect(sent).toHaveLength(2);
	});

	test("an unreachable or rate-limited source records its own reason", async () => {
		await ask(A, "Ship it?");
		outcome = { status: "failed", reason: "unreachable (ECONNREFUSED)" };
		await answerQuestion(master(), "q1", "yes");
		expect(stored().entries[0].delivery).toBe("undeliverable: unreachable (ECONNREFUSED)");
		outcome = { status: "failed", reason: "rate limited" };
		await retryDelivery(master(), "q1");
		expect(stored().entries[0].delivery).toBe("undeliverable: rate limited");
		expect(checkQuestions(host(A), "q1")).toEqual({ ok: true, text: expect.stringContaining("delivery: undeliverable: rate limited") });
	});

	test("an answer to a paused asking session is stored as undeliverable and the asker can still read it with check", async () => {
		await ask(A, "Ship it?");
		outcome = { status: "failed", reason: "session is paused" };
		const reply = await run("answer q1 yes");
		expect(stored().entries[0].delivery).toBe("undeliverable: session is paused");
		expect(reply).toContain("session is paused");
		expect(reply).toContain("(resume policy: see /peers pause status)"); // no pause file in this suite: who paused it is not known
		expect(checkQuestions(host(A), "q1")).toEqual({ ok: true, text: expect.stringContaining("delivery: undeliverable: session is paused") });
		outcome = { status: "delivered" };
		await retryDelivery(master(), "q1");
		expect(stored().entries[0].delivery).toBe("delivered");
	});

	test("an offline source keeps the resolution, stays pending, is read by check, and retry delivers once it is live", async () => {
		await ask(A, "Ship it?");
		outcome = { status: "offline" };
		expect(await run("answer q1 yes")).toContain("delivery is pending");
		expect(stored().entries[0]).toMatchObject({ state: "answered", resolution: "yes", delivery: "pending" });
		const check = checkQuestions(host(A));
		expect(check).toEqual({ ok: true, text: expect.stringContaining("q1 answered: yes") });
		expect(sent).toHaveLength(1);
		outcome = { status: "delivered" };
		expect(await run("retry q1")).toContain("delivered");
		expect(sent).toHaveLength(2);
		expect(stored().entries[0].delivery).toBe("delivered");
	});

	test("answering the master's own question sends nothing and stays readable by check", async () => {
		await ask(MASTER, "Mine?");
		expect(await run("answer q1 yes")).toContain("delivery is pending");
		expect(sent).toEqual([]);
		expect(checkQuestions(master(), "q1")).toEqual({ ok: true, text: expect.stringContaining("q1 answered: yes") });
	});

	test("defer sends nothing; reopen returns it to open and clears the resolution", async () => {
		await ask(A, "Ship it?");
		expect(await run("defer q1 ask again after the demo")).toContain("deferred; nothing was sent");
		expect(sent).toEqual([]);
		expect(stored().entries[0]).toMatchObject({ state: "deferred", resolution: "ask again after the demo" });
		expect(checkQuestions(host(A), "q1")).toEqual({ ok: true, text: expect.stringContaining("deferred by the user: ask again after the demo") });
		expect(await run("retry q1")).toContain("deferring sends nothing");
		expect(await run("reopen q1")).toContain("q1 reopened");
		expect(stored().entries[0].state).toBe("open");
		expect(stored().entries[0].resolution).toBeUndefined();
		expect(await run("reopen q1")).toContain("already open");
		await answerQuestion(master(), "q1", "yes");
		expect(await run("reopen 1")).toContain("reopened");
		expect(stored().entries[0]).toMatchObject({ state: "open", delivery: "pending" });
	});

	test("unknown ids and bad ids are errors", async () => {
		expect(await run("answer q9 yes")).toBe("error: no inbox question q9");
		expect(await run("answer nope yes")).toContain("not an inbox id");
		expect(await run("defer q9")).toBe("error: no inbox question q9");
		expect(await run("reopen q9")).toBe("error: no inbox question q9");
		expect(await run("retry q9")).toBe("error: no inbox question q9");
		expect(await run("frobnicate")).toContain("usage:");
	});

	test("check shows only the session's own questions", async () => {
		await ask(A, "Mine?");
		await ask(B, "Not yours?");
		const own = checkQuestions(host(A));
		expect(own).toEqual({ ok: true, text: expect.stringContaining("q1 open") });
		expect(JSON.stringify(own)).not.toContain("Not yours");
		expect(checkQuestions(host(A), "q2")).toEqual({ ok: false, error: "no question q2 from this session" });
		expect(checkQuestions(host(MASTER))).toEqual({ ok: true, text: "this session has no inbox questions" });
	});
});

describe("secret rejection", () => {
	const token = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2";
	test("credential-looking question, context, option, answer and note are rejected without echoing the secret or writing", async () => {
		const checks = [
			await askQuestion(host(A), { question: `use ${token} for deploy?` }),
			await askQuestion(host(A), { question: "ok", context: `password=${"abcd1234" + "efgh5678"}` }),
			await askQuestion(host(A), { question: "ok", options: [`Bearer ${"x".repeat(24)}`] }),
		];
		for (const result of checks) {
			expect(result.ok).toBe(false);
			expect(JSON.stringify(result)).not.toContain(token);
			expect(JSON.stringify(result)).toContain("credential");
		}
		expect(fs.existsSync(inboxFile(home))).toBe(false);
		await ask(A, "Ship it?");
		expect(await run(`answer q1 use ${token}`)).toContain("credential");
		expect(await run(`defer q1 note ${token}`)).toContain("credential");
		expect(fs.readFileSync(inboxFile(home), "utf8")).not.toContain(token);
		expect(sent).toEqual([]);
	});
});

describe("the peers_decision tool", () => {
	const tool = inbox.tools!()[0];
	test("ask queues and returns the id; a retry says it is already queued; check reports the answer", async () => {
		const asked = await tool.execute({ action: "ask", question: "Ship it?", options: ["yes", "no"] }, host(A));
		expect(asked.text).toContain("queued q1");
		const retry = await tool.execute({ action: "ask", question: "ship it?" }, host(A));
		expect(retry.text).toContain("q1 is already queued");
		expect(stored().entries).toHaveLength(1);
		await answerQuestion(master(), "q1", "yes");
		expect((await tool.execute({ action: "check" }, host(A))).text).toContain("q1 answered: yes");
		expect((await tool.execute({ action: "check", id: "q1" }, host(A))).isError).toBeUndefined();
	});

	test("bad input is an error result, not a throw", async () => {
		expect(await tool.execute({ action: "ask" }, host(A))).toEqual({ text: "error: question is required", isError: true });
		expect(await tool.execute({ action: "ask", question: 5 }, host(A))).toMatchObject({ isError: true });
		expect(await tool.execute({ action: "ask", question: "q", options: "yes" }, host(A))).toMatchObject({ isError: true });
		expect(await tool.execute({ action: "wipe" }, host(A))).toMatchObject({ isError: true });
		expect(await tool.execute({ action: "check", id: "zzz" }, host(A))).toMatchObject({ isError: true });
	});
});

describe("capacity", () => {
	test("drops the oldest answered-and-delivered entries first, keeps unresolved ones, and refuses when nothing can be dropped", async () => {
		const seed: InboxState = { version: 1, nextId: 501, entries: [] };
		for (let i = 1; i <= 500; i++) {
			const delivered = i <= 2;
			seed.entries.push({
				id: `q${i}`, source: { id: A, name: "worker-a" }, question: `question ${i}`, dedupKey: `text:question ${i}`, createdAt: i,
				state: delivered ? "answered" : "open", ...(delivered ? { resolution: "done", resolvedAt: i } : {}), delivery: delivered ? "delivered" : "pending",
			});
		}
		fs.mkdirSync(path.dirname(inboxFile(home)), { recursive: true });
		fs.writeFileSync(inboxFile(home), JSON.stringify(seed));
		expect((await ask(B, "new one")).entry.id).toBe("q501");
		expect(stored().entries.map(e => e.id).slice(0, 2)).toEqual(["q2", "q3"]);
		expect((await ask(B, "another")).entry.id).toBe("q502");
		expect(stored().entries.map(e => e.id)[0]).toBe("q3");
		// Both delivered entries are gone; every remaining entry is unresolved, so there is no room.
		expect(await askQuestion(host(B), { question: "overflow" })).toEqual({ ok: false, error: expect.stringContaining("inbox is full") });
		expect(stored().entries).toHaveLength(500);
	});

	test("an inbox full of pending answers frees room oldest-answered-first; open and deferred entries stay; a master context line counts open questions", async () => {
		const seed: InboxState = { version: 1, nextId: 501, entries: [] };
		for (let i = 1; i <= 500; i++) {
			const base = { id: `q${i}`, source: { id: A, name: "worker-a" }, question: `question ${i}`, dedupKey: `text:question ${i}`, createdAt: i };
			if (i === 1) seed.entries.push({ ...base, state: "answered", resolution: "r", resolvedAt: 1, delivery: "pending" });
			else if (i === 2) seed.entries.push({ ...base, state: "answered", resolution: "r", resolvedAt: 2, delivery: "undeliverable: peer refuses inbound requests" });
			else if (i === 3) seed.entries.push({ ...base, state: "answered", resolution: "r", resolvedAt: 3, delivery: "delivered" });
			else seed.entries.push({ ...base, state: i % 2 ? "open" : "deferred", delivery: "pending" });
		}
		fs.mkdirSync(path.dirname(inboxFile(home)), { recursive: true });
		fs.writeFileSync(inboxFile(home), JSON.stringify(seed));
		await ask(B, "one");
		expect(stored().entries.some(e => e.id === "q3")).toBe(false);
		expect(stored().entries.slice(0, 2).map(e => e.id)).toEqual(["q1", "q2"]);
		await ask(B, "two");
		expect(stored().entries.slice(0, 2).map(e => e.id)).toEqual(["q2", "q4"]);
		await ask(B, "three");
		expect(stored().entries.some(e => e.state === "answered")).toBe(false);
		const full = await askQuestion(host(B), { question: "overflow" });
		expect(full).toEqual({ ok: false, error: "inbox is full (500 entries, all open or deferred); answer some to free room" });
		expect(stored().entries).toHaveLength(500);
		expect(stored().entries.filter(e => e.state === "deferred").length).toBeGreaterThan(0);
		// Answering frees room again, and the master sees a count line without question text.
		const line = agentContext(master())!;
		expect(line).toMatch(/^Decision inbox: \d+ open question\(s\) from other sessions \(q\d+, /);
		expect(line).not.toContain("question 5");
		expect(agentContext(host(A, false))).toBeUndefined();
		expect(agentContext({ ...master(), acceptsRemote: () => false })).toBeUndefined();
		fs.rmSync(inboxFile(home));
		expect(agentContext(master())).toBeUndefined();
	});
});

describe("concurrency", () => {
	test("two real processes asking simultaneously lose no entry and never share an id", async () => {
		const spawn = (id: string, tag: string, count: number) => Bun.spawn([process.execPath, path.join(import.meta.dir, "child_ask.ts"), home, id, tag, String(count)], { stdout: "pipe", stderr: "pipe" });
		const children = [spawn(A, "left", 15), spawn(B, "right", 15)];
		const codes = await Promise.all(children.map(child => child.exited));
		const stderr = await Promise.all(children.map(child => new Response(child.stderr).text()));
		expect(codes, stderr.join("\n")).toEqual([0, 0]);
		const entries = stored().entries;
		expect(entries).toHaveLength(30);
		expect(new Set(entries.map(e => e.id)).size).toBe(30);
		expect(stored().nextId).toBe(31);
		expect(entries.filter(e => e.source.id === A).map(e => e.question).sort()).toEqual(Array.from({ length: 15 }, (_, i) => `left question ${i}`).sort());
		expect(entries.filter(e => e.source.id === B)).toHaveLength(15);
	});

	test("simultaneous identical retries from two processes deduplicate to one entry", async () => {
		const spawn = () => Bun.spawn([process.execPath, path.join(import.meta.dir, "child_ask.ts"), home, A, "same", "5"], { stdout: "pipe", stderr: "pipe" });
		expect(await Promise.all([spawn(), spawn()].map(child => child.exited))).toEqual([0, 0]);
		expect(stored().entries).toHaveLength(5);
	});
});
