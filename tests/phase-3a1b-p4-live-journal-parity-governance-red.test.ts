import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	BROWSER_DEATH_TUPLES,
	BROWSER_SCHEMA,
	NO_WRITE_DEATH_TUPLES,
	NODE_DEATH_TUPLES,
	NODE_SCHEMA,
} from "./fixtures/phase-3a1b-p4/live-journal-contract.js";
import {
	P4_BROWSER_DEATH_TUPLES,
	P4_BROWSER_NO_WRITE_DEATH_TUPLES,
	P4_BROWSER_SCHEMA,
} from "../packages/storage-browser/tests/fixtures/phase-3a1b-p4-browser-contract.js";
import {
	P4_NODE_DEATH_TUPLES,
	P4_NODE_NO_WRITE_DEATH_TUPLES,
	P4_NODE_SCHEMA,
} from "../packages/storage-node/tests/fixtures/phase-3a1b-p4-node-contract.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const temporaryDirectories: string[] = [];
const EXACT_EXPORT = Object.freeze({
	import: "./dist/src/live-journal.js",
	types: "./dist/src/live-journal.d.ts",
});

interface AdapterManifest {
	readonly dependencies?: Readonly<Record<string, string>>;
	readonly exports?: Readonly<Record<string, unknown>>;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
});

function json(relativePath: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8")) as Record<string, unknown>;
}

function sha256(relativePath: string): string {
	return createHash("sha256")
		.update(fs.readFileSync(path.join(ROOT, relativePath)))
		.digest("hex");
}

function adapterViolations(manifest: AdapterManifest, expectedDependencies: readonly string[]): readonly string[] {
	const violations: string[] = [];
	const exportsMap = manifest.exports ?? {};
	const dependencies = manifest.dependencies ?? {};
	const root = exportsMap["."] as Readonly<Record<string, unknown>> | undefined;
	const issuance = exportsMap["./issuance"] as Readonly<Record<string, unknown>> | undefined;
	const journal = exportsMap["./live-journal"] as Readonly<Record<string, unknown>> | undefined;
	if (
		root?.import !== "./dist/src/index.js" ||
		root.types !== "./dist/src/index.d.ts" ||
		Object.keys(root).length !== 2
	) {
		violations.push("root-export");
	}
	if (
		issuance?.import !== "./dist/src/issuance.js" ||
		issuance.types !== "./dist/src/issuance.d.ts" ||
		Object.keys(issuance).length !== 2
	) {
		violations.push("issuance-export");
	}
	if (
		journal?.import !== EXACT_EXPORT.import ||
		journal.types !== EXACT_EXPORT.types ||
		Object.keys(journal ?? {}).length !== 2
	) {
		violations.push("journal-export");
	}
	if (JSON.stringify(Object.keys(exportsMap).sort()) !== JSON.stringify([".", "./issuance", "./live-journal"])) {
		violations.push("export-inventory");
	}
	if (dependencies["@ts-drp/live-journal"] !== "0.11.0") violations.push("journal-version");
	if (JSON.stringify(Object.keys(dependencies).sort()) !== JSON.stringify([...expectedDependencies].sort())) {
		violations.push("dependency-inventory");
	}
	return violations;
}

function sourceFiles(directory: string): readonly string[] {
	return fs
		.readdirSync(directory, { withFileTypes: true })
		.flatMap((entry) =>
			entry.isDirectory()
				? sourceFiles(path.join(directory, entry.name))
				: entry.isFile() && /\.(?:js|mjs|ts)$/u.test(entry.name)
					? [path.join(directory, entry.name)]
					: []
		);
}

describe("D.93.34 p4-d parity and governance RED", () => {
	it("binds both adapter schemas and complete death registries to the shared contract owner", () => {
		expect(P4_NODE_SCHEMA).toEqual(NODE_SCHEMA);
		expect(P4_BROWSER_SCHEMA).toEqual(BROWSER_SCHEMA);
		expect(P4_NODE_DEATH_TUPLES).toEqual(NODE_DEATH_TUPLES);
		expect(P4_BROWSER_DEATH_TUPLES).toEqual(BROWSER_DEATH_TUPLES);
		expect(P4_NODE_NO_WRITE_DEATH_TUPLES).toEqual(NO_WRITE_DEATH_TUPLES);
		expect(P4_BROWSER_NO_WRITE_DEATH_TUPLES).toEqual(NO_WRITE_DEATH_TUPLES);
	});

	it("transitions only the two adapter manifests to exact additive exports and dependencies", () => {
		const node = json("packages/storage-node/package.json") as AdapterManifest;
		const browser = json("packages/storage-browser/package.json") as AdapterManifest;
		expect(adapterViolations(node, ["@ts-drp/issuance-store", "@ts-drp/live-journal", "@ts-drp/storage"])).toEqual([]);
		expect(
			adapterViolations(browser, [
				"@ts-drp/canonical",
				"@ts-drp/issuance-store",
				"@ts-drp/live-journal",
				"@ts-drp/storage",
			])
		).toEqual([]);
	});

	it("kills missing, extra, retargeted, deep and wrong-version additive transition mutants", () => {
		const baseline: AdapterManifest = {
			dependencies: {
				"@ts-drp/issuance-store": "0.11.0",
				"@ts-drp/live-journal": "0.11.0",
				"@ts-drp/storage": "0.11.0",
			},
			exports: {
				".": { import: "./dist/src/index.js", types: "./dist/src/index.d.ts" },
				"./issuance": { import: "./dist/src/issuance.js", types: "./dist/src/issuance.d.ts" },
				"./live-journal": EXACT_EXPORT,
			},
		};
		const expected = ["@ts-drp/issuance-store", "@ts-drp/live-journal", "@ts-drp/storage"];
		expect(adapterViolations(baseline, expected)).toEqual([]);
		const mutants: readonly AdapterManifest[] = [
			{ ...baseline, exports: { ...baseline.exports, "./live-journal": undefined } },
			{ ...baseline, exports: { ...baseline.exports, "./private/live-journal": EXACT_EXPORT } },
			{
				...baseline,
				exports: { ...baseline.exports, "./live-journal": { ...EXACT_EXPORT, import: "./src/live-journal.ts" } },
			},
			{ ...baseline, exports: { ...baseline.exports, "./issuance": EXACT_EXPORT } },
			{ ...baseline, dependencies: { ...baseline.dependencies, "@ts-drp/live-journal": "workspace:*" } },
			{ ...baseline, dependencies: { ...baseline.dependencies, "@ts-drp/protocol-v3": "0.11.0" } },
		];
		expect(mutants.map((mutant) => adapterViolations(mutant, expected).length > 0)).toEqual(Array(6).fill(true));
	});

	it("keeps every old root byte and public runtime root unchanged while adding no node-facing journal seam", async () => {
		expect(sha256("packages/storage-node/src/index.ts")).toBe(
			"14688ec0442cf331f329a5cb944bfa893f6a6ef08eeedd8bb6352651283d7211"
		);
		expect(sha256("packages/storage-browser/src/index.ts")).toBe(
			"30d32c3b4e9f9b4a7036602fe2338315167112bec41ca83a753b4feaba3bf56c"
		);
		const nodeRoot = await import("@ts-drp/storage-node");
		const browserRoot = await import("@ts-drp/storage-browser");
		expect(nodeRoot).not.toHaveProperty("createNodeDurableLiveJournalStore");
		expect(browserRoot).not.toHaveProperty("createBrowserDurableLiveJournalStore");
		const nodePackage = await import("@ts-drp/node");
		expect(nodePackage).not.toHaveProperty("DurableLiveJournalStore");
		expect(nodePackage).not.toHaveProperty("LiveJournalSnapshotToken");
	});

	it("keeps local journal domains out of both protocol registries and freezes registry bytes", () => {
		const v2 = json("packages/protocol-v2/registry/field-registry.json");
		const v3 = json("packages/protocol-v3/registry/registry-v1.json");
		const serialized = `${JSON.stringify(v2)}${JSON.stringify(v3)}`;
		for (const domain of [
			"ts-drp/live-journal-row/v1",
			"ts-drp/live-journal-order/v1",
			"ts-drp/live-journal-snapshot/v1",
		]) {
			expect(serialized).not.toContain(domain);
		}
		expect(sha256("packages/protocol-v3/registry/registry-v1.json")).toBe(
			"2fd6f51286e06f2c3c634c244a0242a55da186258664ec54a371f19b814a11d9"
		);
	});

	it("ships source, declarations and runtime only through the three exact package subpaths", () => {
		for (const packageName of ["storage-node", "storage-browser"] as const) {
			const directory = path.join(ROOT, `packages/${packageName}`);
			expect(fs.existsSync(path.join(directory, "src/live-journal.ts"))).toBe(true);
			expect(fs.existsSync(path.join(directory, "dist/src/live-journal.js"))).toBe(true);
			expect(fs.existsSync(path.join(directory, "dist/src/live-journal.d.ts"))).toBe(true);
			const destination = fs.mkdtempSync(path.join(os.tmpdir(), `phase-3a1b-p4-pack-${packageName}-`));
			temporaryDirectories.push(destination);
			const packed = JSON.parse(
				execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", destination], {
					cwd: directory,
					encoding: "utf8",
				})
			) as readonly [{ readonly files: readonly { readonly path: string }[] }];
			const files = packed[0].files.map(({ path: file }) => file);
			expect(files).toEqual(expect.arrayContaining(["dist/src/live-journal.d.ts", "dist/src/live-journal.js"]));
			expect(files.some((file) => /(?:tests|fixtures|test-control)/u.test(file))).toBe(false);
		}
	});

	it("forbids retained live indexes, consumer replay, outbox and activation authority in every p4 production owner", () => {
		const roots = [
			path.join(ROOT, "packages/live-journal/src"),
			path.join(ROOT, "packages/storage-node/src/live-journal.ts"),
			path.join(ROOT, "packages/storage-browser/src/live-journal.ts"),
		].filter((candidate) => fs.existsSync(candidate));
		expect(roots).toHaveLength(3);
		const files = roots.flatMap((candidate) =>
			fs.statSync(candidate).isDirectory() ? sourceFiles(candidate) : [candidate]
		);
		const production = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
		expect(production).not.toMatch(
			/\b(?:CausalityIndex|extractAdmittedReceivedVertex|readIssued|readOutboxPage|compareAndMarkOutboxPublished|activatePreparedV3Live|consumePreparedV3Live|subscribe|reducer|fold|discard|repair)\b/u
		);
		expect(production).not.toMatch(/@ts-drp\/(?:control-plane|issuance-store|node|network)\b/u);
	});

	it("keeps fast and nightly browser ownership explicit with no skip or single-engine downgrade", () => {
		for (const config of [
			"packages/storage-browser/playwright.phase-3a1b-p4-live-journal.config.ts",
			"packages/storage-browser/playwright.phase-3a1b-p4-live-journal-death.config.ts",
		]) {
			const source = fs.readFileSync(path.join(ROOT, config), "utf8");
			expect(source).toContain('{ name: "chromium"');
			expect(source).toContain('{ name: "firefox"');
			expect(source).toContain('{ name: "webkit"');
			expect(source).not.toMatch(/\.skip|process\.env.*\?/u);
		}
	});
});
