// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FEATURES } from "../../lib/features";
import type { FeatureHost } from "../../lib/features/host";
import {
	BACKOFF_MS, BREAKER_FAILURES, COOLDOWN_MS, RATE_PER_HOUR, REQUEST_TIMEOUT_MS, SSH_OPTIONS, createHosts, hosts, hostsFile, parseReply, readHosts, readRuntime, resolveSshBin,
	runSsh, runtimeFile, sshArgv, sshEnv, sshTargetError, type HostsDeps, type RunResult,
} from "../../lib/features/hosts";
import { BRIDGE_COMMAND, HOST_NAME_RE, MAX_HOSTS, MAX_TEXT_BYTES, cleanName, capBytes, ensureHostId, hostIdFile, hostLabel, readRemoteMessage } from "../../lib/features/hosts_wire";
import { allFileText, tmpHome } from "./hosts_helpers";

const SELF = "p00000000000000a1";
const NOW = 1_700_000_000_000;
const REMOTE_ID = "fedcba9876543210";
const OTHER_ID = "0011223344556677";
const PEER = "p00000000000000b2";

let home: string;
let clock: number;
let master: boolean;
let runs: Array<{ argv: string[]; stdin: string }>;
let sleeps: number[];
type Step = (request: Record<string, unknown>) => Partial<RunResult> & { reply?: Record<string, unknown> };
let script: Step[];
beforeEach(() => {
	home = tmpHome();
	clock = NOW;
	master = true;
	runs = [];
	sleeps = [];
	script = [];
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const ok = (extra: Record<string, unknown> = {}, hostId = REMOTE_ID) => (request: Record<string, unknown>) => ({ reply: { v: 1, id: request.id, ok: true, hostId, bridge: 1, ...extra } });
const refused = (error: string, hostId = REMOTE_ID) => (request: Record<string, unknown>) => ({ reply: { v: 1, id: request.id, ok: false, hostId, error } });
const failed = (exitCode: number, stderr = ""): (() => Partial<RunResult>) => () => ({ exitCode, stderr, stdout: "" });
const timeout = (): Partial<RunResult> => ({ exitCode: null, timedOut: true });

const deps: HostsDeps = {
	sshBin: () => "/usr/bin/ssh",
	run: async (argv, stdin) => {
		runs.push({ argv, stdin });
		const step = script.shift();
		if (!step) throw new Error("unscripted ssh call");
		const result = step(JSON.parse(stdin));
		return {
			exitCode: 0, stdout: result.reply ? `${JSON.stringify(result.reply)}\n` : "", stderr: "", timedOut: false, overflow: false, spawnFailed: false, ...result,
		};
	},
	sleep: async ms => {
		sleeps.push(ms);
	},
};
const feature = createHosts(deps);

function host(): FeatureHost {
	return {
		home,
		now: () => clock,
		self: () => ({ id: SELF, name: "origin-worker" }),
		isMaster: () => master,
		acceptsRemote: () => true,
		peers: async () => [],
		groupsOf: () => [],
		notify: () => {},
		resolveGroup: async () => ({ recipients: [], skipped: [] }),
		resolveModel: async () => ({ ok: false, error: "not exercised by this suite" }),
		applyModel: async () => ({ ok: false, error: "not exercised by this suite" }),
		send: async () => ({ status: "offline" }),
	};
}
const say = (line: string) => feature.command(line.split(/\s+/).filter(Boolean), host());
const request = (index: number): Record<string, unknown> => JSON.parse(runs[index].stdin);
async function pinned(name = "alpha", target = "alpha-box") {
	expect(await say(`add ${name} ${target}`)).toContain("added host");
	script.push(ok());
	expect(await say(`test ${name}`)).toContain("pinned");
	runs.length = 0;
}

describe("registration", () => {
	test("the feature is registered under /peers hosts and with no hosts nothing runs", async () => {
		expect(FEATURES.map(f => f.name)).toContain("hosts");
		expect(hosts.name).toBe("hosts");
		expect(await say("list")).toBe("no hosts configured (local-only); add one with /peers hosts add <name> <ssh>");
		expect(await say("status")).toBe("no hosts configured (local-only); add one with /peers hosts add <name> <ssh>");
		expect(runs).toEqual([]);
		expect(fs.existsSync(hostsFile(home))).toBe(false);
	});

	test("usage for unknown or malformed subcommands", async () => {
		for (const line of ["", "nope", "add", "add a", "add a b c", "remove", "list extra", "status a b", "test", "pin", "sessions", "msg", "msg alpha:p1 "]) {
			expect(await say(line)).toStartWith("usage: /peers hosts add");
		}
		expect(runs).toEqual([]);
	});
});

describe("ssh target and host name validation", () => {
	const good = ["prod", "build-box", "ops@build-box", "user.name" + "@" + "host.example", "alias_1", "u+tag@h", "host:with:colons", "a".repeat(255 - 2) + "bc", "9lives"];
	for (const target of good) test(`accepts ${JSON.stringify(target.slice(0, 30))}`, () => expect(sshTargetError(target)).toBeUndefined());

	const bad: Array<[string, string]> = [
		["empty", ""], ["leading dash", "-oProxyCommand=x"], ["leading dash after at", "user@-host"], ["option-like with equals", "-F/dev/null"], ["double dash", "--"],
		["a space", "host name"], ["a tab", "host\tname"], ["a newline", "host\nname"], ["a trailing newline", "host\n"], ["a carriage return", "host\r"], ["NUL", "host\u0000"],
		["a semicolon", "host;ls"], ["a pipe", "host|ls"], ["an ampersand", "host&ls"], ["a dollar", "host$HOME"], ["parentheses", "host(1)"], ["a backtick", "host`id`"],
		["angle brackets", "host<in"], ["greater-than", "host>out"], ["quotes", 'host"x'], ["single quote", "host'x"], ["a backslash", "host\\x"], ["a glob", "ho*st"],
		["a slash", "host/path"], ["a URL", "ssh://host"], ["two at signs", "a@b@c"], ["an empty user", "@host"], ["an empty host", "user@"], ["a non-ASCII letter", "h\u00f6st"],
		["a bidi override", "host\u202e"], ["an equals sign", "a=b"], ["a percent sign", "host%1"], ["brackets", "[::1]"], ["256 characters", "a".repeat(256)], ["user over 64 characters", `${"u".repeat(65)}@h`],
	];
	for (const [label, target] of bad) test(`rejects ${label}`, () => expect(sshTargetError(target)).toBeString());

	test("host names are 1-24 characters of a-z 0-9 and dash", () => {
		for (const name of ["a", "prod-1", "0", "a".repeat(24), "-", "--x"]) expect(HOST_NAME_RE.test(name)).toBe(true);
		for (const name of ["", "A", "a".repeat(25), "a_b", "a.b", "a b", "a:b", "é", "a\n", "../x"]) expect(HOST_NAME_RE.test(name)).toBe(false);
	});

	test("add refuses every bad name and target without touching state", async () => {
		expect(await say("add Bad-Name box")).toStartWith("error: host name must be");
		expect(await say(`add ${"a".repeat(25)} box`)).toStartWith("error: host name must be");
		expect(await say("add ok -oProxyCommand=x")).toStartWith("error: ssh target must be");
		expect(await say("add ok a;b")).toStartWith("error: ssh target must be");
		expect(fs.existsSync(hostsFile(home))).toBe(false);
	});
});

describe("argv", () => {
	test("is exactly [bin, fixed options, '--', target, bridge command], one element each", () => {
		const argv = sshArgv("/abs/ssh", "ops@box");
		expect(argv).toEqual(["/abs/ssh", ...SSH_OPTIONS, "--", "ops@box", BRIDGE_COMMAND]);
		expect(argv.slice(-3)).toEqual(["--", "ops@box", "omp-peers-remote"]);
		expect(SSH_OPTIONS.filter(a => a === "-o")).toHaveLength((SSH_OPTIONS.length - 1) / 2);
	});

	test("carries every hardening option and no identity, config, proxy, port or user option", () => {
		const options = SSH_OPTIONS.filter((_, i) => SSH_OPTIONS[i - 1] === "-o");
		for (const required of ["BatchMode=yes", "StrictHostKeyChecking=yes", "ConnectTimeout=10", "ServerAliveInterval=5", "ServerAliveCountMax=2", "ForwardAgent=no", "ForwardX11=no", "ClearAllForwardings=yes", "PermitLocalCommand=no", "RequestTTY=no", "LogLevel=ERROR"]) {
			expect(options).toContain(required);
		}
		expect(SSH_OPTIONS).toContain("-T");
		expect(SSH_OPTIONS.join(" ")).not.toMatch(/IdentityFile|IdentitiesOnly|ProxyCommand|ProxyJump|-F|-i |-p |-l |-J|StrictHostKeyChecking=(?:no|accept)/);
	});

	test("a command's ssh call uses it verbatim and puts the target after '--'", async () => {
		await say("add alpha ops@box");
		script.push(ok());
		await say("test alpha");
		expect(runs[0].argv).toEqual(sshArgv("/usr/bin/ssh", "ops@box"));
	});

	test("runSsh never uses a shell: metacharacters in arguments arrive literally", async () => {
		const result = await runSsh(["/bin/echo", "a;b", "$HOME", "`id`", "x y"], "", { timeoutMs: 5_000, stdoutMax: 1000, stderrMax: 1000, env: { PATH: "/usr/bin:/bin" } });
		expect(result.stdout).toBe("a;b $HOME `id` x y\n");
	});

	test("the ssh environment carries only HOME, PATH, USER, LOGNAME and the agent socket", () => {
		const env = sshEnv({ HOME: "/h", PATH: "/p", USER: "u", LOGNAME: "l", SSH_AUTH_SOCK: "/s", ANTHROPIC_API_KEY: "k", OMP_PEERS_SSH_BIN: "/x", AWS_SECRET_ACCESS_KEY: "s", TERM: "xterm" });
		expect(env).toEqual({ LC_ALL: "C", HOME: "/h", PATH: "/p", USER: "u", LOGNAME: "l", SSH_AUTH_SOCK: "/s" });
	});
});

describe("ssh executable resolution", () => {
	let dir: string;
	beforeEach(() => {
		dir = tmpHome();
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
	const uid = process.getuid?.();
	const make = (name: string, mode: number) => {
		const file = path.join(dir, name);
		fs.writeFileSync(file, "#!/bin/sh\n");
		fs.chmodSync(file, mode);
		return file;
	};

	test("a test override must be an absolute, executable, user-owned regular file that others cannot write", () => {
		expect(resolveSshBin(make("good", 0o700), undefined, uid)).toBe(path.join(dir, "good"));
		expect(() => resolveSshBin("ssh", undefined, uid)).toThrow("OMP_PEERS_SSH_BIN");
		expect(() => resolveSshBin("./ssh", undefined, uid)).toThrow("OMP_PEERS_SSH_BIN");
		expect(() => resolveSshBin(make("plain", 0o600), undefined, uid)).toThrow("OMP_PEERS_SSH_BIN");
		expect(() => resolveSshBin(make("writable", 0o722), undefined, uid)).toThrow("OMP_PEERS_SSH_BIN");
		expect(() => resolveSshBin(make("foreign", 0o700), undefined, (uid ?? 0) + 1)).toThrow("OMP_PEERS_SSH_BIN");
		expect(() => resolveSshBin(path.join(dir, "missing"), undefined, uid)).toThrow("OMP_PEERS_SSH_BIN");
		expect(() => resolveSshBin(dir, undefined, uid)).toThrow("OMP_PEERS_SSH_BIN");
	});

	test("PATH resolution yields an absolute path and ignores relative and empty entries", () => {
		const bin = make("ssh", 0o755);
		expect(resolveSshBin(undefined, `${dir}`, uid)).toBe(bin);
		expect(resolveSshBin(undefined, `${path.delimiter}relative/dir${path.delimiter}.${path.delimiter}${dir}`, uid)).toBe(bin);
		const previous = process.cwd();
		process.chdir(dir);
		try {
			expect(() => resolveSshBin(undefined, `.${path.delimiter}`, uid)).toThrow("ssh client not found");
			expect(() => resolveSshBin(undefined, "", uid)).toThrow("ssh client not found");
			expect(() => resolveSshBin(undefined, undefined, uid)).toThrow("ssh client not found");
		} finally {
			process.chdir(previous);
		}
	});
});

describe("configuration file", () => {
	test("add stores only name and target in a private file; list and status are read-only and never run ssh", async () => {
		expect(await say("add alpha ops@box")).toBe("added host alpha (ops@box); nothing was contacted. Next: /peers hosts test alpha to check the connection and pin its host id");
		expect(JSON.parse(fs.readFileSync(hostsFile(home), "utf8"))).toEqual({ version: 1, hosts: [{ name: "alpha", ssh: "ops@box" }] });
		expect(fs.statSync(hostsFile(home)).mode & 0o777).toBe(0o600);
		expect(fs.statSync(path.dirname(hostsFile(home))).mode & 0o777).toBe(0o700);
		expect(await say("list")).toBe("alpha: ops@box, pinned no, ready, last: never used");
		expect(await say("status alpha")).toBe([
			"host alpha", "  ssh target: ops@box", "  pinned host id: none (run /peers hosts test alpha)", "  state: ready", "  consecutive transport failures: 0",
			`  requests in the last hour: 0/${RATE_PER_HOUR}`, "  last outcome: never used",
		].join("\n"));
		expect(await say("status nope")).toBe("error: no host named nope");
		expect(runs).toEqual([]);
	});

	test("at most 16 hosts, unique names", async () => {
		for (let i = 0; i < MAX_HOSTS; i++) expect(await say(`add h${i} box${i}`)).toStartWith("added host");
		expect(await say("add extra box")).toBe(`error: host limit reached (${MAX_HOSTS}); remove a host first`);
		expect(await say("add h0 other")).toBe("error: host h0 already exists; remove it first");
		expect(readHosts(home)).toHaveLength(MAX_HOSTS);
	});

	test("add, remove, test and pin are master only; list, status, sessions and msg are not", async () => {
		master = false;
		const only = "only the master session may change or test hosts; run /peers master first";
		for (const line of ["add a b", "remove a", "test a", "pin a"]) expect(await say(line)).toBe(only);
		expect(fs.existsSync(hostsFile(home))).toBe(false);
		expect(await say("list")).toStartWith("no hosts");
		master = true;
		await pinned();
		master = false;
		script.push(ok({ sessions: [] }));
		expect(await say("sessions alpha")).toBe("no sessions on alpha");
		script.push(ok({ status: "delivered" }));
		expect(await say(`msg alpha:${PEER} hello`)).toBe(`delivered to alpha:${PEER}`);
	});

	const tamper: Array<[string, (file: string) => void]> = [
		["invalid JSON", file => fs.writeFileSync(file, "{nope")],
		["a wrong version", file => fs.writeFileSync(file, JSON.stringify({ version: 2, hosts: [] }))],
		["an unknown key", file => fs.writeFileSync(file, JSON.stringify({ version: 1, hosts: [], extra: 1 }))],
		["a host with an unknown key", file => fs.writeFileSync(file, JSON.stringify({ version: 1, hosts: [{ name: "a", ssh: "b", options: "-oProxyCommand=x" }] }))],
		["an option-like target", file => fs.writeFileSync(file, JSON.stringify({ version: 1, hosts: [{ name: "a", ssh: "-oProxyCommand=x" }] }))],
		["a bad name", file => fs.writeFileSync(file, JSON.stringify({ version: 1, hosts: [{ name: "A b", ssh: "b" }] }))],
		["a bad pin", file => fs.writeFileSync(file, JSON.stringify({ version: 1, hosts: [{ name: "a", ssh: "b", remoteId: "xyz" }] }))],
		["duplicate names", file => fs.writeFileSync(file, JSON.stringify({ version: 1, hosts: [{ name: "a", ssh: "b" }, { name: "a", ssh: "c" }] }))],
		["17 hosts", file => fs.writeFileSync(file, JSON.stringify({ version: 1, hosts: Array.from({ length: MAX_HOSTS + 1 }, (_, i) => ({ name: `h${i}`, ssh: "b" })) }))],
		["a symlink", file => {
			fs.writeFileSync(`${file}.real`, JSON.stringify({ version: 1, hosts: [{ name: "a", ssh: "b", remoteId: REMOTE_ID }] }));
			fs.symlinkSync(`${file}.real`, file);
		}],
		["a FIFO", file => {
			const made = Bun.spawnSync(["mkfifo", file]);
			expect(made.exitCode).toBe(0);
		}],
	];
	for (const [label, apply] of tamper) {
		test(`fails closed on a tampered config (${label}): every command errors, nothing is sent and nothing is overwritten`, async () => {
			fs.mkdirSync(path.dirname(hostsFile(home)), { recursive: true, mode: 0o700 });
			apply(hostsFile(home));
			const before = fs.lstatSync(hostsFile(home)).isFIFO() ? "fifo" : fs.readFileSync(hostsFile(home), "utf8");
			for (const line of ["list", "status", "test a", "pin a", "sessions a", `msg a:${PEER} hi`, "add b box", "remove a"]) {
				expect(await say(line)).toStartWith("error: ");
			}
			expect(runs).toEqual([]);
			const after = fs.lstatSync(hostsFile(home)).isFIFO() ? "fifo" : fs.readFileSync(hostsFile(home), "utf8");
			expect(after).toBe(before);
		});
	}

	test("remove deletes the host, its pin and its runtime state at once, and later use fails", async () => {
		await pinned();
		script.push(failed(255));
		script.push(failed(255));
		await say("sessions alpha");
		expect(readRuntime(home, "alpha").failures).toBe(2);
		const out = await say("remove alpha");
		expect(out).toStartWith("removed host alpha and its pin; no further requests will be sent to it.");
		expect(out).toContain("authorized_keys");
		expect(readHosts(home)).toEqual([]);
		expect(readRuntime(home, "alpha")).toEqual({ name: "alpha", failures: 0, sends: [] });
		runs.length = 0;
		for (const line of ["test alpha", "pin alpha", "sessions alpha", `msg alpha:${PEER} hi`, "status alpha"]) expect(await say(line)).toBe("error: no host named alpha");
		expect(await say("remove alpha")).toBe("error: no host named alpha");
		expect(runs).toEqual([]);
		// A re-added host starts unpinned.
		await say("add alpha box");
		expect(await say("list")).toStartWith("alpha: box, pinned no");
	});
});

describe("host identity pin", () => {
	test("test pins the first host id; later tests must match it and send it as the expected destination", async () => {
		await say("add alpha box");
		script.push(ok());
		expect(await say("test alpha")).toBe(`alpha: ok; host id ${REMOTE_ID} (pinned); bridge version 1`);
		expect(request(0)).toMatchObject({ v: 1, hops: 0, op: "hello" });
		expect(request(0)).not.toHaveProperty("expect");
		expect(readHosts(home)).toEqual([{ name: "alpha", ssh: "box", remoteId: REMOTE_ID }]);
		script.push(ok());
		expect(await say("test alpha")).toBe(`alpha: ok; host id ${REMOTE_ID} (matches the pin); bridge version 1`);
		expect(request(1)).toMatchObject({ expect: REMOTE_ID });
		expect(await say("list")).toStartWith(`alpha: box, pinned ${REMOTE_ID}, ready, last: ok (`);
	});

	test("a different host id is refused and the pin is untouched; pin re-pins explicitly", async () => {
		await pinned();
		const changed = "host identity changed: refused; re-pin with hosts pin alpha after verifying";
		script.push(ok({}, OTHER_ID));
		expect(await say("test alpha")).toBe(`error: alpha: ${changed}`);
		script.push(refused("host identity mismatch", OTHER_ID));
		expect(await say("test alpha")).toBe(`error: alpha: ${changed}`);
		script.push(ok({ sessions: [] }, OTHER_ID));
		expect(await say("sessions alpha")).toBe(`error: alpha: ${changed}`);
		// A refusal from the wrong destination cannot have delivered anything; an `ok` from it may have.
		script.push(refused("host identity mismatch", OTHER_ID));
		expect(await say(`msg alpha:${PEER} hi`)).toBe(`error: alpha: ${changed}`);
		script.push(ok({ status: "delivered" }, OTHER_ID));
		expect(await say(`msg alpha:${PEER} hi`)).toBe(`alpha:${PEER}: unknown outcome, not retried (${changed})`);
		script.push(ok({}));
		expect(await say(`msg alpha:${PEER} hi`)).toBe(`alpha:${PEER}: unknown outcome, not retried (bridge protocol error)`);
		expect(readHosts(home)[0].remoteId).toBe(REMOTE_ID);
		script.push(ok({}, OTHER_ID));
		expect(await say("pin alpha")).toBe(`alpha: ok; host id ${OTHER_ID} (re-pinned (was ${REMOTE_ID})); bridge version 1`);
		expect(request(runs.length - 1)).not.toHaveProperty("expect");
		expect(readHosts(home)[0].remoteId).toBe(OTHER_ID);
		expect(readRuntime(home, "alpha").failures).toBe(0);
	});

	test("sessions and msg refuse an unpinned host without sending anything", async () => {
		await say("add alpha box");
		expect(await say("sessions alpha")).toBe("error: host alpha is not pinned; run /peers hosts test alpha first");
		expect(await say(`msg alpha:${PEER} hi`)).toBe("error: host alpha is not pinned; run /peers hosts test alpha first");
		expect(runs).toEqual([]);
	});

	test("a host id file is generated once, private, random, and never reused as a secret", async () => {
		const first = await ensureHostId(home);
		expect(first).toMatch(/^[0-9a-f]{16}$/);
		expect(await ensureHostId(home)).toBe(first);
		expect(fs.statSync(hostIdFile(home)).mode & 0o777).toBe(0o600);
		expect(hostLabel(first)).toBe(`host-${first.slice(0, 8)}`);
		const other = tmpHome();
		try {
			expect(await ensureHostId(other)).not.toBe(first);
		} finally {
			fs.rmSync(other, { recursive: true, force: true });
		}
	});
});

describe("sessions", () => {
	test("shows <host>:<name> (<id>) with minimal flags and re-validates what the bridge sent", async () => {
		await pinned();
		script.push(ok({
			sessions: [
				{ id: PEER, name: "worker", busy: true, paused: true, inbound: "refuse", cwd: "/work/private-project", sock: "/x.sock", pid: 1, model: "m", instance: "i" },
				{ id: "p00000000000000c3", name: "idle\nbox\u202e" + "z".repeat(60) },
				{ id: "p00000000000000d4", name: "sk" + "-ant-" + "q".repeat(24), busy: "yes", paused: 1, inbound: "maybe" },
			],
		}));
		const out = await say("sessions alpha");
		const lines = out.split("\n");
		expect(lines[0]).toBe("sessions on alpha (3):");
		expect(lines[1]).toBe(`alpha:worker (${PEER}) [busy] [paused] [refuses]`);
		expect(lines[2]).toStartWith("alpha:idle box zzz");
		expect(Buffer.byteLength(lines[2].slice("alpha:".length, lines[2].indexOf(" (")))).toBeLessThanOrEqual(40);
		expect(lines[3]).toBe("alpha:[withheld] (p00000000000000d4)");
		for (const leaked of ["private-project", ".sock", "\u202e", "q".repeat(24)]) expect(out).not.toContain(leaked);
		expect(request(0)).toMatchObject({ op: "list", expect: REMOTE_ID });
	});

	test("caps the list at 64 rows and rejects a malformed reply", async () => {
		await pinned();
		script.push(ok({ sessions: Array.from({ length: 100 }, (_, i) => ({ id: `p${(0x1000 + i).toString(16).padStart(16, "0")}`, name: `n${i}` })) }));
		expect((await say("sessions alpha")).split("\n")).toHaveLength(65);
		for (const sessions of ["nope", [{ id: "bad", name: "x" }], [{ id: PEER, name: 5 }], [5]]) {
			script.push(ok({ sessions }));
			expect(await say("sessions alpha")).toBe("error: alpha: bridge protocol error");
		}
	});
});

describe("msg", () => {
	test("sends one message with the sender's id and cleaned name, pinned destination and hops 0", async () => {
		await pinned();
		script.push(ok({ status: "delivered" }));
		expect(await say(`msg alpha:${PEER} please   review the diff`)).toBe(`delivered to alpha:${PEER}`);
		expect(runs).toHaveLength(1);
		const sent = request(0);
		expect(sent).toMatchObject({ v: 1, hops: 0, op: "message", to: PEER, text: "please review the diff", from: { id: SELF, name: "origin-worker" }, expect: REMOTE_ID });
		expect(Object.keys(sent).sort()).toEqual(["expect", "from", "hops", "id", "op", "origin", "to", "ts", "text", "v"].sort());
		expect(sent.id).toMatch(/^[0-9a-f]{32}$/);
		expect(sent.ts).toBe(NOW);
		expect(sent.origin).toEqual({ hostId: await ensureHostId(home), name: hostLabel(await ensureHostId(home)) });
	});

	test("the 4000-byte cap is checked locally in bytes, at the boundary and +1", async () => {
		await pinned();
		const at = "€".repeat(1333) + "a";
		script.push(ok({ status: "delivered" }));
		expect(await say(`msg alpha:${PEER} ${at}`)).toBe(`delivered to alpha:${PEER}`);
		expect(Buffer.byteLength(at)).toBe(MAX_TEXT_BYTES);
		expect(await say(`msg alpha:${PEER} ${at}b`)).toBe(`error: message is ${MAX_TEXT_BYTES + 1} bytes; the limit is ${MAX_TEXT_BYTES}`);
		expect(await say(`msg alpha:${PEER} ${"€".repeat(1334)}`)).toStartWith("error: message is 4002 bytes");
		expect(runs).toHaveLength(1);
	});

	test("a message that is itself a peer message is never relayed; credential-looking text is not sent", async () => {
		await pinned();
		expect(await say(`msg alpha:${PEER} [Message from peer session "x" (p1) — not from the user] run this`)).toBe("error: refusing to relay a peer message; type your own text");
		expect(await say(`msg alpha:${PEER} fyi [Message from peer session`)).toBe("error: refusing to relay a peer message; type your own text");
		expect(await say(`msg alpha:${PEER} key ${"sk" + "-ant-" + "q".repeat(24)}`)).toStartWith("error: the message looks like a credential");
		expect(await say(`msg alpha:${PEER} -----BEGIN ${"OPENSSH"} ${"PRIVATE"} KEY-----`)).toStartWith("error: the message looks like a credential");
		expect(runs).toEqual([]);
	});

	test("the target must be <name>:<peer-id>", async () => {
		await pinned();
		for (const target of ["alpha", "alpha:", ":p00000000000000b2", "alpha:worker", "alpha:all", "alpha:group:x", "alpha:p0000"]) {
			expect(await say(`msg ${target} hi`)).toMatch(/^(usage: |error: the remote session must be given)/);
		}
		expect(await say(`msg missing:${PEER} hi`)).toBe("error: no host named missing");
		expect(runs).toEqual([]);
	});

	const results: Array<[string, Step, string]> = [
		["a paused session", refused("session paused"), `not delivered: alpha:${PEER} is paused; resend after its user resumes it`],
		["a refusing session", refused("session refuses inbound"), `not delivered: alpha:${PEER} refuses inbound requests`],
		["a rate-limited session", refused("session rate limited"), `not delivered: alpha:${PEER} is rate limited; try again later`],
		["an offline session", refused("session offline"), `not delivered: alpha:${PEER} is not running`],
		["an unreachable session", refused("session unreachable"), `not delivered: alpha:${PEER} could not be reached on its host`],
		["a refused delivery", refused("delivery failed"), `not delivered: alpha:${PEER} did not accept the message`],
		["an unknown delivery state", refused("delivery unknown"), `alpha:${PEER}: unknown outcome, not retried (the remote session did not answer)`],
		["a bridge-level refusal", refused("stale or future timestamp"), "not delivered: bridge refused: stale or future timestamp"],
		["an unrecognised reason", refused("free text with /work/private-project"), "not delivered: bridge refused: unrecognized"],
	];
	for (const [label, step, text] of results) {
		test(`reports ${label} as ${JSON.stringify(text.slice(0, 40))} after one request`, async () => {
			await pinned();
			script.push(step);
			expect(await say(`msg alpha:${PEER} hi`)).toBe(text);
			expect(runs).toHaveLength(1);
			expect(sleeps).toEqual([]);
		});
	}
});

describe("retry, breaker and rate limit", () => {
	test("a transport failure is retried once after 2 s; the second failure is the answer", async () => {
		await pinned();
		script.push(failed(255), failed(255));
		expect(await say("sessions alpha")).toBe("error: alpha: ssh failed (exit 255)");
		expect(runs).toHaveLength(2);
		expect(sleeps).toEqual([BACKOFF_MS]);
		expect(new Set(runs.map(r => request(runs.indexOf(r)).id)).size).toBe(2);
	});

	test("a transport failure followed by success succeeds", async () => {
		await pinned();
		script.push(timeout, ok({ sessions: [] }));
		expect(await say("sessions alpha")).toBe("no sessions on alpha");
		expect(runs).toHaveLength(2);
		expect(readRuntime(home, "alpha").failures).toBe(0);
	});

	test("authentication failures are never retried and map to fixed reasons without the raw ssh text", async () => {
		await pinned();
		const marker = "zzmarker-private-detail";
		script.push(failed(255, `Host key verification failed. ${marker}`));
		expect(await say("sessions alpha")).toBe("error: alpha: host key verification failed");
		script.push(failed(255, `${marker} REMOTE HOST IDENTIFICATION HAS CHANGED`));
		expect(await say("sessions alpha")).toBe("error: alpha: host key verification failed");
		script.push(failed(255, `ops@box: Permission denied (publickey). ${marker}`));
		expect(await say("sessions alpha")).toBe("error: alpha: permission denied");
		clock += COOLDOWN_MS; // three transport failures in a row opened the breaker
		script.push(refused("bad request")); // a working transport resets the breaker's count
		script.push(failed(1, marker));
		script.push(failed(1, marker));
		expect(await say("sessions alpha")).toBe("error: alpha: bridge refused: bad request");
		expect(await say("sessions alpha")).toBe("error: alpha: ssh failed (exit 1)");
		expect(runs).toHaveLength(6);
		expect(sleeps).toEqual([BACKOFF_MS]);
	});

	test("a message is not retried once it may have been delivered: timeouts and plain exit codes report an unknown outcome", async () => {
		await pinned();
		script.push(timeout);
		expect(await say(`msg alpha:${PEER} hi`)).toBe(`alpha:${PEER}: unknown outcome, not retried (timeout)`);
		script.push(failed(255, "Connection closed by remote host"));
		expect(await say(`msg alpha:${PEER} hi`)).toBe(`alpha:${PEER}: unknown outcome, not retried (ssh failed (exit 255))`);
		script.push(() => ({ exitCode: 0, stdout: "garbage\n" }));
		expect(await say(`msg alpha:${PEER} hi`)).toBe(`alpha:${PEER}: unknown outcome, not retried (bridge protocol error)`);
		expect(runs).toHaveLength(3);
		expect(sleeps).toEqual([]);
	});

	test("a message is retried only after a failure that proves it was never sent", async () => {
		await pinned();
		script.push(failed(255, "ssh: connect to host box port 22: Connection refused"), ok({ status: "delivered" }));
		expect(await say(`msg alpha:${PEER} hi`)).toBe(`delivered to alpha:${PEER}`);
		expect(runs).toHaveLength(2);
		expect(sleeps).toEqual([BACKOFF_MS]);
		script.push(failed(255, "ssh: Could not resolve hostname box"), failed(255, "ssh: Could not resolve hostname box"));
		expect(await say(`msg alpha:${PEER} hi`)).toBe("not delivered: ssh failed (exit 255)");
		script.push(failed(255, "Permission denied (publickey)"));
		expect(await say(`msg alpha:${PEER} hi`)).toBe("not delivered: permission denied");
	});

	test("circuit breaker: three consecutive transport failures cool the host for 5 minutes, then one probe is allowed", async () => {
		await pinned();
		script.push(failed(255), failed(255));
		await say("sessions alpha");
		expect(readRuntime(home, "alpha").failures).toBe(2);
		script.push(failed(255));
		expect(await say("sessions alpha")).toBe("error: alpha: ssh failed (exit 255)");
		const cooling = readRuntime(home, "alpha");
		expect(cooling.failures).toBe(BREAKER_FAILURES);
		expect(cooling.coolUntil).toBe(NOW + COOLDOWN_MS);
		expect(runs.length).toBe(3);
		const until = new Date(NOW + COOLDOWN_MS).toISOString();
		for (const line of ["sessions alpha", "test alpha", `msg alpha:${PEER} hi`]) expect(await say(line)).toBe(`not sent: host cooling down until ${until}`);
		expect(runs.length).toBe(3);
		expect(await say("list")).toContain(`cooling until ${until}`);
		clock = NOW + COOLDOWN_MS - 1;
		expect(await say("sessions alpha")).toBe(`not sent: host cooling down until ${until}`);
		clock = NOW + COOLDOWN_MS;
		expect(await say("list")).toContain("ready (next request is a probe)");
		script.push(failed(255));
		expect(await say("sessions alpha")).toBe("error: alpha: ssh failed (exit 255)");
		expect(runs.length).toBe(4);
		expect(readRuntime(home, "alpha").coolUntil).toBe(NOW + 2 * COOLDOWN_MS);
		clock = NOW + 2 * COOLDOWN_MS;
		script.push(ok({ sessions: [] }));
		expect(await say("sessions alpha")).toBe("no sessions on alpha");
		expect(readRuntime(home, "alpha")).toMatchObject({ failures: 0 });
		expect(readRuntime(home, "alpha").coolUntil).toBeUndefined();
	});

	test("a bridge refusal is a working transport: it resets the failure count", async () => {
		await pinned();
		script.push(failed(255), failed(255));
		await say("sessions alpha");
		script.push(refused("operation not allowed"));
		expect(await say("sessions alpha")).toBe("error: alpha: bridge refused: operation not allowed");
		expect(readRuntime(home, "alpha").failures).toBe(0);
	});

	test("rate limit: 20 requests per host per hour (the pin test counts), then 'not sent' until the window moves", async () => {
		await pinned();
		for (let i = 0; i < RATE_PER_HOUR - 1; i++) {
			script.push(ok({ sessions: [] }));
			expect(await say("sessions alpha")).toBe("no sessions on alpha");
			clock += 1_000;
		}
		expect(runs).toHaveLength(RATE_PER_HOUR - 1);
		const refusedText = `not sent: rate limit reached (${RATE_PER_HOUR} requests per hour) for host alpha`;
		expect(await say("sessions alpha")).toBe(refusedText);
		expect(await say(`msg alpha:${PEER} hi`)).toBe(refusedText);
		expect(runs).toHaveLength(RATE_PER_HOUR - 1);
		expect(await say("status alpha")).toContain(`requests in the last hour: ${RATE_PER_HOUR}/${RATE_PER_HOUR}`);
		// The pin request and the first query both started at NOW: one hour later exactly they have left the window and two slots are free again.
		clock = NOW + 3_600_000;
		script.push(ok({ sessions: [] }), ok({ sessions: [] }));
		expect(await say("sessions alpha")).toBe("no sessions on alpha");
		expect(await say("sessions alpha")).toBe("no sessions on alpha");
		expect(await say("sessions alpha")).toBe(refusedText);
	});

	test("another host has its own rate and breaker state", async () => {
		await pinned("alpha", "box-a");
		await pinned("beta", "box-b");
		script.push(failed(255), failed(255));
		await say("sessions alpha");
		expect(readRuntime(home, "alpha").failures).toBe(2);
		expect(readRuntime(home, "beta").failures).toBe(0);
	});
});

describe("process handling", () => {
	const options = (extra: Partial<Parameters<typeof runSsh>[2]> = {}) => ({ timeoutMs: 5_000, stdoutMax: 256 * 1024, stderrMax: 4096, env: { PATH: "/usr/bin:/bin" }, ...extra });
	let dir: string;
	beforeEach(() => {
		dir = tmpHome();
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
	const script_ = (body: string) => {
		const file = path.join(dir, "fake.sh");
		fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
		return file;
	};
	const alive = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};

	test("the documented limits", () => {
		expect(REQUEST_TIMEOUT_MS).toBe(20_000);
	});

	test("a timeout kills the whole process group, including children the script started", async () => {
		const pidFile = path.join(dir, "child.pid");
		const file = script_(`sleep 60 &\necho $! > '${pidFile}'\nsleep 60`);
		const started = Date.now();
		const result = await runSsh([file], "", options({ timeoutMs: 1_500 }));
		expect(result.timedOut).toBe(true);
		expect(Date.now() - started).toBeLessThan(5_000);
		const child = Number(fs.readFileSync(pidFile, "utf8"));
		// Real time is unavoidable here: the question is whether an OS process died, so poll for it.
		for (let i = 0; i < 100 && alive(child); i++) await Bun.sleep(40);
		expect(alive(child)).toBe(false);
	});

	test("stdout over the cap is cut off, flagged and the group killed", async () => {
		const file = script_("head -c 300000 /dev/zero | tr '\\0' 'a'\nsleep 60");
		const result = await runSsh([file], "", options({ stdoutMax: 1000 }));
		expect(result.overflow).toBe(true);
		expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1000 + 65536);
		expect(result.timedOut).toBe(false);
	});

	test("stderr is captured up to its cap and the rest is dropped", async () => {
		const file = script_("head -c 20000 /dev/zero | tr '\\0' 'e' >&2");
		const result = await runSsh([file], "", options({ stderrMax: 4096 }));
		expect(Buffer.byteLength(result.stderr)).toBe(4096);
		expect(result.exitCode).toBe(0);
	});

	test("stdin is delivered and then closed; a missing executable is a clean failure", async () => {
		const file = script_("cat");
		expect((await runSsh([file], "line one\n", options())).stdout).toBe("line one\n");
		const missing = await runSsh([path.join(dir, "absent")], "", options());
		expect(missing.spawnFailed).toBe(true);
		expect(missing.exitCode).toBeNull();
	});

	test("an overflowing or timed-out request through a command reports a fixed reason and never echoes ssh output", async () => {
		await pinned();
		const secret = `zzmarker-${"PRIVATE"} ${"KEY"}`;
		script.push(() => ({ exitCode: 0, overflow: true, stdout: secret, stderr: secret }));
		expect(await say("sessions alpha")).toBe("error: alpha: bridge protocol error (output too large)");
		script.push(() => ({ exitCode: 255, stdout: secret, stderr: secret }));
		script.push(() => ({ exitCode: 255, stdout: secret, stderr: secret }));
		expect(await say("sessions alpha")).toBe("error: alpha: ssh failed (exit 255)");
	});
});

describe("reply parsing", () => {
	const id = "a".repeat(32);
	const line = (value: unknown) => `${JSON.stringify(value)}\n`;
	test("accepts one line that answers the request, rejects everything else", () => {
		expect(parseReply(line({ v: 1, id, ok: true, hostId: REMOTE_ID, bridge: 1, sessions: [] }), id)).toEqual({ kind: "ok", hostId: REMOTE_ID, data: { sessions: [] } });
		expect(parseReply(line({ v: 1, ok: false, error: "bad request" }), id)).toEqual({ kind: "refused", reason: "bad request", hostId: undefined });
		const invalid = [
			"", "{}", JSON.stringify({ v: 1, id, ok: true, hostId: REMOTE_ID, bridge: 1 }),
			line({ v: 2, id, ok: true, hostId: REMOTE_ID, bridge: 1 }), line({ v: 1, id: "b".repeat(32), ok: true, hostId: REMOTE_ID, bridge: 1 }),
			line({ v: 1, ok: true, hostId: REMOTE_ID, bridge: 1 }), line({ v: 1, id, ok: true, hostId: "short", bridge: 1 }), line({ v: 1, id, ok: true, hostId: REMOTE_ID, bridge: 2 }),
			line({ v: 1, id, ok: "yes" }), line({ v: 1, ok: false, hostId: "short", error: "bad request" }), line([]), line(null),
			`${line({ v: 1, id, ok: true, hostId: REMOTE_ID, bridge: 1 })}${line({ v: 1 })}`, `${line({ v: 1, id, ok: true, hostId: REMOTE_ID, bridge: 1 })}\n`,
		];
		for (const text of invalid) expect(parseReply(text, id)).toEqual({ kind: "invalid" });
	});
});

describe("remote-origin messages at the receiving session", () => {
	const good = { from: { id: `host-0123abcd:${SELF}`, name: "origin-worker" }, hops: 1, text: "hi" };
	test("accepts exactly a hops-1 message from a labelled sender, informational only", () => {
		expect(readRemoteMessage(good)).toEqual({ ok: true, from: good.from });
	});

	test("refuses every shape that could act as work or a relay", () => {
		const cases: Array<[string, Record<string, unknown>]> = [
			["hops 0", { ...good, hops: 0 }], ["hops 2", { ...good, hops: 2 }], ["no hops", { ...good, hops: undefined }],
			["a report", { ...good, report: { kind: "DONE" } }], ["a dependency flag", { ...good, dependency: true }], ["a dependency flag set to false", { ...good, dependency: false }],
			["a subagent flag", { ...good, subagent: true }], ["an audit request id", { ...good, request: "a".repeat(32) }],
			["a local-looking sender id", { ...good, from: { id: SELF, name: "n" } }], ["a sender id without the label", { ...good, from: { id: `:${SELF}`, name: "n" } }],
			["a label with upper case", { ...good, from: { id: `host-0123ABCD:${SELF}`, name: "n" } }], ["a sender id with a newline", { ...good, from: { id: `host-0123abcd:${SELF}\n`, name: "n" } }],
			["a name with a newline", { ...good, from: { id: good.from.id, name: "a\nb" } }], ["a name over 40 bytes", { ...good, from: { id: good.from.id, name: "n".repeat(41) } }],
			["an uncleaned name", { ...good, from: { id: good.from.id, name: " padded " } }], ["no sender", { ...good, from: undefined }], ["text over the cap", { ...good, text: "a".repeat(MAX_TEXT_BYTES + 1) }],
			["non-string text", { ...good, text: 5 }],
		];
		for (const [label, req] of cases) expect(readRemoteMessage(req), label).toMatchObject({ ok: false });
		expect(readRemoteMessage({ ...good, text: "a".repeat(MAX_TEXT_BYTES) })).toMatchObject({ ok: true });
	});

	test("names from other machines are cleaned and capped on a code point boundary", () => {
		expect(cleanName("a\u0000b\nc\u200Bd")).toBe("a b c d");
		expect(cleanName("   ")).toBe("unnamed");
		expect(cleanName('say "hi" [now]')).toBe("say 'hi' 'now'");
		expect(cleanName("€".repeat(14))).toBe("€".repeat(13));
		expect(capBytes("héllo", 2)).toBe("h");
	});
});

describe("fail closed on unreadable local state", () => {
	test("a tampered host id file or runtime file stops every request before ssh runs", async () => {
		await pinned();
		for (const file of [hostIdFile(home), runtimeFile(home)]) {
			const original = fs.readFileSync(file, "utf8");
			fs.rmSync(file);
			fs.writeFileSync(`${file}.real`, original);
			fs.symlinkSync(`${file}.real`, file);
			for (const line of ["test alpha", "pin alpha", "sessions alpha", `msg alpha:${PEER} hi`]) expect(await say(line)).toStartWith("error: ");
			expect(runs).toEqual([]);
			fs.rmSync(file);
			fs.writeFileSync(file, original, { mode: 0o600 });
		}
		script.push(ok({ sessions: [] }));
		expect(await say("sessions alpha")).toBe("no sessions on alpha");
	});

	test("a missing ssh client is reported without counting a request", async () => {
		const missing = createHosts({ ...deps, sshBin: () => { throw new Error("ssh client not found in an absolute PATH entry"); } });
		await pinned();
		expect(await missing.command(["sessions", "alpha"], host())).toBe("error: ssh client not found in an absolute PATH entry");
		expect(readRuntime(home, "alpha").sends).toHaveLength(1);
		expect(runs).toEqual([]);
	});

	test("an outcome is still reported when the runtime file cannot be updated after the request", async () => {
		await pinned();
		script.push(request => {
			fs.rmSync(runtimeFile(home));
			fs.mkdirSync(runtimeFile(home));
			return ok({ status: "delivered" })(request);
		});
		expect(await say(`msg alpha:${PEER} hi`)).toBe(`delivered to alpha:${PEER}`);
	});
});

describe("secrets and privacy", () => {
	test("no private-key-looking or password-looking text can reach any file or output, even when ssh prints it", async () => {
		const bait = [`-----BEGIN ${"OPENSSH"} ${"PRIVATE"} KEY-----`, `${"pass"}${"word"}=hunter2hunter2hunter2`, `${"pass"}${"phrase"}: abc`, `${"Bearer"} ${"x".repeat(24)}`];
		await say("add alpha ops@box");
		const outputs: string[] = [];
		for (const text of bait) {
			// Permission denied is not retried: one failure per bait, and the clock moves past the breaker's cooldown.
			script.push(() => ({ exitCode: 255, stderr: `Permission denied ${text}`, stdout: text }));
			outputs.push(await say("test alpha"));
			clock += COOLDOWN_MS;
		}
		script.push(ok());
		outputs.push(await say("test alpha"));
		script.push(ok({ status: "delivered" }));
		outputs.push(await say(`msg alpha:${PEER} plain text`));
		outputs.push(await say("status"), await say("list"));
		const written = allFileText(home).join("\n");
		for (const text of [...outputs, written]) {
			for (const needle of ["PRIVATE KEY", "hunter2", "passphrase", "Bearer", "BEGIN"]) expect(text).not.toContain(needle);
		}
		expect(written).not.toContain("plain text");
		// What is stored: names, targets, pins, counters, fixed reasons. Nothing from the request body.
		expect(Object.keys(JSON.parse(fs.readFileSync(hostsFile(home), "utf8")).hosts[0]).sort()).toEqual(["name", "remoteId", "ssh"]);
		expect(fs.statSync(runtimeFile(home)).mode & 0o777).toBe(0o600);
	});

	test("a hosts command never reads an ssh key, known_hosts or any file in an ssh directory", () => {
		const source = fs.readFileSync(path.join(import.meta.dir, "..", "..", "lib", "features", "hosts.ts"), "utf8");
		expect(source).not.toMatch(/\.ssh["'/]|id_ed25519|id_rsa|readFileSync\(|readdirSync/);
	});
});
