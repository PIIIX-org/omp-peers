// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

// Child process for the end-to-end test: `bun child_hosts.ts <home> <session id> <hosts args...>` runs one real
// `/peers hosts` command (real ssh runner, real environment seam) as the master session and prints its reply.
import type { FeatureHost } from "../../lib/features/host";
import { hosts } from "../../lib/features/hosts";

const [home, selfId, ...args] = process.argv.slice(2);
const host: FeatureHost = {
	home,
	now: Date.now,
	self: () => ({ id: selfId, name: "origin-worker" }),
	isMaster: () => true,
	acceptsRemote: () => true,
	peers: async () => [],
	groupsOf: () => [],
	notify: () => {},
	resolveGroup: async () => ({ recipients: [], skipped: [] }),
	resolveModel: async () => ({ ok: false, error: "not exercised" }),
	applyModel: async () => ({ ok: false, error: "not exercised" }),
	send: async () => ({ status: "offline" }),
};
console.log(await hosts.command(args, host));
