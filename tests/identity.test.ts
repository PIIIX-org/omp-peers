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
