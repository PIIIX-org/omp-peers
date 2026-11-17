// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
// Consumer-level exercise of the resume policy through the real extension, run in a disposable HOME (see test_notifications.py):
// the restart rule (a simulated blackout leaves `clean: false` behind), the managed-turn marker, and the receiver's resume op over the socket.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as z from "@oh-my-pi/omptype/zod";
import peers from "../extensions/peers";
import { stablePeerId } from "../lib/identity";
import { FileLock } from "@oh-my-pi/pi-natives";
import { RESTART_REASON, RESUME_REFUSED, SUBAGENT_RESUME_ERROR, pauseFile, pauseSession, readPause } from "../lib/features/pause";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";

const home = os.homedir();
const root = path.join(home, ".omp/run/peers");
const savedDir = path.join(home, ".omp/agent/peer-sessions");
const auditFile = path.join(home, ".omp/agent/peer-state/audit.jsonl");
const hooks = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<unknown>>>();
const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
const tools = new Map<string, ToolDefinition>();
const notices: string[] = [];
const sent: string[] = [];
let idle = true;

const manager = { id: "", getSessionId() { return this.id; } };
const ctxFor = (kind: string) => ({
	agent: { kind }, mode: "rpc", cwd: home, sessionManager: manager,
	models: { current: () => undefined }, isIdle: () => idle,
	ui: { setStatus() {}, notify(text: string) { notices.push(text); } },
	setInterval() { return undefined; }, clearTimer() {}, setTimeout() { return undefined; }, shutdown() {},
}) as unknown as ExtensionContext;
const ctx = ctxFor("main");
const api = {
	zod: z, setLabel() {}, getSessionName: () => "", getThinkingLevel: () => "off",
	on(name: string, fn: (event: unknown, context: ExtensionContext) => Promise<unknown>) { hooks.set(name, [...(hooks.get(name) ?? []), fn]); },
	registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
	registerCommand(name: string, command: { handler: (args: string, context: ExtensionContext) => Promise<void> }) { commands.set(name, command.handler); },
	sendMessage(message: { content: string }) { sent.push(message.content); },
	sendUserMessage(text: string) { sent.push(text); },
} as unknown as ExtensionAPI;

async function emit(name: string): Promise<void> {
	const event = name === "turn_end" ? { type: name, message: { role: "assistant", stopReason: "stop" } } : { type: name };
	for (const fn of hooks.get(name) ?? []) await fn(event, ctx);
}
async function command(args: string): Promise<string> {
	await commands.get("peers")!(args, ctx);
	return notices.at(-1) ?? "";
}
async function until(predicate: () => boolean): Promise<void> {
	for (let n = 0; n < 600; n++) {
		if (predicate()) return;
		await delay(5);
	}
	throw new Error("Timed out waiting for the isolated peer");
}

const rows = () => (fs.existsSync(root) ? fs.readdirSync(root) : []).filter(f => /^p[0-9a-f]{16}\.json$/.test(f))
	.map(f => JSON.parse(fs.readFileSync(path.join(root, f), "utf8")) as { id: string; sessionId: string; sock: string; paused?: boolean; pausedBy?: string });
const row = (sessionId: string) => rows().find(r => r.sessionId === sessionId);
const savedFile = (sessionId: string) => path.join(savedDir, `${stablePeerId(sessionId)}.json`);
const saved = (sessionId: string) => JSON.parse(fs.readFileSync(savedFile(sessionId), "utf8")) as Record<string, unknown>;
const view = (sessionId: string) => readPause(home, stablePeerId(sessionId));

/** What an earlier process left behind: the record a kill -9 (clean: false) or a normal exit (clean: true) leaves. */
function leave(sessionId: string, record: Record<string, unknown>): void {
	fs.mkdirSync(savedDir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(savedFile(sessionId), JSON.stringify({ sessionId, name: "", restoreMaster: false, routingPolicy: "keep", ...record }), { mode: 0o600 });
}
async function switchTo(sessionId: string): Promise<void> {
	manager.id = sessionId;
	await emit("session_switch");
	await until(() => row(sessionId) !== undefined);
}

const MASTER = "p1111111111111111";
const STRANGER = "p2222222222222222";
async function rpc(sessionId: string, req: Record<string, unknown>): Promise<Record<string, unknown>> {
	const socket = net.createConnection(row(sessionId)!.sock);
	let buffer = "";
	const reply = Promise.withResolvers<Record<string, unknown>>();
	socket.on("error", reply.reject);
	socket.on("connect", () => socket.write(`${JSON.stringify({ from: { id: MASTER, name: "boss" }, ...req })}\n`));
	socket.on("data", data => {
		buffer += data;
		if (buffer.includes("\n")) reply.resolve(JSON.parse(buffer.split("\n")[0]));
	});
	try {
		return await reply.promise;
	} finally {
		socket.destroy();
	}
}
const auditRecords = () => (fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>) : []);

try {
	peers(api);
	fs.mkdirSync(root, { recursive: true });
	// A live master claim (this process's pid), as routing.test.ts does.
	fs.writeFileSync(path.join(root, `${MASTER}.json`), JSON.stringify({ id: MASTER, pid: process.pid }));
	fs.writeFileSync(path.join(root, "master.json"), JSON.stringify({ id: MASTER, pid: process.pid }));

	// ---- Restart rule: the first session starts after a simulated blackout while idle --------------------
	leave("ses-idle", { clean: false, managed: false });
	manager.id = "ses-idle";
	await emit("session_start");
	await until(() => row("ses-idle") !== undefined);
	assert.deepEqual(view("ses-idle"), { paused: true, since: view("ses-idle").since, by: "restart", reason: "not working for the master before the restart" });
	assert.equal(RESTART_REASON, "not working for the master before the restart");
	// The pause exists before the session is reachable: its first registry row already says so.
	assert.equal(row("ses-idle")!.paused, true);
	assert.equal(row("ses-idle")!.pausedBy, "restart");
	assert.ok(notices.some(n => n.includes("was paused automatically") && n.includes(stablePeerId("ses-idle"))), notices.join("\n"));
	assert.deepEqual(saved("ses-idle"), { sessionId: "ses-idle", name: "", restoreMaster: false, routingPolicy: "keep", clean: false, managed: false });
	assert.equal(fs.statSync(pauseFile(home)).mode & 0o777, 0o600);
	assert.equal(fs.statSync(path.dirname(pauseFile(home))).mode & 0o777, 0o700);
	assert.equal(fs.statSync(savedFile("ses-idle")).mode & 0o777, 0o600);
	// A wake from anyone is refused, the master cannot clear it, only the user can.
	const woken = await rpc("ses-idle", { op: "message", text: "wake up", from: { id: STRANGER, name: "stranger" } });
	assert.deepEqual(woken, { ok: false, status: "deferred", paused: true, error: "session is paused" });
	assert.deepEqual(await rpc("ses-idle", { op: "prompt", text: "do it" }), { ok: false, status: "refused", paused: true, error: "session is paused" });
	assert.deepEqual(await rpc("ses-idle", { op: "resume" }), { ok: false, error: RESUME_REFUSED.restart });
	assert.equal(view("ses-idle").by, "restart");
	assert.deepEqual(sent, [], "nothing woke the restart-paused session");
	assert.match(await command("pause status"), /is paused since .* by the restart rule \(not working for the master before the restart\); resumable by only its user/);
	assert.match(await command("resume"), /\(it was paused by the restart rule\): wake-triggering messages and prompts are accepted again$/);
	assert.equal(view("ses-idle").paused, false);

	// ---- A session that was working under the master's management is left exactly as it was ---------------
	leave("ses-managed", { clean: false, managed: true });
	await switchTo("ses-managed");
	assert.equal(view("ses-managed").paused, false);
	assert.equal(row("ses-managed")!.paused, false);
	assert.deepEqual(saved("ses-managed"), { sessionId: "ses-managed", name: "", restoreMaster: false, routingPolicy: "keep", clean: false, managed: false });

	// ---- Clean exit, an older record, a brand-new session: unchanged ------------------------------------
	leave("ses-clean", { clean: true, managed: false });
	await switchTo("ses-clean");
	assert.equal(view("ses-clean").paused, false);
	leave("ses-legacy", {});
	await switchTo("ses-legacy");
	assert.equal(view("ses-legacy").paused, false);
	assert.equal(fs.existsSync(savedFile("ses-new")), false);
	await switchTo("ses-new");
	assert.equal(view("ses-new").paused, false);
	assert.equal(saved("ses-new").clean, false, "a running session records that it has not exited cleanly");
	// Switching away is a clean exit of the session; coming back to it is a normal reopen, not a blackout.
	await switchTo("ses-clean");
	assert.equal(saved("ses-new").clean, true);
	assert.equal(saved("ses-new").managed, false);
	await switchTo("ses-new");
	assert.equal(view("ses-new").paused, false);

	// ---- An existing pause keeps its provenance across a restart ------------------------------------------
	await pauseSession(home, stablePeerId("ses-prepaused"), "master", Date.now(), "held by the master");
	leave("ses-prepaused", { clean: false, managed: false });
	await switchTo("ses-prepaused");
	assert.equal(view("ses-prepaused").by, "master");
	assert.equal(view("ses-prepaused").reason, "held by the master");
	assert.deepEqual(await rpc("ses-prepaused", { op: "resume" }), { ok: true, paused: false, cleared: true });
	assert.equal(view("ses-prepaused").paused, false);

	// ---- Managed-turn marker: set by master work, saved at the turn, cleared when the run ends -------------
	await switchTo("ses-work");
	assert.equal(saved("ses-work").managed, false);
	assert.equal((await rpc("ses-work", { op: "message", text: "from a stranger", from: { id: STRANGER, name: "stranger" } })).ok, true);
	await emit("agent_start");
	assert.equal(saved("ses-work").managed, false, "a turn started by anyone but the master is not managed");
	await emit("agent_end");
	assert.equal((await rpc("ses-work", { op: "message", text: "from the master" })).ok, true);
	assert.equal(saved("ses-work").managed, false, "accepted but not started yet");
	await emit("agent_start");
	assert.equal(saved("ses-work").managed, true, "the master's message started this turn");
	assert.equal(saved("ses-work").clean, false);
	await emit("agent_end");
	assert.equal(saved("ses-work").managed, false);
	assert.equal((await rpc("ses-work", { op: "prompt", text: "a task", tier: "keep" })).ok, true);
	await emit("agent_start");
	assert.equal(saved("ses-work").managed, true, "a master prompt is managed work");
	// What a kill -9 right now would leave behind is a managed, unclean record: the next start leaves the session alone.
	const mid = saved("ses-work");
	await emit("agent_end");
	assert.equal(saved("ses-work").managed, false);
	// Provenance is fixed when the turn starts. A turn the user started stays unmanaged when a master message joins it ...
	await emit("agent_start");
	idle = false;
	assert.equal((await rpc("ses-work", { op: "message", text: "joins the user's running turn" })).ok, true);
	await emit("turn_end");
	assert.equal(saved("ses-work").managed, false, "a master message that joins a user-started turn does not make it managed");
	idle = true;
	await emit("agent_end");
	assert.equal(saved("ses-work").managed, false);
	// ... and a managed turn stays managed when other senders join it, until the run ends.
	assert.equal((await rpc("ses-work", { op: "prompt", text: "another task", tier: "keep" })).ok, true);
	await emit("agent_start");
	idle = false;
	assert.equal((await rpc("ses-work", { op: "message", text: "a stranger joins", from: { id: STRANGER, name: "stranger" } })).ok, true);
	await emit("turn_end");
	assert.equal(saved("ses-work").managed, true, "a managed turn stays managed when someone else's message joins it");
	idle = true;
	await emit("agent_end");
	assert.equal(saved("ses-work").managed, false);
	await switchTo("ses-managed");
	leave("ses-work", mid);
	await switchTo("ses-work");
	assert.equal(view("ses-work").paused, false);
	// The same session was idle when the blackout hit: paused by the restart rule.
	await switchTo("ses-managed");
	leave("ses-work", { ...mid, managed: false });
	await switchTo("ses-work");
	await until(() => view("ses-work").paused);
	assert.equal(view("ses-work").by, "restart");
	await command("resume");

	// ---- A failed restart-pause write keeps the session gated until it is recorded or the user resumes -------
	const stateDir = path.dirname(pauseFile(home));
	const stateBackup = `${stateDir}.bak`;
	const breakStateDir = () => {
		// A symlinked state directory: reads still work, every write is refused (privateDir refuses symlinks).
		fs.renameSync(stateDir, stateBackup);
		fs.symlinkSync(stateBackup, stateDir);
	};
	const repairStateDir = () => {
		fs.unlinkSync(stateDir);
		fs.renameSync(stateBackup, stateDir);
	};
	const warnings = (id: string) => notices.filter(n => n.includes(id) && n.includes("is treated as paused after a restart, but the pause could not be recorded")).length;
	breakStateDir();
	leave("ses-fail", { clean: false, managed: false });
	await switchTo("ses-fail");
	const failId = stablePeerId("ses-fail");
	assert.equal(view("ses-fail").paused, false, "nothing could be written");
	assert.equal(row("ses-fail")!.paused, true, "the registry row already says paused");
	assert.equal(row("ses-fail")!.pausedBy, "restart");
	await until(() => warnings(failId) === 1);
	assert.deepEqual(await rpc("ses-fail", { op: "message", text: "wake up", from: { id: STRANGER, name: "stranger" } }), { ok: false, status: "deferred", paused: true, error: "session is paused" });
	assert.deepEqual(await rpc("ses-fail", { op: "prompt", text: "do it" }), { ok: false, status: "refused", paused: true, error: "session is paused" });
	assert.deepEqual(await rpc("ses-fail", { op: "resume" }), { ok: false, error: RESUME_REFUSED.restart });
	assert.deepEqual(await rpc("ses-fail", { op: "pause", text: "x" }), { ok: true, paused: true }, "a master pause does not replace the pending restart pause");
	const sentBefore = sent.length;
	assert.match(await command("pause status"), /treated as paused by the restart rule .*could not be recorded yet/);
	await emit("turn_end");
	await emit("turn_end");
	await until(() => row("ses-fail")!.paused === true);
	assert.equal(warnings(failId), 1, "the same failure is warned about once, not on every retry");
	assert.equal(sent.length, sentBefore, "nothing woke the gated session");
	repairStateDir();
	await emit("turn_end"); // the next refresh retries the write
	await until(() => view("ses-fail").paused);
	assert.equal(view("ses-fail").by, "restart");
	assert.equal(view("ses-fail").reason, RESTART_REASON);
	assert.deepEqual(await rpc("ses-fail", { op: "resume" }), { ok: false, error: RESUME_REFUSED.restart }, "recorded: now refused by the stored provenance");
	assert.match(await command("resume"), /\(it was paused by the restart rule\)/);

	// The user can cancel a pause that cannot be recorded; a later repair then writes nothing.
	breakStateDir();
	leave("ses-fail2", { clean: false, managed: false });
	await switchTo("ses-fail2");
	await until(() => warnings(stablePeerId("ses-fail2")) === 1);
	assert.equal((await rpc("ses-fail2", { op: "message", text: "gated", from: { id: STRANGER, name: "stranger" } })).paused, true);
	assert.match(await command("resume"), /the restart pause could not be recorded and is cancelled/);
	assert.equal(row("ses-fail2")!.paused, false);
	assert.equal((await rpc("ses-fail2", { op: "message", text: "welcome back", from: { id: STRANGER, name: "stranger" } })).ok, true);
	repairStateDir();
	await emit("turn_end");
	await delay(50);
	assert.equal(view("ses-fail2").paused, false, "a cancelled restart pause is never written later");

	// ---- Receiver resume op ------------------------------------------------------------------------------
	await switchTo("ses-rcv");
	assert.deepEqual(await rpc("ses-rcv", { op: "resume" }), { ok: true, paused: false, cleared: false }, "not paused: nothing to clear");
	assert.deepEqual(await rpc("ses-rcv", { op: "pause", text: "hold" }), { ok: true, paused: true, pausedSince: new Date(view("ses-rcv").since!).toISOString() });
	assert.equal(view("ses-rcv").by, "master");
	assert.equal(row("ses-rcv")!.pausedBy, "master");
	// resume is not woken by the gate: a paused session still answers it.
	assert.deepEqual(await rpc("ses-rcv", { op: "resume" }), { ok: true, paused: false, cleared: true });
	assert.equal(view("ses-rcv").paused, false);
	assert.equal(row("ses-rcv")!.paused, false);

	// The user's own pause is never overridden by the master.
	assert.match(await command("pause my own reason"), /^paused /);
	assert.equal(view("ses-rcv").by, "user");
	assert.deepEqual(await rpc("ses-rcv", { op: "resume" }), { ok: false, error: RESUME_REFUSED.user });
	assert.equal(view("ses-rcv").by, "user");
	assert.match(await command("resume"), /\(it was paused by its user\)/);

	// A master pause the user later repeats becomes the user's.
	await rpc("ses-rcv", { op: "pause", text: "maintenance" });
	assert.match(await command("pause"), /was paused by the master and is now paused by its user/);
	assert.deepEqual(await rpc("ses-rcv", { op: "resume" }), { ok: false, error: RESUME_REFUSED.user });
	assert.deepEqual(await rpc("ses-rcv", { op: "pause", text: "ignored" }), { ok: true, paused: true, pausedSince: new Date(view("ses-rcv").since!).toISOString() });
	assert.equal(view("ses-rcv").by, "user", "a later master pause does not turn a user pause back into the master's");

	// Non-master senders, a subagent claim and a locked session are refused before anything is read.
	assert.deepEqual(await rpc("ses-rcv", { op: "resume", from: { id: STRANGER, name: "stranger" } }), { ok: false, error: "sender is not the master session" });
	assert.deepEqual(await rpc("ses-rcv", { op: "resume", from: { name: "nobody" } }), { ok: false, error: "sender is not the master session" });
	assert.deepEqual(await rpc("ses-rcv", { op: "resume", subagent: true }), { ok: false, error: SUBAGENT_RESUME_ERROR });
	await command("resume");
	await rpc("ses-rcv", { op: "pause" });
	assert.deepEqual(await rpc("ses-rcv", { op: "resume", subagent: true }), { ok: false, error: SUBAGENT_RESUME_ERROR }, "a master-paused session is not resumed on a subagent's behalf");
	assert.equal(view("ses-rcv").by, "master");
	assert.match(await command("lock"), /refused/);
	assert.deepEqual(await rpc("ses-rcv", { op: "resume" }), { ok: false, error: "peer is locked (control refused)" });
	assert.equal(view("ses-rcv").paused, true);
	await command("unlock");
	assert.deepEqual(await rpc("ses-rcv", { op: "resume" }), { ok: true, paused: false, cleared: true });

	// The audit log records the outcome like every other control op.
	assert.match(await command("audit on"), /audit log on/);
	await rpc("ses-rcv", { op: "pause" });
	await rpc("ses-rcv", { op: "resume" });
	await command("pause");
	await rpc("ses-rcv", { op: "resume" });
	await command("resume");
	const completed = auditRecords().filter(r => r.side === "receiver" && r.phase === "completed" && r.op === "resume");
	assert.deepEqual(completed.map(r => [r.outcome, r.reason, r.masterChecked]), [["ok", undefined, true], ["refused", "not-resumable", true]]);
	assert.equal(auditRecords().filter(r => r.side === "receiver" && r.phase === "attempted" && r.op === "resume").length, 2);
	assert.equal(JSON.stringify(auditRecords()).includes("only that user"), false, "refusal text is never stored");

	// ---- Authorization is re-read under the pause lock: a handoff or a lock during the wait is honoured -----
	await switchTo("ses-race");
	const resumeAttempts = () => auditRecords().filter(r => r.side === "receiver" && r.phase === "attempted" && r.op === "resume").length;
	const heldResume = async (during: () => Promise<void>): Promise<Record<string, unknown>> => {
		await rpc("ses-race", { op: "pause", text: "hold" });
		assert.equal(view("ses-race").by, "master");
		const attempts = resumeAttempts();
		const lock = FileLock.tryAcquire(`${pauseFile(home)}.lock`);
		assert.equal(lock.acquired, true);
		const pending = rpc("ses-race", { op: "resume" });
		await until(() => resumeAttempts() === attempts + 1);
		await delay(50); // the receiver has passed its first master check and is polling for the lock
		await during();
		lock.release();
		return pending;
	};
	const other = "p3333333333333333";
	fs.writeFileSync(path.join(root, `${other}.json`), JSON.stringify({ id: other, pid: process.pid }));
	const claim = (id: string) => fs.writeFileSync(path.join(root, "master.json"), JSON.stringify({ id, pid: process.pid }));
	assert.deepEqual(await heldResume(async () => claim(other)), { ok: false, error: "sender is not the master session" }, "the master claim moved while the resume waited");
	assert.equal(view("ses-race").by, "master");
	assert.equal(view("ses-race").paused, true);
	claim(MASTER);
	assert.deepEqual(await heldResume(async () => void (await command("lock"))), { ok: false, error: "peer is locked (control refused)" }, "control was locked while the resume waited");
	assert.equal(view("ses-race").paused, true);
	await command("unlock");
	assert.deepEqual(await rpc("ses-race", { op: "resume" }), { ok: true, paused: false, cleared: true });
	fs.rmSync(path.join(root, `${other}.json`));

	// ---- Tool: peers_control accepts resume, and a subagent cannot use it -------------------------------------
	fs.rmSync(path.join(root, "master.json"));
	fs.rmSync(path.join(root, `${MASTER}.json`));
	await switchTo("ses-master");
	assert.match(await command("master"), /now the master/);
	const control = tools.get("peers_control")!;
	assert.match(control.description, /resume \(clears a pause ONLY if the master paused that session itself/);
	const refused = await control.execute("id", { to: "ses-rcv", action: "resume" }, undefined, undefined, ctxFor("task"));
	assert.deepEqual(refused, { content: [{ type: "text", text: `error: ${SUBAGENT_RESUME_ERROR}` }], details: {}, isError: true });
	const none = await control.execute("id", { to: "no-such-session", action: "resume" }, undefined, undefined, ctx);
	assert.match(JSON.stringify(none), /no-such-session|no peer|not found|ambiguous|unknown/i);

	console.log("PASS restart rule and resume policy through the extension");
} finally {
	await emit("session_shutdown");
}
