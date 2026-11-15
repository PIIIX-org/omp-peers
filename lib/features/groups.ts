// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

/**
 * Session groups: named sets of logical sessions, for scoped rules and filtered broadcasts.
 *
 * Stored in `~/.omp/agent/peer-state/groups.json` as group name -> member stable session ids (the id a
 * session computes for itself, never a peer-instance id), so a restarted or re-registered session
 * keeps its memberships. `group:<name>` is a send target; resolution lives in `resolvePeerTargets`.
 */
import * as path from "node:path";
import type { FeatureHost } from "./host";
import type { Feature } from "./index";
import { wakeGate } from "./pause";
import { GROUP_RE, resolvePeer } from "./rules";
import { readState, stateRoot, updateState } from "./store";
import { skippedLine, type GroupTargeting } from "../identity";

export interface GroupsState {
	version: 1;
	/** Group name -> member stable ids, sorted. */
	groups: Record<string, string[]>;
}

export const MAX_GROUPS = 64;
export const MAX_MEMBERS = 64;
const PEER_ID_RE = /^p(?:[0-9a-f]{6}|[0-9a-f]{16})$/;
const MASTER_ONLY = "only the master session may change the membership of other sessions; run /peers master first (a session may add or remove itself)";

/** Ops only the master may send and a locked session refuses; the same set the receiver checks. */
export const CONTROL_OPS = new Set(["prompt", "abort", "compact", "model", "effort", "subagents", "setting", "rename", "tail", "shutdown", "pause"]);
/** Ops a broadcast or `preview` may name. */
const PREVIEW_OPS: readonly string[] = ["message", "status", ...CONTROL_OPS];

export const groupsFile = (home: string) => path.join(stateRoot(home), "groups.json");

const emptyState = (): GroupsState => ({ version: 1, groups: {} });

function validateState(value: unknown): GroupsState {
	const state = value as Partial<GroupsState> | null;
	if (!state || typeof state !== "object" || state.version !== 1) throw new Error("unsupported version (expected 1)");
	const groups = state.groups as Record<string, unknown> | undefined;
	if (!groups || typeof groups !== "object" || Array.isArray(groups)) throw new Error("malformed fields");
	const names = Object.keys(groups);
	if (names.length > MAX_GROUPS) throw new Error(`more than ${MAX_GROUPS} groups`);
	for (const name of names) {
		const members = groups[name];
		const ok = GROUP_RE.test(name) && Array.isArray(members) && members.length <= MAX_MEMBERS &&
			members.every(id => typeof id === "string" && PEER_ID_RE.test(id)) && new Set(members).size === members.length;
		if (!ok) throw new Error(`malformed group "${name.slice(0, 48)}"`);
	}
	return state as GroupsState;
}

/** The groups, read fresh from disk. Throws when the file is unreadable or invalid. */
export function readGroups(home: string): GroupsState {
	return readState(groupsFile(home), emptyState, validateState);
}

/** Group names `peerId` (a stable session id) belongs to, sorted. Throws when the registry is unreadable. */
export function groupsOf(home: string, peerId: string): string[] {
	const { groups } = readGroups(home);
	return Object.keys(groups).filter(name => groups[name].includes(peerId)).sort();
}

/** Members of `name`, or undefined when no such group exists. */
export function membersOf(home: string, name: string): string[] | undefined {
	const { groups } = readGroups(home);
	return Object.hasOwn(groups, name) ? groups[name] : undefined;
}

/** Why a session must not receive `op` right now, mirroring the receiver's own checks; undefined when it may. */
export interface Reachability {
	inbound?: "accept" | "refuse";
	control?: boolean;
	paused?: boolean;
}
export function sendSkipReason(peer: Reachability, op: string): string | undefined {
	if (peer.inbound === "refuse") return "refuses inbound requests";
	if (CONTROL_OPS.has(op) && peer.control === false) return "locked (control refused)";
	// Pre-filter from the published registry flag; the receiver's own gate stays authoritative.
	if (!wakeGate({ paused: peer.paused === true }, op).allow) return "paused";
	return undefined;
}

export function groupTargeting<T extends Reachability>(home: string, op: string): GroupTargeting<T> {
	return { members: name => membersOf(home, name), skip: peer => sendSkipReason(peer, op) };
}

// ---- Operations --------------------------------------------------------------------------------

export interface Actor {
	/** The acting session's stable id. */
	self: string;
	master: boolean;
}

export type ChangeResult = { ok: true; changed: boolean; count: number } | { ok: false; error: string };

function normalizeGroup(raw: string): { group?: string; error?: string } {
	const group = raw.toLowerCase();
	return GROUP_RE.test(group) ? { group } : { error: "group name must be 1-48 characters: lower-case letters, digits, '.', '_' or '-', starting with a letter or digit" };
}

export async function addMember(home: string, rawGroup: string, peerId: string, actor: Actor): Promise<ChangeResult> {
	const { group, error } = normalizeGroup(rawGroup);
	if (!group) return { ok: false, error: error! };
	if (!PEER_ID_RE.test(peerId)) return { ok: false, error: "session identity unavailable" };
	if (peerId !== actor.self && !actor.master) return { ok: false, error: MASTER_ONLY };
	return updateState<GroupsState, ChangeResult>(groupsFile(home), emptyState, validateState, current => {
		const members = Object.hasOwn(current.groups, group) ? current.groups[group] : undefined;
		if (members?.includes(peerId)) return { result: { ok: true, changed: false, count: members.length } };
		if (!members && Object.keys(current.groups).length >= MAX_GROUPS) return { result: { ok: false, error: `group limit reached (${MAX_GROUPS}); delete a group first` } };
		if ((members?.length ?? 0) >= MAX_MEMBERS) return { result: { ok: false, error: `member limit reached (${MAX_MEMBERS} per group); remove a member first` } };
		const next = [...(members ?? []), peerId].sort();
		return { state: { version: 1, groups: { ...current.groups, [group]: next } }, result: { ok: true, changed: true, count: next.length } };
	});
}

/** Removing the last member leaves the (empty) group in place; `deleteGroup` removes it. */
export async function removeMember(home: string, rawGroup: string, peerId: string, actor: Actor): Promise<ChangeResult> {
	const { group, error } = normalizeGroup(rawGroup);
	if (!group) return { ok: false, error: error! };
	if (peerId !== actor.self && !actor.master) return { ok: false, error: MASTER_ONLY };
	return updateState<GroupsState, ChangeResult>(groupsFile(home), emptyState, validateState, current => {
		const members = Object.hasOwn(current.groups, group) ? current.groups[group] : undefined;
		if (!members) return { result: { ok: false, error: `unknown group "${group}"` } };
		if (!members.includes(peerId)) return { result: { ok: false, error: `${peerId} is not a member of group "${group}"` } };
		const next = members.filter(id => id !== peerId);
		return { state: { version: 1, groups: { ...current.groups, [group]: next } }, result: { ok: true, changed: true, count: next.length } };
	});
}

/** Delete a group. The master may delete any group; another session only a group it alone belongs to (or an empty one). */
export async function deleteGroup(home: string, rawGroup: string, actor: Actor): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
	const { group, error } = normalizeGroup(rawGroup);
	if (!group) return { ok: false, error: error! };
	return updateState<GroupsState, { ok: true; count: number } | { ok: false; error: string }>(groupsFile(home), emptyState, validateState, current => {
		const members = Object.hasOwn(current.groups, group) ? current.groups[group] : undefined;
		if (!members) return { result: { ok: false, error: `unknown group "${group}"` } };
		if (!actor.master && members.some(id => id !== actor.self)) return { result: { ok: false, error: MASTER_ONLY } };
		const rest = { ...current.groups };
		delete rest[group];
		return { state: { version: 1, groups: rest }, result: { ok: true, count: members.length } };
	});
}

// ---- Commands ----------------------------------------------------------------------------------

const USAGE = `usage: /peers groups list | add <group> <peer> | remove <group> <peer> | delete <group> | members <group> | preview <group> [${PREVIEW_OPS.join("|")}]`;

const actorOf = (host: FeatureHost): Actor => ({ self: host.self().id, master: host.isMaster() });

async function preview(host: FeatureHost, rawGroup: string, rawOp: string | undefined): Promise<string> {
	const { group, error } = normalizeGroup(rawGroup);
	if (!group) return `error: ${error}`;
	const op = rawOp ?? "message";
	if (!PREVIEW_OPS.includes(op)) return USAGE;
	const members = membersOf(host.home, group);
	if (!members) return `error: unknown group "${group}"`;
	const plan = await host.resolveGroup(group, op);
	return [
		`preview group:${group} (${op}), ${members.length} member(s)`,
		plan.error ? `error: ${plan.error}` : `would receive: ${plan.recipients.map(peer => `${peer.name} (${peer.id})`).join(", ")}`,
		...plan.skipped.map(skippedLine),
	].join("\n");
}

async function command(args: string[], host: FeatureHost): Promise<string> {
	const [sub, ...rest] = args;
	try {
		switch (sub) {
			case "list": {
				if (rest.length) return USAGE;
				const { groups } = readGroups(host.home);
				const names = Object.keys(groups).sort();
				return names.length ? names.map(name => `${name}  ${groups[name].length} member(s)`).join("\n") : "no groups";
			}
			case "add":
			case "remove": {
				if (rest.length !== 2) return USAGE;
				const peer = await resolvePeer(host, rest[1], sub === "remove");
				if (!peer.id) return `error: ${peer.error}`;
				const label = (await host.peers()).find(p => p.id === peer.id)?.name;
				const who = label ? `${label} (${peer.id})` : peer.id;
				const result = sub === "add" ? await addMember(host.home, rest[0], peer.id, actorOf(host)) : await removeMember(host.home, rest[0], peer.id, actorOf(host));
				if (!result.ok) return `error: ${result.error}`;
				const group = rest[0].toLowerCase();
				if (sub === "add") return result.changed ? `added ${who} to group ${group} (${result.count} member(s))` : `${who} is already in group ${group}`;
				return `removed ${who} from group ${group} (${result.count} member(s) left)`;
			}
			case "delete": {
				if (rest.length !== 1) return USAGE;
				const result = await deleteGroup(host.home, rest[0], actorOf(host));
				return result.ok ? `deleted group ${rest[0].toLowerCase()} (${result.count} member(s)); rules scoped to it stay stored and apply to nobody` : `error: ${result.error}`;
			}
			case "members": {
				if (rest.length !== 1) return USAGE;
				const { group, error } = normalizeGroup(rest[0]);
				if (!group) return `error: ${error}`;
				const members = membersOf(host.home, group);
				if (!members) return `error: unknown group "${group}"`;
				const names = new Map((await host.peers()).map(peer => [peer.id, peer.name]));
				return [`group ${group}: ${members.length} member(s)`,
					...members.map(id => names.has(id) ? `  ${names.get(id)} (${id})` : `  ${id}  (no running session listed)`)].join("\n");
			}
			case "preview":
				return rest.length === 1 || rest.length === 2 ? preview(host, rest[0], rest[1]) : USAGE;
			default:
				return USAGE;
		}
	} catch (error) {
		return `error: ${(error as Error).message}`;
	}
}

export const groups: Feature = {
	name: "groups",
	command,
};
