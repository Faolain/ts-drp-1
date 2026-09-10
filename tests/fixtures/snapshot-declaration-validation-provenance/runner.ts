import { chromium, firefox, webkit } from "@playwright/test";
import { build } from "esbuild";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

import { type probe, SENTINELS, STAGES } from "./probe.js";

type Observation = Awaited<ReturnType<typeof probe>>;
const fixture = "tests/fixtures/snapshot-declaration-validation-provenance/";
const root = ".logs/bounded-storage-lifecycle/declaration-discovery-provenance-validation-red-01/";
const label = process.argv[2];
if (!label || !/^[a-z0-9-]+$/.test(label) || existsSync(root + label))
	throw new Error("supply fresh immutable run label");
const directory = root + label;
mkdirSync(directory, { recursive: true });
const save = (name: string, value: unknown): void => {
	writeFileSync(directory + "/" + name, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
};
const hash = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const cases = STAGES.flatMap((stage) => SENTINELS.map((sentinel) => ({ stage, sentinel })));
const observations: { engine: string; result: Observation }[] = [];

/** Run bounded fresh contexts and certify completed results only after custody checks. */
async function main(): Promise<void> {
	const graphs = [];
	for (const [name, entry, platform] of [
		["node", "child.ts", "node"],
		["browser", "probe.ts", "browser"],
		["consumer", "consumer.ts", "node"],
	] as const) {
		const built = await build({
			entryPoints: [fixture + entry],
			platform,
			format: "esm",
			bundle: true,
			write: false,
			metafile: true,
		});
		const bytes = built.outputFiles[0]?.text;
		assert.ok(bytes);
		assert.ok(Object.keys(built.metafile.inputs).includes("packages/canonical/dist/src/index.js"));
		assert.ok(!Object.keys(built.metafile.inputs).includes("packages/canonical/src/index.ts"));
		const path = directory + "/" + name + ".mjs";
		writeFileSync(path, bytes, { flag: "wx" });
		graphs.push({ name, path, sha256: hash(bytes), metafile: built.metafile });
	}
	save("graphs.json", graphs);
	const paths = [
		...new Set(
			graphs
				.flatMap((graph) => Object.keys(graph.metafile.inputs))
				.concat([fixture + "runner.ts", fixture + "tsconfig.json"])
		),
	];
	const hashes = (): Record<string, string> =>
		Object.fromEntries(paths.map((path) => [path, hash(readFileSync(path))]));
	const before = hashes();
	save("before.json", before);
	for (const engine of ["node-direct", "node-bundle"]) {
		for (const selected of cases) {
			const args =
				engine === "node-direct"
					? ["--import", "tsx", fixture + "child.ts", selected.stage, selected.sentinel]
					: [directory + "/node.mjs", selected.stage, selected.sentinel];
			const child = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
			save(`${engine}-${selected.stage}-${selected.sentinel}.json`, {
				command: [process.execPath, ...args],
				exit: child.status,
				signal: child.signal,
				error: child.error?.message,
				stdout: child.stdout,
				stderr: child.stderr,
			});
			assert.equal(child.error, undefined);
			assert.equal(child.signal, null);
			assert.equal(child.status, 0);
			observations.push({ engine, result: JSON.parse(child.stdout) as Observation });
		}
		console.log(
			JSON.stringify({
				engine,
				cases: 15,
				classifications: observations
					.filter((item) => item.engine === engine)
					.map((item) => item.result.classification),
			})
		);
	}
	const consumer = spawnSync(process.execPath, [directory + "/consumer.mjs"], {
		encoding: "utf8",
		timeout: 10000,
		maxBuffer: 2 * 1024 * 1024,
	});
	save("consumer.json", {
		exit: consumer.status,
		signal: consumer.signal,
		error: consumer.error?.message,
		stdout: consumer.stdout,
		stderr: consumer.stderr,
	});
	assert.equal(consumer.error, undefined);
	assert.equal(consumer.status, 0);
	assert.equal(consumer.signal, null);
	const server = createServer((request, response) => {
		response.setHeader("cache-control", "no-store");
		if (request.url === "/probe.js")
			response.writeHead(200, { "content-type": "text/javascript" }).end(readFileSync(directory + "/browser.mjs"));
		else response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><meta charset=utf-8>");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	try {
		for (const [engine, launcher] of Object.entries({ chromium, firefox, webkit })) {
			const browser = await launcher.launch({ headless: true });
			try {
				for (const selected of cases) {
					const context = await browser.newContext();
					try {
						const page = await context.newPage();
						await page.goto(`http://127.0.0.1:${address.port}`);
						const result = await page.evaluate(async (selected) => {
							const path = "/probe.js";
							const module = (await import(path)) as { probe: typeof probe };
							return module.probe(selected.stage, selected.sentinel);
						}, selected);
						observations.push({ engine, result });
						save(`${engine}-${selected.stage}-${selected.sentinel}.json`, { version: browser.version(), result });
					} finally {
						await context.close();
					}
				}
			} finally {
				await browser.close();
			}
			console.log(JSON.stringify({ engine, cases: 15 }));
		}
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
	const after = hashes();
	save("after.json", after);
	assert.deepEqual(after, before);
	assert.equal(observations.length, 75);
	for (const engine of ["node-direct", "node-bundle", "chromium", "firefox", "webkit"]) {
		const selected = observations.filter((item) => item.engine === engine);
		assert.equal(selected.length, 15);
		assert.equal(new Set(selected.map((item) => item.result.stage + ":" + item.result.variant)).size, 15);
	}
	const badControls = observations.filter(
		(item) =>
			!Object.values(item.result.controls).every(Boolean) || item.result.classification === "HARNESS_OR_CONTROL_FAILURE"
	);
	const red = observations.filter((item) => item.result.classification !== "PASS");
	const status = badControls.length ? 2 : red.length ? 1 : 0;
	const summary = {
		status,
		complete: true,
		cases: observations.length,
		badControls: badControls.length,
		absent: observations.filter((item) => item.result.classification === "ABSENT_VALIDATION_PATH").length,
		propagationGaps: observations.filter((item) => item.result.classification === "VALIDATION_PROPAGATION_GAP").length,
		passes: observations.length - red.length,
		graphs,
		observations,
		consumer: JSON.parse(consumer.stdout) as unknown,
	};
	save("summary.json", summary);
	save("completed.json", {
		status,
		cases: 75,
		summarySha256: hash(readFileSync(directory + "/summary.json")),
		unchanged: true,
	});
	console.log(
		JSON.stringify({ status, absent: summary.absent, passes: summary.passes, badControls: summary.badControls })
	);
	process.exitCode = status;
}
main().catch((error) => {
	save("infrastructure-failure.json", { message: String(error), stack: error instanceof Error ? error.stack : null });
	console.error(error);
	process.exitCode = 2;
});
