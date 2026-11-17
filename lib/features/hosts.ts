// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

/**
 * Opt-in multi-host peers (`/peers hosts`): explicitly configured, authenticated, user-driven requests to
 * another machine over the user's own `ssh` client. Nothing here listens, discovers, connects in the
 * background or relays. See docs/features/hosts.md for the trust model and exact limits.
 *
 * Each request is one short-lived `ssh` subprocess (argv only, never a shell) whose remote end is the forced
 * command `scripts/omp-peers-remote.ts`. The destination is authenticated by the user's known_hosts
 * (`StrictHostKeyChecking=yes`), the peer by the user's own ssh key. This module stores no key, password,
 * passphrase or host key and never reads an ssh private key.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { FeatureHost } from "./host";
import type { Feature } from "./index";
import {
	BRIDGE_COMMAND, BRIDGE_VERSION, HOST_ID_RE, HOST_NAME_RE, MAX_HOSTS, MAX_SESSIONS_LISTED, MAX_TEXT_BYTES, PEER_ID_RE,
	cleanName, ensureHostId, hasOnlyKeys, hostLabel, isReason, isRecord, type Reason,
} from "./hosts_wire";
import { looksLikeSecret } from "./secrets";
import { readState, stateRoot, updateState } from "./store";

export const REQUEST_TIMEOUT_MS = 20_000;
export const STDOUT_MAX = 256 * 1024;
export const STDERR_MAX = 4 * 1024;
export const MAX_ATTEMPTS = 2;
export const BACKOFF_MS = 2_000;
export const BREAKER_FAILURES = 3;
export const COOLDOWN_MS = 5 * 60_000;
export const RATE_PER_HOUR = 20;
const HOUR_MS = 3_600_000;
const MAX_SSH_TARGET = 255;
const MAX_LAST = 160;

/** Fixed ssh options the plugin always adds. No option is ever taken from config, a command or a reply. */
export const SSH_OPTIONS: readonly string[] = [
	"-o", "BatchMode=yes",
	"-o", "StrictHostKeyChecking=yes",
	"-o", "ConnectTimeout=10",
	"-o", "ServerAliveInterval=5",
	"-o", "ServerAliveCountMax=2",
	"-o", "ForwardAgent=no",
	"-o", "ForwardX11=no",
	"-o", "ClearAllForwardings=yes",
	"-o", "PermitLocalCommand=no",
	"-o", "UpdateHostKeys=no",
	"-o", "ControlMaster=no",
	"-o", "ControlPath=none",
	"-T",
	"-o", "RequestTTY=no",
	"-o", "LogLevel=ERROR",
];

// ---- Configuration -----------------------------------------------------------------------------

export interface HostEntry {
	/** Local label for the host: `[a-z0-9-]{1,24}`. */
	name: string;
	/** An ssh config alias or `user@host`; see `sshTargetError`. */
	ssh: string;
	/** The remote bridge's host id, pinned by `test`/`pin`; absent until then. */
	remoteId?: string;
}

interface HostsState {
	version: 1;
	hosts: HostEntry[];
}

export const hostsFile = (home: string) => path.join(stateRoot(home), "hosts.json");
const emptyHosts = (): HostsState => ({ version: 1, hosts: [] });

/** Why `target` is not an acceptable ssh target; undefined when it is. Strict on purpose: it becomes one argv element after `--`. */
export function sshTargetError(target: string): string | undefined {
	const ok = target.length <= MAX_SSH_TARGET && /^(?:[A-Za-z0-9_][A-Za-z0-9_.+-]{0,63}@)?[A-Za-z0-9_][A-Za-z0-9_.:-]*$/.test(target);
	return ok ? undefined : "ssh target must be an ssh config alias or user@host (letters, digits, '.', '_', '-'; ':' in the host part; at most 255 characters; no leading '-', spaces or shell characters)";
}

function validateHosts(value: unknown): HostsState {
	if (!isRecord(value) || value.version !== 1 || !hasOnlyKeys(value, ["version", "hosts"]) || !Array.isArray(value.hosts)) throw new Error("unsupported version or malformed fields");
	if (value.hosts.length > MAX_HOSTS) throw new Error(`more than ${MAX_HOSTS} hosts`);
	const names = new Set<string>();
	for (const entry of value.hosts) {
		const ok = isRecord(entry) && hasOnlyKeys(entry, ["name", "ssh"], ["remoteId"]) && typeof entry.name === "string" && HOST_NAME_RE.test(entry.name) &&
			typeof entry.ssh === "string" && sshTargetError(entry.ssh) === undefined &&
			(entry.remoteId === undefined || (typeof entry.remoteId === "string" && HOST_ID_RE.test(entry.remoteId)));
		if (!ok || names.has((entry as unknown as HostEntry).name)) throw new Error("malformed host entry");
		names.add((entry as unknown as HostEntry).name);
	}
	return value as unknown as HostsState;
}

/** The configured hosts, read fresh. Throws (callers fail closed: no connection) when the file is unreadable, a symlink, not a regular file or invalid. */
export function readHosts(home: string): HostEntry[] {
	return readState(hostsFile(home), emptyHosts, validateHosts).hosts;
}

// ---- Per-host runtime state: breaker, rate limit, last outcome ---------------------------------

interface RuntimeEntry {
	name: string;
	/** Consecutive transport failures; reset by any well-formed bridge answer. */
	failures: number;
	coolUntil?: number;
	lastAt?: number;
	last?: string;
	/** Start times (ms) of requests in the last hour. */
	sends: number[];
}

interface RuntimeState {
	version: 1;
	hosts: RuntimeEntry[];
}

export const runtimeFile = (home: string) => path.join(stateRoot(home), "hosts-runtime.json");
const emptyRuntime = (): RuntimeState => ({ version: 1, hosts: [] });

function validateRuntime(value: unknown): RuntimeState {
	if (!isRecord(value) || value.version !== 1 || !hasOnlyKeys(value, ["version", "hosts"]) || !Array.isArray(value.hosts) || value.hosts.length > MAX_HOSTS) throw new Error("unsupported version or malformed fields");
	for (const entry of value.hosts) {
		const finite = (x: unknown) => typeof x === "number" && Number.isFinite(x);
		const ok = isRecord(entry) && hasOnlyKeys(entry, ["name", "failures", "sends"], ["coolUntil", "lastAt", "last"]) && typeof entry.name === "string" && HOST_NAME_RE.test(entry.name) &&
			Number.isInteger(entry.failures) && (entry.failures as number) >= 0 && Array.isArray(entry.sends) && entry.sends.length <= RATE_PER_HOUR && entry.sends.every(finite) &&
			(entry.coolUntil === undefined || finite(entry.coolUntil)) && (entry.lastAt === undefined || finite(entry.lastAt)) &&
			(entry.last === undefined || (typeof entry.last === "string" && entry.last.length <= MAX_LAST));
		if (!ok) throw new Error("malformed runtime entry");
	}
	return value as unknown as RuntimeState;
}

const freshRuntime = (name: string): RuntimeEntry => ({ name, failures: 0, sends: [] });

export function readRuntime(home: string, name: string): RuntimeEntry {
	return readState(runtimeFile(home), emptyRuntime, validateRuntime).hosts.find(entry => entry.name === name) ?? freshRuntime(name);
}

function putRuntime(state: RuntimeState, entry: RuntimeEntry): RuntimeState {
	const others = state.hosts.filter(other => other.name !== entry.name);
	return others.length >= MAX_HOSTS ? state : { version: 1, hosts: [...others, entry] };
}

/** Reserve one request slot: refuses while cooling down or at the hourly limit, otherwise counts the request. */
async function reserve(home: string, name: string, now: number): Promise<{ ok: true } | { ok: false; reason: string }> {
	return updateState<RuntimeState, { ok: true } | { ok: false; reason: string }>(runtimeFile(home), emptyRuntime, validateRuntime, current => {
		const entry = current.hosts.find(other => other.name === name) ?? freshRuntime(name);
		if (entry.coolUntil !== undefined && now < entry.coolUntil) return { result: { ok: false, reason: `host cooling down until ${new Date(entry.coolUntil).toISOString()}` } };
		const sends = entry.sends.filter(at => now - at < HOUR_MS);
		if (sends.length >= RATE_PER_HOUR) return { result: { ok: false, reason: `rate limit reached (${RATE_PER_HOUR} requests per hour) for host ${name}` } };
		return { state: putRuntime(current, { ...entry, sends: [...sends, now] }), result: { ok: true } };
	});
}

/**
 * Record how a request ended. A transport failure counts toward the breaker; any well-formed bridge answer resets it.
 * Never throws: by now the request may have been delivered, and the caller must still be able to report that. A
 * runtime file that cannot be updated makes the next `reserve` fail (closed) instead.
 */
async function record(home: string, name: string, now: number, last: string, transportFailure: boolean): Promise<void> {
	try {
		await updateState<RuntimeState, void>(runtimeFile(home), emptyRuntime, validateRuntime, current => {
			const entry = current.hosts.find(other => other.name === name) ?? freshRuntime(name);
			const failures = transportFailure ? entry.failures + 1 : 0;
			const next: RuntimeEntry = {
				name, failures, sends: entry.sends, lastAt: now, last: last.slice(0, MAX_LAST),
				...(failures >= BREAKER_FAILURES ? { coolUntil: now + COOLDOWN_MS } : {}),
			};
			return { state: putRuntime(current, next), result: undefined };
		});
	} catch {
		// see above
	}
}

// ---- ssh ---------------------------------------------------------------------------------------

/** `OMP_PEERS_SSH_BIN` is test-only: read once when this module loads, never from a command, config or remote request. */
const ENV_SSH_BIN = process.env.OMP_PEERS_SSH_BIN;
let sshBinCache: string | undefined;

/**
 * The ssh executable as an absolute path: the test override (an absolute path to an executable regular file
 * owned by this user, not group/world-writable) or the first absolute PATH entry containing an executable `ssh`.
 * Relative and empty PATH entries are ignored.
 */
export function resolveSshBin(override: string | undefined, pathVar: string | undefined, uid: number | undefined = process.getuid?.()): string {
	const executable = (file: string): fs.Stats | undefined => {
		try {
			const info = fs.statSync(file);
			return info.isFile() && (info.mode & 0o111) !== 0 ? info : undefined;
		} catch {
			return undefined;
		}
	};
	if (override !== undefined) {
		const info = path.isAbsolute(override) ? executable(override) : undefined;
		if (!info || info.uid !== uid || (info.mode & 0o022) !== 0) throw new Error("OMP_PEERS_SSH_BIN must be an absolute path to an executable regular file you own that others cannot write");
		return override;
	}
	for (const dir of (pathVar ?? "").split(path.delimiter)) {
		if (!dir || !path.isAbsolute(dir)) continue;
		const candidate = path.join(dir, "ssh");
		if (executable(candidate)) return candidate;
	}
	throw new Error("ssh client not found in an absolute PATH entry");
}

/** The exact argv of one request: `[bin, ...SSH_OPTIONS, "--", target, BRIDGE_COMMAND]`. Run without a shell. */
export const sshArgv = (bin: string, target: string): string[] => [bin, ...SSH_OPTIONS, "--", target, BRIDGE_COMMAND];

export interface RunResult {
	exitCode: number | null;
	stdout: string;
	/** At most STDERR_MAX bytes; classified, never shown. */
	stderr: string;
	timedOut: boolean;
	/** Output exceeded STDOUT_MAX; the process group was killed. */
	overflow: boolean;
	spawnFailed: boolean;
}

export interface RunOptions {
	timeoutMs: number;
	stdoutMax: number;
	stderrMax: number;
	env: Record<string, string>;
}

/** The environment ssh gets: just what it needs to find the user's config, keys and agent. No API keys or session variables. */
export function sshEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const env: Record<string, string> = { LC_ALL: "C" };
	for (const key of ["HOME", "PATH", "USER", "LOGNAME", "SSH_AUTH_SOCK"]) if (source[key] !== undefined) env[key] = source[key];
	return env;
}

/** One ssh subprocess in its own process group: stdin gets `stdin` then EOF, the group is killed on timeout or output overflow. */
export function runSsh(argv: string[], stdin: string, options: RunOptions): Promise<RunResult> {
	const { promise, resolve } = Promise.withResolvers<RunResult>();
	const out: Buffer[] = [];
	const err: Buffer[] = [];
	let outSize = 0;
	let errSize = 0;
	let timedOut = false;
	let overflow = false;
	let settled = false;
	const child = spawn(argv[0], argv.slice(1), { detached: true, shell: false, stdio: ["pipe", "pipe", "pipe"], env: options.env });
	const killGroup = () => {
		try {
			if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
	};
	const settle = (exitCode: number | null, spawnFailed: boolean) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		resolve({ exitCode, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut, overflow, spawnFailed });
	};
	const timer = setTimeout(() => {
		timedOut = true;
		killGroup();
	}, options.timeoutMs);
	child.stdout.on("data", (chunk: Buffer) => {
		outSize += chunk.length;
		if (outSize > options.stdoutMax) {
			overflow = true;
			killGroup();
			return;
		}
		out.push(chunk);
	});
	child.stderr.on("data", (chunk: Buffer) => {
		if (errSize >= options.stderrMax) return;
		const kept = chunk.subarray(0, options.stderrMax - errSize);
		err.push(kept);
		errSize += kept.length;
	});
	child.stdin.on("error", () => {});
	child.stdin.end(stdin);
	child.on("error", () => settle(null, true));
	child.on("close", code => settle(code, false));
	return promise;
}

// ---- One request -------------------------------------------------------------------------------

export interface HostsDeps {
	/** Absolute path of the ssh executable; throws when none is usable. */
	sshBin(): string;
	run(argv: string[], stdin: string): Promise<RunResult>;
	sleep(ms: number): Promise<void>;
}

const defaultDeps: HostsDeps = {
	sshBin: () => (sshBinCache ??= resolveSshBin(ENV_SSH_BIN, process.env.PATH)),
	run: (argv, stdin) => runSsh(argv, stdin, { timeoutMs: REQUEST_TIMEOUT_MS, stdoutMax: STDOUT_MAX, stderrMax: STDERR_MAX, env: sshEnv() }),
	sleep: ms => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, ms);
		return promise;
	},
};

type Payload = { op: "hello" } | { op: "list" } | { op: "message"; to: string; text: string; from: { id: string; name: string } };

export type Outcome =
	| { kind: "ok"; hostId: string; data: Record<string, unknown> }
	/** The bridge answered and refused, with one of its fixed reasons. */
	| { kind: "refused"; reason: Reason | "unrecognized" }
	/** The destination's host id is not the pinned one. `acted`: it answered `ok`, so a request may have taken effect there. */
	| { kind: "mismatch"; acted: boolean }
	/** Nothing was sent. */
	| { kind: "not-sent"; reason: string }
	/** A transport failure. `unknown`: a message may have been delivered, so it was not retried. */
	| { kind: "failed"; reason: string; unknown: boolean };

interface Failure {
	reason: string;
	retryable: boolean;
	/** The failure proves the request never reached the remote bridge (so even a message may be retried). */
	notSent: boolean;
}

const NOT_SENT_STDERR = /could not resolve hostname|connection refused|no route to host|network is unreachable|connect to host .{1,255} port \d+: (?:connection|operation) timed out/i;

function classify(run: RunResult): Failure {
	if (run.timedOut) return { reason: "timeout", retryable: true, notSent: false };
	if (run.overflow) return { reason: "bridge protocol error (output too large)", retryable: false, notSent: false };
	if (/host key verification failed|remote host identification has changed/i.test(run.stderr)) return { reason: "host key verification failed", retryable: false, notSent: true };
	if (/permission denied/i.test(run.stderr)) return { reason: "permission denied", retryable: false, notSent: true };
	if (run.spawnFailed) return { reason: "ssh failed (could not start)", retryable: false, notSent: true };
	return { reason: `ssh failed (exit ${run.exitCode ?? "signal"})`, retryable: true, notSent: NOT_SENT_STDERR.test(run.stderr) };
}

type Parsed =
	| { kind: "ok"; hostId: string; data: Record<string, unknown> }
	| { kind: "refused"; reason: Reason | "unrecognized"; hostId?: string }
	| { kind: "invalid" };

/** Exactly one JSON line, schema v1, answering `requestId`; anything else is invalid. Replies are never trusted beyond these checks. */
export function parseReply(stdout: string, requestId: string): Parsed {
	if (!stdout.endsWith("\n") || stdout.indexOf("\n") !== stdout.length - 1) return { kind: "invalid" };
	let reply: unknown;
	try {
		reply = JSON.parse(stdout);
	} catch {
		return { kind: "invalid" };
	}
	if (!isRecord(reply) || reply.v !== 1 || (reply.id !== undefined && reply.id !== requestId)) return { kind: "invalid" };
	const hostId = typeof reply.hostId === "string" && HOST_ID_RE.test(reply.hostId) ? reply.hostId : undefined;
	if (reply.ok === true) {
		if (!hostId || reply.id !== requestId || reply.bridge !== BRIDGE_VERSION) return { kind: "invalid" };
		const data = { ...reply };
		for (const key of ["v", "id", "ok", "hostId", "bridge"]) delete data[key];
		return { kind: "ok", hostId, data };
	}
	if (reply.ok === false && (reply.hostId === undefined || hostId)) return { kind: "refused", reason: isReason(reply.error) ? reply.error : "unrecognized", hostId };
	return { kind: "invalid" };
}

/**
 * One user command's request to one host: at most MAX_ATTEMPTS attempts with BACKOFF_MS between them, only for
 * transport failures. A message is retried only when the failure proves nothing was delivered. `pinned` is the
 * host id the destination must have (also sent as `expect` so the bridge refuses before acting).
 */
async function exchange(deps: HostsDeps, host: Pick<FeatureHost, "home" | "now">, entry: HostEntry, payload: Payload, pinned: string | undefined): Promise<Outcome> {
	const bin = deps.sshBin();
	const origin = await ensureHostId(host.home);
	let last: Failure | undefined;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const slot = await reserve(host.home, entry.name, host.now());
		if (!slot.ok) return last ? { kind: "failed", reason: last.reason, unknown: false } : { kind: "not-sent", reason: slot.reason };
		const id = randomBytes(16).toString("hex");
		const line = `${JSON.stringify({ v: 1, id, ts: host.now(), hops: 0, origin: { hostId: origin, name: hostLabel(origin) }, ...(pinned ? { expect: pinned } : {}), ...payload })}\n`;
		const run = await deps.run(sshArgv(bin, entry.ssh), line);
		const parsed = run.exitCode === 0 && !run.timedOut && !run.overflow ? parseReply(run.stdout, id) : undefined;
		if (parsed?.kind === "ok" || parsed?.kind === "refused") {
			const mismatch = (parsed.hostId !== undefined && pinned !== undefined && parsed.hostId !== pinned) || (parsed.kind === "refused" && parsed.reason === "host identity mismatch");
			const outcome: Outcome = mismatch ? { kind: "mismatch", acted: parsed.kind === "ok" } : parsed.kind === "ok" ? parsed : { kind: "refused", reason: parsed.reason };
			await record(host.home, entry.name, host.now(), outcome.kind === "ok" ? "ok" : outcome.kind === "mismatch" ? "host identity changed: refused" : `bridge refused: ${outcome.kind === "refused" ? outcome.reason : ""}`, false);
			return outcome;
		}
		const failure: Failure = parsed ? { reason: "bridge protocol error", retryable: false, notSent: false } : classify(run);
		await record(host.home, entry.name, host.now(), failure.reason, true);
		last = failure;
		if (payload.op === "message" && !failure.notSent) return { kind: "failed", reason: failure.reason, unknown: true };
		if (!failure.retryable || attempt === MAX_ATTEMPTS) break;
		await deps.sleep(BACKOFF_MS);
	}
	return { kind: "failed", reason: last!.reason, unknown: false };
}

// ---- Commands ----------------------------------------------------------------------------------

const USAGE = [
	"usage: /peers hosts add <name> <ssh> | remove <name> | list | status [name] | test <name> | pin <name> | sessions <name> | msg <name>:<peer-id> <text>",
	"  <name>: 1-24 characters a-z 0-9 '-'; <ssh>: an ssh config alias or user@host. add/remove/test/pin are master only.",
].join("\n");
const MASTER_ONLY = "only the master session may change or test hosts; run /peers master first";
/** The header the receiving session puts on a peer message; text containing it is a forwarded message, never relayed. */
const PEER_MESSAGE_MARKER = "[Message from peer session";

const NOT_DELIVERED: Record<string, (target: string) => string> = {
	"session paused": target => `not delivered: ${target} is paused; resend after its user resumes it`,
	"session refuses inbound": target => `not delivered: ${target} refuses inbound requests`,
	"session rate limited": target => `not delivered: ${target} is rate limited; try again later`,
	"session offline": target => `not delivered: ${target} is not running`,
	"session unreachable": target => `not delivered: ${target} could not be reached on its host`,
	"delivery failed": target => `not delivered: ${target} did not accept the message`,
};

const changedText = (name: string) => `host identity changed: refused; re-pin with hosts pin ${name} after verifying`;

function find(hosts: HostEntry[], name: string): HostEntry | undefined {
	return hosts.find(entry => entry.name === name);
}

function describe(entry: HostEntry, runtime: RuntimeEntry, now: number, detail: boolean): string {
	const cooling = runtime.coolUntil !== undefined && now < runtime.coolUntil;
	const state = cooling ? `cooling until ${new Date(runtime.coolUntil!).toISOString()}` : runtime.failures >= BREAKER_FAILURES ? "ready (next request is a probe)" : "ready";
	const last = runtime.last !== undefined && runtime.lastAt !== undefined ? `${runtime.last} (${new Date(runtime.lastAt).toISOString()})` : "never used";
	if (!detail) return `${entry.name}: ${entry.ssh}, pinned ${entry.remoteId ?? "no"}, ${state}, last: ${last}`;
	return [
		`host ${entry.name}`,
		`  ssh target: ${entry.ssh}`,
		`  pinned host id: ${entry.remoteId ?? `none (run /peers hosts test ${entry.name})`}`,
		`  state: ${state}`,
		`  consecutive transport failures: ${runtime.failures}`,
		`  requests in the last hour: ${runtime.sends.filter(at => now - at < HOUR_MS).length}/${RATE_PER_HOUR}`,
		`  last outcome: ${last}`,
	].join("\n");
}

async function setPin(home: string, entry: HostEntry, hostId: string): Promise<boolean> {
	return updateState<HostsState, boolean>(hostsFile(home), emptyHosts, validateHosts, current => {
		const index = current.hosts.findIndex(other => other.name === entry.name && other.ssh === entry.ssh);
		if (index < 0) return { result: false };
		const hosts = current.hosts.map((other, i) => (i === index ? { ...other, remoteId: hostId } : other));
		return { state: { version: 1, hosts }, result: true };
	});
}

/** The sessions a reply lists, re-validated and capped here regardless of what the bridge claims; unknown fields never display. */
function readSessions(data: Record<string, unknown>): Array<{ id: string; name: string; busy?: boolean; paused?: boolean; inbound?: "accept" | "refuse" }> | undefined {
	if (!Array.isArray(data.sessions)) return undefined;
	const rows: Array<{ id: string; name: string; busy?: boolean; paused?: boolean; inbound?: "accept" | "refuse" }> = [];
	for (const row of data.sessions.slice(0, MAX_SESSIONS_LISTED)) {
		if (!isRecord(row) || typeof row.id !== "string" || !PEER_ID_RE.test(row.id) || typeof row.name !== "string") return undefined;
		const name = cleanName(row.name);
		rows.push({
			id: row.id,
			name: looksLikeSecret(name) ? "[withheld]" : name,
			...(typeof row.busy === "boolean" ? { busy: row.busy } : {}),
			...(typeof row.paused === "boolean" ? { paused: row.paused } : {}),
			...(row.inbound === "accept" || row.inbound === "refuse" ? { inbound: row.inbound } : {}),
		});
	}
	return rows;
}

export function createHosts(deps: HostsDeps): Feature {
	async function command(args: string[], host: FeatureHost): Promise<string> {
		const [sub, ...rest] = args;
		try {
			switch (sub) {
				case "add": return await add(rest, host);
				case "remove": return await remove(rest, host);
				case "list": return rest.length ? USAGE : list(host);
				case "status": return rest.length > 1 ? USAGE : status(rest[0], host);
				case "test": return await probe(rest, host, false);
				case "pin": return await probe(rest, host, true);
				case "sessions": return await sessions(rest, host);
				case "msg": return await msg(rest, host);
				default: return USAGE;
			}
		} catch (error) {
			return `error: ${(error as Error).message}`;
		}
	}

	async function add(args: string[], host: FeatureHost): Promise<string> {
		if (args.length !== 2) return USAGE;
		if (!host.isMaster()) return MASTER_ONLY;
		const [name, target] = args;
		if (!HOST_NAME_RE.test(name)) return "error: host name must be 1-24 characters: a-z, 0-9 or '-'";
		const invalid = sshTargetError(target);
		if (invalid) return `error: ${invalid}`;
		const result = await updateState<HostsState, string>(hostsFile(host.home), emptyHosts, validateHosts, current => {
			if (find(current.hosts, name)) return { result: `error: host ${name} already exists; remove it first` };
			if (current.hosts.length >= MAX_HOSTS) return { result: `error: host limit reached (${MAX_HOSTS}); remove a host first` };
			return { state: { version: 1, hosts: [...current.hosts, { name, ssh: target }] }, result: "" };
		});
		if (result) return result;
		// A re-added name starts with a clean breaker and rate window.
		await updateState<RuntimeState, void>(runtimeFile(host.home), emptyRuntime, validateRuntime, current => ({ state: { version: 1, hosts: current.hosts.filter(entry => entry.name !== name) }, result: undefined }));
		return `added host ${name} (${target}); nothing was contacted. Next: /peers hosts test ${name} to check the connection and pin its host id`;
	}

	async function remove(args: string[], host: FeatureHost): Promise<string> {
		if (args.length !== 1) return USAGE;
		if (!host.isMaster()) return MASTER_ONLY;
		const name = args[0];
		const removed = await updateState<HostsState, boolean>(hostsFile(host.home), emptyHosts, validateHosts, current => {
			if (!find(current.hosts, name)) return { result: false };
			return { state: { version: 1, hosts: current.hosts.filter(entry => entry.name !== name) }, result: true };
		});
		if (!removed) return `error: no host named ${name}`;
		await updateState<RuntimeState, void>(runtimeFile(host.home), emptyRuntime, validateRuntime, current => ({ state: { version: 1, hosts: current.hosts.filter(entry => entry.name !== name) }, result: undefined }));
		return `removed host ${name} and its pin; no further requests will be sent to it. Also delete its key's line from the remote authorized_keys (see docs/features/hosts.md)`;
	}

	function list(host: FeatureHost): string {
		const hosts = readHosts(host.home);
		if (!hosts.length) return "no hosts configured (local-only); add one with /peers hosts add <name> <ssh>";
		return hosts.map(entry => describe(entry, readRuntime(host.home, entry.name), host.now(), false)).join("\n");
	}

	function status(name: string | undefined, host: FeatureHost): string {
		const hosts = readHosts(host.home);
		if (name !== undefined && !find(hosts, name)) return `error: no host named ${name}`;
		const shown = name === undefined ? hosts : hosts.filter(entry => entry.name === name);
		if (!shown.length) return "no hosts configured (local-only); add one with /peers hosts add <name> <ssh>";
		return shown.map(entry => describe(entry, readRuntime(host.home, entry.name), host.now(), true)).join("\n");
	}

	/** Text for an outcome that is not `ok`, shared by every request command. */
	function failureText(outcome: Exclude<Outcome, { kind: "ok" }>, name: string, target?: string): string {
		switch (outcome.kind) {
			case "mismatch":
				// An `ok` answer from the wrong destination may have acted on a message; a refusal cannot have.
				if (target && outcome.acted) return `${target}: unknown outcome, not retried (${changedText(name)})`;
				return `error: ${name}: ${changedText(name)}`;
			case "not-sent": return `not sent: ${outcome.reason}`;
			case "refused":
				if (target && outcome.reason === "delivery unknown") return `${target}: unknown outcome, not retried (the remote session did not answer)`;
				if (target && NOT_DELIVERED[outcome.reason]) return NOT_DELIVERED[outcome.reason](target);
				return target ? `not delivered: bridge refused: ${outcome.reason}` : `error: ${name}: bridge refused: ${outcome.reason}`;
			case "failed":
				if (target) return outcome.unknown ? `${target}: unknown outcome, not retried (${outcome.reason})` : `not delivered: ${outcome.reason}`;
				return `error: ${name}: ${outcome.reason}`;
		}
	}

	/** `test` (pin only if unpinned) and `pin` (explicitly re-pin): one `hello`. */
	async function probe(args: string[], host: FeatureHost, repin: boolean): Promise<string> {
		if (args.length !== 1) return USAGE;
		if (!host.isMaster()) return MASTER_ONLY;
		const entry = find(readHosts(host.home), args[0]);
		if (!entry) return `error: no host named ${args[0]}`;
		const outcome = await exchange(deps, host, entry, { op: "hello" }, repin ? undefined : entry.remoteId);
		if (outcome.kind !== "ok") return failureText(outcome, entry.name);
		const pinned = !entry.remoteId || repin;
		if (pinned && !(await setPin(host.home, entry, outcome.hostId))) return `error: ${entry.name} changed while it was being tested; nothing was pinned`;
		const verb = !entry.remoteId ? "pinned" : repin && entry.remoteId !== outcome.hostId ? `re-pinned (was ${entry.remoteId})` : "matches the pin";
		return `${entry.name}: ok; host id ${outcome.hostId} (${verb}); bridge version ${BRIDGE_VERSION}`;
	}

	async function pinnedHost(name: string, host: FeatureHost): Promise<{ entry: HostEntry } | { error: string }> {
		const entry = find(readHosts(host.home), name);
		if (!entry) return { error: `error: no host named ${name}` };
		if (!entry.remoteId) return { error: `error: host ${name} is not pinned; run /peers hosts test ${name} first` };
		return { entry };
	}

	async function sessions(args: string[], host: FeatureHost): Promise<string> {
		if (args.length !== 1) return USAGE;
		const found = await pinnedHost(args[0], host);
		if ("error" in found) return found.error;
		const { entry } = found;
		const outcome = await exchange(deps, host, entry, { op: "list" }, entry.remoteId);
		if (outcome.kind !== "ok") return failureText(outcome, entry.name);
		const rows = readSessions(outcome.data);
		if (!rows) return `error: ${entry.name}: bridge protocol error`;
		if (!rows.length) return `no sessions on ${entry.name}`;
		return [`sessions on ${entry.name} (${rows.length}):`, ...rows.map(row =>
			`${entry.name}:${row.name} (${row.id})${[row.busy ? "busy" : "", row.paused ? "paused" : "", row.inbound === "refuse" ? "refuses" : ""].filter(Boolean).map(flag => ` [${flag}]`).join("")}`)].join("\n");
	}

	async function msg(args: string[], host: FeatureHost): Promise<string> {
		const [target, ...words] = args;
		const text = words.join(" ");
		const colon = target?.indexOf(":") ?? -1;
		if (colon < 1 || !text) return USAGE;
		const name = target.slice(0, colon);
		const peerId = target.slice(colon + 1);
		if (!PEER_ID_RE.test(peerId)) return "error: the remote session must be given as <name>:<peer-id> (see /peers hosts sessions <name>)";
		// A message from another session is never forwarded onward: only text typed here is sent.
		if (text.includes(PEER_MESSAGE_MARKER)) return "error: refusing to relay a peer message; type your own text";
		const bytes = Buffer.byteLength(text);
		if (bytes > MAX_TEXT_BYTES) return `error: message is ${bytes} bytes; the limit is ${MAX_TEXT_BYTES}`;
		if (looksLikeSecret(text)) return "error: the message looks like a credential or token; not sent. Describe it instead of including it";
		const self = host.self();
		if (!PEER_ID_RE.test(self.id)) return "error: session identity unavailable";
		const found = await pinnedHost(name, host);
		if ("error" in found) return found.error;
		const { entry } = found;
		const outcome = await exchange(deps, host, entry, { op: "message", to: peerId, text, from: { id: self.id, name: cleanName(self.name) } }, entry.remoteId);
		const label = `${entry.name}:${peerId}`;
		if (outcome.kind !== "ok") return failureText(outcome, entry.name, label);
		// An answer that is not an explicit delivery is not a delivery.
		return outcome.data.status === "delivered" ? `delivered to ${label}` : `${label}: unknown outcome, not retried (bridge protocol error)`;
	}

	return { name: "hosts", command };
}

export const hosts: Feature = createHosts(defaultDeps);
