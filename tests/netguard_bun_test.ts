// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

// `bun test` preload (bunfig.toml): a network-guard refusal that no test declared with `expectViolations` fails the run,
// even when the code under test caught the thrown error. Checked after every test and again after the last one.
import { afterAll, afterEach } from "bun:test";
import { takeViolations } from "./netguard_policy";

function assertNoViolations(): void {
	const violations = takeViolations();
	if (violations.length > 0) throw new Error(`unexpected outbound network attempt(s):\n${violations.join("\n")}`);
}

afterEach(assertNoViolations);
afterAll(assertNoViolations);
