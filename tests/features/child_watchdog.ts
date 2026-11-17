// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

// Child process for concurrency tests: `bun child_watchdog.ts <home> <master id> <peer id> <rounds>` acts as the master and
// overrides then clears <peer id> <rounds> times, ticking in between, then leaves a final override in place.
import type { FeatureHost, PeerView } from "../../lib/features/host";
import { tick, watchdog } from "../../lib/features/watchdog";

const [home, masterId, id, rounds] = process.argv.slice(2);
const T0 = 1_700_000_000_000;
const host: FeatureHost = {
	home,
	now: () => T0,
	self: () => ({ id: masterId, name: "master" }),
	isMaster: () => true,
	acceptsRemote: () => true,
	peers: async (): Promise<PeerView[]> => [
		{ id: masterId, name: "master" },
		{ id, name: "worker", busy: true, updatedAt: new Date(T0).toISOString() },
	],
	groupsOf: () => [],
	resolveModel: async () => ({ ok: false, error: "not exercised by this suite" }),
	applyModel: async () => ({ ok: false, error: "not exercised by this suite" }),
	resolveGroup: async () => ({ recipients: [], skipped: [] }),
	send: async () => ({ status: "delivered" }),
};

for (let i = 0; i < Number(rounds); i++) {
	const set = await watchdog.command(["override", id, "--busy-minutes", String(100 + i)], host);
	if (set.startsWith("error:")) throw new Error(set);
	await tick(host);
	const cleared = await watchdog.command(["clear-override", id], host);
	if (cleared.startsWith("error:")) throw new Error(cleared);
}
const last = await watchdog.command(["override", id, "--context-percent", "77"], host);
if (last.startsWith("error:")) throw new Error(last);
