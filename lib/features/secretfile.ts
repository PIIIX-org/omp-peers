// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

/**
 * Reading a credential from a file the user keeps outside the repository.
 *
 * The file must be a regular file owned by the current user with no group or other permission bits
 * (mode 0600 or stricter), reached without following a symlink at the final path component, and
 * 16 to 256 bytes long once one trailing newline is removed. Opening is non-blocking so a FIFO fails
 * fast instead of hanging the caller. The value is returned to the caller and never logged here;
 * error messages name the path and the rule, never the content.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const SECRET_MIN_BYTES = 16;
export const SECRET_MAX_BYTES = 256;

/** The plugin's own directory: a credential stored inside it could be committed or published with it. */
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Whether `file` lies inside `root` after lexical resolution. */
export function isInside(file: string, root: string): boolean {
	const relative = path.relative(root, path.resolve(file));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The credential in `file`, or an Error naming the violated rule. */
export function readSecretFile(file: string): string {
	if (!path.isAbsolute(file)) throw new Error("secret file path must be absolute");
	if (isInside(file, PLUGIN_ROOT)) throw new Error("secret file must be outside the plugin directory");
	let fd: number;
	try {
		fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ELOOP") throw new Error(`secret file ${file} is a symlink; refusing to read it`);
		if (code === "ENOENT") throw new Error(`secret file ${file} does not exist`);
		throw new Error(`secret file ${file} cannot be opened (${code ?? "error"})`);
	}
	try {
		const info = fs.fstatSync(fd);
		if (!info.isFile()) throw new Error(`secret file ${file} is not a regular file`);
		if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error(`secret file ${file} is not owned by the current user`);
		if ((info.mode & 0o077) !== 0) throw new Error(`secret file ${file} must not be accessible to group or others (chmod 600)`);
		// One byte over the maximum plus a possible "\r\n" is enough to decide; never read an unbounded file.
		if (info.size > SECRET_MAX_BYTES + 2) throw new Error(`secret file ${file} is larger than ${SECRET_MAX_BYTES} bytes`);
		const buffer = Buffer.alloc(SECRET_MAX_BYTES + 3);
		let length = 0;
		for (;;) {
			const n = fs.readSync(fd, buffer, length, buffer.length - length, null);
			if (n === 0) break;
			length += n;
			if (length >= buffer.length) break;
		}
		let text = buffer.subarray(0, length).toString("utf8");
		if (text.endsWith("\n")) text = text.slice(0, text.endsWith("\r\n") ? -2 : -1);
		const bytes = Buffer.byteLength(text);
		if (bytes < SECRET_MIN_BYTES || bytes > SECRET_MAX_BYTES) throw new Error(`secret file ${file} must hold ${SECRET_MIN_BYTES} to ${SECRET_MAX_BYTES} bytes`);
		return text;
	} finally {
		fs.closeSync(fd);
	}
}
