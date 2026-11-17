// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

/**
 * Side-effect-free half of the test-only network guard (tests/netguard.ts): the loopback policy and the process-global
 * violation log. Importing this module installs nothing, so a test that imports ONLY this module can prove the guard is
 * active solely because the preload (bun test) or `omp -e tests/netguard_ext.ts` (smoke OMP) installed it.
 *
 * Every refusal is recorded here and written to stderr (`network guard: refused ...`) before it is thrown, so a caller
 * that catches the error still leaves evidence: the bun preload (tests/netguard_bun_test.ts) fails the run on any
 * violation a test did not declare with `expectViolations`, and the smoke harnesses fail on that stderr line.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { writeSync } from "node:fs";

interface ViolationState {
	/** Refusals nobody declared as expected; the bun preload fails the run when this is non-empty. */
	unexpected: string[];
	/** Collector for the refusals made inside an `expectViolations` call, including across awaits. */
	scope: AsyncLocalStorage<string[]>;
}

const STATE = Symbol.for("omp-peers.netguard.violations");

function state(): ViolationState {
	const holder = globalThis as Record<symbol, unknown>;
	holder[STATE] ??= { unexpected: [], scope: new AsyncLocalStorage<string[]>() } satisfies ViolationState;
	return holder[STATE] as ViolationState;
}

/** Whether `host` (a name or address literal, optionally bracketed) is loopback. Anything unparsable is not. */
export function isLoopback(host: string | undefined | null): boolean {
	if (host === undefined || host === null || host === "") return true; // node's default target is localhost
	const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
	if (bare === "localhost" || bare.endsWith(".localhost") || bare === "::1") return true;
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
	const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(mapped ? mapped[1] : bare);
	return parts !== null && Number(parts[1]) === 127 && parts.slice(1).every(p => Number(p) <= 255);
}

/** Record `message` as a violation, write it to stderr unless a test expects it, and throw it. */
export function refuse(message: string): never {
	const expected = state().scope.getStore();
	if (expected) {
		expected.push(message);
	} else {
		state().unexpected.push(message);
		try {
			writeSync(2, `${message}\n`);
		} catch {
			// stderr closed: the global list still carries the evidence
		}
	}
	throw new Error(message);
}

/** Return and clear the refusals no test declared. */
export function takeViolations(): string[] {
	return state().unexpected.splice(0);
}

/** Run `fn` (sync or async) and return the refusals made inside it, which are then not counted as unexpected. */
export async function expectViolations(fn: () => unknown): Promise<string[]> {
	const collected: string[] = [];
	await state().scope.run(collected, fn);
	return collected;
}
