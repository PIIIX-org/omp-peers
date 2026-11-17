// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

// Child process for concurrency tests: `bun child_digest.ts <home> <epoch ms> <tag>` evaluates the digest schedule as the master, three times, at a fixed clock.
// Every notification it would show is appended to <home>/notified.log.
import * as fs from "node:fs";
import * as path from "node:path";
import type { FeatureHost } from "../../lib/features/host";
import { tickDigest } from "../../lib/features/digest";

const [home, now, tag] = process.argv.slice(2);
const host: FeatureHost = {
	home,
	now: () => Number(now),
	self: () => ({ id: "p00000000000000aa", name: `master-${tag}` }),
	isMaster: () => true,
	notify: text => fs.appendFileSync(path.join(home, "notified.log"), `${tag}: ${text.split("\n")[0]}\n`),
	acceptsRemote: () => true,
	peers: async () => [],
	groupsOf: () => [],
	resolveGroup: async () => ({ recipients: [], skipped: [] }),
	resolveModel: async () => ({ ok: false, error: "not exercised by this suite" }),
	applyModel: async () => ({ ok: false, error: "not exercised by this suite" }),
	send: async () => {
		throw new Error("a digest must never send a peer message");
	},
};
for (let i = 0; i < 3; i++) await tickDigest(host);
