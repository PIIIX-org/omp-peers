#!/usr/bin/env bun
// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

// Remote end of `/peers hosts`. Started by sshd as a forced command (see docs/features/hosts.md); reads ONE
// JSON request line from stdin, writes ONE JSON line to stdout and exits. It never listens and never connects out.
import * as os from "node:os";
import { serve } from "../lib/features/hosts_bridge";

await serve({ home: os.homedir(), now: Date.now }, process.stdin, process.stdout);
process.exit(0);
