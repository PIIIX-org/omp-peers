// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

// Child process for concurrency tests: `bun child_groups.ts <home> <tag> <count>` adds <count> distinct members (ids built from the 8-hex <tag>) to group "shared" and one group of its own.
import { addMember } from "../../lib/features/groups";

const [home, tag, count] = process.argv.slice(2);
const master = { self: "p0000000000000001", master: true };
for (let i = 0; i < Number(count); i++) {
	const result = await addMember(home, "shared", `p${tag}${i.toString(16).padStart(8, "0")}`, master);
	if (!result.ok) throw new Error(result.error);
}
const own = await addMember(home, `own-${tag}`, `p${tag}00000000`, master);
if (!own.ok) throw new Error(own.error);
