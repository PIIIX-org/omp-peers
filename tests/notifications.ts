// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
// Consumer-level extension exercise: local sockets and host callbacks, no provider.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as z from "@oh-my-pi/omptype/zod";
import peers from "../extensions/peers";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";

const root = path.join(os.homedir(), ".omp/run/peers");
const hooks = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<unknown>>>();
const tools = new Map<string, ToolDefinition>();
const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
const notices: string[] = [];
const inbound: unknown[] = [];
let sessionId = "routing-worker";
const ctx = {
	agent: { kind: "main" }, mode: "rpc", cwd: os.homedir(),
	sessionManager: { getSessionId: () => sessionId },
	isIdle: () => true,
	ui: { setStatus() {}, notify(text: string) { notices.push(text); } },
	setInterval() { return undefined; }, clearTimer() {},
} as unknown as ExtensionContext;
const api = {
	zod: z, setLabel() {}, getSessionName: () => "Routing worker", getThinkingLevel: () => "off",
	on(name: string, fn: (event: unknown, context: ExtensionContext) => Promise<unknown>) {
		hooks.set(name, [...(hooks.get(name) ?? []), fn]);
	},
	registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
	registerCommand(name: string, command: { handler: (args: string, context: ExtensionContext) => Promise<void> }) {
		commands.set(name, command.handler);
	},
	sendMessage(message: unknown) { inbound.push(message); },
} as unknown as ExtensionAPI;

async function emit(name: string, context = ctx): Promise<void> {
	for (const fn of hooks.get(name) ?? []) await fn({ type: name }, context);
}
async function until(predicate: () => boolean): Promise<void> {
	for (let n = 0; n < 200; n++) {
		if (predicate()) return;
		await delay(5);
	}
	throw new Error("Timed out waiting for isolated peer");
}
function journal(): Array<Record<string, unknown>> {
	const directory = path.join(root, "notifications");
	if (!fs.existsSync(directory)) return [];
	return fs.readdirSync(directory).flatMap(file => fs.readFileSync(path.join(directory, file), "utf8")
		.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
}
const received: Array<Record<string, unknown>> = [];
let response: Record<string, unknown> | undefined;
let duringDelivery: (() => Promise<void> | void) | undefined;
const servers: net.Server[] = [];
function claim(id: string, sid: string): void {
	fs.writeFileSync(path.join(root, "master.json"), JSON.stringify({ id, pid: process.pid }));
	assert.equal(JSON.parse(fs.readFileSync(path.join(root, `${id}.json`), "utf8")).sessionId, sid);
}
async function remote(id: string, sid: string): Promise<void> {
	const socket = path.join(root, `${id}.sock`);
	const server = net.createServer(conn => {
		let buffer = "";
		conn.on("data", async data => {
			buffer += data;
			if (!buffer.includes("\n")) return;
			received.push(JSON.parse(buffer.split("\n")[0]));
			const action = duringDelivery;
			duringDelivery = undefined;
			await action?.();
			conn.end(JSON.stringify(response ?? { ok: true, peerId: id, sessionId: sid }) + "\n");
		});
	});
	servers.push(server);
	const listening = Promise.withResolvers<void>();
	server.listen(socket, listening.resolve);
	await listening.promise;
	fs.writeFileSync(path.join(root, `${id}.json`), JSON.stringify({ id, sessionId: sid,
		pid: process.pid, sock: socket, name: id, startedAt: "start", updatedAt: "now", busy: false }));
}
async function send(to: string, text: string, report?: string, context = ctx): Promise<void> {
	const tool = tools.get("peers_send")!;
	const result = await tool.execute("send", { to, text, ...(report ? { report } : {}) }, undefined, undefined, context);
	assert(result.content.length > 0);
}
const master = "p1111111111111111", other = "p2222222222222222";
try {
	peers(api);
	await emit("session_start");
	await until(() => fs.readdirSync(root).some(file => /^p[0-9a-f]{16}\.json$/.test(file)));
	await remote(master, "master-session");
	await remote(other, "other-session");
	claim(master, "master-session");
	const workerFile = fs.readdirSync(root).find(file => /^p[0-9a-f]{16}\.json$/.test(file) && !file.startsWith(master) && !file.startsWith(other))!;
	const worker = JSON.parse(fs.readFileSync(path.join(root, workerFile), "utf8"));
	// Exercise the receiver's actual message route and identity acknowledgement.
	const acknowledgement = Promise.withResolvers<Record<string, unknown>>();
	const socket = net.createConnection(worker.sock);
	socket.on("connect", () => socket.write(JSON.stringify({ op: "message", text: "incoming report", from: { id: master, name: "Master" } }) + "\n"));
	socket.on("data", data => { acknowledgement.resolve(JSON.parse(data.toString())); socket.destroy(); });
	const ack = await acknowledgement.promise;
	assert.equal(ack.sessionId, sessionId);
	assert.equal(ack.peerId, worker.id);
	assert.equal(inbound.length, 1);

	for (const kind of ["DONE", "BLOCKED", "WAITING", "DECISION"]) {
		await emit("agent_start");
		await send(master, `${kind} private body`, kind);
		await emit("agent_end");
	}
	assert.equal(journal().filter(row => row.type === "report").length, 4);
	assert.equal(new Set(journal().filter(row => row.type === "report").map(row => row.turnId)).size, 4);
	assert(received.slice(0, 4).every((row, n) => row.text === ["DONE", "BLOCKED", "WAITING", "DECISION"][n] + " private body"));
	await emit("agent_start");
	await send(master, "DONE is just ordinary chatter");
	await send(other, "report to unrelated recipient", "DONE");
	response = { ok: false, error: "refused" };
	await send(master, "failed report", "BLOCKED");
	response = { ok: true, peerId: master, sessionId: "wrong-session" };
	await send(master, "stale destination report", "DONE");
	response = { ok: true }; // Old receivers cannot establish the actual destination.
	await send(master, "legacy acknowledgement", "WAITING");
	response = undefined;
	const child = { ...ctx, agent: { kind: "subagent" } } as unknown as ExtensionContext;
	await send(master, "child report is not the main turn", "DONE", child);
	duringDelivery = () => claim(other, "other-session");
	await send(master, "master changed while delivering", "DECISION");
	claim(master, "master-session");
	duringDelivery = () => claim(other, "other-session");
	await send(other, "unrelated recipient becomes master mid-delivery", "DONE");
	claim(master, "master-session");
	await emit("agent_end");
	assert.equal(journal().filter(row => row.type === "report").length, 4);
	// All reports still went through the ordinary message route, including failures.
	assert.equal(received.length, 12);

	await emit("agent_start");
	const oldTurn = JSON.parse(fs.readFileSync(path.join(root, workerFile), "utf8")).notificationTurnId;
	duringDelivery = async () => { await emit("agent_end"); await emit("agent_start"); };
	await send(master, "late acknowledgement belongs to the sending turn", "DONE");
	await emit("agent_end");
	assert.equal(journal().filter(row => row.type === "report").at(-1)!.turnId, oldTurn);
	await commands.get("peers")!(`report ${master} DECISION operator report outside turn`, ctx);
	assert(notices.at(-1)?.includes("ok"));
	assert.equal(journal().filter(row => row.type === "report").length, 5);
	assert.equal(received.at(-1)!.text, "operator report outside turn");
	// A logical session switch cannot inherit the previous session's turn.
	sessionId = "another-logical-session";
	await emit("session_switch");
	await emit("agent_start");
	await send(master, "new logical session report", "WAITING");
	await emit("agent_end");
	assert.equal(journal().filter(row => row.type === "report").at(-1)!.sessionId, sessionId);
	await emit("agent_start");
	await commands.get("peers")!(`report ${master} BLOCKED operator report in active turn`, ctx);
	await emit("agent_end");
	assert.equal(journal().filter(row => row.type === "report").at(-1)!.report, "BLOCKED");
	assert.equal(received.at(-1)!.text, "operator report in active turn");
	await emit("agent_start");
	for (const kind of ["DONE", "BLOCKED", "WAITING", "DECISION"]) {
		await send(master, `same-turn ${kind}`, kind);
	}
	await emit("agent_end");
	assert.equal(new Set(journal().filter(row => row.type === "report").slice(-4).map(row => row.turnId)).size, 1);
	assert.deepEqual(received.slice(-4).map(row => row.text), ["same-turn DONE", "same-turn BLOCKED", "same-turn WAITING", "same-turn DECISION"]);
	// Metadata I/O failure must not turn a successful report into a failed send.
	const directory = path.join(root, "notifications");
	const count = journal().filter(row => row.type === "report").length;
	fs.renameSync(directory, directory + ".saved");
	fs.writeFileSync(directory, "not a directory");
	try {
		await emit("agent_start");
		await send(master, "report despite unavailable metadata", "DECISION");
		await emit("agent_end");
		assert.equal(received.at(-1)!.text, "report despite unavailable metadata");
		const current = fs.readdirSync(root).filter(file => /^p[0-9a-f]{16}\.json$/.test(file))
			.map(file => JSON.parse(fs.readFileSync(path.join(root, file), "utf8")))
			.find(peer => peer.sessionId === sessionId);
		assert.equal(current.notificationVersion, undefined, "journal failure must restore legacy lifecycle fallback");
	} finally {
		fs.rmSync(directory);
		fs.renameSync(directory + ".saved", directory);
	}
	assert.equal(journal().filter(row => row.type === "report").length, count);
	await emit("agent_start");
	await emit("agent_end");
	assert(!JSON.stringify(journal()).includes("private body"));
	for (const file of fs.readdirSync(path.join(root, "notifications"))) {
		assert.equal(fs.statSync(path.join(root, "notifications", file)).mode & 0o777, 0o600);
	}
	console.log("PASS offline notification routing: immediate reports, successful exact-turn receipts, destination and session isolation");
} finally {
	await emit("session_shutdown");
	await Promise.all(servers.map(server => {
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		return closed.promise;
	}));
}
