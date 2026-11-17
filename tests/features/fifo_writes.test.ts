// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let root: string;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "fw-"));
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

/** Run a script in a child bun; `timeout` kills it if a write blocks on the FIFO, so a regression fails instead of hanging the suite. */
async function child(script: string): Promise<{ out: string; err: string; code: number | null }> {
	const proc = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe", timeout: 4_000 });
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { out, err, code };
}

const NOTIFICATIONS = path.resolve(import.meta.dir, "../../extensions/notifications.ts");

describe("notifications journal", () => {
	test("a FIFO at the journal path fails the append at once (with and without a reader); a regular journal still works", async () => {
		const id = createHash("sha256").update("s1").digest("hex");
		const dir = path.join(root, "notifications");
		fs.mkdirSync(dir, { recursive: true });
		const journal = path.join(dir, `${id}.jsonl`);
		expect(Bun.spawnSync(["mkfifo", journal]).exitCode).toBe(0);
		const script = `
			import { Notifications } from ${JSON.stringify(NOTIFICATIONS)};
			const n = new Notifications(${JSON.stringify(root)});
			n.bind("s1");
			n.start();
			console.log(JSON.stringify({ available: n.available }));
		`;
		// No reader: open(O_WRONLY|O_NONBLOCK) fails with ENXIO.
		const noReader = await child(script);
		expect(noReader.code, noReader.err).toBe(0);
		expect(JSON.parse(noReader.out)).toEqual({ available: true }); // start() itself writes nothing
		const ended = await child(script.replace("n.start();", "n.start(); n.end('x'); "));
		expect(ended.code, ended.err).toBe(0);
		expect(JSON.parse(ended.out)).toEqual({ available: false });
		// With a reader holding the FIFO open: the open succeeds, fstat refuses it, nothing is written. A non-blocking read-open in this
		// process returns at once, so the reader exists before the child starts (no sleep, no race).
		const readerFd = fs.openSync(journal, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
		let withReader: Awaited<ReturnType<typeof child>>;
		try {
			withReader = await child(script.replace("n.start();", "n.start(); n.end('x'); "));
		} finally {
			fs.closeSync(readerFd);
		}
		expect(withReader.code, withReader.err).toBe(0);
		expect(JSON.parse(withReader.out)).toEqual({ available: false });
		// A regular journal is appended as before.
		fs.rmSync(journal);
		const ok = await child(script.replace("n.start();", "n.start(); n.end('x'); "));
		expect(JSON.parse(ok.out)).toEqual({ available: true });
		expect(fs.readFileSync(journal, "utf8").trim().split("\n")).toHaveLength(1);
	});
});
