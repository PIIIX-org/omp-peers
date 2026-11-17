// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

// Child process for concurrency tests: `bun child_autocompact.ts <home> <peer id> <kind> <rounds>` runs <rounds> state-changing commands as that session.
// kind "add": adds <rounds> distinct group entries. kind "toggle:<n>": alternates contextPercent between n and n+1; callers use disjoint n, so every call changes the state and logs.
import type { FeatureHost } from "../../lib/features/host";
import { AutoCompactRuntime } from "../../lib/features/autocompact";

const [home, id, kind, rounds] = process.argv.slice(2);
const host: FeatureHost = {
	home,
	now: Date.now,
	self: () => ({ id, name: `session-${id.slice(-4)}` }),
	isMaster: () => false,
	acceptsRemote: () => true,
	peers: async () => [],
	groupsOf: () => [],
	resolveModel: async () => ({ ok: false, error: "not exercised by this suite" }),
	applyModel: async () => ({ ok: false, error: "not exercised by this suite" }),
	notify: () => {},
	resolveGroup: async () => ({ recipients: [], skipped: [] }),
	send: async () => ({ status: "offline" }),
};
const runtime = new AutoCompactRuntime();
for (let i = 0; i < Number(rounds); i++) {
	const out = kind === "add" ? await runtime.command(["add", `group:${id.slice(-4)}-${i}`], host) : await runtime.command(["set", "contextPercent", String(Number(kind.slice(7)) + (i % 2))], host);
	if (out.startsWith("error")) throw new Error(out);
}
