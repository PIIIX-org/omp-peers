// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

// Child process for concurrency tests: `bun child_ask.ts <home> <peer id> <tag> <count>` queues <count> distinct questions as that session.
import { askQuestion } from "../../lib/features/inbox";
import type { FeatureHost } from "../../lib/features/host";

const [home, id, tag, count] = process.argv.slice(2);
const host: FeatureHost = {
	home,
	now: Date.now,
	self: () => ({ id, name: `session-${tag}` }),
	isMaster: () => false,
	acceptsRemote: () => true,
	peers: async () => [],
	groupsOf: () => [],
	usageNow: () => undefined,
	resolveGroup: async () => ({ recipients: [], skipped: [] }),
	resolveModel: async () => ({ ok: false, error: "not exercised by this suite" }), applyModel: async () => ({ ok: false, error: "not exercised by this suite" }),
	send: async () => ({ status: "offline" }),
};
for (let i = 0; i < Number(count); i++) {
	const result = await askQuestion(host, { question: `${tag} question ${i}` });
	if (!result.ok) throw new Error(result.error);
}
