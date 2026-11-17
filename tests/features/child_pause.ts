// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

// Child process for concurrency tests: `bun child_pause.ts <home> <peer id> <rounds>` pauses and resumes <peer id> <rounds> times, then leaves it paused.
import { pauseSession, resumeSession } from "../../lib/features/pause";

const [home, id, rounds] = process.argv.slice(2);
for (let i = 0; i < Number(rounds); i++) {
	const paused = await pauseSession(home, id, "user", Date.now(), `round ${i}`);
	if (!paused.ok) throw new Error(paused.error);
	await resumeSession(home, id, "user");
}
const last = await pauseSession(home, id, "user", Date.now(), "final");
if (!last.ok) throw new Error(last.error);
