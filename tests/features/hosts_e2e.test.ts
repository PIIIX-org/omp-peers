// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { hostLabel, ensureHostId } from "../../lib/features/hosts_wire";
import { BRIDGE_SCRIPT, allFileText, startSession, tmpHome, writeFakeSsh, type FakeSession } from "./hosts_helpers";

// Two disposable homes stand in for two machines. The "ssh" is a script that checks its exact argv and then runs the
// real remote bridge in the second home; no network is involved.
const LOCAL_SESSION = "p00000000000000a1";
const TARGET = "ops-box";

let local: string;
let remote: string;
let tools: string;
let log: string;
let fake: string;
let worker: FakeSession | undefined;
beforeEach(() => {
	local = tmpHome();
	remote = tmpHome();
	tools = tmpHome();
	log = path.join(tools, "ssh.log");
	fake = writeFakeSsh(tools, TARGET, remote, log);
	worker = undefined;
});
afterEach(() => {
	worker?.close();
	for (const dir of [local, remote, tools]) fs.rmSync(dir, { recursive: true, force: true });
});

async function hosts(...args: string[]): Promise<string> {
	const child = path.join(import.meta.dir, "child_hosts.ts");
	const proc = Bun.spawn([process.execPath, child, local, LOCAL_SESSION, ...args], {
		env: { PATH: process.env.PATH ?? "", HOME: local, OMP_PEERS_SSH_BIN: fake, ["ANTHROPIC_API" + "_KEY"]: "must-not-reach-ssh" }, stdout: "pipe", stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	expect(await proc.exited).toBe(0);
	expect(stderr).toBe("");
	return stdout.trimEnd();
}
const sshCalls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0);

async function bridge(request: Record<string, unknown>): Promise<Record<string, unknown>> {
	const proc = Bun.spawn([process.execPath, BRIDGE_SCRIPT], { env: { PATH: process.env.PATH ?? "", HOME: remote }, stdin: new Blob([`${JSON.stringify(request)}\n`]), stdout: "pipe", stderr: "pipe" });
	const out = await new Response(proc.stdout).text();
	await proc.exited;
	return JSON.parse(out);
}
const direct = (op: string, extra: Record<string, unknown> = {}) => ({
	v: 1, id: Bun.randomUUIDv7().replaceAll("-", "").slice(0, 32).padEnd(32, "0"), ts: Date.now(), hops: 0,
	origin: { hostId: "0123456789abcdef", name: hostLabel("0123456789abcdef") }, op, ...extra,
});

describe("through a fake ssh to the real remote bridge", () => {
	test("configure, test (pin), list sessions, message once with the origin marker, honour pause, refuse control ops and replays, remove", async () => {
		worker = await startSession(remote, "w1", { name: "remote-worker" });
		expect(await hosts("list")).toBe("no hosts configured (local-only); add one with /peers hosts add <name> <ssh>");
		expect(sshCalls()).toBe(0);

		expect(await hosts("add", "alpha", TARGET)).toStartWith("added host alpha (ops-box); nothing was contacted.");
		expect(sshCalls()).toBe(0);
		const remoteId = await ensureHostId(remote);
		expect(await hosts("test", "alpha")).toBe(`alpha: ok; host id ${remoteId} (pinned); bridge version 1`);
		expect(sshCalls()).toBe(1);
		expect(JSON.parse(fs.readFileSync(path.join(local, ".omp/agent/peer-state/hosts.json"), "utf8")).hosts[0].remoteId).toBe(remoteId);

		expect(await hosts("sessions", "alpha")).toBe(`sessions on alpha (1):\nalpha:remote-worker (${worker.id})`);

		const localId = await ensureHostId(local);
		expect(localId).not.toBe(remoteId);
		expect(await hosts("msg", `alpha:${worker.id}`, "hello", "from", "the", "other", "host")).toBe(`delivered to alpha:${worker.id}`);
		expect(worker.requests).toEqual([{
			op: "message", text: "hello from the other host", origin: "remote", hops: 1,
			from: { id: `${hostLabel(localId)}:${LOCAL_SESSION}`, name: "origin-worker" },
		}]);

		// The remote session's own pause applies exactly as for a local sender: nothing is delivered.
		worker.close();
		worker = await startSession(remote, "w1", { name: "remote-worker", reply: () => ({ ok: false, status: "deferred", paused: true, error: "session is paused" }), row: { paused: true } });
		expect(await hosts("sessions", "alpha")).toBe(`sessions on alpha (1):\nalpha:remote-worker (${worker.id}) [paused]`);
		expect(await hosts("msg", `alpha:${worker.id}`, "are", "you", "there")).toBe(`not delivered: alpha:${worker.id} is paused; resend after its user resumes it`);
		expect(worker.requests).toHaveLength(1);
		expect(await hosts("msg", "alpha:p00000000000000ff", "anyone")).toBe("not delivered: alpha:p00000000000000ff is not running");

		// Anything but hello, list and message is refused by the bridge itself; the session sees nothing.
		const before = worker.connections;
		for (const op of ["prompt", "abort", "compact", "model", "setting", "rename", "shutdown", "pause", "tail", "status"]) {
			expect(await bridge(direct(op, { to: worker.id, text: "x", from: { id: LOCAL_SESSION, name: "n" } }))).toMatchObject({ ok: false, error: "operation not allowed", hostId: remoteId });
		}
		expect(worker.connections).toBe(before);

		// A repeated request id is refused the second time and reaches the session once.
		const once = direct("message", { to: worker.id, text: "replay me", from: { id: LOCAL_SESSION, name: "n" } });
		worker.close();
		worker = await startSession(remote, "w1", { name: "remote-worker" });
		expect(await bridge(once)).toMatchObject({ ok: true, status: "delivered" });
		expect(await bridge(once)).toMatchObject({ ok: false, error: "duplicate request" });
		expect(worker.requests.filter(r => r.text === "replay me")).toHaveLength(1);

		// No listener on either side: the only socket under either home is the worker's own.
		const sockets = (dir: string) => fs.readdirSync(path.join(dir, ".omp", "run", "peers"), { recursive: true }).map(String).filter(f => f.endsWith(".sock"));
		expect(sockets(remote)).toEqual([`${worker.id}.sock`]);
		expect(fs.existsSync(path.join(local, ".omp", "run"))).toBe(false);

		// Removing the host stops all use at once: no further ssh call is made.
		const calls = sshCalls();
		expect(await hosts("remove", "alpha")).toStartWith("removed host alpha and its pin");
		for (const args of [["test", "alpha"], ["sessions", "alpha"], ["msg", `alpha:${worker.id}`, "hi"]]) expect(await hosts(...args)).toBe("error: no host named alpha");
		expect(sshCalls()).toBe(calls);

		// Neither home holds anything credential-like, including the calling environment's API key (the ssh environment allowlist itself is unit tested).
		const written = [...allFileText(local), ...allFileText(remote)].join("\n");
		for (const needle of ["PRIVATE KEY", "must-not-reach-ssh", "BEGIN", "passphrase", "hunter2"]) expect(written).not.toContain(needle);
		for (const dir of [local, remote]) {
			const state = path.join(dir, ".omp/agent/peer-state");
			for (const file of fs.readdirSync(state)) if (!file.endsWith(".lock")) expect(fs.statSync(path.join(state, file)).mode & 0o777).toBe(0o600);
			expect(fs.statSync(state).mode & 0o777).toBe(0o700);
		}
	});

	test("a changed destination is refused: the pin from another machine does not match this bridge", async () => {
		worker = await startSession(remote, "w1");
		await hosts("add", "alpha", TARGET);
		await hosts("test", "alpha");
		const pinnedId = await ensureHostId(remote);
		fs.writeFileSync(path.join(remote, ".omp/agent/peer-state/host-id.json"), JSON.stringify({ version: 1, hostId: "aaaaaaaaaaaaaaaa" }), { mode: 0o600 });
		const refused = "error: alpha: host identity changed: refused; re-pin with hosts pin alpha after verifying";
		expect(await hosts("test", "alpha")).toBe(refused);
		expect(await hosts("sessions", "alpha")).toBe(refused);
		expect(await hosts("msg", `alpha:${worker.id}`, "hi")).toBe(refused);
		expect(worker.requests).toEqual([]);
		expect(await hosts("pin", "alpha")).toBe(`alpha: ok; host id aaaaaaaaaaaaaaaa (re-pinned (was ${pinnedId})); bridge version 1`);
		expect(await hosts("sessions", "alpha")).toBe(`sessions on alpha (1):\nalpha:worker (${worker.id})`);
	});

	test("the fake ssh rejects any other argv, so a changed option or target would fail these tests", async () => {
		const proc = Bun.spawn([fake, "-o", "BatchMode=no", "--", TARGET, "omp-peers-remote"], { stdout: "pipe", stderr: "pipe" });
		expect(await proc.exited).toBe(97);
	});
});
