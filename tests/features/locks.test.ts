// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FEATURES } from "../../lib/features";
import type { FeatureHost } from "../../lib/features/host";
import { acquireLock, forceRelease, formatDuration, locks, locksFile, releaseLock, renderStatus, renewLock, type LocksState } from "../../lib/features/locks";

const MASTER = "p00000000000000aa";
const A = "p00000000000000a1";
const B = "p00000000000000b2";
const C = "p00000000000000c3";
const NAMES: Record<string, string> = { [MASTER]: "master", [A]: "worker-a", [B]: "worker-b", [C]: "worker-c" };
const T0 = 1_700_000_000_000;

let home: string;
let clock: number;
beforeEach(() => {
	home = fs.mkdtempSync(path.join("/tmp", "opl-"));
	clock = T0;
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

/** A fake host as seen from peer `self`, on the shared fake clock. */
function host(self: string, master = self === MASTER): FeatureHost {
	return {
		home,
		now: () => clock,
		self: () => ({ id: self, name: NAMES[self] ?? "anon" }),
		isMaster: () => master,
		acceptsRemote: () => true,
		peers: async () => [],
		groupsOf: () => [],
		resolveGroup: async () => ({ recipients: [], skipped: [] }),
		send: async () => ({ status: "offline" }),
	};
}
const stored = (): LocksState => JSON.parse(fs.readFileSync(locksFile(home), "utf8"));
const secs = (n: number) => n * 1000;
const run = (line: string, self = A) => locks.command(line.split(/\s+/), host(self));
const peerId = (n: number) => `p${n.toString(16).padStart(16, "0")}`;

describe("registry and storage", () => {
	test("is registered as /peers locks with the peers_lock tool", () => {
		expect(FEATURES.map(f => f.name)).toContain("locks");
		expect(locks.tools?.().map(t => t.name)).toEqual(["peers_lock"]);
	});

	test("an acquire stores a private version 1 lease with owner, instance, times and note", async () => {
		const result = await acquireLock(host(A), { name: "heavy-build", ttl: 120, note: "  nightly   build " }, "inst-1");
		expect(result.outcome).toBe("acquired");
		expect(fs.statSync(locksFile(home)).mode & 0o777).toBe(0o600);
		expect(fs.statSync(path.dirname(locksFile(home))).mode & 0o777).toBe(0o700);
		expect(stored()).toEqual({
			version: 1,
			nextId: 2,
			resources: [{ name: "heavy-build", capacity: 1, leases: [{ id: "l1", owner: A, name: "worker-a", instance: "inst-1", acquiredAt: T0, expiresAt: T0 + secs(120), note: "nightly build" }] }],
		});
	});

	test("an invalid or symlinked store is reported and never overwritten", async () => {
		fs.mkdirSync(path.dirname(locksFile(home)), { recursive: true });
		fs.writeFileSync(locksFile(home), JSON.stringify({ version: 1, nextId: 1, resources: [{ name: "x", capacity: 1, leases: [] }] }));
		const before = fs.readFileSync(locksFile(home), "utf8");
		await expect(acquireLock(host(A), { name: "x" })).rejects.toThrow(/locks\.json is invalid/);
		expect(await run("acquire x")).toMatch(/^error: locks\.json is invalid/);
		expect(await run("status")).toMatch(/^error: locks\.json is invalid/);
		expect(fs.readFileSync(locksFile(home), "utf8")).toBe(before);
	});
});

describe("capacity and contention", () => {
	test("capacity 1 is a mutex: the second session gets busy naming the holder and the earliest expiry, without waiting", async () => {
		await acquireLock(host(A), { name: "heavy-build", ttl: 300 });
		clock += secs(100);
		const result = await acquireLock(host(B), { name: "heavy-build", ttl: 600 });
		expect(result.outcome).toBe("busy");
		if (result.outcome !== "busy") throw new Error("unreachable");
		expect(result.capacity).toBe(1);
		expect(result.holders.map(h => h.owner)).toEqual([A]);
		expect(result.earliestExpiry).toBe(T0 + secs(300));
		expect(stored().resources[0].leases).toHaveLength(1);
	});

	test("a semaphore of capacity 2 admits two owners, refuses the third, and a release frees exactly one slot", async () => {
		expect((await acquireLock(host(A), { name: "pool", capacity: 2 })).outcome).toBe("acquired");
		expect((await acquireLock(host(B), { name: "pool" })).outcome).toBe("acquired");
		clock += secs(5);
		const third = await acquireLock(host(C), { name: "pool" });
		expect(third.outcome).toBe("busy");
		if (third.outcome !== "busy") throw new Error("unreachable");
		expect(third.holders.map(h => h.owner).sort()).toEqual([A, B]);
		expect((await releaseLock(host(A), { name: "pool" })).outcome).toBe("released");
		expect((await acquireLock(host(C), { name: "pool" })).outcome).toBe("acquired");
		expect((await acquireLock(host(A), { name: "pool" })).outcome).toBe("busy");
		expect(stored().resources[0].leases.map(l => l.owner)).toEqual([B, C]);
	});

	test("the busy text lists every holder with remaining time and says nothing is waiting", async () => {
		await acquireLock(host(A), { name: "heavy-build", ttl: 300, note: "build" });
		clock += secs(30);
		expect(await run("acquire heavy-build", B)).toBe([
			"busy heavy-build: all 1 slot is held; nothing was acquired and nothing is waiting. Earliest slot frees in 4m 30s (2023-11-14T22:18:20.000Z) unless released sooner. Do other work and try again later.",
			"  l1  worker-a (p00000000000000a1)  expires in 4m 30s (2023-11-14T22:18:20.000Z)  note: build",
		].join("\n"));
	});

	test("capacity is fixed by the first acquire: a different explicit capacity is refused with the current value, omitting it accepts the existing one", async () => {
		await acquireLock(host(A), { name: "pool", capacity: 3 });
		const mismatch = await acquireLock(host(B), { name: "pool", capacity: 5 });
		expect(mismatch).toEqual({ outcome: "refused", reason: "capacity mismatch: pool was created with capacity 3 (requested 5); the capacity is fixed until every lease on it has ended" });
		expect((await acquireLock(host(B), { name: "pool", capacity: 3 })).outcome).toBe("acquired");
		expect((await acquireLock(host(C), { name: "pool" })).outcome).toBe("acquired");
		expect(stored().resources[0].capacity).toBe(3);
		expect(stored().resources[0].leases).toHaveLength(3);
		// Even the current owner cannot change it with a re-acquire.
		expect((await acquireLock(host(A), { name: "pool", capacity: 1 })).outcome).toBe("refused");
	});

	test("capacity is chosen again once every lease on the name has ended", async () => {
		await acquireLock(host(A), { name: "pool", capacity: 3, ttl: 60 });
		await releaseLock(host(A), { name: "pool" });
		expect(stored().resources).toEqual([]);
		await acquireLock(host(A), { name: "pool", capacity: 3, ttl: 60 });
		clock += secs(61);
		expect((await acquireLock(host(B), { name: "pool", capacity: 2 })).outcome).toBe("acquired");
		expect(stored().resources[0].capacity).toBe(2);
	});

	test("a second acquire by the current holder is refused with the exact text and changes nothing, while another session still gets busy; renew extends", async () => {
		await acquireLock(host(A), { name: "heavy-build", ttl: 100, note: "first" }, "inst-1");
		clock += secs(40);
		const before = fs.readFileSync(locksFile(home), "utf8");
		const again = await acquireLock(host(A), { name: "heavy-build", ttl: 500, note: "second" }, "inst-2");
		expect(again).toEqual({ outcome: "refused", reason: "this session already holds heavy-build (lease l1), possibly via another of its agents; renew to extend it or release it when done" });
		expect(await run("acquire heavy-build", A)).toBe("refused: this session already holds heavy-build (lease l1), possibly via another of its agents; renew to extend it or release it when done");
		expect(fs.readFileSync(locksFile(home), "utf8")).toBe(before);
		expect((await acquireLock(host(B), { name: "heavy-build" })).outcome).toBe("busy");
		const renewed = await renewLock(host(A), { name: "heavy-build", ttl: 500 }, "inst-1");
		expect(renewed.outcome).toBe("renewed");
		expect(stored().resources[0].leases).toEqual([{ id: "l1", owner: A, name: "worker-a", instance: "inst-1", acquiredAt: T0, expiresAt: T0 + secs(540), note: "first" }]);
		expect(stored().nextId).toBe(2);
	});

	test("a capacity-2 resource still gives one slot per session: the holder is refused, a second session is admitted", async () => {
		await acquireLock(host(A), { name: "pool", capacity: 2 });
		expect((await acquireLock(host(A), { name: "pool" })).outcome).toBe("refused");
		expect((await acquireLock(host(B), { name: "pool" })).outcome).toBe("acquired");
		expect(stored().resources[0].leases.map(l => l.owner)).toEqual([A, B]);
	});

	test("the same owner may hold different names independently", async () => {
		await acquireLock(host(A), { name: "one" });
		await acquireLock(host(A), { name: "two" });
		expect(stored().resources.map(r => r.name)).toEqual(["one", "two"]);
	});
});

describe("ownership, expiry and renewal", () => {
	test("only the owner releases: another session is refused and the lease stays", async () => {
		await acquireLock(host(A), { name: "heavy-build" });
		const denied = await releaseLock(host(B), { name: "heavy-build" });
		expect(denied).toEqual({ outcome: "refused", reason: "this session holds no active lease on heavy-build; only the owner may release it" });
		expect(stored().resources[0].leases.map(l => l.owner)).toEqual([A]);
		expect((await releaseLock(host(MASTER), { name: "heavy-build" })).outcome).toBe("refused");
		expect(await releaseLock(host(A), { name: "nothing" })).toEqual({ outcome: "refused", reason: "this session holds no active lease on nothing" });
	});

	test("the master has no special release power over an unexpired lease", async () => {
		await acquireLock(host(A), { name: "heavy-build" });
		expect((await releaseLock(host(MASTER), { name: "heavy-build" })).outcome).toBe("refused");
		expect((await acquireLock(host(MASTER), { name: "heavy-build" })).outcome).toBe("busy");
	});

	test("an unexpired lease is never stolen, then is reclaimed lazily by the first mutation after expiry", async () => {
		await acquireLock(host(A), { name: "heavy-build", ttl: 60 });
		clock += secs(59) + 999;
		expect((await acquireLock(host(B), { name: "heavy-build" })).outcome).toBe("busy");
		clock = T0 + secs(60);
		// Expired but not yet reclaimed: still in the file until a mutation runs.
		expect(stored().resources[0].leases[0].owner).toBe(A);
		const taken = await acquireLock(host(B), { name: "heavy-build", ttl: 60 });
		expect(taken.outcome).toBe("acquired");
		expect(stored().resources[0].leases.map(l => [l.owner, l.id])).toEqual([[B, "l2"]]);
	});

	test("reclaim removes expired leases of other names in the same atomic update", async () => {
		await acquireLock(host(A), { name: "old", ttl: 10 });
		await acquireLock(host(A), { name: "keep", ttl: 1000 });
		clock += secs(11);
		await acquireLock(host(B), { name: "fresh" });
		expect(stored().resources.map(r => r.name)).toEqual(["fresh", "keep"]);
	});

	test("renew sets the expiry from now and keeps the slot; an expired or foreign lease cannot be renewed", async () => {
		await acquireLock(host(A), { name: "heavy-build", ttl: 100 });
		clock += secs(90);
		const renewed = await renewLock(host(A), { name: "heavy-build", ttl: 400 });
		expect(renewed).toMatchObject({ outcome: "renewed", held: 1 });
		expect(stored().resources[0].leases[0].expiresAt).toBe(T0 + secs(490));
		clock += secs(200);
		// Past the original TTL, the renewed lease still holds the slot.
		expect((await acquireLock(host(B), { name: "heavy-build" })).outcome).toBe("busy");
		expect((await renewLock(host(B), { name: "heavy-build" })).outcome).toBe("refused");
		clock = T0 + secs(490);
		const late = await renewLock(host(A), { name: "heavy-build" });
		expect(late).toEqual({ outcome: "refused", reason: "this session holds no active lease on heavy-build (it expired, was released, or was never acquired); acquire it again" });
	});

	test("an active lease survives a simulated owner restart and others still cannot steal it", async () => {
		await acquireLock(host(A), { name: "heavy-build", ttl: 600 }, "before-crash");
		clock += secs(30);
		// Restarted session: same logical id, new process instance, nothing carried over in memory.
		expect((await acquireLock(host(B), { name: "heavy-build" }, "other-proc")).outcome).toBe("busy");
		expect(await renderStatus(host(A), "heavy-build", "after-restart")).toContain("worker-a (p00000000000000a1, this session, earlier instance)");
		const renewed = await renewLock(host(A), { name: "heavy-build", ttl: 600 }, "after-restart");
		expect(renewed.outcome).toBe("renewed");
		expect(stored().resources[0].leases[0]).toMatchObject({ owner: A, instance: "after-restart", acquiredAt: T0, expiresAt: T0 + secs(630) });
		expect(renderStatus(host(A), "heavy-build", "after-restart")).toContain("worker-a (p00000000000000a1, this session)");
		expect((await acquireLock(host(C), { name: "heavy-build" }, "another")).outcome).toBe("busy");
		const released = await releaseLock(host(A), { name: "heavy-build" });
		expect(released.outcome).toBe("released");
		expect(stored().resources).toEqual([]);
	});

	test("a crashed owner's lease is recovered only after the bounded TTL", async () => {
		await acquireLock(host(A), { name: "heavy-build", ttl: 600 }, "crashed");
		clock += secs(599);
		expect((await acquireLock(host(B), { name: "heavy-build" })).outcome).toBe("busy");
		clock += secs(1);
		expect((await acquireLock(host(B), { name: "heavy-build" })).outcome).toBe("acquired");
	});
});

describe("status", () => {
	test("is read-only: the file is byte-identical, untouched and no lock file appears, even with expired leases", async () => {
		await acquireLock(host(A), { name: "pool", capacity: 2, ttl: 60, note: "n" });
		await acquireLock(host(B), { name: "pool", ttl: 1000 });
		clock += secs(120);
		const file = locksFile(home);
		const before = { bytes: fs.readFileSync(file), mtime: fs.statSync(file).mtimeMs };
		const entries = fs.readdirSync(path.dirname(file)).sort();
		const text = renderStatus(host(C));
		expect(text).toBe([
			"pool: 1 of 2 slots in use",
			"  l1  worker-a (p00000000000000a1)  EXPIRED 1m ago (ignored; reclaimed by the next acquire)  note: n",
			"  l2  worker-b (p00000000000000b2)  expires in 14m 40s (2023-11-14T22:30:00.000Z)",
		].join("\n"));
		expect(await run("status pool", C)).toBe(text);
		expect(Buffer.compare(fs.readFileSync(file), before.bytes)).toBe(0);
		expect(fs.statSync(file).mtimeMs).toBe(before.mtime);
		expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(entries);
	});

	test("on a fresh home status writes nothing, and a free or unknown name is reported as free", () => {
		expect(renderStatus(host(A))).toBe("no locks held");
		expect(renderStatus(host(A), "heavy-build")).toBe("heavy-build: free (no leases; the first acquire sets its capacity)");
		expect(renderStatus(host(A), "Bad Name")).toMatch(/^refused: "Bad Name" is not a valid lock name/);
		expect(fs.existsSync(path.join(home, ".omp"))).toBe(false);
	});

	test("expired leases are ignored for capacity: a resource whose leases all expired reads as free of holders but still shows them", async () => {
		await acquireLock(host(A), { name: "heavy-build", ttl: 10 });
		clock += secs(10);
		expect(renderStatus(host(B), "heavy-build")).toBe("heavy-build: 0 of 1 slot in use\n  l1  worker-a (p00000000000000a1)  EXPIRED 0s ago (ignored; reclaimed by the next acquire)");
	});

	test("formatDuration is exact", () => {
		expect([0, 1, 999, 1000, 61_000, 3_600_000, 3_661_000, 86_400_000].map(formatDuration)).toEqual(["0s", "1s", "1s", "1s", "1m 1s", "1h", "1h 1m 1s", "24h"]);
	});
});

describe("force-release", () => {
	test("is master-only", async () => {
		await acquireLock(host(A), { name: "heavy-build", ttl: 10 });
		clock += secs(20);
		const denied = await forceRelease(host(B), { name: "heavy-build", target: A });
		expect(denied).toEqual({ outcome: "refused", reason: "only the master session may force-release a lease; run /peers master first" });
		expect(stored().resources[0].leases).toHaveLength(1);
	});

	test("refuses an unexpired lease unless --yes-live is given, and says it can break a live lease", async () => {
		await acquireLock(host(A), { name: "heavy-build", ttl: 300 });
		clock += secs(60);
		const text = await run("force-release heavy-build " + A, MASTER);
		expect(text).toBe("refused: l1 held by worker-a (p00000000000000a1) has not expired (4m left). Force-releasing a live lease can let two sessions use heavy-build at once; add --yes-live to do it anyway");
		expect(stored().resources[0].leases).toHaveLength(1);
		expect(await run(`force-release heavy-build ${A} --yes-live`, MASTER)).toBe("force-released heavy-build: lease l1 held by worker-a (p00000000000000a1) was removed; it had NOT expired, so its owner may still be using the resource");
		expect(stored().resources).toEqual([]);
	});

	test("removes an expired lease without the flag, by owner or by lease id, leaving other leases", async () => {
		await acquireLock(host(A), { name: "pool", capacity: 3, ttl: 10 });
		await acquireLock(host(B), { name: "pool", ttl: 10 });
		await acquireLock(host(C), { name: "pool", ttl: 1000 });
		clock += secs(20);
		expect(await run(`force-release pool ${A}`, MASTER)).toBe("force-released pool: lease l1 held by worker-a (p00000000000000a1) was removed");
		expect(await run("force-release pool l2", MASTER)).toBe("force-released pool: lease l2 held by worker-b (p00000000000000b2) was removed");
		expect(stored().resources[0].leases.map(l => l.owner)).toEqual([C]);
	});

	test("rejects unknown targets, bad names and bad usage, changing nothing", async () => {
		await acquireLock(host(A), { name: "heavy-build" });
		const before = fs.readFileSync(locksFile(home), "utf8");
		expect(await run(`force-release heavy-build ${B}`, MASTER)).toBe(`refused: no lease on heavy-build matches ${B}; an expired lease may already have been reclaimed`);
		expect(await run("force-release heavy-build worker-a", MASTER)).toMatch(/^refused: owner must be a session's stable id or a lease id/);
		expect(await run(`force-release Bad ${A}`, MASTER)).toMatch(/^refused: "Bad" is not a valid lock name/);
		expect(await run("force-release heavy-build", MASTER)).toMatch(/^usage:/);
		expect(await run(`force-release heavy-build ${A} --bogus`, MASTER)).toMatch(/^usage:/);
		expect(fs.readFileSync(locksFile(home), "utf8")).toBe(before);
	});
});

describe("validation and bounds", () => {
	test("names must match the documented pattern", async () => {
		for (const name of ["", "Heavy", "-x", ".x", "a b", "a/b", "x".repeat(49), undefined, 5]) {
			const result = await acquireLock(host(A), { name });
			expect(result.outcome).toBe("refused");
		}
		for (const name of ["a", "0", "heavy-build", "a.b_c-d", "x".repeat(48), "constructor"]) {
			expect((await acquireLock(host(A), { name })).outcome).toBe("acquired");
		}
		expect(fs.existsSync(locksFile(home))).toBe(true);
	});

	test("capacity must be 1..64 and ttl 10..86400, whole numbers only; nothing is written on refusal", async () => {
		const bad: Array<Record<string, unknown>> = [{ capacity: 0 }, { capacity: 65 }, { capacity: 1.5 }, { capacity: "x" }, { capacity: "-1" }, { ttl: 9 }, { ttl: 86_401 }, { ttl: "abc" }, { ttl: 10.5 }, { ttl: Number.NaN }];
		for (const extra of bad) expect((await acquireLock(host(A), { name: "x", ...extra })).outcome).toBe("refused");
		expect(fs.existsSync(locksFile(home))).toBe(false);
		expect(await acquireLock(host(A), { name: "x", capacity: 64, ttl: 86_400 })).toMatchObject({ outcome: "acquired", capacity: 64 });
		expect(stored().resources[0].leases[0].expiresAt).toBe(T0 + secs(86_400));
		expect((await acquireLock(host(B), { name: "y", capacity: "2", ttl: "10" })).outcome).toBe("acquired");
		expect((await renewLock(host(A), { name: "x", ttl: 9 })).outcome).toBe("refused");
	});

	test("notes are limited to 80 characters, one line, and credential-screened without echoing the secret", async () => {
		expect((await acquireLock(host(A), { name: "x", note: "n".repeat(80) })).outcome).toBe("acquired");
		expect(await acquireLock(host(B), { name: "x", note: "n".repeat(81) })).toEqual({ outcome: "refused", reason: "note is longer than 80 characters" });
		const secret = "password=" + "abcd1234efgh5678";
		const result = await acquireLock(host(B), { name: "y", note: `use ${secret}` });
		expect(result.outcome).toBe("refused");
		expect(JSON.stringify(result)).not.toContain("abcd1234");
		expect((await acquireLock(host(B), { name: "y", note: "bad\u0007note" })).outcome).toBe("refused");
		expect((await acquireLock(host(B), { name: "y", note: 5 })).outcome).toBe("refused");
		expect(fs.readFileSync(locksFile(home), "utf8")).not.toContain("abcd1234");
		expect(stored().resources.map(r => r.name)).toEqual(["x"]);
	});

	test("at most 64 names exist at once; one more is refused, an existing name still works, and expiry frees a name", async () => {
		for (let i = 0; i < 64; i++) await acquireLock(host(A), { name: `n${i}`, ttl: i === 0 ? 10 : 1000 });
		expect(stored().resources).toHaveLength(64);
		expect(await acquireLock(host(A), { name: "extra" })).toEqual({ outcome: "refused", reason: "at most 64 lock names may exist at once" });
		expect((await acquireLock(host(B), { name: "n1" })).outcome).toBe("busy");
		clock += secs(10);
		expect((await acquireLock(host(A), { name: "extra" })).outcome).toBe("acquired");
		expect(stored().resources).toHaveLength(64);
	});

	test("at most 256 leases exist at once", async () => {
		for (let owner = 0; owner < 64; owner++) {
			const self = peerId(owner + 1);
			for (const name of ["a", "b", "c", "d"]) {
				const result = await acquireLock(host(self), { name, capacity: 64 });
				expect(result.outcome).toBe("acquired");
			}
		}
		expect(stored().resources.reduce((sum, r) => sum + r.leases.length, 0)).toBe(256);
		expect(await acquireLock(host(A), { name: "e" })).toEqual({ outcome: "refused", reason: "at most 256 leases may exist at once" });
		// An existing lease can still renew when the table is full.
		expect((await renewLock(host(peerId(2)), { name: "b" })).outcome).toBe("renewed");
	});
});

describe("command and tool", () => {
	test("acquire parses flags and a multi-word note, and the reply is exact", async () => {
		const text = await run("acquire heavy-build --capacity 2 --ttl 120 --note running the full suite");
		expect(text).toBe("acquired heavy-build: lease l1, expires in 2m (2023-11-14T22:15:20.000Z); 1 of 2 slots in use. Renew before it expires and release when done.");
		expect(stored().resources[0]).toMatchObject({ name: "heavy-build", capacity: 2 });
		expect(stored().resources[0].leases[0].note).toBe("running the full suite");
		expect(await run("renew heavy-build --ttl 30")).toBe("renewed heavy-build: lease l1 now expires in 30s (2023-11-14T22:13:50.000Z); 1 of 2 in use");
		expect(await run("release heavy-build")).toBe("released heavy-build: lease l1");
		expect(await run("release heavy-build")).toBe("refused: this session holds no active lease on heavy-build");
	});

	test("note may be followed by another flag, and malformed flags show usage without writing", async () => {
		await run("acquire a --note two words --ttl 60");
		expect(stored().resources[0].leases[0]).toMatchObject({ note: "two words", expiresAt: T0 + secs(60) });
		for (const bad of ["acquire", "acquire a --capacity", "acquire a --capacity 1 --capacity 2", "acquire a --nope 1", "acquire a stray", "release", "release a b", "renew", "renew a --capacity 2", "frobnicate", "status a b"]) {
			expect(await run(bad)).toMatch(/^usage:/);
		}
		expect(stored().resources).toHaveLength(1);
		expect(await locks.command([], host(A))).toBe(renderStatus(host(A)));
		expect(await run("status")).toContain("a: 1 of 1 slot in use (busy)");
	});

	test("the peers_lock tool shares the semantics and reports refusals as errors but busy as a normal outcome", async () => {
		const tool = locks.tools!()[0];
		const as = (self: string) => host(self);
		const ok = await tool.execute({ action: "acquire", name: "heavy-build", ttl_seconds: 120 }, as(A));
		expect(ok.isError).toBeUndefined();
		expect(ok.text).toMatch(/^acquired heavy-build: lease l1, expires in 2m /);
		const busy = await tool.execute({ action: "acquire", name: "heavy-build" }, as(B));
		expect(busy.isError).toBeUndefined();
		expect(busy.text).toMatch(/^busy heavy-build: all 1 slot is held; nothing was acquired and nothing is waiting\./);
		expect(busy.text).toContain("worker-a (p00000000000000a1)");
		const refusedCapacity = await tool.execute({ action: "acquire", name: "heavy-build", capacity: 4 }, as(B));
		expect(refusedCapacity).toEqual({ text: "refused: capacity mismatch: heavy-build was created with capacity 1 (requested 4); the capacity is fixed until every lease on it has ended", isError: true });
		expect((await tool.execute({ action: "release", name: "heavy-build" }, as(B))).isError).toBe(true);
		expect((await tool.execute({ action: "renew", name: "heavy-build", ttl_seconds: 300 }, as(A))).text).toMatch(/^renewed heavy-build: lease l1 now expires in 5m /);
		expect((await tool.execute({ action: "status" }, as(B))).text).toMatch(/^heavy-build: 1 of 1 slot in use \(busy\)\n {2}l1 {2}worker-a/);
		expect((await tool.execute({ action: "status", name: "Bad" }, as(B))).isError).toBe(true);
		expect((await tool.execute({ action: "release", name: "heavy-build" }, as(A))).text).toBe("released heavy-build: lease l1");
		expect(await tool.execute({ action: "force-release", name: "x" }, as(MASTER))).toEqual({ text: "error: action must be acquire, renew, release or status", isError: true });
		expect((await tool.execute({ action: "acquire", name: "x", ttl_seconds: "soon" }, as(A))).isError).toBe(true);
	});
});

describe("atomicity across real processes", () => {
	const spawn = (id: string, name: string, capacity: number) =>
		Bun.spawn([process.execPath, path.join(import.meta.dir, "child_lock.ts"), home, id, name, String(capacity)], { stdout: "pipe", stderr: "pipe" });

	async function race(name: string, capacity: number, racers: number): Promise<string[]> {
		const children = Array.from({ length: racers }, (_, i) => spawn(peerId(0x100 + i), name, capacity));
		const results = await Promise.all(children.map(async child => {
			const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
			if (code !== 0) throw new Error(`child failed: ${err}`);
			return out.trim();
		}));
		return results;
	}

	test("N processes racing for capacity 2: exactly two win, the rest see busy, every round", async () => {
		for (let round = 0; round < 4; round++) {
			const name = `race-${round}`;
			const results = await race(name, 2, 8);
			expect(results.filter(r => r === "acquired")).toHaveLength(2);
			expect(results.filter(r => r === "busy")).toHaveLength(6);
			const resource = stored().resources.find(r => r.name === name)!;
			expect(resource.capacity).toBe(2);
			expect(resource.leases).toHaveLength(2);
			expect(new Set(resource.leases.map(l => l.owner)).size).toBe(2);
		}
		const state = stored();
		expect(new Set(state.resources.flatMap(r => r.leases.map(l => l.id))).size).toBe(8);
		expect(state.nextId).toBe(9);
	});

	test("racing for a mutex across processes yields exactly one winner", async () => {
		for (let round = 0; round < 3; round++) {
			const results = await race(`mutex-${round}`, 1, 6);
			expect(results.filter(r => r === "acquired")).toHaveLength(1);
			expect(results.filter(r => r === "busy")).toHaveLength(5);
		}
	});

	test("racers asking for different capacities on a new name: exactly one capacity wins and the other three are refused as a mismatch", async () => {
		const children = [1, 2, 3, 4].map(capacity => spawn(peerId(0x200 + capacity), "mixed", capacity));
		const results = await Promise.all(children.map(async child => {
			const out = (await new Response(child.stdout).text()).trim();
			expect(await child.exited).toBe(0);
			return out;
		}));
		const resource = stored().resources[0];
		expect(resource.leases).toHaveLength(1);
		expect(results.filter(r => r === "acquired")).toHaveLength(1);
		expect(results.filter(r => r.startsWith("refused: capacity mismatch"))).toHaveLength(3);
	});
});
