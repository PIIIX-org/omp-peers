// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FEATURES } from "../../lib/features";
import {
	addMember, CONTROL_OPS, deleteGroup, groups, groupsFile, groupsOf, groupTargeting, MAX_GROUPS, MAX_MEMBERS, membersOf, readGroups, removeMember, sendSkipReason, type GroupsState,
} from "../../lib/features/groups";
import type { FeatureHost } from "../../lib/features/host";
import { addRule, agentContext, rules } from "../../lib/features/rules";
import { identifyPeers, logicalId, resolvePeerTargets, stablePeerId, type Registration } from "../../lib/identity";

interface Row extends Registration {
	pid: number;
	instance: string;
	sock: string;
	inbound: "accept" | "refuse";
	control: boolean;
	paused?: boolean;
}
const row = (session: string, name: string, extra: Partial<Row> = {}): Row => ({
	id: stablePeerId(session), sessionId: session, name, pid: 1, instance: "i", sock: `/sandbox/${session}.sock`, inbound: "accept", control: true, ...extra,
});
const id = (session: string) => stablePeerId(session);
const MASTER = id("master");
const A = id("a");
const B = id("b");
const OFFLINE = "p00000000000000e5"; // a stable id with no running session

let home: string;
let live: Row[];
let proven: boolean;
beforeEach(() => {
	home = fs.mkdtempSync(path.join("/tmp", "opf-"));
	live = [row("master", "master"), row("a", "worker-a"), row("b", "worker-b")];
	proven = true;
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const roster = () => identifyPeers(live, async () => proven);

/** A host as seen from session `self`, over the `live` registry rows, resolving groups with the real resolver. */
function host(self: string, master = self === "master"): FeatureHost {
	const selfId = id(self);
	return {
		home,
		now: () => 1_700_000_000_000,
		self: () => ({ id: selfId, name: live.find(r => r.sessionId === self)?.name ?? "?" }),
		isMaster: () => master,
		acceptsRemote: () => true,
		peers: async () => (await roster()).filter(p => !p.duplicateSession.length || p.canonicalId === p.id).map(p => ({ id: logicalId(p), name: p.name })),
		groupsOf: peerId => groupsOf(home, peerId),
		resolveGroup: async (name, op) => {
			const result = resolvePeerTargets(`group:${name}`, await roster(), selfId, self, groupTargeting(home, op));
			return { recipients: result.peers.map(p => ({ id: logicalId(p), name: p.name })), skipped: result.skipped ?? [], error: result.error };
		},
		send: async () => ({ status: "offline" }),
	};
}
const say = (args: string, self = "master") => groups.command(args.split(/\s+/).filter(Boolean), host(self));
const stored = (): GroupsState => JSON.parse(fs.readFileSync(groupsFile(home), "utf8"));
const sortedNames = (ids: string[]) => [...ids].sort().map(member => `  ${live.find(r => r.id === member)?.name} (${member})`);

describe("membership commands", () => {
	test("is registered as /peers groups", () => {
		expect(FEATURES.map(f => f.name)).toContain("groups");
	});

	test("add, members, list, remove and delete print exact results and persist stable ids only", async () => {
		expect(await say("list")).toBe("no groups");
		expect(await say("add frontend worker-a")).toBe(`added worker-a (${A}) to group frontend (1 member(s))`);
		expect(await say("add Frontend worker-b")).toBe(`added worker-b (${B}) to group frontend (2 member(s))`);
		expect(await say(`add frontend ${A}`)).toBe(`${"worker-a"} (${A}) is already in group frontend`);
		expect(await say("add backend worker-a")).toBe(`added worker-a (${A}) to group backend (1 member(s))`);
		expect(await say("list")).toBe("backend  1 member(s)\nfrontend  2 member(s)");
		expect(await say("members frontend")).toBe(["group frontend: 2 member(s)", ...sortedNames([A, B])].join("\n"));
		expect(stored()).toEqual({ version: 1, groups: { backend: [A], frontend: [A, B].sort() } });
		expect(JSON.stringify(stored())).not.toContain("worker");
		expect(fs.statSync(groupsFile(home)).mode & 0o777).toBe(0o600);
		expect(fs.statSync(path.dirname(groupsFile(home))).mode & 0o777).toBe(0o700);
		expect(await say("remove frontend worker-a")).toBe(`removed worker-a (${A}) from group frontend (1 member(s) left)`);
		expect(await say("remove frontend worker-a")).toBe(`error: ${A} is not a member of group "frontend"`);
		expect(await say("remove nope worker-a")).toBe('error: unknown group "nope"');
		expect(await say("delete frontend")).toBe("deleted group frontend (1 member(s)); rules scoped to it stay stored and apply to nobody");
		expect(await say("delete frontend")).toBe('error: unknown group "frontend"');
		expect(await say("list")).toBe("backend  1 member(s)");
	});

	test("an offline member is shown by stable id and can be removed by it; a stranger name cannot be added", async () => {
		await addMember(home, "ops", OFFLINE, { self: MASTER, master: true });
		expect(await say("members ops")).toBe(`group ops: 1 member(s)\n  ${OFFLINE}  (no running session listed)`);
		expect(await say("add ops ghost")).toBe('error: no live peer matches "ghost"; use its stable ID or exact name');
		expect(await say(`add ops ${OFFLINE}`)).toBe(`error: no live peer matches "${OFFLINE}"; use its stable ID or exact name`);
		expect(await say(`remove ops ${OFFLINE}`)).toBe(`removed ${OFFLINE} from group ops (0 member(s) left)`);
		expect(await say("list")).toBe("ops  0 member(s)"); // an emptied group stays until deleted
		expect(await say("members nope")).toBe('error: unknown group "nope"');
	});

	test("usage and name validation", async () => {
		const usage = "usage: /peers groups list | add <group> <peer> | remove <group> <peer> | delete <group> | members <group> | preview <group> [message|status|prompt|abort|compact|model|effort|subagents|setting|rename|tail|shutdown|pause|resume]";
		for (const bad of ["", "bogus", "add frontend", "remove a b c", "delete", "list extra", "members", "preview", "preview a b c", "preview frontend nonsense"]) {
			expect(await say(bad)).toBe(usage);
		}
		const invalid = "error: group name must be 1-48 characters: lower-case letters, digits, '.', '_' or '-', starting with a letter or digit";
		for (const name of ["-x", ".x", "a b", "x".repeat(49), "bad/name", "ünï"]) {
			expect(await groups.command(["add", name, "worker-a"], host("master"))).toBe(invalid);
			expect(await groups.command(["members", name], host("master"))).toBe(invalid);
		}
		expect(await say(`add ${"x".repeat(48)} worker-a`)).toContain("added worker-a");
		expect(await say("add constructor worker-a")).toContain("added worker-a"); // not a prototype lookup
		expect(await say("members toString")).toBe('error: unknown group "tostring"');
	});
});

describe("authorization", () => {
	test("a session may add and remove itself; changing another session is master-only", async () => {
		const denied = "error: only the master session may change the membership of other sessions; run /peers master first (a session may add or remove itself)";
		expect(await say("add frontend worker-a", "a")).toBe(`added worker-a (${A}) to group frontend (1 member(s))`);
		expect(await say("add frontend worker-b", "a")).toBe(denied);
		expect(await say("remove frontend worker-a", "b")).toBe(denied);
		await say("add frontend worker-b"); // master
		expect(stored().groups.frontend).toEqual([A, B].sort());
		expect(await say("remove frontend worker-b", "b")).toBe(`removed worker-b (${B}) from group frontend (1 member(s) left)`);
		expect(await say("remove frontend worker-a")).toContain("removed worker-a"); // master removes another session
		// A claimed name is not authority: a non-master host that merely says "master" in its name gains nothing.
		expect(await groups.command(["add", "frontend", "worker-b"], { ...host("b"), self: () => ({ id: B, name: "master" }) })).toContain("added worker-b");
		expect(await groups.command(["add", "frontend", "worker-a"], { ...host("b"), self: () => ({ id: B, name: "master" }) })).toBe(denied);
	});

	test("delete: the master may delete any group; others only a group they alone belong to, or an empty one", async () => {
		const denied = "error: only the master session may change the membership of other sessions; run /peers master first (a session may add or remove itself)";
		await say("add solo worker-a");
		await say("add shared worker-a");
		await say("add shared worker-b");
		expect(await say("delete shared", "a")).toBe(denied);
		expect(await say("delete solo", "b")).toBe(denied);
		expect(await say("delete solo", "a")).toContain("deleted group solo (1 member(s))");
		await removeMember(home, "shared", A, { self: MASTER, master: true });
		await removeMember(home, "shared", B, { self: MASTER, master: true });
		expect(await say("delete shared", "b")).toContain("deleted group shared (0 member(s))");
		await say("add shared worker-a");
		expect(await say("delete shared")).toContain("deleted group shared (1 member(s))");
	});

	test("the library refuses an unauthorised change without touching the file", async () => {
		expect(await addMember(home, "g", B, { self: A, master: false })).toEqual({ ok: false, error: expect.stringContaining("only the master") });
		expect(fs.existsSync(groupsFile(home))).toBe(false);
		expect(await addMember(home, "g", "not-an-id", { self: MASTER, master: true })).toEqual({ ok: false, error: "session identity unavailable" });
		expect(await deleteGroup(home, "g", { self: MASTER, master: true })).toEqual({ ok: false, error: 'unknown group "g"' });
	});
});

describe("limits", () => {
	const master = { self: MASTER, master: true };
	const member = (n: number) => `p${n.toString(16).padStart(16, "0")}`;

	test(`at most ${MAX_MEMBERS} members per group`, async () => {
		for (let n = 0; n < MAX_MEMBERS; n++) expect((await addMember(home, "big", member(n), master)).ok).toBe(true);
		expect(await addMember(home, "big", member(MAX_MEMBERS), master)).toEqual({ ok: false, error: `member limit reached (${MAX_MEMBERS} per group); remove a member first` });
		expect(await addMember(home, "big", member(0), master)).toEqual({ ok: true, changed: false, count: MAX_MEMBERS }); // already in: not an error
		expect(membersOf(home, "big")).toHaveLength(MAX_MEMBERS);
		expect((await addMember(home, "other", member(MAX_MEMBERS), master)).ok).toBe(true); // the cap is per group
		expect((await removeMember(home, "big", member(0), master)).ok).toBe(true);
		expect((await addMember(home, "big", member(MAX_MEMBERS), master)).ok).toBe(true);
	});

	test(`at most ${MAX_GROUPS} groups`, async () => {
		for (let n = 0; n < MAX_GROUPS; n++) expect((await addMember(home, `g${n}`, A, master)).ok).toBe(true);
		expect(await addMember(home, "one-too-many", A, master)).toEqual({ ok: false, error: `group limit reached (${MAX_GROUPS}); delete a group first` });
		expect((await addMember(home, "g0", B, master)).ok).toBe(true); // an existing group still grows
		expect(Object.keys(readGroups(home).groups)).toHaveLength(MAX_GROUPS);
		await deleteGroup(home, "g0", master);
		expect((await addMember(home, "one-too-many", A, master)).ok).toBe(true);
	});

	test("a file beyond either cap is rejected as invalid", () => {
		fs.mkdirSync(path.dirname(groupsFile(home)), { recursive: true, mode: 0o700 });
		const tooMany = Object.fromEntries(Array.from({ length: MAX_GROUPS + 1 }, (_, n) => [`g${n}`, [A]]));
		fs.writeFileSync(groupsFile(home), JSON.stringify({ version: 1, groups: tooMany }));
		expect(() => readGroups(home)).toThrow("more than 64 groups");
		const members = Array.from({ length: MAX_MEMBERS + 1 }, (_, n) => member(n));
		fs.writeFileSync(groupsFile(home), JSON.stringify({ version: 1, groups: { g: members } }));
		expect(() => readGroups(home)).toThrow('malformed group "g"');
	});
});

describe("persistence and unreadable state", () => {
	test("membership survives a reload and is keyed by stable id, so peer-id rotation keeps it", async () => {
		await say("add frontend worker-a");
		// The same logical session re-registers under a different peer ID (an older version's alias, new instance, new pid).
		live = [row("master", "master"), row("a", "worker-a renamed", { id: "p000001", pid: 999, instance: "other" }), row("b", "worker-b")];
		expect(logicalId(live[1])).toBe(A);
		expect(groupsOf(home, A)).toEqual(["frontend"]); // read fresh from disk
		const plan = await host("master").resolveGroup("frontend", "message");
		expect(plan).toEqual({ recipients: [{ id: A, name: "worker-a renamed" }], skipped: [], error: undefined });
		// A different session that merely reuses the name is not a member.
		live = [row("master", "master"), row("impostor", "worker-a"), row("b", "worker-b")];
		const other = await host("master").resolveGroup("frontend", "message");
		expect(other.recipients).toEqual([]);
		expect(other.skipped).toEqual([{ name: A, reason: "not running" }]);
	});

	test("an invalid or symlinked groups file is an error and is never overwritten", async () => {
		fs.mkdirSync(path.dirname(groupsFile(home)), { recursive: true, mode: 0o700 });
		const bads: unknown[] = ["{ not json", { version: 2, groups: {} }, { version: 1, groups: [] }, { version: 1, groups: { "Bad Name": [A] } },
			{ version: 1, groups: { g: ["nope"] } }, { version: 1, groups: { g: [A, A] } }, { version: 1, groups: { g: "p00000000000000a1" } }];
		for (const bad of bads) {
			const text = typeof bad === "string" ? bad : JSON.stringify(bad);
			fs.writeFileSync(groupsFile(home), text);
			expect(() => groupsOf(home, A)).toThrow("groups.json");
			expect(await say("add g worker-a")).toStartWith("error: groups.json");
			expect(await say("list")).toStartWith("error: groups.json");
			expect(fs.readFileSync(groupsFile(home), "utf8")).toBe(text);
		}
		fs.rmSync(groupsFile(home));
		const elsewhere = path.join(home, "elsewhere.json");
		fs.writeFileSync(elsewhere, JSON.stringify({ version: 1, groups: {} }));
		fs.symlinkSync(elsewhere, groupsFile(home));
		expect(() => readGroups(home)).toThrow("symlink");
	});
});

describe("preview and send filtering", () => {
	const seed = async () => {
		const master = { self: MASTER, master: true };
		live = [row("master", "master"), row("a", "worker-a"), row("b", "worker-b", { paused: true }), row("c", "worker-c", { inbound: "refuse" }),
			row("d", "worker-d", { control: false }), row("g", "worker-g"), row("g", "worker-g", { id: "p000001" })];
		proven = false; // the two worker-g registrations share a logical session and neither is proven the writer
		for (const member of [MASTER, A, B, id("c"), id("d"), id("g"), OFFLINE]) await addMember(home, "frontend", member, master);
	};

	test("preview of a message names every excluded member with its reason", async () => {
		await seed();
		const choices = `worker-g (${id("g")}), worker-g (p000001)`;
		expect(await say("preview frontend")).toBe([
			"preview group:frontend (message), 7 member(s)",
			`would receive: worker-a (${A}), worker-d (${id("d")})`,
			"skipped: master (this session)",
			`skipped: ${OFFLINE} (not running)`,
			"skipped: worker-b (paused)",
			"skipped: worker-c (refuses inbound requests)",
			`skipped: worker-g (ambiguous: 2 registrations share this logical session and none is proven: ${choices}; use an explicit peer ID)`,
		].join("\n"));
	});

	test("the op matters: control ops also skip locked sessions, status reaches a paused one", async () => {
		await seed();
		const out = (await say("preview frontend prompt")).split("\n");
		expect(out[0]).toBe("preview group:frontend (prompt), 7 member(s)");
		expect(out[1]).toBe(`would receive: worker-a (${A})`);
		expect(out).toContain("skipped: worker-d (locked (control refused))");
		expect(out).toContain("skipped: worker-b (paused)");
		const status = (await say("preview frontend status")).split("\n");
		expect(status[1]).toBe(`would receive: worker-a (${A}), worker-b (${B}), worker-d (${id("d")})`);
		expect(status).not.toContain("skipped: worker-b (paused)");
		expect(status).toContain("skipped: worker-c (refuses inbound requests)");
	});

	test("with a proven writer the logical session is one recipient and nothing is ambiguous", async () => {
		await seed();
		proven = true;
		const plan = await host("master").resolveGroup("frontend", "message");
		expect(plan.recipients.map(p => p.id)).toEqual([A, id("d"), id("g")]); // registry order; worker-g once, via its proven writer
		expect(plan.skipped.some(s => s.reason.startsWith("ambiguous"))).toBe(false);
	});

	test("preview errors mirror a real send: unknown, empty, no running members, no eligible recipients", async () => {
		const master = { self: MASTER, master: true };
		expect(await say("preview nope")).toBe('error: unknown group "nope"');
		await addMember(home, "empty", A, master);
		await removeMember(home, "empty", A, master);
		expect(await say("preview empty")).toBe("preview group:empty (message), 0 member(s)\nerror: group \"empty\" is empty; add members with /peers groups add empty <peer>");
		await addMember(home, "gone", OFFLINE, master);
		expect(await say("preview gone")).toBe(`preview group:gone (message), 1 member(s)\nerror: group "gone" has no running members\nskipped: ${OFFLINE} (not running)`);
		live = [row("master", "master"), row("b", "worker-b", { paused: true })];
		await addMember(home, "idle", id("b"), master);
		expect(await say("preview idle")).toBe("preview group:idle (message), 1 member(s)\nerror: group \"idle\" has no eligible recipients right now\nskipped: worker-b (paused)");
	});

	test("the preview, the send resolution and the receiver gate use one decision", () => {
		for (const op of ["message", "status", ...CONTROL_OPS]) {
			for (const peer of [{}, { paused: true }, { inbound: "refuse" as const }, { control: false }, { paused: true, control: false }]) {
				const reason = sendSkipReason(peer, op);
				expect(groupTargeting(home, op).skip(peer)).toBe(reason);
			}
		}
		expect(sendSkipReason({ paused: undefined, inbound: undefined, control: undefined }, "prompt")).toBeUndefined(); // unknown stays unknown
		expect(sendSkipReason({ inbound: "refuse", control: false, paused: true }, "prompt")).toBe("refuses inbound requests"); // the receiver's own order
	});
});

describe("group-scoped rules", () => {
	test("a group rule starts applying to a session once it is added, and stops after removal", async () => {
		const masterHost = host("master");
		const added = await addRule(masterHost, "group:backend", "run the linter");
		expect(added.ok).toBe(true);
		const workerA = host("a", false);
		expect(agentContext(workerA)).toBeUndefined();
		await say("add backend worker-a");
		expect(agentContext(workerA)).toContain("- [r1 group:backend] run the linter");
		expect(agentContext(host("b", false))).toBeUndefined(); // another session is unaffected
		expect(await rules.command(["explain", "worker-a"], masterHost)).toContain("groups: backend");
		await say("remove backend worker-a");
		expect(agentContext(workerA)).toBeUndefined();
	});
});

describe("concurrency", () => {
	test("two OMP processes adding members at once lose nothing", async () => {
		const spawn = (tag: string, count: number) => Bun.spawn([process.execPath, path.join(import.meta.dir, "child_groups.ts"), home, tag, String(count)], { stdout: "pipe", stderr: "pipe" });
		const children = [spawn("aaaaaaaa", 25), spawn("bbbbbbbb", 25)];
		const codes = await Promise.all(children.map(child => child.exited));
		expect(codes).toEqual([0, 0]);
		const state = readGroups(home);
		expect(state.groups.shared).toHaveLength(50);
		expect(new Set(state.groups.shared).size).toBe(50);
		expect(Object.keys(state.groups).sort()).toEqual(["own-aaaaaaaa", "own-bbbbbbbb", "shared"]);
		expect(fs.readdirSync(path.dirname(groupsFile(home))).filter(f => f.endsWith(".tmp"))).toEqual([]);
	});
});
