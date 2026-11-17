// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

// Child process for concurrency tests, acting as the master session:
//   bun child_events.ts <home> ingest <event id>   admits one generic event from source `ci` (as the spool reader would)
//   bun child_events.ts <home> tick                runs one periodic tick
// Every message "sent" is appended to <home>/sent.log, after a pause that widens the race window.
import * as fs from "node:fs";
import * as path from "node:path";
import { ingestEvent, tick } from "../../lib/features/events";
import { validateGeneric } from "../../lib/features/events-ingest";
import type { FeatureHost } from "../../lib/features/host";

const [home, mode, arg] = process.argv.slice(2);
const MASTER = "p00000000000000aa";
const host: FeatureHost = {
	home,
	now: Date.now,
	self: () => ({ id: MASTER, name: "master" }),
	isMaster: () => true,
	acceptsRemote: () => true,
	peers: async () => [{ id: MASTER, name: "master" }, { id: "p00000000000000a1", name: "worker-a" }],
	groupsOf: () => [],
	resolveModel: async () => ({ ok: false, error: "not exercised by this suite" }),
	applyModel: async () => ({ ok: false, error: "not exercised by this suite" }),
	notify: () => {},
	resolveGroup: async () => ({ recipients: [], skipped: [] }),
	send: async (to, req) => {
		await Bun.sleep(150);
		fs.appendFileSync(path.join(home, "sent.log"), `${JSON.stringify({ to, text: req.text })}\n`);
		return { status: "delivered" };
	},
};

if (mode === "ingest") {
	const out = await ingestEvent(host, "cli", "ci", () => validateGeneric({ id: arg, type: "t", summary: "same event" }));
	console.log(out.outcome);
} else {
	await tick(host);
	console.log("ticked");
}
