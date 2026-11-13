// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
import { zod as z } from "@oh-my-pi/pi-coding-agent";

const segmenter = new Intl.Segmenter("und", { granularity: "word" });

/** Require two letter-bearing Unicode words separated by whitespace or a natural word boundary.
 * This is a readability contract, not a language detector or prose reconstruction heuristic. */
function readable(text: string): boolean {
	const words = [...segmenter.segment(text)].filter(part => part.isWordLike && /\p{L}/u.test(part.segment));
	return words.some((word, index) => {
		if (!index) return false;
		const previous = words[index - 1];
		const gap = text.slice(previous.index + previous.segment.length, word.index);
		return gap === "" || /\s/u.test(gap);
	});
}

const human = z.string().trim().min(1).max(240)
	.refine(text => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text), "Use one readable line without control or format characters")
	.refine(readable, "Use at least two readable Unicode words; do not strip spaces or use an identifier/URL as a human description");
const reference = z.string().min(1).max(512).regex(/^[^\s\p{Cc}\p{Cf}]+$/u, "Use a nonempty whitespace-free reference");

export const reportSchema = z.union([
	z.object({ kind: z.literal("DONE"), unit: human,
		evidence: z.object({ description: human, references: z.array(reference).min(1).max(8).optional() }).strict() }).strict(),
	z.object({ kind: z.literal("BLOCKED"), unit: human, blocker: human, nextAction: human }).strict(),
	z.object({ kind: z.literal("WAITING"), unit: human, background: z.enum(["pending", "none", "unknown"]), nextAction: human }).strict(),
	z.object({ kind: z.literal("DECISION"), unit: human, question: human }).strict(),
]);
export type Report = z.infer<typeof reportSchema>;

export const sendParameters = z.object({
	to: z.string().describe("Stable peer id, name (or unique prefix), or 'all'"),
	text: z.string().optional().describe("Ordinary message body; mutually exclusive with report"),
	report: reportSchema.optional().describe("Structured report; mutually exclusive with text. Human fields need readable Unicode words."),
}).strict();

// Host validation repairs closed schemas before execute (including optional nulls
// and selected-union extras). Accept raw objects first so those values reach our
// strict runtime validator intact; retain the documented shape for tool discovery.
// Ordering matters: even nullable optional properties are removed by the host.
export const sendIngressParameters = {
	type: "object",
	anyOf: [
		{ type: "object", additionalProperties: true },
		sendParameters.toJsonSchema({ io: "input" }),
	],
	description: "Supply the documented to plus text OR report shape. The handler strictly validates all fields; nulls and unknown fields are errors, not omitted values.",
};

export function renderReport(report: Report): string {
	const lines = [report.kind, `Unit: ${report.unit}`];
	switch (report.kind) {
		case "DONE":
			lines.push(`Evidence: ${report.evidence.description}`);
			if (report.evidence.references) lines.push(`References: ${report.evidence.references.join(", ")}`);
			break;
		case "BLOCKED": lines.push(`Blocker: ${report.blocker}`, `Next action: ${report.nextAction}`); break;
		case "WAITING": lines.push(`Background: ${report.background}`, `Next action: ${report.nextAction}`); break;
		case "DECISION": lines.push(`Question: ${report.question}`); break;
	}
	return lines.join("\n");
}

/** Shared by outbound tools/commands and the inbound socket before any delivery side effect. */
export function readMessage(input: { text?: unknown; report?: unknown }): { text: string; report?: Report } {
	if (input.report !== undefined) {
		if (input.text !== undefined) throw new Error("Supply either text or report, not both");
		const report = reportSchema.parse(input.report);
		return { text: renderReport(report), report };
	}
	if (typeof input.text !== "string" || !input.text.trim()) throw new Error("empty message: supply text or a structured report");
	return { text: input.text };
}
