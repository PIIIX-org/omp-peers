// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

/**
 * Shared decision inbox: sessions queue short questions for the user, the master presents them together
 * and records an answer or a deferral. An answer is sent once to the asking session when it is live; if it
 * is not live the answer waits in the inbox (delivery stays `pending`) until the asker reads it with
 * `peers_decision check` or the master runs `/peers inbox retry`. Nothing here resumes a session, and
 * listing never writes.
 */
import * as path from "node:path";
import type { FeatureHost } from "./host";
import type { Feature, ToolSpec } from "./index";
import { resumeHint } from "./pause";
import { looksLikeSecret } from "./secrets";
import { readState, stateRoot, updateState } from "./store";

export type EntryState = "open" | "answered" | "deferred";

export interface Entry {
	/** Stable, never reused: `q<number>`. */
	id: string;
	/** The asking logical session: stable peer id and the name it had when it queued the question. */
	source: { id: string; name: string };
	question: string;
	context?: string;
	/** The decision requested, as a list of choices. */
	options?: string[];
	/** Explicit retry key, if the asker gave one. */
	key?: string;
	/** Retry identity: `key:<key>` or `text:<normalized question>`; unique per source while unresolved. */
	dedupKey: string;
	createdAt: number;
	state: EntryState;
	/** The answer (answered) or the optional note (deferred). */
	resolution?: string;
	resolvedAt?: number;
	/** `pending`, `delivered`, or `undeliverable: <reason>`. Only meaningful once answered. */
	delivery: string;
}

export interface InboxState {
	version: 1;
	nextId: number;
	entries: Entry[];
}

export const MAX_QUESTION = 300;
export const MAX_CONTEXT = 500;
export const MAX_RESOLUTION = 500;
export const MAX_OPTIONS = 8;
const MAX_OPTION = 100;
const MAX_REASON = 200;
const MAX_ENTRIES = 500;
const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const PEER_ID_RE = /^p(?:[0-9a-f]{6}|[0-9a-f]{16})$/;
const ID_RE = /^q[1-9][0-9]*$/;
const STATES: EntryState[] = ["open", "answered", "deferred"];
const MASTER_ONLY = "only the master session may answer, defer, reopen or retry inbox questions; run /peers master first";
const SECRET_ERROR = (what: string) => `${what} looks like a credential or token; the inbox is stored in plain text and shown to other sessions. Describe where the secret lives instead of including it`;

export const inboxFile = (home: string) => path.join(stateRoot(home), "inbox.json");

const emptyState = (): InboxState => ({ version: 1, nextId: 1, entries: [] });

const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\p{Cc}\p{Cf}]/u.test(value);

function validateState(value: unknown): InboxState {
	const state = value as Partial<InboxState> | null;
	if (!state || typeof state !== "object" || state.version !== 1) throw new Error("unsupported version (expected 1)");
	if (!Number.isInteger(state.nextId) || (state.nextId as number) < 1 || !Array.isArray(state.entries)) throw new Error("malformed fields");
	const ids = new Set<string>();
	for (const entry of state.entries as Entry[]) {
		const ok = entry && typeof entry === "object" && typeof entry.id === "string" && ID_RE.test(entry.id) &&
			entry.source && typeof entry.source === "object" && typeof entry.source.id === "string" && PEER_ID_RE.test(entry.source.id) && typeof entry.source.name === "string" &&
			isText(entry.question, MAX_QUESTION) && (entry.context === undefined || isText(entry.context, MAX_CONTEXT)) &&
			(entry.options === undefined || (Array.isArray(entry.options) && entry.options.length > 0 && entry.options.length <= MAX_OPTIONS && entry.options.every(option => isText(option, MAX_OPTION)))) &&
			(entry.key === undefined || (typeof entry.key === "string" && KEY_RE.test(entry.key))) &&
			typeof entry.dedupKey === "string" && entry.dedupKey.length > 0 && typeof entry.createdAt === "number" &&
			STATES.includes(entry.state) && (entry.resolution === undefined || isText(entry.resolution, MAX_RESOLUTION)) &&
			(entry.resolvedAt === undefined || typeof entry.resolvedAt === "number") &&
			typeof entry.delivery === "string" && (entry.delivery === "pending" || entry.delivery === "delivered" || (entry.delivery.startsWith("undeliverable: ") && entry.delivery.length <= 15 + MAX_REASON));
		if (!ok || ids.has(entry.id)) throw new Error("malformed or duplicate entry");
		ids.add(entry.id);
		if (Number(entry.id.slice(1)) >= (state.nextId as number)) throw new Error("entry id beyond nextId");
	}
	return state as InboxState;
}

/** The inbox as stored; a missing file is an empty inbox. Never writes. */
export function readInbox(host: Pick<FeatureHost, "home">): InboxState {
	return readState(inboxFile(host.home), emptyState, validateState);
}

// ---- Validation --------------------------------------------------------------------------------

/** One-line text: whitespace collapsed, surrounding matching quotes removed. */
function clean(raw: unknown, what: string, max: number, required = true): { text?: string; error?: string } {
	if (typeof raw !== "string") return required ? { error: `${what} is required` } : {};
	let text = raw.trim().replace(/\s+/g, " ");
	if (text.length > 1 && /^(["'])[\s\S]*\1$/.test(text)) text = text.slice(1, -1).trim();
	if (!text) return required ? { error: `${what} is empty` } : {};
	if (text.length > max) return { error: `${what} is longer than ${max} characters` };
	if (/[\p{Cc}\p{Cf}]/u.test(text)) return { error: `${what} contains control characters` };
	if (looksLikeSecret(text)) return { error: SECRET_ERROR(what) };
	return { text };
}

/** Retry identity of a question: the explicit key, else the lower-cased text without trailing punctuation. */
function dedupKeyOf(question: string, key?: string): string {
	return key ? `key:${key}` : `text:${question.toLowerCase().replace(/[\s?.!]+$/, "")}`;
}

function parseId(spec: string): string | undefined {
	const id = /^\d+$/.test(spec) ? `q${spec}` : spec.toLowerCase();
	return ID_RE.test(id) ? id : undefined;
}

// ---- Operations --------------------------------------------------------------------------------

export interface AskInput {
	question?: unknown;
	context?: unknown;
	options?: unknown;
	key?: unknown;
}
export type AskResult = { ok: true; entry: Entry; duplicate: boolean } | { ok: false; error: string };

/** Queue a question for the calling session. A retry of an unresolved question returns the existing entry. */
export async function askQuestion(host: FeatureHost, input: AskInput): Promise<AskResult> {
	const question = clean(input.question, "question", MAX_QUESTION);
	if (!question.text) return { ok: false, error: question.error! };
	const context = clean(input.context, "context", MAX_CONTEXT, false);
	if (context.error) return { ok: false, error: context.error };
	let options: string[] | undefined;
	if (input.options !== undefined) {
		if (!Array.isArray(input.options) || input.options.length > MAX_OPTIONS) return { ok: false, error: `options must be a list of at most ${MAX_OPTIONS} choices` };
		options = [];
		for (const raw of input.options) {
			const option = clean(raw, "option", MAX_OPTION);
			if (!option.text) return { ok: false, error: option.error! };
			options.push(option.text);
		}
		if (!options.length) options = undefined;
	}
	let key: string | undefined;
	if (input.key !== undefined) {
		key = typeof input.key === "string" ? input.key.toLowerCase() : "";
		if (!KEY_RE.test(key)) return { ok: false, error: "key must be 1-32 characters: letters, digits, '.', '_' or '-'" };
	}
	const self = host.self();
	const source = { id: self.id, name: clean(self.name, "session name", 120).text ?? self.id };
	const dedupKey = dedupKeyOf(question.text, key);
	const createdAt = host.now();
	return updateState<InboxState, AskResult>(inboxFile(host.home), emptyState, validateState, current => {
		const existing = current.entries.find(e => e.source.id === source.id && e.dedupKey === dedupKey && e.state !== "answered");
		if (existing) return { result: { ok: true, entry: existing, duplicate: true } };
		let entries = current.entries;
		if (entries.length >= MAX_ENTRIES) {
			// Make room by dropping answered entries only: delivered ones first, then the oldest other answered ones.
			// Open and deferred entries are never dropped.
			const need = entries.length - MAX_ENTRIES + 1;
			const droppable = [
				...entries.filter(e => e.state === "answered" && e.delivery === "delivered"),
				...entries.filter(e => e.state === "answered" && e.delivery !== "delivered"),
			].slice(0, need);
			if (droppable.length < need) return { result: { ok: false, error: `inbox is full (${MAX_ENTRIES} entries, all open or deferred); answer some to free room` } };
			entries = entries.filter(e => !droppable.includes(e));
		}
		const entry: Entry = {
			id: `q${current.nextId}`, source, question: question.text!,
			...(context.text ? { context: context.text } : {}), ...(options ? { options } : {}), ...(key ? { key } : {}),
			dedupKey, createdAt, state: "open", delivery: "pending",
		};
		return { state: { version: 1, nextId: current.nextId + 1, entries: [...entries, entry] }, result: { ok: true, entry, duplicate: false } };
	});
}

export type ResolveResult = { ok: true; entry: Entry; delivery?: string } | { ok: false; error: string };

type Change = (entry: Entry) => Entry | string;

/** Apply `change` to entry `id` under the lock; a string result is the refusal reason. */
async function mutate(host: FeatureHost, id: string, change: Change): Promise<ResolveResult> {
	return updateState<InboxState, ResolveResult>(inboxFile(host.home), emptyState, validateState, current => {
		const entry = current.entries.find(e => e.id === id);
		if (!entry) return { result: { ok: false, error: `no inbox question ${id}` } };
		const next = change(entry);
		if (typeof next === "string") return { result: { ok: false, error: next } };
		return { state: { ...current, entries: current.entries.map(e => (e === entry ? next : e)) }, result: { ok: true, entry: next } };
	});
}

function checkMaster(host: FeatureHost): string | undefined {
	return host.isMaster() ? undefined : MASTER_ONLY;
}

function answerMessage(entry: Entry): string {
	return [
		`Decision for your inbox question ${entry.id}, recorded by the master session (confirm with peers_decision check ${entry.id}).`,
		`Question: ${entry.question}`,
		`Decision: ${entry.resolution}`,
	].join("\n");
}

/** Send the answer to the asker once and record the outcome. `pending` when the asker is not live or is this session. */
async function deliver(host: FeatureHost, entry: Entry): Promise<ResolveResult> {
	let delivery = "pending";
	if (entry.source.id !== host.self().id) {
		const result = await host.send(entry.source.id, { text: answerMessage(entry) });
		if (result.status === "delivered") delivery = "delivered";
		else if (result.status === "failed") delivery = `undeliverable: ${result.reason.replace(/\s+/g, " ").trim().slice(0, MAX_REASON - 1) || "unknown reason"}`;
	}
	const stored = await mutate(host, entry.id, current => (current.state === "answered" && current.resolvedAt === entry.resolvedAt ? { ...current, delivery } : "answer changed while delivering"));
	return stored.ok ? { ...stored, delivery } : stored;
}

export async function answerQuestion(host: FeatureHost, idSpec: string, rawText: string): Promise<ResolveResult> {
	const denied = checkMaster(host);
	if (denied) return { ok: false, error: denied };
	const id = parseId(idSpec);
	if (!id) return { ok: false, error: `"${idSpec}" is not an inbox id (q<number>)` };
	const resolution = clean(rawText, "answer", MAX_RESOLUTION);
	if (!resolution.text) return { ok: false, error: resolution.error! };
	const resolvedAt = host.now();
	const saved = await mutate(host, id, entry => entry.state === "answered"
		? `${id} is already answered; reopen it first to change the answer`
		: { ...entry, state: "answered", resolution: resolution.text, resolvedAt, delivery: "pending" });
	return saved.ok ? deliver(host, saved.entry) : saved;
}

export async function deferQuestion(host: FeatureHost, idSpec: string, rawNote: string): Promise<ResolveResult> {
	const denied = checkMaster(host);
	if (denied) return { ok: false, error: denied };
	const id = parseId(idSpec);
	if (!id) return { ok: false, error: `"${idSpec}" is not an inbox id (q<number>)` };
	const note = clean(rawNote, "note", MAX_RESOLUTION, false);
	if (note.error) return { ok: false, error: note.error };
	const resolvedAt = host.now();
	// Deferring sends nothing to the asker.
	return mutate(host, id, entry => {
		if (entry.state !== "open") return `${id} is ${entry.state}; only an open question can be deferred`;
		return { ...entry, state: "deferred", resolution: note.text, resolvedAt };
	});
}

export async function reopenQuestion(host: FeatureHost, idSpec: string): Promise<ResolveResult> {
	const denied = checkMaster(host);
	if (denied) return { ok: false, error: denied };
	const id = parseId(idSpec);
	if (!id) return { ok: false, error: `"${idSpec}" is not an inbox id (q<number>)` };
	return updateState<InboxState, ResolveResult>(inboxFile(host.home), emptyState, validateState, current => {
		const entry = current.entries.find(e => e.id === id);
		if (!entry) return { result: { ok: false, error: `no inbox question ${id}` } };
		if (entry.state === "open") return { result: { ok: false, error: `${id} is already open` } };
		const twin = current.entries.find(e => e !== entry && e.source.id === entry.source.id && e.dedupKey === entry.dedupKey && e.state !== "answered");
		if (twin) return { result: { ok: false, error: `${twin.id} is the same unresolved question from the same session; resolve that one instead` } };
		const next: Entry = { ...entry, state: "open", resolution: undefined, resolvedAt: undefined, delivery: "pending" };
		return { state: { ...current, entries: current.entries.map(e => (e === entry ? next : e)) }, result: { ok: true, entry: next } };
	});
}

export async function retryDelivery(host: FeatureHost, idSpec: string): Promise<ResolveResult> {
	const denied = checkMaster(host);
	if (denied) return { ok: false, error: denied };
	const id = parseId(idSpec);
	if (!id) return { ok: false, error: `"${idSpec}" is not an inbox id (q<number>)` };
	const entry = readInbox(host).entries.find(e => e.id === id);
	if (!entry) return { ok: false, error: `no inbox question ${id}` };
	if (entry.state !== "answered") return { ok: false, error: entry.state === "deferred" ? `${id} is deferred; deferring sends nothing` : `${id} is not answered yet` };
	if (entry.delivery === "delivered") return { ok: false, error: `${id} was already delivered` };
	return deliver(host, entry);
}

// ---- Presentation ------------------------------------------------------------------------------

function renderEntry(entry: Entry): string[] {
	const lines = [`  ${entry.id}  ${entry.state}  asked ${new Date(entry.createdAt).toISOString()}`, `      question: ${entry.question}`];
	if (entry.context) lines.push(`      context: ${entry.context}`);
	if (entry.options) lines.push(`      requested decision: choose one of: ${entry.options.join(" | ")}`);
	if (entry.state === "answered") lines.push(`      answer: ${entry.resolution}`, `      delivery: ${entry.delivery}`);
	if (entry.state === "deferred") lines.push(`      deferred${entry.resolution ? `: ${entry.resolution}` : " (no note)"}`);
	return lines;
}

function count(entries: Entry[], state: EntryState): number {
	return entries.filter(entry => entry.state === state).length;
}

/** Everything, grouped by asking session. Read-only: no file is created or changed and no session is contacted beyond the roster. */
export async function renderInbox(host: FeatureHost, openOnly: boolean): Promise<string> {
	const all = readInbox(host).entries;
	const shown = (openOnly ? all.filter(entry => entry.state === "open") : all).slice().sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
	if (!all.length) return "inbox is empty";
	if (!shown.length) return `no open questions (${count(all, "answered")} answered, ${count(all, "deferred")} deferred)`;
	const live = new Map<string, string>();
	try {
		for (const peer of await host.peers()) live.set(peer.id, peer.name);
	} catch {
		// liveness is informational; the stored entries are what matter
	}
	const groups = new Map<string, Entry[]>();
	for (const entry of shown) groups.set(entry.source.id, [...(groups.get(entry.source.id) ?? []), entry]);
	const lines = [`inbox: ${count(all, "open")} open, ${count(all, "deferred")} deferred, ${count(all, "answered")} answered${openOnly ? " (showing open only)" : ""}`];
	for (const [id, entries] of groups) {
		const name = live.get(id) ?? entries[entries.length - 1].source.name;
		lines.push(`from ${name} (${id}) [${live.has(id) ? "live" : "not live"}]`);
		for (const entry of entries) lines.push(...renderEntry(entry));
	}
	return lines.join("\n");
}

function describeResolve(result: ResolveResult & { ok: true }, verb: string, home: string): string {
	const { entry, delivery } = result;
	if (verb !== "answered") return `${entry.id} ${verb}`;
	switch (delivery) {
		case "delivered": return `${entry.id} answered; the answer was delivered to ${entry.source.name} (${entry.source.id})`;
		case "pending": return `${entry.id} answered; ${entry.source.name} (${entry.source.id}) is not reachable from this session, so delivery is pending. It can read the answer with peers_decision check, or run /peers inbox retry ${entry.id}`;
		default: return `${entry.id} answered; ${entry.delivery}${entry.delivery.endsWith("session is paused") ? ` (${resumeHint(home, entry.source.id)})` : ""}. Fix the cause and run /peers inbox retry ${entry.id}, or the session can read it with peers_decision check`;
	}
}

// ---- Asker side --------------------------------------------------------------------------------

/** The calling session's own questions; `idSpec` narrows to one. Read-only. */
export function checkQuestions(host: FeatureHost, idSpec?: string): { ok: true; text: string } | { ok: false; error: string } {
	const self = host.self().id;
	let mine = readInbox(host).entries.filter(entry => entry.source.id === self);
	if (idSpec !== undefined) {
		const id = parseId(idSpec);
		if (!id) return { ok: false, error: `"${idSpec}" is not an inbox id (q<number>)` };
		mine = mine.filter(entry => entry.id === id);
		if (!mine.length) return { ok: false, error: `no question ${id} from this session` };
	}
	if (!mine.length) return { ok: true, text: "this session has no inbox questions" };
	return {
		ok: true,
		text: mine.map(entry => {
			switch (entry.state) {
				case "open": return `${entry.id} open: no decision yet. Keep working on other things; do not ask again.\n  question: ${entry.question}`;
				case "deferred": return `${entry.id} deferred by the user${entry.resolution ? `: ${entry.resolution}` : ""}. No decision yet; do not block on it.\n  question: ${entry.question}`;
				default: return `${entry.id} answered: ${entry.resolution}\n  question: ${entry.question}\n  delivery: ${entry.delivery}`;
			}
		}).join("\n"),
	};
}

const decisionTool: ToolSpec = {
	name: "peers_decision",
	label: "Decision Inbox",
	description:
		"Queue a short question for the user in the shared decision inbox, or check the state of your own queued questions. ask: queues the question and returns its id immediately (a retry of the same unresolved question returns the same id); keep working, the master presents all questions together and the answer arrives as a peer message. check: read the state and answer of your own questions without waking anything. Never include credentials.",
	parameters: z => z.object({
		action: z.enum(["ask", "check"]),
		question: z.string().optional().describe(`ask only: one short line, at most ${MAX_QUESTION} characters`),
		context: z.string().optional().describe(`ask only: why it matters, at most ${MAX_CONTEXT} characters`),
		options: z.array(z.string()).optional().describe(`ask only: the choices requested, at most ${MAX_OPTIONS}`),
		key: z.string().optional().describe("ask only: explicit retry key; the same key from this session while the question is unresolved returns the existing id"),
		id: z.string().optional().describe("check only: one question id (q<number>); omit for all of this session's questions"),
	}),
	async execute(params, host) {
		if (params.action === "check") {
			const result = checkQuestions(host, typeof params.id === "string" ? params.id : undefined);
			return result.ok ? { text: result.text } : { text: `error: ${result.error}`, isError: true };
		}
		if (params.action !== "ask") return { text: "error: action must be ask or check", isError: true };
		const result = await askQuestion(host, params);
		if (!result.ok) return { text: `error: ${result.error}`, isError: true };
		const { entry, duplicate } = result;
		return { text: duplicate
			? `${entry.id} is already queued (${entry.state}); not queued again. Check it with peers_decision check`
			: `queued ${entry.id}. The user answers from the master session; the answer arrives as a peer message and is also readable with peers_decision check. Continue with other work; do not wait` };
	},
};

// ---- Command -----------------------------------------------------------------------------------

const USAGE = "usage: /peers inbox [list [--open]] | ask <question> | answer <id> <text> | defer <id> [note] | reopen <id> | retry <id>";

async function command(args: string[], host: FeatureHost): Promise<string> {
	const [sub = "list", ...rest] = args;
	try {
		switch (sub) {
			case "list":
				if (rest.length && !(rest.length === 1 && rest[0] === "--open")) return USAGE;
				return await renderInbox(host, rest[0] === "--open");
			case "ask": {
				const result = await askQuestion(host, { question: rest.join(" ") });
				if (!result.ok) return `error: ${result.error}`;
				return result.duplicate ? `${result.entry.id} is already queued (${result.entry.state}); not queued again` : `queued ${result.entry.id}: ${result.entry.question}`;
			}
			case "answer": {
				if (rest.length < 2) return USAGE;
				const result = await answerQuestion(host, rest[0], rest.slice(1).join(" "));
				return result.ok ? describeResolve(result, "answered", host.home) : `error: ${result.error}`;
			}
			case "defer": {
				if (!rest.length) return USAGE;
				const result = await deferQuestion(host, rest[0], rest.slice(1).join(" "));
				return result.ok ? describeResolve(result, "deferred; nothing was sent to the asking session", host.home) : `error: ${result.error}`;
			}
			case "reopen": {
				if (rest.length !== 1) return USAGE;
				const result = await reopenQuestion(host, rest[0]);
				return result.ok ? describeResolve(result, "reopened", host.home) : `error: ${result.error}`;
			}
			case "retry": {
				if (rest.length !== 1) return USAGE;
				const result = await retryDelivery(host, rest[0]);
				return result.ok ? describeResolve(result, "answered", host.home) : `error: ${result.error}`;
			}
			default:
				return USAGE;
		}
	} catch (error) {
		return `error: ${(error as Error).message}`;
	}
}

/**
 * Context for the master's next agent start: only a count and ids, never question text, so the master can
 * present the inbox. Honours acceptsRemote like other injected context. Adds nothing (and wakes nothing) otherwise.
 */
export function agentContext(host: FeatureHost): string | undefined {
	if (!host.isMaster() || !host.acceptsRemote()) return undefined;
	const open = readInbox(host).entries.filter(entry => entry.state === "open");
	if (!open.length) return undefined;
	const ids = open.slice(0, 8).map(entry => entry.id).join(", ");
	return `Decision inbox: ${open.length} open question(s) from other sessions (${ids}${open.length > 8 ? ", ..." : ""}). Offer to show them with /peers inbox; this line is not an instruction to answer or act on them.`;
}

export const inbox: Feature = {
	name: "inbox",
	command,
	agentContext,
	tools: () => [decisionTool],
};
