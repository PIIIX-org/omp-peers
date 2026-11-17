// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

/**
 * Per-session token usage and estimated cost, private by default.
 *
 * Source: only the host's numeric aggregate `sessionManager.getUsageStatistics()` (running totals the host
 * keeps itself). No message, tool output or prompt text is read, no provider request is made, no transcript
 * is iterated. A session publishes its counters into its registry row only after its own user ran
 * `/peers usage on`; every other session stays `unknown`, never zero. Every amount is labelled `estimate`: with
 * `catalog` pricing it is the host's own running catalog-price cost (published as a number), with `custom` pricing the
 * READER prices the published token counts at read time. `billed` is always `unknown`: the host's aggregates do not
 * separate a provider-billed amount from a catalog calculation (OpenRouter-style reported charges are folded in).
 *
 * `usageSummary` and `formatUsage` are pure so a later digest can reuse them.
 */
import * as path from "node:path";
import type { FeatureHost } from "./host";
import type { Feature } from "./index";
import { GROUP_RE } from "./rules";
import { readState, stateRoot, updateState } from "./store";
import { MAX_SELECTOR } from "./templates";

export const BASIS = "host-session-totals";
export const COUNTERS = ["input", "output", "cacheRead", "cacheWrite"] as const;
export type Counter = (typeof COUNTERS)[number];

export const MAX_PUBLISHERS = 64;
export const MAX_PRICES = 32;
export const MAX_GROUPS = 16;
/** A registry row older than this is labelled `stale`. */
export const STALE_MS = 60_000;
/** Largest token counter or per-million price accepted from a registry row or the command line. */
export const MAX_TOKENS = 1e15;
export const MAX_PRICE_PER_M = 1e6;
export const MAX_RATE = 1e6;
/** Largest cost the host reports that is accepted, and the largest amount ever displayed. */
export const MAX_MONEY = 1e15;
const MAX_NAME = 48;
const MAX_MODEL = 80;
const PEER_ID_RE = /^p(?:[0-9a-f]{6}|[0-9a-f]{16})$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const DECIMAL_RE = /^\d{1,15}(?:\.\d{1,12})?$/;
const MASTER_ONLY = "only the master session lists other sessions' usage; run /peers master first (this session's own figures: /peers usage status)";
const BILLED = "billed: unknown (host aggregates do not separate billed amounts from estimates)";

// ---- Stored configuration ---------------------------------------------------------------------

/** Per-million-token prices in USD for one model. Cache prices are optional; a missing one makes cost unknown only when that counter is non-zero. */
export interface ModelPrice {
	inPerM: number;
	outPerM: number;
	cacheReadPerM?: number;
	cacheWritePerM?: number;
}

export interface UsageConfig {
	version: 1;
	/** Stable ids of the sessions whose own user turned publishing on. Everything else publishes nothing. */
	publishers: string[];
	/** Display label for amounts. */
	currency: string;
	/** Multiplier from USD to `currency`, set by the user; required exactly when `currency` is not USD. No network lookup. */
	rate?: number;
	/** `catalog`: the host's per-call catalog-price cost; `custom`: the `prices` table applied to published token counts. */
	pricing: "catalog" | "custom";
	/** Model selector (as published: `provider/id`, or a bare id) -> USD per million tokens. */
	prices: Record<string, ModelPrice>;
	/** Scope: only sessions in one of these groups are listed. Empty means every session. */
	groups: string[];
}

export const usageFile = (home: string) => path.join(stateRoot(home), "usage.json");

const emptyConfig = (): UsageConfig => ({ version: 1, publishers: [], currency: "USD", pricing: "catalog", prices: {}, groups: [] });

function boundedNumber(value: unknown, min: number, max: number, minExclusive = false): value is number {
	return typeof value === "number" && Number.isFinite(value) && (minExclusive ? value > min : value >= min) && value <= max;
}

function validateModelKey(key: string): boolean {
	return key.length >= 1 && key.length <= MAX_SELECTOR && !/[\s\p{Cc}\p{Cf}]/u.test(key);
}

function validateConfig(value: unknown): UsageConfig {
	const config = value as Partial<UsageConfig> | null;
	if (!config || typeof config !== "object" || config.version !== 1) throw new Error("unsupported version (expected 1)");
	const { publishers, currency, rate, pricing, prices, groups } = config;
	if (!Array.isArray(publishers) || publishers.length > MAX_PUBLISHERS || new Set(publishers).size !== publishers.length ||
		!publishers.every(id => typeof id === "string" && PEER_ID_RE.test(id))) throw new Error("malformed publishers");
	if (typeof currency !== "string" || !CURRENCY_RE.test(currency)) throw new Error("malformed currency");
	if (currency === "USD" ? rate !== undefined : !boundedNumber(rate, 0, MAX_RATE, true)) throw new Error("malformed rate (required exactly when the currency is not USD)");
	if (pricing !== "catalog" && pricing !== "custom") throw new Error("malformed pricing");
	if (!prices || typeof prices !== "object" || Array.isArray(prices)) throw new Error("malformed prices");
	const entries = Object.entries(prices);
	if (entries.length > MAX_PRICES) throw new Error(`more than ${MAX_PRICES} prices`);
	for (const [model, price] of entries) {
		const p = price as Partial<ModelPrice> | null;
		const ok = validateModelKey(model) && p && typeof p === "object" && boundedNumber(p.inPerM, 0, MAX_PRICE_PER_M) && boundedNumber(p.outPerM, 0, MAX_PRICE_PER_M) &&
			(p.cacheReadPerM === undefined || boundedNumber(p.cacheReadPerM, 0, MAX_PRICE_PER_M)) &&
			(p.cacheWritePerM === undefined || boundedNumber(p.cacheWritePerM, 0, MAX_PRICE_PER_M)) &&
			Object.keys(p).every(k => k === "inPerM" || k === "outPerM" || k === "cacheReadPerM" || k === "cacheWritePerM");
		if (!ok) throw new Error(`malformed price for "${model.slice(0, 48)}"`);
	}
	if (!Array.isArray(groups) || groups.length > MAX_GROUPS || new Set(groups).size !== groups.length || !groups.every(g => typeof g === "string" && GROUP_RE.test(g))) {
		throw new Error("malformed groups");
	}
	return config as UsageConfig;
}

/** The configuration, read fresh from disk. Throws when the file is unreadable or invalid. */
export function readConfig(home: string): UsageConfig {
	return readState(usageFile(home), emptyConfig, validateConfig);
}

/** Whether session `peerId` publishes usage. An unreadable or invalid file means no: private is the failure mode. */
export function isPublishing(home: string, peerId: string): boolean {
	try {
		return readConfig(home).publishers.includes(peerId);
	} catch {
		return false;
	}
}

export type ChangeResult<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

function change<T>(home: string, fn: (config: UsageConfig) => { config?: UsageConfig; result: ChangeResult<T> }): Promise<ChangeResult<T>> {
	return updateState<UsageConfig, ChangeResult<T>>(usageFile(home), emptyConfig, validateConfig, current => {
		const out = fn(current);
		return { state: out.config, result: out.result };
	});
}

/**
 * Turn publication of session `peerId` on or off. When the list is full, entries for sessions that are not
 * running (`live`) are dropped first; a dropped session simply publishes nothing until its user turns it on again.
 */
export async function setPublishing(home: string, peerId: string, on: boolean, live: ReadonlySet<string>): Promise<ChangeResult<{ changed: boolean }>> {
	if (!PEER_ID_RE.test(peerId)) return { ok: false, error: "session identity unavailable" };
	return change<{ changed: boolean }>(home, config => {
		const has = config.publishers.includes(peerId);
		if (has === on) return { result: { ok: true, changed: false } };
		if (!on) return { config: { ...config, publishers: config.publishers.filter(id => id !== peerId) }, result: { ok: true, changed: true } };
		let publishers = config.publishers;
		if (publishers.length >= MAX_PUBLISHERS) publishers = publishers.filter(id => live.has(id));
		if (publishers.length >= MAX_PUBLISHERS) return { result: { ok: false, error: `publisher limit reached (${MAX_PUBLISHERS} running sessions publish); run /peers usage off in one of them first` } };
		return { config: { ...config, publishers: [...publishers, peerId].sort() }, result: { ok: true, changed: true } };
	});
}

function parseDecimal(raw: string | undefined, label: string, max: number, exclusiveZero = false): { value?: number; error?: string } {
	if (raw === undefined || !DECIMAL_RE.test(raw)) return { error: `${label} must be a plain decimal number such as 3 or 0.25 (no sign, exponent or separator)` };
	const value = Number(raw);
	if (exclusiveZero && value === 0) return { error: `${label} must be greater than 0` };
	if (value > max) return { error: `${label} must be at most ${max}` };
	return { value };
}

/** `currency` is a three-letter label; any code but USD needs `rate`, the user's own USD multiplier (no network lookup). */
export async function setCurrency(home: string, rawCurrency: string, rawRate?: string): Promise<ChangeResult<{ currency: string; rate?: number }>> {
	const currency = rawCurrency.toUpperCase();
	if (!CURRENCY_RE.test(currency)) return { ok: false, error: "currency must be a three-letter code such as USD or EUR" };
	let rate: number | undefined;
	if (currency === "USD") {
		if (rawRate !== undefined) return { ok: false, error: "USD needs no rate; amounts are computed in USD" };
	} else {
		if (rawRate === undefined) return { ok: false, error: `${currency} needs a rate: /peers usage set currency ${currency} <USD-to-${currency} multiplier> (no exchange rate is looked up)` };
		const parsed = parseDecimal(rawRate, "rate", MAX_RATE, true);
		if (parsed.value === undefined) return { ok: false, error: parsed.error! };
		rate = parsed.value;
	}
	return change<{ currency: string; rate?: number }>(home, config => {
		const next: UsageConfig = { ...config, currency, rate };
		if (rate === undefined) delete next.rate;
		return { config: next, result: { ok: true, currency, ...(rate === undefined ? {} : { rate }) } };
	});
}

export async function setPricing(home: string, pricing: string): Promise<ChangeResult<{ pricing: UsageConfig["pricing"] }>> {
	if (pricing !== "catalog" && pricing !== "custom") return { ok: false, error: "pricing must be catalog or custom" };
	return change<{ pricing: UsageConfig["pricing"] }>(home, config => ({ config: { ...config, pricing }, result: { ok: true, pricing } }));
}

/** Scope to `names` (lower-cased group names); an empty list means every session. */
export async function setGroups(home: string, names: string[]): Promise<ChangeResult<{ groups: string[] }>> {
	const groups = [...new Set(names.map(name => name.toLowerCase()))].sort();
	if (groups.length > MAX_GROUPS) return { ok: false, error: `at most ${MAX_GROUPS} groups` };
	if (!groups.every(name => GROUP_RE.test(name))) return { ok: false, error: "group name must be 1-48 characters: lower-case letters, digits, '.', '_' or '-', starting with a letter or digit" };
	return change<{ groups: string[] }>(home, config => ({ config: { ...config, groups }, result: { ok: true, groups } }));
}

export async function setPrice(home: string, rawModel: string, rawIn: string | undefined, rawOut: string | undefined, rawCacheRead?: string, rawCacheWrite?: string): Promise<ChangeResult<{ model: string; replaced: boolean }>> {
	if (!validateModelKey(rawModel)) return { ok: false, error: `model must be 1-${MAX_SELECTOR} characters without whitespace or control characters` };
	const price: Partial<ModelPrice> = {};
	for (const [key, raw, label] of [["inPerM", rawIn, "input price"], ["outPerM", rawOut, "output price"], ["cacheReadPerM", rawCacheRead, "cache-read price"], ["cacheWritePerM", rawCacheWrite, "cache-write price"]] as const) {
		if (raw === undefined && (key === "cacheReadPerM" || key === "cacheWritePerM")) continue;
		const parsed = parseDecimal(raw, label, MAX_PRICE_PER_M);
		if (parsed.value === undefined) return { ok: false, error: parsed.error! };
		price[key] = parsed.value;
	}
	return change<{ model: string; replaced: boolean }>(home, config => {
		const replaced = Object.hasOwn(config.prices, rawModel);
		if (!replaced && Object.keys(config.prices).length >= MAX_PRICES) return { result: { ok: false, error: `price limit reached (${MAX_PRICES}); remove one with /peers usage unprice <model>` } };
		return { config: { ...config, prices: { ...config.prices, [rawModel]: price as ModelPrice } }, result: { ok: true, model: rawModel, replaced } };
	});
}

export async function removePrice(home: string, model: string): Promise<ChangeResult> {
	return change<unknown>(home, config => {
		if (!Object.hasOwn(config.prices, model)) return { result: { ok: false, error: `no custom price for "${safeText(model, MAX_MODEL)}"` } };
		const prices = { ...config.prices };
		delete prices[model];
		return { config: { ...config, prices }, result: { ok: true } };
	});
}

// ---- What a session publishes ------------------------------------------------------------------

/** What the extension reads from the host for this session. Everything is unvalidated host output; `snapshotUsage` checks it. */
export interface UsageSource {
	/** `sessionManager.getUsageStatistics()`: numeric running totals only. Undefined when the host lacks it. */
	stats?: unknown;
	/** Canonical `provider/id` of the current model. */
	model?: string;
	/** Whether the host says the current model's provider is used through a subscription login. Undefined when unknown. */
	subscription?: boolean;
	/** Session header creation time (ISO): where the cumulative totals start. */
	since?: string;
	/** The session was forked from another one, so its totals include tokens copied from the parent's history. */
	forked?: boolean;
}

/** The registry row's `usage` value: only numbers and short labels. Absent fields are unknown, never zero. */
export interface PublishedUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	/** Host-computed cost of all counted calls at catalog prices (USD, per-call prices at call time). Not a billed amount. */
	catalogCost?: number;
	model?: string;
	subscription?: boolean;
	forked?: boolean;
	basis: typeof BASIS;
	since?: string;
}

/** A finite number in [0, max], else undefined (wrong types, NaN, negatives and huge values are unknown). */
export function cleanNumber(value: unknown, max = MAX_TOKENS): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : undefined;
}

export function safeText(value: unknown, max: number): string {
	const text = String(value ?? "").replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const cleanIso = (value: unknown): string | undefined => typeof value === "string" && ISO_RE.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;

/** The published form of `source`, or undefined when the host reported no usable counters. */
export function snapshotUsage(source: UsageSource): PublishedUsage | undefined {
	const stats = source.stats && typeof source.stats === "object" ? source.stats as Record<string, unknown> : undefined;
	if (!stats) return undefined;
	const usage: PublishedUsage = { basis: BASIS };
	let any = false;
	for (const counter of COUNTERS) {
		const value = cleanNumber(stats[counter]);
		if (value !== undefined) {
			usage[counter] = value;
			any = true;
		}
	}
	if (!any) return undefined;
	const catalogCost = cleanNumber(stats.cost, MAX_MONEY);
	if (catalogCost !== undefined) usage.catalogCost = catalogCost;
	if (typeof source.model === "string" && source.model) usage.model = safeText(source.model, MAX_MODEL);
	if (typeof source.subscription === "boolean") usage.subscription = source.subscription;
	if (source.forked === true) usage.forked = true;
	const since = cleanIso(source.since);
	if (since) usage.since = since;
	return usage;
}

/**
 * The `usage` value for this session's registry row: undefined (nothing published) unless its own user ran
 * `/peers usage on`. `source` is only called when publishing, so a private session never even reads the counters.
 */
export function usageForRegistry(home: string, peerId: string, source: () => UsageSource | undefined): PublishedUsage | undefined {
	if (!isPublishing(home, peerId)) return undefined;
	const read = source();
	return read ? snapshotUsage(read) : undefined;
}

// ---- Reading and costing -------------------------------------------------------------------------

/** A registry `usage` value as the reader trusts it after validation. */
export interface ReadUsage {
	counters: Partial<Record<Counter, number>>;
	catalogCost?: number;
	model?: string;
	subscription?: boolean;
	forked?: boolean;
	since?: string;
}

/** Validate a published value of unknown provenance. Undefined means unknown: wrong shape, another basis or no usable counter. */
export function readUsage(raw: unknown): ReadUsage | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const row = raw as Record<string, unknown>;
	if (row.basis !== BASIS) return undefined;
	const counters: Partial<Record<Counter, number>> = {};
	for (const counter of COUNTERS) {
		const value = cleanNumber(row[counter]);
		if (value !== undefined) counters[counter] = value;
	}
	if (!Object.keys(counters).length) return undefined;
	const usage: ReadUsage = { counters };
	const catalogCost = cleanNumber(row.catalogCost, MAX_MONEY);
	if (catalogCost !== undefined) usage.catalogCost = catalogCost;
	if (typeof row.model === "string" && row.model) usage.model = safeText(row.model, MAX_MODEL);
	if (typeof row.subscription === "boolean") usage.subscription = row.subscription;
	if (row.forked === true) usage.forked = true;
	const since = cleanIso(row.since);
	if (since) usage.since = since;
	return usage;
}

function priceFor(prices: UsageConfig["prices"], model: string | undefined): ModelPrice | undefined {
	if (!model) return undefined;
	if (Object.hasOwn(prices, model)) return prices[model];
	const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : undefined;
	return bare && Object.hasOwn(prices, bare) ? prices[bare] : undefined;
}

export type Estimate = { ok: true; usd: number } | { ok: false; reason: string };

/** Estimated cost in USD of `usage` under the configured pricing source. Unknown inputs give a reason, never zero. */
export function estimateUsd(usage: ReadUsage, config: Pick<UsageConfig, "pricing" | "prices">): Estimate {
	if (config.pricing === "catalog") {
		if (usage.catalogCost === undefined) return { ok: false, reason: "the host reported no catalog cost" };
		// The host total is 0 both for a free model and for one with no catalog price: with tokens spent that is not a known cost.
		if (usage.catalogCost === 0 && COUNTERS.some(counter => (usage.counters[counter] ?? 0) > 0)) {
			return { ok: false, reason: "host catalog cost is 0 for non-zero tokens (no catalog price, or a free model)" };
		}
		return { ok: true, usd: usage.catalogCost };
	}
	const price = priceFor(config.prices, usage.model);
	if (!price) return { ok: false, reason: usage.model ? `no custom price for ${usage.model}` : "the session published no model to price" };
	const rates: Record<Counter, number | undefined> = { input: price.inPerM, output: price.outPerM, cacheRead: price.cacheReadPerM, cacheWrite: price.cacheWritePerM };
	let usd = 0;
	for (const counter of COUNTERS) {
		const tokens = usage.counters[counter];
		if (tokens === undefined) return { ok: false, reason: `${counter} tokens unknown` };
		if (tokens === 0) continue;
		const rate = rates[counter];
		if (rate === undefined) return { ok: false, reason: `custom price for ${usage.model} has no ${counter} rate` };
		usd += (tokens * rate) / 1e6;
	}
	return { ok: true, usd };
}

export interface UsagePeer {
	id: string;
	name: string;
	/** Unvalidated registry `usage` value. */
	usage?: unknown;
	/** Registry row time (ISO), for staleness. */
	updatedAt?: string;
}

export interface UsageRow {
	id: string;
	name: string;
	usage?: ReadUsage;
	/** The row is older than STALE_MS (or has no valid time). */
	stale: boolean;
	/** Estimated cost in the display currency, when it could be computed. */
	estimate?: number;
	/** Why `estimate` is unknown. */
	estimateReason?: string;
	/** Every counter published and valid: the row counts in the token totals. */
	complete: boolean;
}

export interface UsageSummary {
	rows: UsageRow[];
	/** Logical sessions considered (each id once). */
	sessions: number;
	/** Sessions whose four counters are all known. */
	covered: number;
	/** Sessions that are not covered: nothing published, or counters missing. */
	unknown: number;
	/** Sum over covered sessions only; undefined when none is covered. */
	tokens?: Record<Counter, number>;
	/** Sum of known estimates in the display currency, over `estimated` sessions. */
	estimate?: number;
	estimated: number;
	/** Part of `estimate` from sessions the host says use a subscription login: an equivalent, not a charge. */
	subscriptionEstimate: number;
	stale: number;
	forked: number;
}

const rowAge = (peer: UsagePeer, now: number): number | undefined => {
	const t = peer.updatedAt === undefined ? NaN : Date.parse(peer.updatedAt);
	return Number.isFinite(t) ? now - t : undefined;
};

/**
 * Pure aggregation of registry rows. Each logical session id is counted once even if it appears several times
 * (the row with figures and the newest time wins); a session that published nothing is unknown, never zero.
 * `rate` converts USD to the display currency.
 */
export function usageSummary(peers: readonly UsagePeer[], config: UsageConfig, now: number): UsageSummary {
	const best = new Map<string, UsagePeer>();
	for (const peer of peers) {
		const current = best.get(peer.id);
		if (!current) {
			best.set(peer.id, peer);
			continue;
		}
		const a = readUsage(peer.usage) !== undefined, b = readUsage(current.usage) !== undefined;
		const ta = Date.parse(peer.updatedAt ?? ""), tb = Date.parse(current.updatedAt ?? "");
		if ((a && !b) || (a === b && Number.isFinite(ta) && (!Number.isFinite(tb) || ta > tb))) best.set(peer.id, peer);
	}
	const rate = config.rate ?? 1;
	const rows: UsageRow[] = [...best.values()].sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id)).map(peer => {
		const usage = readUsage(peer.usage);
		const age = rowAge(peer, now);
		const row: UsageRow = { id: peer.id, name: safeText(peer.name, MAX_NAME), usage, stale: age === undefined || age > STALE_MS, complete: !!usage && COUNTERS.every(c => usage.counters[c] !== undefined) };
		if (usage) {
			const est = estimateUsd(usage, config);
			if (!est.ok) row.estimateReason = est.reason;
			else if (est.usd * rate > MAX_MONEY) row.estimateReason = "estimate exceeds the displayable maximum";
			else row.estimate = est.usd * rate;
		}
		return row;
	});
	const covered = rows.filter(r => r.complete);
	const priced = rows.filter(r => r.estimate !== undefined);
	return {
		rows,
		sessions: rows.length,
		covered: covered.length,
		unknown: rows.length - covered.length,
		tokens: covered.length ? Object.fromEntries(COUNTERS.map(c => [c, covered.reduce((sum, r) => sum + r.usage!.counters[c]!, 0)])) as Record<Counter, number> : undefined,
		estimate: priced.length ? priced.reduce((sum, r) => sum + r.estimate!, 0) : undefined,
		estimated: priced.length,
		subscriptionEstimate: priced.filter(r => r.usage?.subscription === true).reduce((sum, r) => sum + r.estimate!, 0),
		stale: rows.filter(r => r.usage && r.stale).length,
		forked: rows.filter(r => r.usage?.forked === true).length,
	};
}

// ---- Rendering ---------------------------------------------------------------------------------

/** Tokens are whole numbers without separators; costs have four decimals; absent is `unknown`. */
export const fmtTokens = (n: number | undefined): string => n === undefined ? "unknown" : String(Math.round(n));
export const fmtMoney = (n: number, currency: string): string => `${n.toFixed(4)} ${currency}`;

const counterText = (counters: Partial<Record<Counter, number>>): string => COUNTERS.map(c => `${c} ${fmtTokens(counters[c])}`).join(" ");

function billingText(usage: ReadUsage): string {
	if (usage.subscription === true) return "subscription: yes (no per-token bill)";
	return usage.subscription === false ? "subscription: no" : "subscription: unknown";
}

function estimateText(row: UsageRow, config: UsageConfig): string {
	if (row.estimate === undefined) return `estimate: unknown (${row.estimateReason ?? "no figures"})`;
	const note = row.usage?.subscription === true ? `${config.pricing}-price equivalent, not a charge` : config.pricing;
	return `estimate: ${fmtMoney(row.estimate, config.currency)} (${note})`;
}

export function formatRow(row: UsageRow, config: UsageConfig): string {
	if (!row.usage) return `${row.id}  ${row.name}  unknown (nothing published)`;
	const flags = [row.stale ? "stale" : "", row.usage.forked ? "forked: includes history copied from its parent" : "", row.complete ? "" : "partial: some counters unknown"].filter(Boolean);
	return [
		`${row.id}  ${row.name}`, `tokens: ${counterText(row.usage.counters)}`, billingText(row.usage), estimateText(row, config), "billed: unknown",
		...(row.usage.model ? [`model: ${row.usage.model}`] : []), ...(row.usage.since ? [`since ${row.usage.since}`] : []),
		...(flags.length ? [`[${flags.join(", ")}]`] : []),
	].join("  ");
}

/** The multi-line report for `summary`. Pure; `now` is only used for the header. */
export function formatUsage(summary: UsageSummary, config: UsageConfig, now: number, scope: string): string {
	const { sessions, covered, unknown } = summary;
	const lines = [`usage (${scope}; basis ${BASIS}: cumulative per session file; pricing ${config.pricing}; currency ${config.currency}${config.rate === undefined ? "" : ` at ${config.rate} per USD`}; read ${new Date(now).toISOString()})`];
	if (!sessions) return `${lines[0]}\nno sessions to report`;
	if (summary.rows.every(r => !r.usage)) lines.push("nothing is published: no listed session has run /peers usage on (usage is private by default)");
	for (const row of summary.rows) lines.push(formatRow(row, config));
	lines.push(`total of ${covered} of ${sessions} session(s); ${unknown} unknown`);
	if (summary.tokens) lines.push(`tokens: ${counterText(summary.tokens)} (covered sessions only)`);
	lines.push(summary.estimate === undefined
		? "estimate: unknown (no session has a computable estimate)"
		: `estimate: ${fmtMoney(summary.estimate, config.currency)} (${config.pricing}) over ${summary.estimated} of ${sessions} session(s)${summary.subscriptionEstimate > 0 ? `, of which ${fmtMoney(summary.subscriptionEstimate, config.currency)} is a subscription-price equivalent, not a charge` : ""}`);
	lines.push(BILLED);
	if (summary.stale) lines.push(`${summary.stale} session(s) stale: last published more than ${STALE_MS / 1000}s ago`);
	if (summary.forked) lines.push(`${summary.forked} forked session(s) include tokens copied from a parent session, which may also be listed`);
	return lines.join("\n");
}

// ---- Commands ----------------------------------------------------------------------------------

const USAGE = "usage: /peers usage status | on | off | set currency <CODE> [<USD-rate>] | set pricing <catalog|custom> | set groups <name>...|all | price <model> <in> <out> [<cacheRead> <cacheWrite>] | unprice <model> | list [group:<name>|<peer>]";

function scopeText(config: UsageConfig): string {
	return config.groups.length ? `groups ${config.groups.join(", ")}` : "all sessions";
}

async function status(host: FeatureHost): Promise<string> {
	const config = readConfig(host.home);
	const self = host.self();
	const source = host.usageNow();
	const live = source ? snapshotUsage(source) : undefined;
	const publishing = config.publishers.includes(self.id);
	const prices = Object.entries(config.prices).sort(([a], [b]) => a.localeCompare(b));
	return [
		`usage: this session (${safeText(self.name, MAX_NAME)}, ${self.id}) ${publishing ? "publishes its counters to the registry (/peers usage off stops it)" : "publishes nothing (private; /peers usage on publishes its counters)"}`,
		live
			? `host counters now (not shared unless publishing): ${counterText(Object.fromEntries(COUNTERS.map(c => [c, live[c]])))}${live.catalogCost === undefined ? "" : `; catalog cost ${fmtMoney(live.catalogCost * (config.rate ?? 1), config.currency)}${live.catalogCost === 0 && COUNTERS.some(c => (live[c] ?? 0) > 0) ? " (no catalog price?)" : ""}`}${live.subscription === true ? "; subscription login (no per-token bill)" : ""}`
			: "host counters now: unknown (the host reported none)",
		`pricing ${config.pricing}; currency ${config.currency}${config.rate === undefined ? "" : ` (rate ${config.rate} per USD)`}; scope ${scopeText(config)}; ${config.publishers.length} session(s) have publishing on`,
		BILLED,
		...(prices.length ? [`custom prices (USD per million tokens), ${prices.length} of ${MAX_PRICES}:`, ...prices.map(([model, p]) =>
			`  ${safeText(model, MAX_MODEL)}  in ${p.inPerM} out ${p.outPerM} cacheRead ${p.cacheReadPerM ?? "unset"} cacheWrite ${p.cacheWritePerM ?? "unset"}`)] : ["custom prices: none"]),
	].join("\n");
}

async function list(host: FeatureHost, target: string | undefined): Promise<string> {
	const config = readConfig(host.home);
	const self = host.self();
	let peers = await host.peers();
	let scope = scopeText(config);
	if (!host.isMaster()) {
		if (target !== undefined) return `error: ${MASTER_ONLY}`;
		peers = peers.filter(p => p.id === self.id);
		scope = "this session only; other sessions are listed by the master";
	} else if (target?.startsWith("group:")) {
		const group = target.slice(6).toLowerCase();
		peers = peers.filter(p => host.groupsOf(p.id).includes(group));
		scope = `group ${group}`;
	} else if (target !== undefined) {
		const lower = target.toLowerCase();
		const matches = peers.filter(p => p.id === lower || p.name.toLowerCase() === lower);
		const exact = matches.filter(p => p.id === lower);
		const chosen = exact.length ? exact : matches;
		if (!chosen.length) return `error: no peer matches "${safeText(target, MAX_NAME)}"`;
		if (chosen.length > 1) return `error: "${safeText(target, MAX_NAME)}" is ambiguous: ${chosen.map(p => `${safeText(p.name, MAX_NAME)} (${p.id})`).join(", ")}; use an explicit peer ID`;
		peers = chosen;
		scope = `session ${chosen[0].id}`;
	} else if (config.groups.length) {
		peers = peers.filter(p => host.groupsOf(p.id).some(g => config.groups.includes(g)));
	}
	const now = host.now();
	return formatUsage(usageSummary(peers, config, now), config, now, scope);
}

async function command(args: string[], host: FeatureHost): Promise<string> {
	const [sub, ...rest] = args;
	try {
		switch (sub) {
			case undefined:
			case "status":
				return rest.length ? USAGE : await status(host);
			case "on":
			case "off": {
				if (rest.length) return USAGE;
				const self = host.self();
				const live = new Set((await host.peers()).map(p => p.id));
				const result = await setPublishing(host.home, self.id, sub === "on", live);
				if (!result.ok) return `error: ${result.error}`;
				const who = `${safeText(self.name, MAX_NAME)} (${self.id})`;
				if (sub === "on") return result.changed ? `${who} now publishes its token counters (numbers only, no text) to the registry; /peers usage off stops it` : `${who} already publishes usage`;
				return result.changed ? `${who} no longer publishes usage; its registry row carries no figures` : `${who} was not publishing usage`;
			}
			case "set": {
				const [key, ...values] = rest;
				if (key === "currency" && (values.length === 1 || values.length === 2)) {
					const result = await setCurrency(host.home, values[0], values[1]);
					return result.ok ? `currency ${result.currency}${result.rate === undefined ? "" : ` at ${result.rate} per USD`}` : `error: ${result.error}`;
				}
				if (key === "pricing" && values.length === 1) {
					const result = await setPricing(host.home, values[0]);
					return result.ok ? `pricing ${result.pricing}` : `error: ${result.error}`;
				}
				if (key === "groups" && values.length >= 1) {
					const result = await setGroups(host.home, values.length === 1 && values[0].toLowerCase() === "all" ? [] : values);
					return result.ok ? `scope ${result.groups.length ? `groups ${result.groups.join(", ")}` : "all sessions"}` : `error: ${result.error}`;
				}
				return USAGE;
			}
			case "price": {
				if (rest.length !== 3 && rest.length !== 5) return USAGE;
				const result = await setPrice(host.home, rest[0], rest[1], rest[2], rest[3], rest[4]);
				return result.ok ? `${result.replaced ? "replaced" : "added"} custom price for ${safeText(result.model, MAX_MODEL)} (USD per million tokens)` : `error: ${result.error}`;
			}
			case "unprice": {
				if (rest.length !== 1) return USAGE;
				const result = await removePrice(host.home, rest[0]);
				return result.ok ? `removed custom price for ${safeText(rest[0], MAX_MODEL)}` : `error: ${result.error}`;
			}
			case "list":
				return rest.length > 1 ? USAGE : await list(host, rest[0]);
			default:
				return USAGE;
		}
	} catch (error) {
		return `error: ${(error as Error).message}`;
	}
}

export const usage: Feature = {
	name: "usage",
	command,
};
