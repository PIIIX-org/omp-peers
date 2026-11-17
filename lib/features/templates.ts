// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

/**
 * Reusable session templates: a named model, role prompt, standing rules and groups.
 *
 * Nothing here starts a process. A template is applied by the session itself, only when the user types
 * `/peers templates apply <name> --yes` in it. Applying only ever changes the current session: it switches its model,
 * adds session-scoped rules and joins it to groups. Every step is planned first, read-only, and the plan is
 * exactly what apply does: any refused step means nothing is applied.
 */
import * as path from "node:path";
import type { FeatureHost, ModelCheck } from "./host";
import type { Feature } from "./index";
import { addMember, deleteGroup, MAX_GROUPS, MAX_MEMBERS, readGroups, removeMember } from "./groups";
import { addRule, GROUP_RE, normalizeText, planOwnRules, readRules, removeRule, screenText } from "./rules";
import { readState, stateRoot, updateState } from "./store";

export interface Template {
	/** Model selector (id, `provider/id` or role alias); absent leaves the model alone. */
	model?: string;
	/** One-line role prompt, applied as the session rule with key `role`; absent adds none. */
	prompt?: string;
	/** Extra session rules, at most `MAX_TEMPLATE_RULES`. */
	rules: string[];
	/** Groups this session joins, at most `MAX_TEMPLATE_GROUPS`. */
	groups: string[];
}

export interface TemplatesState {
	version: 1;
	templates: Record<string, Template>;
}

export const MAX_TEMPLATES = 32;
export const MAX_TEMPLATE_RULES = 8;
export const MAX_TEMPLATE_GROUPS = 8;
export const MAX_SELECTOR = 128;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const ROLE_KEY = "role";
const FLAGS = ["--model", "--prompt", "--rule", "--group"];
const USAGE = "usage: /peers templates add <name> [--model <selector>] [--prompt <role text>] [--rule <text>]... [--group <name>]... | show <name> | list | remove <name> | apply <name> [--yes] | launch <name>";

export const templatesFile = (home: string) => path.join(stateRoot(home), "templates.json");

const emptyState = (): TemplatesState => ({ version: 1, templates: {} });

// ---- Validation --------------------------------------------------------------------------------

interface TemplateInput {
	model?: string;
	prompt?: string;
	rules: string[];
	groups: string[];
}

function checkText(label: string, raw: string): { text?: string; error?: string } {
	const { text, error } = normalizeText(raw);
	if (!text) return { error: `${label}: ${error!.replace(/^rule text/, "text")}` };
	const secret = screenText(text);
	return secret ? { error: `${label}: ${secret.replace(/^rule text/, "text")}` } : { text };
}

/** The canonical template for `input`, or why it is invalid. Never echoes text that looks like a credential. */
export function checkTemplate(input: TemplateInput): { template?: Template; error?: string } {
	const template: Template = { rules: [], groups: [] };
	if (input.model !== undefined) {
		const model = input.model.trim();
		if (!model || model.length > MAX_SELECTOR || /[\s\p{Cc}\p{Cf}]/u.test(model)) {
			return { error: `model selector must be 1-${MAX_SELECTOR} characters without whitespace or control characters` };
		}
		template.model = model;
	}
	const texts: string[] = [];
	if (input.prompt !== undefined) {
		const { text, error } = checkText("role prompt", input.prompt);
		if (!text) return { error };
		template.prompt = text;
		texts.push(text);
	}
	if (input.rules.length > MAX_TEMPLATE_RULES) return { error: `a template holds at most ${MAX_TEMPLATE_RULES} rules` };
	for (const [index, raw] of input.rules.entries()) {
		const { text, error } = checkText(`rule ${index + 1}`, raw);
		if (!text) return { error };
		template.rules.push(text);
		texts.push(text);
	}
	if (new Set(texts).size !== texts.length) return { error: "the role prompt and rules must all differ (a repeated text would be applied once)" };
	if (input.groups.length > MAX_TEMPLATE_GROUPS) return { error: `a template joins at most ${MAX_TEMPLATE_GROUPS} groups` };
	for (const raw of input.groups) {
		const group = raw.toLowerCase();
		if (!GROUP_RE.test(group)) return { error: "group name must be 1-48 characters: lower-case letters, digits, '.', '_' or '-', starting with a letter or digit" };
		template.groups.push(group);
	}
	if (new Set(template.groups).size !== template.groups.length) return { error: "a group is listed twice" };
	if (template.model === undefined && template.prompt === undefined && !template.rules.length && !template.groups.length) {
		return { error: "a template must set at least one of --model, --prompt, --rule or --group" };
	}
	return { template };
}

function validateState(value: unknown): TemplatesState {
	const state = value as Partial<TemplatesState> | null;
	if (!state || typeof state !== "object" || state.version !== 1) throw new Error("unsupported version (expected 1)");
	const raw = state.templates as Record<string, unknown> | undefined;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("malformed fields");
	const names = Object.keys(raw);
	if (names.length > MAX_TEMPLATES) throw new Error(`more than ${MAX_TEMPLATES} templates`);
	const templates: Record<string, Template> = {};
	for (const name of names) {
		const entry = raw[name] as Partial<Template> | null;
		const shape = entry && typeof entry === "object" && !Array.isArray(entry) && Object.keys(entry).every(key => ["model", "prompt", "rules", "groups"].includes(key)) &&
			(entry.model === undefined || typeof entry.model === "string") && (entry.prompt === undefined || typeof entry.prompt === "string") &&
			Array.isArray(entry.rules) && entry.rules.every(rule => typeof rule === "string") && Array.isArray(entry.groups) && entry.groups.every(group => typeof group === "string");
		if (!NAME_RE.test(name) || !shape) throw new Error(`malformed template "${name.slice(0, 48)}"`);
		const checked = checkTemplate({ model: entry.model, prompt: entry.prompt, rules: entry.rules!, groups: entry.groups! });
		if (!checked.template) throw new Error(`template "${name}": ${checked.error}`);
		templates[name] = checked.template;
	}
	return { version: 1, templates };
}

/** The stored templates, read fresh from disk. Throws when the file is unreadable or invalid. */
export function readTemplates(home: string): TemplatesState {
	return readState(templatesFile(home), emptyState, validateState);
}

// ---- Plan --------------------------------------------------------------------------------------

export type Step =
	| { kind: "model"; selector: string; action: "switch" | "keep" | "refuse"; from?: string; to?: string; error?: string }
	| { kind: "rule"; label: string; text: string; key?: string; action: "add" | "present" | "refuse"; id?: string; error?: string }
	| { kind: "group"; name: string; action: "join" | "create" | "present" | "refuse"; error?: string };

export interface Plan {
	name: string;
	template: Template;
	/** This session's stable id: the only session a plan or apply ever changes. */
	self: string;
	/** One step per template field, in apply order: model, role, rules, groups. */
	steps: Step[];
	warnings: string[];
}

const blocked = (plan: Plan) => plan.steps.some(step => step.action === "refuse");
const unchanged = (step: Step) => step.action === "keep" || step.action === "present";

function modelStep(selector: string, check: ModelCheck): Step {
	if (!check.ok) return { kind: "model", selector, action: "refuse", error: check.error };
	if (check.current === check.model) return { kind: "model", selector, action: "keep", to: check.model };
	return { kind: "model", selector, action: "switch", from: check.current, to: check.model };
}

/** What applying `template` to this session would do right now. Read-only; throws when rules or groups cannot be read. */
export async function buildPlan(host: FeatureHost, name: string, template: Template): Promise<Plan> {
	const self = host.self().id;
	const steps: Step[] = [];
	const warnings: string[] = [];
	if (template.model !== undefined) steps.push(modelStep(template.model, await host.resolveModel(template.model)));

	const entries = [
		...(template.prompt !== undefined ? [{ label: "role", text: template.prompt, key: ROLE_KEY }] : []),
		...template.rules.map((text, index) => ({ label: `rule ${index + 1}`, text, key: undefined as string | undefined })),
	];
	if (entries.length) {
		const planned = planOwnRules(host, entries);
		entries.forEach((entry, index) => {
			const rule = planned.steps[index];
			steps.push({ kind: "rule", label: entry.label, text: entry.text, ...(entry.key ? { key: entry.key } : {}),
				action: rule.action, ...(rule.action === "present" ? { id: rule.id } : {}), ...(rule.action === "refuse" ? { error: rule.error } : {}) });
		});
		if (planned.omitted) warnings.push(`${planned.omitted} active rule(s) of this session exceed the injection byte cap and would not be injected (see /peers rules explain ${self})`);
	}

	if (template.groups.length) {
		const { groups } = readGroups(host.home);
		const stored = readRules(host).rules;
		let created = 0;
		for (const group of template.groups) {
			const members = Object.hasOwn(groups, group) ? groups[group] : undefined;
			if (members?.includes(self)) steps.push({ kind: "group", name: group, action: "present" });
			else if (!members && Object.keys(groups).length + created >= MAX_GROUPS) steps.push({ kind: "group", name: group, action: "refuse", error: `group limit reached (${MAX_GROUPS}); delete a group first` });
			else if ((members?.length ?? 0) >= MAX_MEMBERS) steps.push({ kind: "group", name: group, action: "refuse", error: `member limit reached (${MAX_MEMBERS} per group)` });
			else {
				if (!members) created++;
				steps.push({ kind: "group", name: group, action: members ? "join" : "create" });
				const existing = stored.filter(rule => rule.scope === `group:${group}`).length;
				if (existing) {
					warnings.push(host.acceptsRemote()
						? `group ${group}: ${existing} stored rule(s) scoped to group:${group} will apply to this session from its next agent start`
						: `group ${group}: ${existing} stored rule(s) are scoped to group:${group}; this session refuses or locks out others, so only rules it added itself are injected`);
				}
			}
		}
	}
	return { name, template, self, steps, warnings };
}

// ---- Presentation ------------------------------------------------------------------------------

const quote = (text: string) => `"${text}"`;
const stepLabel = (step: Step) => step.kind === "model" ? `model ${step.selector}` : step.kind === "rule" ? `${step.label} ${quote(step.text)}` : `group ${step.name}`;

/** One step as the plan words it (`done` false) or as the applied result words it (`done` true; `id` is the rule id just added). */
function stepLine(step: Step, done: boolean, id?: string): string {
	let what: string;
	if (step.action === "refuse") what = `refused: ${step.error}`;
	else if (step.kind === "model") what = step.action === "keep" ? `${done ? "kept" : "keep"} ${step.to} (already current)` : `${done ? "switched" : "switch"} ${step.from ?? "(none)"} -> ${step.to}`;
	else if (step.kind === "rule") what = step.action === "present" ? `already present (${step.id})` : done ? `added ${id}` : `add as a session rule${step.key ? ` (key ${step.key})` : ""}`;
	else what = step.action === "present" ? "already a member" : step.action === "create" ? (done ? "created and joined" : "create and join") : done ? "joined" : "join";
	return `  ${stepLabel(step)}: ${what}`;
}

/** The stored configuration, with the model selector resolved: what the template contains, independent of any session. */
async function configLines(host: FeatureHost, name: string, template: Template): Promise<string[]> {
	const lines = [`template ${name}`];
	if (template.model !== undefined) {
		const check = await host.resolveModel(template.model);
		lines.push(check.ok ? `  model: ${template.model} -> ${check.model} (available, credentials found)` : `  model: ${template.model} (unavailable: ${check.error})`);
	}
	if (template.prompt !== undefined) lines.push(`  role: ${template.prompt}  (session rule, key ${ROLE_KEY})`);
	template.rules.forEach((rule, index) => lines.push(`  rule ${index + 1}: ${rule}  (session rule)`));
	if (template.groups.length) lines.push(`  groups: ${template.groups.join(", ")}`);
	return lines;
}

function resultLine(plan: Plan): string {
	if (blocked(plan)) return `result: cannot apply: ${plan.steps.filter(step => step.action === "refuse").length} step(s) refused above; nothing would be applied`;
	if (plan.steps.every(unchanged)) return "result: nothing to change; this session already matches the template";
	return `result: not applied yet (nothing has been changed); run /peers templates apply ${plan.name} --yes to apply these steps`;
}

async function renderPlan(host: FeatureHost, plan: Plan, tail: string): Promise<string> {
	return [
		...await configLines(host, plan.name, plan.template),
		`for this session (${plan.self}) apply would:`,
		...plan.steps.map(step => stepLine(step, false)),
		...plan.warnings.map(warning => `warning: ${warning}`),
		tail,
	].join("\n");
}

// ---- Apply -------------------------------------------------------------------------------------

/**
 * Run the steps of an unblocked `plan` against this session. A step that fails although the plan allowed it (state
 * changed in between) stops the run and undoes what this run changed, so the session ends unchanged or says exactly
 * what could not be undone.
 */
async function applyPlan(host: FeatureHost, plan: Plan): Promise<string> {
	const actor = { self: plan.self, master: host.isMaster() };
	const undo: { what: string; run: () => Promise<string | undefined> }[] = [];
	const lines: string[] = [];
	try {
		for (const step of plan.steps) {
			if (step.kind === "model") {
				if (step.action === "keep") {
					lines.push(stepLine(step, true));
					continue;
				}
				const result = await host.applyModel(step.selector);
				if (!result.ok) throw new Error(`model ${step.selector}: ${result.error}`);
				lines.push(stepLine({ ...step, from: result.previous, to: result.model }, true));
				const previous = result.previous;
				undo.push({ what: `model (now ${result.model})`, run: async () => {
					if (!previous) return "the session had no model before; it keeps the new one";
					const back = await host.applyModel(previous);
					return back.ok ? undefined : back.error;
				} });
			} else if (step.kind === "rule") {
				if (step.action === "present") {
					lines.push(stepLine(step, true));
					continue;
				}
				const added = await addRule(host, `session:${plan.self}`, step.text, step.key);
				if (added.ok) {
					lines.push(stepLine(step, true, added.rule.id));
					const id = added.rule.id;
					undo.push({ what: `rule ${id}`, run: async () => {
						const gone = await removeRule(host, id);
						return gone.ok ? undefined : gone.error;
					} });
				} else if (added.existing) lines.push(stepLine({ ...step, action: "present", id: added.existing }, true)); // added by someone since the plan
				else throw new Error(`${step.label}: ${added.error}`);
			} else {
				if (step.action === "present") {
					lines.push(stepLine(step, true));
					continue;
				}
				const joined = await addMember(host.home, step.name, plan.self, actor);
				if (!joined.ok) throw new Error(`group ${step.name}: ${joined.error}`);
				if (!joined.changed) {
					lines.push(stepLine({ ...step, action: "present" }, true));
					continue;
				}
				// Created only when the plan found no such group and we are its first member; an existing (even empty) group is joined and never deleted by rollback.
				const created = step.action === "create" && joined.count === 1;
				lines.push(stepLine({ ...step, action: created ? "create" : "join" }, true));
				undo.push({ what: `membership of group ${step.name}`, run: async () => {
					const left = await removeMember(host.home, step.name, plan.self, actor);
					if (!left.ok) return left.error;
					if (created && left.count === 0) {
						const deleted = await deleteGroup(host.home, step.name, actor);
						if (!deleted.ok) return deleted.error;
					}
					return undefined;
				} });
			}
		}
	} catch (error) {
		const failures: string[] = [];
		for (const item of undo.reverse()) {
			const failure = await item.run().catch((e: Error) => e.message);
			if (failure) failures.push(`${item.what}: ${failure}`);
		}
		const outcome = !undo.length ? "nothing was changed" : failures.length ? `rollback incomplete (${failures.join("; ")}); review with /peers rules list and /peers groups list` : "every earlier step was rolled back";
		return `error: template ${plan.name} not applied: ${(error as Error).message}; ${outcome}`;
	}
	const changed = !plan.steps.every(unchanged);
	return [
		changed ? `applied template ${plan.name} to this session (${plan.self})` : `template ${plan.name} is already applied to this session (${plan.self}); nothing changed`,
		...lines,
		...plan.warnings.map(warning => `warning: ${warning}`),
		...(changed ? ["Only this session changed; other sessions, existing rules and groups were kept. Rules are injected from this session's next agent start."] : []),
	].join("\n");
}

// ---- Session start -----------------------------------------------------------------------------

/**
 * `OMP_PEERS_TEMPLATE=<name>` in the environment of a starting session shows that template's plan and nothing else: it
 * never applies. Environment variables are inherited by every program the session starts (including another omp), so
 * they cannot carry authorization; applying always needs `/peers templates apply <name> --yes` typed in the session.
 * Returns the text to show, or undefined when no template was requested.
 */
export async function startupTemplate(host: FeatureHost, env: Record<string, string | undefined>): Promise<string | undefined> {
	const requested = env.OMP_PEERS_TEMPLATE?.trim();
	if (!requested) return undefined;
	if (!NAME_RE.test(requested)) return "template not applied: OMP_PEERS_TEMPLATE is not a valid template name";
	const name = requested;
	const not = `template ${name} not applied: `;
	try {
		const { templates } = readTemplates(host.home);
		if (!Object.hasOwn(templates, name)) return `${not}no such template; /peers templates list shows the stored ones`;
		const plan = await buildPlan(host, name, templates[name]);
		if (blocked(plan)) return await renderPlan(host, plan, `${not}${plan.steps.filter(step => step.action === "refuse").length} step(s) refused above; nothing was changed`);
		return await renderPlan(host, plan, `${not}run /peers templates apply ${name} --yes in this session to apply it`);
	} catch (error) {
		return `${not}${(error as Error).message}`;
	}
}

// ---- Commands ----------------------------------------------------------------------------------

type Parsed = { name: string; input: TemplateInput } | { error: string };

/** `<name> --model <sel> --prompt <text...> --rule <text...> --group <name>`; a value runs until the next of these exact flags. */
function parseAdd(tokens: string[]): Parsed {
	const [name, ...rest] = tokens;
	if (!name) return { error: USAGE };
	const input: TemplateInput = { rules: [], groups: [] };
	let index = 0;
	while (index < rest.length) {
		const flag = rest[index++];
		if (!FLAGS.includes(flag)) return { error: `unexpected "${flag.slice(0, 40)}"; options are ${FLAGS.join(", ")}` };
		const start = index;
		while (index < rest.length && !FLAGS.includes(rest[index])) index++;
		const value = rest.slice(start, index).join(" ");
		if (!value) return { error: `${flag} needs a value` };
		if (flag === "--model" || flag === "--prompt") {
			const field = flag === "--model" ? "model" : "prompt";
			if (input[field] !== undefined) return { error: `${flag} was given twice` };
			input[field] = value;
		} else if (flag === "--rule") input.rules.push(value);
		else input.groups.push(value);
	}
	return { name: name.toLowerCase(), input };
}

async function add(tokens: string[], host: FeatureHost): Promise<string> {
	const parsed = parseAdd(tokens);
	if ("error" in parsed) return parsed.error.startsWith("usage:") ? parsed.error : `error: ${parsed.error}`;
	if (!NAME_RE.test(parsed.name)) return "error: template name must be 1-48 characters: lower-case letters, digits, '.', '_' or '-', starting with a letter or digit";
	const { template, error } = checkTemplate(parsed.input);
	if (!template) return `error: ${error}`;
	if (template.model !== undefined) {
		const check = await host.resolveModel(template.model);
		if (!check.ok) return `error: model ${template.model}: ${check.error}; template not saved`;
	}
	const name = parsed.name;
	const stored = await updateState<TemplatesState, string | undefined>(templatesFile(host.home), emptyState, validateState, current => {
		if (Object.hasOwn(current.templates, name)) return { result: `template ${name} already exists; remove it first` };
		if (Object.keys(current.templates).length >= MAX_TEMPLATES) return { result: `template limit reached (${MAX_TEMPLATES}); remove a template first` };
		return { state: { version: 1, templates: { ...current.templates, [name]: template } }, result: undefined };
	});
	return stored ? `error: ${stored}` : `added template ${name}; review it with /peers templates show ${name}`;
}

async function command(args: string[], host: FeatureHost): Promise<string> {
	const [sub, ...rest] = args;
	try {
		switch (sub) {
			case "add":
				return await add(rest, host);
			case "list": {
				if (rest.length) return USAGE;
				const { templates } = readTemplates(host.home);
				const names = Object.keys(templates).sort();
				return names.length
					? names.map(name => `${name}  model=${templates[name].model ?? "-"}  role=${templates[name].prompt !== undefined ? "yes" : "no"}  rules=${templates[name].rules.length}  groups=${templates[name].groups.length}`).join("\n")
					: "no templates";
			}
			case "remove": {
				if (rest.length !== 1) return USAGE;
				const name = rest[0].toLowerCase();
				const found = await updateState<TemplatesState, boolean>(templatesFile(host.home), emptyState, validateState, current => {
					if (!Object.hasOwn(current.templates, name)) return { result: false };
					const left = { ...current.templates };
					delete left[name];
					return { state: { version: 1, templates: left }, result: true };
				});
				return found ? `removed template ${name}; sessions it was applied to keep their rules, groups and model` : `error: no template "${name}"`;
			}
			case "show":
			case "apply":
			case "launch": {
				const yes = sub === "apply" && rest.includes("--yes");
				const names = rest.filter(token => !(sub === "apply" && token === "--yes"));
				if (names.length !== 1) return USAGE;
				const name = names[0].toLowerCase();
				const { templates } = readTemplates(host.home);
				if (!Object.hasOwn(templates, name)) return `error: no template "${name}"; /peers templates list shows the stored ones`;
				const template = templates[name];
				if (sub === "launch") {
					return [
						...await configLines(host, name, template),
						"nothing was started or changed. To start a new session and see this plan there, run in a NEW terminal:",
						`  OMP_PEERS_TEMPLATE=${name} omp`,
						`That session only shows the plan; nothing is applied until you type /peers templates apply ${name} --yes in it. (The variable is inherited by programs started from that session, so a program it launches shows its plan too and likewise changes nothing.)`,
						"Applying adds each rule and joins each group, and switches the model unless the session already runs the selected one; availability is checked again there.",
					].join("\n");
				}
				const plan = await buildPlan(host, name, template);
				if (sub === "show" || !yes) return await renderPlan(host, plan, resultLine(plan));
				if (blocked(plan)) return await renderPlan(host, plan, `error: template ${name} not applied: ${plan.steps.filter(step => step.action === "refuse").length} step(s) refused above; nothing was changed`);
				return await applyPlan(host, plan);
			}
			default:
				return USAGE;
		}
	} catch (error) {
		return `error: ${(error as Error).message}`;
	}
}

export const templates: Feature = {
	name: "templates",
	command,
};
