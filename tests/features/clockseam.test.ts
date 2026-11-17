// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");

function sources(dir: string): string[] {
	return fs.readdirSync(path.join(ROOT, dir), { recursive: true, withFileTypes: true })
		.filter(entry => entry.isFile() && entry.name.endsWith(".ts"))
		.map(entry => path.join(entry.parentPath, entry.name));
}

describe("the scenario clock seam stays test-only", () => {
	test("plugin code never mentions the clock extension or a clock override", () => {
		for (const file of [...sources("lib"), ...sources("extensions")]) {
			const text = fs.readFileSync(file, "utf8");
			expect(text, file).not.toMatch(/_clock_ext|clock advance|globalThis\.Date\s*=|OMP_PEERS_CLOCK|OMP_PEERS_NOW/);
		}
	});

	test("the extension is not shipped and the only thing that loads it is a scenario", () => {
		const files: unknown = Reflect.get(JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")), "files");
		expect(Array.isArray(files)).toBe(true);
		for (const entry of Array.isArray(files) ? files : []) expect(String(entry), String(entry)).not.toMatch(/^tests\/?$|scenarios|_clock_ext/);
		const loaders = fs.readdirSync(path.join(ROOT, "tests/scenarios")).filter(name => name.endsWith(".py") && fs.readFileSync(path.join(ROOT, "tests/scenarios", name), "utf8").includes("_clock_ext.ts"));
		expect(loaders.sort()).toEqual(["digest.py", "watchdog.py"]);
	});
});
