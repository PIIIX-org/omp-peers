// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FEATURES } from "../../lib/features";
import {
	AUTH_STOPPED, BACKOFF_MS, BREAKER_FAILURES, BREAKER_PAUSE_MS, buildPayload, cleanText, credential, discord, discordFile, formatReport, HELP_REPLY, MAX_ATTEMPTS, MAX_COMMAND_AGE_MS, MAX_FUTURE_SKEW_MS, MAX_INBOUND_BYTES, MAX_LOG,
	MAX_NAME_BYTES, MAX_QUEUE, MAX_SUMMARY_BYTES, MAX_WAIT_MS, parseCommand, POLL_INTERVAL_MS, readDiscord, redactedWebhook, setTestEndpoint, setTestSeam, TEST_MESSAGE, UNKNOWN_REPLY, USER_COMMANDS, WEBHOOK_RE,
	type DiscordState,
} from "../../lib/features/discord";
import type { FeatureHost, PeerView } from "../../lib/features/host";
import { isInside, readSecretFile } from "../../lib/features/secretfile";
import type { Report } from "../../lib/reports";

const MASTER = "p00000000000000aa";
const WORKER = "p00000000000000a1";
const CHANNEL = "111111111111111111";
const USER = "222222222222222222";
const OTHER = "333333333333333333";
const WEBHOOK_ID = "987654321098765432";
// Fake credentials assembled at run time; none is a real token.
const WEBHOOK_TOKEN = `${"wh".repeat(8)}-TESTONLY-${"x".repeat(20)}`;
const WEBHOOK_URL = `https://discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`;
const BOT_TOKEN = ["MTIzNDU2Nzg5MDEyMzQ1Njc4", "Gx0abc", "fake".repeat(8)].join(".");
const DISCORD_EPOCH = 1_420_070_400_000;
const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-17T12:00:00Z");
const REPO = path.resolve(import.meta.dir, "..", "..");
const VERSION = (JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")) as { version: string }).version;

let home: string;
let clock: number;
let notes: string[];
let hostCalls: string[];
let peerList: PeerView[];
let counter = 0;

beforeEach(() => {
	home = fs.mkdtempSync(path.join("/tmp", "opd-"));
	fs.mkdirSync(path.join(home, "secrets"), { mode: 0o700 });
	clock = T0;
	notes = [];
	hostCalls = [];
	peerList = [{ id: MASTER, name: "master", busy: false, paused: false }, { id: WORKER, name: "worker-a", busy: true, paused: true }];
	fake.reset();
});
afterEach(() => {
	setTestSeam();
	setTestEndpoint(undefined);
	fs.rmSync(home, { recursive: true, force: true });
});

/** A fake host: every member a Discord command could abuse records its name in `hostCalls`. */
function host(master = true): FeatureHost {
	const spy = <T>(name: string, value: T): T => {
		hostCalls.push(name);
		return value;
	};
	return {
		home,
		now: () => clock,
		self: () => spy("self", { id: MASTER, name: "master" }),
		isMaster: () => master,
		notify: text => void notes.push(text),
		usageNow: () => spy("usageNow", undefined),
		acceptsRemote: () => spy("acceptsRemote", true),
		peers: async () => spy("peers", peerList),
		groupsOf: () => spy("groupsOf", []),
		resolveGroup: async () => spy("resolveGroup", { recipients: [], skipped: [] }),
		resolveModel: async () => spy("resolveModel", { ok: false as const, error: "not exercised" }),
		applyModel: async () => spy("applyModel", { ok: false as const, error: "not exercised" }),
		send: async () => spy("send", { status: "offline" as const }),
	};
}
const run = (line: string, h = host()) => discord.command(line.split(/\s+/).filter(Boolean), h);
const tick = (h = host()) => discord.tick!(h);
const stored = (): DiscordState => JSON.parse(fs.readFileSync(discordFile(home), "utf8"));

function secret(name: string, content: string, mode = 0o600): string {
	const file = path.join(home, "secrets", name);
	fs.writeFileSync(file, content, { mode });
	fs.chmodSync(file, mode);
	return file;
}
const webhookFile = () => secret("webhook", `${WEBHOOK_URL}\n`);
const botFile = () => secret("bot", `${BOT_TOKEN}\n`);

async function enableWebhook(...extra: string[]) {
	expect(await run(`set webhook-file ${webhookFile()}`)).toBe("set webhook-file");
	for (const line of extra) expect(await run(line)).toStartWith("set ");
	expect(await run("on")).toStartWith("discord bridge on (webhook)");
}
async function enableBot(...extra: string[]) {
	expect(await run(`set bot-token-file ${botFile()}`)).toBe("set bot-token-file");
	expect(await run(`set channel ${CHANNEL}`)).toBe("set channel");
	for (const line of extra) expect(await run(line)).toStartWith("set ");
	expect(await run("on")).toStartWith("discord bridge on (bot)");
}
async function enableInbound(users = [USER]) {
	await enableBot(`set inbound-users ${users.join(" ")}`, "set inbound on");
}

const done = (unit = "Parser rewrite", description = "Offline checks passed", references?: string[]): Report => ({ kind: "DONE", unit, evidence: { description, ...(references ? { references } : {}) } });
const accept = (report: Report = done(), from = { id: WORKER, name: "worker-a" }, h = host()) => discord.onReport!(report, from, h);

// ---- Fake Discord over a seam fetch ------------------------------------------------------------

interface Recorded {
	method: string;
	url: string;
	headers: Record<string, string>;
	body?: string;
	redirect?: string;
}
interface FakeMessage {
	id: string;
	content: string;
	author: { id: string; bot?: boolean };
	webhook_id?: string;
}
const snow = (ms: number, seq = 0) => ((BigInt(ms - DISCORD_EPOCH) << 22n) | BigInt(seq)).toString();

const fake = {
	requests: [] as Recorded[],
	messages: [] as FakeMessage[],
	post: undefined as ((n: number, req: Recorded) => Response | Promise<Response>) | undefined,
	get: undefined as ((req: Recorded) => Response) | undefined,
	reset() {
		this.requests = [];
		this.messages = [];
		this.post = undefined;
		this.get = undefined;
		setTestSeam({
			fetch: async (url, init) => {
				const req: Recorded = { method: String(init.method), url, headers: init.headers as Record<string, string>, body: init.body as string | undefined, redirect: init.redirect };
				this.requests.push(req);
				if (req.method === "POST") {
					const posts = this.requests.filter(r => r.method === "POST").length;
					return this.post ? this.post(posts, req) : new Response(JSON.stringify({ id: "1" }), { status: 200 });
				}
				if (this.get) return this.get(req);
				const query = new URL(url).searchParams;
				const after = query.get("after");
				const limit = Number(query.get("limit"));
				const sorted = [...this.messages].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
				const pick = after === null ? sorted.slice(-limit) : sorted.filter(m => BigInt(m.id) > BigInt(after)).slice(0, limit);
				return new Response(JSON.stringify(pick.reverse()), { status: 200 });
			},
		});
	},
	posts: () => fake.requests.filter(r => r.method === "POST"),
	gets: () => fake.requests.filter(r => r.method === "GET"),
	/** The `content` of every POST, in order. */
	contents: () => fake.posts().map(r => (JSON.parse(r.body!) as { content: string }).content),
	say(content: string, author = USER, at = clock, extra: Partial<FakeMessage> = {}): FakeMessage {
		const message = { id: snow(at, counter++), content, author: { id: author }, ...extra };
		this.messages.push(message);
		return message;
	},
};

// ---- Secret files ------------------------------------------------------------------------------

describe("secret files", () => {
	test("a 0600 owned regular file is read and one trailing newline is stripped", () => {
		const text = "a".repeat(40);
		expect(readSecretFile(secret("s", text))).toBe(text);
		expect(readSecretFile(secret("s", `${text}\n`))).toBe(text);
		expect(readSecretFile(secret("s", `${text}\r\n`))).toBe(text);
		expect(readSecretFile(secret("s", `${text}\n\n`))).toBe(`${text}\n`);
		expect(readSecretFile(secret("s", text, 0o400))).toBe(text);
	});

	test("group or other access of any kind is refused", () => {
		for (const mode of [0o644, 0o640, 0o604, 0o660, 0o666, 0o601, 0o610]) expect(() => readSecretFile(secret("s", "a".repeat(40), mode))).toThrow("must not be accessible to group or others");
	});

	test("size bounds apply after one newline is stripped", () => {
		for (const [length, ok] of [[15, false], [16, true], [256, true], [257, false]] as const) {
			const file = secret("s", `${"a".repeat(length)}\n`);
			if (ok) expect(readSecretFile(file)).toHaveLength(length);
			else expect(() => readSecretFile(file)).toThrow(/must hold 16 to 256 bytes|larger than 256/);
		}
		expect(() => readSecretFile(secret("s", "a".repeat(5000)))).toThrow("larger than 256 bytes");
		expect(() => readSecretFile(secret("s", ""))).toThrow("must hold 16 to 256 bytes");
		// Bytes, not characters: 8 two-byte characters are 16 bytes, 7 are 14.
		expect(readSecretFile(secret("s", "é".repeat(8)))).toBe("é".repeat(8));
		expect(() => readSecretFile(secret("s", "é".repeat(7)))).toThrow("must hold 16 to 256 bytes");
	});

	test("a symlink, a directory, a missing file, a relative path and a path inside the plugin are refused", () => {
		const real = secret("real", "a".repeat(40));
		const link = path.join(home, "secrets", "link");
		fs.symlinkSync(real, link);
		expect(() => readSecretFile(link)).toThrow("is a symlink");
		expect(() => readSecretFile(path.join(home, "secrets"))).toThrow("not a regular file");
		expect(() => readSecretFile(path.join(home, "secrets", "missing"))).toThrow("does not exist");
		expect(() => readSecretFile("secrets/real")).toThrow("must be absolute");
		expect(() => readSecretFile(path.join(REPO, "token.txt"))).toThrow("outside the plugin directory");
		expect(() => readSecretFile(path.join(REPO, "lib", "..", "token.txt"))).toThrow("outside the plugin directory");
		expect(isInside(path.join(REPO, "a"), REPO)).toBe(true);
		expect(isInside(`${REPO}-sibling/a`, REPO)).toBe(false);
	});

	test("a FIFO fails fast instead of hanging", () => {
		const fifo = path.join(home, "secrets", "fifo");
		const made = Bun.spawnSync(["mkfifo", fifo]);
		expect(made.exitCode).toBe(0);
		const started = Date.now();
		expect(() => readSecretFile(fifo)).toThrow("not a regular file");
		expect(Date.now() - started).toBeLessThan(2000);
	});

	test("a file owned by another user is refused", () => {
		const real = process.getuid!;
		const file = secret("s", "a".repeat(40));
		process.getuid = () => real.call(process) + 1;
		try {
			expect(() => readSecretFile(file)).toThrow("not owned by the current user");
		} finally {
			process.getuid = real;
		}
	});

	test("an error never contains the content", () => {
		const text = `${"q".repeat(300)}`;
		try {
			readSecretFile(secret("s", text));
		} catch (error) {
			expect((error as Error).message).not.toContain("qqqq");
		}
	});
});

// ---- Webhook URL and credentials ----------------------------------------------------------------

describe("credentials", () => {
	test("only the exact Discord webhook shape is accepted", () => {
		const ok = [WEBHOOK_URL, `https://discordapp.com/api/webhooks/12345/${"A".repeat(20)}`, `https://discord.com/api/webhooks/${"9".repeat(25)}/${"b_-".repeat(40)}`];
		for (const url of ok) expect(WEBHOOK_RE.test(url)).toBe(true);
		const rejected = [
			WEBHOOK_URL.replace("https", "http"),
			`https://discord.com.evil.example/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`,
			`https://evil.example/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`,
			`https://ptb.discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`,
			`https://canary.discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`,
			`https://discord.gg/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`,
			`https://DISCORD.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`,
			`https://user${"@"}discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`,
			`https://user:pw${"@"}discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`,
			`https://discord.com:443/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`,
			`https://discord.com:8080/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`,
			`${WEBHOOK_URL}?wait=true`,
			`${WEBHOOK_URL}?thread_id=1`,
			`${WEBHOOK_URL}#frag`,
			`${WEBHOOK_URL}/`,
			`${WEBHOOK_URL}/github`,
			`https://discord.com/api/webhooks/${WEBHOOK_ID}/../../${WEBHOOK_TOKEN}`,
			`https://discord.com/api/webhooks/${WEBHOOK_ID}/%2e%2e/${WEBHOOK_TOKEN}`,
			`https://discord.com/api/v10/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`,
			`https://discord.com//api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`,
			`https://discord.com/api/webhooks/1234/${WEBHOOK_TOKEN}`,
			`https://discord.com/api/webhooks/${"1".repeat(26)}/${WEBHOOK_TOKEN}`,
			`https://discord.com/api/webhooks/${WEBHOOK_ID}/${"a".repeat(19)}`,
			`https://discord.com/api/webhooks/${WEBHOOK_ID}/${"a".repeat(121)}`,
			`https://discord.com/api/webhooks/${WEBHOOK_ID}/${"a".repeat(19)}!`,
			`https://discord.com/api/webhooks/abc/${WEBHOOK_TOKEN}`,
			` ${WEBHOOK_URL}`,
			`${WEBHOOK_URL} `,
			`${WEBHOOK_URL}\nhttps://evil.example/`,
			`${WEBHOOK_URL}\r`,
			"",
		];
		for (const url of rejected) expect(WEBHOOK_RE.test(url)).toBe(false);
	});

	test("a webhook file with a wrong shape is refused without echoing its content", () => {
		const file = secret("w", `https://evil.example/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`);
		try {
			credential({ webhookFile: file, includeNames: false, rateLimit: 30, inbound: false, inboundUsers: [] });
			throw new Error("accepted");
		} catch (error) {
			expect((error as Error).message).toContain("does not hold a Discord webhook URL");
			expect((error as Error).message).not.toContain(WEBHOOK_TOKEN);
			expect((error as Error).message).not.toContain("evil.example");
		}
	});

	test("a bot token file holds one printable token without spaces", () => {
		const config = { botTokenFile: secret("b", `${"a b".repeat(10)}`), channel: CHANNEL, includeNames: false, rateLimit: 30, inbound: false, inboundUsers: [] };
		expect(() => credential(config)).toThrow("printable characters without spaces");
		expect(credential({ ...config, botTokenFile: botFile() })).toEqual({ mode: "bot", token: BOT_TOKEN, channel: CHANNEL });
	});

	test("the shown webhook form hides the token", () => {
		expect(redactedWebhook(WEBHOOK_ID)).toBe(`…/webhooks/${WEBHOOK_ID}/<redacted>`);
	});
});

// ---- Text ------------------------------------------------------------------------------------

describe("outbound text", () => {
	const Z = "\u200b";
	test("mentions are neutralised", () => {
		expect(cleanText("@everyone and @here", 300)).toBe(`@${Z}everyone and @${Z}here`);
		expect(cleanText("<@123456789012345678>", 300)).toBe(`<${Z}@${Z}123456789012345678\\>`);
		expect(cleanText("<@!123456789012345678> <@&123456789012345678> <#123456789012345678>", 300)).not.toMatch(/<[@#]/);
		expect(cleanText("<t:1700000000:R> </cmd:1234> <:emoji:12345>", 300)).not.toMatch(/<[t/:]/);
		for (const text of ["@everyone", "<@1>", "<@&1>", "<#1>", "<@!1>"]) expect(cleanText(text, 300)).not.toMatch(/@(?!\u200b)|<(?!\u200b)/);
	});

	test("markdown is escaped", () => {
		expect(cleanText("*bold* _it_ ~s~ `c` |sp| > q [a]", 300)).toBe("\\*bold\\* \\_it\\_ \\~s\\~ \\`c\\` \\|sp\\| \\> q \\[a\\]");
		expect(cleanText("back\\slash", 300)).toBe("back\\\\slash");
	});

	test("links, absolute paths and drive paths are removed; relative paths stay", () => {
		expect(cleanText("see https://example.com/a?b=c now", 300)).toBe("see (link removed) now");
		expect(cleanText("see HTTP://EXAMPLE.COM and ftp://h/x and www.example.com/a", 300)).toBe("see (link removed) and (link removed) and (link removed)");
		expect(cleanText("invite discord.gg/abcdef", 300)).toBe("invite (link removed)");
		expect(cleanText("edit /etc/passwd and ~/notes.txt (/var/log/x) ok", 300)).toBe("edit (path removed) and (path removed) ((path removed)) ok");
		expect(cleanText("file=/srv/app/main.ts, then C:\\work\\app and \\\\host\\share", 300)).toBe("file=(path removed), then (path removed) and (path removed)");
		expect(cleanText("read/write and src/app.ts stay", 300)).toBe("read/write and src/app.ts stay");
	});

	test("credential-looking text is withheld, including Discord token and webhook shapes", () => {
		const prefix = ["sk", "ant"].join("-");
		for (const text of [`key ${prefix}-${"a".repeat(30)}`, `${["pass", "word"].join("")}: hunter2hunter2hunter2`, `${BOT_TOKEN} leaked`, `post to ${WEBHOOK_URL}`, `proxy://user:pw${"@"}host/`, `Bearer ${"a".repeat(30)}`]) expect(cleanText(text, 300)).toBe("(withheld)");
		expect(cleanText("token handling is documented", 300)).toBe("token handling is documented");
	});

	test("control characters, ANSI sequences and newlines become one clean line", () => {
		expect(cleanText("a\x1b[31mred\x1b[0m\x07b\r\nc\td\u200be\u202ef", 300)).toBe("ared b c d e f");
		expect(cleanText("\x1b]0;title\x07after", 300)).toBe("after");
		expect(cleanText(" \n\t ", 300)).toBe("(empty)");
	});

	test("the cap applies to the final bytes: exact at the boundary, cut with an ellipsis one byte over", () => {
		expect(Buffer.byteLength(cleanText("a".repeat(300), 300))).toBe(300);
		expect(cleanText("a".repeat(300), 300)).toBe("a".repeat(300));
		const over = cleanText("a".repeat(301), 300);
		expect(over).toBe(`${"a".repeat(297)}…`);
		expect(Buffer.byteLength(over)).toBe(300);
		// Multi-byte: 100 three-byte characters are exactly 300 bytes; 101 are cut at a character boundary.
		expect(cleanText("€".repeat(100), 300)).toBe("€".repeat(100));
		const euros = cleanText("€".repeat(101), 300);
		expect(euros).toBe(`${"€".repeat(99)}…`);
		expect(Buffer.byteLength(euros)).toBe(300);
		// Escapes count: 150 stars are 300 bytes escaped; 151 are cut without splitting an escape pair.
		expect(Buffer.byteLength(cleanText("*".repeat(150), 300))).toBe(300);
		const stars = cleanText("*".repeat(151), 300);
		expect(Buffer.byteLength(stars)).toBeLessThanOrEqual(300);
		expect(stars.endsWith("…")).toBe(true);
		expect(stars.slice(0, -1)).toMatch(/^(\\\*)+$/);
		// A mention's zero-width space is never separated from its @.
		const at = cleanText("@".repeat(200), 300);
		expect(Buffer.byteLength(at)).toBeLessThanOrEqual(300);
		expect(at.slice(0, -1)).toMatch(/^(@\u200b)+$/);
	});

	test("a report becomes the fixed template, ids only by default", () => {
		expect(formatReport(done(), { id: WORKER, name: "worker-a" }, false)).toBe(`**DONE** ${WORKER}: Parser rewrite: Offline checks passed`);
		expect(formatReport(done(), { id: WORKER, name: "worker-a" }, true)).toBe(`**DONE** worker-a (${WORKER}): Parser rewrite: Offline checks passed`);
		const blocked: Report = { kind: "BLOCKED", unit: "Deploy", blocker: "Needs a key", nextAction: "Ask the owner" };
		const waiting: Report = { kind: "WAITING", unit: "Tests", background: "pending", nextAction: "Wait for CI" };
		const decision: Report = { kind: "DECISION", unit: "Plan", question: "Which option" };
		expect(formatReport(blocked, { id: WORKER, name: "w" }, false)).toBe(`**BLOCKED** ${WORKER}: Deploy: Needs a key`);
		expect(formatReport(waiting, { id: WORKER, name: "w" }, false)).toBe(`**WAITING** ${WORKER}: Tests: Wait for CI`);
		expect(formatReport(decision, { id: WORKER, name: "w" }, false)).toBe(`**DECISION** ${WORKER}: Plan: Which option`);
	});

	test("references, paths and the sender's claimed name stay out unless names are on; a forged id is shown as ?", () => {
		const text = formatReport(done("Unit", "ok", [`/${["Users", "alice"].join("/")}/project/secret.txt`]), { id: "p1\nINJECT @everyone", name: "x" }, false);
		expect(text).toBe("**DONE** ?: Unit: ok");
		const named = formatReport(done(), { id: WORKER, name: `n\u200b@everyone ${"z".repeat(100)}` }, true);
		const name = `n @${Z}everyone ${"z".repeat(MAX_NAME_BYTES - 3 - 15)}…`;
		expect(Buffer.byteLength(name)).toBe(MAX_NAME_BYTES);
		expect(named).toBe(`**DONE** ${name} (${WORKER}): Parser rewrite: Offline checks passed`);
	});

	test("the summary is capped at 300 bytes whatever the fields hold", () => {
		const text = formatReport(done("u".repeat(100), "d".repeat(500)), { id: WORKER, name: "w" }, false);
		expect(Buffer.byteLength(text.slice(`**DONE** ${WORKER}: `.length))).toBe(MAX_SUMMARY_BYTES);
		expect(text.endsWith("…")).toBe(true);
	});

	test("every payload carries an empty allowed_mentions and only content", () => {
		for (const text of ["x", "@everyone", TEST_MESSAGE]) {
			const body = JSON.parse(buildPayload(text)) as Record<string, unknown>;
			expect(Object.keys(body).sort()).toEqual(["allowed_mentions", "content"]);
			expect(body.allowed_mentions).toEqual({ parse: [] });
		}
	});
});

// ---- Off by default ---------------------------------------------------------------------------

describe("off by default", () => {
	test("registered, off, and nothing is written or sent while off", async () => {
		expect(FEATURES.map(f => f.name)).toContain("discord");
		const status = await run("status");
		expect(status).toStartWith("discord bridge: off (opt-in; /peers discord on enables it)");
		expect(status).toContain("mode: not configured");
		expect(await run("")).toBe(status);
		expect(await run("log")).toBe("discord log: empty");
		await accept();
		await tick();
		expect(await run("off")).toBe("discord bridge is already off");
		expect(await run("clear-queue")).toBe("queue is empty");
		expect(fake.requests).toHaveLength(0);
		expect(fs.existsSync(path.join(home, ".omp"))).toBe(false);
		expect(hostCalls).toEqual([]);
	});

	test("on needs a complete configuration and a good credential", async () => {
		expect(await run("on")).toBe("error: not configured: set webhook-file <path>, or set bot-token-file <path> and set channel <id>");
		expect(await run(`set bot-token-file ${botFile()}`)).toBe("set bot-token-file");
		expect(await run("on")).toStartWith("error: not configured");
		await run(`set channel ${CHANNEL}`);
		fs.chmodSync(path.join(home, "secrets", "bot"), 0o644);
		expect(await run("on")).toContain("error: cannot turn on: secret file");
		expect(readDiscord(host()).enabled).toBe(false);
	});

	test("usage errors and extra words are refused", async () => {
		for (const line of ["status x", "log x", "off x", "on x", "test x", "clear-queue x", "bogus", "set", "set nope 1"]) expect(await run(line)).toMatch(/^(usage|error): /);
		expect(fs.existsSync(discordFile(home))).toBe(false);
	});
});


// ---- Configuration ----------------------------------------------------------------------------

describe("configuration", () => {
	test("master-only commands are refused elsewhere; status, log and off work in any session", async () => {
		const other = host(false);
		for (const line of ["on", "test", "clear-queue", `set channel ${CHANNEL}`]) expect(await run(line, other)).toBe("error: only the master session may change or run the Discord bridge; run /peers master first");
		expect(await run("status", other)).toContain("this session is not the master");
		expect(await run("log", other)).toBe("discord log: empty");
		await enableWebhook();
		expect(await run("off", other)).toContain("discord bridge off");
		expect(readDiscord(host()).enabled).toBe(false);
	});

	test("values are validated", async () => {
		expect(await run("set webhook-file relative/path")).toBe("error: the path must be absolute, without spaces");
		expect(await run(`set webhook-file ${path.join(home, "secrets", "missing")}`)).toContain("does not exist");
		expect(await run(`set webhook-file ${webhookFile()} extra`)).toStartWith("error: usage");
		expect(await run("set channel 1234")).toBe("error: a channel id is 5 to 25 digits");
		expect(await run("set channel 12ab5")).toBe("error: a channel id is 5 to 25 digits");
		expect(await run(`set channel ${"1".repeat(26)}`)).toBe("error: a channel id is 5 to 25 digits");
		for (const value of ["0", "121", "-1", "abc", "1.5", "", "1e1", "0x10"]) expect(await run(`set rate-limit ${value}`)).toStartWith("error: rate-limit must be a whole number from 1 to 120");
		expect(await run("set rate-limit 1")).toBe("set rate-limit");
		expect(await run("set rate-limit 120")).toBe("set rate-limit");
		expect(await run("set include-names maybe")).toStartWith("error: usage");
		const eight = Array.from({ length: 8 }, (_, i) => `${100000 + i}`);
		expect(await run(`set inbound-users ${eight.join(" ")}`)).toBe("set inbound-users");
		expect(await run(`set inbound-users ${[...eight, "100008"].join(" ")}`)).toBe("error: at most 8 user ids");
		expect(await run("set inbound-users 1234")).toStartWith("error: user ids are 5 to 25 digits");
		expect(await run(`set inbound-users ${eight[0]} ${eight[0]}`)).toStartWith("error: user ids are 5 to 25 digits");
		expect(await run("set inbound-users")).toStartWith("error: usage");
		expect(await run("set inbound-users none")).toBe("set inbound-users");
		expect(readDiscord(host()).config.inboundUsers).toEqual([]);
	});

	test("webhook and bot settings are alternatives; inbound needs the bot", async () => {
		await run(`set webhook-file ${webhookFile()}`);
		expect(await run(`set channel ${CHANNEL}`)).toContain("clear it first");
		expect(await run(`set bot-token-file ${botFile()}`)).toContain("clear it first");
		expect(await run("set inbound on")).toContain("inbound needs bot mode");
		expect(await run("set webhook-file none")).toBe("set webhook-file");
		await enableBot("set inbound-users 222222", "set inbound on");
		expect(await run(`set webhook-file ${webhookFile()}`)).toContain("clear it first");
		expect(await run("off")).toContain("off");
		expect(await run("set channel none")).toBe("set channel");
		expect(readDiscord(host()).config.inbound).toBe(false);
	});

	test("a credential cannot be removed while the bridge is on", async () => {
		await enableWebhook();
		expect(await run("set webhook-file none")).toBe("error: the bridge is on; run /peers discord off before removing its credential");
		expect(readDiscord(host()).config.webhookFile).toBeDefined();
	});

	test("status shows paths and the redacted webhook, never a secret; state holds paths only", async () => {
		await enableWebhook();
		const status = await run("status");
		expect(status).toContain(`credential: readable (…/webhooks/${WEBHOOK_ID}/<redacted>)`);
		await run("off");
		await run("set webhook-file none");
		await enableBot("set inbound-users 222222");
		const bot = await run("status");
		expect(bot).toContain("bot token not shown");
		for (const text of [status, bot, fs.readFileSync(discordFile(home), "utf8")]) {
			expect(text).not.toContain(WEBHOOK_TOKEN);
			expect(text).not.toContain(BOT_TOKEN);
		}
	});

	test("state is private and a corrupt or inconsistent file is refused, not overwritten", async () => {
		await enableWebhook();
		expect(fs.statSync(discordFile(home)).mode & 0o777).toBe(0o600);
		expect(fs.statSync(path.dirname(discordFile(home))).mode & 0o777).toBe(0o700);
		const good = fs.readFileSync(discordFile(home), "utf8");
		for (const mutate of [
			(s: DiscordState) => void (s.config.inbound = true),
			(s: DiscordState) => void delete s.config.webhookFile,
			(s: DiscordState) => void (s.queue = Array.from({ length: MAX_QUEUE + 1 }, (_, i) => ({ id: i + 1, kind: "report" as const, text: "x", attempts: 0, notBefore: 0 }))),
			(s: DiscordState) => void (s.queue = [{ id: 1, kind: "report", text: "x".repeat(1901), attempts: 0, notBefore: 0 }]),
			(s: DiscordState) => void (s.config.rateLimit = 121),
			(s: DiscordState) => void (s.config.channel = "12"),
			(s: DiscordState) => void ((s as unknown as { version: number }).version = 2),
		]) {
			const state = JSON.parse(good) as DiscordState;
			mutate(state);
			fs.writeFileSync(discordFile(home), JSON.stringify(state));
			expect(await run("status")).toStartWith("error: discord.json is invalid");
			expect(await run("off")).toStartWith("error: discord.json is invalid");
			await accept().catch(() => {});
			expect(fs.readFileSync(discordFile(home), "utf8")).toBe(JSON.stringify(state));
		}
		fs.writeFileSync(discordFile(home), "not json");
		expect(await run("status")).toContain("not valid JSON");
	});
});

// ---- Outbound -----------------------------------------------------------------------------------

describe("outbound", () => {
	test("a webhook post: exact URL, body, headers, no redirects, no Authorization", async () => {
		await enableWebhook();
		await accept();
		await tick();
		expect(fake.requests).toHaveLength(1);
		const [req] = fake.requests;
		expect(req.method).toBe("POST");
		expect(req.url).toBe(WEBHOOK_URL);
		expect(req.redirect).toBe("manual");
		expect(req.headers).toEqual({ "Content-Type": "application/json", "User-Agent": `omp-peers (https://github.com/PIIIX-org/omp-peers, ${VERSION})` });
		expect(JSON.parse(req.body!)).toEqual({ content: `**DONE** ${WORKER}: Parser rewrite: Offline checks passed`, allowed_mentions: { parse: [] } });
		expect(stored().queue).toEqual([]);
		expect(stored().sent).toBe(1);
		await tick();
		await tick();
		expect(fake.posts()).toHaveLength(1);
	});

	test("a bot post: channel URL, Bot authorization, user agent", async () => {
		await enableBot();
		await accept(done("Unit", "ok"), { id: WORKER, name: "worker-a" });
		await tick();
		// Inbound is a separate switch: bot mode with inbound off never polls.
		expect(fake.gets()).toEqual([]);
		const [req] = fake.requests;
		expect(req.url).toBe(`https://discord.com/api/v10/channels/${CHANNEL}/messages`);
		expect(req.headers.Authorization).toBe(`Bot ${BOT_TOKEN}`);
		expect(req.headers["User-Agent"]).toBe(`omp-peers (https://github.com/PIIIX-org/omp-peers, ${VERSION})`);
		expect(JSON.parse(req.body!)).toEqual({ content: `**DONE** ${WORKER}: Unit: ok`, allowed_mentions: { parse: [] } });
	});

	test("include-names on shows the cleaned claimed name; off (the default) never does", async () => {
		await enableWebhook();
		await accept(done(), { id: WORKER, name: "worker-a" });
		await run("set include-names on");
		await accept(done(), { id: WORKER, name: "worker-a" });
		await tick();
		clock += 1;
		await tick();
		expect(fake.contents()).toEqual([`**DONE** ${WORKER}: Parser rewrite: Offline checks passed`, `**DONE** worker-a (${WORKER}): Parser rewrite: Offline checks passed`]);
	});

	test("every field passes the screen: secrets, mentions, links and paths never reach the request", async () => {
		await enableWebhook();
		const evil: Report = { kind: "BLOCKED", unit: "Deploy @everyone <@&123456789012345678>", blocker: `see https://example.com/x and /${["Users", "bob"].join("/")}/work`, nextAction: "x" };
		await accept(evil);
		await accept({ kind: "DECISION", unit: "Rotate", question: `use ${BOT_TOKEN}` });
		await tick();
		clock += 1;
		await tick();
		const [first, second] = fake.contents();
		expect(first).toBe(`**BLOCKED** ${WORKER}: Deploy @\u200beveryone <\u200b@\u200b&123456789012345678\\>: see (link removed) and (path removed)`);
		expect(second).toBe(`**DECISION** ${WORKER}: (withheld)`);
		for (const req of fake.posts()) expect(JSON.parse(req.body!).allowed_mentions).toEqual({ parse: [] });
	});

	test("only reports the master accepted are bridged, and only while on", async () => {
		await enableWebhook();
		await accept(done(), { id: WORKER, name: "w" }, host(false));
		expect(stored().queue).toEqual([]);
		await run("off");
		await accept();
		expect(readDiscord(host()).queue).toEqual([]);
		await tick();
		expect(fake.requests).toEqual([]);
	});

	test("a non-master tick sends nothing", async () => {
		await enableWebhook();
		await accept();
		await tick(host(false));
		expect(fake.requests).toEqual([]);
		expect(stored().queue).toHaveLength(1);
	});

	test("the queue holds 100: the oldest is dropped and counted", async () => {
		await enableWebhook();
		for (let i = 0; i < MAX_QUEUE; i++) await accept(done(`Unit ${i}`));
		expect(stored().queue).toHaveLength(MAX_QUEUE);
		expect(stored().dropped).toBe(0);
		await accept(done("Unit 100"));
		const state = stored();
		expect(state.queue).toHaveLength(MAX_QUEUE);
		expect(state.dropped).toBe(1);
		expect(state.queue[0].text).toContain("Unit 1:");
		expect(state.queue.at(-1)!.text).toContain("Unit 100:");
		expect(state.log.at(-1)!.text).toBe("dropped 1 oldest message: queue full (100)");
		expect(await run("status")).toContain("queued: 100 of 100; sent: 0; dropped: 1");
	});

	test("the rate limit is a rolling hour: exactly N requests, the window frees at +1 h", async () => {
		await enableWebhook("set rate-limit 3");
		for (let i = 0; i < 6; i++) await accept(done(`Unit ${i}`));
		for (let i = 0; i < 6; i++) await tick();
		expect(fake.posts()).toHaveLength(3);
		clock = T0 + HOUR - 1;
		await tick();
		expect(fake.posts()).toHaveLength(3);
		clock = T0 + HOUR;
		await tick();
		await tick();
		await tick();
		await tick();
		expect(fake.posts()).toHaveLength(6);
		expect(stored().queue).toEqual([]);
	});

	test("one request per tick, in order", async () => {
		await enableWebhook();
		await accept(done("A"));
		await accept(done("B"));
		await tick();
		expect(fake.contents()).toHaveLength(1);
		await tick();
		expect(fake.contents().map(c => c.split(": ")[1])).toEqual(["A", "B"]);
	});

	test("5xx and network errors retry on the 30 s / 2 min / 10 min schedule, then the message is dropped after 4 attempts", async () => {
		await enableWebhook();
		await accept();
		fake.post = () => new Response("", { status: 503 });
		const times = [0, BACKOFF_MS[0], BACKOFF_MS[0] + BACKOFF_MS[1], BACKOFF_MS[0] + BACKOFF_MS[1] + BACKOFF_MS[2]];
		let at = 0;
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			clock = T0 + at;
			if (attempt > 1) {
				clock = T0 + at - 1;
				await tick();
				expect(fake.posts()).toHaveLength(attempt - 1);
				clock = T0 + at;
			}
			await tick();
			expect(fake.posts()).toHaveLength(attempt);
			at = times[attempt] ?? at;
		}
		const state = stored();
		expect(state.queue).toEqual([]);
		expect(state.dropped).toBe(1);
		expect(state.log.map(e => e.text)).toEqual([
			"webhook-file set",
			"bridge on",
			"retry #1 in 30 s (http 503, attempt 1 of 4)",
			"retry #1 in 120 s (http 503, attempt 2 of 4)",
			"retry #1 in 600 s (http 503, attempt 3 of 4)",
			"failed #1: gave up after 4 attempts (http 503)",
		]);
		clock += 24 * HOUR;
		await tick();
		expect(fake.posts()).toHaveLength(4);
	});

	test("a network error and a timeout are retried; their text never carries an error message", async () => {
		await enableWebhook();
		await accept();
		fake.post = () => {
			throw new Error(`connect failed to ${WEBHOOK_URL}`);
		};
		await tick();
		expect(stored().log.at(-1)!.text).toBe("retry #1 in 30 s (network error, attempt 1 of 4)");
		setTestSeam({ timeoutMs: 20, fetch: (_url, init) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")))) });
		clock += BACKOFF_MS[0];
		await tick();
		expect(stored().log.at(-1)!.text).toBe("retry #1 in 120 s (timeout, attempt 2 of 4)");
		expect(JSON.stringify(stored())).not.toContain(WEBHOOK_TOKEN);
	});

	test("429 honours Retry-After (header or body), caps the wait at 10 minutes and counts as an attempt", async () => {
		await enableWebhook();
		await accept();
		fake.post = () => new Response("", { status: 429, headers: { "Retry-After": "5" } });
		await tick();
		expect(stored().queue[0].notBefore).toBe(T0 + 5000);
		expect(stored().queue[0].attempts).toBe(1);
		clock = T0 + 4999;
		await tick();
		expect(fake.posts()).toHaveLength(1);
		clock = T0 + 5000;
		fake.post = () => new Response(JSON.stringify({ retry_after: 2.5, global: false }), { status: 429 });
		await tick();
		expect(stored().queue[0].notBefore).toBe(T0 + 5000 + 2500);
		clock = T0 + 7500;
		fake.post = () => new Response("", { status: 429, headers: { "Retry-After": "86400" } });
		await tick();
		expect(stored().queue[0].notBefore).toBe(T0 + 7500 + MAX_WAIT_MS);
		expect(stored().queue[0].attempts).toBe(3);
		clock = T0 + 7500 + MAX_WAIT_MS;
		fake.post = () => new Response("", { status: 429 });
		await tick();
		expect(fake.posts()).toHaveLength(4);
		expect(stored().queue).toEqual([]);
		expect(stored().log.at(-1)!.text).toBe("failed #1: gave up after 4 attempts (http 429)");
	});

	test("429 without a usable Retry-After falls back to the backoff schedule", async () => {
		await enableWebhook();
		await accept();
		fake.post = () => new Response("not json", { status: 429, headers: { "Retry-After": "soon" } });
		await tick();
		expect(stored().queue[0].notBefore).toBe(T0 + BACKOFF_MS[0]);
	});

	test("other 4xx drop the message with the code and are not retried", async () => {
		await enableWebhook();
		await accept();
		fake.post = () => new Response("", { status: 400 });
		await tick();
		expect(stored().queue).toEqual([]);
		expect(stored().log.at(-1)!.text).toBe("failed #1: http 400");
		await accept();
		fake.post = () => new Response("", { status: 404 });
		clock += 1;
		await tick();
		expect(stored().log.at(-1)!.text).toBe("failed #2: http 404");
		expect(fake.posts()).toHaveLength(2);
		expect(stored().enabled).toBe(true);
	});

	test("a redirect is a failure and is never followed", async () => {
		await enableWebhook();
		await accept();
		fake.post = () => new Response("", { status: 302, headers: { Location: "https://evil.example/hook" } });
		await tick();
		expect(fake.requests).toHaveLength(1);
		expect(fake.requests[0].redirect).toBe("manual");
		expect(stored().log.at(-1)!.text).toBe("failed #1: http 302 (redirect refused)");
		expect(stored().queue).toEqual([]);
		clock += HOUR;
		await tick();
		expect(fake.requests).toHaveLength(1);
	});

	test("401 and 403 stop the bridge: visible notice, queue discarded, nothing more is sent", async () => {
		for (const code of [401, 403]) {
			notes = [];
			fake.reset();
			await run("off");
			await enableWebhook();
			await accept();
			await accept();
			fake.post = () => new Response("", { status: code });
			await tick();
			expect(notes).toEqual([`discord: ${AUTH_STOPPED} (http ${code}); check the credential, then /peers discord on`]);
			const state = stored();
			expect(state.enabled).toBe(false);
			expect(state.queue).toEqual([]);
			expect(state.stopped).toBe(AUTH_STOPPED);
			expect(await run("status")).toContain(`stopped: ${AUTH_STOPPED}`);
			expect(await run("status")).toStartWith("discord bridge: off");
			await accept();
			clock += HOUR;
			await tick();
			expect(fake.posts()).toHaveLength(1);
			expect(await run("on")).toStartWith("discord bridge on");
			expect(stored().stopped).toBeUndefined();
			clock += 1;
		}
	});

	test("the circuit breaker opens after 5 consecutive failures for 30 minutes; a success resets the count", async () => {
		await enableWebhook();
		fake.post = () => new Response("", { status: 400 });
		for (let i = 0; i < BREAKER_FAILURES - 1; i++) {
			await accept(done(`U${i}`));
			await tick();
		}
		expect(stored().failures).toBe(4);
		fake.post = undefined;
		await accept(done("ok"));
		await tick();
		expect(stored().failures).toBe(0);
		fake.post = () => new Response("", { status: 400 });
		notes = [];
		for (let i = 0; i < BREAKER_FAILURES; i++) {
			await accept(done(`V${i}`));
			await tick();
		}
		expect(notes).toEqual([`discord bridge paused for 30 minutes after 5 consecutive failures`]);
		const open = stored();
		expect(open.pausedUntil).toBe(T0 + BREAKER_PAUSE_MS);
		expect(await run("status")).toContain(`circuit breaker: open until ${new Date(T0 + BREAKER_PAUSE_MS).toISOString()}`);
		await accept(done("queued while open"));
		const before = fake.posts().length;
		clock = T0 + BREAKER_PAUSE_MS - 1;
		await tick();
		expect(fake.posts()).toHaveLength(before);
		expect(await run("test")).toContain("not delivered: the circuit breaker is open");
		expect(fake.posts()).toHaveLength(before);
		clock = T0 + BREAKER_PAUSE_MS;
		fake.post = undefined;
		await tick();
		expect(fake.posts()).toHaveLength(before + 1);
		expect(fake.contents().at(-1)).toContain("queued while open");
	});

	test("turning off discards the queue at once, keeps the cursor, and nothing is sent afterwards", async () => {
		await enableInbound();
		fake.say("hello", OTHER, T0 - 1000);
		await tick();
		const cursor = stored().cursor;
		expect(cursor).toBeDefined();
		await accept();
		await accept();
		expect(await run("off")).toContain("2 queued message(s) discarded");
		const state = stored();
		expect(state.enabled).toBe(false);
		expect(state.queue).toEqual([]);
		expect(state.cursor).toBe(cursor);
		const before = fake.requests.length;
		clock += HOUR;
		await tick();
		await accept();
		expect(fake.requests).toHaveLength(before);
	});

	test("clear-queue discards queued messages and leaves the bridge on", async () => {
		await enableWebhook();
		await accept();
		await accept();
		expect(await run("clear-queue")).toBe("queue cleared: 2 message(s) discarded");
		expect(stored().enabled).toBe(true);
		await tick();
		expect(fake.requests).toEqual([]);
	});

	test("test posts one fixed message, honours the rate limit, and status never posts", async () => {
		expect(await run("test")).toBe("not delivered: the bridge is off; nothing was sent");
		await enableWebhook("set rate-limit 1");
		await run("status");
		await run("log");
		expect(fake.requests).toEqual([]);
		expect(await run("test")).toBe("test message delivered");
		expect(fake.contents()).toEqual([TEST_MESSAGE]);
		expect(await run("test")).toBe("not delivered: the rate limit is reached (1/1 requests in the last hour); nothing was sent");
		expect(fake.posts()).toHaveLength(1);
		expect(stored().queue).toEqual([]);
		clock += HOUR;
		fake.post = () => new Response("", { status: 500 });
		expect(await run("test")).toBe("not delivered: http 500");
		expect(stored().queue).toEqual([]);
	});

	test("status and log are read-only", async () => {
		await enableWebhook();
		await accept();
		const before = [fs.readFileSync(discordFile(home), "utf8"), fs.statSync(discordFile(home)).mtimeMs, fs.readdirSync(path.dirname(discordFile(home))).sort()];
		await run("status");
		await run("log");
		await run("");
		expect([fs.readFileSync(discordFile(home), "utf8"), fs.statSync(discordFile(home)).mtimeMs, fs.readdirSync(path.dirname(discordFile(home))).sort()]).toEqual(before);
		expect(fake.requests).toEqual([]);
	});

	test("the log is bounded and holds no message content", async () => {
		await enableWebhook();
		for (let i = 0; i < MAX_LOG + 5; i++) {
			await accept(done(`UNIQUE-CONTENT-${i}`));
			await tick();
			clock += 1;
		}
		const state = stored();
		expect(state.log).toHaveLength(MAX_LOG);
		expect(JSON.stringify(state.log)).not.toContain("UNIQUE-CONTENT");
	});

	test("no secret appears in any file under home, any command output or any notice", async () => {
		const outputs: string[] = [];
		const out = async (line: string) => {
			const text = await run(line);
			outputs.push(text);
			return text;
		};
		await out(`set bot-token-file ${botFile()}`);
		await out(`set channel ${CHANNEL}`);
		await out(`set inbound-users ${USER}`);
		await out("set inbound on");
		await out("on");
		await accept(done("Unit", `${BOT_TOKEN} and ${WEBHOOK_URL}`));
		fake.say("!peers status", USER, T0 - 1000);
		await tick();
		clock += POLL_INTERVAL_MS;
		fake.say("!peers list");
		await tick();
		fake.post = () => new Response("", { status: 401 });
		await accept();
		clock += 1;
		await tick();
		for (const line of ["status", "log", "test", "off"]) await out(line);
		await out(`set webhook-file ${webhookFile()}`);
		const secrets = [BOT_TOKEN, WEBHOOK_TOKEN, WEBHOOK_URL];
		for (const text of [...outputs, ...notes]) for (const s of secrets) expect(text).not.toContain(s);
		const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
		for (const file of walk(home).filter(f => !f.startsWith(path.join(home, "secrets")))) for (const s of secrets) expect(fs.readFileSync(file, "utf8")).not.toContain(s);
	});
});

// ---- Inbound --------------------------------------------------------------------------------------

describe("inbound", () => {
	const poll = async (advance = POLL_INTERVAL_MS) => {
		clock += advance;
		await tick();
	};

	test("the first poll records the channel position and runs nothing; later polls use it", async () => {
		await enableInbound();
		const old = fake.say("!peers list", USER, T0 - 2000);
		await tick();
		expect(fake.gets().map(g => new URL(g.url).search)).toEqual(["?limit=1"]);
		expect(stored().cursor).toBe(old.id);
		expect(fake.posts()).toEqual([]);
		expect(hostCalls).toEqual([]);
		await poll();
		expect(fake.gets().map(g => new URL(g.url).search)).toEqual(["?limit=1", `?limit=20&after=${old.id}`]);
		expect(fake.posts()).toEqual([]);
		expect(fake.gets()[1].url).toBe(`https://discord.com/api/v10/channels/${CHANNEL}/messages?limit=20&after=${old.id}`);
		expect(fake.gets()[1].headers.Authorization).toBe(`Bot ${BOT_TOKEN}`);
		expect(fake.gets()[1].redirect).toBe("manual");
	});

	test("an empty channel records cursor 0, so the first message is executed", async () => {
		await enableInbound();
		await tick();
		expect(stored().cursor).toBe("0");
		fake.say("!peers help");
		await poll();
		expect(fake.contents()).toEqual([HELP_REPLY]);
	});

	test("an allowlisted user's list gets one reply; the same message is never answered twice", async () => {
		await enableInbound();
		await tick();
		fake.say("!peers list");
		await poll();
		expect(fake.contents()).toEqual([`sessions: 2\n${MASTER} idle\n${WORKER} busy paused`]);
		expect(hostCalls).toEqual(["peers"]);
		expect(fake.posts()[0].url).toBe(`https://discord.com/api/v10/channels/${CHANNEL}/messages`);
		for (let i = 0; i < 3; i++) await poll();
		expect(fake.posts()).toHaveLength(1);
	});

	test("list honours include-names and caps its rows", async () => {
		await enableInbound();
		await run("set include-names on");
		peerList = Array.from({ length: 12 }, (_, i) => ({ id: `p${String(i).padStart(16, "0")}`, name: `n${i} @everyone`, busy: i % 2 === 0 }));
		peerList[3].busy = undefined;
		await tick();
		fake.say("!peers list");
		await poll();
		const lines = fake.contents()[0].split("\n");
		expect(lines).toHaveLength(12);
		expect(lines[0]).toBe("sessions: 12");
		expect(lines[1]).toBe("n0 @\u200beveryone (p0000000000000000) busy");
		expect(lines[4]).toBe("n3 @\u200beveryone (p0000000000000003) unknown");
		expect(lines[11]).toBe("… 2 more");
	});

	test("status and help replies are exact", async () => {
		await enableInbound();
		await tick();
		fake.say("!peers status");
		fake.say("!peers help");
		await poll();
		await poll();
		expect(fake.contents()).toEqual(["discord bridge: on; mode bot; queued 0; requests in last hour 0/30; breaker closed", HELP_REPLY]);
	});

	test("only allowlisted humans: other users, bots, webhooks and an empty allowlist are ignored", async () => {
		await enableInbound();
		await tick();
		fake.say("!peers help", OTHER);
		fake.messages.push({ id: snow(clock, counter++), content: "!peers help", author: { id: USER, bot: true } });
		fake.messages.push({ id: snow(clock, counter++), content: "!peers help", author: { id: USER }, webhook_id: "444444444444444444" });
		await poll();
		expect(fake.posts()).toEqual([]);
		fake.say("!peers help", USER);
		await poll();
		expect(fake.contents()).toEqual([HELP_REPLY]);
		await run("set inbound-users none");
		fake.say("!peers help", USER);
		await poll();
		await poll();
		expect(fake.posts()).toHaveLength(1);
		expect(await run("status")).toContain("allowlist is empty: nothing is accepted");
	});

	test("the exact prefix is required and the content limit is 200 bytes", async () => {
		await enableInbound();
		await tick();
		for (const content of ["!peers", "peers help", " !peers help", "!PEERS help", "!peersx help", "!peers\thelp", "hello !peers help", "", "!peers help".padEnd(MAX_INBOUND_BYTES + 1, " ")]) fake.say(content);
		await poll();
		expect(fake.posts()).toEqual([]);
		fake.say("!peers help".padEnd(MAX_INBOUND_BYTES, " "));
		await poll();
		expect(fake.contents()).toEqual([HELP_REPLY]);
		expect(parseCommand("!peers help".padEnd(MAX_INBOUND_BYTES, " "))).toBe("help");
		expect(parseCommand("!peers help".padEnd(MAX_INBOUND_BYTES + 1, " "))).toBeUndefined();
		// Bytes, not characters: 99 two-byte characters + the prefix is over the limit.
		expect(parseCommand(`!peers ${"é".repeat(96)}`)).toBe("");
		expect(parseCommand(`!peers ${"é".repeat(97)}`)).toBeUndefined();
	});

	test("every word outside status, list and help gets the fixed reply and causes no host call", async () => {
		await enableInbound();
		await tick();
		const words = ["prompt x", "msg worker hi", "pause", "resume", "approve q1", "set", "set channel 1", "do all prompt x", "report x", "abort", "compact", "shutdown", "rename x", "model x", "send x", "dispatch", "unlock", "accept", "refuse", "on", "off", "rules", "status extra", "list all", "help me", "STATUS", "List", "", "  ", "status;list", "peers list", "!peers list", "statusx", "../status", "@everyone", "<@1>"];
		await run("set rate-limit 120");
		let sent = 0;
		for (const word of words) {
			fake.say(`!peers ${word}`);
			await poll();
			sent++;
			// A poll answers in the same tick; the reply is queued and sent within a few ticks at most.
			for (let i = 0; i < 3 && stored().queue.length; i++) {
				clock += 1;
				await tick();
			}
			expect(fake.posts()).toHaveLength(sent);
			expect(fake.contents().at(-1)).toBe(UNKNOWN_REPLY);
			expect(hostCalls).toEqual([]);
			clock += 60_000;
		}
		expect(fake.posts().every(p => JSON.parse(p.body!).content === UNKNOWN_REPLY)).toBe(true);
	});

	test("the command set is exactly status, list and help", () => {
		const source = fs.readFileSync(path.join(REPO, "lib", "features", "discord.ts"), "utf8");
		expect(source.match(/INBOUND_COMMANDS = \[(.*)\] as const/)![1]).toBe('"status", "list", "help"');
		// Nothing in the module can reach a session: the only host members used are these.
		const members = new Set([...source.matchAll(/\bhost\.([a-zA-Z]+)\(/g)].map(m => m[1]));
		expect([...members].sort()).toEqual(["isMaster", "notify", "now", "peers"]);
	});

	test("old and future-dated messages are skipped, never replayed; the age limits are exact", async () => {
		await enableInbound();
		await tick();
		const next = () => clock + POLL_INTERVAL_MS;
		fake.say("!peers help", USER, next() - MAX_COMMAND_AGE_MS - 1);
		fake.say("!peers help", USER, next() - MAX_COMMAND_AGE_MS);
		await poll();
		expect(fake.contents()).toEqual([HELP_REPLY]);
		fake.say("!peers help", USER, next() + MAX_FUTURE_SKEW_MS + 1);
		await poll();
		expect(fake.contents()).toHaveLength(1);
		fake.say("!peers help", USER, next() + MAX_FUTURE_SKEW_MS);
		await poll();
		clock += 1;
		await tick();
		expect(fake.contents()).toHaveLength(2);
	});

	test("a command is executed once even if a server repeats it; the cursor survives a new process", async () => {
		await enableInbound();
		await tick();
		const msg = fake.say("!peers help");
		await poll();
		expect(stored().cursor).toBe(msg.id);
		// A misbehaving server ignores `after` and repeats everything.
		fake.get = () => new Response(JSON.stringify([msg]), { status: 200 });
		await poll();
		await poll();
		expect(fake.posts()).toHaveLength(1);
		// A bridge turned off and on again keeps the cursor and does not replay.
		await run("off");
		await run("on");
		fake.get = undefined;
		await poll();
		await poll();
		expect(fake.posts()).toHaveLength(1);
		expect(fake.gets().at(-1)!.url).toContain(`after=${msg.id}`);
	});

	test("turning inbound off and on again re-baselines instead of replaying; a new channel does too", async () => {
		await enableInbound();
		await tick();
		await run("set inbound off");
		expect(stored().cursor).toBeUndefined();
		const missed = fake.say("!peers help");
		await run("set inbound on");
		await poll();
		await poll();
		expect(fake.posts()).toEqual([]);
		expect(stored().cursor).toBe(missed.id);
		await run("set channel 555555555555555555");
		expect(stored().cursor).toBeUndefined();
	});

	test("a user may run 6 commands a minute; the rest are ignored without a reply", async () => {
		await enableInbound();
		await tick();
		for (let i = 0; i < USER_COMMANDS + 3; i++) fake.say("!peers help");
		await poll();
		expect(stored().queue.length + fake.posts().length).toBe(USER_COMMANDS);
		for (let i = 0; i < USER_COMMANDS; i++) {
			clock += 1;
			await tick();
		}
		expect(fake.posts()).toHaveLength(USER_COMMANDS);
		fake.say("!peers help");
		await poll(5000);
		expect(fake.posts()).toHaveLength(USER_COMMANDS);
		// 15 s later the minute is not over: the 7th command is ignored without a reply.
		fake.say("!peers help");
		await poll();
		clock += 1;
		await tick();
		expect(fake.posts()).toHaveLength(USER_COMMANDS);
		expect(stored().queue).toEqual([]);
		fake.say("!peers help");
		await poll(60_000);
		clock += 1;
		await tick();
		expect(fake.posts()).toHaveLength(USER_COMMANDS + 1);
	});

	test("the poll interval is 15 s and polling stops when off or webhook", async () => {
		await enableInbound();
		await tick();
		await tick();
		clock += POLL_INTERVAL_MS - 1;
		await tick();
		expect(fake.gets()).toHaveLength(1);
		clock += 1;
		await tick();
		expect(fake.gets()).toHaveLength(2);
		await run("set inbound off");
		clock += HOUR;
		await tick();
		expect(fake.gets()).toHaveLength(2);
		await run("off");
		await run("set bot-token-file none");
		await run("set channel none");
		await enableWebhook();
		const gets = fake.gets().length;
		clock += HOUR;
		await tick();
		expect(fake.gets()).toHaveLength(gets);
	});

	test("replies use the same redaction, queue and rate limit as reports", async () => {
		await enableInbound();
		await run("set rate-limit 2");
		await tick();
		fake.say("!peers help");
		fake.say("!peers help");
		fake.say("!peers help");
		await poll();
		for (let i = 0; i < 4; i++) {
			clock += 1;
			await tick();
		}
		expect(fake.posts()).toHaveLength(2);
		expect(stored().queue).toHaveLength(1);
		expect(fake.posts().every(p => JSON.parse(p.body!).allowed_mentions.parse.length === 0)).toBe(true);
	});

	test("a failed poll counts toward the breaker; 401 on a poll stops the bridge; a malformed body is a failure", async () => {
		await enableInbound();
		await tick();
		fake.get = () => new Response("not json", { status: 200 });
		await poll();
		expect(stored().log.at(-1)!.text).toBe("poll failed: invalid response");
		expect(stored().failures).toBe(1);
		fake.get = () => new Response(JSON.stringify(Array.from({ length: 21 }, (_, i) => ({ id: snow(T0, i), content: "", author: { id: USER } }))), { status: 200 });
		await poll();
		expect(stored().failures).toBe(2);
		fake.get = () => new Response("", { status: 401 });
		await poll();
		expect(stored().enabled).toBe(false);
		expect(notes.at(-1)).toBe(`discord: ${AUTH_STOPPED} (http 401); check the credential, then /peers discord on`);
		const before = fake.requests.length;
		await poll();
		expect(fake.requests).toHaveLength(before);
	});

	test("poll failures open the breaker after 5 in a row", async () => {
		await enableInbound();
		await tick();
		fake.get = () => new Response("", { status: 500 });
		for (let i = 0; i < BREAKER_FAILURES; i++) await poll();
		expect(stored().pausedUntil).toBe(clock + BREAKER_PAUSE_MS);
		const gets = fake.gets().length;
		await poll();
		expect(fake.gets()).toHaveLength(gets);
	});

	test("a 429 on a poll delays the next poll by Retry-After", async () => {
		await enableInbound();
		await tick();
		fake.get = () => new Response("", { status: 429, headers: { "Retry-After": "60" } });
		await poll();
		const gets = fake.gets().length;
		await poll(59_000 - 1);
		expect(fake.gets()).toHaveLength(gets);
		await poll(1001);
		expect(fake.gets()).toHaveLength(gets + 1);
	});

	test("malformed message entries are skipped", async () => {
		await enableInbound();
		await tick();
		fake.get = () => new Response(JSON.stringify([null, 5, "x", {}, { id: "abc", author: { id: USER }, content: "!peers help" }, { id: snow(clock, 1), content: "!peers help" }, { id: snow(clock, 2), author: { id: USER }, content: 5 }]), { status: 200 });
		await poll();
		expect(fake.posts()).toEqual([]);
		expect(stored().failures).toBe(0);
	});
});

// ---- Test seam ------------------------------------------------------------------------------------

describe("endpoint", () => {
	test("the environment cannot steer the endpoint: a set OMP_PEERS_DISCORD_API_BASE changes nothing", async () => {
		const name = "OMP_PEERS_DISCORD_API_BASE";
		const previous = process.env[name];
		process.env[name] = "http://127.0.0.1:9";
		try {
			// Neither the already loaded module nor a freshly loaded copy reads it.
			await enableBot();
			await accept();
			await tick();
			expect(fake.requests.map(r => r.url)).toEqual([`https://discord.com/api/v10/channels/${CHANNEL}/messages`]);
			expect(fake.requests[0].headers.Authorization).toBe(`Bot ${BOT_TOKEN}`);
			// A runtime-selected specifier: the query makes the loader evaluate the module afresh with the variable already set.
			const fresh = await import(`../../lib/features/discord.ts?fresh=${Date.now()}`);
			expect(fresh.postTarget({ mode: "bot", token: BOT_TOKEN, channel: CHANNEL }).url).toBe(`https://discord.com/api/v10/channels/${CHANNEL}/messages`);
			expect(fresh.postTarget({ mode: "webhook", url: WEBHOOK_URL, id: WEBHOOK_ID }).url).toBe(WEBHOOK_URL);
		} finally {
			if (previous === undefined) delete process.env[name];
			else process.env[name] = previous;
		}
		const source = fs.readFileSync(path.join(REPO, "lib", "features", "discord.ts"), "utf8");
		expect(source).not.toContain(name);
		expect(source).not.toContain("process.env");
	});

	test("the webhook goes to the URL from the credential file, host included", async () => {
		await enableWebhook();
		await accept();
		await tick();
		expect(new URL(fake.requests[0].url).host).toBe("discord.com");
		expect(fake.requests[0].url).toBe(WEBHOOK_URL);
	});

	test("the test endpoint accepts exactly http://127.0.0.1:<port> and is restorable", async () => {
		for (const value of ["http://127.0.0.1", "http://127.0.0.1:8080/", "http://127.0.0.1:8080/x", "https://127.0.0.1:8080", "http://localhost:8080", "http://127.0.0.1.evil.example:80", "http://user" + "@127.0.0.1:8080", "http://127.0.0.1:8080?x=1", "http://[::1]:8080", "http://127.0.0.2:8080", "https://discord.com", "http://127.0.0.1:123456", " http://127.0.0.1:8080", ""]) expect(() => setTestEndpoint(value)).toThrow("must be exactly http://127.0.0.1:<port>");
		await enableBot();
		setTestEndpoint("http://127.0.0.1:8080");
		try {
			await accept();
			await tick();
			expect(fake.requests[0].url).toBe(`http://127.0.0.1:8080/api/v10/channels/${CHANNEL}/messages`);
		} finally {
			setTestEndpoint(undefined);
		}
		await accept();
		clock += 1;
		await tick();
		expect(fake.requests[1].url).toBe(`https://discord.com/api/v10/channels/${CHANNEL}/messages`);
		// The scenario-only endpoint extension is not part of the published package.
		const files: unknown = Reflect.get(JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")), "files");
		expect(Array.isArray(files)).toBe(true);
		for (const entry of Array.isArray(files) ? files : []) expect(String(entry), String(entry)).not.toMatch(/^tests\/?$|scenarios|_discord_endpoint_ext/);
	});

	test("with the test endpoint a webhook keeps its validated path and only the origin changes", async () => {
		await enableWebhook();
		setTestEndpoint("http://127.0.0.1:8081");
		try {
			await accept();
			await tick();
		} finally {
			setTestEndpoint(undefined);
		}
		expect(fake.requests[0].url).toBe(`http://127.0.0.1:8081/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`);
	});
});

describe("hardening", () => {
	const writeState = (mutate: (s: DiscordState) => void) => {
		const state = stored();
		mutate(state);
		fs.writeFileSync(discordFile(home), JSON.stringify(state));
	};
	const failThrice = async () => {
		fake.post = () => new Response("", { status: 503 });
		for (const at of [0, BACKOFF_MS[0], BACKOFF_MS[0] + BACKOFF_MS[1]]) {
			clock = T0 + at;
			await tick();
		}
		expect(fake.posts()).toHaveLength(3);
		expect(stored().queue[0].attempts).toBe(3);
	};

	test("a message whose 4th attempt never reported back is dropped, never sent a 5th time", async () => {
		await enableWebhook();
		await accept();
		await failThrice();
		// Crash or handoff during attempt 4: claimed (attempts 4, live lease) but never settled.
		const lease = clock + 30_000;
		writeState(s => {
			s.queue[0].attempts = 4;
			s.queue[0].leaseUntil = lease;
		});
		clock += 10_000;
		await tick();
		expect(fake.posts()).toHaveLength(3);
		expect(stored().queue).toHaveLength(1);
		clock = lease;
		await tick();
		expect(fake.posts()).toHaveLength(3);
		const state = stored();
		expect(state.queue).toEqual([]);
		expect(state.dropped).toBe(1);
		expect(state.log.at(-1)!.text).toBe("failed #1: gave up after 4 attempts (no result recorded)");
		clock += HOUR;
		await tick();
		expect(fake.posts()).toHaveLength(3);
	});

	test("an over-limit attempt count never breaks status, log or off, and the message is dropped", async () => {
		await enableWebhook();
		await accept();
		await accept();
		writeState(s => {
			s.queue[0].attempts = 5;
			s.queue[1].attempts = 999;
		});
		expect(await run("status")).toContain("queued: 2 of 100");
		expect(await run("log")).toContain("bridge on");
		expect(readDiscord(host()).queue.map(q => q.attempts)).toEqual([MAX_ATTEMPTS, MAX_ATTEMPTS]);
		await tick();
		expect(fake.posts()).toEqual([]);
		expect(stored().queue).toEqual([]);
		expect(stored().dropped).toBe(2);
		await accept();
		writeState(s => void (s.queue[0].attempts = 7));
		expect(await run("off")).toContain("1 queued message(s) discarded");
		expect(stored().enabled).toBe(false);
	});

	test("an exhausted message does not block the next one", async () => {
		await enableWebhook();
		await accept(done("Old"));
		await accept(done("Fresh"));
		writeState(s => void (s.queue[0].attempts = 4));
		await tick();
		expect(fake.contents()).toEqual([`**DONE** ${WORKER}: Fresh: Offline checks passed`]);
		expect(stored().dropped).toBe(1);
	});

	test("a 429 holds every send, not only its own message", async () => {
		await enableWebhook();
		await accept(done("First"));
		await accept(done("Second"));
		fake.post = () => new Response("", { status: 429, headers: { "Retry-After": "60" } });
		await tick();
		expect(fake.posts()).toHaveLength(1);
		expect(stored().holdUntil).toBe(T0 + 60_000);
		fake.post = undefined;
		for (const at of [5000, 59_999]) {
			clock = T0 + at;
			await tick();
			expect(fake.posts()).toHaveLength(1);
		}
		expect(await run("test")).toBe("not delivered: Discord asked the bridge to slow down for 1 more second(s); nothing was sent");
		expect(await run("status")).toContain("discord rate-limit hold (HTTP 429): nothing is sent or polled until");
		expect(fake.posts()).toHaveLength(1);
		clock = T0 + 60_000;
		await tick();
		expect(fake.posts()).toHaveLength(2);
		clock += 1;
		await tick();
		expect(fake.contents().map(c => c.split(": ")[1])).toEqual(["First", "First", "Second"]);
	});

	test("a 429 caps the hold at 10 minutes and `on` clears it", async () => {
		await enableWebhook();
		await accept();
		fake.post = () => new Response("", { status: 429, headers: { "Retry-After": "86400" } });
		await tick();
		expect(stored().holdUntil).toBe(T0 + MAX_WAIT_MS);
		await run("off");
		await run("on");
		expect(stored().holdUntil).toBeUndefined();
	});

	test("a 429 without Retry-After holds for the backoff step", async () => {
		await enableWebhook();
		await accept();
		fake.post = () => new Response("", { status: 429 });
		await tick();
		expect(stored().holdUntil).toBe(T0 + BACKOFF_MS[0]);
	});

	test("a 429 on a send also holds polling", async () => {
		await enableInbound();
		await tick();
		await accept();
		fake.post = () => new Response("", { status: 429, headers: { "Retry-After": "60" } });
		clock += POLL_INTERVAL_MS;
		await tick();
		const gets = fake.gets().length;
		fake.post = undefined;
		clock += POLL_INTERVAL_MS;
		await tick();
		expect(fake.gets()).toHaveLength(gets);
		expect(fake.posts()).toHaveLength(1);
		clock = stored().holdUntil!;
		await tick();
		expect(fake.gets()).toHaveLength(gets + 1);
		expect(fake.posts()).toHaveLength(2);
	});
});

// ---- Two processes -------------------------------------------------------------------------------

describe("concurrent processes", () => {
	test("two processes ticking send each message once and poll once", async () => {
		await enableBot(`set inbound-users ${USER}`, "set inbound on");
		await accept(done("One"));
		await accept(done("Two"));
		const spawn = (tag: string) => Bun.spawn(["bun", path.join(import.meta.dir, "child_discord.ts"), home, String(clock), tag], { stdout: "pipe", stderr: "pipe" });
		const children = [spawn("a"), spawn("b")];
		const results = await Promise.all(children.map(async c => ({ code: await c.exited, err: await new Response(c.stderr).text() })));
		for (const r of results) expect(r).toEqual({ code: 0, err: "" });
		const lines = fs.readFileSync(path.join(home, "requests.log"), "utf8").trim().split("\n");
		const posts = lines.filter(l => l.includes(" POST "));
		const gets = lines.filter(l => l.includes(" GET "));
		// Each child ticks 3 times; one request per tick; the first poll (baseline) happens once and later polls are 15 s apart.
		expect(new Set(posts.map(l => l.slice(l.indexOf(" POST ") + 6))).size).toBe(2);
		expect(posts).toHaveLength(2);
		expect(gets).toHaveLength(1);
		expect(stored().queue).toEqual([]);
		expect(stored().sent).toBe(2);
	});
});
