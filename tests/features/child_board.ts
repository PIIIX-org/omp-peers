// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

// Child process for concurrency tests: `bun child_board.ts <home> <tag> <count>` records reports for <count> distinct sessions of its own, twice each.
import type { FeatureHost } from "../../lib/features/host";
import { recordReport } from "../../lib/features/board";

const [home, tag, count] = process.argv.slice(2);
const host: FeatureHost = {
	home,
	now: Date.now,
	self: () => ({ id: "p0000000000000001", name: "writer" }),
	isMaster: () => false,
	acceptsRemote: () => true,
	peers: async () => [],
	groupsOf: () => [],
	resolveGroup: async () => ({ recipients: [], skipped: [] }),
	resolveModel: async () => ({ ok: false, error: "not exercised by this suite" }), applyModel: async () => ({ ok: false, error: "not exercised by this suite" }),
	send: async () => ({ status: "offline" }),
};
for (const round of ["first", "second"]) {
	for (let i = 0; i < Number(count); i++) {
		const id = `p${tag}${String(i).padStart(14, "0")}`;
		await recordReport(host, { kind: "WAITING", unit: `${tag} unit ${i} ${round}`, background: "none", nextAction: "Check back later" }, { id, name: `${tag}-${i}` });
	}
}
