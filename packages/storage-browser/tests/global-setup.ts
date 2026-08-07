import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

/**
 *
 */
export default async function globalSetup(): Promise<void> {
	const packageDirectory = path.resolve(import.meta.dirname, "..");
	const assetDirectory = fs.mkdtempSync(path.join(packageDirectory, ".phase-2b-assets-"));
	const artifactDirectory = path.resolve(
		packageDirectory,
		"../..",
		".logs/phase-2b-process-death-green-codex-high/artifacts"
	);
	fs.rmSync(artifactDirectory, { recursive: true, force: true });
	fs.mkdirSync(artifactDirectory, { recursive: true });
	await build({
		entryPoints: {
			"page-entry": path.join(packageDirectory, "tests/assets/page-entry.ts"),
			"worker-entry": path.join(packageDirectory, "tests/assets/worker-entry.ts"),
			"seed-entry": path.join(packageDirectory, "tests/assets/seed-entry.ts"),
			"oracle-entry": path.join(packageDirectory, "tests/assets/oracle-entry.ts"),
		},
		outdir: assetDirectory,
		bundle: true,
		format: "esm",
		platform: "browser",
		target: "es2022",
	});
	await build({
		entryPoints: {
			"settled-child": path.join(packageDirectory, "tests/process/settled-child.ts"),
			"arming-child": path.join(packageDirectory, "tests/process/arming-child.ts"),
			"crash-child": path.join(packageDirectory, "tests/process/crash-child.ts"),
			"browser-smoke-child": path.join(packageDirectory, "tests/process/browser-smoke-child.ts"),
		},
		outdir: assetDirectory,
		bundle: true,
		format: "esm",
		platform: "node",
		packages: "external",
		target: "node22",
	});
	const transitionGraph = `${fs.readFileSync(path.join(assetDirectory, "page-entry.js"), "utf8")}\n${fs.readFileSync(
		path.join(assetDirectory, "worker-entry.js"),
		"utf8"
	)}`;
	const seedGraph = fs.readFileSync(path.join(assetDirectory, "seed-entry.js"), "utf8");
	const oracleGraph = fs.readFileSync(path.join(assetDirectory, "oracle-entry.js"), "utf8");
	if (transitionGraph.includes("oracle database") || transitionGraph.includes("seed database")) {
		throw new TypeError("transition browser bundle graph contains seed or oracle implementation");
	}
	if (seedGraph.includes("oracle database") || seedGraph.includes("preflight-cursor-open")) {
		throw new TypeError("seed browser bundle graph contains recovery or transition implementation");
	}
	if (oracleGraph.includes("seed database") || oracleGraph.includes("preflight-cursor-open")) {
		throw new TypeError("oracle browser bundle graph contains mutation implementation");
	}
	fs.writeFileSync(
		path.join(artifactDirectory, "bundle-graph-proof.txt"),
		"transition: instrumented transition only\nseed: instrumented seed only\noracle: read-only oracle only\n",
		"utf8"
	);
	fs.writeFileSync(
		path.join(assetDirectory, "index.html"),
		'<!doctype html><meta charset="utf-8"><script type="module" src="./page-entry.js"></script>',
		"utf8"
	);
	fs.writeFileSync(
		path.join(assetDirectory, "seed.html"),
		'<!doctype html><meta charset="utf-8"><script type="module" src="./seed-entry.js"></script>',
		"utf8"
	);
	fs.writeFileSync(
		path.join(assetDirectory, "oracle.html"),
		'<!doctype html><meta charset="utf-8"><script type="module" src="./oracle-entry.js"></script>',
		"utf8"
	);
	process.env.PHASE_2B_ASSET_DIR = assetDirectory;
	process.env.PHASE_2B_ARTIFACT_DIR = artifactDirectory;
}
