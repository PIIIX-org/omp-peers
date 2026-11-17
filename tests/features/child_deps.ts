// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

// Child process for concurrency tests, acting as the master session:
//   bun child_deps.ts <home> approve <trigger id>   dispatches that trigger
//   bun child_deps.ts <home> report <sender id>     accepts one fixed DONE report from that sender
// Every message "sent" is appended to <home>/sent.log, after a pause that widens the race window.
import * as fs from "node:fs";
import * as path from "node:path";
import { dispatchTrigger, onReport } from "../../lib/features/deps";
import type { FeatureHost } from "../../lib/features/host";

const [home, mode, arg] = process.argv.slice(2);
const MASTER = "p00000000000000aa";
const host: FeatureHost = {
	home,
	now: Date.now,
	self: () => ({ id: MASTER, name: "master" }),
	isMaster: () => true,
	acceptsRemote: () => true,
	peers: async () => [{ id: MASTER, name: "master" }, { id: "p00000000000000a1", name: "worker-a" }, { id: "p00000000000000b2", name: "worker-b" }],
	groupsOf: () => [],
	notify: () => {},
	resolveModel: async () => ({ ok: false, error: "not exercised by this suite" }),
	applyModel: async () => ({ ok: false, error: "not exercised by this suite" }),
	resolveGroup: async () => ({ recipients: [], skipped: [] }),
	send: async (to, req) => {
		await Bun.sleep(150);
		fs.appendFileSync(path.join(home, "sent.log"), `${JSON.stringify({ to, text: req.text })}\n`);
		return { status: "delivered" };
	},
};

if (mode === "approve") {
	const result = await dispatchTrigger(host, arg);
	console.log(result.status);
} else {
	await onReport({ kind: "DONE", unit: "Parser rewrite", evidence: { description: "Offline checks passed" } }, { id: arg, name: "worker-a" }, host);
	console.log("reported");
}
