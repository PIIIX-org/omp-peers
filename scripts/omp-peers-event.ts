#!/usr/bin/env bun
// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

/**
 * Drop one external event into the local spool read by the master OMP session:
 *   bun scripts/omp-peers-event.ts --source <name> [--file event.json]   (JSON on stdin without --file)
 * The producer must run as the same user as OMP; the spool directory is private to that user.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import { MAX_EVENT_BYTES } from "../lib/features/events-ingest";
import { runCli } from "../lib/features/events-spool";

/** Read stdin up to one byte more than the event limit, so an oversize event is rejected without being buffered whole. */
function readStdin(): Uint8Array {
	const chunks: Buffer[] = [];
	let total = 0;
	while (total <= MAX_EVENT_BYTES) {
		const chunk = Buffer.alloc(8192);
		let size = 0;
		try {
			size = fs.readSync(0, chunk, 0, chunk.length, null);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EOF") break;
			throw error;
		}
		if (size === 0) break;
		chunks.push(chunk.subarray(0, size));
		total += size;
	}
	return Buffer.concat(chunks);
}

const lines: string[] = [];
const code = runCli(process.argv.slice(2), os.homedir(), readStdin, line => lines.push(line));
(code === 0 ? console.log : console.error)(lines.join("\n"));
process.exit(code);
