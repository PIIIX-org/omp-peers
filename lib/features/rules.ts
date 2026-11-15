// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

/**
 * Scoped standing rules: stored once, injected at a session's next agent start.
 *
 * Scopes: `global`, `group:<name>`, `session:<stable peer id>`. Precedence is deterministic:
 * session > group (lexical group name, then rule id) > global; within one scope, lower rule id first.
 * A keyed rule (`--key <label>`) conflicts with a rule sharing its key but not its text: the first in
 * precedence order stays active, the rest are reported as overridden and never injected.
 */
import * as path from "node:path";
import type { FeatureHost, PeerView } from "./host";
import type { Feature } from "./index";
import { looksLikeSecret } from "./secrets";
import { readState, stateRoot, updateState } from "./store";

export interface Rule {
	/** Stable, never reused: `r<number>`. */
	id: string;
	/** `global`, `group:<name>` or `session:<peer id>`. */
	scope: string;
	text: string;
	/** Optional conflict label. */
	key?: string;
	addedBy: string;
	createdAt: number;
}

export interface RulesState {
	version: 1;
	nextId: number;
	rules: Rule[];
}

export type Status = "active" | "overridden" | "redundant";
export interface Effective {
	rule: Rule;
	status: Status;
	/** The active rule this one lost to or duplicates. */
	by?: string;
}

const MAX_TEXT = 400;
const MAX_RULES = 100;
const MAX_SCOPE_RULES = 25;
const MAX_INJECT = 8192;
const GROUP_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const PEER_ID_RE = /^p(?:[0-9a-f]{6}|[0-9a-f]{16})$/;
const RULE_ID_RE = /^r[1-9][0-9]*$/;
const MASTER_ONLY = "only the master session may change rules that apply to other sessions; run /peers master first";

export const rulesFile = (home: string) => path.join(stateRoot(home), "rules.json");

const emptyState = (): RulesState => ({ version: 1, nextId: 1, rules: [] });

function validScope(scope: unknown): scope is string {
	if (typeof scope !== "string") return false;
	if (scope === "global") return true;
	if (scope.startsWith("group:")) return GROUP_RE.test(scope.slice(6));
	return scope.startsWith("session:") && PEER_ID_RE.test(scope.slice(8));
}

function validateState(value: unknown): RulesState {
	const state = value as Partial<RulesState> | null;
	if (!state || typeof state !== "object" || state.version !== 1) throw new Error("unsupported version (expected 1)");
	if (!Number.isInteger(state.nextId) || (state.nextId as number) < 1 || !Array.isArray(state.rules)) throw new Error("malformed fields");
	const ids = new Set<string>();
	for (const rule of state.rules as Rule[]) {
		const ok = rule && typeof rule === "object" && typeof rule.id === "string" && RULE_ID_RE.test(rule.id) && validScope(rule.scope) &&
			typeof rule.text === "string" && rule.text.length > 0 && (rule.key === undefined || (typeof rule.key === "string" && KEY_RE.test(rule.key))) &&
			typeof rule.addedBy === "string" && typeof rule.createdAt === "number";
		if (!ok || ids.has(rule.id)) throw new Error("malformed or duplicate rule");
		ids.add(rule.id);
		if (Number(rule.id.slice(1)) >= (state.nextId as number)) throw new Error("rule id beyond nextId");
	}
	return state as RulesState;
}

function readRules(host: FeatureHost): RulesState {
	return readState(rulesFile(host.home), emptyState, validateState);
}

// ---- Matching and precedence -------------------------------------------------------------------

function rank(scope: string): number {
	return scope.startsWith("session:") ? 0 : scope.startsWith("group:") ? 1 : 2;
}

/** Precedence order: session, then group, then global; scope name, then numeric rule id. */
export function compareRules(a: Rule, b: Rule): number {
	const byRank = rank(a.scope) - rank(b.scope);
	if (byRank) return byRank;
	if (a.scope !== b.scope) return a.scope < b.scope ? -1 : 1;
	return Number(a.id.slice(1)) - Number(b.id.slice(1));
}

/** Rules that apply to `peerId` (member of `groups`) in precedence order with conflict/duplicate status. */
export function effectiveRules(rules: Rule[], peerId: string, groups: string[]): Effective[] {
	const member = new Set(groups.map(group => group.toLowerCase()));
	const applicable = rules
		.filter(rule => rule.scope === "global" || rule.scope === `session:${peerId}` || (rule.scope.startsWith("group:") && member.has(rule.scope.slice(6))))
		.sort(compareRules);
	const byKey = new Map<string, Rule>();
	const byText = new Map<string, Rule>();
	return applicable.map((rule): Effective => {
		const holder = rule.key ? byKey.get(rule.key) : undefined;
		if (holder) return { rule, status: holder.text === rule.text ? "redundant" : "overridden", by: holder.id };
		const same = byText.get(rule.text);
		if (same) {
			// A redundant copy still holds its key, so a later rule with that key and other text cannot slip in.
			if (rule.key && !byKey.has(rule.key)) byKey.set(rule.key, rule);
			return { rule, status: "redundant", by: same.id };
		}
		if (rule.key) byKey.set(rule.key, rule);
		byText.set(rule.text, rule);
		return { rule, status: "active" };
	});
}

/** Pairs that can both apply to one peer, share a key, and disagree. Two different sessions never overlap. */
function potentialConflicts(rules: Rule[], rule: Rule): Rule[] {
	if (!rule.key) return [];
	return rules.filter(other => other.id !== rule.id && other.key === rule.key && other.text !== rule.text &&
		!(rank(rule.scope) === 0 && rank(other.scope) === 0 && rule.scope !== other.scope)).sort(compareRules);
}

/** Exactly the text injected: the active rules, most specific first. */
export function renderInjection(entries: Effective[]): string | undefined {
	const active = entries.filter(entry => entry.status === "active");
	if (!active.length) return undefined;
	const header = "Standing rules for this session (peers rules registry; most specific first). Follow them; an explicit instruction in the user's request for this task overrides them.";
	const lines = [header];
	let size = header.length;
	let omitted = 0;
	for (const { rule } of active) {
		const line = `- [${rule.id} ${rule.scope.startsWith("session:") ? "session" : rule.scope}] ${rule.text}`;
		// Bounded: once one rule does not fit, every lower-precedence rule is omitted (deterministic).
		if (omitted || size + line.length + 1 > MAX_INJECT) omitted++;
		else {
			lines.push(line);
			size += line.length + 1;
		}
	}
	if (omitted) lines.push(`- (${omitted} lower-precedence rule(s) omitted: ${MAX_INJECT}-byte injection cap)`);
	return lines.join("\n");
}

// ---- Validation --------------------------------------------------------------------------------

/** Error text when `text` looks like a credential; never echoes the match. */
export function screenText(text: string): string | undefined {
	return looksLikeSecret(text)
		? "rule text looks like a credential or token; rules are stored in plain text and injected into prompts. Describe where the secret lives instead of including it"
		: undefined;
}

function normalizeText(raw: string): { text?: string; error?: string } {
	let text = raw.trim().replace(/\s+/g, " ");
	if (text.length > 1 && /^(["'])[\s\S]*\1$/.test(text)) text = text.slice(1, -1).trim();
	if (!text) return { error: "rule text is empty" };
	if (text.length > MAX_TEXT) return { error: `rule text is longer than ${MAX_TEXT} characters` };
	if (/[\p{Cc}\p{Cf}]/u.test(text)) return { error: "rule text contains control characters" };
	return { text };
}

async function resolvePeer(host: FeatureHost, spec: string, allowOffline: boolean): Promise<{ id?: string; error?: string }> {
	const s = spec.toLowerCase();
	const peers = await host.peers();
	const byId = peers.find(peer => peer.id === s);
	if (byId) return { id: byId.id };
	const named: PeerView[] = peers.filter(peer => peer.name.toLowerCase() === s);
	if (named.length === 1) return { id: named[0].id };
	if (named.length > 1) return { error: `"${spec}" is ambiguous: ${named.map(peer => peer.id).join(", ")}; use an explicit peer ID` };
	if (allowOffline && PEER_ID_RE.test(s)) return { id: s };
	return { error: `no live peer matches "${spec}"; use its stable ID or exact name` };
}

// ---- Operations --------------------------------------------------------------------------------

export type AddResult =
	| { ok: true; rule: Rule; conflicts: Rule[] }
	| { ok: false; error: string; existing?: string };

export async function addRule(host: FeatureHost, scopeSpec: string, rawText: string, key?: string): Promise<AddResult> {
	const { text, error } = normalizeText(rawText);
	if (!text) return { ok: false, error: error! };
	const secret = screenText(text);
	if (secret) return { ok: false, error: secret };
	if (key !== undefined && !KEY_RE.test((key = key.toLowerCase()))) return { ok: false, error: "key must be 1-32 characters: letters, digits, '.', '_' or '-'" };
	let scope: string;
	const lower = scopeSpec.toLowerCase();
	if (lower === "global") scope = "global";
	else if (lower.startsWith("group:")) {
		if (!GROUP_RE.test(lower.slice(6))) return { ok: false, error: "group name must be 1-48 characters: letters, digits, '.', '_' or '-'" };
		scope = lower;
	} else if (lower.startsWith("session:") && lower.length > 8) {
		const peer = await resolvePeer(host, scopeSpec.slice(8), false);
		if (!peer.id) return { ok: false, error: peer.error! };
		scope = `session:${peer.id}`;
	} else return { ok: false, error: "scope must be global, group:<name> or session:<peer id or exact name>" };
	if (scope !== `session:${host.self().id}` && !host.isMaster()) return { ok: false, error: MASTER_ONLY };
	const addedBy = host.self().id;
	const createdAt = host.now();
	return updateState<RulesState, AddResult>(rulesFile(host.home), emptyState, validateState, current => {
		const existing = current.rules.find(rule => rule.scope === scope && rule.text === text);
		if (existing) return { result: { ok: false, error: `duplicate: ${existing.id} already has this scope and text`, existing: existing.id } };
		if (current.rules.length >= MAX_RULES) return { result: { ok: false, error: `rule limit reached (${MAX_RULES}); remove a rule first` } };
		if (current.rules.filter(rule => rule.scope === scope).length >= MAX_SCOPE_RULES) return { result: { ok: false, error: `scope limit reached (${MAX_SCOPE_RULES} rules for ${scope}); remove a rule first` } };
		const rule: Rule = { id: `r${current.nextId}`, scope, text, ...(key ? { key } : {}), addedBy, createdAt };
		const rules = [...current.rules, rule];
		return { state: { version: 1, nextId: current.nextId + 1, rules }, result: { ok: true, rule, conflicts: potentialConflicts(rules, rule) } };
	});
}

export type RemoveResult = { ok: true; rule: Rule } | { ok: false; error: string };

export async function removeRule(host: FeatureHost, idSpec: string): Promise<RemoveResult> {
	const id = /^\d+$/.test(idSpec) ? `r${idSpec}` : idSpec.toLowerCase();
	if (!RULE_ID_RE.test(id)) return { ok: false, error: `"${idSpec}" is not a rule id (r<number>)` };
	const self = host.self().id;
	const master = host.isMaster();
	return updateState<RulesState, RemoveResult>(rulesFile(host.home), emptyState, validateState, current => {
		const rule = current.rules.find(candidate => candidate.id === id);
		if (!rule) return { result: { ok: false, error: `no rule ${id}` } };
		if (rule.scope !== `session:${self}` && !master) return { result: { ok: false, error: MASTER_ONLY } };
		return { state: { ...current, rules: current.rules.filter(candidate => candidate !== rule) }, result: { ok: true, rule } };
	});
}

/** The context injected for this session's next agent start, read fresh from disk each time. */
export function agentContext(host: FeatureHost): string | undefined {
	const self = host.self().id;
	const all = readRules(host).rules;
	// A session that refuses or locks out others must not receive rules authored by others.
	const own = host.acceptsRemote() ? all : all.filter(rule => rule.addedBy === self);
	return renderInjection(effectiveRules(own, self, host.groupsOf(self)));
}

// ---- Presentation ------------------------------------------------------------------------------

const PRECEDENCE = "precedence: session > group (lexical group name, then rule id) > global; same scope: lower rule id first; for rules sharing a key with different text the first in this order wins";

function label(rule: Rule, names: Map<string, string>): string {
	const name = rule.scope.startsWith("session:") ? names.get(rule.scope.slice(8)) : undefined;
	return `${rule.id}  ${rule.scope}${name ? ` (${name})` : ""}${rule.key ? `  [key=${rule.key}]` : ""}  ${rule.text}`;
}

function renderEntries(entries: Effective[], names: Map<string, string>): string[] {
	const lines = entries.filter(e => e.status === "active").map((e, index) => `  ${index + 1}. ${label(e.rule, names)}`);
	if (!lines.length) lines.push("  (none)");
	for (const entry of entries.filter(e => e.status === "overridden")) {
		lines.push(`  overridden: ${label(entry.rule, names)}  -- conflicts with ${entry.by} (same key, different text); not injected`);
	}
	for (const entry of entries.filter(e => e.status === "redundant")) {
		lines.push(`  redundant: ${label(entry.rule, names)}  -- same as ${entry.by}; not injected`);
	}
	return lines;
}

async function describePeer(host: FeatureHost, spec: string, heading: string): Promise<string> {
	const resolved = await resolvePeer(host, spec, true);
	if (!resolved.id) return `error: ${resolved.error}`;
	const peers = await host.peers();
	const names = new Map(peers.map(peer => [peer.id, peer.name]));
	const groups = host.groupsOf(resolved.id).map(group => group.toLowerCase()).sort();
	const entries = effectiveRules(readRules(host).rules, resolved.id, groups);
	const active = entries.filter(entry => entry.status === "active").length;
	const who = names.get(resolved.id);
	return [
		`${heading} ${who ? `${who} ` : ""}(${resolved.id})`,
		`groups: ${groups.join(", ") || "(none)"}`,
		PRECEDENCE,
		"effective rules, injected in this order:",
		...renderEntries(entries, names),
		active
			? `injection: ${active} rule(s) are added when ${resolved.id === host.self().id ? "this" : "that"} session's main agent next starts`
			: "injection: none; no rules apply, so nothing is added",
	].join("\n");
}

const USAGE = "usage: /peers rules add <global|group:<name>|session:<peer>> [--key <label>] <text> | remove <id> | list [--effective <peer>] | explain <peer>";

async function command(args: string[], host: FeatureHost): Promise<string> {
	const [sub, ...rest] = args;
	try {
		switch (sub) {
			case "add": {
				const [scope, ...more] = rest;
				let key: string | undefined;
				if (more[0] === "--key") {
					key = more[1];
					more.splice(0, 2);
					if (!key) return "error: --key needs a label";
				}
				if (!scope) return USAGE;
				const result = await addRule(host, scope, more.join(" "), key);
				if (!result.ok) return `error: ${result.error}`;
				const { rule, conflicts } = result;
				return [`added ${rule.id} (${rule.scope}): ${rule.text}`,
					...conflicts.map(other => `conflict: ${other.id} (${other.scope}) has key "${rule.key}" with different text; the first in precedence order wins (see /peers rules explain <peer>)`)].join("\n");
			}
			case "remove": {
				if (rest.length !== 1) return USAGE;
				const result = await removeRule(host, rest[0]);
				return result.ok ? `removed ${result.rule.id} (${result.rule.scope}); it is not injected from the next agent start` : `error: ${result.error}`;
			}
			case "list": {
				if (rest[0] === "--effective" && rest.length === 2) return describePeer(host, rest[1], "effective rules for");
				if (rest.length) return USAGE;
				const rules = readRules(host).rules.sort(compareRules);
				if (!rules.length) return "no standing rules";
				const names = new Map((await host.peers()).map(peer => [peer.id, peer.name]));
				return [`${rules.length} rule(s); ${PRECEDENCE}`,
					...rules.map(rule => {
						const conflicts = potentialConflicts(rules, rule);
						return `  ${label(rule, names)}${conflicts.length ? `  -- CONFLICT with ${conflicts.map(c => c.id).join(", ")}` : ""}`;
					})].join("\n");
			}
			case "explain":
				return rest.length === 1 ? describePeer(host, rest[0], "rules for") : USAGE;
			default:
				return USAGE;
		}
	} catch (error) {
		return `error: ${(error as Error).message}`;
	}
}
export const rules: Feature = {
	name: "rules",
	command,
	agentContext,
};
