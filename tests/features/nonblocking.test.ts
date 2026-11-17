// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readRegularFile } from "../../lib/features/store";

let home: string;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "nb-"));
	fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
});
afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
});

function mkfifo(file: string): void {
	const made = Bun.spawnSync(["mkfifo", file]);
	if (made.exitCode !== 0) throw new Error(`mkfifo failed: ${made.stderr.toString()}`);
}

describe("readers of user-writable files never block on a FIFO", () => {
	test("readRegularFile reads a regular file, follows a symlink, and refuses a FIFO", () => {
		const file = path.join(home, "a.json");
		fs.writeFileSync(file, '{"x":1}');
		expect(readRegularFile(file)).toBe('{"x":1}');
		fs.symlinkSync(file, path.join(home, "link.json"));
		expect(readRegularFile(path.join(home, "link.json"))).toBe('{"x":1}');
		expect(() => readRegularFile(path.join(home, "missing.json"))).toThrow(/ENOENT/);
		const fifo = path.join(home, "f.json");
		mkfifo(fifo);
		expect(() => readRegularFile(fifo)).toThrow("not a regular file");
	});

	test("board staleConfig, audit loadSettings and readRegularFile return at once for a FIFO peers.json (a blocking read would hang the child)", async () => {
		const fifo = path.join(home, ".omp", "agent", "peers.json");
		mkfifo(fifo);
		// `timeout` kills the child if a read blocks on the FIFO, so a regression fails this test instead of hanging the suite.
		const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "child_fifo.ts"), home, fifo], { stdout: "pipe", stderr: "pipe", timeout: 4_000 });
		const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		expect(code, err).toBe(0);
		const result: unknown = JSON.parse(out);
		expect(result).toMatchObject({
			code: "NOT_REGULAR",
			hours: 24,
			warning: "peers.json is not a regular file; using 24h",
			audit: ["peers.json is not a regular file; audit limits use their defaults"],
		});
	});
});
