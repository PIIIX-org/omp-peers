// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FEATURES } from "../../lib/features";
import type { FeatureHost } from "../../lib/features/host";
import {
	AuditLog, auditCommand, auditConfigFile, auditPaths, buildRecord, classifyResponse, describeParams, newRequestId, parseRecord,
	validRequestId, MAX_LINE_BYTES, type AuditInput, type AuditRecord, type ControlArgs, type Outcome, type Reason,
} from "../../lib/features/audit";

const MASTER = "p00000000000000aa";
const WORKER = "p00000000000000a1";
const T0 = 1_700_000_000_000;
const DAY = 86_400_000;

let home: string;
beforeEach(() => {
	home = fs.mkdtempSync(path.join("/tmp", "opf-"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const host = (): FeatureHost => ({
	home,
	now: () => T0,
	self: () => ({ id: MASTER, name: "master" }),
	isMaster: () => true,
	acceptsRemote: () => true,
	peers: async () => [],
	groupsOf: () => [],
	send: async () => ({ status: "offline" }),
});
const cmd = (args: string, log = new AuditLog()) => auditCommand(args.split(/\s+/).filter(Boolean), host(), log);
const paths = () => auditPaths(home);
const mode = (p: string) => fs.statSync(p).mode & 0o777;
const input = (over: Partial<AuditInput> = {}): AuditInput => ({
	request: newRequestId(),
	side: "receiver",
	phase: "attempted",
	actor: { id: MASTER, name: "master" },
	target: { id: WORKER, name: "worker-a" },
	op: "abort",
	args: {},
	...over,
});
const lines = (file = paths().live) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
const records = (file = paths().live): AuditRecord[] => lines(file).map(line => {
	const record = parseRecord(line);
	if (!record) throw new Error(`not a valid record: ${line}`);
	return record;
});
const enable = async () => expect(await cmd("on")).toContain("audit log on");
/** Peers config with the audit limits; the smallest legal size cap is 64 KiB. */
const configure = (audit: unknown) => {
	fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
	fs.writeFileSync(path.join(home, ".omp", "agent", "peers.json"), JSON.stringify({ audit }));
};

describe("opt-in and storage", () => {
	test("is registered as /peers audit", () => {
		expect(FEATURES.map(f => f.name)).toContain("audit");
	});

	test("off by default: recording writes nothing, not even the state directory", async () => {
		const log = new AuditLog();
		await log.record(home, T0, input());
		expect(fs.existsSync(path.join(home, ".omp"))).toBe(false);
		expect(log.lastError).toBeUndefined();
		expect(await cmd("")).toContain("audit: off (opt-in; /peers audit on enables it)");
		expect(fs.existsSync(path.join(home, ".omp"))).toBe(false);
	});

	test("on persists privately and survives a new process-level recorder; off stops recording but keeps the log", async () => {
		await enable();
		expect(mode(auditConfigFile(home))).toBe(0o600);
		expect(JSON.parse(fs.readFileSync(auditConfigFile(home), "utf8"))).toEqual({ version: 1, enabled: true });
		await new AuditLog().record(home, T0, input());
		expect(records()).toHaveLength(1);
		expect(await cmd("off")).toContain("existing log is kept");
		await new AuditLog().record(home, T0, input());
		expect(records()).toHaveLength(1);
		expect(await cmd("on extra")).toContain("usage:");
	});

	test("log directory is 0700 and the file 0600; no temp files remain", async () => {
		await enable();
		await new AuditLog().record(home, T0, input());
		expect(mode(paths().dir)).toBe(0o700);
		expect(mode(paths().live)).toBe(0o600);
		expect(fs.readdirSync(paths().dir).filter(name => name.endsWith(".tmp"))).toEqual([]);
	});
});

describe("record schema", () => {
	test("attempted and completed records are exact version 1 objects sharing one request id", async () => {
		await enable();
		const log = new AuditLog();
		const request = newRequestId();
		await log.record(home, T0, input({ request, op: "model", args: { text: "provider/model:high" } }));
		await log.record(home, T0 + 5, input({ request, op: "model", args: { text: "provider/model:high" }, phase: "completed", masterChecked: true, result: { outcome: "ok" } }));
		const [attempted, completed] = records();
		expect(attempted).toEqual({
			v: 1, ts: T0, event: attempted.event, request, side: "receiver", phase: "attempted", actorClaim: MASTER, actorClaimName: "master",
			targetId: WORKER, targetName: "worker-a", op: "model", params: { selector: "provider/model:high" },
		});
		expect(completed).toEqual({
			v: 1, ts: T0 + 5, event: completed.event, request, side: "receiver", phase: "completed", actorClaim: MASTER, actorClaimName: "master",
			targetId: WORKER, targetName: "worker-a", op: "model", params: { selector: "provider/model:high" }, masterChecked: true, outcome: "ok",
		});
		expect(attempted.event).toMatch(/^[0-9a-f]{32}$/);
		expect(attempted.event).not.toBe(completed.event);
		expect(Object.keys(JSON.parse(lines()[0]))).not.toContain("outcome");
	});

	test("a refused completion carries the fixed reason; the claim is stored as a claim, never as an authenticated actor", async () => {
		await enable();
		const log = new AuditLog();
		await log.record(home, T0, input({ phase: "completed", actor: { id: "p0000000000000bad" }, masterChecked: false, result: { outcome: "refused", reason: "not-master" } }));
		const [record] = records();
		expect(record).toMatchObject({ actorClaim: "p0000000000000bad", masterChecked: false, outcome: "refused", reason: "not-master" });
		expect(Object.keys(record)).not.toContain("actorId");
		expect(record.actorClaimName).toBeUndefined();
	});

	test("an absent claim is unknown and a malformed one is [invalid]; ids are never free text", () => {
		expect(buildRecord(input({ actor: {} }), T0).actorClaim).toBe("unknown");
		expect(buildRecord(input({ actor: { id: "not an id\n{\"x\":1}" } }), T0).actorClaim).toBe("[invalid]");
		expect(buildRecord(input({ actor: { id: 7 }, target: { id: { toString: 1 } } }), T0)).toMatchObject({ actorClaim: "[invalid]", targetId: "[invalid]" });
	});

	test("a request id from the wire is kept only in the random-id shape", () => {
		const id = newRequestId();
		expect(validRequestId(id)).toBe(id);
		for (const bad of [undefined, 5, "", id.toUpperCase(), `${id}0`, id.slice(1), "../../x"]) expect(validRequestId(bad)).toBeUndefined();
	});

	test("strict parser rejects unknown keys, wrong types, forged outcomes on attempts and out-of-vocabulary reasons", () => {
		const good = buildRecord(input(), T0);
		expect(parseRecord(JSON.stringify(good))).toEqual(good);
		const bad: unknown[] = [
			{ ...good, extra: 1 }, { ...good, v: 2 }, { ...good, ts: "1" }, { ...good, request: "x" }, { ...good, phase: "other" },
			{ ...good, outcome: "ok" }, { ...good, phase: "completed", outcome: "ok", reason: "free text from a peer" }, { ...good, phase: "completed", outcome: "great" },
			{ ...good, params: { value: "secret" } }, { ...good, actorClaimName: "\u001b[2Jevil" }, { ...good, actorClaim: "x".repeat(10) },
		];
		for (const value of bad) expect(parseRecord(JSON.stringify(value))).toBeUndefined();
		expect(parseRecord("not json")).toBeUndefined();
		expect(parseRecord(`{"pad":"${"x".repeat(MAX_LINE_BYTES)}"}`)).toBeUndefined();
	});

	test("the largest possible record stays within the 4 KiB line limit", async () => {
		await enable();
		const wide = "\u{1F600}".repeat(200);
		await new AuditLog().record(home, T0, input({
			phase: "completed", op: "setting", actor: { id: MASTER, name: wide }, target: { id: WORKER, name: wide }, masterChecked: false,
			args: { text: "set", key: "a".repeat(30), tier: "heavy", overridePin: true, n: 5 }, result: { outcome: "unknown", reason: "response-too-large" },
		}));
		await new AuditLog().record(home, T0, input({ op: "model", actor: { id: MASTER, name: wide }, target: { id: WORKER, name: wide }, args: { text: "a/".repeat(300) } }));
		expect(lines().every(line => Buffer.byteLength(line) + 1 <= MAX_LINE_BYTES)).toBe(true);
		expect(records()).toHaveLength(2);
		expect([...records()[0].actorClaimName!]).toHaveLength(60);
		expect(records()[1].params?.selector).toBe("[redacted]");
	});
});

describe("content policy", () => {
	const SENTINEL = "SENTINEL-BODY-do-not-store";

	test("prompt bodies, setting values, rename text, subagent specs and transcripts never reach the file", async () => {
		await enable();
		const log = new AuditLog();
		const cases: Array<Pick<AuditInput, "op" | "args">> = [
			{ op: "prompt", args: { text: `${SENTINEL} prompt`, tier: "heavy", overridePin: true } },
			{ op: "setting", args: { text: "set", key: "retry.maxAttempts", value: { secret: SENTINEL } } as ControlArgs },
			{ op: "rename", args: { text: `${SENTINEL} name` } },
			{ op: "subagents", args: { text: `task=${SENTINEL}-model` } },
			{ op: "tail", args: { text: SENTINEL, n: 6 } },
			{ op: "abort", args: { text: SENTINEL } },
			{ op: "compact", args: { text: SENTINEL } },
			{ op: "shutdown", args: { text: SENTINEL } },
		];
		for (const [i, c] of cases.entries()) for (const phase of ["attempted", "completed"] as const) {
			await log.record(home, T0 + i, input({ ...c, phase, ...(phase === "completed" ? { result: { outcome: "ok" as const } } : {}) }));
		}
		expect(log.lastError).toBeUndefined();
		const raw = fs.readFileSync(paths().live, "utf8");
		expect(raw).not.toContain(SENTINEL);
		expect(raw).not.toContain("SENTINEL");
		expect(records()).toHaveLength(cases.length * 2);
	});

	test("params keep only lengths, keyword modes and screened names", () => {
		const bytes = Buffer.byteLength("h\u00e9llo \u{1F600}");
		expect(describeParams("prompt", { text: "h\u00e9llo \u{1F600}", tier: "light", overridePin: true })).toEqual({ textLength: bytes, tier: "light", overridePin: true });
		expect(describeParams("prompt", { text: "x", tier: "bogus", overridePin: "yes" })).toEqual({ textLength: 1 });
		expect(describeParams("prompt", {})).toEqual({ textLength: 0 });
		expect(describeParams("rename", { text: "h\u00e9llo" })).toEqual({ textLength: Buffer.byteLength("h\u00e9llo") });
		expect(describeParams("setting", { text: "set", key: "task.agentModelOverrides", value: "v" } as ControlArgs)).toEqual({ mode: "set", key: "task.agentModelOverrides" });
		expect(describeParams("setting", {})).toEqual({ mode: "get" });
		expect(describeParams("setting", { text: "list", key: "retry." })).toEqual({ mode: "list", key: "retry." });
		expect(describeParams("setting", { text: "frobnicate" })).toEqual({ mode: "[invalid]" });
		expect(describeParams("subagents", { text: "auto" })).toEqual({ mode: "auto", textLength: 4 });
		expect(describeParams("subagents", { text: "" })).toEqual({ mode: "clear" });
		expect(describeParams("subagents", { text: "task=provider/model" })).toEqual({ mode: "spec", textLength: 19 });
		expect(describeParams("effort", { text: "high" })).toEqual({ effort: "high" });
		expect(describeParams("effort", { text: "x".repeat(40) })).toEqual({ effort: "[redacted]" });
		expect(describeParams("tail", { n: 6 })).toEqual({ n: 6 });
		for (const n of [0, -1, 1.5, Number.NaN, "6", undefined]) expect(describeParams("tail", { n })).toBeUndefined();
		expect(describeParams("tail", { n: 1e12 })).toEqual({ n: 1_000_000 });
		for (const op of ["abort", "compact", "shutdown"]) expect(describeParams(op, { text: SENTINEL })).toBeUndefined();
	});

	test("selectors that look like credentials, contain controls or odd characters are masked; long ones are capped at 80", () => {
		// Credential-shaped samples are assembled at runtime so the repository holds none.
		const ant = `sk-${"ant-"}${"A1b2".repeat(8)}`;
		const assigned = `api_${"key"}=${"abcd1234".repeat(2)}`;
		const jwt = ["eyJ" + "a".repeat(14), "b".repeat(14), "c".repeat(14)].join(".");
		const blob = "A".repeat(20) + "b".repeat(20);
		for (const selector of [ant, assigned, jwt, blob, "model\nname", "mod el", "name\u001b[31m", "a;b", `bearer ${"x".repeat(20)}`, "x".repeat(600)]) {
			expect(describeParams("model", { text: selector })).toEqual({ selector: "[redacted]" });
		}
		expect(describeParams("model", { text: `provider/${"m-".repeat(60)}` })?.selector).toHaveLength(80);
		expect(describeParams("model", { text: "provider/model-name:high" })).toEqual({ selector: "provider/model-name:high" });
		expect(describeParams("model", { text: "@default" })).toEqual({ selector: "@default" });
		expect(describeParams("model", { text: "  " })).toBeUndefined();
		expect(describeParams("model", {})).toBeUndefined();
	});

	test("setting keys that are not plain identifiers or look like credentials are masked", () => {
		const keyed = `token=${"abcd1234".repeat(2)}`;
		for (const key of [keyed, "a b", "key\n", "x".repeat(81), "A".repeat(33)]) expect(describeParams("setting", { text: "get", key })).toEqual({ mode: "get", key: "[redacted]" });
	});

	test("names lose control characters, are masked when credential-shaped, and are capped", () => {
		const name = (value: unknown) => buildRecord(input({ target: { id: WORKER, name: value } }), T0).targetName;
		expect(name("work\u001b[2Jer\n\tone\u202e")).toBe("work [2Jer one");
		expect(name(`n ${"api_" + "key"}=${"abcd1234".repeat(2)}`)).toBe("[redacted]");
		expect(name("ab-".repeat(40))).toHaveLength(60);
		// Trimmed after the cap, so a cut that lands on a space still re-parses as a valid record.
		expect(name("ab ".repeat(40))).toBe("ab ".repeat(19) + "ab");
		const cut = buildRecord(input({ target: { id: WORKER, name: "ab ".repeat(40) } }), T0);
		expect(parseRecord(JSON.stringify(cut))).toEqual(cut);
		expect(name("x".repeat(100))).toBe("[redacted]"); // an unbroken run this long is indistinguishable from a token
		expect(name("   ")).toBeUndefined();
		expect(name(42)).toBeUndefined();
	});

	test("reasons come from a fixed vocabulary; response text is classified, never stored", () => {
		const cases: Array<[Record<string, unknown>, Outcome, Reason?]> = [
			[{ ok: true }, "ok"],
			[{ ok: false, error: "peer is locked (control refused)" }, "refused", "locked"],
			[{ ok: false, error: "sender is not the master session" }, "refused", "not-master"],
			[{ ok: false, error: "peer refuses inbound requests" }, "refused", "inbound-refused"],
			[{ ok: false, error: 'setting "auth.x" is protected and cannot be changed remotely' }, "refused", "protected-setting"],
			[{ ok: false, error: "session not ready" }, "failed", "not-ready"],
			[{ ok: false, error: "unreachable (ECONNREFUSED)" }, "unreachable", "unreachable"],
			[{ ok: false, error: "timeout" }, "unknown", "timeout"],
			[{ ok: false, error: "connection closed" }, "unknown", "connection-closed"],
			[{ ok: false, error: "bad response" }, "unknown", "bad-response"],
			[{ ok: false, error: "response too large" }, "unknown", "response-too-large"],
			[{ ok: false, error: "empty prompt" }, "failed", "invalid-argument"],
			[{ ok: false, error: 'invalid effort "x"' }, "failed", "invalid-argument"],
			[{ ok: false, error: 'unknown setting "x"' }, "failed", "invalid-argument"],
			[{ ok: false, error: 'unavailable model "x" (unknown, unauthenticated or invalid selector); no dispatch or effort change' }, "failed", "unavailable-model"],
			[{ ok: false, error: 'no credentials for model "x"; no dispatch or effort change' }, "failed", "no-credentials"],
			[{ ok: false, error: "peer busy; explicit routing refused without dispatch; retry when idle" }, "failed", "busy"],
			[{ ok: false, error: "anything else, including attacker text" }, "failed", "error"],
			[{ ok: false }, "failed", "error"],
			[{ ok: false, error: 5 }, "failed", "error"],
		];
		for (const [response, outcome, reason] of cases) expect(classifyResponse("prompt", response)).toEqual({ outcome, ...(reason ? { reason } : {}) });
		expect(classifyResponse("prompt", { ok: true, queued: true })).toEqual({ outcome: "deferred" });
		expect(classifyResponse("compact", { ok: true, started: true })).toEqual({ outcome: "deferred" });
		expect(classifyResponse("shutdown", { ok: true })).toEqual({ outcome: "deferred" });
		expect(classifyResponse("abort", { ok: true })).toEqual({ outcome: "ok" });
		expect(classifyResponse("prompt", { ok: true, queued: false })).toEqual({ outcome: "ok" });
	});
});

describe("retention", () => {
	const record = (log: AuditLog, ts: number, i = 0) => log.record(home, ts, input({ op: "model", args: { text: `provider/model-${i}` }, phase: "completed", result: { outcome: "ok" } }));

	test("size rotation keeps exactly one 0600 previous file, bounds both files and loses only the oldest records", async () => {
		await enable();
		configure({ maxBytes: 65536 });
		const log = new AuditLog();
		for (let i = 0; i < 500; i++) await record(log, T0 + i, i);
		expect(log.lastError).toBeUndefined();
		expect(fs.readdirSync(paths().dir).filter(name => name.startsWith("audit.jsonl")).sort()).toEqual(["audit.jsonl", "audit.jsonl.1", "audit.jsonl.lock"]);
		expect(fs.statSync(paths().live).size).toBeLessThanOrEqual(65536);
		expect(fs.statSync(paths().prev).size).toBeLessThanOrEqual(65536);
		expect(mode(paths().prev)).toBe(0o600);
		const all = [...records(paths().prev), ...records()];
		const models = all.map(r => r.params!.selector!);
		expect(models.at(-1)).toBe("provider/model-499");
		// Contiguous newest records survive in order; nothing in the middle is missing or duplicated.
		const first = Number(models[0].split("-")[1]);
		expect(models).toEqual(Array.from({ length: 500 - first }, (_, i) => `provider/model-${first + i}`));
		expect(first).toBeGreaterThan(0);
		expect(all.length).toBeGreaterThan(records().length);
	});

	test("an expired live log is rotated at the next write and its expired records are pruned from the previous file", async () => {
		await enable();
		configure({ maxAgeDays: 30 });
		const log = new AuditLog();
		await record(log, T0, 1); // day 0
		await record(log, T0 + 25 * DAY, 2);
		await record(log, T0 + 40 * DAY, 3); // day 0 record has expired; day 25 has not
		expect(records(paths().prev).map(r => r.params!.selector)).toEqual(["provider/model-2"]);
		expect(records().map(r => r.params!.selector)).toEqual(["provider/model-3"]);
		await record(log, T0 + 90 * DAY, 4); // everything older has expired: nothing is kept in the previous file
		expect(fs.existsSync(paths().prev)).toBe(false);
		expect(records().map(r => r.params!.selector)).toEqual(["provider/model-4"]);
		await record(log, T0 + 100 * DAY, 5);
		expect(records().map(r => r.params!.selector)).toEqual(["provider/model-4", "provider/model-5"]);
	});

	test("a previous file whose last write is older than the cutoff is deleted at the next write", async () => {
		await enable();
		configure({ maxAgeDays: 10 });
		const log = new AuditLog();
		await record(log, T0, 1);
		fs.renameSync(paths().live, paths().prev);
		fs.utimesSync(paths().prev, new Date(T0), new Date(T0));
		await record(log, T0 + 9 * DAY, 2);
		expect(fs.existsSync(paths().prev)).toBe(true);
		await record(log, T0 + 11 * DAY, 3);
		expect(fs.existsSync(paths().prev)).toBe(false);
		expect(records().map(r => r.params!.selector)).toEqual(["provider/model-2", "provider/model-3"]);
	});

	test("defaults, boundaries and invalid values for the limits", async () => {
		const read = () => cmd("status");
		expect(await read()).toContain("limits: maxBytes 1048576, maxAgeDays 30");
		configure({ maxBytes: 65536, maxAgeDays: 1 });
		expect(await read()).toContain("limits: maxBytes 65536, maxAgeDays 1");
		configure({ maxBytes: 67108864, maxAgeDays: 3650 });
		expect(await read()).toContain("limits: maxBytes 67108864, maxAgeDays 3650");
		configure({ maxBytes: 65535, maxAgeDays: 0 });
		let status = await read();
		expect(status).toContain("limits: maxBytes 1048576, maxAgeDays 30");
		expect(status).toContain("config: audit.maxBytes ignored: must be an integer from 65536 to 67108864");
		expect(status).toContain("config: audit.maxAgeDays ignored: must be an integer from 1 to 3650");
		configure({ maxBytes: 67108865, maxAgeDays: 3651 });
		expect(await read()).toContain("limits: maxBytes 1048576, maxAgeDays 30");
		configure({ maxBytes: 70000.5, maxAgeDays: "30" });
		status = await read();
		expect(status).toContain("audit.maxBytes ignored");
		expect(status).toContain("audit.maxAgeDays ignored");
		configure("nope");
		expect(await read()).toContain("config: peers.json audit must be an object");
		fs.writeFileSync(path.join(home, ".omp", "agent", "peers.json"), "{broken");
		expect(await read()).toContain("config: peers.json is not valid JSON");
		expect(fs.existsSync(path.join(home, ".omp", "agent", "peer-state"))).toBe(false);
	});
});

describe("tamper and permission handling", () => {
	const writeAs = async (log: AuditLog) => log.record(home, T0, input());

	test("a symlinked log is refused and its target is untouched", async () => {
		await enable();
		const victim = path.join(home, "victim");
		fs.writeFileSync(victim, "keep\n");
		fs.symlinkSync(victim, paths().live);
		const log = new AuditLog();
		await writeAs(log);
		expect(log.lastError?.message).toBe("audit.jsonl is a symlink; refusing to use it");
		expect(fs.readFileSync(victim, "utf8")).toBe("keep\n");
		expect(await cmd("status")).toContain("records: unknown (audit.jsonl: audit.jsonl is a symlink; refusing to use it)");
		expect(await cmd("tail")).toBe("error: audit.jsonl is a symlink; refusing to use it");
	});

	test("a dangling symlink is not followed to create its target", async () => {
		await enable();
		const target = path.join(home, "created-by-attacker");
		fs.symlinkSync(target, paths().live);
		const log = new AuditLog();
		await writeAs(log);
		expect(log.lastError).toBeDefined();
		expect(fs.existsSync(target)).toBe(false);
	});

	test("a hard-linked log is refused and the other name is untouched", async () => {
		await enable();
		const other = path.join(home, "other");
		fs.writeFileSync(other, "keep\n", { mode: 0o600 });
		fs.linkSync(other, paths().live);
		const log = new AuditLog();
		await writeAs(log);
		expect(log.lastError?.message).toBe("audit.jsonl has several hard links; refusing to use it");
		expect(fs.readFileSync(other, "utf8")).toBe("keep\n");
	});

	test("a log readable by group or others is refused for writing, status and tail", async () => {
		await enable();
		await writeAs(new AuditLog());
		fs.chmodSync(paths().live, 0o644);
		const log = new AuditLog();
		await writeAs(log);
		expect(log.lastError?.message).toBe("audit.jsonl is accessible to group or others; chmod 600 it or delete it");
		expect(lines()).toHaveLength(1);
		expect(await cmd("tail")).toContain("accessible to group or others");
		expect(await cmd("status")).toContain("records: unknown");
		fs.chmodSync(paths().live, 0o600);
		await writeAs(log);
		expect(log.lastError).toBeUndefined();
		expect(lines()).toHaveLength(2);
	});

	test("a non-regular file in place of the log is refused", async () => {
		await enable();
		fs.mkdirSync(paths().live);
		const log = new AuditLog();
		await writeAs(log);
		expect(log.lastError).toBeDefined();
	});

	test("a symlinked state directory is refused", async () => {
		fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
		const real = path.join(home, "elsewhere");
		fs.mkdirSync(real);
		fs.symlinkSync(real, paths().dir);
		expect(await cmd("on")).toBe("error: peer-state is not a private directory; refusing to use it");
		expect(fs.readdirSync(real)).toEqual([]);
	});

	test("a symlinked previous log is reported as a problem, never read", async () => {
		await enable();
		await writeAs(new AuditLog());
		const victim = path.join(home, "victim");
		fs.writeFileSync(victim, "keep\n");
		fs.symlinkSync(victim, paths().prev);
		expect(await cmd("status")).toContain("audit.jsonl.1: audit.jsonl.1 is a symlink; refusing to use it");
		expect(await cmd("tail")).toContain("audit.jsonl.1 is a symlink");
	});

	test("writer failures never break the caller: warn once, stay in status, clear on the next success", async () => {
		await enable();
		fs.mkdirSync(paths().live);
		const log = new AuditLog();
		const warnings: string[] = [];
		for (let i = 0; i < 3; i++) await expect(log.record(home, T0 + i, input(), text => warnings.push(text))).resolves.toBeUndefined();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("control not recorded");
		expect(warnings[0]).not.toContain(home);
		const status = await cmd("status", log);
		expect(status).toContain("last write error (this session): ");
		expect(status).not.toContain("last write error (this session): none");
		expect(status).not.toContain(home);
		fs.rmSync(paths().live, { recursive: true });
		await log.record(home, T0 + 9, input(), text => warnings.push(text));
		expect(log.lastError).toBeUndefined();
		expect(await cmd("status", log)).toContain("last write error (this session): none");
		expect(records()).toHaveLength(1);
	});

	test("a throwing warn callback and an unreadable enable flag do not break the caller either", async () => {
		await enable();
		fs.mkdirSync(paths().live);
		const log = new AuditLog();
		await expect(log.record(home, T0, input(), () => { throw new Error("ui gone"); })).resolves.toBeUndefined();
		fs.rmSync(paths().live, { recursive: true });
		fs.writeFileSync(auditConfigFile(home), "{broken", { mode: 0o600 });
		const other = new AuditLog();
		await expect(other.record(home, T0, input())).resolves.toBeUndefined();
		expect(other.lastError?.message).toBe("audit-config.json is not valid JSON; fix or remove it");
		expect(fs.existsSync(paths().live)).toBe(false);
		expect(await cmd("status")).toContain("audit: off (unknown: audit-config.json is not valid JSON; fix or remove it)");
	});
});

describe("concurrency", () => {
	test("child processes appending at once leave only complete, valid, unique lines", async () => {
		await enable();
		const script = path.join(import.meta.dir, "audit_child.ts");
		const tags = ["alpha", "bravo", "charlie", "delta"];
		const children = tags.map(tag => Bun.spawn(["bun", script, home, tag, "40"], { stdout: "pipe", stderr: "pipe" }));
		const results = await Promise.all(children.map(async child => ({ code: await child.exited, err: await new Response(child.stderr).text() })));
		expect(results.map(r => r.err.trim())).toEqual(["", "", "", ""]);
		expect(results.map(r => r.code)).toEqual([0, 0, 0, 0]);
		const raw = fs.readFileSync(paths().live, "utf8");
		expect(raw.endsWith("\n")).toBe(true);
		const all = records();
		expect(all).toHaveLength(160);
		expect(new Set(all.map(r => r.event)).size).toBe(160);
		for (const tag of tags) expect(all.filter(r => r.actorClaimName === tag).map(r => r.targetName).sort()).toEqual(Array.from({ length: 40 }, (_, i) => `worker-${i}`).sort());
	}, 60_000);

	test("concurrent appenders crossing the size cap rotate safely: no torn lines, no duplicates", async () => {
		await enable();
		configure({ maxBytes: 65536 });
		const script = path.join(import.meta.dir, "audit_child.ts");
		const children = [0, 1, 2].map(i => Bun.spawn(["bun", script, home, `c${i}`, "150"], { stdout: "pipe", stderr: "pipe" }));
		const results = await Promise.all(children.map(async child => ({ code: await child.exited, err: await new Response(child.stderr).text() })));
		expect(results.map(r => r.err.trim())).toEqual(["", "", ""]);
		const all = [...records(paths().prev), ...records()];
		expect(new Set(all.map(r => r.event)).size).toBe(all.length);
		expect(all.length).toBeGreaterThan(100);
		for (const file of [paths().live, paths().prev]) expect(fs.statSync(file).size).toBeLessThanOrEqual(65536);
	}, 60_000);
});

describe("inspection and deletion", () => {
	const seed = async (n: number) => {
		await enable();
		const log = new AuditLog();
		for (let i = 0; i < n; i++) await log.record(home, T0 + i * 1000, input({ op: "rename", args: { text: `name-${i}` }, target: { id: WORKER, name: `worker-${i}` } }));
	};

	test("status reports enabled state, size, record count, oldest, newest and write errors", async () => {
		await seed(3);
		const size = fs.statSync(paths().live).size;
		expect(await cmd("status")).toBe([
			"audit: on (/peers audit off stops recording)",
			`files: ~/.omp/agent/peer-state/audit.jsonl ${size} bytes; previous absent`,
			"records: 3",
			`oldest: ${new Date(T0).toISOString()}`,
			`newest: ${new Date(T0 + 2000).toISOString()}`,
			"limits: maxBytes 1048576, maxAgeDays 30 (~/.omp/agent/peers.json \"audit\"); at most one previous file is kept",
			"last write error (this session): none",
		].join("\n"));
		expect(await cmd("status now")).toContain("usage:");
	});

	test("status counts unreadable lines; tail skips them and never prints tampered text", async () => {
		await seed(2);
		fs.appendFileSync(paths().live, `{"v":1,"actorClaimName":"\u001b[2Jevil"}\ntorn-line`);
		const status = await cmd("status");
		expect(status).toContain("records: 2 (2 unreadable line(s) skipped)");
		const tail = await cmd("tail");
		expect(tail).not.toContain("evil");
		expect(tail).not.toContain("\u001b");
		expect(tail.split("\n")).toHaveLength(3);
	});

	test("tail shows the newest n oldest-first with redacted rendering and the claims caveat", async () => {
		await seed(12);
		await new AuditLog().record(home, T0 + 99_000, input({ op: "prompt", args: { text: "SECRET BODY", tier: "light" }, phase: "completed", masterChecked: false, actor: { id: "p00000000000000bb" }, result: { outcome: "refused", reason: "not-master" } }));
		const out = (await cmd("tail 3")).split("\n");
		expect(out[0]).toBe("last 3 of 13 record(s), oldest first (actors are sender claims, not authenticated):");
		expect(out).toHaveLength(4);
		expect(out[1]).toMatch(/ receiver attempted req=[0-9a-f]{32} claimed-actor=p00000000000000aa "master" target=p00000000000000a1 "worker-10" rename textLength=7$/);
		const last = out[3];
		expect(last).toBe(`${new Date(T0 + 99_000).toISOString()} receiver completed req=${last.match(/req=([0-9a-f]{32})/)![1]} claimed-actor=p00000000000000bb target=p00000000000000a1 "worker-a" prompt textLength=11 tier=light master-claim-mismatch => refused (not-master)`);
		expect(out.join("\n")).not.toContain("SECRET");
		expect((await cmd("tail")).split("\n")).toHaveLength(11);
	});

	test("tail limits: default 10, at most 50, and rejects other arguments", async () => {
		await seed(60);
		expect((await cmd("tail 50")).split("\n")).toHaveLength(51);
		expect(await cmd("tail 51")).toBe("error: tail shows at most 50 records");
		for (const bad of ["0", "-1", "abc", "5x", "1.5", "3 4"]) expect(await cmd(`tail ${bad}`)).toContain("usage:");
	});

	test("tail and status on an empty or missing log are read-only and create nothing", async () => {
		expect(await cmd("tail")).toBe("no audit records");
		expect(fs.existsSync(path.join(home, ".omp"))).toBe(false);
		await enable();
		expect(await cmd("tail")).toBe("no audit records");
		expect(fs.existsSync(paths().live)).toBe(false);
	});

	test("clear needs the literal --yes; then deletes both files and only those", async () => {
		await seed(3);
		fs.writeFileSync(paths().prev, fs.readFileSync(paths().live), { mode: 0o600 });
		for (const args of ["clear", "clear yes", "clear -y", "clear --yes now", "clear --YES"]) expect(await cmd(args)).toContain("--yes");
		expect(fs.existsSync(paths().live) && fs.existsSync(paths().prev)).toBe(true);
		expect(await cmd("clear --yes")).toBe("audit log cleared: removed 2 file(s)");
		expect(fs.existsSync(paths().live) || fs.existsSync(paths().prev)).toBe(false);
		expect(fs.existsSync(auditConfigFile(home))).toBe(true);
		expect(await cmd("status")).toContain("records: 0");
		expect(await cmd("clear --yes")).toBe("audit log: nothing to clear");
	});

	test("clear with no state directory creates nothing; clearing a symlinked log removes the link, not the target", async () => {
		expect(await cmd("clear --yes")).toBe("audit log: nothing to clear");
		expect(fs.existsSync(path.join(home, ".omp"))).toBe(false);
		await enable();
		const victim = path.join(home, "victim");
		fs.writeFileSync(victim, "keep\n");
		fs.symlinkSync(victim, paths().live);
		expect(await cmd("clear --yes")).toBe("audit log cleared: removed 1 file(s)");
		expect(fs.readFileSync(victim, "utf8")).toBe("keep\n");
	});

	test("unknown subcommands print usage", async () => {
		expect(await cmd("frobnicate")).toBe("usage: /peers audit [status] | on | off | tail [n (1-50, default 10)] | clear --yes");
	});
});
