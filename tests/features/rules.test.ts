// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FEATURES } from "../../lib/features";
import type { FeatureHost } from "../../lib/features/host";
import { addRule, agentContext, effectiveRules, removeRule, rules, rulesFile, screenText, type Rule, type RulesState } from "../../lib/features/rules";

const MASTER = "p00000000000000aa";
const A = "p00000000000000a1";
const B = "p00000000000000b2";
const PEERS = [{ id: MASTER, name: "master" }, { id: A, name: "worker-a" }, { id: B, name: "worker-b" }, { id: "p00000000000000c3", name: "twin" }, { id: "p00000000000000c4", name: "Twin" }];

let home: string;
let groups: Record<string, string[]>;
beforeEach(() => {
	home = fs.mkdtempSync(path.join("/tmp", "opf-"));
	groups = {};
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

/** A fake host as seen from peer `self`; `master` says whether that peer holds the master role. */
function host(self: string, master = self === MASTER): FeatureHost {
	return {
		home,
		now: () => 1_700_000_000_000,
		self: () => PEERS.find(peer => peer.id === self)!,
		isMaster: () => master,
		acceptsRemote: () => true,
		peers: async () => PEERS,
		groupsOf: peerId => groups[peerId] ?? [],
		notify: () => {},
		resolveGroup: async () => ({ recipients: [], skipped: [] }), // not exercised by this suite
		resolveModel: async () => ({ ok: false, error: "not exercised by this suite" }), applyModel: async () => ({ ok: false, error: "not exercised by this suite" }),
		send: async () => ({ status: "offline" }),
	};
}
const master = () => host(MASTER);
const stored = (): RulesState => JSON.parse(fs.readFileSync(rulesFile(home), "utf8"));
const add = async (scope: string, text: string, key?: string, h = master()) => {
	const result = await addRule(h, scope, text, key);
	if (!result.ok) throw new Error(result.error);
	return result.rule;
};
const run = (args: string, h = master()) => rules.command(args.split(/\s+/), h);
const injected = (self: string) => agentContext(host(self, false));
const lines = (text: string | undefined) => (text ?? "").split("\n").filter(line => line.startsWith("- ")).map(line => line.replace(/^- \[\S+ \S+\] /, ""));

describe("registry and storage", () => {
	test("is registered as /peers rules", () => {
		expect(FEATURES.map(f => f.name)).toContain("rules");
	});

	test("add returns stable sequential ids; removed ids are never reused", async () => {
		expect((await add("global", "one")).id).toBe("r1");
		expect((await add("global", "two")).id).toBe("r2");
		expect((await removeRule(master(), "r2")).ok).toBe(true);
		expect((await add("global", "three")).id).toBe("r3");
		expect(stored().rules.map(r => r.id)).toEqual(["r1", "r3"]);
	});

	test("stores privately as version 1 and reloads after a restart", async () => {
		await add("global", "persist me");
		await add("group:frontend", "group rule");
		expect(fs.statSync(rulesFile(home)).mode & 0o777).toBe(0o600);
		expect(fs.statSync(path.dirname(rulesFile(home))).mode & 0o777).toBe(0o700);
		expect(stored().version).toBe(1);
		// A fresh host object over the same disk state models a process restart.
		expect(lines(injected(A))).toEqual(["persist me"]);
		expect(await run("list")).toContain("r2  group:frontend  group rule");
	});

	test("records who added a rule and when, and no peer names", async () => {
		await add("session:worker-a", "mine");
		expect(stored().rules[0]).toEqual({ id: "r1", scope: `session:${A}`, text: "mine", addedBy: MASTER, createdAt: 1_700_000_000_000 });
		expect(fs.readFileSync(rulesFile(home), "utf8")).not.toContain("worker-a");
	});

	test("a corrupt file is reported and never overwritten", async () => {
		fs.mkdirSync(path.dirname(rulesFile(home)), { recursive: true });
		fs.writeFileSync(rulesFile(home), "garbage");
		expect(await run("add global x")).toContain("not valid JSON");
		expect(() => injected(A)).toThrow("not valid JSON");
		expect(fs.readFileSync(rulesFile(home), "utf8")).toBe("garbage");
	});
});

describe("scopes and authorization", () => {
	test("a session scope resolves an exact name or id to the stable id at add time", async () => {
		expect((await add("session:worker-a", "by name")).scope).toBe(`session:${A}`);
		expect((await add(`session:${B}`, "by id")).scope).toBe(`session:${B}`);
		expect((await add("session:WORKER-A", "case-insensitive name")).scope).toBe(`session:${A}`);
	});

	test("unknown, ambiguous and malformed scopes are rejected without storing", async () => {
		expect(await addRule(master(), "session:nobody", "x")).toMatchObject({ ok: false, error: expect.stringContaining("no live peer") });
		expect(await addRule(master(), "session:twin", "x")).toMatchObject({ ok: false, error: expect.stringContaining("ambiguous") });
		expect(await addRule(master(), "group:Bad Name", "x")).toMatchObject({ ok: false });
		expect(await addRule(master(), "group:", "x")).toMatchObject({ ok: false });
		expect(await addRule(master(), "everyone", "x")).toMatchObject({ ok: false, error: expect.stringContaining("scope must be") });
		expect(fs.existsSync(rulesFile(home))).toBe(false);
	});

	test("only the master changes rules that reach other sessions; a session manages its own", async () => {
		const worker = host(A, false);
		expect(await addRule(worker, "global", "x")).toMatchObject({ ok: false, error: expect.stringContaining("master") });
		expect(await addRule(worker, "group:frontend", "x")).toMatchObject({ ok: false });
		expect(await addRule(worker, `session:${B}`, "x")).toMatchObject({ ok: false });
		expect(fs.existsSync(rulesFile(home))).toBe(false);
		const own = await addRule(worker, "session:worker-a", "own rule");
		expect(own.ok).toBe(true);
		const globalRule = await add("global", "everyone");
		const other = await add(`session:${B}`, "for b");
		expect(await removeRule(worker, globalRule.id)).toMatchObject({ ok: false });
		expect(await removeRule(worker, other.id)).toMatchObject({ ok: false });
		expect((await removeRule(host(B, false), "r1")).ok).toBe(false);
		expect((await removeRule(worker, "r1")).ok).toBe(true);
		expect(stored().rules.map(r => r.id)).toEqual(["r2", "r3"]);
		expect((await removeRule(master(), "r2")).ok).toBe(true);
	});

	test("removing an unknown or malformed id fails clearly", async () => {
		await add("global", "x");
		expect(await removeRule(master(), "r9")).toEqual({ ok: false, error: "no rule r9" });
		expect(await removeRule(master(), "nope")).toMatchObject({ ok: false });
		expect((await removeRule(master(), "1")).ok).toBe(true);
	});
});

describe("duplicates and secrets", () => {
	test("identical scope and text is rejected with the existing id, including after normalization", async () => {
		await add("global", "run the formatter");
		for (const text of ["run the formatter", "  run   the formatter ", "\"run the formatter\""]) {
			expect(await addRule(master(), "global", text)).toEqual({ ok: false, error: "duplicate: r1 already has this scope and text", existing: "r1" });
		}
		expect(await addRule(master(), "global", "run the formatter", "fmt")).toMatchObject({ ok: false, existing: "r1" });
		expect(stored().rules).toHaveLength(1);
		// Same text under a different scope is a separate, intentional rule.
		expect((await add("group:frontend", "run the formatter")).id).toBe("r2");
	});

	test.each([
		// Fragments are joined at runtime so this file itself contains no credential-shaped text.
		["api key assignment", `use ${"api_"}${"key="}${"abcd1234efgh5678"} for the build`],
		["token prefix", `export ${"ghp_"}${"a".repeat(24)}`],
		["bearer", `send Bearer ${"x".repeat(20)} always`],
		["private key", `${"-----BEGIN "}${"PRIVATE KEY-----"} stuff`],
		["url userinfo", `clone https://${"user"}:${"hunter2hunter2"}${"@"}host.test/repo`],
		["password assignment", `${"pass"}${"word"}: ${"correcthorsebattery"}`],
	])("rejects credential-looking text (%s) without echoing it", async (_name, text) => {
		const result = await addRule(master(), "global", text);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("credential");
			expect(result.error).not.toContain(text.slice(-12));
		}
		expect(fs.existsSync(rulesFile(home))).toBe(false);
		expect(screenText(text)).toBeDefined();
	});

	test("ordinary instructions mentioning secrets abstractly are accepted", async () => {
		expect(screenText("never commit tokens; read them from the keychain")).toBeUndefined();
		expect(screenText("run tests before pushing")).toBeUndefined();
	});

	test("validates text length, emptiness and key labels", async () => {
		expect(await addRule(master(), "global", "   ")).toMatchObject({ ok: false });
		expect(await addRule(master(), "global", "x".repeat(401))).toMatchObject({ ok: false });
		expect(await addRule(master(), "global", "ok", "Bad Key")).toMatchObject({ ok: false });
		expect((await addRule(master(), "global", "ok", "Tests")).ok).toBe(true);
		expect(stored().rules[0].key).toBe("tests");
	});
});

describe("matching, precedence and conflicts", () => {
	const rule = (id: number, scope: string, text: string, key?: string): Rule => ({ id: `r${id}`, scope, text, ...(key ? { key } : {}), addedBy: MASTER, createdAt: 0 });

	test("session > group > global; groups by lexical name then id; deterministic under input order", () => {
		const all = [
			rule(1, "global", "g1"), rule(2, "group:beta", "b2"), rule(3, "group:alpha", "a3"), rule(4, `session:${A}`, "s4"),
			rule(5, "group:alpha", "a5"), rule(6, "global", "g6"), rule(7, `session:${B}`, "other session"), rule(8, "group:gamma", "not a member"),
		];
		const expected = ["s4", "a3", "a5", "b2", "g1", "g6"];
		for (const order of [all, [...all].reverse(), [all[3], all[0], all[6], all[2], all[7], all[1], all[5], all[4]]]) {
			expect(effectiveRules(order, A, ["beta", "alpha"]).map(e => e.rule.text)).toEqual(expected);
		}
		expect(effectiveRules(all, A, []).map(e => e.rule.text)).toEqual(["s4", "g1", "g6"]);
		expect(effectiveRules(all, A, ["ALPHA"]).map(e => e.rule.text)).toEqual(["s4", "a3", "a5", "g1", "g6"]);
	});

	test("conflicting keyed rules: the more specific scope wins and the loser is shown overridden", () => {
		const all = [rule(1, "global", "use tabs", "style"), rule(2, "group:web", "use spaces", "style"), rule(3, `session:${A}`, "use two spaces", "style"), rule(4, "global", "be brief")];
		const effective = effectiveRules(all, A, ["web"]);
		expect(effective.map(e => [e.rule.id, e.status, e.by])).toEqual([
			["r3", "active", undefined], ["r2", "overridden", "r3"], ["r1", "overridden", "r3"], ["r4", "active", undefined],
		]);
		expect(effectiveRules(all, B, ["web"]).map(e => [e.rule.id, e.status])).toEqual([["r2", "active"], ["r1", "overridden"], ["r4", "active"]]);
	});

	test("same key within one scope: lower id wins; across group names the lexically first wins", () => {
		const same = effectiveRules([rule(1, "global", "first", "k"), rule(2, "global", "second", "k")], A, []);
		expect(same.map(e => e.status)).toEqual(["active", "overridden"]);
		const groupsOnly = effectiveRules([rule(1, "group:zeta", "z", "k"), rule(2, "group:alpha", "a", "k")], A, ["zeta", "alpha"]);
		expect(groupsOnly.map(e => [e.rule.text, e.status])).toEqual([["a", "active"], ["z", "overridden"]]);
	});

	test("identical text is redundant, not a conflict, and is injected once", () => {
		const entries = effectiveRules([rule(1, "global", "same", "k"), rule(2, `session:${A}`, "same", "k"), rule(3, "global", "plain"), rule(4, `session:${A}`, "plain")], A, []);
		expect(entries.map(e => [e.rule.id, e.status, e.by])).toEqual([["r2", "active", undefined], ["r4", "active", undefined], ["r1", "redundant", "r2"], ["r3", "redundant", "r4"]]);
	});

	test("explain shows precedence, groups, winners, overridden losers and the injection verdict", async () => {
		groups[A] = ["web"];
		await add("global", "run X", "tests");
		await add("group:web", "run Y", "tests");
		await add("global", "be brief");
		const out = await run("explain worker-a");
		expect(out).toContain(`rules for worker-a (${A})`);
		expect(out).toContain("groups: web");
		expect(out).toContain("precedence: session > group");
		expect(out).toContain("1. r2  group:web  [key=tests]  run Y");
		expect(out).toContain("2. r3  global  be brief");
		expect(out).toContain("overridden: r1  global  [key=tests]  run X  -- conflicts with r2");
		expect(out).toContain("injection: 2 of 2 rule(s)");
		const lockedPeers = { ...master(), peers: async () => PEERS.map(peer => peer.id === A ? { ...peer, acceptsRemote: false } : peer) };
		const lockedView = await rules.command(["explain", A], lockedPeers);
		expect(lockedView).toContain("only rules this session added itself are injected");
		expect(lockedView).toContain("injection: none; no rules apply");
		await addRule(host(A, false), `session:${A}`, "self rule");
		expect(await rules.command(["explain", A], lockedPeers)).toContain("injection: 1 of 1 rule(s)");
		const offline = await run("explain p00000000000000f9");
		expect(offline).toContain("inbound state unknown");
		groups[B] = [];
		expect(await run(`explain ${B}`)).toContain("1. r1  global  [key=tests]  run X");
		expect(await run("explain nobody")).toContain("error: no live peer matches");
		const quiet = await run("explain worker-b");
		expect(quiet).not.toContain("overridden");
	});

	test("add reports a visible conflict; list marks both sides but not rules for different sessions", async () => {
		await add("global", "run X", "tests");
		const out = await run("add group:web --key tests run Y");
		expect(out).toContain("added r2 (group:web): run Y");
		expect(out).toContain("conflict: r1 (global)");
		await add(`session:${A}`, "alpha only", "mode");
		await add(`session:${B}`, "beta only", "mode");
		const list = await run("list");
		expect(list).toMatch(/r1 {2}global {2}\[key=tests\] {2}run X {2}-- CONFLICT with r2/);
		expect(list).toMatch(/r2 {2}group:web .*-- CONFLICT with r1/);
		expect(list).not.toMatch(/r3 .*CONFLICT/);
		expect(list.indexOf("r3  ")).toBeLessThan(list.indexOf("r2  "));
		expect(list.indexOf("r2  ")).toBeLessThan(list.indexOf("r1  "));
	});
});

describe("injection", () => {
	test("contains exactly the effective rules, most specific first, and nothing for others", async () => {
		groups[A] = ["web"];
		await add("global", "G rule");
		await add("group:web", "W rule");
		await add("group:other", "O rule");
		await add("session:worker-a", "S rule");
		await add(`session:${B}`, "B rule");
		await add("global", "lost", "k");
		await add("session:worker-a", "won", "k");
		expect(lines(injected(A))).toEqual(["S rule", "won", "W rule", "G rule"]);
		expect(lines(injected(B))).toEqual(["B rule", "G rule", "lost"]);
		expect(injected(A)).toContain("[r4 session] S rule");
		expect(injected(A)).toContain("[r2 group:web] W rule");
		expect(injected(A)).not.toMatch(/O rule|B rule|lost/);
	});

	test("removing a rule removes it from the next injection; nothing applies means nothing is injected", async () => {
		const first = await add("global", "keep");
		const second = await add(`session:${A}`, "drop");
		expect(lines(injected(A))).toEqual(["drop", "keep"]);
		await removeRule(master(), second.id);
		expect(lines(injected(A))).toEqual(["keep"]);
		await removeRule(master(), first.id);
		expect(injected(A)).toBeUndefined();
		expect(await run(`explain ${A}`)).toContain("injection: none; no rules apply");
		expect(await run("list")).toBe("no standing rules");
	});

	test("group membership comes from the host at injection time", async () => {
		await add("group:web", "web rule");
		expect(injected(A)).toBeUndefined();
		groups[A] = ["web"];
		expect(lines(injected(A))).toEqual(["web rule"]);
	});

	test("list --effective matches what that peer is injected, including offline stable ids", async () => {
		await add("global", "g");
		await add(`session:${A}`, "s");
		const out = await run("list --effective worker-a");
		expect(out).toContain("1. r2");
		expect(out).toContain("2. r1");
		expect(await run("list --effective p00000000000000f9")).toContain("1. r1  global  g");
	});

	test("a locked or refusing session is injected only its own rules, never rules authored by others", async () => {
		await add("global", "from master");
		await add(`session:${A}`, "master wrote this for a");
		const own = await addRule(host(A, false), `session:${A}`, "self added");
		expect(own.ok).toBe(true);
		expect(lines(injected(A))).toEqual(["master wrote this for a", "self added", "from master"]);
		const locked = { ...host(A, false), acceptsRemote: () => false };
		expect(lines(agentContext(locked))).toEqual(["self added"]);
		await removeRule(host(A, false), "r3");
		expect(agentContext(locked)).toBeUndefined();
	});

	test("a redundant copy keeps its key so a conflicting global cannot slip in beside it", async () => {
		await add("global", "use tabs", "style");
		await add("global", "use spaces", "style");
		await add(`session:${A}`, "use tabs");
		expect(lines(injected(A))).toEqual(["use tabs"]);
		const statuses = effectiveRules(stored().rules, A, []).map(entry => `${entry.rule.id}:${entry.status}`);
		expect(statuses).toEqual(["r3:active", "r1:redundant", "r2:overridden"]);
	});

	test("limits: per-scope and total rule counts refuse the add; injection is size-capped deterministically", async () => {
		for (let i = 0; i < 25; i++) await add("global", `rule number ${i}`);
		const over = await addRule(master(), "global", "one too many");
		expect(over.ok).toBe(false);
		expect(!over.ok && over.error).toContain("scope limit");
		for (const g of ["g1", "g2", "g3"]) for (let i = 0; i < 25; i++) await add(`group:${g}`, `${g} ${"x".repeat(380)} ${i}`);
		const total = await addRule(master(), "group:g4", "past the total");
		expect(total.ok).toBe(false);
		expect(!total.ok && total.error).toContain("rule limit");
		groups[A] = ["g1", "g2", "g3"];
		const text = injected(A)!;
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8192);
		const omitted = Number(/\((\d+) lower-precedence/.exec(text)![1]);
		const injectedCount = lines(text).length - 1; // the omission note is a list line too
		expect(text).toMatch(/\(\d+ lower-precedence rule\(s\) omitted: 8192-byte injection cap\)/);
		expect(text).toBe(injected(A)!);
		const explained = await run(`explain ${A}`);
		expect(explained).toContain(`injection: ${injectedCount} of ${injectedCount + omitted} rule(s)`);
		expect(explained).toContain(`${omitted} omitted: 8192-byte injection cap`);
	});
});

describe("concurrency across real processes", () => {
	const spawn = (tag: string, count: number) => Bun.spawn([process.execPath, path.join(import.meta.dir, "child_add.ts"), home, tag, String(count)], { stdout: "pipe", stderr: "pipe" });

	test("adds from two processes lose nothing and ids stay unique", async () => {
		const children = [spawn("left", 12), spawn("right", 12)];
		const codes = await Promise.all(children.map(child => child.exited));
		expect(codes).toEqual([0, 0]);
		const state = stored();
		expect(state.rules).toHaveLength(24);
		expect(new Set(state.rules.map(r => r.id)).size).toBe(24);
		expect(new Set(state.rules.map(r => r.text)).size).toBe(24);
		expect(state.nextId).toBe(25);
	});

	test("identical adds racing in two processes store exactly one rule", async () => {
		const codes = await Promise.all([spawn("same", 5), spawn("same", 5)].map(child => child.exited));
		expect(codes).toEqual([0, 0]);
		expect(stored().rules.map(r => r.text).sort()).toEqual(["same rule 0", "same rule 1", "same rule 2", "same rule 3", "same rule 4"]);
	});

	test("a process add and in-process adds interleave without loss", async () => {
		const child = spawn("child", 10);
		await Promise.all(Array.from({ length: 10 }, (_, i) => add("global", `local ${i}`)));
		expect(await child.exited).toBe(0);
		expect(stored().rules).toHaveLength(20);
	});
});
