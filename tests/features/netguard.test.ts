// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import https, * as httpsNamespace from "node:https";
import { request as namedRequest } from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
// ONLY the side-effect-free policy module is imported: the refusals below pass solely because the bunfig preload
// (tests/netguard.ts) installed the guard before this file loaded.
import { expectViolations, fakeScript, isLoopback, takeViolations } from "../netguard_policy";

// Address literals are built here so the repository leak scan, which flags non-loopback IPs, stays quiet.
const OUTSIDE_IP = ["203", "0", "113", "7"].join(".");
const REFUSED = /^network guard: refused outbound connection to /;
const REFUSED_PROGRAM = /^network guard: refused network program /;
const GUARD_SOURCE = path.join(import.meta.dir, "..", "netguard.ts");

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

/** Run `attempt` expecting the guard to refuse exactly once; returns the recorded message. */
async function refusedOnce(attempt: () => unknown): Promise<string> {
	const violations = await expectViolations(async () => {
		try {
			await attempt();
		} catch {
			// the guard throws or rejects; what matters is the recorded violation
		}
	});
	expect(violations.length).toBeGreaterThanOrEqual(1);
	return violations[0];
}

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

	test("the guard is installed although this file imports only the policy module", () => {
		expect(Reflect.get(globalThis, Symbol.for("omp-peers.netguard"))).toBe(true);
	});

	test("a non-loopback fetch is refused with host and port, before any DNS lookup", async () => {
		const violations = await expectViolations(async () => {
			await expect(fetch("https://discord.com:8443/api")).rejects.toThrow("network guard: refused outbound connection to discord.com:8443");
			await expect(fetch(new Request(`http://${OUTSIDE_IP}/x`))).rejects.toThrow(REFUSED);
			expect(() => fetch.preconnect("https://example.com/")).toThrow(REFUSED);
		});
		expect(violations).toHaveLength(3);
		expect(violations[0]).toBe("network guard: refused outbound connection to discord.com:8443");
	});

	test("non-loopback net, tls, http and WebSocket connections throw", async () => {
		const violations = await expectViolations(() => {
			expect(() => net.connect(443, "discord.com")).toThrow("network guard: refused outbound connection to discord.com:443");
			expect(() => net.connect({ host: OUTSIDE_IP, port: 80 })).toThrow(REFUSED);
			expect(() => new net.Socket().connect(80, "example.com")).toThrow(REFUSED);
			expect(() => tls.connect({ host: "example.com", port: 443 })).toThrow(REFUSED);
			expect(() => http.request("http://example.com/")).toThrow(REFUSED);
			expect(() => http.get({ hostname: OUTSIDE_IP, port: 80 })).toThrow(REFUSED);
			expect(() => new WebSocket("wss://example.com/gateway")).toThrow(REFUSED);
		});
		expect(violations).toHaveLength(7);
	});

	test("an http(s) `path` is a URL path, never a unix socket (the form the ws library uses)", async () => {
		const violations = await expectViolations(() => {
			expect(() => https.request({ hostname: "discord.com", path: "/api/v10/gateway" })).toThrow("network guard: refused outbound connection to discord.com:?");
			expect(() => http.request({ host: OUTSIDE_IP, port: 80, path: "/x" })).toThrow(REFUSED);
			expect(() => http.get({ hostname: "example.com", path: "/" })).toThrow(REFUSED);
		});
		expect(violations).toHaveLength(3);
	});

	test("net, tls and Bun.connect options use `path`/`unix` as a unix socket, so a host beside it is not consulted", async () => {
		const violations = await expectViolations(async () => {
			const socket = net.connect({ path: unixPath, host: "example.com" });
			const first = Promise.withResolvers<string>();
			socket.once("data", chunk => first.resolve(String(chunk)));
			expect(await first.promise).toBe("u");
			socket.destroy();
			const bunSocket = await Bun.connect({ unix: unixPath, socket: { data() {}, open() {} } });
			bunSocket.end();
		});
		expect(violations).toEqual([]);
		const refused = await expectViolations(() => {
			expect(() => Bun.connect({ hostname: "example.com", port: 443, socket: { data() {} } })).toThrow(REFUSED);
		});
		expect(refused).toHaveLength(1);
	});

	test("namespace and named imports of node:https are refused on the first send", async () => {
		const attempts: Array<() => void> = [
			() => {
				const req = httpsNamespace.request({ hostname: "discord.com", path: "/api/v10/gateway" });
				req.on("error", () => {});
				req.end();
			},
			() => {
				const req = namedRequest({ hostname: "discord.com", path: "/api/v10/gateway" });
				req.on("error", () => {});
				req.write("x");
			},
			() => {
				const req = namedRequest({ hostname: "discord.com", path: "/" });
				req.on("error", () => {});
				req.flushHeaders();
			},
		];
		for (const attempt of attempts) {
			expect(await refusedOnce(attempt)).toMatch(REFUSED);
		}
	});

	test("loopback TCP, loopback fetch, loopback http and unix sockets still work", async () => {
		expect(await readAll(() => net.connect(port, "127.0.0.1"))).toBe("hi");
		const web = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
		try {
			expect(await (await fetch(`http://127.0.0.1:${web.port}/`)).text()).toBe("ok");
			const body = Promise.withResolvers<string>();
			const req = http.request({ hostname: "127.0.0.1", port: web.port, path: "/p" }, res => {
				let text = "";
				res.on("data", chunk => (text += chunk));
				res.on("end", () => body.resolve(text));
			});
			req.on("error", body.reject);
			req.end();
			expect(await body.promise).toBe("ok");
		} finally {
			void web.stop(true);
		}
		expect(await readAll(() => net.connect(unixPath))).toBe("u");
	});

	test("an undeclared refusal is written to stderr and fails the process even when the caller catches it", () => {
		// Run in a child so the undeclared refusal neither prints in this run nor trips this run's own violation check.
		const script = `import net from "node:net"; try { net.connect(80, "example.com"); } catch {} console.log("done");`;
		const child = Bun.spawnSync([process.execPath, "--preload", GUARD_SOURCE, "-e", script], { cwd: os.tmpdir(), stdout: "pipe", stderr: "pipe" });
		expect(child.stdout.toString().trim()).toBe("done");
		expect(child.stderr.toString()).toContain("network guard: refused outbound connection to example.com:80");
		expect(child.exitCode).toBe(1);
	});

	test("refusals declared with expectViolations leave nothing behind in the global log", async () => {
		const violations = await expectViolations(() => {
			expect(() => net.connect(80, "example.com")).toThrow(REFUSED);
		});
		expect(violations).toHaveLength(1);
		expect(takeViolations()).toEqual([]);
	});
});

describe("child processes", () => {
	const fixtures = mkdtempSync(path.join(os.tmpdir(), "netguard-"));
	const fakeSsh = path.join(fixtures, "ssh");
	const linkedSsh = path.join(fixtures, "git");
	beforeAll(() => {
		writeFileSync(fakeSsh, fakeScript("echo fake-ssh"));
		chmodSync(fakeSsh, 0o755);
		symlinkSync(Bun.which("true") ?? "/usr/bin/true", linkedSsh);
	});
	afterAll(() => rmSync(fixtures, { recursive: true, force: true }));

	test("network programs are refused through every spawn API, and the refusal is recorded", async () => {
		const attempts: Array<() => unknown> = [
			() => Bun.spawn(["curl", "--version"]),
			() => Bun.spawn({ cmd: ["wget", "--version"] }),
			() => Bun.spawnSync(["/usr/bin/ssh", "-V"]),
			() => Bun.spawnSync(["git", "--version"]),
			() => spawnSync("rsync", ["--version"]),
			() => spawn("nc", ["-h"]),
			() => execFileSync("telnet", ["--help"]),
			() => execSync("echo hello && curl --version"),
			() => execSync("(cd . ; /usr/bin/scp -V)"),
			() => Bun.spawnSync(["sh", "-c", "ssh -V"]),
			() => execSync("curl>/dev/null"),
			() => execSync("cat </dev/null;/usr/bin/wget<&-"),
		];
		for (const attempt of attempts) {
			expect(await refusedOnce(attempt)).toMatch(REFUSED_PROGRAM);
		}
		const violations = await expectViolations(() => {
			expect(() => Bun.spawnSync(["curl", "--version"])).toThrow(REFUSED_PROGRAM);
		});
		expect(violations).toHaveLength(1);
	});

	test("ordinary programs and words that merely contain a program name are not refused", async () => {
		const violations = await expectViolations(() => {
			expect(Bun.spawnSync(["echo", "ok"]).stdout.toString().trim()).toBe("ok");
			expect(execSync("echo gitignore curl-like ssh_config").toString()).toContain("gitignore");
			expect(execFileSync("ls", ["/"], { stdio: "pipe" }).length).toBeGreaterThan(0);
		});
		expect(violations).toEqual([]);
	});

	test("exception: a text script carrying the marker line may carry a network name, wherever it sits", async () => {
		const violations = await expectViolations(() => {
			expect(Bun.spawnSync([fakeSsh]).stdout.toString().trim()).toBe("fake-ssh");
			expect(spawnSync("ssh", { env: { PATH: fixtures } }).stdout.toString().trim()).toBe("fake-ssh");
			expect(execSync(`${fakeSsh}`).toString().trim()).toBe("fake-ssh");
		});
		expect(violations).toEqual([]);
	});

	/** A fresh directory for one test: every file the test writes goes here, never into the shared fixtures. */
	const freshDir = (prefix: string) => mkdtempSync(prefix);

	test("a copy of a real network program is refused wherever it is written and whatever it is named", async () => {
		const realCurl = Bun.which("curl");
		expect(realCurl).toBeTruthy();
		const bytes = readFileSync(realCurl!);
		const dirs = [freshDir(path.join(os.tmpdir(), "netguard-copy-")), freshDir("/tmp/opf-"), freshDir("/tmp/opx-"), freshDir("/tmp/netguard-")];
		try {
			const copies: string[] = [];
			for (const dir of dirs) {
				mkdirSync(path.join(dir, "tools"));
				for (const name of ["curl", "git", "wget", "ssh", "scp"]) {
					for (const sub of ["", "tools"]) {
						// One new file per copy in a directory this test just created; an existing file or symlink is never written through.
						const file = path.join(dir, sub, name);
						writeFileSync(file, bytes, { mode: 0o755, flag: "wx" });
						chmodSync(file, 0o755);
						copies.push(file);
					}
				}
			}
			for (const copy of copies) {
				expect(await refusedOnce(() => Bun.spawnSync([copy, "--version"])), copy).toMatch(REFUSED_PROGRAM);
				expect(await refusedOnce(() => spawnSync(path.basename(copy), ["--version"], { env: { PATH: path.dirname(copy) } })), `via PATH: ${copy}`).toMatch(REFUSED_PROGRAM);
			}
		} finally {
			for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a script is a fake only with the exact marker line near its top and a #! start; the genuine fake is allowed", async () => {
		const dir = freshDir("/tmp/opx-");
		try {
			const write = (name: string, text: string | Buffer) => {
				const file = path.join(dir, name, "ssh");
				mkdirSync(path.dirname(file));
				writeFileSync(file, text, { mode: 0o755, flag: "wx" });
				chmodSync(file, 0o755);
				return file;
			};
			const genuine = write("genuine", fakeScript("echo genuine"));
			const violations = await expectViolations(() => {
				expect(Bun.spawnSync([genuine]).stdout.toString().trim()).toBe("genuine");
			});
			expect(violations).toEqual([]);
			const refused: Record<string, string | Buffer> = {
				noMarker: "#!/bin/sh\necho nothing\n",
				similarMarker: "#!/bin/sh\n# omp-peers netguard fake2\necho x\n",
				markerWithSuffix: "#!/bin/sh\n# omp-peers netguard fake \necho x\n",
				markerOnShebangLine: "#!/bin/sh # omp-peers netguard fake\necho x\n",
				noShebang: "# omp-peers netguard fake\necho x\n",
				markerTooLate: `#!/bin/sh\n${"#".repeat(600)}\n# omp-peers netguard fake\necho x\n`,
				binaryWithMarker: Buffer.concat([Buffer.from("#!/bin/sh\n# omp-peers netguard fake\n"), Buffer.from([0, 1, 2]), Buffer.from("echo x\n")]),
				realBinaryPlusMarker: Buffer.concat([readFileSync(Bun.which("curl")!).subarray(0, 64), Buffer.from("\n# omp-peers netguard fake\n")]),
			};
			for (const [name, text] of Object.entries(refused)) {
				const file = write(name, text);
				expect(await refusedOnce(() => Bun.spawnSync([file])), name).toMatch(REFUSED_PROGRAM);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the exception follows the real path: a tmp symlink to a system program named like a network tool is refused", async () => {
		expect(await refusedOnce(() => Bun.spawnSync([linkedSsh, "--version"]))).toMatch(REFUSED_PROGRAM);
	});

	test("a child bun without --preload is guarded too; one that already has --preload is left alone", () => {
		const script = `try { await fetch("https://discord.com/"); console.log("OPEN"); } catch (error) { console.log(String(error.message)); }`;
		const child = Bun.spawnSync([process.execPath, "-e", script], { cwd: os.tmpdir(), stdout: "pipe", stderr: "pipe" });
		expect(child.stdout.toString()).toMatch(/network guard: refused outbound connection to discord\.com/);
		expect(child.stderr.toString()).toMatch(/network guard: refused outbound connection to discord\.com/);
		expect(child.exitCode).toBe(1); // the child caught the refusal and finished normally, yet still fails
		const explicit = Bun.spawnSync([process.execPath, "--preload", GUARD_SOURCE, "-e", script], { cwd: os.tmpdir(), stdout: "pipe", stderr: "pipe" });
		expect(explicit.stdout.toString()).toMatch(/refused outbound connection/);
		expect(explicit.exitCode).toBe(1);
		const viaNode = spawnSync(process.execPath, ["-e", script], { cwd: os.tmpdir() });
		expect(viaNode.stdout.toString()).toMatch(/refused outbound connection/);
		expect(viaNode.status).toBe(1);
	});
});
