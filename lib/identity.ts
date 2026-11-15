// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
import { createHash } from "node:crypto";

export interface Registration {
	id: string;
	name: string;
	sessionId: string;
}

export interface IdentityStatus {
	duplicateNames: string[];
	duplicateSession: string[];
	canonicalId?: string;
}

export function stablePeerId(sessionId: string): string {
	return `p${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}`;
}

export function matchesWriter(
	peer: Registration & { pid: number; instance: string; sock: string },
	response: Record<string, unknown>, lockHeld: boolean,
): boolean {
	const info = response.info as Partial<typeof peer> | undefined;
	return lockHeld && response.ok === true && response.sessionOwner === true
		&& !!peer.sessionId && peer.id === stablePeerId(peer.sessionId) && !!peer.instance
		&& info?.id === peer.id && info.sessionId === peer.sessionId
		&& info.pid === peer.pid && info.instance === peer.instance && info.sock === peer.sock;
}

/** Ownership is supplied by a live lock-owning socket, never by registry timestamps. */
export async function identifyPeers<T extends Registration>(
	peers: T[], verifyWriter: (peer: T) => Promise<boolean>,
): Promise<Array<T & IdentityStatus>> {
	const names = new Map<string, T[]>();
	const sessions = new Map<string, T[]>();
	for (const peer of peers) {
		const name = peer.name.toLowerCase();
		names.set(name, [...(names.get(name) ?? []), peer]);
		if (peer.sessionId) sessions.set(peer.sessionId, [...(sessions.get(peer.sessionId) ?? []), peer]);
	}
	const owners = new Map<string, string>();
	await Promise.all(peers.map(async peer => {
		const duplicated = (names.get(peer.name.toLowerCase())?.length ?? 0) > 1
			|| (sessions.get(peer.sessionId)?.length ?? 0) > 1;
		if (duplicated && peer.sessionId && peer.id === stablePeerId(peer.sessionId) && await verifyWriter(peer)) {
			owners.set(peer.sessionId, peer.id);
		}
	}));
	return peers.map(peer => ({
		...peer,
		duplicateNames: (names.get(peer.name.toLowerCase()) ?? []).filter(p => p.id !== peer.id).map(p => p.id),
		duplicateSession: (sessions.get(peer.sessionId) ?? []).filter(p => p.id !== peer.id).map(p => p.id),
		canonicalId: owners.get(peer.sessionId),
	}));
}

export function identityFlags(peer: IdentityStatus & Registration): string[] {
	return [
		peer.duplicateNames.length ? `duplicate-name:${peer.duplicateNames.join("|")}` : "",
		peer.duplicateSession.length ? `duplicate-session:${peer.duplicateSession.join("|")}` : "",
		peer.duplicateNames.length || peer.duplicateSession.length
			? peer.canonicalId === peer.id ? "canonical" : peer.canonicalId ? `canonical:${peer.canonicalId}` : "canonical:unknown (use explicit ID)"
			: "",
	].filter(Boolean);
}

/** A group member that was left out of a broadcast and why. `name` is the stable ID when the session is not running. */
export interface Skipped {
	name: string;
	reason: string;
}

/** How a `group:<name>` target is resolved; supplied by the caller so this module stays free of state files. */
export interface GroupTargeting<T> {
	/** Stable IDs of the group's members, or undefined when no such group exists. `name` is already lower-case. */
	members(name: string): string[] | undefined;
	/** Why `peer` must not receive this request right now, or undefined when it may. */
	skip(peer: T): string | undefined;
}

export const skippedLine = (skipped: Skipped): string => `skipped: ${skipped.name} (${skipped.reason})`;

/** The stable logical-session ID a peer registration belongs to: group membership is keyed by it, never by a peer-instance ID. */
export function logicalId(peer: Registration): string {
	return peer.sessionId ? stablePeerId(peer.sessionId) : peer.id;
}

/** Registrations grouped by logical session, in roster order, each with its proven writer when there is one. */
function logicalSessions<T extends Registration & IdentityStatus>(peers: T[]): Array<{ members: T[]; owner?: T }> {
	const sessions: Array<{ members: T[]; owner?: T }> = [];
	const seen = new Set<string>();
	for (const peer of peers) {
		const key = peer.sessionId || peer.id;
		if (seen.has(key)) continue;
		seen.add(key);
		const members = peer.sessionId ? peers.filter(p => p.sessionId === peer.sessionId) : [peer];
		sessions.push({ members, owner: members.find(p => p.id === p.canonicalId) });
	}
	return sessions;
}

export function resolvePeerTargets<T extends Registration & IdentityStatus>(
	spec: string, roster: T[], selfId: string, selfSessionId: string, groups?: GroupTargeting<T>,
): { peers: T[]; error?: string; skipped?: Skipped[] } {
	const other = (peer: T) => peer.id !== selfId && (!selfSessionId || peer.sessionId !== selfSessionId);
	const all = roster.filter(other);
	const s = spec.toLowerCase();
	const exactId = roster.find(peer => peer.id === s);
	// IDs win even when a different session chose that literal ID as its name.
	if (exactId) return other(exactId) ? { peers: [exactId] } : { peers: [], error: "target is this logical session" };
	const choices = (peers: T[]) => peers.map(peer => `${peer.name} (${peer.id})${peer.canonicalId === peer.id ? " [canonical]" : ""}`).join(", ");
	if (s === "all") {
		const targets: T[] = [];
		for (const { members, owner } of logicalSessions(all)) {
			if (members.length > 1 && !owner) {
				return { peers: [], error: `broadcast not sent: logical session has no proven writer: ${choices(members)}; use an explicit peer ID` };
			}
			targets.push(owner ?? members[0]);
		}
		return targets.length ? { peers: targets } : { peers: [], error: "no other peers" };
	}
	let unknownGroup: string | undefined;
	if (groups && s.startsWith("group:")) {
		const name = s.slice(6);
		const members = groups.members(name);
		if (!members) unknownGroup = name; // a peer literally named like this keeps its ordinary meaning below
		else {
			const sameName = all.filter(peer => peer.name.toLowerCase() === s);
			if (sameName.length) return { peers: [], error: `"${spec}" is ambiguous: it names a group and a peer: ${choices(sameName)}; use the explicit peer ID, or rename the peer to target the group` };
			return resolveGroup(name, members, all, roster.find(p => !other(p)), selfId, selfSessionId, groups, choices);
		}
	}
	const names = all.filter(peer => peer.name.toLowerCase() === s);
	const pool = names.length ? names : all.filter(peer => peer.id.startsWith(s) || peer.name.toLowerCase().startsWith(s));
	if (!pool.length) return { peers: [], error: unknownGroup === undefined ? `no peer matches "${spec}"` : `unknown group "${unknownGroup}"` };
	if (pool.length > 1) return { peers: [], error: `"${spec}" is ambiguous: ${choices(pool)}; use an explicit peer ID` };
	const peer = pool[0];
	if (peer.duplicateSession.length && peer.canonicalId !== peer.id) {
		return { peers: [], error: `"${spec}" shares a logical session with ${peer.duplicateSession.join(", ")}; ${peer.canonicalId ? `canonical: ${peer.canonicalId}` : "writer unknown"}; use an explicit peer ID` };
	}
	return { peers: pool };
}

/**
 * The live members of a group that may receive the request, plus every member that may not and why.
 * Nothing is dropped silently: a member is a recipient or has a `skipped` entry (not running, this
 * session, ambiguous logical session, or the caller's own reason). The sender is never a recipient.
 */
function resolveGroup<T extends Registration & IdentityStatus>(
	name: string, members: string[], others: T[], selfRow: T | undefined, selfId: string, selfSessionId: string,
	groups: GroupTargeting<T>, choices: (peers: T[]) => string,
): { peers: T[]; error?: string; skipped?: Skipped[] } {
	if (!members.length) return { peers: [], error: `group "${name}" is empty; add members with /peers groups add ${name} <peer>` };
	const wanted = new Set(members);
	const selfKey = selfSessionId ? stablePeerId(selfSessionId) : selfId;
	const peers: T[] = [];
	const skipped: Skipped[] = [];
	const live = new Set<string>();
	for (const { members: rows, owner } of logicalSessions(others)) {
		const key = logicalId(rows[0]);
		if (!wanted.has(key)) continue;
		live.add(key);
		if (rows.length > 1 && !owner) {
			skipped.push({ name: rows[0].name, reason: `ambiguous: ${rows.length} registrations share this logical session and none is proven: ${choices(rows)}; use an explicit peer ID` });
			continue;
		}
		const target = owner ?? rows[0];
		const reason = groups.skip(target);
		if (reason) skipped.push({ name: target.name, reason });
		else peers.push(target);
	}
	if (wanted.has(selfKey)) skipped.push({ name: selfRow?.name ?? selfKey, reason: "this session" });
	for (const id of members) if (!live.has(id) && id !== selfKey) skipped.push({ name: id, reason: "not running" });
	skipped.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));
	if (peers.length) return { peers, skipped };
	return { peers: [], skipped, error: live.size ? `group "${name}" has no eligible recipients right now` : `group "${name}" has no running members` };
}
