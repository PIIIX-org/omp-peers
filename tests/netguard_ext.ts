// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

// Test-only OMP extension: `omp -e <this file>` installs the outbound network guard (tests/netguard.ts) in the OMP process,
// so a smoke scenario that makes any non-loopback connection fails loudly instead of reaching the network.
import "./netguard";

export default function netguard(): void {}
