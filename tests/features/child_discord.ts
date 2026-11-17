// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

// Child process for concurrency tests: `bun child_discord.ts <home> <epoch ms> <tag>` ticks the Discord bridge as the master, three times,
// at a fixed clock, against a fake HTTP client that answers slowly (so two children overlap). Every request it makes is appended to
// <home>/requests.log as `<tag> <METHOD> <url>`; no network is touched.
import * as fs from "node:fs";
import * as path from "node:path";
import { discord, setTestSeam } from "../../lib/features/discord";
import type { FeatureHost } from "../../lib/features/host";

const [home, now, tag] = process.argv.slice(2);
const host: FeatureHost = {
	home,
	now: () => Number(now),
	self: () => ({ id: "p00000000000000aa", name: `master-${tag}` }),
	isMaster: () => true,
	notify: text => fs.appendFileSync(path.join(home, "notified.log"), `${tag}: ${text}\n`),
	usageNow: () => undefined,
	acceptsRemote: () => true,
	peers: async () => [],
	groupsOf: () => [],
	resolveGroup: async () => ({ recipients: [], skipped: [] }),
	resolveModel: async () => ({ ok: false, error: "not exercised by this suite" }),
	applyModel: async () => ({ ok: false, error: "not exercised by this suite" }),
	send: async () => {
		throw new Error("the Discord bridge must never send a peer message");
	},
};
setTestSeam({
	fetch: async (url, init) => {
		fs.appendFileSync(path.join(home, "requests.log"), `${tag} ${init.method} ${url} ${init.body ?? ""}\n`);
		await Bun.sleep(300);
		return new Response(init.method === "GET" ? "[]" : "{}", { status: 200 });
	},
});
for (let i = 0; i < 3; i++) await discord.tick!(host);
