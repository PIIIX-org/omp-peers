// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

// Test-only OMP extension, loaded by a scenario with `omp -e <this file>`; it is not part of the plugin and is not shipped.
// It moves the process clock forward on request (`/clock advance <seconds>`) so a scenario can cross a scheduled slot or a
// duration threshold without waiting for it in real time. Only the wall clock read by `Date.now()` and `new Date()` moves;
// timers still run in real time. The plugin never imports this file and reads no variable for it: the offset can only be
// changed by this extension, which only a test harness loads (tests/features/clockseam.test.ts keeps it that way).
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const RealDate = Date;
let offsetMs = 0;
const realNow = RealDate.now.bind(RealDate);

globalThis.Date = new Proxy(RealDate, {
	get(target, key, receiver) {
		if (key === "now") return () => realNow() + offsetMs;
		return Reflect.get(target, key, receiver);
	},
	construct(target, args, newTarget) {
		return args.length === 0 ? Reflect.construct(target, [realNow() + offsetMs], newTarget) : Reflect.construct(target, args, newTarget);
	},
});

export default function clock(pi: ExtensionAPI): void {
	pi.registerCommand("clock", {
		description: "Test only: /clock advance <seconds>",
		handler: async (args, ctx) => {
			const [verb, value] = args.trim().split(/\s+/);
			const seconds = Number(value);
			if (verb !== "advance" || !Number.isFinite(seconds) || seconds < 0 || seconds > 86_400) {
				ctx.ui.notify("usage: /clock advance <seconds 0-86400>", "error");
				return;
			}
			offsetMs += Math.round(seconds * 1000);
			ctx.ui.notify(`clock advanced by ${seconds}s (offset ${offsetMs / 1000}s)`, "info");
		},
	});
}
