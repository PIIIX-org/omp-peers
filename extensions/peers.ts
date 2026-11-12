// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

/**
 * peers — cross-session messaging + master-session control for omp.
 *
 * Every top-level omp process on this machine:
 *   - publishes ~/.omp/run/peers/<id>.json (registry) and listens on <id>.sock (Unix socket, 0600),
 *   - can message any other peer (`peers_send`, `/peers msg`),
 *   - can claim the single "master" role (`/peers master`); the master can prompt, abort, compact,
 *     re-model, rename, tail, and shut down every other peer (`peers_control`, `/peers do`, `/peers`).
 *
 * Trust boundary: same OS user (0700 dir, 0600 sockets). Control ops are accepted only when the
 * sender's id equals the id in ~/.omp/run/peers/master.json at request time. A peer can opt out with
 * `/peers refuse` (no inbound at all) or `/peers lock` (messages only, no control).
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type * as SettingsRegistry from "@oh-my-pi/pi-coding-agent/config/registry";

const ROOT = path.join(os.homedir(), ".omp", "run", "peers");
const MASTER_FILE = path.join(ROOT, "master.json");
const CONTROL_OPS = new Set(["prompt", "abort", "compact", "model", "effort", "subagents", "setting", "rename", "tail", "shutdown"]);
// Settings the master may never touch remotely (credentials, trust/approval/sandbox, transports).
const SETTING_DENY = /^(auth|secrets|collab|share|mcp|providers)\.|approval|token|apikey|api_key|password|credential|trust|sandbox|extension/i;
const MAX_LINE = 256 * 1024;
const RATE_LIMIT = 20; // inbound peer messages per minute per sender

// ---- Cost-aware routing -----------------------------------------------------------------------
// The master picks a model + reasoning effort per task *before* dispatching a prompt, so a typo fix
// does not run on the slow/high-effort model. Classification is a local heuristic (zero tokens).
// Tier models default to omp role aliases (@smol / @default / @slow); override in ~/.omp/agent/peers.json:
//   { "tiers": { "light": { "model": "anthropic/claude-haiku-4-5", "effort": "minimal" } } }
type Tier = "light" | "standard" | "heavy";
interface TierCfg {
	model: string;
	effort: string;
}
const TIERS: Tier[] = ["light", "standard", "heavy"];
const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const DEFAULT_TIERS: Record<Tier, TierCfg> = {
	light: { model: "@smol", effort: "minimal" },
	standard: { model: "@default", effort: "medium" },
	heavy: { model: "@slow", effort: "high" },
};
const HEAVY_RE =
	/\b(architect\w*|design|refactor\w*|migrat\w*|root.?cause|race condition|deadlock|security|vulnerab\w*|investigate|diagnos\w*|debug\w*|performance|optimi[sz]\w*|rewrite|multi.?file|concurren\w*|trade.?offs?)\b/i;
const LIGHT_RE =
	/\b(rename|typo|format|lint|list|summari[sz]e|status|commit message|run (the )?tests?|grep|find|what is|show|print|read|reply with|ack)\b/i;

// ---- Automatic subagent routing ------------------------------------------------------------------
// before_subagent_spawn carries the agent name but not its task text, so the tier comes from (1) the
// agent type for specialists and (2) the parent session's current task tier (classified from the
// prompt it is working on) for generic workers. Override per agent in peers.json: {"subagentTiers":{"task":"standard"}}
const DEFAULT_SUB_TIERS: Record<string, Tier> = { scout: "light", sonic: "light", reviewer: "standard", "security-reviewer": "heavy" };

function subTierFor(agent: string, kind: string): { tier: Tier; why: string } {
	const cfg = readJson<{ subagentTiers?: Record<string, string> }>(path.join(os.homedir(), ".omp", "agent", "peers.json"));
	const pinned = { ...DEFAULT_SUB_TIERS, ...(cfg?.subagentTiers ?? {}) }[agent];
	if (TIERS.includes(pinned as Tier)) return { tier: pinned as Tier, why: `agent "${agent}"` };
	if (kind === "eval") return { tier: "light", why: "eval helper" };
	return { tier: state.tier, why: `follows session task tier` };
}

/** "managed" (default): auto-route only while a master session exists and this peer allows control. */
function autoActive(): boolean {
	return state.subAuto === "on" || (state.subAuto === "managed" && state.control && masterId() !== undefined);
}

async function registry(): Promise<typeof SettingsRegistry | undefined> {
	try {
		// Dynamic on purpose: a host that cannot resolve this subpath must not stop the whole extension from loading.
		return await import("@oh-my-pi/pi-coding-agent/config/registry");
	} catch {
		return undefined;
	}
}

/** True when the operator pinned this agent in task.agentModelOverrides; that always wins. */
async function operatorPinned(pi: ExtensionAPI, agent: string): Promise<boolean> {
	const reg = await registry();
	const value = reg?.lookup("task.agentModelOverrides")?.get(pi.pi.settings);
	return typeof value === "object" && value !== null && agent in value;
}

function loadTiers(): Record<Tier, TierCfg> {
	const cfg = readJson<{ tiers?: Partial<Record<Tier, Partial<TierCfg>>> }>(path.join(os.homedir(), ".omp", "agent", "peers.json"));
	const out = { ...DEFAULT_TIERS };
	for (const t of TIERS) out[t] = { ...DEFAULT_TIERS[t], ...(cfg?.tiers?.[t] ?? {}) };
	return out;
}

function classify(text: string): { tier: Tier; reason: string } {
	const heavy = HEAVY_RE.exec(text);
	if (heavy) return { tier: "heavy", reason: `keyword "${heavy[0]}"` };
	if (text.length > 1500) return { tier: "heavy", reason: `long task (${text.length} chars)` };
	const light = LIGHT_RE.exec(text);
	if (light && text.length < 300) return { tier: "light", reason: `short, keyword "${light[0]}"` };
	return { tier: "standard", reason: "default" };
}

/** Pick model/effort for a prompt. `tier` overrides the heuristic; "keep" leaves the peer unchanged. */
function routeFor(text: string, tier?: string): { tier: string; reason: string; model?: string; effort?: string } {
	if (tier === "keep") return { tier: "keep", reason: "explicit" };
	const picked = TIERS.includes(tier as Tier) ? { tier: tier as Tier, reason: "explicit" } : classify(text);
	const cfg = loadTiers()[picked.tier];
	return { ...picked, model: cfg.model, effort: cfg.effort };
}

interface PeerInfo {
	id: string;
	pid: number;
	name: string;
	cwd: string;
	sessionId: string;
	model: string;
	effort: string;
	subagents: string;
	busy: boolean;
	context: string;
	sock: string;
	startedAt: string;
	updatedAt: string;
	inbound: "accept" | "refuse";
	control: boolean;
}
interface Req {
	op: string;
	from?: { id: string; name: string };
	text?: string;
	model?: string;
	effort?: string;
	tier?: string;
	key?: string;
	value?: unknown;
	n?: number;
}

// Module state is shared by every session bound in this process (subagents too), so it is
// strictly per-process: one server, one identity.
const state = {
	id: `p${randomBytes(3).toString("hex")}`,
	startedAt: new Date().toISOString(),
	server: undefined as net.Server | undefined,
	ctx: undefined as ExtensionContext | undefined,
	inbound: (process.env.OMP_PEERS_INBOUND === "refuse" ? "refuse" : "accept") as "accept" | "refuse",
	control: true,
	route: true,
	subModels: {} as Record<string, string>,
	subAuto: "managed" as "managed" | "on" | "off",
	tier: "standard" as Tier,
	forcedTier: undefined as Tier | undefined,
	timer: undefined as unknown,
	rate: new Map<string, number[]>(),
};
const sockPath = () => path.join(ROOT, `${state.id}.sock`);
const infoPath = (id: string) => path.join(ROOT, `${id}.json`);

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function writeJson(file: string, value: unknown): void {
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
	fs.renameSync(tmp, file);
}

function selfInfo(pi: ExtensionAPI): PeerInfo {
	const ctx = state.ctx;
	const usage = ctx?.getContextUsage?.() as { tokens?: number; percent?: number } | undefined;
	const model = ctx?.model as { provider?: string; id?: string } | undefined;
	return {
		id: state.id,
		pid: process.pid,
		name: pi.getSessionName() || path.basename(ctx?.cwd ?? process.cwd()),
		cwd: ctx?.cwd ?? process.cwd(),
		sessionId: ctx?.sessionManager.getSessionId() ?? "",
		model: model?.id ? `${model.provider ?? ""}/${model.id}` : "",
		effort: String(pi.getThinkingLevel() ?? ""),
		subagents: [
			`auto=${state.subAuto}${autoActive() ? "(active)" : ""} tier=${state.tier}`,
			...Object.entries(state.subModels).map(([a, m]) => `${a}=${m}`),
		].join(" "),
		busy: ctx ? !ctx.isIdle() : false,
		context: usage?.tokens != null ? `${usage.tokens}${usage.percent != null ? ` (${Math.round(usage.percent)}%)` : ""}` : "",
		sock: sockPath(),
		startedAt: state.startedAt,
		updatedAt: new Date().toISOString(),
		inbound: state.inbound,
		control: state.control,
	};
}

function publish(pi: ExtensionAPI): void {
	if (!state.server) return;
	try {
		writeJson(infoPath(state.id), selfInfo(pi));
	} catch {
		// registry write is best-effort; the socket still serves `status`
	}
}

function masterId(): string | undefined {
	const m = readJson<{ id: string; pid: number }>(MASTER_FILE);
	if (!m) return undefined;
	if (!alive(m.pid) || !fs.existsSync(infoPath(m.id))) {
		fs.rmSync(MASTER_FILE, { force: true });
		return undefined;
	}
	return m.id;
}

function listPeers(): PeerInfo[] {
	let files: string[] = [];
	try {
		files = fs.readdirSync(ROOT).filter(f => /^p[0-9a-f]{6}\.json$/.test(f));
	} catch {
		return [];
	}
	const out: PeerInfo[] = [];
	for (const f of files) {
		const info = readJson<PeerInfo>(path.join(ROOT, f));
		if (!info || typeof info.pid !== "number" || typeof info.sock !== "string") continue;
		if (!alive(info.pid)) {
			fs.rmSync(path.join(ROOT, f), { force: true });
			fs.rmSync(info.sock, { force: true });
			continue;
		}
		out.push(info);
	}
	return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function resolveTargets(spec: string): { peers: PeerInfo[]; error?: string } {
	const all = listPeers().filter(p => p.id !== state.id);
	if (spec === "all") return all.length ? { peers: all } : { peers: [], error: "no other peers" };
	const s = spec.toLowerCase();
	const exact = all.filter(p => p.id === s || p.name.toLowerCase() === s);
	if (exact.length === 1) return { peers: exact };
	const pool = exact.length ? exact : all.filter(p => p.id.startsWith(s) || p.name.toLowerCase().startsWith(s));
	if (pool.length === 1) return { peers: pool };
	if (pool.length === 0) return { peers: [], error: `no peer matches "${spec}"` };
	return { peers: [], error: `"${spec}" is ambiguous: ${pool.map(p => `${p.name} (${p.id})`).join(", ")}` };
}

function call(peer: PeerInfo, req: Req, timeoutMs = 10_000): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	let buf = "";
	let done = false;
	const finish = (v: Record<string, unknown>) => {
		if (done) return;
		done = true;
		clearTimeout(timer);
		sock.destroy();
		resolve(v);
	};
	const sock = net.createConnection(peer.sock);
	const timer = setTimeout(() => finish({ ok: false, error: "timeout" }), timeoutMs);
	sock.on("connect", () => sock.write(`${JSON.stringify(req)}\n`));
	sock.on("data", d => {
		buf += d.toString();
		if (buf.length > MAX_LINE) return finish({ ok: false, error: "response too large" });
		const nl = buf.indexOf("\n");
		if (nl >= 0) {
			try {
				finish(JSON.parse(buf.slice(0, nl)));
			} catch {
				finish({ ok: false, error: "bad response" });
			}
		}
	});
	sock.on("error", e => finish({ ok: false, error: `unreachable (${(e as NodeJS.ErrnoException).code ?? e.message})` }));
	sock.on("close", () => finish({ ok: false, error: "connection closed" }));
	return promise;
}

function messageText(entry: unknown): string {
	const m = (entry as { message?: { role?: string; content?: unknown } }).message;
	if (!m) return "";
	const c = m.content;
	const text = typeof c === "string" ? c : Array.isArray(c) ? c.map(b => (b?.type === "text" ? b.text : "")).join("") : "";
	return text.trim();
}

function rateOk(sender: string): boolean {
	const now = Date.now();
	const hits = (state.rate.get(sender) ?? []).filter(t => now - t < 60_000);
	if (hits.length >= RATE_LIMIT) return false;
	hits.push(now);
	state.rate.set(sender, hits);
	return true;
}

/** Apply the master's chosen model/effort on the receiving peer. Never switches mid-turn. */
async function applyRouting(pi: ExtensionAPI, ctx: ExtensionContext, req: Req): Promise<string> {
	if (!req.model && !req.effort) return "";
	if (!ctx.isIdle()) return "skipped (peer busy)";
	const done: string[] = [];
	if (req.model) {
		const m = ctx.models.resolve(req.model);
		const cur = ctx.model;
		if (!m) done.push(`model "${req.model}" unknown, kept`);
		else if (cur?.id === m.id && cur.provider === m.provider) done.push(`model=${m.provider}/${m.id} (unchanged)`);
		else done.push((await pi.setModel(m)) ? `model=${m.provider}/${m.id}` : `model ${m.id} has no credentials, kept`);
	}
	if (req.effort && EFFORTS.includes(req.effort)) {
		if (pi.getThinkingLevel() !== req.effort) pi.setThinkingLevel(req.effort as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
		done.push(`effort=${pi.getThinkingLevel()}`);
	}
	publish(pi);
	return done.join(", ");
}

/** Resolve a tier name (light|standard|heavy) to its configured model[:effort]; pass other specs through. */
function expandSpec(spec: string): string {
	const tier = TIERS.find(t => t === spec.trim().toLowerCase());
	if (!tier) return spec.trim();
	const cfg = loadTiers()[tier];
	return cfg.effort && cfg.effort !== "off" ? `${cfg.model}:${cfg.effort}` : cfg.model;
}

/** Master-driven read/write of any (non-denied) omp setting, as an in-memory runtime override. */
async function settingOp(pi: ExtensionAPI, req: Req): Promise<Record<string, unknown>> {
	const reg = await registry();
	if (!reg) return { ok: false, error: "settings registry unavailable" };
	const scope = pi.pi.settings;
	const mode = req.text || "get";
	if (mode === "list") {
		const prefix = req.key ?? "";
		const ids = reg.all().map(s => s.id as string).filter(id => id.startsWith(prefix) && !SETTING_DENY.test(id));
		return { ok: true, settings: ids.slice(0, 300) };
	}
	const key = req.key;
	if (!key) return { ok: false, error: "missing setting key" };
	if (SETTING_DENY.test(key)) return { ok: false, error: `setting "${key}" is protected and cannot be changed remotely` };
	const s = reg.lookup(key);
	if (!s) return { ok: false, error: `unknown setting "${key}"` };
	try {
		if (mode === "set") (s as { override(scope: unknown, v: unknown): void }).override(scope, req.value);
		else if (mode === "clear") s.clearOverride(scope);
		else if (mode !== "get") return { ok: false, error: `unknown setting mode "${mode}" (get|set|clear|list)` };
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
	return { ok: true, key, value: s.get(scope), provenance: s.provenance(scope) };
}

async function handle(pi: ExtensionAPI, req: Req): Promise<Record<string, unknown>> {
	const ctx = state.ctx;
	if (!ctx) return { ok: false, error: "session not ready" };
	if (state.inbound === "refuse") return { ok: false, error: "peer refuses inbound requests" };
	const text = typeof req.text === "string" ? req.text : "";
	if (CONTROL_OPS.has(req.op)) {
		if (!state.control) return { ok: false, error: "peer is locked (control refused)" };
		if (!req.from?.id || masterId() !== req.from.id) return { ok: false, error: "sender is not the master session" };
	}
	switch (req.op) {
		case "status":
			return { ok: true, info: selfInfo(pi) };
		case "message": {
			if (!text) return { ok: false, error: "empty message" };
			const from = req.from ?? { id: "?", name: "unknown" };
			if (!rateOk(from.id)) return { ok: false, error: "rate limited" };
			pi.sendMessage(
				{
					customType: "peer-message",
					content:
						`[Message from peer session "${from.name}" (${from.id}) — not from the user]\n${text}\n\n` +
						`(Reply with the peers_send tool only if this needs an answer or action; do not acknowledge for its own sake.)`,
					display: true,
					attribution: "agent",
				},
				{ deliverAs: "aside", triggerTurn: true },
			);
			ctx.ui.notify(`Message from ${from.name} (${from.id})`, "info");
			return { ok: true };
		}
		case "prompt": {
			if (!text) return { ok: false, error: "empty prompt" };
			if (req.tier && TIERS.includes(req.tier as Tier)) state.forcedTier = req.tier as Tier;
			const routed = await applyRouting(pi, ctx, req);
			pi.sendUserMessage(text, { deliverAs: "aside" });
			return { ok: true, queued: !ctx.isIdle(), routed };
		}
		case "abort":
			ctx.abort();
			return { ok: true };
		case "compact":
			void ctx.compact().catch(() => {});
			return { ok: true, started: true };
		case "rename":
			if (!text) return { ok: false, error: "empty name" };
			await pi.setSessionName(text);
			publish(pi);
			return { ok: true };
		case "subagents": {
			// text: "clear" | "<spec>" (all agents) | "agent=spec,agent2=spec2"; spec = model selector, @role, or light|standard|heavy
			if (text === "auto" || text === "auto-off" || text === "auto-managed") {
				state.subAuto = text === "auto" ? "on" : text === "auto-off" ? "off" : "managed";
				publish(pi);
				return { ok: true, routed: `subagent auto-routing: ${state.subAuto}${autoActive() ? " (active)" : ""}` };
			}
			if (!text || text === "clear") state.subModels = {};
			else {
				const next: Record<string, string> = {};
				for (const part of text.split(",")) {
					const eq = part.indexOf("=");
					const agent = eq < 0 ? "*" : part.slice(0, eq).trim();
					const spec = expandSpec(eq < 0 ? part : part.slice(eq + 1));
					if (agent && spec) next[agent] = spec;
				}
				state.subModels = next;
			}
			publish(pi);
			const cur = Object.entries(state.subModels).map(([a, m]) => `${a}=${m}`).join(", ");
			return { ok: true, routed: cur ? `subagents: ${cur}` : "subagent overrides cleared" };
		}
		case "setting":
			return settingOp(pi, req);
		case "effort": {
			if (!EFFORTS.includes(text)) return { ok: false, error: `effort must be one of ${EFFORTS.join(", ")}` };
			pi.setThinkingLevel(text as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
			publish(pi);
			return { ok: true, routed: `effort=${pi.getThinkingLevel()}` };
		}
		case "model": {
			const m = ctx.models.resolve(text);
			if (!m) return { ok: false, error: `unknown model "${text}"` };
			const ok = await pi.setModel(m);
			publish(pi);
			return ok ? { ok: true } : { ok: false, error: "no credentials for that model" };
		}
		case "tail": {
			const n = Math.max(1, Math.min(req.n ?? 6, 30));
			const rows = (ctx.sessionManager.getBranch() as Array<{ type?: string; message?: { role?: string } }>)
				.filter(e => e.type === "message")
				.slice(-n)
				.map(e => ({ role: e.message?.role ?? "?", text: messageText(e).slice(0, 2000) }))
				.filter(r => r.text);
			return { ok: true, entries: rows };
		}
		case "shutdown":
			ctx.setTimeout(() => ctx.shutdown(), 150);
			return { ok: true };
		default:
			return { ok: false, error: `unknown op "${req.op}"` };
	}
}

function startServer(pi: ExtensionAPI): void {
	if (state.server) return;
	fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
	fs.chmodSync(ROOT, 0o700);
	fs.rmSync(sockPath(), { force: true });
	const server = net.createServer(conn => {
		let buf = "";
		let handled = false;
		conn.on("error", () => conn.destroy());
		conn.on("data", d => {
			if (handled) return;
			buf += d.toString();
			if (buf.length > MAX_LINE) return conn.destroy();
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			handled = true;
			let req: Req;
			try {
				req = JSON.parse(buf.slice(0, nl));
			} catch {
				conn.end(`${JSON.stringify({ ok: false, error: "bad request" })}\n`);
				return;
			}
			handle(pi, req)
				.catch(e => ({ ok: false, error: String((e as Error)?.message ?? e) }))
				.then(res => conn.end(`${JSON.stringify(res)}\n`));
		});
	});
	server.on("error", () => {});
	server.listen(sockPath(), () => {
		try {
			fs.chmodSync(sockPath(), 0o600);
		} catch {}
		publish(pi);
	});
	server.unref();
	state.server = server;
	process.on("exit", teardown);
}

function teardown(): void {
	if (!state.server) return;
	state.server.close();
	state.server = undefined;
	fs.rmSync(sockPath(), { force: true });
	fs.rmSync(infoPath(state.id), { force: true });
	const m = readJson<{ id: string }>(MASTER_FILE);
	if (m?.id === state.id) fs.rmSync(MASTER_FILE, { force: true });
}

function fmt(p: PeerInfo, master: string | undefined): string {
	const flags = [p.id === master ? "★master" : "", p.id === state.id ? "this" : "", p.inbound === "refuse" ? "refuses" : p.control ? "" : "locked"]
		.filter(Boolean)
		.join(",");
	const home = os.homedir();
	const cwd = p.cwd.startsWith(home) ? `~${p.cwd.slice(home.length)}` : p.cwd;
	return `${p.id}  ${p.name}  ${p.busy ? "busy" : "idle"}  ${p.model || "-"}${p.effort ? `:${p.effort}` : ""}${p.subagents ? `  sub:${p.subagents}` : ""}  ctx:${p.context || "-"}  ${cwd}${flags ? `  [${flags}]` : ""}`;
}

function summarize(res: Record<string, unknown>): string {
	if (!res.ok) return `failed: ${String(res.error)}`;
	if (Array.isArray(res.entries)) {
		return (res.entries as Array<{ role: string; text: string }>).map(e => `${e.role}: ${e.text}`).join("\n---\n") || "(empty)";
	}
	if (res.info) return fmt(res.info as PeerInfo, masterId());
	if (Array.isArray(res.settings)) return (res.settings as string[]).join(", ") || "(none)";
	if ("key" in res && "value" in res) return `${String(res.key)} = ${JSON.stringify(res.value)} (${String(res.provenance)})`;
	return typeof res.routed === "string" && res.routed ? `ok (${res.routed})` : "ok";
}

export default function peers(pi: ExtensionAPI) {
	const z = pi.zod;
	pi.setLabel("Peers (cross-session messaging + master control)");

	const bind = (ctx: ExtensionContext): boolean => {
		if (ctx.agent.kind !== "main") return false;
		state.ctx = ctx;
		return true;
	};
	const refresh = (ctx: ExtensionContext) => {
		if (!bind(ctx)) return;
		startServer(pi);
		publish(pi);
		const n = listPeers().filter(p => p.id !== state.id).length;
		const m = masterId();
		ctx.ui.setStatus("peers", `peers:${n}${m === state.id ? " ★master" : m ? ` master:${m}` : ""}`);
	};

	pi.on("session_start", async (_e, ctx) => {
		if (!bind(ctx) || ctx.mode === "print" || ctx.mode === "json") return;
		refresh(ctx);
		if (state.timer) ctx.clearTimer(state.timer as never);
		state.timer = ctx.setInterval(() => refresh(ctx), 5_000);
	});
	for (const ev of ["session_switch", "agent_start", "agent_end", "turn_end"] as const) {
		pi.on(ev, async (_e, ctx) => {
			if (ctx.agent.kind === "main" && state.server) refresh(ctx);
		});
	}
	// Track the session's current task tier from the prompt it is about to work on (the master's explicit tier wins).
	pi.on("before_agent_start", async (event, ctx) => {
		if (ctx.agent.kind !== "main" || event.reason === "revive" || !event.prompt) return;
		if (event.prompt.startsWith("[Message from peer session")) return;
		state.tier = state.forcedTier ?? classify(event.prompt).tier;
		state.forcedTier = undefined;
	});
	// Subagent models: manual overrides set by the master win, then automatic tiering, never over an operator pin.
	pi.on("before_subagent_spawn", async (event, ctx) => {
		const manual = state.subModels[event.agent] ?? state.subModels["*"];
		if (manual) return { model: manual, note: `peers master override: ${manual}` };
		if (!autoActive() || event.agent === "seance" || (await operatorPinned(pi, event.agent))) return;
		const { tier, why } = subTierFor(event.agent, event.invocationKind);
		const cfg = loadTiers()[tier];
		const spec = cfg.effort && cfg.effort !== "off" ? `${cfg.model}:${cfg.effort}` : cfg.model;
		return { model: spec, note: `peers auto: ${tier} — ${why}` };
	});
	pi.on("session_shutdown", async (_e, ctx) => {
		if (ctx.agent.kind === "main") teardown();
	});

	const senderInfo = () => ({ id: state.id, name: selfInfo(pi).name });

	async function fanout(spec: string, req: Omit<Req, "from">): Promise<string> {
		const { peers: targets, error } = resolveTargets(spec);
		if (error) return `error: ${error}`;
		let out = req;
		let note = "";
		if (req.op === "prompt" && req.text && (state.route || req.tier)) {
			const r = routeFor(req.text, req.tier);
			out = { ...req, model: r.model, effort: r.effort, tier: r.tier };
			note = `[route: ${r.tier} — ${r.reason}${r.model ? `, ${r.model}/${r.effort}` : ""}]\n`;
		}
		const lines = await Promise.all(
			targets.map(async t => `${t.name} (${t.id}): ${summarize(await call(t, { ...out, from: senderInfo() }))}`),
		);
		return note + lines.join("\n");
	}

	// ---- LLM tools -------------------------------------------------------------------------
	pi.registerTool({
		name: "peers_list",
		label: "List Peers",
		description:
			"List the other omp sessions running on this machine (id, name, busy/idle, model, cwd) and which one is the master.",
		parameters: z.object({}),
		async execute() {
			const m = masterId();
			const text = listPeers().map(p => fmt(p, m)).join("\n") || "(no peers)";
			return { content: [{ type: "text", text }], details: { master: m } };
		},
	});

	pi.registerTool({
		name: "peers_send",
		label: "Message Peer",
		description:
			"Send a text message to another omp session (by id or name, or 'all'). It arrives as a peer message at the receiver's next step boundary, or starts a turn if it is idle. Use for hand-offs, findings, and questions; never to run commands.",
		parameters: z.object({
			to: z.string().describe("Peer id, name (or unique prefix), or 'all'"),
			text: z.string().describe("Message body"),
		}),
		async execute(_id, p) {
			const text = await fanout(p.to, { op: "message", text: p.text });
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	pi.registerTool({
		name: "peers_control",
		label: "Control Peer",
		description:
			"MASTER ONLY. Control other omp sessions (by id/name or 'all'): prompt (give the session a task as if the user typed it), abort, compact, model (text=model spec), rename (text=name), tail (read its last messages; text=count), shutdown, status. Fails unless this session is the master (claimed by the user with /peers master).",
		parameters: z.object({
			to: z.string().describe("Peer id, name (or unique prefix), or 'all'"),
			action: z.enum(["prompt", "abort", "compact", "model", "effort", "subagents", "setting", "rename", "tail", "shutdown", "status"]),
			text: z
				.string()
				.optional()
				.describe(
					"prompt: the task. model: selector/@role. effort: off|minimal|low|medium|high|xhigh|max. subagents: 'auto' (automatic per-task tiering, always on) | 'auto-off' | 'auto-managed' (default: on only while a master exists) | 'clear' (drop manual overrides) | '<spec>' (pin all subagents) | 'agent=spec,agent2=spec2' where spec is a model selector (optionally ':high'), an @role, or a tier light|standard|heavy; manual pins beat auto and apply to subagents spawned afterwards. setting: mode get|set|clear|list (default get). rename: new name. tail: message count.",
				),
			key: z.string().optional().describe("setting only: setting id, e.g. task.agentModelOverrides, modelRoles, retry.fallbackChains; for mode=list an id prefix"),
			value: z.string().optional().describe("setting set only: JSON value, e.g. {\"task\":\"@smol\"} or \"high\" or true"),
			tier: z
				.enum(["light", "standard", "heavy", "keep"])
				.optional()
				.describe(
					"prompt only. Cost tier for the task: light (trivial/lookup), standard (normal coding), heavy (design/debug/refactor). Omit to auto-classify; 'keep' leaves the peer's model/effort unchanged. Prefer the cheapest tier that fits.",
				),
		}),
		async execute(_id, p) {
			if (p.action !== "status" && masterId() !== state.id) {
				return { content: [{ type: "text", text: "error: this session is not the master; ask the user to run /peers master" }], details: {}, isError: true };
			}
			const n = p.action === "tail" && p.text ? Number.parseInt(p.text, 10) || undefined : undefined;
			let value: unknown = p.value;
			if (typeof value === "string") {
				try {
					value = JSON.parse(value);
				} catch {
					// plain string value
				}
			}
			const text = await fanout(p.to, { op: p.action, text: p.text, n, tier: p.tier, key: p.key, value });
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	// ---- /peers ----------------------------------------------------------------------------
	const ACTIONS = ["message", "prompt", "tail", "abort", "compact", "rename", "model", "effort", "subagents", "shutdown"] as const;
	pi.registerCommand("peers", {
		description:
			"Peer sessions: /peers [list|master|release|msg <peer> <text>|do <peer|all> <action> [text]|set <peer|all> <get|set|clear|list> <key> [json]|route [on|off]|accept|refuse|lock|unlock]",
		handler: async (args, ctx) => {
			refresh(ctx);
			const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const m = masterId();
			const say = (s: string) => ctx.ui.notify(s, "info");
			switch (sub) {
				case "list": {
					return say(listPeers().map(p => fmt(p, m)).join("\n") || "(no peers)");
				}
				case "master":
					fs.writeFileSync(MASTER_FILE, JSON.stringify({ id: state.id, pid: process.pid, since: new Date().toISOString() }), { mode: 0o600 });
					refresh(ctx);
					return say(`This session (${state.id}) is now the master.`);
				case "release":
					if (m === state.id) fs.rmSync(MASTER_FILE, { force: true });
					refresh(ctx);
					return say("Master role released.");
				case "set": {
					const [to, mode, key, ...v] = rest;
					if (!to || !mode) return say("usage: /peers set <peer|all> <get|set|clear|list> [key] [json]");
					if (m !== state.id) return say("Not the master. Run /peers master first.");
					let value: unknown = v.join(" ") || undefined;
					if (typeof value === "string") {
						try {
							value = JSON.parse(value);
						} catch {
							// plain string value
						}
					}
					return say(await fanout(to, { op: "setting", text: mode, key, value }));
				}
				case "route": {
					const arg = rest[0];
					if (arg === "on" || arg === "off") state.route = arg === "on";
					const t = loadTiers();
					return say(
						`Auto-routing: ${state.route ? "on" : "off"}\n` + TIERS.map(k => `${k}: ${t[k].model} / ${t[k].effort}`).join("\n"),
					);
				}
				case "accept":
				case "refuse":
					state.inbound = sub;
					publish(pi);
					return say(`Inbound peer requests: ${sub}`);
				case "lock":
				case "unlock":
					state.control = sub === "unlock";
					publish(pi);
					return say(`Control from master: ${state.control ? "allowed" : "refused"}`);
				case "msg": {
					const [to, ...t] = rest;
					if (!to || !t.length) return say("usage: /peers msg <peer|all> <text>");
					return say(await fanout(to, { op: "message", text: t.join(" ") }));
				}
				case "do": {
					const [to, action, ...t] = rest;
					if (!to || !action) return say("usage: /peers do <peer|all> <action> [text]");
					if (action !== "status" && m !== state.id) return say("Not the master. Run /peers master first.");
					const text = t.join(" ");
					return say(await fanout(to, { op: action, text, n: action === "tail" ? Number.parseInt(text, 10) || undefined : undefined }));
				}
				default: {
					// interactive dashboard
					const peersNow = listPeers().filter(p => p.id !== state.id);
					if (!peersNow.length) return say(`No other peers. This session is ${state.id}.${m === state.id ? " (master)" : ""}`);
					const rows = new Map(peersNow.map(p => [fmt(p, m), p]));
					const pickedLabel = await ctx.ui.select(m === state.id ? "Peers (you are master)" : "Peers", [...rows.keys()]);
					const peer = pickedLabel ? rows.get(pickedLabel) : undefined;
					if (!peer) return;
					const isMaster = m === state.id;
					const actions = isMaster ? [...ACTIONS] : ["message"];
					const action = await ctx.ui.select(`${peer.name} (${peer.id})`, actions);
					if (!action) return;
					const op = action === "message" ? "message" : action;
					let text: string | undefined;
					if (["message", "prompt", "rename", "model", "effort", "subagents"].includes(op)) {
						text = await ctx.ui.input(op, op === "model" ? "provider/model" : op === "effort" ? "minimal|low|medium|high|xhigh" : op === "subagents" ? "auto | auto-off | light | agent=model,... | clear" : "text");
						if (!text) return;
					}
					if (op === "shutdown" && !(await ctx.ui.confirm("Shut down peer?", `${peer.name} (${peer.id})`))) return;
					say(await fanout(peer.id, { op, text }));
				}
			}
		},
	});
}
