// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
import { describe, expect, test } from "bun:test";
import { readMessage, renderReport, reportSchema, sendParameters, type Report } from "../lib/reports";

const reports: Report[] = [
	{ kind: "DONE", unit: "Report validation", evidence: { description: "Consumer checks passed", references: ["https://example.test/proof", "a_long_machine_identifier", "abc123"] } },
	{ kind: "BLOCKED", unit: "Report validation", blocker: "Approval is missing", nextAction: "Request the approval" },
	{ kind: "WAITING", unit: "Report validation", background: "pending", nextAction: "Wait for results" },
	{ kind: "DECISION", unit: "Report validation", question: "Which option should proceed?" },
];
const rendered = [
	"DONE\nUnit: Report validation\nEvidence: Consumer checks passed\nReferences: https://example.test/proof, a_long_machine_identifier, abc123",
	"BLOCKED\nUnit: Report validation\nBlocker: Approval is missing\nNext action: Request the approval",
	"WAITING\nUnit: Report validation\nBackground: pending\nNext action: Wait for results",
	"DECISION\nUnit: Report validation\nQuestion: Which option should proceed?",
];

describe("structured reports", () => {
	for (const [index, report] of reports.entries()) {
		test(`${report.kind} validates required fields and exact rendering`, () => {
			expect(renderReport(reportSchema.parse(report))).toBe(rendered[index]);
			expect(readMessage({ report })).toEqual({ report, text: rendered[index] });
			for (const field of Object.keys(report)) {
				const missing: Record<string, unknown> = { ...report };
				delete missing[field];
				expect(() => readMessage({ report: missing })).toThrow();
			}
			expect(() => readMessage({ report: { ...report, ignored: "Not silently ignored" } })).toThrow();
			for (const unit of ["", " \t ", "Nospacehumanreadableprose", "single_identifier", "one-long-identifier", "https://example.test/proof", "123 456", "one\ntwo", "one\u200btwo", "one\u2028two", "a ".repeat(121)]) {
				expect(() => readMessage({ report: { ...report, unit } })).toThrow();
			}
		});
	}

	test("every human field uses the same readable contract", () => {
		for (const report of reports) {
			for (const field of ["unit", "blocker", "nextAction", "question"]) {
				if (!(field in report)) continue;
				expect(reportSchema.safeParse({ ...report, [field]: "CompressedUnreadableProse" }).success).toBe(false);
			}
		}
		for (const description of ["", " ", "CompressedEvidenceDescription", "machine_identifier", "https://example.test/proof"]) {
			expect(reportSchema.safeParse({ ...reports[0], evidence: { description } }).success).toBe(false);
		}
	});

	test("Unicode words, CJK segmentation and machine references remain usable", () => {
		for (const unit of ["修复完成测试通过", "日本語の報告です", "Исправление готово", "تم الإصلاح", "Révision terminée", "งานเสร็จแล้ว"]) {
			expect(reportSchema.safeParse({ ...reports[3], unit }).success).toBe(true);
		}
		expect(readMessage({ report: { ...reports[3], unit: "  Two  words  " } }).text).toContain("Unit: Two  words");
		for (const references of [[], [""], ["space stripped"], ["line\nbreak"], ["format\u200bcharacter"], ["x".repeat(513)], Array(9).fill("ref")]) {
			expect(reportSchema.safeParse({ ...reports[0], evidence: { description: "Readable evidence description", references } }).success).toBe(false);
		}
	});

	test("DONE evidence never substitutes for WAITING background state", () => {
		expect(reportSchema.safeParse({ kind: "DONE", unit: "Finished unit", evidence: { references: ["abc123"] } }).success).toBe(false);
		for (const background of ["pending", "none", "unknown"]) {
			expect(readMessage({ report: { ...reports[2], background } }).text).toContain(`Background: ${background}`);
		}
		for (const background of [undefined, "", "done", false, null]) {
			expect(reportSchema.safeParse({ ...reports[2], background }).success).toBe(false);
		}
		expect(reportSchema.safeParse({ ...reports[2], evidence: { description: "Evidence is present" } }).success).toBe(false);
	});

	test("ordinary messages stay unchanged and old/inconsistent inputs fail", () => {
		for (const text of ["ordinarycompressedmessage", "DONE", "  ordinary message\nwith formatting  "]) {
			expect(readMessage({ text })).toEqual({ text });
		}
		for (const input of [{}, { text: " " }, { report: "DONE" }, { report: null }, { report: {} }, { report: reports[0], text: "Extra prose" }]) {
			expect(() => readMessage(input)).toThrow();
		}
		expect(sendParameters.safeParse({ to: "peer", text: "Ordinary message", evidence: "Ignored field" }).success).toBe(false);
	});
});
