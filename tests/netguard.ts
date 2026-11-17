// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

/**
 * Test-only outbound network guard. Importing this module patches the process so that ANY connection to a
 * non-loopback address throws `network guard: refused outbound connection to <host>:<port>`: fetch (and
 * fetch.preconnect), WebSocket, node:net, node:tls, node:http(s) and Bun.connect. Unix sockets and loopback
 * (127.0.0.0/8, ::1, localhost) pass. No name is resolved: a hostname other than localhost is refused without a DNS lookup.
 *
 * node:http(s) is checked twice. `request`/`get` are wrapped, but Bun's namespace and named imports
 * (`import * as https`, `import { request }`) keep the original functions, so the first send of every
 * `http.ClientRequest` (end/write/flushHeaders) is checked too. For http(s) options only `socketPath` denotes a unix
 * socket (`path` is the URL path); for net, tls and Bun.connect options `path` / `unix` is the socket.
 *
 * Child processes: Bun.spawn and Bun.spawnSync are wrapped, and every node:child_process API (spawn, exec, execFile,
 * fork and their sync forms) funnels through them, including named imports. A program whose basename is ssh, scp, sftp,
 * rsync, curl, wget, nc, ncat, telnet or git (also when run via `sh -c "..."`) is refused, git outright since its network
 * subcommands are not told apart. The only exceptions (see isFixtureProgram): a program inside this tests directory, or a text
 * script (`#!`, no NUL byte) with the exact line `# omp-peers netguard fake` in its first 512 bytes, which the test helpers write
 * into their fake `ssh`. A copied real binary never passes, wherever it sits. A child `bun` (process.execPath) without
 * `--preload` gets `--preload <this file>` so it is guarded too.
 *
 * Refusals are loud even when the caller swallows the error: see tests/netguard_policy.ts (violation log, stderr line).
 * A process that exits with an undeclared violation on record exits 1, so a guarded child bun that caught the refusal
 * and otherwise finished cleanly still fails its parent's exit-code check.
 *
 * NOT covered (gaps): dns.lookup/resolve (a refused connect never resolves, but a direct dns call does), dgram/UDP
 * (`Bun.udpSocket`), node:http2, `Bun.$` shell, and network programs launched through other wrappers (`env ssh`, `xargs`,
 * `nohup`, `sudo`). Processes other than bun/OMP are unguarded: a `node`, `python3` or `npm` child (npm fetches packages)
 * bypasses every check, and the Python test harnesses make no network calls the guard could see. A refusal recorded after
 * the last test of a `bun test` run, or after a child's exit hook, is only visible on stderr.
 *
 * It is preloaded for every `bun test` run (bunfig.toml) and loaded into every OMP process the smoke harnesses start
 * (tests/netguard_ext.ts, `omp -e`). It is never imported by plugin code and is not shipped.
 */
import { realpathSync, statSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { isAllowedFake, isLoopback, refuse, takeViolations } from "./netguard_policy";

const GUARD = Symbol.for("omp-peers.netguard");
const SELF = import.meta.path;

const NETWORK_PROGRAMS = new Set(["ssh", "scp", "sftp", "rsync", "curl", "wget", "nc", "ncat", "telnet", "git"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
/** `bun <subcommand>` forms that do not run a script and so take no `--preload`. */
const BUN_SUBCOMMANDS = new Set(["test", "install", "i", "add", "remove", "rm", "update", "upgrade", "pm", "x", "bunx", "build", "create", "init", "link", "unlink", "publish", "outdated", "audit", "patch", "pack", "completions", "help", "repl"]);

function check(host: string | undefined | null, port?: unknown): void {
	if (!isLoopback(host)) refuse(`network guard: refused outbound connection to ${host ?? "?"}:${port ?? "?"}`);
}

function urlText(input: unknown): string | undefined {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	if (typeof input === "object" && input !== null && "url" in input && typeof input.url === "string") return input.url;
	return undefined;
}

function checkUrl(input: unknown): void {
	const text = urlText(input);
	if (text === undefined) return;
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return; // not a network URL: the real call rejects it itself
	}
	if (url.protocol === "file:" || url.protocol === "data:" || url.protocol === "blob:") return;
	check(url.hostname, url.port || undefined);
}

function field(options: object, key: string): unknown {
	return key in options ? Reflect.get(options, key) : undefined;
}

/** `socket`: net/tls/Bun.connect options, where `path` or `unix` is a unix socket. `http`: only `socketPath` is. */
function checkOptions(options: unknown, api: "socket" | "http"): void {
	if (typeof options !== "object" || options === null) return;
	const unixSocket = api === "http" ? field(options, "socketPath") : (field(options, "path") ?? field(options, "unix"));
	if (typeof unixSocket === "string") return;
	const hostname = field(options, "hostname");
	const host = field(options, "host");
	check(typeof hostname === "string" ? hostname : typeof host === "string" ? host : undefined, field(options, "port"));
}

/** The real path of `candidate` when it is an existing file. */
function realPath(candidate: string): string | undefined {
	try {
		return statSync(candidate).isFile() ? realpathSync(candidate) : undefined;
	} catch {
		return undefined;
	}
}

function resolveProgram(program: string, cwd: string, searchPath: string | undefined): string | undefined {
	if (program.includes("/")) return realPath(path.resolve(cwd, program));
	for (const dir of (searchPath ?? "").split(path.delimiter)) {
		const found = realPath(path.resolve(cwd, dir || ".", program));
		if (found) return found;
	}
	return undefined;
}

/** Exception for fixtures (tests/netguard_policy.ts `isAllowedFake`): a program inside the tests directory or a marked fake script. */
function isFixtureProgram(resolved: string | undefined): boolean {
	return resolved !== undefined && isAllowedFake(resolved);
}

function checkProgram(program: string, cwd: string, searchPath: string | undefined): void {
	const resolved = resolveProgram(program, cwd, searchPath);
	const names = [path.basename(program), ...(resolved ? [path.basename(resolved)] : [])];
	const network = names.find(name => NETWORK_PROGRAMS.has(name));
	if (network !== undefined && !isFixtureProgram(resolved)) refuse(`network guard: refused network program ${network} (${program})`);
}

const SHELL_WORD = new RegExp(`(?:^|[\\s;&|()<>\`$'"])((?:[^\\s;&|()<>\`'"]*/)?(?:${[...NETWORK_PROGRAMS].join("|")}))(?=$|[\\s;&|()<>\`'"])`, "g");

/** `sh -c "<script>"`: refuse when the script names a network program as a command word. */
function checkShellScript(cmd: string[], cwd: string, searchPath: string | undefined): void {
	const flag = cmd.findIndex((arg, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(arg));
	const script = flag >= 0 ? cmd[flag + 1] : undefined;
	if (typeof script !== "string") return;
	for (const match of script.matchAll(SHELL_WORD)) checkProgram(match[1], cwd, searchPath);
}

interface SpawnCall {
	cmd: string[];
	cwd: string;
	searchPath: string | undefined;
	/** The same call with `cmd` replaced. */
	withCmd(cmd: string[]): unknown[];
}

function spawnCall(args: unknown[]): SpawnCall | undefined {
	const [first, second] = args;
	const fromArray = Array.isArray(first);
	const options = fromArray ? second : first;
	const cmd = fromArray ? first : typeof first === "object" && first !== null ? field(first, "cmd") : undefined;
	if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every(part => typeof part === "string")) return undefined;
	const opt = (key: string): unknown => (typeof options === "object" && options !== null ? field(options, key) : undefined);
	const cwd = opt("cwd");
	const env = opt("env");
	const envPath = typeof env === "object" && env !== null ? field(env, "PATH") : process.env.PATH;
	return {
		cmd,
		cwd: typeof cwd === "string" ? cwd : process.cwd(),
		searchPath: typeof envPath === "string" ? envPath : process.env.PATH,
		withCmd: replacement => (fromArray ? [replacement, ...args.slice(1)] : [{ ...(first as object), cmd: replacement }, ...args.slice(1)]),
	};
}

function guardSpawn(args: unknown[]): unknown[] {
	const call = spawnCall(args);
	if (call === undefined) return args;
	const [program, ...rest] = call.cmd;
	checkProgram(program, call.cwd, call.searchPath);
	if (SHELLS.has(path.basename(program))) checkShellScript(call.cmd, call.cwd, call.searchPath);
	const isBun = program === process.execPath || path.basename(program) === path.basename(process.execPath);
	const takesScript = rest.length > 0 && !BUN_SUBCOMMANDS.has(rest[0]) && !/^(-v|--version|-h|--help|--revision)$/.test(rest[0]);
	const preloaded = rest.some(arg => arg === "--preload" || arg === "-r" || arg === "--require" || arg.startsWith("--preload=") || arg.startsWith("--require="));
	if (isBun && takesScript && !preloaded) return call.withCmd([program, "--preload", SELF, ...rest]);
	return args;
}

function install(): void {
	const marker = globalThis as Record<symbol, unknown>;
	if (marker[GUARD]) return;
	marker[GUARD] = true;

	process.on("exit", () => {
		if (takeViolations().length > 0) process.exitCode = 1; // the refusal was already written to stderr
	});

	const realFetch = globalThis.fetch;
	globalThis.fetch = Object.assign(
		(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			try {
				if (typeof field(init ?? {}, "unix") !== "string") checkUrl(input);
			} catch (error) {
				return Promise.reject(error);
			}
			return realFetch(input, init);
		},
		realFetch,
	);
	const preconnect: unknown = Reflect.get(realFetch, "preconnect");
	if (typeof preconnect === "function") {
		Reflect.set(globalThis.fetch, "preconnect", (url: unknown, ...rest: unknown[]) => {
			checkUrl(url);
			return Reflect.apply(preconnect, realFetch, [url, ...rest]);
		});
	}

	const RealWebSocket = globalThis.WebSocket;
	if (RealWebSocket) {
		globalThis.WebSocket = new Proxy(RealWebSocket, {
			construct(target, args: ConstructorParameters<typeof WebSocket>) {
				checkUrl(args[0]);
				return Reflect.construct(target, args);
			},
		});
	}

	/** `net.connect`/`Socket#connect`/`tls.connect` call shapes: (options) | (port[, host]) | (path). */
	const checkConnectArgs = (args: unknown[]): void => {
		const first = args[0];
		if (typeof first === "object" && first !== null) checkOptions(first, "socket");
		else if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) check(typeof args[1] === "string" ? args[1] : undefined, first);
		// any other string is a unix socket path
	};
	const wrap = (target: object, name: string): void => {
		const real: unknown = Reflect.get(target, name);
		if (typeof real !== "function") return;
		Reflect.set(target, name, function (this: unknown, ...args: unknown[]) {
			checkConnectArgs(args);
			return Reflect.apply(real, this, args);
		});
	};
	wrap(net.Socket.prototype, "connect");
	wrap(net, "connect");
	wrap(net, "createConnection");
	wrap(tls, "connect");

	for (const mod of [http, https]) {
		for (const name of ["request", "get"]) {
			const real: unknown = Reflect.get(mod, name);
			if (typeof real !== "function") continue;
			Reflect.set(mod, name, function (this: unknown, ...args: unknown[]) {
				const first = args[0];
				if (typeof first === "string" || first instanceof URL) checkUrl(first);
				else checkOptions(first, "http");
				checkOptions(args[1], "http");
				return Reflect.apply(real, this, args);
			});
		}
	}
	// Namespace/named imports bypass the wrappers above; every request still sends through these.
	for (const name of ["end", "write", "flushHeaders"]) {
		const real: unknown = Reflect.get(http.ClientRequest.prototype, name);
		if (typeof real !== "function") continue;
		Reflect.set(http.ClientRequest.prototype, name, function (this: object, ...args: unknown[]) {
			if (typeof field(this, "socketPath") !== "string") {
				const host = field(this, "host") ?? field(this, "hostname");
				check(typeof host === "string" ? host : undefined, field(this, "port"));
			}
			return Reflect.apply(real, this, args);
		});
	}

	const connect: unknown = Reflect.get(Bun, "connect");
	if (typeof connect === "function") {
		Reflect.set(Bun, "connect", (options: unknown) => {
			checkOptions(options, "socket");
			return Reflect.apply(connect, Bun, [options]);
		});
	}

	// node:child_process (named imports included) runs everything through Bun.spawn / Bun.spawnSync.
	for (const name of ["spawn", "spawnSync"]) {
		const real: unknown = Reflect.get(Bun, name);
		if (typeof real !== "function") continue;
		Reflect.set(Bun, name, function (this: unknown, ...args: unknown[]) {
			return Reflect.apply(real, this, guardSpawn(args));
		});
	}
}

install();
