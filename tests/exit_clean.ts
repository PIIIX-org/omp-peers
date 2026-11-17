// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
// Run by test_notifications.py in a disposable HOME: `bun exit_clean.ts <exit code>` starts the extension for one session and
// leaves through process.exit(<code>) without a session_shutdown, as a crash or a kill-induced exit would. It prints the saved record
// as the last thing the process does, so the harness can check that only exit code 0 marks the run clean.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as z from "@oh-my-pi/omptype/zod";
import peers from "../extensions/peers";
import { stablePeerId } from "../lib/identity";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const code = Number(process.argv[2]);
const sessionId = "ses-exit";
const hooks = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<unknown>>>();
const ctx = {
	agent: { kind: "main" }, mode: "rpc", cwd: os.homedir(), sessionManager: { getSessionId: () => sessionId },
	models: { current: () => undefined }, isIdle: () => true,
	ui: { setStatus() {}, notify() {} }, setInterval() { return undefined; }, clearTimer() {},
} as unknown as ExtensionContext;
const api = {
	zod: z, setLabel() {}, getSessionName: () => "", getThinkingLevel: () => "off",
	on(name: string, fn: (event: unknown, context: ExtensionContext) => Promise<unknown>) { hooks.set(name, [...(hooks.get(name) ?? []), fn]); },
	registerTool() {}, registerCommand() {}, sendMessage() {},
} as unknown as ExtensionAPI;

peers(api);
const saved = path.join(os.homedir(), ".omp/agent/peer-sessions", `${stablePeerId(sessionId)}.json`);
for (const fn of hooks.get("session_start") ?? []) await fn({ type: "session_start" }, ctx);
for (let n = 0; n < 200 && !fs.existsSync(saved); n++) await delay(5);
// Registered after the extension's own exit hook, so it sees what that hook wrote.
process.on("exit", () => console.log(`SAVED ${fs.readFileSync(saved, "utf8")}`));
process.exit(code);
