// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
// Child of nonblocking.test.ts: reads user-writable files that are FIFOs. A blocking read would hang this process; the parent kills it.
import { staleConfig } from "../../lib/features/board";
import { peersConfigFile, loadSettings } from "../../lib/features/audit";
import { readRegularFile } from "../../lib/features/store";

const [home, fifo] = process.argv.slice(2);
let code = "none";
try {
	readRegularFile(fifo);
} catch (error) {
	code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
}
const stale = staleConfig(home);
const settings = loadSettings(home);
console.log(JSON.stringify({ code, file: peersConfigFile(home), hours: stale.hours, warning: stale.warning, audit: settings.warnings }));
