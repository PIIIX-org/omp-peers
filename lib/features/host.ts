// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

/** A live logical peer session as features see it. */
export interface PeerView {
	/** Stable peer id. */
	id: string;
	name: string;
}

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
	/** Group names a peer belongs to; empty until group membership exists. */
	groupsOf(peerId: string): string[];
}
