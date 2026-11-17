// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

// Child process for the replay concurrency test: `bun child_hosts_replay.ts <home> <request id> <now>` prints the claim result.
import { claimRequestId } from "../../lib/features/hosts_bridge";

const [home, id, now] = process.argv.slice(2);
console.log(await claimRequestId(home, id, Number(now)));
