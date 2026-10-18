import { chromium, firefox, webkit } from "@playwright/test";
import { build } from "esbuild";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

import type { Case, run } from "./common.js";

type Result = Awaited<ReturnType<typeof run>>;
const fixture = "tests/fixtures/snapshot-declaration-manifest-determinism/";
const base = ".logs/bounded-storage-lifecycle/declaration-discovery-provenance-deterministic-red-01/";
const label = process.argv[2];
if (!label || !/^[a-z0-9-]+$/.test(label) || existsSync(base + label))
	throw new Error("fresh immutable run label required");
const directory = base + label;
mkdirSync(directory, { recursive: true });
const save = (name: string, value: unknown): void => {
	writeFileSync(directory + "/" + name, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
};
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const cases: Case[] = ["bom-byte-comparison", "oversized-carrier"];

/** Execute native cases with actual retained bundles and completed input-custody receipts. */
async function main(): Promise<void> {
	const graphs = [];
	const text: Record<string, string> = {};
	for (const [name, entry, platform] of [
		["node-owner", "node-owner.ts", "node"],
		["node-bootstrap", "node-child.ts", "node"],
		["browser-owner", "browser-owner.ts", "browser"],
		["browser-bootstrap", "browser-entry.ts", "browser"],
	] as const) {
		const result = await build({
			entryPoints: [fixture + entry],
			platform,
			bundle: true,
			format: "esm",
			write: false,
			metafile: true,
		});
		const code = result.outputFiles[0]?.text;
		assert.ok(code);
		text[name] = code;
		const inputs = Object.keys(result.metafile.inputs);
		if (name.endsWith("owner")) {
			for (const path of [
				"packages/canonical/dist/src/index.js",
				"packages/protocol-v3/dist/src/snapshot-transfer.js",
				"packages/storage/dist/src/snapshot-transfer.js",
				`packages/storage-${platform === "node" ? "node" : "browser"}/src/snapshot-transfer.ts`,
			])
				assert.ok(inputs.includes(path), path);
			assert.ok(
				!inputs.includes(`packages/storage-${platform === "node" ? "node" : "browser"}/dist/src/snapshot-transfer.js`)
			);
		} else assert.ok(inputs.every((path) => !path.startsWith("packages/")));
		const path = directory + "/" + name + ".mjs";
		writeFileSync(path, code, { flag: "wx" });
		graphs.push({ name, entry: fixture + entry, platform, path, sha256: hash(code), metafile: result.metafile });
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
	const observations: { engine: string; result: Result }[] = [];
	for (const name of cases)
		for (const instrument of [false, true]) {
			const child = spawnSync(process.execPath, ["--input-type=module", "--eval", text["node-bootstrap"] ?? ""], {
				input: JSON.stringify({ bundle: text["node-owner"], name, instrument }),
				encoding: "utf8",
				timeout: 15000,
				maxBuffer: 4 * 1024 * 1024,
			});
			save(`sqlite-${name}-${instrument}.json`, {
				command: [process.execPath, "--input-type=module", "--eval", "retained node-bootstrap.mjs bytes"],
				ownerBundle: "node-owner.mjs via stdin JSON",
				exit: child.status,
				signal: child.signal,
				error: child.error?.message,
				stdout: child.stdout,
				stderr: child.stderr,
			});
			assert.equal(child.error, undefined);
			assert.equal(child.signal, null);
			assert.equal(child.status, 0, child.stderr);
			const result = JSON.parse(child.stdout) as Result;
			assert.equal(result.name, name);
			assert.equal(result.instrument, instrument);
			observations.push({ engine: "sqlite", result });
		}
	console.log(JSON.stringify({ engine: "sqlite", cases: observations.length }));
	const server = createServer((request, response) => {
		response.setHeader("cache-control", "no-store");
		if (request.url === "/owner.js" || request.url === "/entry.js")
			response
				.writeHead(200, { "content-type": "text/javascript" })
				.end(text[request.url === "/owner.js" ? "browser-owner" : "browser-bootstrap"]);
		else
			response
				.writeHead(200, { "content-type": "text/html" })
				.end("<!doctype html><script type=module src=/entry.js></script>");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	try {
		for (const [engine, launcher] of Object.entries({ chromium, firefox, webkit })) {
			const browser = await launcher.launch({ headless: true });
			try {
				for (const name of cases)
					for (const instrument of [false, true]) {
						const context = await browser.newContext();
						try {
							const page = await context.newPage();
							const errors: string[] = [];
							page.on("pageerror", (error) => errors.push(error.message));
							await page.goto(`http://127.0.0.1:${address.port}/?name=${name}&instrument=${instrument}`);
							await page.waitForFunction(
								() => "deterministicResult" in window || "deterministicError" in window,
								undefined,
								{ timeout: 15000 }
							);
							const report = await page.evaluate(() => ({
								result: Reflect.get(window, "deterministicResult") as Result | undefined,
								error: Reflect.get(window, "deterministicError") as string | undefined,
							}));
							save(`${engine}-${name}-${instrument}.json`, { version: browser.version(), ...report, errors });
							assert.deepEqual(errors, []);
							assert.equal(report.error, undefined);
							assert.ok(report.result);
							assert.equal(report.result.name, name);
							assert.equal(report.result.instrument, instrument);
							observations.push({ engine, result: report.result });
						} finally {
							await context.close();
						}
					}
			} finally {
				await browser.close();
			}
			console.log(JSON.stringify({ engine, cases: 4 }));
		}
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
	assert.equal(observations.length, 16);
	for (const engine of ["sqlite", "chromium", "firefox", "webkit"])
		for (const name of cases) {
			const group = observations.filter((item) => item.engine === engine && item.result.name === name);
			assert.equal(group.length, 2);
			assert.deepEqual(
				group[0]?.result.semantics,
				group[1]?.result.semantics,
				"no-hook and observed actual native results agree"
			);
			assert.deepEqual(
				group[0]?.result.direct,
				group[1]?.result.direct,
				"direct protocol causes unchanged by observation"
			);
			assert.deepEqual(group[0]?.result.native, group[1]?.result.native, "native cause chain unchanged by observation");
			assert.deepEqual(
				group[0]?.result.canonicalEvidence,
				group[1]?.result.canonicalEvidence,
				"canonical comparison evidence unchanged by observation"
			);
			assert.ok(group.some((item) => !item.result.instrument && item.result.events.length === 0));
			const controlled = group.find((item) => item.result.instrument)?.result;
			assert.ok(controlled?.positiveControls);
			assert.ok(Object.values(controlled.positiveControls).every((value) => value === true));
		}
	const after = hashes();
	save("after.json", after);
	assert.deepEqual(after, before);
	const failed = observations.filter((item) => item.result.classification !== "PASS");
	const status = failed.length ? 1 : 0;
	const summary = {
		status,
		complete: true,
		graphs,
		cases: 16,
		semanticControlsPassed: 16,
		noHookComparisons: 8,
		normativeFailures: failed.length,
		observations,
	};
	save("summary.json", summary);
	save("completed.json", {
		status,
		cases: 16,
		summarySha256: hash(readFileSync(directory + "/summary.json")),
		unchanged: true,
	});
	console.log(
		JSON.stringify({ status, semanticControlsPassed: 16, noHookComparisons: 8, normativeFailures: failed.length })
	);
	process.exitCode = status;
}
main().catch((error) => {
	save("infrastructure-failure.json", { message: String(error), stack: error instanceof Error ? error.stack : null });
	console.error(error);
	process.exitCode = 2;
});
