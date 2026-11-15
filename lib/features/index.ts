// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
import type { zod } from "@oh-my-pi/pi-coding-agent";
import type { FeatureHost } from "./host";
import { audit } from "./audit";
import { inbox } from "./inbox";
import { rules } from "./rules";

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
	agentContext?(host: FeatureHost): string | undefined;
	/** LLM tools registered once at extension load; each call receives the calling session's host. */
	tools?(): ToolSpec[];
}

// One line per feature; a new feature adds its module and one entry here.
export const FEATURES: Feature[] = [rules, inbox, audit];
