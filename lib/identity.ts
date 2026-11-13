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

export function resolvePeerTargets<T extends Registration & IdentityStatus>(
	spec: string, roster: T[], selfId: string, selfSessionId: string,
): { peers: T[]; error?: string } {
	const other = (peer: T) => peer.id !== selfId && (!selfSessionId || peer.sessionId !== selfSessionId);
	const all = roster.filter(other);
	const s = spec.toLowerCase();
	const exactId = roster.find(peer => peer.id === s);
	// IDs win even when a different session chose that literal ID as its name.
	if (exactId) return other(exactId) ? { peers: [exactId] } : { peers: [], error: "target is this logical session" };
	const choices = (peers: T[]) => peers.map(peer => `${peer.name} (${peer.id})${peer.canonicalId === peer.id ? " [canonical]" : ""}`).join(", ");
	if (s === "all") {
		const targets: T[] = [];
		const seen = new Set<string>();
		for (const peer of all) {
			const key = peer.sessionId || peer.id;
			if (seen.has(key)) continue;
			seen.add(key);
			const group = peer.sessionId ? all.filter(p => p.sessionId === peer.sessionId) : [peer];
			const owner = group.find(p => p.id === p.canonicalId);
			if (group.length > 1 && !owner) {
				return { peers: [], error: `broadcast not sent: logical session has no proven writer: ${choices(group)}; use an explicit peer ID` };
			}
			targets.push(owner ?? peer);
		}
		return targets.length ? { peers: targets } : { peers: [], error: "no other peers" };
	}
	const names = all.filter(peer => peer.name.toLowerCase() === s);
	const pool = names.length ? names : all.filter(peer => peer.id.startsWith(s) || peer.name.toLowerCase().startsWith(s));
	if (!pool.length) return { peers: [], error: `no peer matches "${spec}"` };
	if (pool.length > 1) return { peers: [], error: `"${spec}" is ambiguous: ${choices(pool)}; use an explicit peer ID` };
	const peer = pool[0];
	if (peer.duplicateSession.length && peer.canonicalId !== peer.id) {
		return { peers: [], error: `"${spec}" shares a logical session with ${peer.duplicateSession.join(", ")}; ${peer.canonicalId ? `canonical: ${peer.canonicalId}` : "writer unknown"}; use an explicit peer ID` };
	}
	return { peers: pool };
}
