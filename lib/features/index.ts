// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
import type { zod } from "@oh-my-pi/pi-coding-agent";
import type { Report } from "../reports";
import { autocompact } from "./autocompact";
import { board } from "./board";
import { dashboard } from "./dashboard";
import { deps } from "./deps";
import { digest } from "./digest";
import { events } from "./events";
import { groups } from "./groups";
import type { FeatureHost } from "./host";
import { audit } from "./audit";
import { inbox } from "./inbox";
import { locks } from "./locks";
import { pause, resume } from "./pause";
import { rules } from "./rules";
import { templates } from "./templates";
import { usage } from "./usage";
import { watchdog } from "./watchdog";

/** An LLM tool a feature contributes. The extension registers it; the feature never imports host runtime values. */
export interface ToolSpec {
	name: string;
	label: string;
	description: string;
	/** Built with the host's zod namespace. */
	parameters(z: typeof zod): ReturnType<(typeof zod)["object"]>;
	/** `params` are unvalidated model output: check them. `isError` marks a failed call. */
	execute(params: Record<string, unknown>, host: FeatureHost): Promise<{ text: string; isError?: boolean }>;
}

export interface Feature {
	/** `/peers <name> ...` routes to `command`. */
	name: string;
	/** `args` are the whitespace-split tokens after the feature name. Returns text shown to the user. */
	command(args: string[], host: FeatureHost): Promise<string>;
	/** Context added before this session's next agent start; undefined adds nothing. May throw. */
	agentContext?(host: FeatureHost): string | undefined | Promise<string | undefined>;
	/** A structured report this session accepted; `from` is the sender's claimed identity, not authenticated. May reject. */
	onReport?(report: Report, from: { id: string; name: string }, host: FeatureHost): Promise<void>;
	/** LLM tools registered once at extension load; each call receives the calling session's host. */
	tools?(): ToolSpec[];
	/** Periodic work, run from the master session's 5 s refresh only. May throw: the extension warns once and carries on. */
	tick?(host: FeatureHost): Promise<void>;
}

// One line per feature; a new feature adds its module and one entry here.
export const FEATURES: Feature[] = [rules, inbox, board, pause, resume, locks, groups, audit, deps, templates, watchdog, autocompact, digest, usage, dashboard, events];
