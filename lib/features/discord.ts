// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

/**
 * Optional Discord bridge: reports the master accepted go to ONE Discord channel through a webhook or a
 * bot account, and (separately, off by default) a short allowlist of Discord users may run three read-only
 * commands. Off until `/peers discord on`.
 *
 * Boundaries, enforced here and described in docs/features/discord.md:
 * - Only documented Discord HTTP APIs are used (incoming webhook; bot token with the `Bot` scheme). No user
 *   account, no gateway/websocket, no scraping.
 * - Credentials live in files outside the repository (`secretfile.ts`); the state file stores only their paths.
 *   A credential is read when it is used and never kept, logged, echoed or queued.
 * - Outbound text is built from a fixed template and a few structured report fields, screened for secrets,
 *   stripped of links and absolute paths, neutralised for mentions and markdown and byte-capped. Every post
 *   carries `allowed_mentions: {parse: []}`. Nothing from a transcript, prompt or tool output is ever used.
 * - Inbound is a separate switch. It can only answer `status`, `list` and `help`; no code path from Discord
 *   reaches `host.send`, a prompt, pause, approval or any setting, so it cannot bypass peer controls.
 * - Everything is bounded: queue, rate, attempts, backoff, timeouts, response size, poll rate, command rate.
 *   The bridge never forwards anything that came from Discord and never reports its own notices.
 * - State is one cross-process-locked file. A send or a poll is CLAIMED under the lock before the network is
 *   touched, so two processes never both do the same work.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Report } from "../reports";
import type { FeatureHost } from "./host";
import type { Feature } from "./index";
import { readSecretFile } from "./secretfile";
import { looksLikeSecret } from "./secrets";
import { readState, stateRoot, updateState } from "./store";

// ---- Limits -----------------------------------------------------------------------------------

export const MAX_QUEUE = 100;
export const DEFAULT_RATE = 30;
export const MIN_RATE = 1;
export const MAX_RATE = 120;
export const REQUEST_TIMEOUT_MS = 10_000;
/** Waits before retry 1, 2 and 3; a message makes at most MAX_ATTEMPTS requests in total. */
export const BACKOFF_MS = [30_000, 120_000, 600_000] as const;
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
export const MAX_WAIT_MS = 600_000;
export const BREAKER_FAILURES = 5;
export const BREAKER_PAUSE_MS = 1_800_000;
/** A claimed send that never reports back (crash) becomes eligible again after this long. */
export const LEASE_MS = 30_000;
export const POLL_INTERVAL_MS = 15_000;
export const POLL_LIMIT = 20;
/** A command older than this (by its message snowflake) is skipped, so a restart or a long off never replays history. */
export const MAX_COMMAND_AGE_MS = 300_000;
export const MAX_FUTURE_SKEW_MS = 60_000;
export const MAX_INBOUND_BYTES = 200;
export const USER_COMMANDS = 6;
export const USER_WINDOW_MS = 60_000;
export const MAX_USERS = 8;
export const MAX_SUMMARY_BYTES = 300;
export const MAX_NAME_BYTES = 40;
export const MAX_MESSAGE_BYTES = 1900;
export const MAX_LOG = 20;
export const MAX_LIST_ROWS = 10;
const MAX_LOG_BYTES = 160;
const RESPONSE_LIMIT = 524_288;
const HOUR = 3_600_000;
const COUNTER_CAP = 1_000_000_000;
const DISCORD_EPOCH = 1_420_070_400_000;

export const TEST_MESSAGE = "omp-peers bridge test";
export const UNKNOWN_REPLY = "unknown command; try !peers help";
export const HELP_REPLY = "read-only commands: !peers status, !peers list, !peers help";
export const AUTH_STOPPED = "auth failed: bridge stopped";
export const COMMAND_PREFIX = "!peers ";
/** Every inbound command that exists. Nothing here changes any state or reaches any session. */
export const INBOUND_COMMANDS = ["status", "list", "help"] as const;

const MASTER_ONLY = "only the master session may change or run the Discord bridge; run /peers master first";
const USAGE = "usage: /peers discord on | off | status | log | test | clear-queue | set <webhook-file|bot-token-file|channel|include-names|rate-limit|inbound|inbound-users> <value...>";
const SET_KEYS = "webhook-file, bot-token-file, channel, include-names, rate-limit, inbound, inbound-users";

export const WEBHOOK_RE = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/([0-9]{5,25})\/([A-Za-z0-9_-]{20,120})$/;
export const SNOWFLAKE_RE = /^[0-9]{5,25}$/;
const CURSOR_RE = /^[0-9]{1,25}$/;
const PEER_ID_RE = /^p[0-9a-f]{16}$/;
const CREDENTIAL_RE = /^[\x21-\x7e]+$/;

const DEFAULT_BASE = "https://discord.com/api/v10";
const LOOPBACK_BASE_RE = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/;

// ---- API base (test seam) ----------------------------------------------------------------------

/**
 * The Discord API base. `OMP_PEERS_DISCORD_API_BASE` exists ONLY so the real-OMP scenario can point the master at a fake
 * server on this machine: it is honoured solely when it is exactly `http://127.0.0.1:<port>`; any other value is ignored
 * with a warning. It is read once, when the process starts, and no command or remote operation can set it.
 */
export function resolveApiBase(value: string | undefined): { base: string; override: boolean; warning?: string } {
	if (value === undefined || value === "") return { base: DEFAULT_BASE, override: false };
	if (LOOPBACK_BASE_RE.test(value)) return { base: `${value}/api/v10`, override: true };
	return { base: DEFAULT_BASE, override: false, warning: "OMP_PEERS_DISCORD_API_BASE ignored: only http://127.0.0.1:<port> is accepted (test-only); using the real Discord API" };
}
const API = resolveApiBase(process.env.OMP_PEERS_DISCORD_API_BASE);
let warnedBase = false;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
interface Seam {
	fetch: Fetch;
	timeoutMs: number;
}
const REAL_SEAM = (): Seam => ({ fetch: (url, init) => fetch(url, init), timeoutMs: REQUEST_TIMEOUT_MS });
let seam: Seam = REAL_SEAM();
/** Unit-test seam: replace the HTTP client and the request timeout; call with no argument to restore the real ones. */
export function setTestSeam(next?: Partial<Seam>): void {
	seam = { ...REAL_SEAM(), ...next };
}

const REPO_URL = "https://github.com/PIIIX-org/omp-peers";
let userAgent: string | undefined;
function agent(): string {
	if (userAgent) return userAgent;
	let version = "unknown";
	try {
		const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: unknown };
		if (typeof parsed.version === "string" && /^[0-9A-Za-z.+-]{1,32}$/.test(parsed.version)) version = parsed.version;
	} catch {
		// the version is informational only
	}
	userAgent = `omp-peers (${REPO_URL}, ${version})`;
	return userAgent;
}

// ---- State -------------------------------------------------------------------------------------

export type Kind = "report" | "reply" | "test";
const KINDS: readonly string[] = ["report", "reply", "test"];

export interface Config {
	/** Absolute path of the file holding the webhook URL. */
	webhookFile?: string;
	/** Absolute path of the file holding the bot token. */
	botTokenFile?: string;
	channel?: string;
	/** Whether session names (claims by the sessions) appear in posts; ids only by default. */
	includeNames: boolean;
	/** Maximum requests per rolling hour. */
	rateLimit: number;
	inbound: boolean;
	inboundUsers: string[];
}

export interface QueueItem {
	/** Sequence number, never reused. */
	id: number;
	kind: Kind;
	/** The final, already redacted text; nothing else about the report is stored. */
	text: string;
	/** Requests started for this message. */
	attempts: number;
	/** Not before this time (epoch ms). */
	notBefore: number;
	/** Set while a process is sending it. */
	leaseUntil?: number;
}

export interface LogEntry {
	at: number;
	text: string;
}

export interface DiscordState {
	version: 1;
	enabled: boolean;
	config: Config;
	queue: QueueItem[];
	nextId: number;
	/** Messages dropped because the queue was full or after a permanent failure, since the state file was created. */
	dropped: number;
	/** Messages delivered. */
	sent: number;
	/** Start times of requests in the last hour (rate limit window). */
	sentTimes: number[];
	/** Consecutive failed requests (sends and polls). */
	failures: number;
	/** Circuit breaker: nothing is sent or polled before this time. */
	pausedUntil?: number;
	/** Newest Discord message id already examined. */
	cursor?: string;
	/** Last time a poll was claimed (epoch ms). */
	lastPollAt: number;
	/** Command times in the last minute per allowlisted user. */
	userHits: Record<string, number[]>;
	/** Why the bridge was stopped by itself; cleared by `on`. */
	stopped?: string;
	log: LogEntry[];
}

export const discordFile = (home: string) => path.join(stateRoot(home), "discord.json");

const defaults = (): Config => ({ includeNames: false, rateLimit: DEFAULT_RATE, inbound: false, inboundUsers: [] });
const emptyState = (): DiscordState => ({ version: 1, enabled: false, config: defaults(), queue: [], nextId: 1, dropped: 0, sent: 0, sentTimes: [], failures: 0, lastPollAt: 0, userHits: {}, log: [] });

const isCount = (v: unknown, max = COUNTER_CAP): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max;
const isTime = (v: unknown): v is number => Number.isFinite(v) && (v as number) >= 0;
const isAbsolutePath = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 1024 && path.isAbsolute(v) && !/[\s\p{Cc}]/u.test(v);

export function modeOf(config: Config): "webhook" | "bot" | undefined {
	if (config.webhookFile) return "webhook";
	return config.botTokenFile && config.channel ? "bot" : undefined;
}

function validateConfig(value: unknown): Config {
	const c = value as Partial<Config> | null;
	const ok = !!c && typeof c === "object" && (c.webhookFile === undefined || isAbsolutePath(c.webhookFile)) && (c.botTokenFile === undefined || isAbsolutePath(c.botTokenFile)) &&
		(c.channel === undefined || (typeof c.channel === "string" && SNOWFLAKE_RE.test(c.channel))) && typeof c.includeNames === "boolean" &&
		isCount(c.rateLimit, MAX_RATE) && c.rateLimit >= MIN_RATE && typeof c.inbound === "boolean" &&
		Array.isArray(c.inboundUsers) && c.inboundUsers.length <= MAX_USERS && c.inboundUsers.every(u => typeof u === "string" && SNOWFLAKE_RE.test(u)) && new Set(c.inboundUsers).size === c.inboundUsers.length;
	if (!ok) throw new Error("malformed config");
	const config = c as Config;
	if (config.webhookFile && (config.botTokenFile || config.channel)) throw new Error("webhook and bot settings are both present");
	if (config.inbound && modeOf(config) !== "bot") throw new Error("inbound is on without a bot configuration");
	return config;
}

function validateItem(value: unknown): QueueItem {
	const q = value as Partial<QueueItem> | null;
	const ok = !!q && typeof q === "object" && Number.isInteger(q.id) && q.id! >= 1 && KINDS.includes(q.kind as string) && typeof q.text === "string" && q.text.length > 0 &&
		Buffer.byteLength(q.text) <= MAX_MESSAGE_BYTES && isCount(q.attempts, MAX_ATTEMPTS) && isTime(q.notBefore) && (q.leaseUntil === undefined || isTime(q.leaseUntil));
	if (!ok) throw new Error("malformed queue entry");
	return q as QueueItem;
}

function validateState(value: unknown): DiscordState {
	const s = value as Partial<DiscordState> | null;
	if (!s || typeof s !== "object" || s.version !== 1) throw new Error("unsupported version (expected 1)");
	const ok = typeof s.enabled === "boolean" && Number.isInteger(s.nextId) && s.nextId! >= 1 && isCount(s.dropped) && isCount(s.sent) && Array.isArray(s.sentTimes) && s.sentTimes.length <= MAX_RATE &&
		s.sentTimes.every(isTime) && isCount(s.failures, BREAKER_FAILURES) && (s.pausedUntil === undefined || isTime(s.pausedUntil)) &&
		(s.cursor === undefined || (typeof s.cursor === "string" && CURSOR_RE.test(s.cursor))) && isTime(s.lastPollAt) && (s.stopped === undefined || (typeof s.stopped === "string" && s.stopped.length <= 80)) &&
		Array.isArray(s.queue) && s.queue.length <= MAX_QUEUE && Array.isArray(s.log) && s.log.length <= MAX_LOG && !!s.userHits && typeof s.userHits === "object" && !Array.isArray(s.userHits);
	if (!ok) throw new Error("malformed fields");
	const config = validateConfig(s.config);
	const ids = new Set<number>();
	for (const item of s.queue!) {
		validateItem(item);
		if (ids.has(item.id) || item.id >= s.nextId!) throw new Error("duplicate queue id or id beyond nextId");
		ids.add(item.id);
	}
	for (const entry of s.log!) if (!entry || !isTime(entry.at) || typeof entry.text !== "string" || Buffer.byteLength(entry.text) > MAX_LOG_BYTES + 3) throw new Error("malformed log entry");
	for (const [user, hits] of Object.entries(s.userHits!)) if (!config.inboundUsers.includes(user) || !Array.isArray(hits) || hits.length > USER_COMMANDS || !hits.every(isTime)) throw new Error("malformed command history");
	if (s.enabled && !modeOf(config)) throw new Error("the bridge is on without a webhook or bot configuration");
	return s as DiscordState;
}

/** The stored state; a missing file is the defaults (off). Never writes. */
export function readDiscord(host: FeatureHost): DiscordState {
	return readState(discordFile(host.home), emptyState, validateState);
}

const update = <R>(host: FeatureHost, fn: (current: DiscordState) => { state?: DiscordState; result: R }): Promise<R> =>
	updateState(discordFile(host.home), emptyState, validateState, fn);

function capBytes(text: string, max: number): string {
	if (Buffer.byteLength(text) <= max) return text;
	let out = "";
	let bytes = 0;
	for (const ch of text) {
		const n = Buffer.byteLength(ch);
		if (bytes + n > max - 3) break;
		out += ch;
		bytes += n;
	}
	return `${out}…`;
}

/** Append a log entry (bounded, no message content). */
function note(state: DiscordState, now: number, text: string): void {
	state.log.push({ at: now, text: capBytes(text, MAX_LOG_BYTES) });
	if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
}

// ---- Outbound text ------------------------------------------------------------------------------

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_RE = new RegExp(`${ESC}(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?|[@-Z\\\\-_])`, "g");
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+|\bwww\.\S+|\bdiscord(?:app)?\.(?:com|gg)\b\S*/gi;
// An absolute POSIX, home-relative, drive-letter or UNC path that starts a word (or follows = , ; : ( [ quote).
const PATH_RE = /(?<=^|[\s("'[=,;:])(?:~\/|[A-Za-z]:[\\/]|\\\\|\/)[^\s"')\],;]*/g;
// Discord credential shapes on top of the shared screen: a bot token (three dot-separated base64url parts) and a webhook URL.
const DISCORD_SECRET_RE = /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}\b|discord(?:app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+/i;

const ZWSP = "\u200b";
/** One character as it may appear in a post: mentions and markdown neutralised. */
function unit(ch: string): string {
	switch (ch) {
		case "@":
		case "<":
			return ch + ZWSP;
		case "\\":
		case "*":
		case "_":
		case "~":
		case "`":
		case "|":
		case ">":
		case "[":
		case "]":
			return `\\${ch}`;
		default:
			return ch;
	}
}

/**
 * One free-text field as Discord may receive it: one line, credential-looking text replaced by `(withheld)`, links and
 * absolute paths replaced, mentions (`@`, `<`) and markdown neutralised, then cut to `max` UTF-8 bytes of the FINAL text
 * (an ellipsis included, never inside a character or an escape).
 */
export function cleanText(raw: string, max: number): string {
	let text = raw.replace(ANSI_RE, "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim();
	if (!text) return "(empty)";
	if (looksLikeSecret(text) || DISCORD_SECRET_RE.test(text)) return "(withheld)";
	text = text.replace(URL_RE, "(link removed)").replace(PATH_RE, "(path removed)");
	const units = [...text].map(unit);
	const sizes = units.map(u => Buffer.byteLength(u));
	if (sizes.reduce((a, b) => a + b, 0) <= max) return units.join("");
	let out = "";
	let bytes = 0;
	for (let i = 0; i < units.length; i++) {
		if (bytes + sizes[i] > max - 3) break;
		out += units[i];
		bytes += sizes[i];
	}
	return `${out}…`;
}

const idText = (id: string): string => (PEER_ID_RE.test(id) ? id : "?");
const who = (id: string, name: string, includeNames: boolean): string => (includeNames ? `${cleanText(name, MAX_NAME_BYTES)} (${idText(id)})` : idText(id));

function detail(report: Report): string {
	switch (report.kind) {
		case "DONE": return report.evidence.description;
		case "BLOCKED": return report.blocker;
		case "WAITING": return report.nextAction;
		case "DECISION": return report.question;
	}
}

/** The post for an accepted report: `**<KIND>** <id>: <unit>: <detail>`. The sender identity is the sender's own claim. */
export function formatReport(report: Report, from: { id: string; name: string }, includeNames: boolean): string {
	return `**${report.kind}** ${who(from.id, from.name, includeNames)}: ${cleanText(`${report.unit}: ${detail(report)}`, MAX_SUMMARY_BYTES)}`;
}

/** The only request body this module ever sends: the text, and no mention of anyone allowed. */
export function buildPayload(text: string): string {
	return JSON.stringify({ content: text, allowed_mentions: { parse: [] } });
}

// ---- Credentials --------------------------------------------------------------------------------

export type Credential = { mode: "webhook"; url: string; id: string } | { mode: "bot"; token: string; channel: string };

/** Read and validate the configured credential. Throws an Error that never contains the credential. */
export function credential(config: Config): Credential {
	if (config.webhookFile) {
		const url = readSecretFile(config.webhookFile);
		const match = WEBHOOK_RE.exec(url);
		if (!match) throw new Error(`webhook file ${config.webhookFile} does not hold a Discord webhook URL (https://discord.com/api/webhooks/<id>/<token>, nothing else)`);
		return { mode: "webhook", url, id: match[1] };
	}
	if (config.botTokenFile && config.channel) {
		const value = readSecretFile(config.botTokenFile);
		if (!CREDENTIAL_RE.test(value)) throw new Error(`bot token file ${config.botTokenFile} must hold one token of printable characters without spaces`);
		return { mode: "bot", token: value, channel: config.channel };
	}
	throw new Error("not configured: set webhook-file <path>, or set bot-token-file <path> and set channel <id>");
}

export const redactedWebhook = (id: string): string => `…/webhooks/${id}/<redacted>`;

// ---- HTTP ---------------------------------------------------------------------------------------

interface Reply {
	status: number;
	type: string;
	retryAfter: string | null;
	text: string;
}

async function readBounded(res: Response): Promise<string> {
	if (!res.body) return "";
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > RESPONSE_LIMIT) {
			await reader.cancel();
			throw new Error("response too large");
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** One bounded request: no redirects followed, a timeout, a size-limited body. Failures are fixed strings, never an error message. */
async function call(url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string }): Promise<Reply | { error: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), seam.timeoutMs);
	try {
		const res = await seam.fetch(url, { ...init, redirect: "manual", signal: controller.signal });
		const text = res.status >= 200 && res.status < 300 && init.method === "POST" ? "" : await readBounded(res);
		if (init.method === "POST") await res.body?.cancel().catch(() => {});
		return { status: res.status, type: res.type, retryAfter: res.headers.get("retry-after"), text };
	} catch {
		return { error: controller.signal.aborted ? "timeout" : "network error" };
	} finally {
		clearTimeout(timer);
	}
}

export type Outcome =
	| { kind: "ok" }
	| { kind: "auth"; code: number }
	| { kind: "rate"; waitMs?: number }
	| { kind: "retry"; reason: string }
	| { kind: "drop"; reason: string };

function waitFrom(reply: Reply): number | undefined {
	let seconds: number | undefined;
	if (reply.retryAfter !== null && /^[0-9]+(?:\.[0-9]+)?$/.test(reply.retryAfter.trim())) seconds = Number(reply.retryAfter);
	else {
		try {
			const body = JSON.parse(reply.text) as { retry_after?: unknown };
			if (typeof body.retry_after === "number" && Number.isFinite(body.retry_after) && body.retry_after >= 0) seconds = body.retry_after;
		} catch {
			// no usable body
		}
	}
	return seconds === undefined ? undefined : Math.min(Math.max(Math.ceil(seconds * 1000), 1000), MAX_WAIT_MS);
}

export function classify(reply: Reply | { error: string }): Outcome {
	if ("error" in reply) return { kind: "retry", reason: reply.error };
	const { status } = reply;
	if (status >= 200 && status < 300) return { kind: "ok" };
	if (status === 0 || reply.type === "opaqueredirect" || (status >= 300 && status < 400)) return { kind: "drop", reason: status >= 300 ? `http ${status} (redirect refused)` : "redirect refused" };
	if (status === 401 || status === 403) return { kind: "auth", code: status };
	if (status === 429) return { kind: "rate", waitMs: waitFrom(reply) };
	if (status >= 500) return { kind: "retry", reason: `http ${status}` };
	return { kind: "drop", reason: `http ${status}` };
}

/** Where a post for `cred` goes. A webhook keeps its validated path; only the loopback test override replaces the origin. */
export function postTarget(cred: Credential): { url: string; headers: Record<string, string> } {
	const common = { "Content-Type": "application/json", "User-Agent": agent() };
	if (cred.mode === "webhook") {
		const url = API.override ? `${API.base.replace(/\/api\/v10$/, "")}${new URL(cred.url).pathname}` : cred.url;
		return { url, headers: common };
	}
	return { url: `${API.base}/channels/${cred.channel}/messages`, headers: { ...common, Authorization: `Bot ${cred.token}` } };
}

// ---- Sending ------------------------------------------------------------------------------------

interface Notice {
	text: string;
}

const inFlight = (s: DiscordState, now: number) => s.queue.some(q => q.leaseUntil !== undefined && q.leaseUntil > now);
const windowTimes = (s: DiscordState, now: number) => s.sentTimes.filter(t => t > now - HOUR);

/** Why nothing may be sent right now, or undefined when a request may start. */
function sendBlock(s: DiscordState, now: number): string | undefined {
	if (!s.enabled) return "the bridge is off";
	if (s.pausedUntil !== undefined && now < s.pausedUntil) return `the circuit breaker is open for ${Math.ceil((s.pausedUntil - now) / 60_000)} more minute(s)`;
	if (inFlight(s, now)) return "another send is in progress";
	const used = windowTimes(s, now).length;
	if (used >= s.config.rateLimit) return `the rate limit is reached (${used}/${s.config.rateLimit} requests in the last hour)`;
	return undefined;
}

/** Mark `item` as being sent now: one more attempt, a lease and a slot in the rate window. */
function claim(s: DiscordState, item: QueueItem, now: number): void {
	item.attempts += 1;
	item.leaseUntil = now + LEASE_MS;
	s.sentTimes = [...windowTimes(s, now), now];
}

/** Count one failed request; the fifth in a row opens the breaker. */
function failed(s: DiscordState, now: number, notices: Notice[]): void {
	s.failures += 1;
	if (s.failures < BREAKER_FAILURES) return;
	s.failures = 0;
	s.pausedUntil = now + BREAKER_PAUSE_MS;
	note(s, now, `circuit breaker: sending and polling paused ${BREAKER_PAUSE_MS / 60_000} min after ${BREAKER_FAILURES} consecutive failures`);
	notices.push({ text: `discord bridge paused for ${BREAKER_PAUSE_MS / 60_000} minutes after ${BREAKER_FAILURES} consecutive failures` });
}

/** Stop the bridge after Discord refused the credential: nothing more is sent or polled and the queue is discarded. */
function stop(s: DiscordState, now: number, code: number, notices: Notice[]): void {
	s.enabled = false;
	s.queue = [];
	s.stopped = AUTH_STOPPED;
	s.failures = 0;
	note(s, now, `${AUTH_STOPPED} (http ${code})`);
	notices.push({ text: `discord: ${AUTH_STOPPED} (http ${code}); check the credential, then /peers discord on` });
}

export interface SendResult {
	delivered: boolean;
	/** Human text for `test`; the log has the same facts. */
	text: string;
}

/** Record how a claimed request ended. Runs under the lock. */
function settle(s: DiscordState, item: { id: number; kind: Kind }, outcome: Outcome, now: number, notices: Notice[]): string {
	if (!s.enabled) return "bridge turned off meanwhile";
	const index = s.queue.findIndex(q => q.id === item.id);
	const queued = index >= 0 ? s.queue[index] : undefined;
	const remove = () => {
		if (index >= 0) s.queue.splice(index, 1);
	};
	switch (outcome.kind) {
		case "ok":
			remove();
			s.sent = Math.min(s.sent + 1, COUNTER_CAP);
			s.failures = 0;
			note(s, now, `sent #${item.id} (${item.kind})`);
			return "delivered";
		case "auth":
			stop(s, now, outcome.code, notices);
			return `${AUTH_STOPPED} (http ${outcome.code})`;
		case "drop": {
			remove();
			s.dropped = Math.min(s.dropped + 1, COUNTER_CAP);
			note(s, now, `failed #${item.id}: ${outcome.reason}`);
			failed(s, now, notices);
			return outcome.reason;
		}
		case "rate":
		case "retry": {
			const reason = outcome.kind === "rate" ? "http 429" : outcome.reason;
			failed(s, now, notices);
			if (!queued) return reason;
			if (item.kind === "test" || queued.attempts >= MAX_ATTEMPTS) {
				remove();
				s.dropped = Math.min(s.dropped + 1, COUNTER_CAP);
				note(s, now, item.kind === "test" ? `failed #${item.id}: ${reason}` : `failed #${item.id}: gave up after ${queued.attempts} attempts (${reason})`);
				return reason;
			}
			const wait = outcome.kind === "rate" && outcome.waitMs !== undefined ? outcome.waitMs : BACKOFF_MS[queued.attempts - 1];
			queued.notBefore = now + wait;
			delete queued.leaseUntil;
			note(s, now, `retry #${item.id} in ${Math.ceil(wait / 1000)} s (${reason}, attempt ${queued.attempts} of ${MAX_ATTEMPTS})`);
			return `${reason}; will retry in ${Math.ceil(wait / 1000)} s`;
		}
	}
}

/** A message this process claimed to send, with the configuration to send it by. */
interface Claimed {
	item: { id: number; kind: Kind; text: string };
	config: Config;
}

/** Send one claimed message and settle it. */
async function transmit(host: FeatureHost, item: { id: number; kind: Kind; text: string }, config: Config): Promise<SendResult> {
	let outcome: Outcome;
	try {
		const cred = credential(config);
		const target = postTarget(cred);
		outcome = classify(await call(target.url, { method: "POST", headers: target.headers, body: buildPayload(item.text) }));
	} catch (error) {
		outcome = { kind: "retry", reason: `credential: ${(error as Error).message}`.slice(0, 120) };
	}
	const notices: Notice[] = [];
	const now = host.now();
	const text = await update(host, s => ({ state: s, result: settle(s, item, outcome, now, notices) }));
	for (const notice of notices) host.notify(notice.text);
	return { delivered: outcome.kind === "ok", text };
}

/** Send the oldest eligible queued message, if any rule allows a request now. At most one request per call. */
export async function pump(host: FeatureHost): Promise<void> {
	const now = host.now();
	const picked = await update(host, s => {
		if (sendBlock(s, now) !== undefined) return { result: undefined };
		const item = s.queue.find(q => q.notBefore <= now);
		if (!item) return { result: undefined };
		claim(s, item, now);
		return { state: s, result: { item: { id: item.id, kind: item.kind, text: item.text }, config: s.config } };
	});
	if (picked) await transmit(host, picked.item, picked.config);
}

/** Append a message, dropping the oldest unclaimed one when the queue is full. */
function push(s: DiscordState, kind: Kind, text: string, now: number): { item: QueueItem } {
	let dropped = 0;
	if (s.queue.length >= MAX_QUEUE) {
		const oldest = s.queue.findIndex(q => q.leaseUntil === undefined || q.leaseUntil <= now);
		s.queue.splice(oldest >= 0 ? oldest : 0, 1);
		dropped = 1;
	}
	const item: QueueItem = { id: s.nextId, kind, text, attempts: 0, notBefore: 0 };
	s.nextId++;
	s.queue.push(item);
	if (dropped) {
		s.dropped = Math.min(s.dropped + 1, COUNTER_CAP);
		note(s, now, `dropped 1 oldest message: queue full (${MAX_QUEUE})`);
	}
	return { item };
}

/** Queue messages under the lock. Nothing is queued while the bridge is off. */
async function enqueue(host: FeatureHost, messages: Array<{ kind: Kind; text: string }>): Promise<void> {
	const now = host.now();
	await update(host, s => {
		if (!s.enabled || !messages.length) return { result: undefined };
		for (const message of messages) if (Buffer.byteLength(message.text) <= MAX_MESSAGE_BYTES) push(s, message.kind, message.text, now);
		return { state: s, result: undefined };
	});
}

// ---- Inbound ------------------------------------------------------------------------------------

const snowflakeMs = (id: string): number => Number(BigInt(id) >> 22n) + DISCORD_EPOCH;

interface InboundMessage {
	id: string;
	content: string;
	author: string;
	bot: boolean;
}

function parseMessages(text: string): InboundMessage[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed) || parsed.length > POLL_LIMIT) return undefined;
	const out: InboundMessage[] = [];
	for (const raw of parsed as Array<Record<string, unknown> | null>) {
		const author = raw?.author as { id?: unknown; bot?: unknown } | undefined;
		if (!raw || typeof raw.id !== "string" || !SNOWFLAKE_RE.test(raw.id) || !author || typeof author.id !== "string" || !SNOWFLAKE_RE.test(author.id)) continue;
		// A bot or webhook message is never a user command, whatever its content says.
		out.push({ id: raw.id, content: typeof raw.content === "string" ? raw.content : "", author: author.id, bot: author.bot === true || raw.webhook_id !== undefined });
	}
	return out;
}

const compareIds = (a: string, b: string): number => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);

/**
 * The command word of `content`, or undefined when the message is not addressed to the bridge. Anything past the
 * single word, an unknown word or an empty word is the unknown command (`""` is returned for those).
 */
export function parseCommand(content: string): string | undefined {
	if (Buffer.byteLength(content) > MAX_INBOUND_BYTES || !content.startsWith(COMMAND_PREFIX)) return undefined;
	const words = content.slice(COMMAND_PREFIX.length).trim().split(/\s+/);
	return words.length === 1 && (INBOUND_COMMANDS as readonly string[]).includes(words[0]) ? words[0] : "";
}

async function replyFor(host: FeatureHost, command: string): Promise<string> {
	switch (command) {
		case "status": return statusReply(readDiscord(host), host.now());
		case "help": return HELP_REPLY;
		case "list": return listReply(host);
		default: return UNKNOWN_REPLY;
	}
}

function statusReply(s: DiscordState, now: number): string {
	const breaker = s.pausedUntil !== undefined && now < s.pausedUntil ? "open" : "closed";
	return `discord bridge: ${s.enabled ? "on" : "off"}; mode ${modeOf(s.config) ?? "none"}; queued ${s.queue.length}; requests in last hour ${windowTimes(s, now).length}/${s.config.rateLimit}; breaker ${breaker}`;
}

async function listReply(host: FeatureHost): Promise<string> {
	const includeNames = readDiscord(host).config.includeNames;
	let peers;
	try {
		peers = await host.peers();
	} catch {
		return "list unavailable";
	}
	const rows = peers.slice(0, MAX_LIST_ROWS).map(p => `${who(p.id, p.name, includeNames)} ${p.busy === undefined ? "unknown" : p.busy ? "busy" : "idle"}${p.paused === true ? " paused" : ""}`);
	return [`sessions: ${peers.length}`, ...rows, ...(peers.length > MAX_LIST_ROWS ? [`… ${peers.length - MAX_LIST_ROWS} more`] : [])].join("\n");
}

/** Poll the configured channel once (when due) and answer allowlisted users' read-only commands. */
export async function poll(host: FeatureHost): Promise<void> {
	const now = host.now();
	const claimed = await update(host, s => {
		if (!s.enabled || !s.config.inbound || modeOf(s.config) !== "bot") return { result: undefined };
		if (s.pausedUntil !== undefined && now < s.pausedUntil) return { result: undefined };
		if (now - s.lastPollAt < POLL_INTERVAL_MS) return { result: undefined };
		s.lastPollAt = now;
		return { state: s, result: { cursor: s.cursor, config: s.config } };
	});
	if (!claimed) return;
	const notices: Notice[] = [];
	let reply: Reply | { error: string };
	try {
		const cred = credential(claimed.config);
		if (cred.mode !== "bot") return;
		const query = claimed.cursor === undefined ? "limit=1" : `limit=${POLL_LIMIT}&after=${claimed.cursor}`;
		reply = await call(`${API.base}/channels/${cred.channel}/messages?${query}`, { method: "GET", headers: { "User-Agent": agent(), Authorization: `Bot ${cred.token}` } });
	} catch (error) {
		reply = { error: `credential: ${(error as Error).message}`.slice(0, 120) };
	}
	const outcome = classify(reply);
	const messages = outcome.kind === "ok" ? parseMessages((reply as Reply).text) : undefined;
	const commands = await update(host, s => {
		if (!s.enabled || s.cursor !== claimed.cursor) return { result: [] as Array<{ user: string; word: string }> };
		if (outcome.kind === "auth") {
			stop(s, now, outcome.code, notices);
			return { state: s, result: [] };
		}
		if (outcome.kind !== "ok" || !messages) {
			const reason = outcome.kind === "ok" ? "invalid response" : outcome.kind === "rate" ? "http 429" : outcome.reason;
			if (outcome.kind === "rate") s.lastPollAt = now + (outcome.waitMs ?? POLL_INTERVAL_MS) - POLL_INTERVAL_MS;
			note(s, now, `poll failed: ${reason}`);
			failed(s, now, notices);
			return { state: s, result: [] };
		}
		s.failures = 0;
		const sorted = [...messages].sort((a, b) => compareIds(a.id, b.id));
		const found: Array<{ user: string; word: string }> = [];
		// The first poll only records where the channel is now: history is never executed.
		if (claimed.cursor !== undefined) {
			for (const message of sorted) {
				const age = now - snowflakeMs(message.id);
				// `after` is the server's job; an id at or before the cursor is never executed twice even if a server repeats it.
				if (compareIds(message.id, claimed.cursor) <= 0 || message.bot || age > MAX_COMMAND_AGE_MS || age < -MAX_FUTURE_SKEW_MS || !s.config.inboundUsers.includes(message.author)) continue;
				const word = parseCommand(message.content);
				if (word === undefined) continue;
				const hits = (s.userHits[message.author] ?? []).filter(t => t > now - USER_WINDOW_MS);
				if (hits.length >= USER_COMMANDS) continue;
				s.userHits[message.author] = [...hits, now];
				found.push({ user: message.author, word });
			}
		}
		const newest = sorted.length ? sorted[sorted.length - 1].id : undefined;
		if (claimed.cursor === undefined) s.cursor = newest ?? "0";
		else if (newest !== undefined && compareIds(newest, claimed.cursor) > 0) s.cursor = newest;
		if (found.length) note(s, now, `inbound: ${found.length} command(s) answered`);
		return { state: s, result: found };
	});
	for (const notice of notices) host.notify(notice.text);
	if (!commands.length) return;
	await enqueue(host, await Promise.all(commands.map(async c => ({ kind: "reply" as const, text: await replyFor(host, c.word) }))));
}

// ---- Feature hooks -------------------------------------------------------------------------------

/** A report this (master) session accepted becomes one queued post. Never a reply, notice or anything from Discord. */
async function onReport(report: Report, from: { id: string; name: string }, host: FeatureHost): Promise<void> {
	if (!host.isMaster()) return;
	const state = readDiscord(host);
	if (!state.enabled) return;
	await enqueue(host, [{ kind: "report", text: formatReport(report, from, state.config.includeNames) }]);
}

async function tick(host: FeatureHost): Promise<void> {
	if (!warnedBase) {
		warnedBase = true;
		if (API.warning) host.notify(API.warning);
	}
	if (!host.isMaster() || !readDiscord(host).enabled) return;
	await poll(host);
	await pump(host);
}

// ---- Commands -----------------------------------------------------------------------------------

const fmtTime = (ms: number) => new Date(ms).toISOString();

function describeConfig(config: Config): string[] {
	const mode = modeOf(config);
	const lines = [`mode: ${mode ?? "not configured"}`];
	if (config.webhookFile) lines.push(`webhook file: ${config.webhookFile}`);
	if (config.botTokenFile) lines.push(`bot token file: ${config.botTokenFile}`);
	if (config.channel) lines.push(`channel: ${config.channel}`);
	if (mode) {
		try {
			const cred = credential(config);
			lines.push(`credential: readable (${cred.mode === "webhook" ? redactedWebhook(cred.id) : "bot token not shown"})`);
		} catch (error) {
			lines.push(`credential: problem: ${(error as Error).message}`);
		}
	}
	lines.push(`include names: ${config.includeNames ? "on" : "off (ids only)"}`, `rate limit: ${config.rateLimit} requests per rolling hour`);
	lines.push(`inbound: ${config.inbound ? "on" : "off"}${config.inbound && !config.inboundUsers.length ? " (allowlist is empty: nothing is accepted)" : ""}`);
	if (config.inboundUsers.length) lines.push(`inbound users: ${config.inboundUsers.join(" ")}`);
	return lines;
}

function renderStatus(host: FeatureHost): string {
	const s = readDiscord(host);
	const now = host.now();
	const lines = [`discord bridge: ${s.enabled ? "on" : "off (opt-in; /peers discord on enables it)"}`];
	if (s.stopped) lines.push(`stopped: ${s.stopped}`);
	lines.push(...describeConfig(s.config));
	const used = windowTimes(s, now).length;
	lines.push(`queued: ${s.queue.length} of ${MAX_QUEUE}; sent: ${s.sent}; dropped: ${s.dropped}; requests in last hour: ${used}/${s.config.rateLimit}`);
	lines.push(s.pausedUntil !== undefined && now < s.pausedUntil ? `circuit breaker: open until ${fmtTime(s.pausedUntil)}` : `circuit breaker: closed (${s.failures} consecutive failure(s) of ${BREAKER_FAILURES})`);
	if (s.config.inbound) lines.push(`inbound cursor: ${s.cursor ? "recorded" : "none (the first poll records the channel position and runs nothing)"}`);
	lines.push(`role: ${host.isMaster() ? "this session is the master and runs the bridge" : "this session is not the master; the bridge runs in the master only"}`);
	return lines.join("\n");
}

function renderLog(host: FeatureHost): string {
	const { log } = readDiscord(host);
	return log.length ? log.map(e => `${fmtTime(e.at)} ${e.text}`).join("\n") : "discord log: empty";
}

const ON_TEXT = (s: DiscordState): string =>
	`discord bridge on (${modeOf(s.config)}): the master posts each report it accepts to the configured channel; nothing is sent to any session. ` +
	`Limits: queue ${MAX_QUEUE}, ${s.config.rateLimit} requests/hour, ${MAX_ATTEMPTS} attempts per message, breaker after ${BREAKER_FAILURES} consecutive failures. ` +
	`${s.config.inbound ? `Inbound is on for ${s.config.inboundUsers.length} user(s): read-only !peers status|list|help. ` : "Inbound is off. "}` +
	"Stop: /peers discord off, then delete the credential file and revoke it in Discord";

async function turnOn(host: FeatureHost): Promise<string> {
	const current = readDiscord(host);
	if (current.enabled) return "discord bridge is already on";
	if (!modeOf(current.config)) return "error: not configured: set webhook-file <path>, or set bot-token-file <path> and set channel <id>";
	try {
		credential(current.config);
	} catch (error) {
		return `error: cannot turn on: ${(error as Error).message}`;
	}
	const now = host.now();
	return update(host, s => {
		if (s.enabled) return { result: "discord bridge is already on" };
		s.enabled = true;
		s.failures = 0;
		delete s.pausedUntil;
		delete s.stopped;
		s.lastPollAt = 0;
		note(s, now, "bridge on");
		return { state: s, result: ON_TEXT(s) };
	});
}

async function turnOff(host: FeatureHost): Promise<string> {
	// A bridge that is already off writes nothing, not even a lock file.
	if (!readDiscord(host).enabled) return "discord bridge is already off";
	const now = host.now();
	return update(host, s => {
		if (!s.enabled) return { result: "discord bridge is already off" };
		const dropped = s.queue.length;
		s.enabled = false;
		s.queue = [];
		note(s, now, `bridge off; ${dropped} queued message(s) discarded`);
		return { state: s, result: `discord bridge off: sending and polling stopped; ${dropped} queued message(s) discarded; the inbound cursor is kept. Delete the credential file and revoke it in Discord to remove access completely` };
	});
}

async function clearQueue(host: FeatureHost): Promise<string> {
	if (!readDiscord(host).queue.length) return "queue is empty";
	const now = host.now();
	return update(host, s => {
		const dropped = s.queue.length;
		if (!dropped) return { result: "queue is empty" };
		s.queue = [];
		note(s, now, `queue cleared: ${dropped} message(s) discarded`);
		return { state: s, result: `queue cleared: ${dropped} message(s) discarded` };
	});
}

/** Post the fixed test message now, under the same rate limit, breaker and bookkeeping as every other post. */
async function testPost(host: FeatureHost): Promise<string> {
	const now = host.now();
	const picked = await update<{ error: string } | Claimed>(host, s => {
		const block = sendBlock(s, now);
		if (block) return { result: { error: block } };
		const { item } = push(s, "test", TEST_MESSAGE, now);
		claim(s, item, now);
		return { state: s, result: { item: { id: item.id, kind: item.kind, text: item.text }, config: s.config } };
	});
	if ("error" in picked) return `not delivered: ${picked.error}; nothing was sent`;
	const sent = await transmit(host, picked.item, picked.config);
	return sent.delivered ? "test message delivered" : `not delivered: ${sent.text}`;
}

function parseOnOff(value: string | undefined): boolean | undefined {
	return value === "on" ? true : value === "off" ? false : undefined;
}

async function setCommand(host: FeatureHost, args: string[]): Promise<string> {
	const [key, ...values] = args;
	if (!key) return `error: usage: /peers discord set <key> <value>; keys: ${SET_KEYS}`;
	const apply = async (fn: (config: Config) => string | undefined, resetCursor = false, message = "set"): Promise<string> =>
		update(host, s => {
			const next: Config = { ...s.config, inboundUsers: [...s.config.inboundUsers] };
			const refused = fn(next);
			if (refused) return { result: `error: ${refused}` };
			if (s.enabled && !modeOf(next)) return { result: "error: the bridge is on; run /peers discord off before removing its credential" };
			// Without a bot configuration there is no inbound; the channel position belongs to one channel.
			if (modeOf(next) !== "bot") next.inbound = false;
			if (!next.inbound || resetCursor) delete s.cursor;
			s.userHits = Object.fromEntries(Object.entries(s.userHits).filter(([user]) => next.inbound && next.inboundUsers.includes(user)));
			s.config = next;
			note(s, host.now(), message);
			return { state: s, result: `set ${key}` };
		});
	const single = (): string | undefined => (values.length === 1 ? values[0] : undefined);
	switch (key) {
		case "webhook-file":
		case "bot-token-file": {
			const value = single();
			if (value === undefined) return `error: usage: /peers discord set ${key} <absolute path>|none`;
			const field = key === "webhook-file" ? "webhookFile" : "botTokenFile";
			if (value === "none") return apply(config => void delete config[field], false, `${key} cleared`);
			if (!isAbsolutePath(value)) return "error: the path must be absolute, without spaces";
			const probe: Config = { ...defaults(), ...(field === "webhookFile" ? { webhookFile: value } : { botTokenFile: value, channel: "00000" }) };
			try {
				credential(probe);
			} catch (error) {
				return `error: ${(error as Error).message}`;
			}
			const other = field === "webhookFile" ? "bot" : "webhook";
			return apply(config => {
				if (field === "webhookFile" ? config.botTokenFile || config.channel : config.webhookFile) return `${other} mode is configured; clear it first (set ${other === "bot" ? "bot-token-file none and set channel none" : "webhook-file none"})`;
				config[field] = path.resolve(value);
				return undefined;
			}, false, `${key} set`);
		}
		case "channel": {
			const value = single();
			if (value === undefined) return "error: usage: /peers discord set channel <channel id>|none";
			if (value === "none") return apply(config => void delete config.channel, true, "channel cleared");
			if (!SNOWFLAKE_RE.test(value)) return "error: a channel id is 5 to 25 digits";
			return apply(config => {
				if (config.webhookFile) return "webhook mode is configured; clear it first (set webhook-file none)";
				config.channel = value;
				return undefined;
			}, true, "channel set");
		}
		case "include-names": {
			const value = parseOnOff(single());
			if (value === undefined) return "error: usage: /peers discord set include-names on|off";
			return apply(config => void (config.includeNames = value), false, `include-names ${value ? "on" : "off"}`);
		}
		case "rate-limit": {
			const value = single();
			const n = value !== undefined && /^[0-9]{1,3}$/.test(value) ? Number(value) : NaN;
			if (!(n >= MIN_RATE && n <= MAX_RATE)) return `error: rate-limit must be a whole number from ${MIN_RATE} to ${MAX_RATE} (requests per rolling hour)`;
			return apply(config => void (config.rateLimit = n), false, `rate-limit ${n}`);
		}
		case "inbound": {
			const value = parseOnOff(single());
			if (value === undefined) return "error: usage: /peers discord set inbound on|off";
			const result = await apply(config => {
				if (value && modeOf(config) !== "bot") return "inbound needs bot mode (bot-token-file and channel); a webhook can only post";
				config.inbound = value;
				return undefined;
			}, value, `inbound ${value ? "on" : "off"}`);
			return result.startsWith("error:") ? result : value ? "set inbound on: read-only !peers status|list|help from allowlisted users only (see set inbound-users); the first poll records the channel position and runs nothing" : "set inbound off";
		}
		case "inbound-users": {
			const users = values.length === 1 && values[0] === "none" ? [] : values;
			if (users.length > MAX_USERS) return `error: at most ${MAX_USERS} user ids`;
			if (!users.every(u => SNOWFLAKE_RE.test(u)) || new Set(users).size !== users.length) return "error: user ids are 5 to 25 digits each, without repeats (or none)";
			if (!values.length) return "error: usage: /peers discord set inbound-users <user id>... | none";
			return apply(config => void (config.inboundUsers = users), false, `inbound-users set (${users.length})`);
		}
		default:
			return `error: unknown key "${key}"; keys: ${SET_KEYS}`;
	}
}

async function command(args: string[], host: FeatureHost): Promise<string> {
	const [sub = "status", ...rest] = args;
	try {
		switch (sub) {
			case "status": return rest.length ? USAGE : renderStatus(host);
			case "log": return rest.length ? USAGE : renderLog(host);
			// Stopping is never gated: any session may switch the bridge off.
			case "off": return rest.length ? USAGE : await turnOff(host);
			case "on":
			case "test":
			case "clear-queue":
			case "set": {
				if (!host.isMaster()) return `error: ${MASTER_ONLY}`;
				if (sub === "set") return await setCommand(host, rest);
				if (rest.length) return USAGE;
				return sub === "on" ? await turnOn(host) : sub === "test" ? await testPost(host) : await clearQueue(host);
			}
			default: return USAGE;
		}
	} catch (error) {
		return `error: ${(error as Error).message}`;
	}
}

export const discord: Feature = { name: "discord", command, onReport, tick };
