import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import type { GraphReport } from "./graph.js";

interface Report {
	boundary: string;
	graph: GraphReport | null;
	controls: Record<string, boolean>;
	results: {
		name: string;
		positive: boolean;
		passes: boolean;
		code: string;
		expectedCode: string;
		causeIncludesSentinel: boolean;
		foreignClass: boolean;
		sharedBrand: boolean;
	}[];
}

/** Execute focused gates while proving frozen105-file and accepted-contract preservation. */
function main(): void {
	const label = process.argv[2];
	assert.ok(label && /^[a-z0-9-]+$/.test(label), "supply a fresh lowercase run label");
	const base = ".logs/bounded-storage-lifecycle/declaration-discovery-provenance-foreign-owner-red-01";
	mkdirSync(base, { recursive: true });
	const evidence = `${base}/${label}`;
	mkdirSync(evidence);
	const fixture = "tests/fixtures/snapshot-declaration-foreign-owner-provenance";
	const manifestPath = ".logs/bounded-storage-lifecycle/declaration-discovery-provenance-red-freeze-01/manifest.json";
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
		entries: { path: string; sha256: string; roles: string[] }[];
	};
	const roles = ["corrective-test", "frozen-original-oracle", "protected-product", "accepted-contract"];
	const entries = manifest.entries.filter((item) => item.roles.some((role) => roles.includes(role)));
	const counts = Object.fromEntries(
		roles.map((role) => [role, entries.filter((item) => item.roles.includes(role)).length])
	);
	assert.equal(counts["corrective-test"], 56);
	assert.equal(counts["frozen-original-oracle"], 29);
	assert.equal(counts["protected-product"], 20);
	const hash = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
	for (const item of entries) assert.equal(hash(item.path), item.sha256, `frozen input changed: ${item.path}`);
	const frozen = new Map(manifest.entries.map((item) => [item.path, item.sha256]));
	const runtimePaths = [
		"package.json",
		"packages/canonical/package.json",
		"packages/protocol-v3/package.json",
		"packages/canonical/dist/src/index.js",
		"packages/protocol-v3/dist/src/snapshot-transfer.js",
		...manifest.entries
			.filter(
				(item) =>
					item.path.startsWith("node_modules/.pnpm/@noble+hashes@1.7.1/node_modules/@noble/hashes/esm/") &&
					item.path.endsWith(".js")
			)
			.map((item) => item.path),
	];
	for (const path of runtimePaths) {
		assert.ok(frozen.has(path), `runtime prehold must have immutable custody: ${path}`);
		assert.equal(hash(path), frozen.get(path), `frozen runtime owner/map/dependency: ${path}`);
	}
	const newMaps = [
		"node_modules/.pnpm/@noble+hashes@1.7.1/node_modules/@noble/hashes/package.json",
		"node_modules/.pnpm/@noble+hashes@1.7.1/node_modules/@noble/hashes/esm/package.json",
	];
	mkdirSync(`${evidence}/export-maps`);
	for (const path of newMaps) {
		assert.equal(frozen.has(path), false, "explicit historical third-party map custody gap");
		writeFileSync(`${evidence}/export-maps/${hash(path)}.json`, readFileSync(path));
	}
	const paths = [
		...new Set([
			...entries.map((item) => item.path),
			...runtimePaths,
			...newMaps,
			manifestPath,
			...["child.ts", "gates.ts", "graph.ts", "tsconfig.json"].map((name) => `${fixture}/${name}`),
		]),
	];
	const before = Object.fromEntries(paths.map((path) => [path, hash(path)]));
	writeFileSync(`${evidence}/before.json`, JSON.stringify({ counts, hashes: before }, null, 2));
	const commands = [
		["strict", "pnpm", ["exec", "tsc", "-p", `${fixture}/tsconfig.json`]],
		["lint", "pnpm", ["exec", "eslint", fixture, "--max-warnings=0"]],
		["format", "pnpm", ["exec", "prettier", "--check", fixture]],
		[
			"protocol-text-decode-observed",
			process.execPath,
			["--import", "tsx", `${fixture}/child.ts`, "protocol-text-decode", "graph"],
		],
		[
			"protocol-text-decode-control",
			process.execPath,
			["--import", "tsx", `${fixture}/child.ts`, "protocol-text-decode", "plain"],
		],
		[
			"protocol-canonical-reencode-observed",
			process.execPath,
			["--import", "tsx", `${fixture}/child.ts`, "protocol-canonical-reencode", "graph"],
		],
		[
			"protocol-canonical-reencode-control",
			process.execPath,
			["--import", "tsx", `${fixture}/child.ts`, "protocol-canonical-reencode", "plain"],
		],
	] as const;
	let severe = false;
	let normativeRed = false;
	const reports: Report[] = [];
	for (const [name, command, args] of commands) {
		const started = new Date().toISOString();
		const child = spawnSync(command, [...args], { encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
		writeFileSync(`${evidence}/${name}.stdout.txt`, child.stdout ?? "");
		writeFileSync(`${evidence}/${name}.stderr.txt`, child.stderr ?? "");
		writeFileSync(
			`${evidence}/${name}.terminal.json`,
			JSON.stringify(
				{
					command: [command, ...args],
					cwd: process.cwd(),
					started,
					finished: new Date().toISOString(),
					status: child.status,
					signal: child.signal,
					error: child.error?.message,
				},
				null,
				2
			)
		);
		console.log(`${name}: ${child.status}`);
		if (child.signal || child.error) severe = true;
		if (!name.startsWith("protocol-")) {
			severe ||= child.status !== 0;
			continue;
		}
		const report = JSON.parse(child.stdout) as Report;
		assert.equal(report.boundary, name.replace(/-(observed|control)$/, ""));
		if (name.endsWith("-observed")) {
			assert.ok(report.graph, "transparent loader must report actual product graph");
			for (const item of report.graph.files) {
				assert.equal(item.sha256, before[item.path], `actual loaded file was held before gates: ${item.path}`);
				assert.equal(item.loadedSourceSha256, item.sha256);
				assert.equal(item.frozenSha256, frozen.get(item.path));
				assert.equal(item.sha256, item.frozenSha256);
			}
			for (const item of report.graph.maps) {
				assert.equal(item.sha256, before[item.path], `actual consulted map was held before gates: ${item.path}`);
				if (item.frozenSha256 === null) assert.ok(newMaps.includes(item.path));
				else assert.equal(item.sha256, frozen.get(item.path));
				assert.equal(createHash("sha256").update(Buffer.from(item.bytesBase64, "base64")).digest("hex"), item.sha256);
			}
			for (const path of ["packages/canonical/package.json", "packages/protocol-v3/package.json", ...newMaps])
				assert.ok(
					report.graph.maps.some((item) => item.path === path),
					`actual product package scope map unobserved: ${path}`
				);
			writeFileSync(`${evidence}/${name}.graph.json`, JSON.stringify(report.graph, null, 2));
		} else assert.equal(report.graph, null, "no-loader comparison process must not install observation hooks");
		assert.equal(Object.keys(report.controls).length, 8);
		assert.deepEqual(
			report.results.map((item) => item.name),
			["foreign-decoding", "foreign-encoding", "shaped-decoding", "shaped-encoding", "owner-decoding", "owner-encoding"]
		);
		const controls =
			Object.values(report.controls).every(Boolean) &&
			report.results.filter((item) => item.positive).length === 2 &&
			report.results.filter((item) => item.positive).every((item) => item.passes);
		const red = report.results.filter((item) => !item.positive).some((item) => !item.passes);
		const status = !controls ? 2 : red ? 1 : 0;
		severe ||= child.status !== status || !controls;
		normativeRed ||= red;
		reports.push(report);
	}
	const after = Object.fromEntries(paths.map((path) => [path, hash(path)]));
	writeFileSync(`${evidence}/after.json`, JSON.stringify({ counts, hashes: after }, null, 2));
	assert.deepEqual(after, before, "all frozen and new inputs unchanged across gates");
	assert.equal(reports.length, 4);
	for (const index of [0, 2]) {
		assert.deepEqual(
			reports[index]?.results,
			reports[index + 1]?.results,
			"loader observation preserves every semantic case"
		);
		assert.deepEqual(
			reports[index]?.controls,
			reports[index + 1]?.controls,
			"loader observation preserves all controls"
		);
	}
	const status = severe ? 2 : normativeRed ? 1 : 0;
	const summary = {
		completed: true,
		label,
		status,
		counts,
		negativeCases: 8,
		positiveCases: 4,
		loaderNoLoaderComparisonsPass: true,
		actualGraphs: reports.filter((item) => item.graph).map((item) => ({ boundary: item.boundary, graph: item.graph })),
		historicalMapCustodyAbsent: newMaps,
		controlsPass: reports.every((item) => Object.values(item.controls).every(Boolean)),
		reports: reports.map((item) => ({ boundary: item.boundary, results: item.results })),
	};
	writeFileSync(`${evidence}/completed-outcome.json`, JSON.stringify(summary, null, 2));
	process.exitCode = status;
}

try {
	main();
} catch (error) {
	console.error(error);
	process.exitCode = 2;
}
