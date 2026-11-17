// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
import { describe, expect, test } from "bun:test";
import { identifyPeers, identityFlags, matchesWriter, resolvePeerTargets, stablePeerId } from "../lib/identity";

const self = { id: stablePeerId("sender"), sessionId: "sender", name: "Sender" };
function registration(sessionId: string, name: string, id = stablePeerId(sessionId)) {
	return { id, sessionId, name, pid: 101, instance: "current", sock: `/sandbox/${id}.sock` };
}

describe("duplicate peer identities", () => {
	test("same-name different sessions remain canonical and name sends list actionable IDs", async () => {
		const a = registration("a", "Worker");
		const b = registration("b", "worker");
		const roster = await identifyPeers([a, b], async () => true);
		expect(roster.map(p => p.canonicalId)).toEqual([a.id, b.id]);
		expect(identityFlags(roster[0])).toEqual([`duplicate-name:${b.id}`, "canonical"]);
		const result = resolvePeerTargets("WORKER", roster, self.id, self.sessionId);
		expect(result.peers).toEqual([]);
		expect(result.error).toContain("ambiguous");
		expect(result.error).toContain(a.id);
		expect(result.error).toContain(b.id);
		expect(result.error).toContain("use an explicit peer ID");
		expect(resolvePeerTargets("all", roster, self.id, self.sessionId).peers).toEqual(roster);
		expect(resolvePeerTargets(a.id, roster, self.id, self.sessionId).peers).toEqual([roster[0]]);
	});

	test("exact literal ID wins over another session's exact name", async () => {
		const a = registration("a", "Worker");
		const b = registration("b", a.id);
		const roster = await identifyPeers([a, b], async () => true);
		expect(resolvePeerTargets(a.id.toUpperCase(), roster, self.id, self.sessionId).peers).toEqual([roster[0]]);
		expect(resolvePeerTargets(b.id, roster, self.id, self.sessionId).peers).toEqual([roster[1]]);
		expect(resolvePeerTargets("missing", roster, self.id, self.sessionId).error).toContain("no peer matches");
		expect(resolvePeerTargets("Work", roster, self.id, self.sessionId).peers).toEqual([roster[0]]);
	});

	test("a proved stable writer owns its logical aliases, independent of ordering", async () => {
		const owner = registration("shared", "Shared");
		const alias = registration("shared", "Shared", "p000001");
		const distinct = registration("other", "Other");
		for (const rows of [[alias, distinct, owner], [owner, distinct, alias]]) {
			const probed: string[] = [];
			const roster = await identifyPeers(rows, async peer => { probed.push(peer.id); return true; });
			expect(probed).toEqual([owner.id]);
			expect(roster.find(p => p.id === alias.id)?.canonicalId).toBe(owner.id);
			expect(identityFlags(roster.find(p => p.id === alias.id)!)).toContain(`canonical:${owner.id}`);
			expect(resolvePeerTargets("Shared", roster, self.id, self.sessionId).error).toContain("ambiguous");
			expect(resolvePeerTargets(alias.id, roster, self.id, self.sessionId).peers[0].id).toBe(alias.id);
			expect(resolvePeerTargets("all", roster, self.id, self.sessionId).peers.map(p => p.id).sort()).toEqual([owner.id, distinct.id].sort());
		}
	});

	test("unknown writers block the whole broadcast and never select an arbitrary alias", async () => {
		const a = registration("shared", "First", "p000001");
		const b = registration("shared", "Second", "p000002");
		const other = registration("other", "Other");
		const roster = await identifyPeers([other, a, b], async () => { throw new Error("legacy rows cannot prove a stable writer"); });
		expect(roster.every(p => !p.canonicalId)).toBe(true);
		expect(identityFlags(roster[1])).toContain("canonical:unknown (use explicit ID)");
		expect(resolvePeerTargets("First", roster, self.id, self.sessionId).error).toContain("writer unknown");
		const broadcast = resolvePeerTargets("all", roster, self.id, self.sessionId);
		expect(broadcast.peers).toEqual([]);
		expect(broadcast.error).toContain("broadcast not sent");
		expect(broadcast.error).toContain(a.id);
		expect(broadcast.error).toContain(b.id);
		expect(resolvePeerTargets(a.id, roster, self.id, self.sessionId).peers[0].id).toBe(a.id);
	});

	test("a held lock or stable-looking ID alone is not writer proof", async () => {
		const owner = registration("shared", "Owner");
		const alias = registration("shared", "Alias", "p000001");
		const response = { ok: true, sessionOwner: true, info: owner };
		expect(matchesWriter(owner, response, true)).toBe(true);
		expect(matchesWriter(owner, response, false)).toBe(false);
		expect(matchesWriter(owner, { ...response, sessionOwner: undefined }, true)).toBe(false);
		expect(matchesWriter(alias, { ...response, info: alias }, true)).toBe(false);
		const roster = await identifyPeers([owner, alias], async () => false);
		expect(roster.every(p => !p.canonicalId)).toBe(true);
		expect(resolvePeerTargets("Owner", roster, self.id, self.sessionId).error).toContain("writer unknown");
		expect(resolvePeerTargets("all", roster, self.id, self.sessionId).peers).toEqual([]);
	});

	test("restart incarnation, SID and socket must match the live writer", async () => {
		const old = registration("shared", "Worker");
		const current = { ...old, pid: 102, instance: "restarted" };
		const response = { ok: true, sessionOwner: true, info: current };
		expect(matchesWriter(old, response, true)).toBe(false);
		expect(matchesWriter({ ...old, pid: current.pid }, response, true)).toBe(false);
		expect(matchesWriter(current, response, true)).toBe(true);
		expect(matchesWriter(current, { ...response, info: { ...current, sessionId: "unrelated" } }, true)).toBe(false);
		expect(matchesWriter(current, { ...response, info: { ...current, sock: "/wrong.sock" } }, true)).toBe(false);
		const alias = registration("shared", "Worker", "p000001");
		const roster = await identifyPeers([alias, current], async peer => matchesWriter(peer, response, true));
		expect(resolvePeerTargets("all", roster, self.id, self.sessionId).peers.map(p => p.id)).toEqual([current.id]);
	});

	test("sender logical aliases never receive a broadcast or steal an exact self-ID name", async () => {
		const alias = registration(self.sessionId, "Old sender", "p000001");
		const other = registration("other", self.id);
		const roster = await identifyPeers([self, alias, other], async () => false);
		expect(resolvePeerTargets("all", roster, self.id, self.sessionId).peers.map(p => p.id)).toEqual([other.id]);
		expect(resolvePeerTargets(self.id, roster, self.id, self.sessionId).error).toContain("this logical session");
		expect(resolvePeerTargets(alias.id, roster, self.id, self.sessionId).peers).toEqual([]);
	});

	test("single legacy and missing-SID sessions retain ordinary broadcast behavior", async () => {
		const rows = [registration("", "One", "p000001"), registration("", "Two", "p000002")];
		const roster = await identifyPeers(rows, async () => false);
		expect(resolvePeerTargets("all", roster, self.id, self.sessionId).peers).toEqual(roster);
		expect(resolvePeerTargets("One", roster, self.id, self.sessionId).peers).toEqual([roster[0]]);
	});
});

describe("group targets", () => {
	const reasons: Record<string, string> = {};
	const targeting = (groups: Record<string, string[]>) => ({
		members: (name: string) => (Object.hasOwn(groups, name) ? groups[name] : undefined),
		skip: (peer: { name: string }) => reasons[peer.name],
	});
	const resolve = async (spec: string, rows: ReturnType<typeof registration>[], groups: Record<string, string[]>, proven = true) =>
		resolvePeerTargets(spec, await identifyPeers(rows, async () => proven), self.id, self.sessionId, targeting(groups));
	const a = registration("a", "Worker-A");
	const b = registration("b", "Worker-B");
	const c = registration("c", "Worker-C");

	test("a group target selects its live members, never the sender, and reports every exclusion", async () => {
		reasons["Worker-B"] = "paused";
		const mine = registration("sender", "Sender");
		const result = await resolve("GROUP:frontend", [mine, a, b, c], { frontend: [a.id, b.id, mine.id, "p00000000000000e5"] });
		expect(result.peers.map(p => p.id)).toEqual([a.id]);
		expect(result.skipped).toEqual([
			{ name: "Sender", reason: "this session" },
			{ name: "Worker-B", reason: "paused" },
			{ name: "p00000000000000e5", reason: "not running" },
		]); // sorted by name in code-unit order
		expect(result.error).toBeUndefined();
		delete reasons["Worker-B"];
	});

	test("membership is keyed by the logical session, not by a peer ID", async () => {
		const rotated = registration("a", "Worker-A", "p000009");
		const result = await resolve("group:frontend", [rotated, b], { frontend: [stablePeerId("a")] });
		expect(result.peers).toEqual([expect.objectContaining({ id: "p000009" })]);
		expect(result.skipped).toEqual([]);
		// An alias ID in the group file would match nothing: the file holds stable IDs.
		expect((await resolve("group:frontend", [rotated, b], { frontend: ["p000009"] })).error).toBe('group "frontend" has no running members');
	});

	test("unknown, empty, no running member and no eligible recipient are explicit errors", async () => {
		reasons["Worker-A"] = "refuses inbound requests";
		expect((await resolve("group:nope", [a], { frontend: [a.id] })).error).toBe('unknown group "nope"');
		expect((await resolve("group:frontend", [a], { frontend: [] })).error).toBe('group "frontend" is empty; add members with /peers groups add frontend <peer>');
		const none = await resolve("group:frontend", [a], { frontend: [b.id] });
		expect(none).toEqual({ peers: [], error: 'group "frontend" has no running members', skipped: [{ name: b.id, reason: "not running" }] });
		const blocked = await resolve("group:frontend", [a], { frontend: [a.id] });
		expect(blocked).toEqual({ peers: [], error: 'group "frontend" has no eligible recipients right now', skipped: [{ name: "Worker-A", reason: "refuses inbound requests" }] });
		delete reasons["Worker-A"];
	});

	test("a member whose logical session has no proven writer fails the whole group send; nothing is sent or guessed", async () => {
		reasons["Worker-C"] = "paused";
		const first = registration("s", "Shared", "p000001");
		const second = registration("s", "Shared", "p000002");
		const result = await resolve("group:frontend", [a, c, first, second], { frontend: [a.id, c.id, stablePeerId("s")] }, false);
		expect(result).toEqual({ peers: [], error: 'group "frontend" not sent: logical session has no proven writer: Shared (p000001), Shared (p000002); use an explicit peer ID' });
		delete reasons["Worker-C"];
		// With a proven writer the same session is one recipient.
		const owner = registration("s", "Shared");
		expect((await resolve("group:frontend", [a, owner, first], { frontend: [stablePeerId("s")] })).peers).toEqual([expect.objectContaining({ id: owner.id })]);
	});

	test("a group name and a peer name that collide is ambiguous; without a group the peer name keeps its ordinary meaning", async () => {
		const named = registration("n", "group:frontend");
		const colliding = await resolve("group:frontend", [a, named], { frontend: [a.id] });
		expect(colliding.peers).toEqual([]);
		expect(colliding.error).toContain('"group:frontend" is ambiguous: it names a group and a peer: group:frontend (');
		expect((await resolve("group:frontend", [a, named], {})).peers).toEqual([expect.objectContaining({ id: named.id })]);
		expect((await resolve(named.id, [a, named], { frontend: [a.id] })).peers).toEqual([expect.objectContaining({ id: named.id })]);
	});

	test("unscoped targets are unchanged by group support", async () => {
		reasons["Worker-A"] = "paused";
		const rows = [a, b, registration("shared", "Shared", "p000001"), registration("shared", "Shared")];
		const groups = { frontend: [a.id] };
		for (const spec of ["all", "worker", "Worker-A", "worker-b", a.id, b.id, "missing", "group", "grp:frontend"]) {
			const roster = await identifyPeers(rows, async () => true);
			expect(resolvePeerTargets(spec, roster, self.id, self.sessionId, targeting(groups))).toEqual(resolvePeerTargets(spec, roster, self.id, self.sessionId));
		}
		const everyone = resolvePeerTargets("all", await identifyPeers(rows, async () => true), self.id, self.sessionId, targeting(groups));
		expect(everyone.peers.map(p => p.name)).toEqual(["Worker-A", "Worker-B", "Shared"]); // paused members are still addressed by 'all'
		expect(everyone.skipped).toBeUndefined();
		expect((await resolve("group:", rows, groups)).error).toBe('unknown group ""'); // the one spelling whose error text names the group
		// Without a targeting argument `group:x` is just a name that matches nothing.
		expect(resolvePeerTargets("group:frontend", await identifyPeers(rows, async () => true), self.id, self.sessionId).error).toBe('no peer matches "group:frontend"');
		delete reasons["Worker-A"];
	});

	test("an unproven duplicate still blocks 'all' exactly as before", async () => {
		const first = registration("s", "Shared", "p000001");
		const second = registration("s", "Shared", "p000002");
		const result = await resolve("all", [a, first, second], { frontend: [a.id] }, false);
		expect(result.peers).toEqual([]);
		expect(result.error).toContain("broadcast not sent: logical session has no proven writer");
	});
});
