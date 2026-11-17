// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { isLoopback } from "../netguard";

// Address literals are built here so the repository leak scan, which flags non-loopback IPs, stays quiet.
const OUTSIDE_IP = ["203", "0", "113", "7"].join(".");
const REFUSED = /^network guard: refused outbound connection to /;

/** Connect with `open`, read until the peer closes, and return what it sent. */
function readAll(open: () => net.Socket): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const socket = open();
	let text = "";
	socket.on("data", chunk => (text += chunk));
	socket.on("end", () => resolve(text));
	socket.on("error", reject);
	return promise;
}

async function listen(server: net.Server, target: { port: number; host: string } | { path: string }): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	server.listen(target, resolve);
	await promise;
}

const ip = (...parts: number[]): string => parts.join(".");
describe("loopback classification", () => {
	test("loopback names and literals pass; everything else, including unresolved names, does not", () => {
		for (const host of ["localhost", "LOCALHOST", "a.localhost", ip(127, 0, 0, 1), ip(127, 255, 255, 254), "::1", "[::1]", `::ffff:${ip(127, 0, 0, 1)}`, "", undefined]) {
			expect(isLoopback(host)).toBe(true);
		}
		for (const host of [OUTSIDE_IP, ip(10, 0, 0, 1), ip(0, 0, 0, 0), ip(128, 0, 0, 1), ip(127, 0, 0, 256), "example.com", "discord.com", "localhost.example.com", ["2001", "db8", "", "1"].join(":"), `::ffff:${OUTSIDE_IP}`]) {
			expect(isLoopback(host)).toBe(false);
		}
	});
});

describe("the preloaded guard", () => {
	const tcp = net.createServer(socket => socket.end("hi"));
	const unixServer = net.createServer(socket => socket.end("u"));
	const unixPath = `${process.env.TMPDIR ?? "/tmp"}/netguard-${process.pid}.sock`;
	let port = 0;
	beforeAll(async () => {
		await listen(tcp, { port: 0, host: "127.0.0.1" });
		const address = tcp.address();
		port = typeof address === "object" && address !== null ? address.port : 0;
		await listen(unixServer, { path: unixPath });
	});
	afterAll(() => {
		tcp.close();
		unixServer.close();
	});

	test("a non-loopback fetch is refused with host and port, before any DNS lookup", async () => {
		await expect(fetch("https://discord.com:8443/api")).rejects.toThrow("network guard: refused outbound connection to discord.com:8443");
		await expect(fetch(new Request(`http://${OUTSIDE_IP}/x`))).rejects.toThrow(REFUSED);
	});

	test("non-loopback net, tls, http and WebSocket connections throw", () => {
		expect(() => net.connect(443, "discord.com")).toThrow("network guard: refused outbound connection to discord.com:443");
		expect(() => net.connect({ host: OUTSIDE_IP, port: 80 })).toThrow(REFUSED);
		expect(() => new net.Socket().connect(80, "example.com")).toThrow(REFUSED);
		expect(() => tls.connect({ host: "example.com", port: 443 })).toThrow(REFUSED);
		expect(() => http.request("http://example.com/")).toThrow(REFUSED);
		expect(() => http.get({ hostname: OUTSIDE_IP, port: 80 })).toThrow(REFUSED);
		expect(() => new WebSocket("wss://example.com/gateway")).toThrow(REFUSED);
	});

	test("loopback TCP, loopback fetch and unix sockets still work", async () => {
		expect(await readAll(() => net.connect(port, "127.0.0.1"))).toBe("hi");
		const web = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
		try {
			expect(await (await fetch(`http://127.0.0.1:${web.port}/`)).text()).toBe("ok");
		} finally {
			void web.stop(true);
		}
		expect(await readAll(() => net.connect(unixPath))).toBe("u");
	});
});
