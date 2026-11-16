// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

/**
 * Explicit report-driven task dependencies: "when session A reports DONE for unit X, prompt session B with Y".
 *
 * A rule fires only from a structured DONE report that the MASTER session accepted through the
 * `Feature.onReport` hook (never from idle transitions, text or subagent reports). Firing records one
 * trigger in a persisted ledger keyed by (rule, sender, report event key), so a re-sent or replayed report
 * cannot fire twice, across restarts and across processes. In `confirm` mode (the default) the trigger waits
 * for `/peers deps approve`; only a rule the user added with `--auto` dispatches by itself. Dispatch is one
 * ordinary peer message through `host.send`, so the target's pause gate, inbound refuse and rate limit apply
 * unchanged. Nothing here wakes a session while listing, previewing or recording.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import type { Report } from "../reports";
import type { FeatureHost, PeerView } from "./host";
import type { Feature } from "./index";
import { PAUSED_ERROR, readPause } from "./pause";
import { looksLikeSecret } from "./secrets";
import { readState, stateRoot, updateState } from "./store";

export interface DepRule {
	/** Stable, never reused: `d<number>`. */
	id: string;
	/** Stable id of the session whose DONE report fires the rule (resolved when the rule was added). */
	from: string;
	/** Report unit, matched exactly after whitespace is collapsed. */
	unit: string;
	/** Only DONE reports trigger; BLOCKED, WAITING and DECISION never do. */
	on: "DONE";
	/** Stable id of the session that receives the prompt. */
	to: string;
	prompt: string;
	/** `confirm` queues the trigger for the user; `auto` dispatches it at once. */
	mode: "confirm" | "auto";
	/** A once rule disables itself when it fires its first trigger. */
	once: boolean;
	enabled: boolean;
	createdAt: number;
}

export interface Trigger {
	/** Stable, never reused: `t<number>`. */
	id: string;
	ruleId: string;
	/** The sender id the report claimed; not authenticated. */
	sourceSession: string;
	/** `e:` plus a hash of (sender, unit, kind, evidence); an exact re-send has the same key. */
	reportEventKey: string;
	firedAt: number;
	/** `pending`, `sending`, `delivered`, `rejected`, `cancelled: rule removed`, `not delivered: <reason>` or `unknown: <reason>`. */
	outcome: string;
	/** When the latest dispatch attempt began. */
	attemptedAt?: number;
}

export interface DepsState {
	version: 1;
	nextRuleId: number;
	nextTriggerId: number;
	rules: DepRule[];
	ledger: Trigger[];
}

export const MAX_RULES = 64;
export const MAX_OUTGOING = 8;
export const MAX_UNIT = 120;
export const MAX_PROMPT = 400;
export const MAX_LEDGER = 500;
const MAX_REASON = 120;
const LEDGER_SHOWN = 50;
/** A dispatch claim older than this is treated as interrupted: its outcome is unknown. Longer than the 10 s send timeout. */
export const SENDING_TTL_MS = 60_000;
const PEER_ID_RE = /^p(?:[0-9a-f]{6}|[0-9a-f]{16})$/;
const RULE_ID_RE = /^d[1-9][0-9]*$/;
const TRIGGER_ID_RE = /^t[1-9][0-9]*$/;
const EVENT_KEY_RE = /^e:[0-9a-f]{16}$/;
const MASTER_ONLY = "only the master session may change dependency rules or approve triggers; run /peers master first";
const CANCELLED = "cancelled: rule removed";
const USAGE =
	"usage: /peers deps [list] | add <from> <unit...> -> <to> <prompt...> [--auto] [--once|--repeat] | remove <id> | enable <id> | disable <id> | " +
	"preview <rule-id|trigger-id|from unit...> | pending | approve <trigger-id> | reject <trigger-id> | ledger";

export const depsFile = (home: string) => path.join(stateRoot(home), "deps.json");

const emptyState = (): DepsState => ({ version: 1, nextRuleId: 1, nextTriggerId: 1, rules: [], ledger: [] });

const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\p{Cc}\p{Cf}]/u.test(value);
const isOutcome = (value: unknown): boolean =>
	typeof value === "string" &&
	(["pending", "sending", "delivered", "rejected", CANCELLED].includes(value) || (/^(?:not delivered|unknown): /.test(value) && value.length <= 15 + MAX_REASON && !/[\p{Cc}\p{Cf}]/u.test(value)));

function validateState(value: unknown): DepsState {
	const state = value as Partial<DepsState> | null;
	if (!state || typeof state !== "object" || state.version !== 1) throw new Error("unsupported version (expected 1)");
	const { nextRuleId, nextTriggerId, rules, ledger } = state;
	if (!Number.isInteger(nextRuleId) || (nextRuleId as number) < 1 || !Number.isInteger(nextTriggerId) || (nextTriggerId as number) < 1 || !Array.isArray(rules) || !Array.isArray(ledger)) {
		throw new Error("malformed fields");
	}
	if (rules.length > MAX_RULES || ledger.length > MAX_LEDGER) throw new Error("too many rules or ledger entries");
	const ruleIds = new Set<string>();
	for (const rule of rules as DepRule[]) {
		const ok = rule && typeof rule === "object" && typeof rule.id === "string" && RULE_ID_RE.test(rule.id) && Number(rule.id.slice(1)) < (nextRuleId as number) &&
			typeof rule.from === "string" && PEER_ID_RE.test(rule.from) && typeof rule.to === "string" && PEER_ID_RE.test(rule.to) && rule.from !== rule.to &&
			isText(rule.unit, MAX_UNIT) && rule.on === "DONE" && isText(rule.prompt, MAX_PROMPT) && (rule.mode === "confirm" || rule.mode === "auto") &&
			typeof rule.once === "boolean" && typeof rule.enabled === "boolean" && Number.isFinite(rule.createdAt);
		if (!ok || ruleIds.has(rule.id)) throw new Error("malformed or duplicate rule");
		ruleIds.add(rule.id);
	}
	const triggerIds = new Set<string>();
	for (const entry of ledger as Trigger[]) {
		const ok = entry && typeof entry === "object" && typeof entry.id === "string" && TRIGGER_ID_RE.test(entry.id) && Number(entry.id.slice(1)) < (nextTriggerId as number) &&
			typeof entry.ruleId === "string" && RULE_ID_RE.test(entry.ruleId) && typeof entry.sourceSession === "string" && PEER_ID_RE.test(entry.sourceSession) &&
			typeof entry.reportEventKey === "string" && EVENT_KEY_RE.test(entry.reportEventKey) && Number.isFinite(entry.firedAt) && isOutcome(entry.outcome) &&
			(entry.attemptedAt === undefined || Number.isFinite(entry.attemptedAt));
		if (!ok || triggerIds.has(entry.id)) throw new Error("malformed or duplicate ledger entry");
		triggerIds.add(entry.id);
	}
	return state as DepsState;
}

/** The dependency state as stored; a missing file is an empty state. Never writes. */
export function readDeps(host: FeatureHost): DepsState {
	return readState(depsFile(host.home), emptyState, validateState);
}

// ---- Ledger entry states -----------------------------------------------------------------------

type Kind = "pending" | "retry" | "inflight" | "unknown" | "delivered" | "closed";

function kindOf(entry: Trigger, now: number): Kind {
	const { outcome } = entry;
	if (outcome === "pending") return "pending";
	if (outcome === "delivered") return "delivered";
	if (outcome === "rejected" || outcome === CANCELLED) return "closed";
	if (outcome.startsWith("not delivered: ")) return "retry";
	if (outcome === "sending") return now - (entry.attemptedAt ?? 0) < SENDING_TTL_MS ? "inflight" : "unknown";
	return "unknown";
}

/** Why `approve` would refuse this entry; undefined when it may be approved. Shared by approve and preview so they cannot disagree. */
function approveBlock(entry: Trigger, now: number): string | undefined {
	switch (kindOf(entry, now)) {
		case "pending":
		case "retry": return undefined;
		case "delivered": return `${entry.id} was already delivered; it is never sent twice`;
		case "closed": return `${entry.id} is ${entry.outcome}; nothing to approve`;
		case "inflight": return `${entry.id} is being dispatched right now by another process; it is not sent again`;
		default: return `${entry.id} has an unknown outcome (${entry.outcome === "sending" ? "a dispatch was interrupted" : entry.outcome}); it may already have been delivered, so it is not retried. Check the target, then /peers deps reject ${entry.id} to close it`;
	}
}

/** Open entries are never dropped to make room: waiting for the user, retryable or in flight. */
const droppable = (entry: Trigger, now: number): boolean => ["delivered", "closed", "unknown"].includes(kindOf(entry, now));

/** Drop the oldest droppable entries so `extra` more fit; undefined when open entries alone fill the ledger. */
function makeRoom(ledger: Trigger[], extra: number, now: number): Trigger[] | undefined {
	const excess = ledger.length + extra - MAX_LEDGER;
	if (excess <= 0) return ledger;
	const drop = new Set(ledger.filter(entry => droppable(entry, now)).slice(0, excess));
	return drop.size < excess ? undefined : ledger.filter(entry => !drop.has(entry));
}

// ---- Text and identity -------------------------------------------------------------------------

const normalize = (raw: string): string => raw.replace(/\s+/g, " ").trim();

function cleanText(raw: string, what: string, max: number): { text?: string; error?: string } {
	const text = normalize(raw);
	if (!text) return { error: `${what} is empty` };
	if (text.length > max) return { error: `${what} is longer than ${max} characters` };
	if (/[\p{Cc}\p{Cf}]/u.test(text)) return { error: `${what} contains control characters` };
	if (looksLikeSecret(text)) return { error: `${what} looks like a credential or token; dependency rules are stored in plain text and sent to another session. Describe where the secret lives instead of including it` };
	return { text };
}

const reasonText = (raw: string): string => raw.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, MAX_REASON) || "unknown reason";

/**
 * Identity of one DONE report: sender, unit, kind and evidence (description and references). An exact
 * re-send has the same key; a genuinely new DONE for the same unit carries different evidence and gets a
 * different one. Only a hash is stored, never the evidence.
 */
export function reportEventKey(sender: string, report: Extract<Report, { kind: "DONE" }>): string {
	const digest = createHash("sha256").update(JSON.stringify([sender, normalize(report.unit), report.kind, report.evidence.description, report.evidence.references ?? []])).digest("hex");
	return `e:${digest.slice(0, 16)}`;
}

function label(id: string, live: PeerView[]): string {
	const peer = live.find(p => p.id === id);
	return peer ? `${peer.name} (${id})` : `${id} (not running)`;
}

/** Exact id or exact (case-sensitive) name of a live session. Never guesses on ambiguity. */
function resolveLive(spec: string, live: PeerView[]): { id?: string; error?: string } {
	const byId = live.find(peer => peer.id === spec);
	if (byId) return { id: byId.id };
	const named = live.filter(peer => peer.name === spec);
	if (named.length === 1) return { id: named[0].id };
	if (named.length > 1) return { error: `"${spec}" is ambiguous: ${named.map(peer => peer.id).join(", ")}; use an explicit stable ID` };
	return { error: `no live session matches "${spec}"; use its stable ID or exact name` };
}

/** `from` for read-only lookups: a live session first, else any well-formed stable id. */
function resolveKnown(spec: string, live: PeerView[]): { id?: string; error?: string } {
	const found = resolveLive(spec, live);
	return found.id || !PEER_ID_RE.test(spec) ? found : { id: spec };
}

/** The shortest chain of rules leading from session `start` to session `goal`, as session ids including both ends. */
function chain(rules: DepRule[], start: string, goal: string): string[] | undefined {
	const parent = new Map<string, string>([[start, ""]]);
	const queue = [start];
	for (let head = 0; head < queue.length; head++) {
		const node = queue[head];
		for (const rule of rules) {
			if (rule.from !== node || parent.has(rule.to)) continue;
			parent.set(rule.to, node);
			if (rule.to === goal) {
				const path = [goal];
				while (path[0] !== start) path.unshift(parent.get(path[0])!);
				return path;
			}
			queue.push(rule.to);
		}
	}
	return undefined;
}

// ---- Dispatch text and blockers ----------------------------------------------------------------

/**
 * The exact peer message a trigger delivers. The receiver adds its own "[Message from peer session ...]" header. Only
 * stable ids and the user-typed rule fields appear: a session's current name is attacker-controlled text and is
 * never put into a message the master sends.
 */
export function dispatchText(rule: DepRule, triggerId: string): string {
	return [
		`Dependency trigger ${triggerId} (rule ${rule.id}, authorized by the user at the master session): session ${rule.from} reported DONE for unit "${rule.unit}" (the sender identity is claimed, not authenticated).`,
		`Task: ${rule.prompt}`,
	].join("\n");
}

/**
 * Why a dispatch to the rule's target is known to fail right now, from the published state the receiver enforces.
 * Empty means an attempt would be made. A control-locked target is not messaged either: a dependency trigger is
 * authorized work, so it respects the target's refusal of control. The receiver's per-sender rate limit cannot be
 * seen from here.
 */
function targetBlockers(host: FeatureHost, rule: DepRule, live: PeerView[]): string[] {
	const reasons: string[] = [];
	const peer = live.find(p => p.id === rule.to);
	if (rule.to === host.self().id) reasons.push("target is the dispatching session itself");
	else if (!peer) reasons.push("target is not running");
	else if (peer.refusesInbound === true) reasons.push("peer refuses inbound requests");
	else if (peer.acceptsRemote === false) reasons.push("target locked (control refused)");
	const pause = readPause(host.home, rule.to);
	if (pause.paused) reasons.push(pause.error ? `pause state unreadable (${pause.error})` : PAUSED_ERROR);
	return reasons;
}

/** Failures after which the message may still have arrived; a retry could deliver it twice. */
const ambiguous = (reason: string): boolean => /^(?:timeout|connection closed|bad response|response too large)$/.test(reason) || /^unreachable \((?!ECONNREFUSED|ENOENT)/.test(reason);

// ---- Operations --------------------------------------------------------------------------------

export interface AddInput {
	from: string;
	unit: string;
	to: string;
	prompt: string;
	auto: boolean;
	once: boolean;
}
export type AddResult = { ok: true; rule: DepRule } | { ok: false; error: string };

/** Master only. Validates both sessions, the text, the caps and the rule graph; sends nothing. */
export async function addRule(host: FeatureHost, input: AddInput): Promise<AddResult> {
	if (!host.isMaster()) return { ok: false, error: MASTER_ONLY };
	const unit = cleanText(input.unit, "unit", MAX_UNIT);
	if (!unit.text) return { ok: false, error: unit.error! };
	const prompt = cleanText(input.prompt, "prompt", MAX_PROMPT);
	if (!prompt.text) return { ok: false, error: prompt.error! };
	const live = await host.peers();
	const from = resolveLive(input.from, live);
	if (!from.id) return { ok: false, error: `from: ${from.error}` };
	const to = resolveLive(input.to, live);
	if (!to.id) return { ok: false, error: `to: ${to.error}` };
	if (from.id === to.id) return { ok: false, error: `a session cannot depend on itself (${label(from.id, live)})` };
	const createdAt = host.now();
	return updateState<DepsState, AddResult>(depsFile(host.home), emptyState, validateState, current => {
		if (current.rules.length >= MAX_RULES) return { result: { ok: false, error: `rule limit reached (${MAX_RULES}); remove a rule first` } };
		if (current.rules.filter(rule => rule.from === from.id).length >= MAX_OUTGOING) {
			return { result: { ok: false, error: `${label(from.id!, live)} already has ${MAX_OUTGOING} outgoing rules (the limit); remove one first` } };
		}
		const twin = current.rules.find(rule => rule.from === from.id && rule.unit === unit.text && rule.to === to.id);
		if (twin) return { result: { ok: false, error: `${twin.id} already says ${label(from.id!, live)} DONE "${unit.text}" -> ${label(to.id!, live)}; remove it first to change it` } };
		const back = chain(current.rules, to.id!, from.id!);
		if (back) return { result: { ok: false, error: `rule would create a dependency cycle: ${[from.id!, ...back].map(id => label(id, live)).join(" -> ")}` } };
		const rule: DepRule = { id: `d${current.nextRuleId}`, from: from.id!, unit: unit.text!, on: "DONE", to: to.id!, prompt: prompt.text!, mode: input.auto ? "auto" : "confirm", once: input.once, enabled: true, createdAt };
		return { state: { ...current, nextRuleId: current.nextRuleId + 1, rules: [...current.rules, rule] }, result: { ok: true, rule } };
	});
}

export type ChangeResult = { ok: true; rule: DepRule; changed: boolean; cancelled?: string[] } | { ok: false; error: string };

function parseId(spec: string, re: RegExp): string | undefined {
	const id = spec.toLowerCase();
	return re.test(id) ? id : undefined;
}

/** Master only. Removing a rule also cancels its triggers that still wait for the user or for a retry. */
export async function removeRule(host: FeatureHost, idSpec: string): Promise<ChangeResult> {
	if (!host.isMaster()) return { ok: false, error: MASTER_ONLY };
	const id = parseId(idSpec, RULE_ID_RE);
	if (!id) return { ok: false, error: `"${idSpec}" is not a rule id (d<number>)` };
	const now = host.now();
	return updateState<DepsState, ChangeResult>(depsFile(host.home), emptyState, validateState, current => {
		const rule = current.rules.find(r => r.id === id);
		if (!rule) return { result: { ok: false, error: `no dependency rule ${id}` } };
		const cancelled = current.ledger.filter(entry => entry.ruleId === id && ["pending", "retry"].includes(kindOf(entry, now))).map(entry => entry.id);
		const ledger = current.ledger.map(entry => (cancelled.includes(entry.id) ? { ...entry, outcome: CANCELLED } : entry));
		return { state: { ...current, rules: current.rules.filter(r => r !== rule), ledger }, result: { ok: true, rule, changed: true, cancelled } };
	});
}

/** Master only. Disabling stops new triggers; triggers already queued stay until approved or rejected. */
export async function setEnabled(host: FeatureHost, idSpec: string, enabled: boolean): Promise<ChangeResult> {
	if (!host.isMaster()) return { ok: false, error: MASTER_ONLY };
	const id = parseId(idSpec, RULE_ID_RE);
	if (!id) return { ok: false, error: `"${idSpec}" is not a rule id (d<number>)` };
	return updateState<DepsState, ChangeResult>(depsFile(host.home), emptyState, validateState, current => {
		const rule = current.rules.find(r => r.id === id);
		if (!rule) return { result: { ok: false, error: `no dependency rule ${id}` } };
		if (rule.enabled === enabled) return { result: { ok: true, rule, changed: false } };
		const next = { ...rule, enabled };
		return { state: { ...current, rules: current.rules.map(r => (r === rule ? next : r)) }, result: { ok: true, rule: next, changed: true } };
	});
}

export type DispatchResult =
	| { status: "refused"; error: string }
	| { status: "delivered" | "not delivered" | "unknown"; trigger: Trigger; rule: DepRule; reason?: string };

/**
 * Deliver one trigger's prompt as an ordinary peer message from this session. The attempt is claimed under the
 * state lock (`sending`) before anything is sent, so two processes can never both send the same trigger; the
 * outcome is written back afterwards. Only `pending` and `not delivered` triggers may be dispatched. Never
 * resumes a paused session: the target's own wake gate still decides.
 */
export async function dispatchTrigger(host: FeatureHost, triggerId: string): Promise<DispatchResult> {
	const attemptedAt = host.now();
	const claim = await updateState<DepsState, { error: string } | { rule: DepRule }>(depsFile(host.home), emptyState, validateState, current => {
		const trigger = current.ledger.find(entry => entry.id === triggerId);
		if (!trigger) return { result: { error: `no trigger ${triggerId}` } };
		const blocked = approveBlock(trigger, attemptedAt);
		if (blocked) return { result: { error: blocked } };
		const rule = current.rules.find(r => r.id === trigger.ruleId);
		if (!rule) return { result: { error: `rule ${trigger.ruleId} no longer exists` } };
		const claimed: Trigger = { ...trigger, outcome: "sending", attemptedAt };
		return { state: { ...current, ledger: current.ledger.map(entry => (entry === trigger ? claimed : entry)) }, result: { rule } };
	});
	if ("error" in claim) return { status: "refused", error: claim.error };
	const { rule } = claim;
	let status: "delivered" | "not delivered" | "unknown";
	let reason: string | undefined;
	let sending = false;
	try {
		const live = await host.peers();
		const blockers = targetBlockers(host, rule, live);
		if (blockers.length) {
			status = "not delivered";
			reason = reasonText(blockers.join("; "));
		} else {
			sending = true;
			const sent = await host.send(rule.to, { text: dispatchText(rule, triggerId) });
			if (sent.status === "delivered") status = "delivered";
			else {
				reason = reasonText(sent.status === "offline" ? "target is not running" : sent.reason);
				status = sent.status === "failed" && ambiguous(reason) ? "unknown" : "not delivered";
			}
		}
	} catch (error) {
		reason = reasonText((error as Error).message);
		status = sending ? "unknown" : "not delivered";
	}
	const outcome = status === "delivered" ? "delivered" : `${status}: ${reason}`;
	const trigger = await updateState<DepsState, Trigger>(depsFile(host.home), emptyState, validateState, current => {
		const entry = current.ledger.find(e => e.id === triggerId)!;
		if (entry.outcome !== "sending" || entry.attemptedAt !== attemptedAt) return { result: entry };
		const done: Trigger = { ...entry, outcome };
		return { state: { ...current, ledger: current.ledger.map(e => (e === entry ? done : e)) }, result: done };
	});
	return { status, trigger, rule, ...(reason ? { reason } : {}) };
}

export type RejectResult = { ok: true; trigger: Trigger } | { ok: false; error: string };

/** Master only. Closes a trigger that waits for the user, retries or has an unknown outcome; sends nothing. */
export async function rejectTrigger(host: FeatureHost, idSpec: string): Promise<RejectResult> {
	if (!host.isMaster()) return { ok: false, error: MASTER_ONLY };
	const id = parseId(idSpec, TRIGGER_ID_RE);
	if (!id) return { ok: false, error: `"${idSpec}" is not a trigger id (t<number>)` };
	const now = host.now();
	return updateState<DepsState, RejectResult>(depsFile(host.home), emptyState, validateState, current => {
		const trigger = current.ledger.find(entry => entry.id === id);
		if (!trigger) return { result: { ok: false, error: `no trigger ${id}` } };
		const kind = kindOf(trigger, now);
		if (kind === "delivered" || kind === "closed") return { result: { ok: false, error: `${id} is ${trigger.outcome}; nothing to reject` } };
		if (kind === "inflight") return { result: { ok: false, error: `${id} is being dispatched right now by another process; it cannot be rejected` } };
		const closed: Trigger = { ...trigger, outcome: "rejected" };
		return { state: { ...current, ledger: current.ledger.map(entry => (entry === trigger ? closed : entry)) }, result: { ok: true, trigger: closed } };
	});
}

// ---- Report hook -------------------------------------------------------------------------------

/**
 * A structured report this session accepted. Acts only when it is the master (one dispatcher, so N receivers
 * never fire the same trigger) and accepts remote requests, and only for DONE (the hook is never called for a
 * subagent's report). Records one ledger entry per matching enabled rule that has not fired for this exact report;
 * `auto` rules then dispatch. Without a matching rule nothing is read for writing and no file is created.
 */
export async function onReport(report: Report, from: { id: string; name: string }, host: FeatureHost): Promise<void> {
	if (report.kind !== "DONE" || !PEER_ID_RE.test(from.id) || !host.isMaster() || !host.acceptsRemote()) return;
	const unit = normalize(report.unit);
	const matches = (rule: DepRule) => rule.enabled && rule.from === from.id && rule.unit === unit;
	if (!readDeps(host).rules.some(matches)) return;
	const key = reportEventKey(from.id, report);
	const firedAt = host.now();
	const fired = await updateState<DepsState, Array<{ trigger: Trigger; rule: DepRule }>>(depsFile(host.home), emptyState, validateState, current => {
		const due = current.rules.filter(rule => matches(rule) && !current.ledger.some(entry => entry.ruleId === rule.id && entry.sourceSession === from.id && entry.reportEventKey === key));
		if (!due.length) return { result: [] };
		const ledger = makeRoom(current.ledger, due.length, firedAt);
		if (!ledger) throw new Error(`dependency ledger is full of ${MAX_LEDGER} unresolved triggers; approve or reject some. The DONE report from ${from.id} was not queued`);
		const triggers = due.map((rule, i): Trigger => ({ id: `t${current.nextTriggerId + i}`, ruleId: rule.id, sourceSession: from.id, reportEventKey: key, firedAt, outcome: "pending" }));
		const rules = current.rules.map(rule => (rule.once && due.includes(rule) ? { ...rule, enabled: false } : rule));
		return { state: { ...current, nextTriggerId: current.nextTriggerId + due.length, rules, ledger: [...ledger, ...triggers] }, result: triggers.map((trigger, i) => ({ trigger, rule: due[i] })) };
	});
	// Auto dispatch never runs inside the report hook: the reporter is acknowledged once the trigger is recorded, so
	// a slow or hung target cannot make it time out and resend. The ledger claim makes the background attempt safe.
	for (const { trigger, rule } of fired) {
		if (rule.mode !== "auto") continue;
		const attempt = dispatchTrigger(host, trigger.id).then(() => undefined, () => undefined);
		inflight.add(attempt);
		void attempt.finally(() => inflight.delete(attempt));
	}
}

const inflight = new Set<Promise<void>>();

/** Resolves once every auto dispatch started by a report has finished (tests and orderly shutdown). */
export async function settled(): Promise<void> {
	await Promise.all([...inflight]);
}

// ---- Presentation ------------------------------------------------------------------------------

async function livePeers(host: FeatureHost): Promise<PeerView[]> {
	try {
		return await host.peers();
	} catch {
		return []; // liveness is informational; the stored rules are what matter
	}
}

const summary = (rule: DepRule, live: PeerView[]): string => `${label(rule.from, live)} DONE "${rule.unit}" -> ${label(rule.to, live)}`;
const flagsOf = (rule: DepRule): string => `${rule.enabled ? "enabled" : "disabled"}, ${rule.mode}, ${rule.once ? "once" : "repeat"}`;

function renderRules(state: DepsState, live: PeerView[]): string {
	if (!state.rules.length) return "no dependency rules";
	return [
		`${state.rules.length} dependency rule${state.rules.length === 1 ? "" : "s"} (at most ${MAX_RULES}); only DONE reports accepted by the master session trigger them; report senders are claimed, not authenticated`,
		...state.rules.flatMap(rule => [`  ${rule.id}  ${flagsOf(rule)}  ${summary(rule, live)}`, `      prompt: ${rule.prompt}`]),
	].join("\n");
}

function triggerLines(entry: Trigger, state: DepsState, live: PeerView[]): string[] {
	const rule = state.rules.find(r => r.id === entry.ruleId);
	const head = `  ${entry.id}  ${entry.outcome}  fired ${new Date(entry.firedAt).toISOString()}`;
	if (!rule) return [`${head}  rule ${entry.ruleId} (removed)`];
	return [`${head}  rule ${rule.id} (${rule.mode}): ${summary(rule, live)}`, `      prompt: ${rule.prompt}`];
}

function renderPending(state: DepsState, live: PeerView[], now: number): string {
	const waiting = state.ledger.filter(entry => ["pending", "retry"].includes(kindOf(entry, now)));
	const unknown = state.ledger.filter(entry => kindOf(entry, now) === "unknown").length;
	const tail = unknown ? [`${unknown} trigger${unknown === 1 ? " has" : "s have"} an unknown outcome and may have been delivered; see /peers deps ledger`] : [];
	if (!waiting.length) return ["no triggers awaiting approval", ...tail].join("\n");
	return [
		`${waiting.length} trigger${waiting.length === 1 ? "" : "s"} awaiting approval; nothing is sent until /peers deps approve <id> (or /peers deps reject <id>)`,
		...waiting.flatMap(entry => triggerLines(entry, state, live)),
		...tail,
	].join("\n");
}

function renderLedger(state: DepsState): string {
	if (!state.ledger.length) return "the dependency ledger is empty";
	const shown = state.ledger.slice(-LEDGER_SHOWN);
	return [
		`dependency ledger: ${state.ledger.length} trigger${state.ledger.length === 1 ? "" : "s"} (at most ${MAX_LEDGER} kept)${shown.length < state.ledger.length ? `, showing the newest ${LEDGER_SHOWN}` : ""}`,
		...shown.map(entry => `  ${entry.id}  ${new Date(entry.firedAt).toISOString()}  rule ${entry.ruleId}  source ${entry.sourceSession}  event ${entry.reportEventKey}  ${entry.outcome}`),
	].join("\n");
}

/**
 * The trigger id this rule would get when a matching DONE report arrives: the hook numbers the triggers of all enabled
 * rules matching one report in rule order, so a rule's id depends on its place among them.
 */
function nextTriggerFor(state: DepsState, rule: DepRule): string {
	const due = state.rules.filter(r => r.enabled && r.from === rule.from && r.unit === rule.unit);
	return `t${state.nextTriggerId + Math.max(0, due.indexOf(rule))}`;
}

/**
 * What dispatching `rule` as trigger `triggerId` would do, computed with the same text, blocker and approve checks as the
 * real dispatch. `entry` is set when previewing an existing trigger. Read-only: sends nothing and wakes nothing.
 */
function renderPreview(host: FeatureHost, rule: DepRule, triggerId: string, entry: Trigger | undefined, live: PeerView[]): string {
	const dispatcher = !host.isMaster()
		? "this session is not the master; only the master session fires triggers"
		: !host.acceptsRemote() ? "this session is the master but refuses or locks remote requests; it ignores reports" : "this session is the master";
	const blockers = targetBlockers(host, rule, live);
	const approval = entry ? approveBlock(entry, host.now()) : undefined;
	const lines = [
		entry ? `preview of trigger ${entry.id} (state: ${entry.outcome}) from rule ${rule.id} (${flagsOf(rule)}): ${summary(rule, live)}` : `preview of rule ${rule.id} (${flagsOf(rule)}): ${summary(rule, live)}`,
		rule.mode === "auto"
			? `when it fires: sent immediately as ${triggerId} when the master accepts a matching DONE report${rule.once ? "; the rule then disables itself" : ""}`
			: `when it fires: queued as ${triggerId}; nothing is sent until /peers deps approve ${triggerId}${rule.once ? "; the rule then disables itself" : ""}`,
		`dispatcher: ${dispatcher}`,
		`to: ${label(rule.to, live)}`,
		`message (one peer message from the dispatching session, exactly):`,
		...dispatchText(rule, triggerId).split("\n").map(line => `  | ${line}`),
		approval
			? `approve would refuse: ${approval}`
			: blockers.length ? `delivery would be blocked: ${blockers.join("; ")} (outcome: not delivered: ${reasonText(blockers.join("; "))})` : "delivery would be attempted; the receiving session's own gates and rate limit still apply",
		"this preview sent nothing and woke nothing",
	];
	return lines.join("\n");
}

async function preview(host: FeatureHost, args: string[]): Promise<string> {
	const state = readDeps(host);
	const live = await livePeers(host);
	const [first, ...rest] = args;
	if (args.length === 1) {
		const triggerId = parseId(first, TRIGGER_ID_RE);
		if (triggerId) {
			const entry = state.ledger.find(e => e.id === triggerId);
			if (!entry) return `error: no trigger ${triggerId}`;
			const rule = state.rules.find(r => r.id === entry.ruleId);
			return rule ? renderPreview(host, rule, entry.id, entry, live) : `error: ${entry.id}'s rule ${entry.ruleId} no longer exists; nothing would be sent`;
		}
		const ruleId = parseId(first, RULE_ID_RE);
		if (!ruleId) return USAGE;
		const rule = state.rules.find(r => r.id === ruleId);
		return rule ? renderPreview(host, rule, nextTriggerFor(state, rule), undefined, live) : `error: no dependency rule ${ruleId}`;
	}
	if (!first || !rest.length) return USAGE;
	const from = resolveKnown(first, live);
	if (!from.id) return `error: from: ${from.error}`;
	const unit = normalize(rest.join(" "));
	const found = state.rules.filter(rule => rule.from === from.id && rule.unit === unit);
	if (!found.length) return `no dependency rule for ${label(from.id, live)} DONE "${unit}"`;
	return found.map(rule => renderPreview(host, rule, nextTriggerFor(state, rule), undefined, live)).join("\n\n");
}

function describeDispatch(result: DispatchResult & { status: "delivered" | "not delivered" | "unknown" }, live: PeerView[]): string {
	const { trigger, rule, reason } = result;
	const target = label(rule.to, live);
	switch (result.status) {
		case "delivered": return `${trigger.id} delivered to ${target}: one peer message from this session carrying rule ${rule.id}'s prompt`;
		case "unknown": return `${trigger.id} outcome unknown: ${reason}; the message may have reached ${target}, so it is not retried. Check the target, then /peers deps reject ${trigger.id} to close it`;
		default: return `${trigger.id} not delivered: ${reason}; nothing reached ${target}${reason?.includes(PAUSED_ERROR) ? " (only that session's own user can /peers resume)" : ""}. Fix the cause and run /peers deps approve ${trigger.id} again, or /peers deps reject ${trigger.id}`;
	}
}

const FLAGS = ["--auto", "--once", "--repeat"];

async function add(host: FeatureHost, rest: string[]): Promise<string> {
	const flags: string[] = [];
	let words = rest;
	while (words.length && FLAGS.includes(words[words.length - 1])) {
		flags.push(words[words.length - 1]);
		words = words.slice(0, -1);
	}
	const [from, ...tail] = words;
	const arrow = tail.indexOf("->");
	if (!from || arrow < 1 || arrow + 2 >= tail.length) return USAGE;
	if (flags.includes("--once") && flags.includes("--repeat")) return "error: choose --once or --repeat, not both";
	const result = await addRule(host, { from, unit: tail.slice(0, arrow).join(" "), to: tail[arrow + 1], prompt: tail.slice(arrow + 2).join(" "), auto: flags.includes("--auto"), once: !flags.includes("--repeat") });
	if (!result.ok) return `error: ${result.error}`;
	const { rule } = result;
	const state = readDeps(host);
	const shown = renderPreview(host, rule, nextTriggerFor(state, rule), undefined, await livePeers(host));
	return [`added ${rule.id}${rule.mode === "auto" ? ": AUTO mode, so a matching DONE report dispatches without asking" : ": confirm mode, so a matching DONE report only queues a trigger for your approval"}`, shown].join("\n");
}

async function command(args: string[], host: FeatureHost): Promise<string> {
	const [sub = "list", ...rest] = args;
	try {
		switch (sub) {
			case "list":
				if (rest.length) return USAGE;
				return renderRules(readDeps(host), await livePeers(host));
			case "add":
				return await add(host, rest);
			case "remove": {
				if (rest.length !== 1) return USAGE;
				const result = await removeRule(host, rest[0]);
				if (!result.ok) return `error: ${result.error}`;
				return `removed ${result.rule.id}${result.cancelled?.length ? `; cancelled ${result.cancelled.join(", ")} (${result.cancelled.length === 1 ? "it was" : "they were"} still waiting)` : ""}`;
			}
			case "enable":
			case "disable": {
				if (rest.length !== 1) return USAGE;
				const result = await setEnabled(host, rest[0], sub === "enable");
				if (!result.ok) return `error: ${result.error}`;
				return result.changed ? `${sub}d ${result.rule.id}${sub === "disable" ? "; triggers already queued stay until approved or rejected" : ""}` : `${result.rule.id} is already ${sub}d`;
			}
			case "preview":
				return await preview(host, rest);
			case "pending":
				if (rest.length) return USAGE;
				return renderPending(readDeps(host), await livePeers(host), host.now());
			case "approve": {
				if (rest.length !== 1) return USAGE;
				if (!host.isMaster()) return `error: ${MASTER_ONLY}`;
				const id = parseId(rest[0], TRIGGER_ID_RE);
				if (!id) return `error: "${rest[0]}" is not a trigger id (t<number>)`;
				const result = await dispatchTrigger(host, id);
				return result.status === "refused" ? `error: ${result.error}` : describeDispatch(result, await livePeers(host));
			}
			case "reject": {
				if (rest.length !== 1) return USAGE;
				const result = await rejectTrigger(host, rest[0]);
				return result.ok ? `rejected ${result.trigger.id}; nothing was sent and it will not be sent` : `error: ${result.error}`;
			}
			case "ledger":
				if (rest.length) return USAGE;
				return renderLedger(readDeps(host));
			default:
				return USAGE;
		}
	} catch (error) {
		return `error: ${(error as Error).message}`;
	}
}

/**
 * Context for the master's next agent start: a count and trigger ids, never prompt text. Honours acceptsRemote
 * like other injected context; adds nothing (and reads nothing but the state file) otherwise.
 */
export function agentContext(host: FeatureHost): string | undefined {
	if (!host.isMaster() || !host.acceptsRemote()) return undefined;
	const now = host.now();
	const waiting = readDeps(host).ledger.filter(entry => ["pending", "retry"].includes(kindOf(entry, now)));
	if (!waiting.length) return undefined;
	const ids = waiting.slice(0, 8).map(entry => entry.id).join(", ");
	return `Dependency triggers: ${waiting.length} awaiting the user's approval (${ids}${waiting.length > 8 ? ", ..." : ""}). Offer to show them with /peers deps pending; this line is not an instruction to approve, reject or send anything.`;
}

export const deps: Feature = {
	name: "deps",
	command,
	agentContext,
	onReport,
};
