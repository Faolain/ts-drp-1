import { chromium, firefox, webkit } from "@playwright/test";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

import { type ResourceReceipt, resourceStatus } from "./outcome.js";
import type { probe } from "./probe.js";

type Result = Awaited<ReturnType<typeof probe>>;
/** Execute product gates and record completion after all engines and custody checks finish. */
async function main(): Promise<void> {
	const run = process.argv[2] ?? "run-02";
	if (!/^[a-z0-9-]+$/.test(run)) throw new Error("invalid run label");
	const evidence = `.logs/bounded-storage-lifecycle/declaration-discovery-provenance-resource-red-01/${run}`;
	if (existsSync(evidence)) throw new Error("immutable evidence run already exists; supply a fresh label");
	mkdirSync(evidence, { recursive: true });
	const hash = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
	const paths = [
		"packages/canonical/src/index.ts",
		"packages/canonical/dist/src/index.js",
		"specs/bounded-storage-lifecycle/slices/02a-1-failure-provenance.md",
		"tests/fixtures/snapshot-declaration-resource-provenance/probe.ts",
		"tests/fixtures/snapshot-declaration-resource-provenance/child.ts",
		"tests/fixtures/snapshot-declaration-resource-provenance/runner.ts",
		"tests/fixtures/snapshot-declaration-resource-provenance/gates.ts",
		"tests/fixtures/snapshot-declaration-resource-provenance/outcome.ts",
		"tests/fixtures/snapshot-declaration-resource-provenance/outcome-diagnostic.ts",
		"tests/fixtures/snapshot-declaration-resource-provenance/tsconfig.json",
		"tests/fixtures/snapshot-declaration-provenance/canonical-controls.ts",
	];
	const before = Object.fromEntries(paths.map((path) => [path, hash(path)]));
	writeFileSync(`${evidence}/before.json`, JSON.stringify(before, null, 2));
	const args = ["--import", "tsx", "tests/fixtures/snapshot-declaration-resource-provenance/child.ts"];
	const node = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
	writeFileSync(`${evidence}/node.stdout.json`, node.stdout);
	writeFileSync(`${evidence}/node.stderr.txt`, node.stderr);
	writeFileSync(
		`${evidence}/node-terminal.json`,
		JSON.stringify(
			{ command: [process.execPath, ...args], status: node.status, signal: node.signal, error: node.error?.message },
			null,
			2
		)
	);
	const summaries: Record<string, unknown> = {};
	/**
	 * Summarize each independently executed check without hiding later assertions behind a guard.
	 * @param result - Executed native product probe.
	 * @returns Independent coverage counters.
	 */
	function summarize(result: Result): {
		cases: number;
		encoderControl: boolean;
		checks: Record<string, { passed: number; failed: number }>;
		limitation: string;
	} {
		return {
			cases: result.results.length,
			encoderControl: result.encoderControl,
			checks: Object.fromEntries(
				[...new Set(result.results.flatMap((item) => Object.keys(item.checks)))].map((key) => [
					key,
					{
						passed: result.results.filter((item) => item.checks[key] === true).length,
						failed: result.results.filter((item) => item.checks[key] === false).length,
					},
				])
			),
			limitation: result.limitation,
		};
	}
	const nodeResult = JSON.parse(node.stdout) as Result;
	summaries.node = summarize(nodeResult);
	let controlsFailed =
		!nodeResult.encoderControl ||
		nodeResult.results.some((item) => !item.checks.compatibility || !item.checks.hookReached);
	if (node.signal || node.error || (node.status !== 0 && node.status !== 1))
		throw new Error("Node infrastructure failure, not normative RED");
	const nodeBundle = await build({
		entryPoints: ["tests/fixtures/snapshot-declaration-resource-provenance/child.ts"],
		bundle: true,
		platform: "node",
		format: "esm",
		write: false,
		metafile: true,
	});
	const nodeCode = nodeBundle.outputFiles[0]?.text;
	if (!nodeCode || !Object.keys(nodeBundle.metafile.inputs).includes("packages/canonical/dist/src/index.js"))
		throw new Error("wrong Node product binding");
	writeFileSync(`${evidence}/actual-node-bundle.mjs`, nodeCode);
	writeFileSync(`${evidence}/actual-node-metafile.json`, JSON.stringify(nodeBundle.metafile, null, 2));
	const nodeInputsBefore = Object.fromEntries(
		Object.keys(nodeBundle.metafile.inputs).map((path) => [path, hash(path)])
	);
	writeFileSync(`${evidence}/node-bundle-inputs-before.json`, JSON.stringify(nodeInputsBefore, null, 2));
	const bundledNode = spawnSync(process.execPath, [`${evidence}/actual-node-bundle.mjs`], {
		encoding: "utf8",
		timeout: 30000,
		maxBuffer: 16 * 1024 * 1024,
	});
	writeFileSync(`${evidence}/node-bundle.stdout.json`, bundledNode.stdout);
	writeFileSync(`${evidence}/node-bundle.stderr.txt`, bundledNode.stderr);
	writeFileSync(
		`${evidence}/node-bundle-terminal.json`,
		JSON.stringify(
			{
				command: [process.execPath, `${evidence}/actual-node-bundle.mjs`],
				status: bundledNode.status,
				signal: bundledNode.signal,
				error: bundledNode.error?.message,
			},
			null,
			2
		)
	);
	const bundledResult = JSON.parse(bundledNode.stdout) as Result;
	summaries.nodeBundled = summarize(bundledResult);
	controlsFailed ||=
		!bundledResult.encoderControl ||
		bundledResult.results.some((item) => !item.checks.compatibility || !item.checks.hookReached);
	if (bundledNode.signal || bundledNode.error || (bundledNode.status !== 0 && bundledNode.status !== 1))
		throw new Error("Bundled Node infrastructure failure, not normative RED");
	const bundle = await build({
		entryPoints: ["tests/fixtures/snapshot-declaration-resource-provenance/probe.ts"],
		bundle: true,
		platform: "browser",
		format: "esm",
		write: false,
		metafile: true,
	});
	const code = bundle.outputFiles[0]?.text;
	if (
		!code ||
		!Object.keys(bundle.metafile.inputs).includes("packages/canonical/dist/src/index.js") ||
		Object.keys(bundle.metafile.inputs).includes("packages/canonical/src/index.ts")
	)
		throw new Error("wrong product bundle binding");
	writeFileSync(`${evidence}/actual-browser-bundle.js`, code);
	writeFileSync(`${evidence}/actual-browser-metafile.json`, JSON.stringify(bundle.metafile, null, 2));
	const browserInputsBefore = Object.fromEntries(Object.keys(bundle.metafile.inputs).map((path) => [path, hash(path)]));
	writeFileSync(`${evidence}/bundle-inputs-before.json`, JSON.stringify(browserInputsBefore, null, 2));
	const server = createServer((request, response) => {
		response.setHeader("cache-control", "no-store");
		if (request.url === "/probe.js") response.writeHead(200, { "content-type": "text/javascript" }).end(code);
		else response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><meta charset=utf-8>");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing server address");
	try {
		for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
			const browser = await engine.launch({ headless: true });
			try {
				const page = await browser.newPage();
				await page.goto(`http://127.0.0.1:${address.port}`);
				const result = await page.evaluate(async () => {
					const modulePath = "/probe.js";
					const module = (await import(modulePath)) as { probe: typeof probe };
					return module.probe();
				});
				writeFileSync(`${evidence}/${name}.json`, JSON.stringify(result));
				controlsFailed ||=
					!result.encoderControl ||
					result.results.some((item) => !item.checks.compatibility || !item.checks.hookReached);
				summaries[name] = {
					version: browser.version(),
					...summarize(result),
					normativeStatus: result.results.every((item) => Object.values(item.checks).every(Boolean)) ? 0 : 1,
				};
			} finally {
				await browser.close();
			}
		}
	} finally {
		server.close();
	}
	const after = Object.fromEntries(paths.map((path) => [path, hash(path)]));
	const nodeInputsAfter = Object.fromEntries(Object.keys(nodeBundle.metafile.inputs).map((path) => [path, hash(path)]));
	const browserInputsAfter = Object.fromEntries(Object.keys(bundle.metafile.inputs).map((path) => [path, hash(path)]));
	writeFileSync(`${evidence}/node-bundle-inputs-after.json`, JSON.stringify(nodeInputsAfter, null, 2));
	writeFileSync(`${evidence}/after.json`, JSON.stringify(after, null, 2));
	writeFileSync(`${evidence}/bundle-inputs-after.json`, JSON.stringify(browserInputsAfter, null, 2));
	if (
		JSON.stringify(before) !== JSON.stringify(after) ||
		JSON.stringify(nodeInputsBefore) !== JSON.stringify(nodeInputsAfter) ||
		JSON.stringify(browserInputsBefore) !== JSON.stringify(browserInputsAfter)
	)
		throw new Error("protected bytes changed");
	const summaryText = JSON.stringify(summaries, null, 2);
	writeFileSync(`${evidence}/summary.json`, summaryText);
	console.log(JSON.stringify(summaries, null, 2));
	const status = controlsFailed ? 2 : resourceStatus(summaries);
	const receipt: ResourceReceipt = {
		completed: true,
		run,
		status,
		summarySha256: createHash("sha256").update(summaryText).digest("hex"),
	};
	writeFileSync(`${evidence}/completed-outcome.json`, JSON.stringify(receipt, null, 2));
	process.exitCode = status;
}

try {
	await main();
} catch (error) {
	console.error(error);
	process.exitCode = 2;
}
