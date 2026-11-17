// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FEATURES } from "../../lib/features";
import { addMember, groupsFile, groupsOf, MAX_MEMBERS, readGroups, removeMember } from "../../lib/features/groups";
import type { FeatureHost, ModelApply, ModelCheck } from "../../lib/features/host";
import { addRule, agentContext, readRules, removeRule, rules, rulesFile } from "../../lib/features/rules";
import { MAX_SELECTOR, MAX_TEMPLATE_GROUPS, MAX_TEMPLATE_RULES, MAX_TEMPLATES, readTemplates, startupTemplate, templates, templatesFile, type TemplatesState } from "../../lib/features/templates";

const A = "p00000000000000a1";
const B = "p00000000000000b2";
const MASTER = "p00000000000000aa";
const NOT_AVAILABLE = "not among the available models (unknown, unauthenticated or invalid selector)";

interface Session {
	id: string;
	name: string;
	model?: string;
	master: boolean;
	accepts: boolean;
}

let home: string;
let sessions: Record<string, Session>;
/** Available model -> whether its credentials are present. */
let available: Map<string, boolean>;
let modelCalls: { resolve: number; apply: number };
/** Runs right after a model switch succeeded: lets a test change shared state between plan and the later steps. */
let afterApply: (() => Promise<void>) | undefined;

beforeEach(() => {
	home = fs.mkdtempSync(path.join("/tmp", "opf-"));
	sessions = {
		[A]: { id: A, name: "worker-a", model: "prov/b", master: false, accepts: true },
		[B]: { id: B, name: "worker-b", model: "prov/b", master: false, accepts: true },
		[MASTER]: { id: MASTER, name: "master", model: "prov/b", master: true, accepts: true },
	};
	available = new Map([["prov/a", true], ["prov/b", true], ["prov/nokey", false]]);
	modelCalls = { resolve: 0, apply: 0 };
	afterApply = undefined;
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function check(session: Session, selector: string): ModelCheck {
	if (selector.includes(":")) return { ok: false, error: "the selector carries a thinking level; templates do not set one" };
	const model = [...available.keys()].find(name => name === selector || name.endsWith(`/${selector}`));
	if (!model) return { ok: false, error: NOT_AVAILABLE };
	if (!available.get(model)) return { ok: false, error: "no credentials for this model" };
	return { ok: true, model, current: session.model };
}

function host(id: string): FeatureHost {
	const session = sessions[id];
	return {
		home,
		now: () => 1_700_000_000_000,
		self: () => ({ id, name: session.name }),
		isMaster: () => session.master,
		acceptsRemote: () => session.accepts,
		peers: async () => Object.values(sessions).map(s => ({ id: s.id, name: s.name })),
		groupsOf: peerId => groupsOf(home, peerId),
		resolveGroup: async () => ({ recipients: [], skipped: [] }), // not exercised by this suite
		send: async () => ({ status: "offline" }),
		resolveModel: async selector => {
			modelCalls.resolve++;
			return check(session, selector);
		},
		applyModel: async (selector): Promise<ModelApply> => {
			modelCalls.apply++;
			const result = check(session, selector);
			if (!result.ok) return result;
			session.model = result.model;
			await afterApply?.();
			return { ok: true, model: result.model, previous: result.current };
		},
	};
}

const say = (args: string, id = A) => templates.command(args.split(/\s+/).filter(Boolean), host(id));
const storedTemplates = (): TemplatesState => JSON.parse(fs.readFileSync(templatesFile(home), "utf8"));
const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
/** Every byte the feature could touch: its own store, rules, groups, and each session's model. */
const snapshot = () => JSON.stringify({ templates: read(templatesFile(home)), rules: read(rulesFile(home)), groups: read(groupsFile(home)), models: Object.values(sessions).map(s => s.model) });
const FULL = "add web --model prov/a --prompt Review carefully. --rule Prefer small diffs --group frontend";
const plannedLines = (text: string) => text.split("\n").slice(text.split("\n").findIndex(l => l.startsWith("for this session")) + 1).filter(l => l.startsWith("  "));
const appliedLines = (text: string) => text.split("\n").slice(1).filter(l => l.startsWith("  "));

describe("storage and validation", () => {
	test("is registered as /peers templates", () => {
		expect(FEATURES.map(f => f.name)).toContain("templates");
	});

	test("add, list and remove print exact results; the file is private, versioned and holds only the template", async () => {
		expect(await say("list")).toBe("no templates");
		expect(await say(FULL)).toBe("added template web; review it with /peers templates show web");
		expect(await say("add Docs --rule Keep docs short")).toBe("added template docs; review it with /peers templates show docs");
		expect(await say("list")).toBe("docs  model=-  role=no  rules=1  groups=0\nweb  model=prov/a  role=yes  rules=1  groups=1");
		expect(storedTemplates()).toEqual({
			version: 1,
			templates: {
				docs: { rules: ["Keep docs short"], groups: [] },
				web: { model: "prov/a", prompt: "Review carefully.", rules: ["Prefer small diffs"], groups: ["frontend"] },
			},
		});
		expect(fs.statSync(templatesFile(home)).mode & 0o777).toBe(0o600);
		expect(fs.statSync(path.dirname(templatesFile(home))).mode & 0o777).toBe(0o700);
		expect(await say("remove WEB")).toBe("removed template web; sessions it was applied to keep their rules, groups and model");
		expect(await say("remove web")).toBe('error: no template "web"');
		expect(Object.keys(storedTemplates().templates)).toEqual(["docs"]);
	});

	test("rejects invalid names, shapes and duplicates without writing", async () => {
		const bad = ["add", "add -x --rule a", "add .x --rule a", `add ${"a".repeat(49)} --rule a`];
		expect(await say(bad[0])).toStartWith("usage: /peers templates add");
		for (const command of bad.slice(1)) expect(await say(command)).toStartWith("error: ");
		expect(await say("add t")).toBe("error: a template must set at least one of --model, --prompt, --rule or --group");
		expect(await say("add t --rule")).toBe("error: --rule needs a value");
		expect(await say("add t --prompt a --prompt b")).toBe("error: --prompt was given twice");
		expect(await say("add t --model prov/a --model prov/b")).toBe("error: --model was given twice");
		expect(await say("add t oops --rule a")).toBe('error: unexpected "oops"; options are --model, --prompt, --rule, --group');
		expect(await say("add t --model prov/a b")).toBe("error: model selector must be 1-128 characters without whitespace or control characters");
		expect(await say("add t --group Bad_Name!")).toStartWith("error: group name must be 1-48 characters");
		expect(await say("add t --group a --group A")).toBe("error: a group is listed twice");
		expect(await say("add t --rule same --rule same")).toBe("error: the role prompt and rules must all differ (a repeated text would be applied once)");
		expect(await say("add t --prompt same --rule same")).toBe("error: the role prompt and rules must all differ (a repeated text would be applied once)");
		expect(await say("add t --rule a\u0007b")).toBe("error: rule 1: text contains control characters");
		expect(fs.existsSync(templatesFile(home))).toBe(false);
		expect(await say("add t --rule one")).toStartWith("added template t");
		expect(await say("add t --rule two")).toBe("error: template t already exists; remove it first");
		expect(storedTemplates().templates.t.rules).toEqual(["one"]);
	});

	test("every cap is enforced at its boundary", async () => {
		expect(await say(`add t --prompt ${"x".repeat(400)}`)).toStartWith("added template t");
		expect(await say(`add u --prompt ${"x".repeat(401)}`)).toBe("error: role prompt: text is longer than 400 characters");
		expect(await say(`add v --rule ${"y".repeat(401)}`)).toBe("error: rule 1: text is longer than 400 characters");
		const rulesArgs = (n: number) => Array.from({ length: n }, (_, i) => `--rule rule${i}`).join(" ");
		expect(await say(`add w ${rulesArgs(MAX_TEMPLATE_RULES)}`)).toStartWith("added template w");
		expect(await say(`add x ${rulesArgs(MAX_TEMPLATE_RULES + 1)}`)).toBe("error: a template holds at most 8 rules");
		const groupArgs = (n: number) => Array.from({ length: n }, (_, i) => `--group g${i}`).join(" ");
		expect(await say(`add y ${groupArgs(MAX_TEMPLATE_GROUPS)}`)).toStartWith("added template y");
		expect(await say(`add z ${groupArgs(MAX_TEMPLATE_GROUPS + 1)}`)).toBe("error: a template joins at most 8 groups");
		expect(await say(`add g1 --group ${"g".repeat(48)}`)).toStartWith("added template g1");
		expect(await say(`add g2 --group ${"g".repeat(49)}`)).toStartWith("error: group name must be 1-48 characters");
		available.set("m".repeat(MAX_SELECTOR), true);
		expect(await say(`add s1 --model ${"m".repeat(MAX_SELECTOR)}`)).toStartWith("added template s1");
		expect(await say(`add s2 --model ${"m".repeat(MAX_SELECTOR + 1)}`)).toBe("error: model selector must be 1-128 characters without whitespace or control characters");
		expect(await say(`add ${"n".repeat(48)} --rule a`)).toStartWith("added template");
		// Fill to the limit.
		for (let i = Object.keys(storedTemplates().templates).length; i < MAX_TEMPLATES; i++) expect(await say(`add fill${i} --rule fill${i}`)).toStartWith("added template");
		expect(Object.keys(storedTemplates().templates)).toHaveLength(MAX_TEMPLATES);
		expect(await say("add overflow --rule a")).toBe("error: template limit reached (32); remove a template first");
		expect(Object.keys(storedTemplates().templates)).toHaveLength(MAX_TEMPLATES);
	});

	test("credential-looking text is refused without being echoed or stored", async () => {
		const secret = `api_${"key"}=abcd1234${"efgh5678"}`;
		for (const flag of ["--prompt", "--rule"]) {
			const out = await say(`add t ${flag} use ${secret} always`);
			expect(out).toStartWith("error: ");
			expect(out).toContain("looks like a credential");
			expect(out).not.toContain("abcd1234");
		}
		expect(fs.existsSync(templatesFile(home))).toBe(false);
		// A hand-edited file with such text is rejected as invalid on read and never applied.
		fs.mkdirSync(path.dirname(templatesFile(home)), { recursive: true });
		fs.writeFileSync(templatesFile(home), JSON.stringify({ version: 1, templates: { t: { prompt: `use ${secret}`, rules: [], groups: [] } } }));
		const out = await say("apply t --yes");
		expect(out).toStartWith('error: templates.json is invalid: template "t": role prompt: text looks like a credential');
		expect(out).not.toContain("abcd1234");
		expect(fs.existsSync(rulesFile(home))).toBe(false);
	});

	test("a model that is unavailable or lacks credentials at add time is refused and nothing is stored", async () => {
		expect(await say("add t --model nope")).toBe(`error: model nope: ${NOT_AVAILABLE}; template not saved`);
		expect(await say("add t --model prov/nokey")).toBe("error: model prov/nokey: no credentials for this model; template not saved");
		expect(await say("add t --model prov/a:high")).toBe("error: model prov/a:high: the selector carries a thinking level; templates do not set one; template not saved");
		expect(fs.existsSync(templatesFile(home))).toBe(false);
	});

	test("an unreadable, wrong-version or unknown-field file is reported and left untouched", async () => {
		fs.mkdirSync(path.dirname(templatesFile(home)), { recursive: true });
		for (const body of ["{not json", JSON.stringify({ version: 2, templates: {} }), JSON.stringify({ version: 1, templates: { t: { rules: ["a"], groups: [], extra: 1 } } }), JSON.stringify({ version: 1, templates: { Bad: { rules: ["a"], groups: [] } } })]) {
			fs.writeFileSync(templatesFile(home), body);
			for (const command of ["list", "add t --rule a", "show t", "apply t --yes", "remove t"]) expect(await say(command)).toStartWith("error: templates.json ");
			expect(fs.readFileSync(templatesFile(home), "utf8")).toBe(body);
		}
	});
});

describe("read-only commands", () => {
	beforeEach(async () => {
		await say(FULL);
		await addRule(host(MASTER), "group:frontend", "Group rule from the team");
	});

	test("show, list and launch leave the store, rules, groups and models byte-identical and never switch a model", async () => {
		const before = snapshot();
		const show = await say("show web");
		expect(await say("list")).toBe("web  model=prov/a  role=yes  rules=1  groups=1");
		const launch = await say("launch web");
		expect(await say("apply web")).toContain("result: not applied yet");
		expect(snapshot()).toBe(before);
		expect(modelCalls.apply).toBe(0);
		expect(show).toContain("template web");
		expect(launch).toContain("nothing was started or changed");
	});

	test("show prints the resolved configuration and the exact steps for this session", async () => {
		expect(await say("show web")).toBe([
			"template web",
			"  model: prov/a -> prov/a (available, credentials found)",
			"  role: Review carefully.  (session rule, key role)",
			"  rule 1: Prefer small diffs  (session rule)",
			"  groups: frontend",
			`for this session (${A}) apply would:`,
			"  model prov/a: switch prov/b -> prov/a",
			'  role "Review carefully.": add as a session rule (key role)',
			'  rule 1 "Prefer small diffs": add as a session rule',
			"  group frontend: create and join",
			"warning: group frontend: 1 stored rule(s) scoped to group:frontend will apply to this session from its next agent start",
			"result: not applied yet (nothing has been changed); run /peers templates apply web --yes to apply these steps",
		].join("\n"));
	});

	test("show reports an unavailable model and the refused step; nothing about it is substituted", async () => {
		available.delete("prov/a");
		expect(await say("show web")).toBe([
			"template web",
			`  model: prov/a (unavailable: ${NOT_AVAILABLE})`,
			"  role: Review carefully.  (session rule, key role)",
			"  rule 1: Prefer small diffs  (session rule)",
			"  groups: frontend",
			`for this session (${A}) apply would:`,
			`  model prov/a: refused: ${NOT_AVAILABLE}`,
			'  role "Review carefully.": add as a session rule (key role)',
			'  rule 1 "Prefer small diffs": add as a session rule',
			"  group frontend: create and join",
			"warning: group frontend: 1 stored rule(s) scoped to group:frontend will apply to this session from its next agent start",
			"result: cannot apply: 1 step(s) refused above; nothing would be applied",
		].join("\n"));
	});

	test("launch prints the exact shell lines and the resolved configuration, starts nothing", async () => {
		const out = await say("launch web");
		expect(out.split("\n").slice(0, 6)).toEqual([
			"template web",
			"  model: prov/a -> prov/a (available, credentials found)",
			"  role: Review carefully.  (session rule, key role)",
			"  rule 1: Prefer small diffs  (session rule)",
			"  groups: frontend",
			"nothing was started or changed. To start a new session and see this plan there, run in a NEW terminal:",
		]);
		expect(out).toContain("\n  OMP_PEERS_TEMPLATE=web omp\n");
		expect(out).toContain("That session only shows the plan; nothing is applied until you type /peers templates apply web --yes in it.");
		expect(out).not.toContain("CONFIRM");
		expect(await say("launch nope")).toBe('error: no template "nope"; /peers templates list shows the stored ones');
	});
});

describe("apply", () => {
	beforeEach(async () => {
		await say(FULL);
	});

	test("without --yes it prints the same plan as show and changes nothing", async () => {
		const before = snapshot();
		expect(await say("apply web")).toBe(await say("show web"));
		expect(snapshot()).toBe(before);
	});

	test("--yes applies exactly the planned steps to this session only", async () => {
		const plan = await say("show web");
		const out = await say("apply web --yes");
		expect(out).toBe([
			`applied template web to this session (${A})`,
			"  model prov/a: switched prov/b -> prov/a",
			'  role "Review carefully.": added r1',
			'  rule 1 "Prefer small diffs": added r2',
			"  group frontend: created and joined",
			"Only this session changed; other sessions, existing rules and groups were kept. Rules are injected from this session's next agent start.",
		].join("\n"));
		// plan == applied: same labels in the same order, each planned verb became its done form.
		const verbs: [string, string][] = [["switch ", "switched "], ["add as a session rule", "added r"], ["create and join", "created and joined"]];
		const split = (line: string): [string, string] => [line.slice(0, line.indexOf(": ")), line.slice(line.indexOf(": ") + 2)];
		const planned = plannedLines(plan);
		const applied = appliedLines(out);
		expect(applied).toHaveLength(planned.length);
		planned.forEach((line, index) => {
			const [label, planVerb] = split(line);
			const [doneLabel, doneVerb] = split(applied[index]);
			expect(doneLabel).toBe(label);
			expect(doneVerb.startsWith(verbs.find(([from]) => planVerb.startsWith(from))![1])).toBe(true);
		});
		expect(sessions[A].model).toBe("prov/a");
		const stored = readRules(host(A)).rules;
		expect(stored.map(r => [r.id, r.scope, r.key, r.text, r.addedBy])).toEqual([
			["r1", `session:${A}`, "role", "Review carefully.", A],
			["r2", `session:${A}`, undefined, "Prefer small diffs", A],
		]);
		expect(readGroups(home).groups).toEqual({ frontend: [A] });
		// Visible and removable through the rules feature, and injected through the existing injection.
		expect(await rules.command(["list"], host(A))).toContain("r1  session:" + A + " (worker-a)  [key=role]  Review carefully.");
		expect(agentContext(host(A))).toContain(`- [r1 session] Review carefully.\n- [r2 session] Prefer small diffs`);
		expect((await removeRule(host(A), "r1")).ok).toBe(true);
		expect(agentContext(host(A))).not.toContain("Review carefully.");
	});

	test("never changes another session, and a template with only some fields leaves the rest alone", async () => {
		await say("apply web --yes");
		expect(sessions[B].model).toBe("prov/b");
		expect(agentContext(host(B))).toBeUndefined();
		expect(groupsOf(home, B)).toEqual([]);
		await say("add rules-only --rule Only a rule");
		const modelBefore = sessions[B].model;
		expect(await say("apply rules-only --yes", B)).toBe([
			`applied template rules-only to this session (${B})`, '  rule 1 "Only a rule": added r3',
			"Only this session changed; other sessions, existing rules and groups were kept. Rules are injected from this session's next agent start.",
		].join("\n"));
		expect(sessions[B].model).toBe(modelBefore);
		expect(readGroups(home).groups).toEqual({ frontend: [A] });
		expect(modelCalls.apply).toBe(1); // only the first template had a model
	});

	test("re-applying is idempotent and reports what is already there; the files do not change", async () => {
		await say("apply web --yes");
		const before = snapshot();
		const again = await say("apply web --yes");
		expect(again).toBe([
			`template web is already applied to this session (${A}); nothing changed`,
			"  model prov/a: kept prov/a (already current)",
			'  role "Review carefully.": already present (r1)',
			'  rule 1 "Prefer small diffs": already present (r2)',
			"  group frontend: already a member",
		].join("\n"));
		expect(await say("show web")).toContain("result: nothing to change; this session already matches the template");
		expect(snapshot()).toBe(before);
		// Partly present: only the missing step is added, existing rules are not reset.
		await removeRule(host(A), "r2");
		const partial = await say("apply web --yes");
		expect(partial).toContain('  role "Review carefully.": already present (r1)');
		expect(partial).toContain('  rule 1 "Prefer small diffs": added r3');
		expect(readRules(host(A)).rules.map(r => r.id)).toEqual(["r1", "r3"]);
	});

	test("an unavailable model applies nothing at all: no rules, no groups, same model", async () => {
		available.delete("prov/a");
		const before = snapshot();
		const out = await say("apply web --yes");
		expect(out).toContain(`  model prov/a: refused: ${NOT_AVAILABLE}`);
		expect(out).toEndWith("error: template web not applied: 1 step(s) refused above; nothing was changed");
		expect(snapshot()).toBe(before);
		expect(fs.existsSync(rulesFile(home))).toBe(false);
		expect(fs.existsSync(groupsFile(home))).toBe(false);
		expect(modelCalls.apply).toBe(0);
		available.set("prov/a", false);
		expect(await say("apply web --yes")).toContain("model prov/a: refused: no credentials for this model");
		expect(snapshot()).toBe(before);
	});

	test("any other refused step also applies nothing: a conflicting role, a full scope, a full group", async () => {
		await addRule(host(A), `session:${A}`, "Be terse", "role");
		let before = snapshot();
		const conflict = await say("apply web --yes");
		expect(conflict).toContain('  role "Review carefully.": refused: r1 already holds key "role" in this session with different text; remove it first with /peers rules remove r1');
		expect(snapshot()).toBe(before);
		expect(sessions[A].model).toBe("prov/b");
		await removeRule(host(A), "r1");

		for (let i = 0; i < 24; i++) await addRule(host(A), `session:${A}`, `filler ${i}`);
		before = snapshot();
		expect(await say("apply web --yes")).toContain(`  rule 1 "Prefer small diffs": refused: scope limit reached (25 rules for session:${A}); remove a rule first`);
		expect(snapshot()).toBe(before);
		for (let i = 0; i < 24; i++) await removeRule(host(A), `r${i + 2}`);

		for (let i = 0; i < MAX_MEMBERS; i++) await addMember(home, "frontend", `p${i.toString(16).padStart(16, "0")}`, { self: MASTER, master: true });
		before = snapshot();
		expect(await say("apply web --yes")).toContain("  group frontend: refused: member limit reached (64 per group)");
		expect(snapshot()).toBe(before);
		expect(sessions[A].model).toBe("prov/b");
	});

	test("a step that fails after the plan was made is rolled back, including the model", async () => {
		// After the model switch, another process fills this session's rule scope: the role rule can no longer be added.
		afterApply = async () => {
			afterApply = undefined;
			for (let i = 0; i < 25; i++) await addRule(host(A), `session:${A}`, `racing ${i}`);
		};
		const out = await say("apply web --yes");
		expect(out).toBe(`error: template web not applied: role: scope limit reached (25 rules for session:${A}); remove a rule first; every earlier step was rolled back`);
		expect(sessions[A].model).toBe("prov/b");
		expect(readRules(host(A)).rules.every(r => r.text.startsWith("racing"))).toBe(true);
		expect(fs.existsSync(groupsFile(home))).toBe(false);
	});

	test("a group step that fails late removes the rules this run added and restores the model", async () => {
		await say("add late --model prov/a --rule Late rule --group newgroup");
		// After the model switch another process fills the group: the rule step succeeds, the group step then fails.
		afterApply = async () => {
			afterApply = undefined;
			for (let i = 0; i < MAX_MEMBERS; i++) await addMember(home, "newgroup", `p${i.toString(16).padStart(16, "0")}`, { self: MASTER, master: true });
		};
		const out = await say("apply late --yes");
		expect(out).toBe("error: template late not applied: group newgroup: member limit reached (64 per group); remove a member first; every earlier step was rolled back");
		expect(sessions[A].model).toBe("prov/b");
		expect(readRules(host(A)).rules).toEqual([]);
		expect(readGroups(home).groups.newgroup).toHaveLength(MAX_MEMBERS);
		expect(readGroups(home).groups.newgroup).not.toContain(A);
	});

	test("an existing empty group is joined, not created: the result says joined and a later failure leaves the group in place", async () => {
		const actor = { self: MASTER, master: true };
		await addMember(home, "keep", "p00000000000000f1", actor);
		await removeMember(home, "keep", "p00000000000000f1", actor);
		expect(readGroups(home).groups.keep).toEqual([]);
		await say("add pair --model prov/a --group keep --group boom");
		afterApply = async () => {
			afterApply = undefined;
			for (let i = 0; i < MAX_MEMBERS; i++) await addMember(home, "boom", `p${i.toString(16).padStart(16, "0")}`, actor);
		};
		expect(await say("apply pair --yes")).toBe("error: template pair not applied: group boom: member limit reached (64 per group); remove a member first; every earlier step was rolled back");
		expect(readGroups(home).groups.keep).toEqual([]);
		await say("remove pair");
		await say("add solo --group keep");
		expect(await say("apply solo --yes")).toContain("  group keep: joined");
		expect(readGroups(home).groups.keep).toEqual([A]);
	});

	test("a warning appears when the injection cap would leave rules out, in the plan and in the result", async () => {
		for (let i = 0; i < 22; i++) await addRule(host(A), `session:${A}`, `${"filler".repeat(60)} ${i}`.slice(0, 390));
		const plan = await say("show web");
		const warning = plan.split("\n").find(line => line.startsWith("warning: ") && line.includes("injection byte cap"))!;
		expect(warning).toBeDefined();
		const applied = await say("apply web --yes");
		expect(applied).toContain(warning);
		const omitted = Number(/(\d+) lower-precedence rule\(s\) omitted/.exec(agentContext(host(A))!)![1]);
		expect(warning).toBe(`warning: ${omitted} active rule(s) of this session exceed the injection byte cap and would not be injected (see /peers rules explain ${A})`);
	});

	test("session-scoped rules are honoured for a session that refuses others; the group warning says which rules are injected", async () => {
		await addRule(host(MASTER), "group:frontend", "Team rule");
		sessions[A].accepts = false;
		const show = await say("show web");
		expect(show).toContain("warning: group frontend: 1 stored rule(s) are scoped to group:frontend; this session refuses or locks out others, so only rules it added itself are injected");
		await say("apply web --yes");
		expect(agentContext(host(A))).toBe([
			"Standing rules for this session (peers rules registry; most specific first). Follow them; an explicit instruction in the user's request for this task overrides them.",
			"- [r2 session] Review carefully.", "- [r3 session] Prefer small diffs",
		].join("\n"));
	});

	test("apply needs exactly one template name and accepts --yes only for apply", async () => {
		expect(await say("apply")).toStartWith("usage: ");
		expect(await say("apply web other --yes")).toStartWith("usage: ");
		expect(await say("show web --yes")).toStartWith("usage: ");
		expect(await say("launch web --yes")).toStartWith("usage: ");
		expect(await say("apply nope --yes")).toBe('error: no template "nope"; /peers templates list shows the stored ones');
	});

	test("two applications at once in one session add each rule and membership once", async () => {
		const [one, two] = await Promise.all([say("apply web --yes"), say("apply web --yes")]);
		expect([one, two].filter(out => out.startsWith("applied template web"))).toHaveLength(2);
		expect(readRules(host(A)).rules.map(r => r.text).sort()).toEqual(["Prefer small diffs", "Review carefully."]);
		expect(readGroups(home).groups).toEqual({ frontend: [A] });
		expect(sessions[A].model).toBe("prov/a");
	});
});

describe("template named in the environment", () => {
	beforeEach(async () => {
		await say(FULL);
	});
	const env = (extra: Record<string, string> = {}) => ({ OMP_PEERS_TEMPLATE: "web", ...extra });

	test("does nothing unless OMP_PEERS_TEMPLATE is set", async () => {
		const before = snapshot();
		expect(await startupTemplate(host(A), {})).toBeUndefined();
		expect(await startupTemplate(host(A), { OMP_PEERS_TEMPLATE: " " })).toBeUndefined();
		expect(await startupTemplate(host(A), { OMP_PEERS_TEMPLATE_CONFIRM: "yes" })).toBeUndefined();
		expect(snapshot()).toBe(before);
	});

	test("it only shows the plan and never applies, whatever else the environment carries", async () => {
		const before = snapshot();
		const plan = (await say("show web")).split("\n").slice(0, -1).join("\n");
		const extras: Record<string, string>[] = [{}, { OMP_PEERS_TEMPLATE_CONFIRM: "yes" }, { OMP_PEERS_TEMPLATE_CONFIRM: "true" }];
		for (const extra of extras) {
			expect(await startupTemplate(host(A), env(extra))).toBe(`${plan}\ntemplate web not applied: run /peers templates apply web --yes in this session to apply it`);
		}
		expect(snapshot()).toBe(before);
		expect(sessions[A].model).toBe("prov/b");
	});

	test("an unknown or invalid name and a blocked plan change nothing", async () => {
		const before = snapshot();
		expect(await startupTemplate(host(A), { OMP_PEERS_TEMPLATE: "nope" })).toBe("template nope not applied: no such template; /peers templates list shows the stored ones");
		expect(await startupTemplate(host(A), { OMP_PEERS_TEMPLATE: "../x" })).toBe("template not applied: OMP_PEERS_TEMPLATE is not a valid template name");
		available.delete("prov/a");
		const blocked = await startupTemplate(host(A), env());
		expect(blocked).toContain(`  model prov/a: refused: ${NOT_AVAILABLE}`);
		expect(blocked).toEndWith("template web not applied: 1 step(s) refused above; nothing was changed");
		expect(snapshot()).toBe(before);
		fs.writeFileSync(templatesFile(home), "{broken");
		expect(await startupTemplate(host(A), env())).toStartWith("template web not applied: templates.json is not valid JSON");
	});
});

describe("several OMP processes", () => {
	/** Run the child script as session p<tag>00000000 and return what it printed. */
	const run = async (tag: string, action: string, name = "") => {
		const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "child_templates.ts"), home, tag, action, name], { stdout: "pipe", stderr: "pipe" });
		const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		if (code !== 0) throw new Error(err);
		return out.trim();
	};

	test("concurrent adds and applies lose nothing; a fresh process reads the stored templates", async () => {
		await say("add shared --rule Shared rule --group team");
		const tags = ["aaaaaaaa", "bbbbbbbb", "cccccccc", "dddddddd", "eeeeeeee", "ffffffff"];
		const outputs = await Promise.all(tags.flatMap(tag => [run(tag, "apply", "shared"), run(tag, "add", `own-${tag}`)]));
		expect(outputs.filter(out => out.startsWith("applied template shared to this session"))).toHaveLength(tags.length);
		const stored = readRules(host(A)).rules;
		expect(stored).toHaveLength(tags.length);
		expect(new Set(stored.map(r => r.id)).size).toBe(tags.length);
		expect(stored.map(r => r.scope).sort()).toEqual(tags.map(tag => `session:p${tag}00000000`));
		expect(readGroups(home).groups.team.sort()).toEqual(tags.map(tag => `p${tag}00000000`));
		expect(Object.keys(readTemplates(home).templates).sort()).toEqual(["shared", ...tags.map(tag => `own-${tag}`)].sort());
		expect(fs.readdirSync(path.dirname(templatesFile(home))).filter(f => f.endsWith(".tmp"))).toEqual([]);
		// Reload: a new process lists exactly what this one does.
		expect(await run("aaaaaaaa", "list")).toBe(await say("list"));
	});
});
