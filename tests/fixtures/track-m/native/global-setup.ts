import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildTrackM14fAssets } from "./build.js";

// Track M, slice 14f: bundles the browser side from the current working tree for every
// run and records exactly which sources were tested (HEAD, dirty state, and a digest of
// every bundled source file).
export default async function globalSetup(): Promise<void> {
	const root = path.resolve(import.meta.dirname, "../../../..");
	const evidence = process.env.TRACK_M_14F_EVIDENCE ?? mkdtempSync(path.join(os.tmpdir(), "tm14f-evidence-"));
	mkdirSync(evidence, { recursive: true });
	process.env.TRACK_M_14F_EVIDENCE = evidence;
	const assets = mkdtempSync(path.join(evidence, "assets-"));
	const built = await buildTrackM14fAssets(assets);
	if (built.distResolved.length !== 0) throw new Error(`TRACK_M_14F_DIST_RESOLVED ${built.distResolved.join(",")}`);
	const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	const hash = createHash("sha256");
	for (const input of [...built.inputs].sort()) {
		hash.update(input);
		hash.update(readFileSync(path.resolve(root, input)));
	}
	const status = git("status", "--porcelain");
	const source = {
		head: git("rev-parse", "HEAD"),
		dirty: status.length !== 0,
		status: status.split("\n").filter((line) => line.length !== 0),
		bundledSourceDigest: hash.digest("hex"),
		bundledInputs: built.inputs.length,
		builtAt: new Date().toISOString(),
	};
	writeFileSync(path.join(assets, "source.json"), JSON.stringify(source, null, 1));
	process.env.TRACK_M_14F_ASSET_DIR = assets;
	process.env.TRACK_M_14F_SOURCE = JSON.stringify({
		head: source.head,
		dirty: source.dirty,
		bundledSourceDigest: source.bundledSourceDigest,
	});
}
