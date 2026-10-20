import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildCanvasChatLullAssets } from "./build.js";

// Track Q: bundles the browser side from the current tree for every run.
export default async function globalSetup(): Promise<void> {
	const evidence = process.env.CANVAS_CHAT_LULL_EVIDENCE ?? mkdtempSync(path.join(os.tmpdir(), "ccl-evidence-"));
	mkdirSync(evidence, { recursive: true });
	process.env.CANVAS_CHAT_LULL_EVIDENCE = evidence;
	const assets = mkdtempSync(path.join(evidence, "assets-"));
	const built = await buildCanvasChatLullAssets(assets);
	if (built.distResolved.length !== 0)
		throw new Error(`CANVAS_CHAT_LULL_DIST_RESOLVED ${built.distResolved.join(",")}`);
	process.env.CANVAS_CHAT_LULL_ASSET_DIR = assets;
}
