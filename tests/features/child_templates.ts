// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

// Child process for tests: `bun child_templates.ts <home> <tag> apply <template>` applies <template> as session p<tag>00000000 (8-hex tag),
// `... add <name>` stores a template named <name>, `... list` prints the stored templates. Prints the command output.
import type { FeatureHost } from "../../lib/features/host";
import { groupsOf } from "../../lib/features/groups";
import { templates } from "../../lib/features/templates";

const [home, tag, action, name] = process.argv.slice(2);
const self = `p${tag}00000000`;
const host: FeatureHost = {
	home,
	now: Date.now,
	self: () => ({ id: self, name: `child-${tag}` }),
	isMaster: () => false,
	acceptsRemote: () => true,
	peers: async () => [{ id: self, name: `child-${tag}` }],
	groupsOf: peerId => groupsOf(home, peerId),
	notify: () => {},
	resolveGroup: async () => ({ recipients: [], skipped: [] }),
	send: async () => ({ status: "offline" }),
	resolveModel: async selector => ({ ok: true, model: `prov/${selector}`, current: "prov/old" }),
	applyModel: async selector => ({ ok: true, model: `prov/${selector}`, previous: "prov/old" }),
};
const args = action === "apply" ? ["apply", name, "--yes"] : action === "add" ? ["add", name, "--rule", `rule of ${tag}`] : ["list"];
console.log(await templates.command(args, host));
