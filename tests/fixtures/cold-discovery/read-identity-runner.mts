import { chromium, firefox, webkit } from "@playwright/test";
import { build } from "esbuild";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";

import { identityModes as modes } from "./read-identity-control.js";
import { nativeReadTransform } from "./read-transform.js";
import type { SetupReport } from "../cold-discovery/types.js";

const base = ".logs/bounded-storage-lifecycle/cold-discovery-red-identity-correction-01";
const run = process.argv[2];
if (!run || !/^[a-z0-9-]+$/.test(run)) throw new Error("NEW_RUN_LABEL_REQUIRED");
const out = join(base, run);
if (existsSync(out)) throw new Error("PROBE_RUN_ALREADY_EXISTS");
mkdirSync(out, { recursive: true });
const hash = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const save = (name: string, value: unknown): void =>
	writeFileSync(join(out, name), JSON.stringify(value, null, 2), { flag: "wx" });
const frozenPath = ".logs/bounded-storage-lifecycle/cold-discovery-red-01/build-06/artifacts.json";
const frozen = JSON.parse(readFileSync(frozenPath, "utf8")) as {
	entries: { name: string; outputPath: string; outputSha256: string; inputs: Record<string, string> }[];
};
const heldPaths = [...new Set(frozen.entries.flatMap((entry) => [entry.outputPath, ...Object.keys(entry.inputs)]))];
const baseline = Object.fromEntries(heldPaths.map((path) => [path, hash(readFileSync(path))]));
const preserve = (): void => {
	for (const [path, digest] of Object.entries(baseline)) assert.equal(hash(readFileSync(path)), digest, path);
	for (const entry of frozen.entries) assert.equal(hash(readFileSync(entry.outputPath)), entry.outputSha256);
};
preserve();
save("custody-before.json", {
	started: new Date().toISOString(),
	command: process.argv,
	proofClass: "DIRECT_RECEIPT_CONTROL_NOT_COLD_PROOF",
	runner: { sha256: hash(readFileSync(import.meta.filename)), bytes: readFileSync(import.meta.filename, "utf8") },
	frozenManifestSha256: hash(readFileSync(frozenPath)),
	baseline,
});
const entries: { name: string; sha256: string; inputs: Record<string, string> }[] = [];
for (const backend of ["node", "browser"] as const)
	for (const observed of [false, true]) {
		const name = `read-identity-${backend}-${observed ? "observed" : "unobserved"}`;
		const observation = observed ? nativeReadTransform(backend, join(out, `${name}-observation`)) : undefined;
		const result = await build({
			entryPoints: [`tests/fixtures/cold-discovery/read-identity-${backend}.ts`],
			bundle: true,
			platform: backend === "node" ? "node" : "browser",
			format: "esm",
			target: "es2022",
			write: false,
			metafile: true,
			plugins: observation ? [observation.plugin] : [],
			...(backend === "node"
				? {
						banner: {
							js: 'import { createRequire } from "node:module"; const require=createRequire(import.meta.url);',
						},
					}
				: {}),
		});
		const file = result.outputFiles[0];
		assert.ok(file);
		writeFileSync(join(out, `${name}.mjs`), file.contents, { flag: "wx" });
		if (observation) save(`${name}-observation.json`, observation.finish());
		save(`${name}-graph.json`, result.metafile);
		entries.push({
			name,
			sha256: hash(file.contents),
			inputs: Object.fromEntries(Object.keys(result.metafile.inputs).map((path) => [path, hash(readFileSync(path))])),
		});
	}
save("probe-build.json", { created: new Date().toISOString(), entries });
const check = (): void => {
	preserve();
	for (const entry of entries) {
		assert.equal(hash(readFileSync(join(out, `${entry.name}.mjs`))), entry.sha256);
		for (const [path, digest] of Object.entries(entry.inputs)) assert.equal(hash(readFileSync(path)), digest);
	}
};
const reports: unknown[] = [];
function child(name: string, file: string, args: string[], dir: string): unknown {
	const started = new Date().toISOString();
	const result = spawnSync(process.execPath, [file, ...args], {
		encoding: "utf8",
		timeout: 20000,
		maxBuffer: 16 * 1024 * 1024,
	});
	writeFileSync(join(dir, `${name}.stdout`), result.stdout ?? "", { flag: "wx" });
	writeFileSync(join(dir, `${name}.stderr`), result.stderr ?? "", { flag: "wx" });
	writeFileSync(
		join(dir, `${name}.receipt.json`),
		JSON.stringify({
			started,
			finished: new Date().toISOString(),
			command: [process.execPath, file, ...args],
			pid: result.pid,
			status: result.status,
			signal: result.signal,
			error: result.error?.message,
			stdoutSha256: hash(result.stdout ?? ""),
			stderrSha256: hash(result.stderr ?? ""),
		}),
		{ flag: "wx" }
	);
	assert.equal(result.status, 0, `${name}:${result.stderr}`);
	const lastLine = result.stdout.trim().split("\n").at(-1);
	assert.ok(lastLine);
	return JSON.parse(lastLine);
}
const nodeSetup = frozen.entries.find((e) => e.name === "node-setup");
const browserSetup = frozen.entries.find((e) => e.name === "browser-setup");
assert.ok(nodeSetup);
assert.ok(browserSetup);
for (const epoch of [1, 2] as const)
	for (const mode of modes) {
		check();
		const dir = resolve(out, `node-${epoch}-${mode}`);
		mkdirSync(dir);
		const setupResult = child("setup", nodeSetup.outputPath, [dir, String(epoch)], dir) as {
			kind: string;
			report: SetupReport;
		};
		assert.equal(setupResult.kind, "SETUP_COMPLETE");
		const path = join(dir, "diagnostic-setup-report.json");
		writeFileSync(path, JSON.stringify(setupResult.report), { flag: "wx" });
		const result = child(
			"probe",
			join(out, `read-identity-node-${mode.endsWith("-observed") ? "observed" : "unobserved"}.mjs`),
			[path, mode],
			dir
		) as { report: unknown };
		reports.push({ engine: "node", epoch, mode, report: result.report });
		console.log(JSON.stringify({ engine: "node", epoch, mode, report: result.report }));
	}
const setupBytes = readFileSync(browserSetup.outputPath);
const probeBytes = Object.fromEntries(
	["observed", "unobserved"].map((mode) => [mode, readFileSync(join(out, `read-identity-browser-${mode}.mjs`))])
);
const server = createServer((req, res) => {
	if (req.url === "/setup.mjs") res.writeHead(200, { "content-type": "text/javascript" }).end(setupBytes);
	else if (req.url === "/observed.mjs" || req.url === "/unobserved.mjs")
		res.writeHead(200, { "content-type": "text/javascript" }).end(probeBytes[req.url.slice(1, -4)]);
	else
		res
			.writeHead(200, { "content-type": "text/html" })
			.end(
				`<!doctype html><script type="module" src="/${req.url === "/setup" ? "setup" : req.url === "/observed" ? "observed" : "unobserved"}.mjs"></script>`
			);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("SERVER_ADDRESS");
const origin = `http://127.0.0.1:${address.port}`;
try {
	const browserResults = await Promise.allSettled(
		(
			[
				["chromium", chromium],
				["firefox", firefox],
				["webkit", webkit],
			] as const
		).map(async ([engine, browserType]) => {
			const browserServer = await browserType.launchServer({ headless: true, timeout: 20000 });
			const bounded = async <T,>(label: string, work: () => Promise<T>): Promise<T> => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					return await Promise.race([
						work(),
						new Promise<never>((_resolve, reject) => {
							timer = setTimeout(() => {
								save(`timeout-${engine}-${randomUUID()}.json`, {
									engine,
									phase: label,
									deadlineMs: 20000,
									at: new Date().toISOString(),
									ownedBrowserPid: browserServer.process().pid,
								});
								browserServer.process().kill("SIGKILL");
								reject(new Error(`CONTROL_BROWSER_TIMEOUT:${engine}:${label}`));
							}, 20000);
						}),
					]);
				} finally {
					if (timer !== undefined) clearTimeout(timer);
				}
			};
			try {
				const browser = await bounded("connect", () => browserType.connect(browserServer.wsEndpoint()));
				for (const epoch of [1, 2] as const)
					for (const mode of modes) {
						check();
						const context = await bounded("new-context", () => browser.newContext());
						const identity = `direct-${engine}-${epoch}-${mode}-${randomUUID()}`;
						const dir = join(out, `${engine}-${epoch}-${mode}`);
						mkdirSync(dir);
						try {
							const page = await bounded("setup-new-page", () => context.newPage());
							await bounded("setup-navigation", () => page.goto(`${origin}/setup`));
							await bounded("setup-ready", () =>
								page.waitForFunction(() => typeof Reflect.get(globalThis, "coldSetup") === "function")
							);
							const setup = (await bounded(`setup:${epoch}:${mode}`, () =>
								page.evaluate(({ identity, epoch }) => Reflect.get(globalThis, "coldSetup")(identity, epoch), {
									identity,
									epoch,
								})
							)) as SetupReport;
							assert.equal(setup.bootstrap.expectedRoomHead.epoch, epoch);
							await bounded("setup-page-close", () => page.close());
							const next = await bounded("probe-new-page", () => context.newPage());
							await bounded("probe-navigation", () =>
								next.goto(`${origin}/${mode.endsWith("-observed") ? "observed" : "unobserved"}`)
							);
							await bounded("probe-ready", () =>
								next.waitForFunction(() => typeof Reflect.get(globalThis, "directIdentityControl") === "function")
							);
							const report = await bounded(`probe:${epoch}:${mode}`, () =>
								next.evaluate(({ setup, mode }) => Reflect.get(globalThis, "directIdentityControl")(setup, mode), {
									setup,
									mode,
								})
							);
							const result = { engine, epoch, mode, setupPageClosed: page.isClosed(), report };
							writeFileSync(join(dir, "report.json"), JSON.stringify(result, null, 2), { flag: "wx" });
							reports.push(result);
							console.log(JSON.stringify(result));
							await bounded(`delete-databases:${epoch}:${mode}`, () =>
								next.evaluate(async (identity) => {
									for (const row of await indexedDB.databases()) {
										const name = row.name;
										if (!name?.startsWith(identity)) continue;
										await new Promise<void>((resolve, reject) => {
											const request = indexedDB.deleteDatabase(name);
											request.onsuccess = (): void => resolve();
											request.onerror = (): void => reject(request.error);
											request.onblocked = (): void => reject(new Error("PROBE_CLEANUP_BLOCKED"));
										});
									}
								}, identity)
							);
						} finally {
							await bounded("context-close", () => context.close());
						}
					}
			} finally {
				await bounded("browser-server-close", () => browserServer.close());
			}
		})
	);
	const failures = browserResults.filter((result) => result.status === "rejected");
	if (failures.length > 0) {
		save(
			"browser-failures.json",
			failures.map((result) => String(result.reason))
		);
		throw new AggregateError(
			failures.map((result) => result.reason),
			"CONTROL_BROWSER_FAILURE"
		);
	}
} finally {
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
check();
save("reports.json", reports);
save("custody-after.json", {
	finished: new Date().toISOString(),
	reportCount: reports.length,
	unchangedHeldInputsDuringControls: true,
	unchangedOriginalBuild06Bundles: true,
	heldOriginalBuildInputsUnchangedDuringRun: true,
	probeBuildSha256: hash(readFileSync(join(out, "probe-build.json"))),
	reportsSha256: hash(readFileSync(join(out, "reports.json"))),
});
