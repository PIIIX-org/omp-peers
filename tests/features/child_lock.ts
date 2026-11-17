// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

// Child process for concurrency tests: `bun child_lock.ts <home> <peer id> <lock name> <capacity>` makes one acquire as that session and prints the outcome.
import { acquireLock } from "../../lib/features/locks";
import type { FeatureHost } from "../../lib/features/host";

const [home, id, name, capacity] = process.argv.slice(2);
const host: FeatureHost = {
	home,
	now: Date.now,
	self: () => ({ id, name: `session-${id.slice(-4)}` }),
	isMaster: () => false,
	acceptsRemote: () => true,
	peers: async () => [],
	groupsOf: () => [],
	notify: () => {},
	resolveModel: async () => ({ ok: false, error: "not exercised by this suite" }),
	applyModel: async () => ({ ok: false, error: "not exercised by this suite" }),
	resolveGroup: async () => ({ recipients: [], skipped: [] }),
	send: async () => ({ status: "offline" }),
};
const result = await acquireLock(host, { name, capacity });
console.log(result.outcome === "refused" ? `refused: ${result.reason}` : result.outcome);
