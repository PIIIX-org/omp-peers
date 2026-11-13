// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { AgentRegistryApi, AgentRef } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";

export interface PeerActivity {
	activity: {
		/** Running background jobs in this session's agent tree, including task jobs. */
		activeJobs: number | null;
		/** Streaming descendant subagents; parked/idle agents are excluded. */
		activeSubagents: number | null;
		/** Why a complete quiescence observation is unavailable. No host error text. */
		unknownReasons: string[];
	};
	/** Owner-scoped host predicate, including delivered results awaiting injection. */
	hasPendingAsyncWork: boolean | null;
	/** Tree quiescence now, not proof that a task met its acceptance criteria. */
	isSettled: boolean | null;
}

export interface ActivityHost {
	registry: AgentRegistryApi;
	isLocalSession(session: AgentSessionHandle): session is AgentSession;
}

let host: ActivityHost | undefined;
let loading: Promise<void> | undefined;

/** Older hosts may lack these exported services. Keep ordinary peer use working. */
export function initializeActivityHost(): Promise<void> {
	return loading ??= (async () => {
		try {
			const [{ AgentRegistry }, { isLocalAgentSession }] = await Promise.all([
				import("@oh-my-pi/pi-coding-agent/registry/agent-registry"),
				import("@oh-my-pi/pi-coding-agent/session/agent-session-handle"),
			]);
			host = { registry: AgentRegistry.global(), isLocalSession: isLocalAgentSession };
		} catch {
			// Missing capability is unknown, not an empty registry or zero jobs.
		}
	})();
}

function descendants(root: AgentRef, refs: AgentRef[]): AgentRef[] {
	const byId = new Map(refs.map(ref => [ref.id, ref]));
	return refs.filter(ref => {
		if (ref.kind !== "sub") return false;
		const seen = new Set<string>();
		for (let id = ref.parentId; id && !seen.has(id); id = byId.get(id)?.parentId) {
			if (id === root.id) return true;
			seen.add(id);
		}
		return false;
	});
}

/** Only public, read-only metadata APIs: never inspect messages or revive a ref. */
export function readActivity(ctx: ExtensionContext | undefined, services = host): PeerActivity {
	const result: PeerActivity = {
		activity: { activeJobs: null, activeSubagents: null, unknownReasons: [] },
		hasPendingAsyncWork: null,
		isSettled: null,
	};
	const unknown = result.activity.unknownReasons;
	if (!ctx || !services) {
		unknown.push(!ctx ? "session_context_unavailable" : "host_activity_services_unavailable");
		return result;
	}
	try {
		const { registry } = services;
		const root = registry.get(ctx.agent.id);
		if (!root?.session || root.kind !== "main"
			|| root.session.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()
			|| !services.isLocalSession(root.session)) {
			unknown.push("owning_session_unavailable");
			return result;
		}
		const session = root.session;
		const children = descendants(root, registry.list());
		result.activity.activeSubagents = children.filter(ref => registry.isRunning(ref)).length;
		const tree = session.getAsyncJobTree?.({ recentLimit: 0 });
		if (tree) result.activity.activeJobs = tree.running.length;
		else unknown.push("job_tree_unavailable");
		if (typeof session.hasPendingAsyncWork === "function") {
			result.hasPendingAsyncWork = session.hasPendingAsyncWork();
		} else unknown.push("pending_async_work_unavailable");

		let blocked = !ctx.isIdle() || result.hasPendingAsyncWork === true
			|| (result.activity.activeJobs ?? 0) > 0 || result.activity.activeSubagents > 0;
		// Include idle live descendants: their delivery/IRC queues can wake them even
		// when a task job no longer backs the agent. Parked refs need no session read.
		for (const ref of [root, ...children.filter(ref => ref.session !== null)]) {
			const live = ref.session;
			if (!live || !services.isLocalSession(live)) {
				unknown.push("descendant_wake_state_unavailable");
				continue;
			}
			if (typeof live.hasPendingAsyncWork !== "function"
				|| typeof live.hasAdmittedSubmission !== "boolean"
				|| typeof live.queuedMessageCount !== "number"
				|| typeof live.ircWakesPending !== "boolean"
				|| typeof live.hasPostPromptWork !== "boolean") {
				unknown.push("session_wake_state_unavailable");
				continue;
			}
			blocked ||= live.isStreaming || live.hasAdmittedSubmission || live.queuedMessageCount > 0
				|| live.hasPendingAsyncWork() || live.ircWakesPending || live.hasPostPromptWork;
		}

		// Mode owners do not expose their scheduled-turn probe. Prove autonomous
		// scheduling disabled; an active/paused mode is conservatively unknown.
		if (ctx.mode === "tui") {
			const modes = ctx.sessionModes?.getState();
			if (!modes || modes.goal.status !== "inactive" || modes.loop.status !== "inactive"
				|| modes.vibe.status !== "inactive") unknown.push("autonomous_scheduler_unavailable");
		} else if (ctx.mode === "rpc") {
			if (typeof session.getGoalModeState !== "function" || session.getGoalModeState() !== undefined) {
				unknown.push("autonomous_scheduler_unavailable");
			}
		} else unknown.push("autonomous_scheduler_unavailable");
		result.isSettled = blocked ? false : unknown.length ? null : true;
	} catch {
		// A host capability may be absent or transiently unavailable during switching.
		unknown.push("host_activity_read_failed");
		result.isSettled = null;
	}
	return result;
}

export function formatActivity(info: Partial<PeerActivity>): string {
	const { activeJobs, activeSubagents } = info.activity ?? {};
	const settled = info.isSettled === true ? "yes" : info.isSettled === false ? "no" : "unknown";
	return `jobs:${activeJobs ?? "?"} agents:${activeSubagents ?? "?"} settled:${settled}`;
}
