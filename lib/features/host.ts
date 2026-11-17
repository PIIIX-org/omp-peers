// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

import type { Skipped } from "../identity";
import type { EventEnvelope } from "./events-wire";
import type { UsageSource } from "./usage";

/** A live logical peer session as features see it. */
export interface PeerView {
	/** Stable logical-session id (the same id a session computes for itself), never a peer-instance id. */
	id: string;
	name: string;
	/** Whether the peer accepts requests from others (published inbound/control state); undefined when unknown. */
	acceptsRemote?: boolean;
	/** Whether the peer refuses all inbound requests (published state); undefined when unknown. A control lock alone is not a refusal: messages still arrive. */
	refusesInbound?: boolean;
	/** The `usage` value the peer published in its registry row, unvalidated (undefined when it published none); only the usage feature interprets it. */
	usage?: unknown;
	/** Published busy state (a turn is running); undefined when unknown. */
	busy?: boolean;
	/** Published context usage text such as `1234 (56%)`; empty or undefined when the peer has no figure. */
	context?: string;
	/** Published explicit pause; undefined on registrations from versions without pause. */
	paused?: boolean;
	/** Consecutive assistant turns that ended in an error, counted by the peer since its process started; undefined on versions that do not publish it. */
	recentErrorTurns?: number;
	/** ISO time of the peer's last registry write; undefined when unknown. */
	updatedAt?: string;
	/** Project directory the session runs in, as published; the dashboard shows only its last path component. */
	cwd?: string;
	/** Running background jobs in the peer's agent tree; null when the peer could not observe them, undefined on versions that do not publish it. */
	activeJobs?: number | null;
	/** Streaming descendant subagents; null when unobserved, undefined on versions that do not publish it. */
	activeSubagents?: number | null;
	/** Whether the peer's whole agent tree was quiescent when it last published; null when it could not tell, undefined on versions that do not publish it. */
	isSettled?: boolean | null;
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

/** A model selector checked against the models available now; nothing was changed. */
export type ModelCheck =
	/** `model` is the canonical `provider/id` the selector resolves to; `current` is this session's model, if it has one. */
	| { ok: true; model: string; current?: string }
	| { ok: false; error: string };

/** Outcome of switching this session's model. */
export type ModelApply =
	/** `previous` is the model before the switch (a valid selector to switch back), if there was one. */
	| { ok: true; model: string; previous?: string }
	| { ok: false; error: string };

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
	/** Show `text` to this session's user as a local notification. Never sent to another session and never added to a prompt. */
	notify(text: string): void;
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
	 * session that is not live. `dependency: true` marks a delivery the master initiated on its own authority (a dependency trigger, an external
	 * event): the RECEIVER then also refuses it while its own control is locked, so a lock set after the sender's preflight still holds.
	 * `event` (events feature only) is the structured delivery the receiver renders itself; the receiver honours it only with
	 * `dependency: true` from the master. `guard`, when given, is evaluated immediately before the message call, after the
	 * peer list and target resolution; when it returns false nothing is sent and the result is `failed` with reason `GUARD_CANCELLED`.
	 */
	send(to: string, req: { text: string; dependency?: boolean; event?: EventEnvelope; guard?: () => boolean }): Promise<SendResult>;
	/**
	 * Resolve `selector` (a model id, `provider/id` or role alias, no thinking-level suffix) against the available
	 * models and check its credentials, the way a routed model change is validated. Read-only: never substitutes
	 * another model and never changes the session.
	 */
	resolveModel(selector: string): Promise<ModelCheck>;
	/** Switch this session to `selector` after the same checks as `resolveModel`; the thinking level is kept. No substitution on failure. */
	applyModel(selector: string): Promise<ModelApply>;
	/** This session's usage counters as the host reports them now: numeric aggregates only. Undefined when the host provides none. Read-only; never starts a request. */
	usageNow(): UsageSource | undefined;
}
