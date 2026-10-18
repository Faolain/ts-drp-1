import { chromium, firefox, webkit } from "@playwright/test";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

import type { probe } from "./probe.js";

type Result = Awaited<ReturnType<typeof probe>>;

/** Run actual product ownership cases and native controls, with immutable evidence. */
async function main(): Promise<void> {
	const label = process.argv[2];
	if (!label || !/^[a-z0-9-]+$/.test(label)) throw new Error("supply fresh lowercase run label");
	const base = ".logs/bounded-storage-lifecycle/declaration-discovery-provenance-ownership-red-01";
	mkdirSync(base, { recursive: true });
	const evidence = `${base}/${label}`;
	if (existsSync(evidence)) throw new Error("immutable run already exists");
	mkdirSync(evidence);
	const fixture = "tests/fixtures/snapshot-declaration-ownership-provenance";
	const hash = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
	const protectedPaths = [
		"packages/storage/src/snapshot-transfer.ts",
		"packages/storage/dist/src/snapshot-transfer.js",
		"packages/protocol-v3/src/snapshot-transfer.ts",
		"packages/protocol-v3/dist/src/snapshot-transfer.js",
		"packages/canonical/src/index.ts",
		"packages/canonical/dist/src/index.js",
		"specs/bounded-storage-lifecycle/slices/02a-1-failure-provenance.md",
		...["probe.ts", "child.ts", "runner.ts", "gates.ts", "tsconfig.json"].map((name) => `${fixture}/${name}`),
	];
	const before = Object.fromEntries(protectedPaths.map((path) => [path, hash(path)]));
	writeFileSync(`${evidence}/before.json`, JSON.stringify(before, null, 2));
	const bundles = {} as Record<"node" | "browser", string>;
	const graphs: Record<string, Record<string, string>> = {};
	for (const platform of ["node", "browser"] as const) {
		const bundle = await build({
			entryPoints: [`${fixture}/${platform === "node" ? "child" : "probe"}.ts`],
			bundle: true,
			platform,
			format: "esm",
			write: false,
			metafile: true,
			keepNames: true,
		});
		const code = bundle.outputFiles[0]?.text;
		const inputs = Object.keys(bundle.metafile.inputs);
		if (
			!code ||
			![
				"packages/storage/dist/src/snapshot-transfer.js",
				"packages/protocol-v3/dist/src/snapshot-transfer.js",
				"packages/canonical/dist/src/index.js",
			].every((path) => inputs.includes(path)) ||
			inputs.some((path) => /^packages\/(storage|protocol-v3|canonical)\/src\//.test(path))
		)
			throw new Error("incorrect product bundle dependency binding");
		bundles[platform] = code;
		writeFileSync(`${evidence}/${platform}-bundle.mjs`, code);
		writeFileSync(`${evidence}/${platform}-metafile.json`, JSON.stringify(bundle.metafile, null, 2));
		graphs[platform] = Object.fromEntries(inputs.map((path) => [path, hash(path)]));
	}
	writeFileSync(`${evidence}/graphs-before.json`, JSON.stringify(graphs, null, 2));
	const results: Record<string, Result> = {};
	for (const nodeMode of ["direct", "bundled"]) {
		for (const mode of ["control", "observe"]) {
			const args =
				nodeMode === "direct"
					? ["--import", "tsx", `${fixture}/child.ts`, mode]
					: [`${evidence}/node-bundle.mjs`, mode];
			const child = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
			const key = `node-${nodeMode}-${mode}`;
			writeFileSync(`${evidence}/${key}.stdout.json`, child.stdout ?? "");
			writeFileSync(`${evidence}/${key}.stderr.txt`, child.stderr ?? "");
			writeFileSync(
				`${evidence}/${key}.terminal.json`,
				JSON.stringify(
					{
						command: [process.execPath, ...args],
						status: child.status,
						signal: child.signal,
						error: child.error?.message,
					},
					null,
					2
				)
			);
			if (child.signal || child.error || (child.status !== 0 && child.status !== 1))
				throw new Error(`${key}: infrastructure or control failure, not RED`);
			results[key] = JSON.parse(child.stdout) as Result;
		}
	}
	const server = createServer((request, response) => {
		response.setHeader("cache-control", "no-store");
		if (request.url === "/probe.js")
			response.writeHead(200, { "content-type": "text/javascript" }).end(bundles.browser);
		else response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><meta charset=utf-8>");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("server address missing");
	const versions: Record<string, string> = {};
	try {
		for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
			const browser = await engine.launch({ headless: true });
			versions[name] = browser.version();
			try {
				for (const instrument of [false, true]) {
					const page = await browser.newPage();
					try {
						await page.goto(`http://127.0.0.1:${address.port}`);
						const result = await page.evaluate(async (observe) => {
							const path = "/probe.js";
							const module = (await import(path)) as { probe: typeof probe };
							return module.probe(observe);
						}, instrument);
						const key = `${name}-${instrument ? "observe" : "control"}`;
						results[key] = result;
						writeFileSync(`${evidence}/${key}.json`, JSON.stringify(result, null, 2));
					} finally {
						await page.close();
					}
				}
			} finally {
				await browser.close();
			}
		}
	} finally {
		server.close();
	}
	const after = Object.fromEntries(protectedPaths.map((path) => [path, hash(path)]));
	const graphsAfter = Object.fromEntries(
		Object.entries(graphs).map(([platform, graph]) => [
			platform,
			Object.fromEntries(Object.keys(graph).map((path) => [path, hash(path)])),
		])
	);
	writeFileSync(`${evidence}/after.json`, JSON.stringify(after, null, 2));
	writeFileSync(`${evidence}/graphs-after.json`, JSON.stringify(graphsAfter, null, 2));
	if (JSON.stringify(before) !== JSON.stringify(after) || JSON.stringify(graphs) !== JSON.stringify(graphsAfter))
		throw new Error("protected inputs changed");
	const engines = ["node-direct", "node-bundled", "chromium", "firefox", "webkit"];
	const expectedIds = ["17-recovery", "17-legacy", "131080-recovery", "131080-legacy"];
	const summary = engines.map((engine) => {
		const observed = results[`${engine}-observe`];
		const control = results[`${engine}-control`];
		if (
			!observed ||
			!control ||
			observed.instrument !== true ||
			control.instrument !== false ||
			JSON.stringify(observed.results.map((item) => item.id)) !== JSON.stringify(expectedIds) ||
			JSON.stringify(control.results.map((item) => item.id)) !== JSON.stringify(expectedIds)
		)
			throw new Error("incomplete engine matrix");
		const ownerAttribution = observed.results.flatMap((item) =>
			item.observations
				.filter((event) => event.kind === "decoder-return")
				.map((event) => {
					if (/decodeSnapshotManifest/.test(event.stack))
						return { id: item.id, kind: "direct-decoder-frame", pass: true };
					const frame = /validateRecoveryManifest[^\n]*:(\d+):(\d+)\)?$/m.exec(event.stack);
					const line = Number(frame?.[1]);
					const column = Number(frame?.[2]);
					const statement =
						(engine === "node-direct"
							? ""
							: bundles[engine === "node-bundled" ? "node" : "browser"].split("\n")[line - 1]) ?? "";
					return {
						id: item.id,
						kind: "tail-call-elided-decoder-frame",
						line,
						column,
						statement,
						pass:
							!!frame &&
							/const decoded = decodeSnapshotManifest\(\{/.test(statement) &&
							column > statement.indexOf("decodeSnapshotManifest") &&
							column <= statement.length + 1,
					};
				})
		);
		return {
			engine,
			ownerAttribution,
			version: versions[engine] ?? process.version,
			controlsPass:
				[...observed.results, ...control.results].every((item) => Object.values(item.controls).every(Boolean)) &&
				control.results.every((item) => item.normative === null) &&
				ownerAttribution.length === 8 &&
				ownerAttribution.every((item) => item.pass),
			observationMatchesNoHook: observed.results.every((item, index) => item.value === control.results[index]?.value),
			cases: observed.results.map((item) => ({
				id: item.id,
				normative: item.normative,
				sharedCopies: item.observations.filter((event) => event.kind === "set" && /\bexactBytes\b/.test(event.stack))
					.length,
				decoderReturns: item.observations.filter((event) => event.kind === "decoder-return").length,
			})),
		};
	});
	const status = summary.some((item) => !item.controlsPass || !item.observationMatchesNoHook)
		? 2
		: summary.some((item) =>
					item.cases.some((entry) => !entry.normative || Object.values(entry.normative).some((pass) => !pass))
			  )
			? 1
			: 0;
	const text = JSON.stringify(summary, null, 2);
	writeFileSync(`${evidence}/summary.json`, text);
	writeFileSync(
		`${evidence}/completed-outcome.json`,
		JSON.stringify(
			{
				completed: true,
				label,
				status,
				engines,
				casesPerEngine: 4,
				summarySha256: createHash("sha256").update(text).digest("hex"),
			},
			null,
			2
		)
	);
	console.log(text);
	process.exitCode = status;
}

try {
	await main();
} catch (error) {
	console.error(error);
	process.exitCode = 2;
}
