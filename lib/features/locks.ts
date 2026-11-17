// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

/**
 * Named shared locks and semaphores for coordinating scarce resources across sessions.
 *
 * A resource has a capacity (slots) fixed by its first acquire. A lease occupies one slot until its
 * TTL runs out, the owner releases it, or the master force-releases it. Every mutation is one atomic
 * `updateState`, so two processes can never both take the last slot. Nothing here waits, wakes a
 * session or runs on a timer: contention is reported (`busy`) and expired leases are reclaimed lazily
 * inside the next mutation. Status is read-only and never reclaims.
 */
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import type { FeatureHost } from "./host";
import type { Feature, ToolSpec } from "./index";
import { looksLikeSecret } from "./secrets";
import { readState, stateRoot, updateState } from "./store";

export interface Lease {
	/** Stable, never reused: `l<number>`. */
	id: string;
	/** Logical owner: the session's stable peer id. */
	owner: string;
	/** The owner's display name when it last acquired; output only, never identity. */
	name: string;
	/** The process instance that last acquired or renewed. A restarted session has a new one but the same owner. */
	instance: string;
	acquiredAt: number;
	/** The lease no longer counts at or after this time. */
	expiresAt: number;
	note?: string;
}

export interface Resource {
	name: string;
	capacity: number;
	leases: Lease[];
}

export interface LocksState {
	version: 1;
	nextId: number;
	/** Sorted by name; a resource with no leases is removed, so its capacity can be chosen again. */
	resources: Resource[];
}

export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;
export const MAX_NAMES = 64;
export const MAX_LEASES = 256;
export const MAX_CAPACITY = 64;
export const DEFAULT_CAPACITY = 1;
export const MIN_TTL = 10;
export const MAX_TTL = 86_400;
export const DEFAULT_TTL = 600;
export const MAX_NOTE = 80;
const MAX_DISPLAY_NAME = 80;
const PEER_ID_RE = /^p(?:[0-9a-f]{6}|[0-9a-f]{16})$/;
const LEASE_ID_RE = /^l[1-9][0-9]*$/;
const INSTANCE_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Identifies this OS process's session instance; a restarted session gets a new one. */
export const PROCESS_INSTANCE = `${process.pid}-${randomBytes(4).toString("hex")}`;

export const locksFile = (home: string) => path.join(stateRoot(home), "locks.json");

const emptyState = (): LocksState => ({ version: 1, nextId: 1, resources: [] });

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isLine = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\p{Cc}\p{Cf}]/u.test(value);

function validateState(value: unknown): LocksState {
	const state = value as Partial<LocksState> | null;
	if (!state || typeof state !== "object" || state.version !== 1) throw new Error("unsupported version (expected 1)");
	if (!Number.isInteger(state.nextId) || (state.nextId as number) < 1 || !Array.isArray(state.resources)) throw new Error("malformed fields");
	if (state.resources.length > MAX_NAMES) throw new Error(`more than ${MAX_NAMES} resources`);
	const names = new Set<string>();
	const ids = new Set<string>();
	let total = 0;
	for (const resource of state.resources as Resource[]) {
		const ok = resource && typeof resource === "object" && typeof resource.name === "string" && NAME_RE.test(resource.name) && !names.has(resource.name) &&
			Number.isInteger(resource.capacity) && resource.capacity >= 1 && resource.capacity <= MAX_CAPACITY &&
			Array.isArray(resource.leases) && resource.leases.length >= 1 && resource.leases.length <= resource.capacity;
		if (!ok) throw new Error("malformed or duplicate resource");
		names.add(resource.name);
		const owners = new Set<string>();
		for (const lease of resource.leases) {
			const valid = lease && typeof lease === "object" && typeof lease.id === "string" && LEASE_ID_RE.test(lease.id) && !ids.has(lease.id) &&
				typeof lease.owner === "string" && PEER_ID_RE.test(lease.owner) && !owners.has(lease.owner) &&
				typeof lease.name === "string" && lease.name.length <= MAX_DISPLAY_NAME && !/[\p{Cc}\p{Cf}]/u.test(lease.name) &&
				typeof lease.instance === "string" && INSTANCE_RE.test(lease.instance) &&
				isFiniteNumber(lease.acquiredAt) && isFiniteNumber(lease.expiresAt) &&
				(lease.note === undefined || isLine(lease.note, MAX_NOTE));
			if (!valid) throw new Error("malformed or duplicate lease");
			if (Number(lease.id.slice(1)) >= (state.nextId as number)) throw new Error("lease id beyond nextId");
			ids.add(lease.id);
			owners.add(lease.owner);
			total++;
		}
	}
	if (total > MAX_LEASES) throw new Error(`more than ${MAX_LEASES} leases`);
	return state as LocksState;
}

/** The lock table as stored; a missing file is empty. Never writes and never reclaims. */
export function readLocks(host: Pick<FeatureHost, "home">): LocksState {
	return readState(locksFile(host.home), emptyState, validateState);
}

// ---- Argument validation -----------------------------------------------------------------------

type Parsed<T> = { value: T; error?: undefined } | { value?: undefined; error: string };

function parseName(raw: unknown): Parsed<string> {
	if (typeof raw !== "string" || !raw) return { error: "name is required" };
	if (!NAME_RE.test(raw)) return { error: `"${raw.slice(0, 60)}" is not a valid lock name (lower-case a-z, 0-9, '.', '_', '-'; starts with a letter or digit; at most 48 characters)` };
	return { value: raw };
}

/** An integer given as a number or a digit string; `undefined` input means "not given". */
function parseInteger(raw: unknown, what: string, min: number, max: number): Parsed<number | undefined> {
	if (raw === undefined) return { value: undefined };
	const value = typeof raw === "number" ? raw : typeof raw === "string" && /^[0-9]{1,9}$/.test(raw) ? Number(raw) : Number.NaN;
	if (!Number.isInteger(value) || value < min || value > max) return { error: `${what} must be a whole number from ${min} to ${max}` };
	return { value };
}

function parseNote(raw: unknown): Parsed<string | undefined> {
	if (raw === undefined) return { value: undefined };
	if (typeof raw !== "string") return { error: "note must be text" };
	const text = raw.trim().replace(/\s+/g, " ");
	if (!text) return { value: undefined };
	if (text.length > MAX_NOTE) return { error: `note is longer than ${MAX_NOTE} characters` };
	if (/[\p{Cc}\p{Cf}]/u.test(text)) return { error: "note contains control characters" };
	if (looksLikeSecret(text)) return { error: "note looks like a credential or token; locks.json is stored in plain text and shown to other sessions. Describe the work instead" };
	return { value: text };
}

const displayName = (name: string): string => name.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, MAX_DISPLAY_NAME) || "unnamed";

// ---- Results -----------------------------------------------------------------------------------

export type LockResult =
	/** A new lease was granted. */
	| { outcome: "acquired"; name: string; lease: Lease; capacity: number; held: number }
	/** An own lease got a new expiry (`renew`). */
	| { outcome: "renewed"; name: string; lease: Lease; capacity: number; held: number }
	/** The own lease was removed. */
	| { outcome: "released"; name: string; lease: Lease; forced: boolean }
	/** Every slot is held by an unexpired lease; nothing changed and nothing waits. */
	| { outcome: "busy"; name: string; capacity: number; holders: Lease[]; earliestExpiry: number }
	/** Bad arguments, capacity mismatch, bounds, wrong owner or authorization; nothing was granted. */
	| { outcome: "refused"; reason: string };

const refused = (reason: string): LockResult => ({ outcome: "refused", reason });

export const live = (lease: Lease, now: number): boolean => lease.expiresAt > now;

/** Drop every expired lease and any resource left empty. Returns whether anything was removed. */
function reclaim(state: LocksState, now: number): boolean {
	let changed = false;
	for (const resource of state.resources) {
		const kept = resource.leases.filter(lease => live(lease, now));
		if (kept.length !== resource.leases.length) {
			resource.leases = kept;
			changed = true;
		}
	}
	if (changed) state.resources = state.resources.filter(resource => resource.leases.length > 0);
	return changed;
}

const totalLeases = (state: LocksState): number => state.resources.reduce((sum, resource) => sum + resource.leases.length, 0);
export const countLive = (resource: Resource, now: number): number => resource.leases.filter(lease => live(lease, now)).length;

// ---- Operations --------------------------------------------------------------------------------

export interface AcquireInput {
	name?: unknown;
	/** Only given when the caller cares: it must match an existing resource, and sets it for a new one. */
	capacity?: unknown;
	/** Seconds. */
	ttl?: unknown;
	note?: unknown;
}

/**
 * Take one slot of `name`. A session that already holds a lease on it is refused (use `renewLock`), so one
 * session never counts twice. Never waits: a full resource returns `busy` naming the holders.
 */
export async function acquireLock(host: FeatureHost, input: AcquireInput, instance = PROCESS_INSTANCE): Promise<LockResult> {
	const name = parseName(input.name);
	const capacity = parseInteger(input.capacity, "capacity", 1, MAX_CAPACITY);
	const ttl = parseInteger(input.ttl, "ttl", MIN_TTL, MAX_TTL);
	const note = parseNote(input.note);
	const bad = [name, capacity, ttl, note].find(parsed => parsed.error !== undefined);
	if (bad) return refused(bad.error!);
	const self = host.self();
	const now = host.now();
	const seconds = ttl.value ?? DEFAULT_TTL;
	return updateState(locksFile(host.home), emptyState, validateState, state => {
		const changed = reclaim(state, now);
		const reply = (result: LockResult, write = changed) => ({ state: write ? state : undefined, result });
		let resource = state.resources.find(r => r.name === name.value);
		if (resource && capacity.value !== undefined && capacity.value !== resource.capacity) {
			return reply(refused(`capacity mismatch: ${name.value} was created with capacity ${resource.capacity} (requested ${capacity.value}); the capacity is fixed until every lease on it has ended`));
		}
		const mine = resource?.leases.find(lease => lease.owner === self.id);
		// Subagents act as their parent session, so a second acquire by the owner may come from another agent that
		// would wrongly believe it holds the slot too. Extending is `renew`'s job, never `acquire`'s.
		if (resource && mine) return reply(refused(`this session already holds ${name.value} (lease ${mine.id}), possibly via another of its agents; renew to extend it or release it when done`));
		if (resource && resource.leases.length >= resource.capacity) {
			const holders = resource.leases.slice().sort((a, b) => a.expiresAt - b.expiresAt || a.id.localeCompare(b.id, "en", { numeric: true }));
			return reply({ outcome: "busy", name: name.value!, capacity: resource.capacity, holders, earliestExpiry: holders[0].expiresAt });
		}
		if (!resource && state.resources.length >= MAX_NAMES) return reply(refused(`at most ${MAX_NAMES} lock names may exist at once`));
		if (totalLeases(state) >= MAX_LEASES) return reply(refused(`at most ${MAX_LEASES} leases may exist at once`));
		if (!resource) {
			resource = { name: name.value!, capacity: capacity.value ?? DEFAULT_CAPACITY, leases: [] };
			state.resources.push(resource);
			state.resources.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		}
		const lease: Lease = { id: `l${state.nextId++}`, owner: self.id, name: displayName(self.name), instance, acquiredAt: now, expiresAt: now + seconds * 1000 };
		if (note.value !== undefined) lease.note = note.value;
		resource.leases.push(lease);
		return reply({ outcome: "acquired", name: name.value!, lease: { ...lease }, capacity: resource.capacity, held: resource.leases.length }, true);
	});
}

/** Set this session's own unexpired lease to expire `ttl` seconds from now. An expired lease cannot be renewed. */
export async function renewLock(host: FeatureHost, input: { name?: unknown; ttl?: unknown }, instance = PROCESS_INSTANCE): Promise<LockResult> {
	const name = parseName(input.name);
	const ttl = parseInteger(input.ttl, "ttl", MIN_TTL, MAX_TTL);
	const bad = [name, ttl].find(parsed => parsed.error !== undefined);
	if (bad) return refused(bad.error!);
	const self = host.self();
	const now = host.now();
	const seconds = ttl.value ?? DEFAULT_TTL;
	return updateState(locksFile(host.home), emptyState, validateState, state => {
		const changed = reclaim(state, now);
		const reply = (result: LockResult, write = changed) => ({ state: write ? state : undefined, result });
		const resource = state.resources.find(r => r.name === name.value);
		const mine = resource?.leases.find(lease => lease.owner === self.id);
		if (!resource || !mine) return reply(refused(`this session holds no active lease on ${name.value}${resource ? "; only the owner may renew it" : " (it expired, was released, or was never acquired); acquire it again"}`));
		mine.instance = instance;
		mine.name = displayName(self.name);
		mine.expiresAt = now + seconds * 1000;
		return reply({ outcome: "renewed", name: name.value!, lease: { ...mine }, capacity: resource.capacity, held: resource.leases.length }, true);
	});
}

/** Release this session's own lease. Only the owner (same logical session, any instance) may release. */
export async function releaseLock(host: FeatureHost, input: { name?: unknown }): Promise<LockResult> {
	const name = parseName(input.name);
	if (name.error !== undefined) return refused(name.error);
	const self = host.self();
	const now = host.now();
	return updateState(locksFile(host.home), emptyState, validateState, state => {
		const changed = reclaim(state, now);
		const resource = state.resources.find(r => r.name === name.value);
		const mine = resource?.leases.find(lease => lease.owner === self.id);
		if (!resource || !mine) {
			return { state: changed ? state : undefined, result: refused(`this session holds no active lease on ${name.value}${resource ? "; only the owner may release it" : ""}`) };
		}
		resource.leases = resource.leases.filter(lease => lease !== mine);
		state.resources = state.resources.filter(r => r.leases.length > 0);
		return { state, result: { outcome: "released", name: name.value!, lease: mine, forced: false } };
	});
}

export interface ForceInput {
	name?: unknown;
	/** The owner's stable peer id, or a lease id (`l<number>`) from `status`. */
	target?: unknown;
	/** Allow breaking a lease that has not expired. */
	yesLive?: boolean;
}

/**
 * Master-only: remove one named lease. An expired lease is removed freely; an unexpired one only with
 * `yesLive`, because that can let two sessions use a resource its owner still believes it holds.
 */
export async function forceRelease(host: FeatureHost, input: ForceInput): Promise<LockResult> {
	if (!host.isMaster()) return refused("only the master session may force-release a lease; run /peers master first");
	const name = parseName(input.name);
	if (name.error !== undefined) return refused(name.error);
	if (typeof input.target !== "string" || !(PEER_ID_RE.test(input.target) || LEASE_ID_RE.test(input.target))) return refused("owner must be a session's stable id or a lease id (l<number>) shown by /peers locks status");
	const target = input.target;
	const now = host.now();
	return updateState(locksFile(host.home), emptyState, validateState, state => {
		const resource = state.resources.find(r => r.name === name.value);
		const lease = resource?.leases.find(l => l.owner === target || l.id === target);
		if (!resource || !lease) return { result: refused(`no lease on ${name.value} matches ${target}; an expired lease may already have been reclaimed`) };
		if (live(lease, now) && !input.yesLive) {
			return { result: refused(`${lease.id} held by ${lease.name} (${lease.owner}) has not expired (${formatDuration(lease.expiresAt - now)} left). Force-releasing a live lease can let two sessions use ${name.value} at once; add --yes-live to do it anyway`) };
		}
		resource.leases = resource.leases.filter(l => l !== lease);
		state.resources = state.resources.filter(r => r.leases.length > 0);
		return { state, result: { outcome: "released", name: name.value!, lease, forced: true } };
	});
}

// ---- Presentation ------------------------------------------------------------------------------

/** `1h 2m 3s`; zero units are skipped and a sub-second remainder rounds up to 1s. */
export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.ceil(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	return [h && `${h}h`, m && `${m}m`, (s || !(h || m)) && `${s}s`].filter(Boolean).join(" ");
}

const iso = (ms: number): string => new Date(ms).toISOString();

function holder(lease: Lease, self: { id: string }, instance: string, now: number): string {
	const who = lease.owner === self.id ? `${lease.name} (${lease.owner}, this session${lease.instance === instance ? "" : ", earlier instance"})` : `${lease.name} (${lease.owner})`;
	const when = live(lease, now) ? `expires in ${formatDuration(lease.expiresAt - now)} (${iso(lease.expiresAt)})` : `EXPIRED ${formatDuration(now - lease.expiresAt)} ago (ignored; reclaimed by the next acquire)`;
	return `${lease.id}  ${who}  ${when}${lease.note ? `  note: ${lease.note}` : ""}`;
}

/** Every resource, or one. Read-only: nothing is created, reclaimed or contacted. Expired leases are shown and ignored. */
export function renderStatus(host: FeatureHost, nameArg?: string, instance = PROCESS_INSTANCE): string {
	const now = host.now();
	const self = host.self();
	let resources = readLocks(host).resources;
	if (nameArg !== undefined) {
		const name = parseName(nameArg);
		if (name.error !== undefined) return `refused: ${name.error}`;
		resources = resources.filter(r => r.name === name.value);
		if (!resources.length) return `${name.value}: free (no leases; the first acquire sets its capacity)`;
	} else if (!resources.length) {
		return "no locks held";
	}
	const lines: string[] = [];
	for (const resource of resources) {
		const used = countLive(resource, now);
		lines.push(`${resource.name}: ${used} of ${resource.capacity} slot${resource.capacity === 1 ? "" : "s"} in use${used >= resource.capacity ? " (busy)" : ""}`);
		for (const lease of resource.leases.slice().sort((a, b) => a.expiresAt - b.expiresAt || a.id.localeCompare(b.id, "en", { numeric: true }))) {
			lines.push(`  ${holder(lease, self, instance, now)}`);
		}
	}
	return lines.join("\n");
}

/** One deterministic text rendering of a result, shared by the command and the tool. */
export function describeResult(result: LockResult, host: FeatureHost, instance = PROCESS_INSTANCE): string {
	const now = host.now();
	const self = host.self();
	switch (result.outcome) {
		case "acquired": {
			const { lease } = result;
			return `acquired ${result.name}: lease ${lease.id}, expires in ${formatDuration(lease.expiresAt - now)} (${iso(lease.expiresAt)}); ${result.held} of ${result.capacity} slot${result.capacity === 1 ? "" : "s"} in use. Renew before it expires and release when done.`;
		}
		case "renewed":
			return `renewed ${result.name}: lease ${result.lease.id} now expires in ${formatDuration(result.lease.expiresAt - now)} (${iso(result.lease.expiresAt)}); ${result.held} of ${result.capacity} in use`;
		case "released":
			return result.forced
				? `force-released ${result.name}: lease ${result.lease.id} held by ${result.lease.name} (${result.lease.owner}) was removed${live(result.lease, now) ? "; it had NOT expired, so its owner may still be using the resource" : ""}`
				: `released ${result.name}: lease ${result.lease.id}`;
		case "busy":
			return [
				`busy ${result.name}: all ${result.capacity} slot${result.capacity === 1 ? " is" : "s are"} held; nothing was acquired and nothing is waiting. Earliest slot frees in ${formatDuration(result.earliestExpiry - now)} (${iso(result.earliestExpiry)}) unless released sooner. Do other work and try again later.`,
				...result.holders.map(lease => `  ${holder(lease, self, instance, now)}`),
			].join("\n");
		default:
			return `refused: ${result.reason}`;
	}
}

// ---- Tool --------------------------------------------------------------------------------------

const lockTool: ToolSpec = {
	name: "peers_lock",
	label: "Shared Locks",
	description:
		`Coordinate a scarce shared resource with other sessions through a named lock or semaphore. acquire: take one slot of \`name\` (capacity is set by the first acquire, default ${DEFAULT_CAPACITY}); the result is acquired, busy (names the holders and when the earliest slot frees; never waits; do other work and retry later) or refused. Leases expire after ttl_seconds (default ${DEFAULT_TTL}); renew a long job before expiry and release when done. renew: extend your own lease. release: give up your own lease (only the owner may). status: read-only list of locks and holders. Never put credentials in note.`,
	parameters: z => z.object({
		action: z.enum(["acquire", "renew", "release", "status"]),
		name: z.string().optional().describe("lock name: lower-case a-z, 0-9, '.', '_', '-', at most 48 characters, e.g. heavy-build; required except for status (omit to list all)"),
		capacity: z.number().optional().describe(`acquire only: slots, 1-${MAX_CAPACITY}; fixed by the first acquire. Omit to accept the existing capacity (new locks default to ${DEFAULT_CAPACITY}); a different value than an existing lock's is refused`),
		ttl_seconds: z.number().optional().describe(`acquire/renew: lease length in seconds, ${MIN_TTL}-${MAX_TTL} (default ${DEFAULT_TTL})`),
		note: z.string().optional().describe(`acquire only: what the lease is for, at most ${MAX_NOTE} characters`),
	}),
	async execute(params, host) {
		const reply = (result: LockResult) => ({ text: describeResult(result, host), ...(result.outcome === "refused" ? { isError: true } : {}) });
		switch (params.action) {
			case "acquire": return reply(await acquireLock(host, { name: params.name, capacity: params.capacity, ttl: params.ttl_seconds, note: params.note }));
			case "renew": return reply(await renewLock(host, { name: params.name, ttl: params.ttl_seconds }));
			case "release": return reply(await releaseLock(host, { name: params.name }));
			case "status": {
				const text = renderStatus(host, typeof params.name === "string" ? params.name : undefined);
				return { text, ...(text.startsWith("refused:") ? { isError: true } : {}) };
			}
			default: return { text: "error: action must be acquire, renew, release or status", isError: true };
		}
	},
};

// ---- Command -----------------------------------------------------------------------------------

const USAGE = "usage: /peers locks acquire <name> [--capacity N] [--ttl S] [--note T] | renew <name> [--ttl S] | release <name> | status [<name>] | force-release <name> <owner|lease-id> [--yes-live]";

/** Split `--flag value` pairs after the positional arguments. A `--note` value runs to the next flag. */
function parseFlags(tokens: string[], allowed: string[]): { values: Record<string, string>; yes: boolean } | undefined {
	const values: Record<string, string> = {};
	let yes = false;
	for (let i = 0; i < tokens.length;) {
		const flag = tokens[i++];
		if (flag === "--yes-live" && allowed.includes(flag)) {
			yes = true;
			continue;
		}
		if (!allowed.includes(flag) || flag in values || i >= tokens.length) return undefined;
		const end = flag === "--note" ? tokens.findIndex((token, index) => index >= i && token.startsWith("--")) : i + 1;
		const stop = end === -1 ? tokens.length : end;
		values[flag] = tokens.slice(i, stop).join(" ");
		i = stop;
	}
	return { values, yes };
}

async function command(args: string[], host: FeatureHost): Promise<string> {
	const [sub = "status", ...rest] = args;
	try {
		switch (sub) {
			case "status":
				return rest.length > 1 ? USAGE : renderStatus(host, rest[0]);
			case "acquire": {
				const flags = rest.length ? parseFlags(rest.slice(1), ["--capacity", "--ttl", "--note"]) : undefined;
				if (!flags) return USAGE;
				return describeResult(await acquireLock(host, { name: rest[0], capacity: flags.values["--capacity"], ttl: flags.values["--ttl"], note: flags.values["--note"] }), host);
			}
			case "renew": {
				const flags = rest.length ? parseFlags(rest.slice(1), ["--ttl"]) : undefined;
				if (!flags) return USAGE;
				return describeResult(await renewLock(host, { name: rest[0], ttl: flags.values["--ttl"] }), host);
			}
			case "release":
				if (rest.length !== 1) return USAGE;
				return describeResult(await releaseLock(host, { name: rest[0] }), host);
			case "force-release": {
				const flags = rest.length >= 2 ? parseFlags(rest.slice(2), ["--yes-live"]) : undefined;
				if (!flags) return USAGE;
				return describeResult(await forceRelease(host, { name: rest[0], target: rest[1], yesLive: flags.yes }), host);
			}
			default:
				return USAGE;
		}
	} catch (error) {
		return `error: ${(error as Error).message}`;
	}
}

export const locks: Feature = {
	name: "locks",
	command,
	tools: () => [lockTool],
};
