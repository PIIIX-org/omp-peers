// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
// Run only through test_routing.py: extension globals must use a disposable HOME.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "bun:test";
import * as z from "@oh-my-pi/omptype/zod";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgTaskAgentModelOverrides } from "@oh-my-pi/pi-coding-agent/task/settings";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import peers from "../extensions/peers";

test("pinned routing through the extension, socket, tools and host callbacks", async () => {
	assert.equal(process.env.OMP_PEERS_ROUTING_TEST, "isolated", "Use npm run test:routing (disposable HOME)");
	const root = path.join(os.homedir(), ".omp/run/peers");
	const settings = Settings.isolated({ modelRoles: { default: "offline/second:high", smol: "offline/second", slow: "offline/second" } });
	const hooks = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
	const tools = new Map<string, ToolDefinition>();
	let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
	const notices: string[] = [], prompts: string[] = [], visible: Array<{ content: string; display: boolean }> = [];
	let sessionId = "routing-worker", busy = false, effort = "high", switches = 0, effortChanges = 0;
	const first = { provider: "offline", id: "first", identity: { class: "unknown" } }, second = { provider: "offline", id: "second", identity: { class: "unknown" } };
	let selected = first;
	const resolve = (spec: string) => {
		const base = spec.replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "");
		return base === "offline/first" ? first : base === "offline/second" || base.startsWith("@") ? second : undefined;
	};
	let credentials = true;
	const ctx = {
		agent: { kind: "main" }, mode: "rpc", cwd: os.homedir(),
		sessionManager: { getSessionId: () => sessionId },
		get model() { return selected; },
		models: { current: () => selected, resolve, list: () => [first, second] },
		modelRegistry: { getApiKey: async () => credentials ? "offline-test" : undefined },
		isIdle: () => !busy,
		ui: { setStatus() {}, notify(text: string) { notices.push(text); } },
		setInterval() {}, clearTimer() {},
	} as unknown as ExtensionContext;
	const api = {
		zod: z, pi: { settings }, setLabel() {}, getSessionName: () => "Routing worker",
		getThinkingLevel: () => effort,
		setThinkingLevel(value: string) { effort = value; effortChanges++; },
		async setModel(model: typeof first) {
			if (!credentials) return false;
			selected = model; effort = "off"; switches++; return true;
		},
		on(name: string, handler: (event: unknown, context: ExtensionContext) => Promise<unknown>) { hooks.set(name, handler); },
		registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
		registerCommand(_name: string, definition: { handler: typeof command }) { command = definition.handler; },
		sendUserMessage(text: string) { prompts.push(text); },
		sendMessage(message: typeof visible[number], options: { triggerTurn: boolean }) {
			assert.equal(options.triggerTurn, false); visible.push(message);
		},
	} as unknown as ExtensionAPI;
	const emit = (name: string, event: unknown = { type: name }) => hooks.get(name)!(event, ctx);
	const rows = () => fs.readdirSync(root).filter(f => /^p[0-9a-f]{16}\.json$/.test(f))
		.map(f => JSON.parse(fs.readFileSync(path.join(root, f), "utf8")));
	const worker = () => rows().find(row => row.sessionId === sessionId)!;
	const master = "p1111111111111111";
	async function rpc(req: Record<string, unknown>) {
		const socket = net.createConnection(worker().sock);
		let buffer = "";
		const reply = Promise.withResolvers<Record<string, unknown>>();
		socket.on("error", reply.reject);
		socket.on("connect", () => socket.write(JSON.stringify({ from: { id: master }, ...req }) + "\n"));
		socket.on("data", data => {
			buffer += data;
			if (buffer.includes("\n")) reply.resolve(JSON.parse(buffer.split("\n")[0]));
		});
		try { return await reply.promise; } finally { socket.destroy(); }
	}
	async function emitReady(name: string) {
		const published = Promise.withResolvers<void>();
		const watcher = fs.watch(root, () => { if (worker()) published.resolve(); });
		try {
			await emit(name);
			if (worker()) published.resolve();
			await published.promise;
		} finally { watcher.close(); }
	}
	const request = { op: "prompt", text: "offline task", tier: "light", model: "offline/second", effort: "minimal" };
	const snapshot = () => ({ selected, effort, switches, effortChanges, prompts: prompts.length, visible: visible.length });
	try {
		peers(api);
		fs.mkdirSync(root, { recursive: true });
		await emitReady("session_start");
		fs.writeFileSync(path.join(root, `${master}.json`), JSON.stringify({ id: master, pid: process.pid }));
		fs.writeFileSync(path.join(root, "master.json"), JSON.stringify({ id: master, pid: process.pid }));
		let result = await rpc(request);
		assert.equal(result.ok, true); assert.match(String(result.routed), /session pin/);
		assert.equal(selected, first); assert.equal(effort, "high"); assert.equal(switches, 0);
		assert.equal(prompts.length, 1); assert.equal(worker().routingPolicy, "keep");
		const pinned = snapshot();
		result = await rpc({ ...request, overridePin: true, from: { id: "not-master" } });
		assert.equal(result.ok, false); assert.match(String(result.error), /not the master/); assert.deepEqual(snapshot(), pinned);
		await command("lock", ctx);
		assert.equal((await rpc({ ...request, overridePin: true })).ok, false); assert.deepEqual(snapshot(), pinned);
		await command("unlock", ctx);
		result = await rpc({ ...request, overridePin: true });
		assert.equal(result.ok, true); assert.match(String(result.routed), /offline\/first -> offline\/second/);
		assert.match(String(result.routed), /effort high -> minimal.*explicit master override/);
		assert.equal(notices.at(-1), `[peers routing] ${result.routed}`);
		assert.equal(visible.at(-1)?.content, notices.at(-1)); assert.equal(visible.at(-1)?.display, true);
		assert.equal(worker().routingPolicy, "keep");
		const changed = snapshot();
		for (const model of ["nonexistent/model", "offline/first:typo", "offline/first"]) {
			credentials = model !== "offline/first";
			result = await rpc({ ...request, model, effort: "max", overridePin: true });
			assert.equal(result.ok, false); assert.match(String(result.error), /unavailable model|no credentials/);
			assert.deepEqual(snapshot(), changed);
		}
		credentials = true;
		assert.equal((await rpc({ ...request, effort: "invalid", overridePin: true })).ok, false);
		assert.deepEqual(snapshot(), changed);
		assert.equal((await rpc({ ...request, tier: "keep", overridePin: true })).ok, false);
		assert.deepEqual(snapshot(), changed);
		await command("unpin", ctx);
		assert.equal(worker().routingPolicy, "auto");
		result = await rpc({ ...request, tier: "keep" }); assert.match(String(result.routed), /explicit keep/);
		assert.equal(switches, changed.switches);
		result = await rpc({ ...request, model: "nonexistent/model" });
		assert.equal(result.ok, false); assert.equal(prompts.length, changed.prompts + 1); assert.equal(effort, changed.effort);
		busy = true;
		result = await rpc(request); assert.equal(result.ok, true); assert.equal(result.queued, true);
		assert.match(String(result.routed), /automatic routing skipped: peer busy/);
		const queued = snapshot();
		for (const req of [{ ...request, overridePin: true }, { op: "model", text: "offline/first" }, { op: "effort", text: "max" }]) {
			result = await rpc(req); assert.equal(result.ok, false); assert.match(String(result.error), /peer busy/);
			assert.deepEqual(snapshot(), queued);
		}
		busy = false;
		result = await rpc({ ...request, model: "offline/first", reason: "short task" });
		assert.equal(result.ok, true); assert.match(String(result.routed), /offline\/second -> offline\/first.*automatic tier light \(short task\)/);
		assert.equal(effort, "minimal"); assert.equal(worker().routingPolicy, "auto");
		await rpc({ op: "model", text: "offline/second" }); assert.equal(effort, "minimal"); assert.equal(worker().routingPolicy, "keep");
		result = await rpc({ op: "effort", text: "high" }); assert.match(String(result.routed), /effort minimal -> high/);
		await command("unpin", ctx);
		const originalId = sessionId;
		sessionId = "different-routing-session"; await emitReady("session_switch");
		assert.equal(worker().routingPolicy, "keep");
		sessionId = originalId; await emitReady("session_switch");
		assert.equal(worker().routingPolicy, "auto");
		await command("pin", ctx);
		// Supported operator setting is stronger than a manual peer override or tiering.
		const spawn = () => emit("before_subagent_spawn", { type: "before_subagent_spawn", agent: "task", invocationKind: "task", patterns: ["offline/first:high"] }) as Promise<{ model?: string; note?: string; block?: boolean; reason?: string } | undefined>;
		await rpc({ op: "subagents", text: "task=offline/second:low" });
		cfgTaskAgentModelOverrides.override(settings, { task: "offline/first:high" });
		assert.equal(await spawn(), undefined);
		cfgTaskAgentModelOverrides.override(settings, {});
		let sub = await spawn(); assert.equal(sub?.model, "offline/second:low");
		assert.match(sub?.note ?? "", /offline\/first:high -> offline\/second:low.*explicit peer subagent override/);
		await rpc({ op: "subagents", text: "task=@default" });
		sub = await spawn(); assert.equal(sub?.model, "offline/second:high");
		await rpc({ op: "subagents", text: "task=nonexistent/model" });
		sub = await spawn(); assert.equal(sub?.block, true); assert.match(sub?.reason ?? "", /unavailable model/);
		await rpc({ op: "subagents", text: "task=offline/second" }); credentials = false;
		sub = await spawn(); assert.equal(sub?.block, true); credentials = true;
		await rpc({ op: "subagents", text: "clear" });
		sub = await spawn(); assert.equal(sub?.model, "offline/second:medium"); assert.match(sub?.note ?? "", /automatic tier standard/);
		cfgTaskAgentModelOverrides.override(settings, { task: "offline/first:high" });
		assert.equal(await spawn(), undefined);
		cfgTaskAgentModelOverrides.override(settings, {});
		assert.equal(await emit("before_subagent_spawn", { agent: "seance", invocationKind: "task", patterns: [] }), undefined);
		await rpc({ op: "subagents", text: "auto-off" }); assert.equal(await spawn(), undefined);
		// The public sender tool still refuses a non-master, including explicit override requests.
		await command("master", ctx); // Existing master is alive, so sender cannot seize authorization.
		const tool = tools.get("peers_control")!;
		const denied = await tool.execute("denied", { action: "prompt", to: "all", tier: "light", overridePin: true, text: "task" }, undefined, undefined, ctx);
		assert.equal(denied.isError, true);
		console.log("PASS offline pinned routing, explicit reports, unavailable atomicity, busy behavior and operator task pins");
	} finally {
		await emit("session_shutdown");
		cfgTaskAgentModelOverrides.clearOverride(settings);
	}
}, 20000);
