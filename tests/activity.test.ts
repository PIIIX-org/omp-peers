// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { AdvisorStatusOverviewEntry } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { isLocalAgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { asyncJobSnapshot, asyncJobTree } from "@oh-my-pi/pi-coding-agent/session/async-job-views";
import { formatActivity, readActivity } from "../lib/activity";

function deferred<T>() {
	return Promise.withResolvers<T>();
}

function setup() {
	const registry = new AgentRegistry();
	AgentRegistry.installGlobal(registry);
	const manager = new AsyncJobManager({ consumedResultEvictionMs: 0 });
	const session = {
		sessionManager: { getSessionId: () => "isolated-session" },
		isStreaming: false,
		hasAdmittedSubmission: false,
		queuedMessageCount: 0,
		ircWakesPending: false,
		hasPostPromptWork: false,
		getGoalModeState: () => undefined as object | undefined,
		getAdvisorStatusOverview: () => ({ configured: false, advisors: [] as AdvisorStatusOverviewEntry[] }),
		getAsyncJobTree: () => asyncJobTree(manager, "Main", { recentLimit: 0 }),
		hasPendingAsyncWork: () => manager.getRunningJobs({ ownerId: "Main" }).length > 0
			|| manager.getDeliveryState({ ownerId: "Main" }).queued > 0,
	};
	registry.register({ id: "Main", displayName: "Main", kind: "main", session: session as unknown as AgentSessionHandle });
	const ctx = {
		agent: { id: "Main" }, mode: "rpc", sessionManager: session.sessionManager,
		isIdle: () => !session.isStreaming,
		getAsyncJobSnapshot: () => asyncJobSnapshot(manager, "Main"),
	} as unknown as ExtensionContext;
	const host = { registry, isLocalSession: isLocalAgentSession };
	return { registry, manager, session, ctx, host, read: () => readActivity(ctx, host) };
}

const managers: AsyncJobManager[] = [];
afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1000 });
	AgentRegistry.resetGlobalForTests();
});

function fixture() {
	const value = setup();
	managers.push(value.manager);
	return value;
}

describe("peer activity metadata", () => {
	test("pending/completed job and in-flight delivery update without losing the wake gap", async () => {
		const { manager, read } = fixture();
		const body = deferred<string>();
		const delivery = deferred<void>();
		const entered = deferred<void>();
		manager.registerDeliverySink("Main", async () => {
			entered.resolve();
			await delivery.promise;
		});
		expect(read().isSettled).toBe(true);
		manager.register("bash", "private command must not be published", () => body.promise, { ownerId: "Main" });
		expect(read().activity.activeJobs).toBe(1);
		expect(read().hasPendingAsyncWork).toBe(true);
		expect(read().isSettled).toBe(false);
		body.resolve("private output must not be published");
		await entered.promise;
		expect(read().activity.activeJobs).toBe(0);
		expect(read().hasPendingAsyncWork).toBe(true);
		expect(read().isSettled).toBe(false);
		delivery.resolve();
		await manager.drainDeliveries({ timeoutMs: 1000 });
		expect(read().hasPendingAsyncWork).toBe(false);
		expect(read().isSettled).toBe(true);
		expect(JSON.stringify(read())).not.toContain("private");
	});

	test("cancelled job stops counting and does not schedule a completion wake", async () => {
		const { manager, read } = fixture();
		const stopped = Promise.withResolvers<string>();
		const id = manager.register("eval", "cancel me", ({ signal }) => {
			signal.addEventListener("abort", () => stopped.reject(signal.reason), { once: true });
			return stopped.promise;
		}, { ownerId: "Main" });
		expect(read().activity.activeJobs).toBe(1);
		expect(manager.cancel(id)).toBe(true);
		await manager.waitForAll();
		expect(read().activity.activeJobs).toBe(0);
		expect(read().hasPendingAsyncWork).toBe(false);
		expect(read().isSettled).toBe(true);
	});

	test("streaming descendants count; idle, parked and foreign agents do not", () => {
		const { registry, session, read } = fixture();
		const child = { ...session, isStreaming: true };
		registry.register({ id: "worker", displayName: "worker", kind: "sub", parentId: "Main",
			session: child as unknown as AgentSessionHandle });
		registry.setStatus("worker", "running");
		registry.register({ id: "foreign", displayName: "foreign", kind: "sub", parentId: "other",
			session: child as unknown as AgentSessionHandle });
		registry.setStatus("foreign", "running");
		expect(read().activity.activeSubagents).toBe(1);
		expect(read().isSettled).toBe(false);
		child.isStreaming = false;
		registry.setStatus("worker", "idle");
		expect(read().activity.activeSubagents).toBe(0);
		expect(read().isSettled).toBe(true);
		registry.detachSession("worker");
		registry.setStatus("worker", "parked");
		expect(read().activity.activeSubagents).toBe(0);
		expect(read().isSettled).toBe(true);
	});

	test("descendant jobs count without double-counting task jobs as subagents", async () => {
		const { registry, session, manager, read } = fixture();
		registry.register({ id: "child", displayName: "child", kind: "sub", parentId: "Main",
			session: { ...session, hasPendingAsyncWork: () => false } as unknown as AgentSessionHandle });
		const body = deferred<string>();
		const id = manager.register("bash", "child job", () => body.promise, { ownerId: "child" });
		expect(read().activity).toMatchObject({ activeJobs: 1, activeSubagents: 0 });
		expect(read().isSettled).toBe(false);
		manager.acknowledgeDeliveries([id]);
		body.resolve("done");
		await manager.waitForAll();
		expect(read().activity.activeJobs).toBe(0);
	});

	test("delivery suppression does not turn a running job into quiescence", async () => {
		const { session, manager, read } = fixture();
		const body = deferred<string>();
		const id = manager.register("bash", "suppressed job", () => body.promise, { ownerId: "Main" });
		manager.acknowledgeDeliveries([id]);
		session.hasPendingAsyncWork = () => false;
		expect(read().hasPendingAsyncWork).toBe(false);
		expect(read().activity.activeJobs).toBe(1);
		expect(read().isSettled).toBe(false);
		body.resolve("done");
		await manager.waitForAll();
		expect(read().isSettled).toBe(true);
	});

	test("a remote idle descendant without wake probes keeps quiescence unknown", () => {
		const { registry, session, read } = fixture();
		registry.register({ id: "remote", displayName: "remote", kind: "sub", parentId: "Main",
			session: { ...session, instanceKey: "remote:instance" } as unknown as AgentSessionHandle });
		expect(read().activity.activeSubagents).toBe(0);
		expect(read().isSettled).toBeNull();
		expect(read().activity.unknownReasons).toContain("descendant_wake_state_unavailable");
	});

	test.each(["hasAdmittedSubmission", "ircWakesPending", "hasPostPromptWork"] as const)("%s prevents settled", key => {
		const { session, read } = fixture();
		session[key] = true;
		expect(read().isSettled).toBe(false);
		session[key] = false;
		expect(read().isSettled).toBe(true);
	});

	test("queued messages and delivered-but-not-injected results prevent settled", () => {
		const { session, read } = fixture();
		session.queuedMessageCount = 1;
		expect(read().isSettled).toBe(false);
		session.queuedMessageCount = 0;
		session.hasPendingAsyncWork = () => true;
		expect(read().hasPendingAsyncWork).toBe(true);
		expect(read().isSettled).toBe(false);
	});

	test.each(["root", "child"])("%s advisor review backlog blocks settlement until drained", owner => {
		const { registry, session, read } = fixture();
		const reviewed = owner === "root" ? session : { ...session };
		if (owner === "child") registry.register({
			id: "reviewed-child", displayName: "reviewed child", kind: "sub", parentId: "Main",
			session: reviewed as unknown as AgentSessionHandle,
		});
		const advisor = { name: "reviewer", status: "running" as const, yielded: false, backlog: 1, isPaused: false };
		reviewed.getAdvisorStatusOverview = () => ({ configured: true, advisors: [advisor] });
		expect(read().activity).toMatchObject({ activeJobs: 0, activeSubagents: 0 });
		expect(read().hasPendingAsyncWork).toBe(false);
		expect(read().isSettled).toBe(false);
		advisor.backlog = 0;
		expect(read().isSettled).toBe(true);
		advisor.backlog = Number.NaN;
		expect(read().isSettled).toBeNull();
		Object.assign(reviewed, { getAdvisorStatusOverview: undefined });
		expect(read().isSettled).toBeNull();
		expect(read().activity.unknownReasons).toContain("advisor_review_state_unavailable");
	});

	test.each(["throws", "null entry"])("advisor probe %s preserves known counts and unknown settlement", failure => {
		const { session, read } = fixture();
		Object.assign(session, { getAdvisorStatusOverview: () => {
			if (failure === "throws") throw new Error("unavailable host probe");
			return { configured: true, advisors: [null] };
		} });
		const state = read();
		expect(state.activity).toMatchObject({ activeJobs: 0, activeSubagents: 0 });
		expect(state.isSettled).toBeNull();
		expect(state.activity.unknownReasons).toEqual(["advisor_review_state_unavailable"]);
	});

	test("unsupported services, null job snapshots and missing wake probes remain unknown", () => {
		const { ctx, host, session, read } = fixture();
		const unavailable = readActivity(ctx, undefined);
		expect(unavailable.activity.activeJobs).toBeNull();
		expect(unavailable.activity.activeSubagents).toBeNull();
		expect(unavailable.isSettled).toBeNull();
		Object.assign(session, { getAsyncJobTree: () => null, hasPendingAsyncWork: undefined });
		expect(read().activity.activeJobs).toBeNull();
		expect(read().hasPendingAsyncWork).toBeNull();
		expect(read().isSettled).toBeNull();
		expect(readActivity(undefined, host).isSettled).toBeNull();
		expect(formatActivity({})).toBe("jobs:? agents:? settled:unknown");
	});

	test("session switch cannot report another session's zero counts", () => {
		const { ctx, host } = fixture();
		const switched = { ...ctx, sessionManager: { getSessionId: () => "different-session" } } as unknown as ExtensionContext;
		expect(readActivity(switched, host).activity.activeJobs).toBeNull();
		expect(readActivity(switched, host).isSettled).toBeNull();
	});

	test("unavailable scheduler proof and autonomous modes prevent a settled claim", () => {
		const { ctx, host, session, read } = fixture();
		session.getGoalModeState = () => ({ enabled: true });
		expect(read().isSettled).toBeNull();
		expect(read().activity.unknownReasons).toContain("autonomous_scheduler_unavailable");
		const tui = { ...ctx, mode: "tui" } as ExtensionContext;
		expect(readActivity(tui, host).isSettled).toBeNull();
		const inactive = { status: "inactive" as const };
		tui.sessionModes = { getState: () => ({ plan: inactive, goal: inactive, loop: inactive, vibe: inactive }),
			set: async () => { throw new Error("status must not control modes"); } };
		expect(readActivity(tui, host).isSettled).toBe(true);
		tui.sessionModes.getState = () => ({ plan: inactive, goal: inactive, loop: { status: "active" }, vibe: inactive });
		expect(readActivity(tui, host).isSettled).toBeNull();
	});
});
