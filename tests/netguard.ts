// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

/**
 * Test-only outbound network guard. Importing this module patches the process so that ANY connection to a
 * non-loopback address throws `network guard: refused outbound connection to <host>:<port>`: fetch, WebSocket,
 * node:net, node:tls, node:http(s) and Bun.connect. Unix sockets and loopback (127.0.0.0/8, ::1, localhost) pass.
 * No name is resolved: a hostname other than localhost is refused without a DNS lookup.
 *
 * It is preloaded for every `bun test` run (bunfig.toml) and loaded into every OMP process the smoke harnesses
 * start (tests/netguard_ext.ts, `omp -e`). It is never imported by plugin code and is not shipped.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const GUARD = Symbol.for("omp-peers.netguard");

/** Whether `host` (a name or address literal, optionally bracketed) is loopback. Anything unparsable is not. */
export function isLoopback(host: string | undefined | null): boolean {
	if (host === undefined || host === null || host === "") return true; // node's default target is localhost
	const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
	if (bare === "localhost" || bare.endsWith(".localhost") || bare === "::1") return true;
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
	const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(mapped ? mapped[1] : bare);
	return parts !== null && Number(parts[1]) === 127 && parts.slice(1).every(p => Number(p) <= 255);
}

function check(host: string | undefined | null, port?: unknown): void {
	if (!isLoopback(host)) throw new Error(`network guard: refused outbound connection to ${host ?? "?"}:${port ?? "?"}`);
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

function checkOptions(options: unknown): void {
	if (typeof options !== "object" || options === null) return;
	if (typeof field(options, "path") === "string" || typeof field(options, "unix") === "string") return; // unix domain socket
	const hostname = field(options, "hostname");
	const host = field(options, "host");
	check(typeof hostname === "string" ? hostname : typeof host === "string" ? host : undefined, field(options, "port"));
}

function install(): void {
	const marker = globalThis as Record<symbol, unknown>;
	if (marker[GUARD]) return;
	marker[GUARD] = true;

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
		if (typeof first === "object" && first !== null) checkOptions(first);
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
				else checkOptions(first);
				checkOptions(args[1]);
				return Reflect.apply(real, this, args);
			});
		}
	}

	const connect: unknown = Reflect.get(Bun, "connect");
	if (typeof connect === "function") {
		Reflect.set(Bun, "connect", (options: unknown) => {
			checkOptions(options);
			return Reflect.apply(connect, Bun, [options]);
		});
	}
}

install();
