// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

// Child process for concurrency tests: `bun child_add.ts <home> <tag> <count>` adds <count> rules; a duplicate rejection is expected when two children race on the same text.
import { addRule } from "../../lib/features/rules";
import type { FeatureHost } from "../../lib/features/host";

const [home, tag, count] = process.argv.slice(2);
const host: FeatureHost = {
	home,
	now: Date.now,
	self: () => ({ id: "p0000000000000001", name: "master" }),
	isMaster: () => true,
	acceptsRemote: () => true,
	peers: async () => [],
	groupsOf: () => [],
	send: async () => ({ status: "offline" }),
};
for (let i = 0; i < Number(count); i++) {
	const result = await addRule(host, "global", `${tag} rule ${i}`);
	if (!result.ok && !result.existing) throw new Error(result.error);
}
