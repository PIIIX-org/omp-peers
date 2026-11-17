// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
// Consumer-level lifecycle exercise: pinned process identity, one exit hook, minimal session metadata.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as z from "@oh-my-pi/omptype/zod";
import peers from "../extensions/peers";
import { stablePeerId } from "../lib/identity";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const root = path.join(os.homedir(), ".omp/run/peers");
const saved = path.join(os.homedir(), ".omp/agent/peer-sessions");
const hooks = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<unknown>>>();
const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
const notices: string[] = [];
let sessionName = "";

// Each ACP session owns a distinct manager object; OMP mutates one manager in place for logical switches.
function session(id: string) {
	const manager = { id, getSessionId() { return this.id; } };
	const ctx = {
		agent: { kind: "main" }, mode: "rpc", cwd: os.homedir(), sessionManager: manager,
		models: { current: () => undefined }, isIdle: () => true,
		ui: { setStatus() {}, notify(text: string) { notices.push(text); } },
		setInterval() { return undefined; }, clearTimer() {},
	} as unknown as ExtensionContext;
	return { manager, ctx };
}
const api = {
	zod: z, setLabel() {}, getSessionName: () => sessionName, getThinkingLevel: () => "off",
	on(name: string, fn: (event: unknown, context: ExtensionContext) => Promise<unknown>) {
		hooks.set(name, [...(hooks.get(name) ?? []), fn]);
	},
	registerTool() {},
	registerCommand(name: string, command: { handler: (args: string, context: ExtensionContext) => Promise<void> }) {
		commands.set(name, command.handler);
	},
	sendMessage() {},
} as unknown as ExtensionAPI;

async function emit(name: string, context: ExtensionContext): Promise<void> {
	const event = name === "turn_end" ? { type: name, message: { role: "assistant", stopReason: "stop" } } : { type: name };
	for (const fn of hooks.get(name) ?? []) await fn(event, context);
}
async function command(args: string, context: ExtensionContext): Promise<string> {
	await commands.get("peers")!(args, context);
	return notices.at(-1) ?? "";
}
const files = (dir: string, pattern: RegExp): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter(f => pattern.test(f)).sort();
const registry = () => files(root, /^p[0-9a-f]{16}\.json$/).map(f => JSON.parse(fs.readFileSync(path.join(root, f), "utf8")) as { id: string; sessionId: string });
const masterClaim = (): string | undefined => {
	try {
		return (JSON.parse(fs.readFileSync(path.join(root, "master.json"), "utf8")) as { id: string }).id;
	} catch {
		return undefined;
	}
};
const stored = (id: string) => path.join(saved, `${stablePeerId(id)}.json`);
async function until(predicate: () => boolean): Promise<void> {
	for (let n = 0; n < 200; n++) {
		if (predicate()) return;
		await delay(5);
	}
	throw new Error("Timed out waiting for isolated peer");
}

const exitBefore = process.listeners("exit").length;
const a = session("worker-a");
const b = session("worker-b");
try {
	peers(api);
	await emit("session_start", a.ctx);
	await until(() => registry().length === 1);
	const exitAfterStart = process.listeners("exit").length;
	assert.equal(exitAfterStart, exitBefore + 1, "extension registers exactly one exit listener");
	assert.deepEqual(registry().map(p => p.sessionId), ["worker-a"]);

	// (c) A default session persists only its run record: `clean: false` while it runs, nothing else beyond the defaults.
	const record = (sessionId: string, extra: Record<string, unknown> = {}) => ({ sessionId, name: "", restoreMaster: false, routingPolicy: "keep", clean: false, managed: false, ...extra });
	assert.deepEqual(files(saved, /\.json$/), [path.basename(stored("worker-a"))], "a bound session writes its run record");
	assert.deepEqual(JSON.parse(fs.readFileSync(stored("worker-a"), "utf8")), record("worker-a"));
	assert.match(await command("master", a.ctx), /now the master/);
	assert.equal(masterClaim(), stablePeerId("worker-a"));
	assert.deepEqual(JSON.parse(fs.readFileSync(stored("worker-a"), "utf8")), record("worker-a"), "claiming master without --restore changes nothing");

	// (a) A second session manager in the same process cannot swap identity or the master claim.
	const pinned = registry()[0]!.id;
	for (let round = 0; round < 3; round++) {
		await emit("session_start", b.ctx);
		for (const name of ["agent_start", "turn_end", "agent_end", "session_shutdown"]) await emit(name, b.ctx);
		await command("list", b.ctx);
		assert.deepEqual(registry().map(p => [p.id, p.sessionId]), [[pinned, "worker-a"]], `round ${round}: identity unchanged`);
		assert.equal(masterClaim(), pinned, `round ${round}: master claim unchanged`);
		assert.equal(fs.existsSync(path.join(root, `${stablePeerId("worker-b")}.lock`)), false, "no lock for the ignored session");
	}
	// The pinned session still refreshes and operates normally.
	await emit("turn_end", a.ctx);
	assert.equal(masterClaim(), pinned);

	// session_switch from the pinned manager is the logical-switch signal: old master claim released, new identity published.
	a.manager.id = "worker-a2";
	await emit("session_switch", a.ctx);
	await until(() => registry().length === 1 && registry()[0]!.sessionId === "worker-a2");
	assert.equal(masterClaim(), undefined, "old logical session's master claim is released on switch");
	assert.notEqual(registry()[0]!.id, pinned);

	// (b) Repeated rebinds must not accumulate exit listeners.
	for (let n = 0; n < 15; n++) {
		a.manager.id = n % 2 ? "worker-a2" : "worker-a3";
		await emit("session_switch", a.ctx);
		await until(() => registry().length === 1 && registry()[0]!.sessionId === a.manager.id);
	}
	assert.equal(process.listeners("exit").length, exitAfterStart, "rebinds register no further exit listeners");
	const visited = ["worker-a", "worker-a2", "worker-a3"].map(id => path.basename(stored(id))).sort();
	assert.deepEqual(files(saved, /\.json$/), visited, "switching default sessions persists only their run records");
	assert.deepEqual(JSON.parse(fs.readFileSync(stored("worker-a2"), "utf8")), record("worker-a2", { clean: true }), "a session left by a switch is recorded as exited cleanly");
	assert.deepEqual(JSON.parse(fs.readFileSync(stored("worker-a3"), "utf8")), record("worker-a3"), "the running session is not clean");

	// (c) Non-default state persists, survives a switch round trip, and never touches other ids.
	a.manager.id = "worker-a";
	await emit("session_switch", a.ctx);
	await until(() => registry()[0]?.sessionId === "worker-a");
	sessionName = "frontend-worker";
	await emit("turn_end", a.ctx);
	assert.deepEqual(JSON.parse(fs.readFileSync(stored("worker-a"), "utf8")),
		record("worker-a", { name: "frontend-worker" }));
	assert.equal(fs.statSync(stored("worker-a")).mode & 0o777, 0o600);
	sessionName = "";
	a.manager.id = "worker-a2";
	await emit("session_switch", a.ctx);
	await until(() => registry()[0]?.sessionId === "worker-a2");
	assert.deepEqual(files(saved, /\.json$/), visited, "every visited session has a run record, and no other id is touched");
	assert.match(await command("master --restore", a.ctx), /Restore on resume enabled/);
	assert.equal(JSON.parse(fs.readFileSync(stored("worker-a2"), "utf8")).restoreMaster, true);
	assert.match(await command("release", a.ctx), /restore on resume disabled/);
	assert.equal(JSON.parse(fs.readFileSync(stored("worker-a2"), "utf8")).restoreMaster, false, "an existing file records the release");
	assert.match(await command("pin", a.ctx), /routing policy: keep/);

	// A session_switch from another manager is ignored too, even when that manager's session id changed.
	b.manager.id = "worker-b2";
	await emit("session_switch", b.ctx);
	await emit("turn_end", b.ctx);
	assert.deepEqual(registry().map(p => p.sessionId), ["worker-a2"], "foreign session_switch must not re-pin");
	assert.equal(fs.existsSync(path.join(root, `${stablePeerId("worker-b2")}.lock`)), false);
	b.manager.id = "worker-b";

	// Collision safety: a stored file for another session id is left byte-for-byte alone.
	const foreign = stored("worker-collision");
	const body = JSON.stringify({ sessionId: "someone-else", name: "keep me", restoreMaster: true, routingPolicy: "auto" });
	fs.writeFileSync(foreign, body, { mode: 0o600 });
	a.manager.id = "worker-collision";
	await emit("session_switch", a.ctx);
	await command("list", a.ctx);
	assert.equal(fs.readFileSync(foreign, "utf8"), body);
	assert.match(notices.at(-1)!, /identity collision/);
	assert.deepEqual(registry(), [], "a colliding identity publishes nothing");

	console.log("PASS lifecycle: pinned process identity, single exit listener, minimal session metadata");
} finally {
	await emit("session_shutdown", a.ctx);
	await emit("session_shutdown", a.ctx);
}
