import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildTrackMAppsAssets } from "./build.js";

// Track M measurement: bundles the browser side from the current tree for every run.
export default async function globalSetup(): Promise<void> {
	const evidence = process.env.TRACK_M_APPS_EVIDENCE ?? mkdtempSync(path.join(os.tmpdir(), "tma-evidence-"));
	mkdirSync(evidence, { recursive: true });
	process.env.TRACK_M_APPS_EVIDENCE = evidence;
	const assets = mkdtempSync(path.join(evidence, "assets-"));
	const built = await buildTrackMAppsAssets(assets);
	if (built.distResolved.length !== 0) throw new Error(`TRACK_M_APPS_DIST_RESOLVED ${built.distResolved.join(",")}`);
	process.env.TRACK_M_APPS_ASSET_DIR = assets;
}
