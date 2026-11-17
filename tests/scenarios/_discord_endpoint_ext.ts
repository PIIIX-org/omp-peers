// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

// Test-only OMP extension, loaded by the Discord scenario with `omp -e <this file>`; it is not part of the plugin and not shipped.
// It points the plugin's Discord bridge at the scenario's fake Discord on this machine. The plugin itself reads no environment
// variable and has no switch for this: the endpoint can only be replaced by code that imports the module, as this file does.
import { setTestEndpoint } from "../../lib/features/discord";

export default function discordTestEndpoint(): void {
	const origin = process.env.OMP_PEERS_SCENARIO_DISCORD_ORIGIN;
	if (origin) setTestEndpoint(origin);
}
