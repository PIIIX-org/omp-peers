// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

import type { Skipped } from "../identity";

/** A live logical peer session as features see it. */
export interface PeerView {
	/** Stable logical-session id (the same id a session computes for itself), never a peer-instance id. */
	id: string;
	name: string;
	/** Whether the peer accepts requests from others (published inbound/control state); undefined when unknown. */
	acceptsRemote?: boolean;
	/** Whether the peer refuses all inbound requests (published state); undefined when unknown. A control lock alone is not a refusal: messages still arrive. */
	refusesInbound?: boolean;
}

/** Who a request addressed to `group:<name>` reaches right now; `skipped` lists every member left out and why. */
export interface GroupPlan {
	recipients: PeerView[];
	skipped: Skipped[];
	/** Set when nothing would be sent (empty or unknown group, no running or eligible member, ambiguity). */
	error?: string;
}
/** Outcome of delivering one message to one peer through the extension's normal send path. */
export type SendResult =
	/** The peer accepted the message. */
	| { status: "delivered" }
	/** No live session has that stable id; nothing was sent. */
	| { status: "offline" }
	/** The peer is live but refused or could not be reached (inbound refuse, rate limit, socket error, ...). */
	| { status: "failed"; reason: string };

/**
 * What a feature may ask of the extension. Features take this instead of importing host runtime
 * values so they unit-test with a fake. Extend additively: add a member only when a feature uses it.
 */
export interface FeatureHost {
	home: string;
	now(): number;
	/** The session this command or hook runs in. */
	self(): PeerView;
	/** Whether this session currently holds the master role (same check as peer control ops). */
	isMaster(): boolean;
	/** Whether this session accepts requests from others (inbound accepted and control not locked). */
	acceptsRemote(): boolean;
	/** Live logical sessions, including this one. */
	peers(): Promise<PeerView[]>;
	/** Group names a peer (stable id) belongs to, read from the group registry. Throws when the registry is unreadable. */
	groupsOf(peerId: string): string[];
	/** The recipients and skipped members of `op` sent to `group:<name>` now: the resolution a real send uses. Read-only. */
	resolveGroup(name: string, op: string): Promise<GroupPlan>;
	/**
	 * Send an ordinary peer message to the live session with stable id `to`. It takes the same path as
	 * `peers_send`, so the receiver's inbound refuse, lock and rate limit apply unchanged. Never resumes a
	 * session that is not live. `dependency: true` marks authorized work (a dependency trigger): the RECEIVER then
	 * also refuses it while its own control is locked, so a lock set after the sender's preflight still holds.
	 */
	send(to: string, req: { text: string; dependency?: boolean }): Promise<SendResult>;
}
