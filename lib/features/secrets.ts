// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

// Conservative credential patterns (same families as scripts/leak_scan.py, plus URL userinfo).
const SECRET_PATTERNS: RegExp[] = [
	/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,})\b/,
	/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
	/["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|token|client[_-]?secret|secret|passwd|password)["']?\s*[:=]\s*["']?[A-Za-z0-9_./+~=-]{12,}/i,
	/\bBearer\s+[A-Za-z0-9_./+~=-]{16,}/i,
	/:\/\/[^\s/:@]+:[^\s/@]+@/,
];

/** Whether `text` looks like a credential. A conservative pattern screen, not a guarantee. */
export function looksLikeSecret(text: string): boolean {
	return SECRET_PATTERNS.some(pattern => pattern.test(text));
}
