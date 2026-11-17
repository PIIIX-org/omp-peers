// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

// Test-only OMP extension: `omp -e <this file>` installs the outbound network guard (tests/netguard.ts) in the OMP process,
// so a smoke scenario that makes any non-loopback connection fails loudly instead of reaching the network. It also
// registers `/netguard-probe`, which the smoke harness runs at startup to prove the guard is live in this very process.
import net from "node:net";
import { expectViolations } from "./netguard_policy";
import "./netguard";

/** Reserved `.invalid` name: never resolves, and the guard must refuse it before any lookup. */
const PROBE_HOST = "netguard-probe.invalid";

interface CommandHost {
	registerCommand(name: string, options: { description: string; handler: (args: string, ctx: { ui: { notify(message: string, type?: string): void } }) => Promise<void> }): void;
}

export default function netguard(pi: CommandHost): void {
	pi.registerCommand("netguard-probe", {
		description: "Test-only: attempt a non-loopback connection and report whether the guard refused it",
		handler: async (_args, ctx) => {
			let socket: net.Socket | undefined;
			const refused = await expectViolations(() => {
				try {
					socket = net.connect(9, PROBE_HOST);
					socket.on("error", () => {});
				} catch {
					// the guard threw, as intended
				}
			});
			socket?.destroy();
			ctx.ui.notify(refused.length > 0 ? "netguard-probe:refused" : "netguard-probe:OPEN", "info");
		},
	});
}
