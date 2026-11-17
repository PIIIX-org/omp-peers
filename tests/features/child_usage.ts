// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

// Child process for concurrency tests: `bun child_usage.ts <home> <peer-id> <tag> <count>` turns publishing on for <peer-id> and adds <count> custom prices.
import { setPrice, setPublishing } from "../../lib/features/usage";

const [home, id, tag, count] = process.argv.slice(2);
const result = await setPublishing(home, id, true, new Set([id]));
if (!result.ok) throw new Error(result.error);
for (let i = 0; i < Number(count); i++) {
	const price = await setPrice(home, `${tag}/model-${i}`, "1", "2");
	if (!price.ok) throw new Error(price.error);
}
