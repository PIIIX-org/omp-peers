// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

/**
 * Private, versioned feature state under `~/.omp/agent/peer-state/`.
 *
 * Directory 0700, files 0600, whole-file atomic replacement. Read-modify-write is serialised across
 * processes with the host's native kernel `FileLock`, so concurrent writers never lose an update.
 * Final files are never followed through a symlink.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { FileLock } from "@oh-my-pi/pi-natives";

export const LOCK_TIMEOUT_MS = 10_000;

export function stateRoot(home: string): string {
	return path.join(home, ".omp", "agent", "peer-state");
}

/** Create `dir` (and parents) owner-only; refuse a symlink or non-directory in its place. */
export function privateDir(dir: string): string {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const info = fs.lstatSync(dir);
	if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${path.basename(dir)} is not a private directory; refusing to use it`);
	fs.chmodSync(dir, 0o700);
	return dir;
}

/**
 * Read JSON state. A missing file yields `fallback()`. A symlink, unparsable file or one rejected by
 * `validate` (which must throw) is an error: callers must not silently overwrite state they cannot read.
 */
export function readState<T>(file: string, fallback: () => T, validate: (value: unknown) => T): T {
	let text: string;
	try {
		const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		try {
			text = fs.readFileSync(fd, "utf8");
		} finally {
			fs.closeSync(fd);
		}
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return fallback();
		if (code === "ELOOP") throw new Error(`${path.basename(file)} is a symlink; refusing to read it`);
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`${path.basename(file)} is not valid JSON; fix or remove it`);
	}
	try {
		return validate(parsed);
	} catch (error) {
		throw new Error(`${path.basename(file)} is invalid: ${(error as Error).message}`);
	}
}

function writeAtomic(file: string, value: unknown): void {
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
		try {
			fs.writeFileSync(fd, `${JSON.stringify(value, null, "\t")}\n`);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(tmp, file);
	} catch (error) {
		fs.rmSync(tmp, { force: true });
		throw error;
	}
}

async function acquire(lockPath: string, timeoutMs: number): Promise<FileLock> {
	const deadline = Date.now() + timeoutMs;
	for (let attempt = 0; ; attempt++) {
		const lock = FileLock.tryAcquire(lockPath);
		if (lock.acquired) return lock;
		if (Date.now() >= deadline) throw new Error(`${path.basename(lockPath)} is busy; another process holds the state lock`);
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, Math.min(5 + attempt * 2, 40) + Math.random() * 5);
		await promise;
	}
}

/**
 * Atomic cross-process read-modify-write. `fn` runs synchronously under the lock and returns the
 * value to persist (omit `state` to leave the file untouched) and a `result` for the caller.
 */
export async function updateState<T, R>(
	file: string,
	fallback: () => T,
	validate: (value: unknown) => T,
	fn: (current: T) => { state?: T; result: R },
	timeoutMs = LOCK_TIMEOUT_MS,
): Promise<R> {
	privateDir(path.dirname(file));
	const lock = await acquire(`${file}.lock`, timeoutMs);
	try {
		const out = fn(readState(file, fallback, validate));
		if (out.state !== undefined) writeAtomic(file, out.state);
		return out.result;
	} finally {
		lock.release();
	}
}
