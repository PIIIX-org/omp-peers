// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

/** A live logical peer session as features see it. */
export interface PeerView {
	/** Stable peer id. */
	id: string;
	name: string;
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
	/** Live logical sessions, including this one. */
	peers(): Promise<PeerView[]>;
	/** Group names a peer belongs to; empty until group membership exists. */
	groupsOf(peerId: string): string[];
	/**
	 * Send an ordinary peer message to the live session with stable id `to`. It takes the same path as
	 * `peers_send`, so the receiver's inbound refuse, lock and rate limit apply unchanged. Never resumes a
	 * session that is not live.
	 */
	send(to: string, req: { text: string }): Promise<SendResult>;
}
