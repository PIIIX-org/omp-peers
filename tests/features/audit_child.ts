// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

// Child process for the audit concurrency test: `bun audit_child.ts <home> <tag> <count>` records <count> control attempts.
import { AuditLog, newRequestId } from "../../lib/features/audit";

const [home, tag, count] = process.argv.slice(2);
const log = new AuditLog();
for (let i = 0; i < Number(count); i++) {
	await log.record(home, Date.now(), {
		request: newRequestId(),
		side: "receiver",
		phase: "attempted",
		actor: { id: "p00000000000000aa", name: tag },
		target: { id: "p00000000000000a1", name: `worker-${i}` },
		op: "rename",
		args: { text: `${tag}-${i}` },
	});
}
if (log.lastError) throw new Error(log.lastError.message);
