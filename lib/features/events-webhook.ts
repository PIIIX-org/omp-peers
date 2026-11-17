// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

/**
 * The optional loopback webhook listener: a deliberately tiny HTTP/1.1 server over `net`, bound to 127.0.0.1 only.
 * It speaks exactly one request per connection (`POST /events/<source>` with a JSON body and a Content-Length),
 * authenticates the raw body with HMAC-SHA256 before anything is parsed, and answers every other request with a
 * fixed status line and body. There is no TLS: put your own tunnel or reverse proxy in front of it.
 */
import * as net from "node:net";
import { MAX_EVENT_BYTES, NAME_RE, verifySignature } from "./events-ingest";

/** The only address the listener ever binds. Not configurable. */
export const LISTEN_HOST = "127.0.0.1";

export interface WebhookLimits {
	maxBodyBytes: number;
	maxHeaderBytes: number;
	maxHeaders: number;
	maxConnections: number;
	requestTimeoutMs: number;
	/** How often the listener asks whether it may keep running. */
	aliveCheckMs: number;
}
export const WEBHOOK_LIMITS: WebhookLimits = { maxBodyBytes: MAX_EVENT_BYTES, maxHeaderBytes: 8192, maxHeaders: 64, maxConnections: 8, requestTimeoutMs: 5000, aliveCheckMs: 5000 };

/** What the listener needs from the feature; it knows nothing about routes, state or sessions. */
export interface WebhookApp {
	/** The adapter name when `name` is a configured webhook source; undefined answers 404. */
	has(name: string): boolean;
	/** The shared secret for `name`, or undefined when it cannot be used (answers 401). */
	secret(name: string): Buffer | undefined;
	/** A request failed authentication; `why` is a fixed word. Called for every failure: the feature rate-limits what it records. */
	denied(name: string, why: "missing signature" | "bad signature" | "no usable secret"): void;
	/** An authenticated body: returns the HTTP status to send. */
	accept(name: string, headers: { event?: string; delivery?: string }, body: Buffer): Promise<number>;
	/** False once the listener must stop (the session is no longer master, or events were turned off). */
	alive(): boolean;
}

export interface WebhookListener {
	port: number;
	/** The address actually bound, as reported by the socket. */
	address(): { address: string; port: number };
	/** Number of connections open right now. */
	connections(): number;
	/** Whether the listener has been closed (by `close()` or by itself when `alive()` turned false). */
	closed(): boolean;
	close(): Promise<void>;
}

const STATUS_TEXT: Record<number, string> = {
	200: "OK", 202: "Accepted", 400: "Bad Request", 401: "Unauthorized", 404: "Not Found", 405: "Method Not Allowed", 408: "Request Timeout", 411: "Length Required",
	413: "Payload Too Large", 415: "Unsupported Media Type", 417: "Expectation Failed", 429: "Too Many Requests", 431: "Request Header Fields Too Large", 503: "Service Unavailable",
};
/** Fixed response bodies: nothing a client sent is ever echoed. */
const BODIES: Record<number, string> = {
	200: '{"status":"ok"}', 202: '{"status":"accepted"}', 400: '{"error":"invalid request"}', 401: '{"error":"unauthorized"}', 404: '{"error":"not found"}', 405: '{"error":"method not allowed"}',
	408: '{"error":"request timeout"}', 411: '{"error":"content-length required"}', 413: '{"error":"payload too large"}', 415: '{"error":"json only"}', 417: '{"error":"expectation failed"}',
	429: '{"error":"rate limited"}', 431: '{"error":"headers too large"}', 503: '{"error":"unavailable"}',
};

function reply(socket: net.Socket, status: number): void {
	const body = BODIES[status] ?? BODIES[503];
	const head = `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Service Unavailable"}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\nCache-Control: no-store\r\n${status === 405 ? "Allow: POST\r\n" : ""}\r\n`;
	socket.end(head + body);
}

interface Head {
	method: string;
	target: string;
	headers: Map<string, string>;
}

/** Parse the request head. Duplicate headers are refused: a header seen twice is ambiguous and we never guess. */
function parseHead(text: string, maxHeaders: number): Head | undefined {
	const lines = text.split("\r\n");
	const request = /^([A-Z]{1,16}) (\S{1,256}) HTTP\/1\.[01]$/.exec(lines[0]);
	if (!request || lines.length - 1 > maxHeaders) return undefined;
	const headers = new Map<string, string>();
	for (const line of lines.slice(1)) {
		const colon = line.indexOf(":");
		if (colon < 1) return undefined;
		const name = line.slice(0, colon).toLowerCase();
		if (!/^[a-z0-9-]+$/.test(name) || headers.has(name)) return undefined;
		headers.set(name, line.slice(colon + 1).trim());
	}
	return { method: request[1], target: request[2], headers };
}

/**
 * Bind 127.0.0.1:`port` (0 picks a free port; the feature never asks for it) and serve `app`. Resolves once
 * listening; rejects with the bind error. The listener closes itself as soon as `app.alive()` says so.
 */
export function startWebhook(port: number, app: WebhookApp, limits: WebhookLimits = WEBHOOK_LIMITS): Promise<WebhookListener> {
	/** Connections being served (the limit applies to these) and every connection, including ones refused for being over the limit. */
	const open = new Set<net.Socket>();
	const all = new Set<net.Socket>();
	const server = net.createServer(socket => {
		all.add(socket);
		socket.on("close", () => all.delete(socket));
		if (open.size >= limits.maxConnections) {
			socket.on("error", () => {});
			reply(socket, 503);
			setTimeout(() => socket.destroy(), 100).unref();
			return;
		}
		open.add(socket);
		socket.on("close", () => open.delete(socket));
		socket.on("error", () => socket.destroy());
		const timer = setTimeout(() => {
			if (!socket.writableEnded) reply(socket, 408);
			setTimeout(() => socket.destroy(), 100).unref();
		}, limits.requestTimeoutMs);
		socket.on("close", () => clearTimeout(timer));
		let received = Buffer.alloc(0);
		let head: Head | undefined;
		let bodyStart = 0;
		let want = 0;
		let done = false;
		const finish = (status: number) => {
			if (done) return;
			done = true;
			socket.removeAllListeners("data");
			reply(socket, status);
		};
		const onHead = (parsed: Head): number | undefined => {
			if (!app.alive()) return 503;
			const match = /^\/events\/([a-z0-9][a-z0-9_-]{0,31})$/.exec(parsed.target);
			if (!match || !NAME_RE.test(match[1]) || !app.has(match[1])) return 404;
			if (parsed.method !== "POST") return 405;
			if (parsed.headers.has("expect")) return 417;
			if (parsed.headers.has("transfer-encoding") || !parsed.headers.has("content-length")) return 411;
			const length = parsed.headers.get("content-length")!;
			if (!/^[0-9]{1,9}$/.test(length)) return 400;
			if (Number(length) > limits.maxBodyBytes) return 413;
			if (!/^application\/json(?:\s*;\s*charset=utf-?8)?$/i.test(parsed.headers.get("content-type") ?? "")) return 415;
			want = Number(length);
			return undefined;
		};
		const handle = async (parsed: Head, body: Buffer): Promise<number> => {
			const name = /^\/events\/([a-z0-9][a-z0-9_-]{0,31})$/.exec(parsed.target)![1];
			const header = parsed.headers.get("x-hub-signature-256");
			if (header === undefined) {
				app.denied(name, "missing signature");
				return 401;
			}
			const secret = app.secret(name);
			if (!secret) {
				app.denied(name, "no usable secret");
				return 401;
			}
			if (!verifySignature(secret, body, header)) {
				app.denied(name, "bad signature");
				return 401;
			}
			// Authenticated: only now is the body parsed, by the feature.
			return app.accept(name, { event: parsed.headers.get("x-github-event"), delivery: parsed.headers.get("x-github-delivery") }, body);
		};
		socket.on("data", (chunk: Buffer) => {
			if (done) return;
			received = Buffer.concat([received, chunk]);
			if (!head) {
				const end = received.indexOf("\r\n\r\n");
				if (end < 0) {
					if (received.length > limits.maxHeaderBytes) finish(431);
					return;
				}
				if (end > limits.maxHeaderBytes) return finish(431);
				const parsed = parseHead(received.subarray(0, end).toString("latin1"), limits.maxHeaders);
				if (!parsed) return finish(400);
				const early = onHead(parsed);
				if (early !== undefined) return finish(early);
				head = parsed;
				bodyStart = end + 4;
			}
			if (received.length - bodyStart < want) return;
			const parsed = head;
			const body = Buffer.from(received.subarray(bodyStart, bodyStart + want));
			done = true;
			// The 5 s limit is for receiving the request; handling it is bounded by the state lock timeout instead.
			clearTimeout(timer);
			socket.removeAllListeners("data");
			handle(parsed, body).then(status => reply(socket, status), () => reply(socket, 503));
		});
	});
	let listener: WebhookListener | undefined;
	const guard = setInterval(() => {
		if (!app.alive()) void listener?.close();
	}, limits.aliveCheckMs);
	guard.unref();
	const { promise, resolve, reject } = Promise.withResolvers<WebhookListener>();
	server.once("error", error => {
		clearInterval(guard);
		reject(error);
	});
	server.listen({ port, host: LISTEN_HOST, exclusive: true }, () => {
		server.removeAllListeners("error");
		server.on("error", () => {});
		const bound = server.address() as net.AddressInfo;
		let closing: Promise<void> | undefined;
		listener = {
			port: bound.port,
			address: () => ({ address: bound.address, port: bound.port }),
			connections: () => open.size,
			closed: () => closing !== undefined,
			close: () => {
				clearInterval(guard);
				if (!closing) {
					const closed = Promise.withResolvers<void>();
					closing = closed.promise;
					server.close(() => closed.resolve());
					for (const socket of all) socket.destroy();
					// The listening socket is closed above; do not let a slow teardown block `off`.
					setTimeout(closed.resolve, 2000).unref();
				}
				return closing;
			},
		};
		resolve(listener);
	});
	return promise;
}
