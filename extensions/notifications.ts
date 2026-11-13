// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";

export type ReportKind = "DONE" | "BLOCKED" | "WAITING" | "DECISION";
export interface TurnIdentity { sessionId: string; turnId: string }

/** Metadata only: no message bodies, transcript entries, or completion inference. */
export class Notifications {
	available = true;
	private sessionId = "";
	private latest: string | undefined;
	private turn: TurnIdentity | undefined;

	constructor(private readonly root: string) {}

	bind(sessionId: string): void {
		if (this.sessionId !== sessionId) {
			this.sessionId = sessionId;
			this.turn = undefined;
			this.latest = undefined;
			this.available = true;
		}
	}

	current(): TurnIdentity | undefined {
		return this.turn;
	}

	turnId(): string | undefined {
		return this.latest;
	}

	start(): void {
		this.turn = { sessionId: this.sessionId, turnId: randomBytes(16).toString("hex") };
		this.latest = this.turn.turnId;
	}

	end(name: string): void {
		const turn = this.turn;
		this.turn = undefined;
		if (turn) this.append({ ...turn, type: "end", name: name.slice(0, 160) });
	}

	reported(turn: TurnIdentity | undefined, report: ReportKind, destination: { id: string; sessionId: string }, response: Record<string, unknown>): void {
		// Require the actual receiver's acknowledgement, not a registry lookup alone.
		if (!turn || response.ok !== true || response.peerId !== destination.id || response.sessionId !== destination.sessionId) return;
		this.append({ ...turn, type: "report", report, destinationId: destination.id, destinationSessionId: destination.sessionId });
	}

	private append(event: TurnIdentity & Record<string, unknown>): void {
		const directory = path.join(this.root, "notifications");
		const id = createHash("sha256").update(event.sessionId).digest("hex");
		let fd: number | undefined;
		try {
			fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
			fd = fs.openSync(path.join(directory, `${id}.jsonl`), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
			fs.writeSync(fd, JSON.stringify({ version: 1, ...event, timestamp: Date.now() / 1000 }) + "\n");
			fs.fsyncSync(fd);
			this.available = true;
		} catch {
			this.available = false;
			// Notification bookkeeping must not fail an ordinary peer report.
			// Missing metadata never authorizes suppression.
		} finally {
			if (fd !== undefined) {
				try { fs.closeSync(fd); } catch {}
			}
		}
	}
}
