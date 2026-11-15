// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors
import type { FeatureHost } from "./host";
import { pause, resume } from "./pause";
import { rules } from "./rules";

export interface Feature {
	/** `/peers <name> ...` routes to `command`. */
	name: string;
	summary: string;
	/** `args` are the whitespace-split tokens after the feature name. Returns text shown to the user. */
	command(args: string[], host: FeatureHost): Promise<string>;
	/** Context added before this session's next agent start; undefined adds nothing. May throw. */
	agentContext?(host: FeatureHost): string | undefined;
}

// One line per feature; a new feature adds its module and one entry here.
export const FEATURES: Feature[] = [rules, pause, resume];
