// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

// Shared fixtures for the multi-host tests: disposable homes, a fake peer session (a unix socket that counts
// connections) and a fake `ssh` executable that runs the real remote bridge locally in a second home.
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { stablePeerId } from "../../lib/identity";
import { sshArgv } from "../../lib/features/hosts";
import { fakeScript } from "../netguard_policy";

export const REPO = path.resolve(import.meta.dir, "..", "..");
export const BRIDGE_SCRIPT = path.join(REPO, "scripts", "omp-peers-remote.ts");
const NETGUARD = path.join(REPO, "tests", "netguard.ts");

export const tmpHome = (): string => fs.mkdtempSync(path.join("/tmp", "opf-"));

export interface FakeSession {
	id: string;
	sock: string;
	requests: Array<Record<string, unknown>>;
	/** Every connection to the socket, including ones that sent nothing. */
	connections: number;
	close(): void;
}

export interface SessionOptions {
	name?: string;
	/** Extra or overriding registry fields. */
	row?: Record<string, unknown>;
	/** The answer to each request; "silent" never answers. Default `{ ok: true }`. */
	reply?: (request: Record<string, unknown>) => Record<string, unknown> | "silent";
	/** Publish a row but run no socket server. */
	noServer?: boolean;
}

/** A live-looking session: a registry row under `<home>/.omp/run/peers` (with fields a bridge must never forward) and a socket. */
export async function startSession(home: string, seed: string, options: SessionOptions = {}): Promise<FakeSession> {
	const sessionId = `session-${seed}`;
	const id = stablePeerId(sessionId);
	const root = path.join(home, ".omp", "run", "peers");
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	const sock = path.join(root, `${id}.sock`);
	const row = {
		id, instance: "instance-secret-1", pid: process.pid, name: options.name ?? "worker", cwd: "/work/private-project", sessionId,
		model: "provider/model-x", effort: "high", subagents: "auto=on tier=standard secret-note", busy: false, context: "1234 (5%)",
		sock, startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z", inbound: "accept", control: true, routingPolicy: "keep",
		paused: false, recentErrorTurns: 0, ...options.row,
	};
	fs.writeFileSync(path.join(root, `${id}.json`), JSON.stringify(row));
	const session: FakeSession = { id, sock, requests: [], connections: 0, close: () => {} };
	if (options.noServer) return session;
	const server = net.createServer(conn => {
		session.connections++;
		let buf = "";
		conn.on("error", () => conn.destroy());
		conn.on("data", chunk => {
			buf += chunk.toString();
			const newline = buf.indexOf("\n");
			if (newline < 0) return;
			const request = JSON.parse(buf.slice(0, newline)) as Record<string, unknown>;
			session.requests.push(request);
			const answer = options.reply ? options.reply(request) : { ok: true };
			if (answer !== "silent") conn.end(`${JSON.stringify(answer)}\n`);
		});
	});
	await new Promise<void>(resolve => server.listen(sock, resolve));
	session.close = () => {
		server.close();
		fs.rmSync(sock, { force: true });
	};
	return session;
}

/**
 * A fake `ssh`: refuses (exit 97) unless called with exactly `sshArgv(<its path>, target)`, appends one line to
 * `log` per call, then runs the real bridge script with HOME set to `remoteHome`.
 */
export function writeFakeSsh(dir: string, target: string, remoteHome: string, log: string): string {
	const bin = path.join(dir, "ssh");
	const expected = sshArgv(bin, target).slice(1);
	const checks = expected.map((arg, index) => `[ "\${${index + 1}}" = '${arg}' ] || { echo "fake ssh: argument ${index + 1} differs" >&2; exit 97; }`);
	const script = fakeScript([
		`echo called >> '${log}'`,
		`[ "$#" -eq ${expected.length} ] || { echo "fake ssh: bad argument count $#" >&2; exit 97; }`,
		...checks,
		// The bridge runs under the network guard: any attempt to reach a non-loopback host fails loudly.
		`HOME='${remoteHome}' exec '${process.execPath}' --preload '${NETGUARD}' '${BRIDGE_SCRIPT}'`,
	].join("\n"));
	fs.writeFileSync(bin, script, { mode: 0o700 });
	return bin;
}

/** Every file under `dir` (recursively, not following symlinks) with its text; used to assert nothing credential-like was written. */
export function allFileText(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...allFileText(full));
		else if (entry.isFile()) out.push(fs.readFileSync(full, "utf8"));
	}
	return out;
}
