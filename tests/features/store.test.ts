// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FileLock } from "@oh-my-pi/pi-natives";
import { privateDir, readState, stateRoot, updateState } from "../../lib/features/store";

interface Counter { version: 1; n: number }
const fallback = (): Counter => ({ version: 1, n: 0 });
const validate = (value: unknown): Counter => {
	const v = value as Counter;
	if (v?.version !== 1 || !Number.isInteger(v.n)) throw new Error("bad counter");
	return v;
};
const bump = (c: Counter) => ({ state: { version: 1 as const, n: c.n + 1 }, result: c.n + 1 });
const mode = (p: string) => fs.statSync(p).mode & 0o777;

let home: string;
let file: string;
beforeEach(() => {
	home = fs.mkdtempSync(path.join("/tmp", "opf-"));
	file = path.join(stateRoot(home), "counter.json");
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("private state store", () => {
	test("state root is under the home's agent directory", () => {
		expect(stateRoot("/h")).toBe(path.join("/h", ".omp", "agent", "peer-state"));
	});

	test("creates a 0700 directory and 0600 file, persists across a reload, leaves no temp files", async () => {
		expect(await updateState(file, fallback, validate, bump)).toBe(1);
		expect(await updateState(file, fallback, validate, bump)).toBe(2);
		expect(mode(path.dirname(file))).toBe(0o700);
		expect(mode(file)).toBe(0o600);
		expect(readState(file, fallback, validate)).toEqual({ version: 1, n: 2 });
		expect(fs.readdirSync(path.dirname(file)).filter(name => name.endsWith(".tmp"))).toEqual([]);
	});

	test("missing state reads as the fallback without creating anything", () => {
		expect(readState(file, fallback, validate)).toEqual(fallback());
		expect(fs.existsSync(path.dirname(file))).toBe(false);
	});

	test("tightens a loose existing directory and refuses a symlinked one", () => {
		const dir = path.join(home, "loose");
		fs.mkdirSync(dir, { mode: 0o755 });
		privateDir(dir);
		expect(mode(dir)).toBe(0o700);
		const link = path.join(home, "link");
		fs.symlinkSync(dir, link);
		expect(() => privateDir(link)).toThrow("not a private directory");
	});

	test("unreadable or invalid state is an error and is never overwritten", async () => {
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		fs.writeFileSync(file, "{not json");
		expect(() => readState(file, fallback, validate)).toThrow("not valid JSON");
		await expect(updateState(file, fallback, validate, bump)).rejects.toThrow("not valid JSON");
		expect(fs.readFileSync(file, "utf8")).toBe("{not json");
		fs.writeFileSync(file, JSON.stringify({ version: 2, n: 1 }));
		await expect(updateState(file, fallback, validate, bump)).rejects.toThrow("invalid: bad counter");
	});

	test("a symlinked state file is never followed", async () => {
		const target = path.join(home, "elsewhere.json");
		fs.writeFileSync(target, JSON.stringify({ version: 1, n: 41 }));
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		fs.symlinkSync(target, file);
		expect(() => readState(file, fallback, validate)).toThrow("symlink");
		await expect(updateState(file, fallback, validate, bump)).rejects.toThrow("symlink");
		expect(JSON.parse(fs.readFileSync(target, "utf8")).n).toBe(41);
	});

	test("an update that returns no state does not write", async () => {
		expect(await updateState(file, fallback, validate, () => ({ result: "noop" }))).toBe("noop");
		expect(fs.existsSync(file)).toBe(false);
	});

	test("concurrent updates in one process never lose an increment", async () => {
		await Promise.all(Array.from({ length: 40 }, () => updateState(file, fallback, validate, bump)));
		expect(readState(file, fallback, validate).n).toBe(40);
	});

	test("a held state lock makes the update fail after its bounded wait, without writing", async () => {
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		const held = FileLock.tryAcquire(`${file}.lock`);
		expect(held.acquired).toBe(true);
		try {
			await expect(updateState(file, fallback, validate, bump, 150)).rejects.toThrow("busy");
		} finally {
			held.release();
		}
		expect(fs.existsSync(file)).toBe(false);
		expect(await updateState(file, fallback, validate, bump)).toBe(1);
	});

	test("a failing update releases the lock", async () => {
		await expect(updateState(file, fallback, validate, () => { throw new Error("boom"); })).rejects.toThrow("boom");
		expect(await updateState(file, fallback, validate, bump, 150)).toBe(1);
	});
});

