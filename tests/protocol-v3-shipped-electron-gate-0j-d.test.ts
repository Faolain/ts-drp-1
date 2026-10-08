import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import currentManifest from "./fixtures/phase-0j-d-v3/current-inactive-shipping-targets.json" with { type: "json" };
import contract from "./fixtures/phase-0j-d-v3/shipping-target-discovery-contract.json" with { type: "json" };
import syntheticShippedManifest from "./fixtures/phase-0j-d-v3/synthetic-shipped-electron-target.json" with { type: "json" };

interface DiscoveryReceipt {
	readonly conformanceBinding: {
		readonly contractRelativePath: string;
		readonly receiptSchemaVersion: number;
		readonly requiredEngines: readonly string[];
		readonly runnerRelativePath: string;
		readonly supportedTiers: readonly string[];
		readonly tier: string;
	};
	readonly discovery: {
		readonly authoritativeManifestPaths: readonly string[];
		readonly dependencyInspection: false;
		readonly manifests: readonly {
			readonly exactBytesSha256: string;
			readonly path: string;
		}[];
		readonly source: "shipping-target-manifest-only";
	};
	readonly executions?: readonly {
		readonly conformanceBinding: DiscoveryReceipt["conformanceBinding"];
		readonly result: "passed";
		readonly runner: string;
		readonly runtime: "electron";
		readonly targetId: string;
		readonly version: string;
	}[];
	readonly result: "not-shipped" | "passed";
	readonly schemaVersion: number;
	readonly targets: readonly {
		readonly id: string;
		readonly runtime: string;
		readonly state: string;
		readonly versions: readonly unknown[];
	}[];
}

type JsonRecord = Record<string, unknown>;
type Tier = "nightly" | "pr";

const CURRENT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(CURRENT_DIRECTORY, "..");
const FIXTURE_DIRECTORY = resolve(CURRENT_DIRECTORY, "fixtures/phase-0j-d-v3");
const RUNNER_PATH = resolve(REPOSITORY_ROOT, contract.runnerRelativePath);
const AUTHORITATIVE_MANIFEST_PATH = contract.authoritativeManifestPaths[0];
const EXACT_CONFORMANCE_CONTRACT_PATH = resolve(REPOSITORY_ROOT, contract.conformanceBinding.contractRelativePath);
const EXACT_CONFORMANCE_RUNNER_PATH = resolve(REPOSITORY_ROOT, contract.conformanceBinding.runnerRelativePath);
const SUPPORTED_TIERS = contract.conformanceBinding.supportedTiers as readonly Tier[];

function exactBytesSha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function exactKeys(value: JsonRecord, expected: readonly string[]): void {
	expect(Object.keys(value).sort()).toEqual([...expected].sort());
}

function requireRunner(): void {
	expect(
		existsSync(RUNNER_PATH),
		`${contract.runnerRelativePath} must exist; a missing discovery runner is the intended Phase 0j-d RED`
	).toBe(true);
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function invokeDiscovery(repositoryRoot: string, tier: Tier = "pr") {
	requireRunner();
	return spawnSync(process.execPath, [RUNNER_PATH, "--repository-root", repositoryRoot, "--tier", tier], {
		cwd: REPOSITORY_ROOT,
		encoding: "utf8",
		env: { ...process.env, CI: "1" },
		timeout: 45_000,
	});
}

function runDiscovery(repositoryRoot = REPOSITORY_ROOT, tier: Tier = "pr"): DiscoveryReceipt {
	const invocation = invokeDiscovery(repositoryRoot, tier);
	if (invocation.error !== undefined) throw invocation.error;
	expect(invocation.status, `${invocation.stderr}\n${invocation.stdout}`).toBe(0);
	return JSON.parse(invocation.stdout) as DiscoveryReceipt;
}

function expectDiscoveryFailure(repositoryRoot: string, expected: RegExp): void {
	const invocation = invokeDiscovery(repositoryRoot);
	if (invocation.error !== undefined) throw invocation.error;
	const output = `${invocation.stderr}\n${invocation.stdout}`;
	expect(invocation.status, output).not.toBe(0);
	expect(output).toMatch(expected);
	expect(output).not.toMatch(/"result"\s*:\s*"not-shipped"/u);
	expect(output).not.toMatch(/"result"\s*:\s*"passed"/u);
}

function temporaryRepository(prefix: string): string {
	const root = mkdtempSync(resolve(tmpdir(), prefix));
	mkdirSync(dirname(resolve(root, contract.conformanceBinding.runnerRelativePath)), { recursive: true });
	mkdirSync(dirname(resolve(root, contract.conformanceBinding.contractRelativePath)), { recursive: true });
	cpSync(EXACT_CONFORMANCE_RUNNER_PATH, resolve(root, contract.conformanceBinding.runnerRelativePath));
	cpSync(EXACT_CONFORMANCE_CONTRACT_PATH, resolve(root, contract.conformanceBinding.contractRelativePath));
	return root;
}

function writeManifest(repositoryRoot: string, value: unknown): void {
	writeFileSync(
		resolve(repositoryRoot, AUTHORITATIVE_MANIFEST_PATH),
		`${JSON.stringify(value, undefined, "\t")}\n`,
		"utf8"
	);
}

function activeManifest(
	mutate?: (target: {
		id: string;
		runtime: string;
		state: string;
		versions: { runner?: string; version?: string }[];
	}) => void
): typeof syntheticShippedManifest {
	const value = structuredClone(syntheticShippedManifest);
	mutate?.(value.shippingTargets[0]);
	return value;
}

function rawRunnerSource(rawReceipt: string, tier: Tier = "pr", afterReceipt: readonly string[] = []): string {
	const expectedContract = JSON.stringify(contract.conformanceBinding.contractRelativePath);
	const expectedTier = JSON.stringify(tier);
	return [
		'import { resolve } from "node:path";',
		"const args = process.argv.slice(2);",
		"const value = (name) => args[args.indexOf(name) + 1];",
		`if (value("--contract") === undefined || !resolve(value("--contract")).endsWith(${expectedContract}))`,
		'  throw new Error("same-matrix contract binding mismatch");',
		`if (value("--tier") !== ${expectedTier}) throw new Error("same-matrix tier binding mismatch");`,
		'if (value("--expected-version") !== "42.0.0") throw new Error("exact version binding mismatch");',
		`process.stdout.write(${JSON.stringify(`${rawReceipt}\n`)});`,
		...afterReceipt,
	].join("\n");
}

function runnerSource(
	result: { readonly result?: string; readonly version?: string },
	tier: Tier = "pr",
	afterReceipt: readonly string[] = []
): string {
	return rawRunnerSource(
		JSON.stringify({
			conformanceBinding: { ...contract.conformanceBinding, tier },
			receiptSchemaVersion: 1,
			runtime: "electron",
			targetId: "electron-desktop",
			...result,
		}),
		tier,
		afterReceipt
	);
}

describe("Phase 0j-d non-vacuous shipped-Electron discovery RED", () => {
	it("authenticates one exact non-empty manifest path and the explicit current inactive state", () => {
		expect(contract.schemaVersion).toBe(1);
		expect(contract.authoritativeManifestPaths).toEqual(["shipping-targets.json"]);
		expect(new Set(contract.authoritativeManifestPaths).size).toBe(contract.authoritativeManifestPaths.length);
		for (const path of contract.authoritativeManifestPaths) {
			expect(path).not.toBe("");
			expect(path).not.toMatch(/[*?[\\\]]/u);
			expect(resolve(REPOSITORY_ROOT, path).startsWith(`${REPOSITORY_ROOT}/`)).toBe(true);
		}

		const absoluteManifestPath = resolve(REPOSITORY_ROOT, AUTHORITATIVE_MANIFEST_PATH);
		expect(
			existsSync(absoluteManifestPath),
			`${AUTHORITATIVE_MANIFEST_PATH} must explicitly declare the current inactive Electron shipping state`
		).toBe(true);
		const actualManifest = JSON.parse(readFileSync(absoluteManifestPath, "utf8")) as JsonRecord;
		expect(actualManifest).toEqual(currentManifest);
		exactKeys(actualManifest, ["schemaVersion", "shippingTargets"]);
		const target = (actualManifest.shippingTargets as JsonRecord[])[0];
		exactKeys(target, ["id", "runtime", "state", "versions"]);
		expect(target).toEqual({
			id: "electron-desktop",
			runtime: "electron",
			state: "inactive",
			versions: [],
		});

		for (const tier of SUPPORTED_TIERS) {
			const receipt = runDiscovery(REPOSITORY_ROOT, tier);
			expect(receipt).toMatchObject({
				schemaVersion: 1,
				result: "not-shipped",
				discovery: {
					source: "shipping-target-manifest-only",
					dependencyInspection: false,
					authoritativeManifestPaths: contract.authoritativeManifestPaths,
				},
				conformanceBinding: { ...contract.conformanceBinding, tier },
				targets: currentManifest.shippingTargets,
			});
			expect(receipt.discovery.manifests).toEqual([
				{
					path: AUTHORITATIVE_MANIFEST_PATH,
					exactBytesSha256: exactBytesSha256(absoluteManifestPath),
				},
			]);
		}
	});

	it("does not activate Electron for dependency presence or lookalike manifests", () => {
		const root = temporaryRepository("ts-drp-phase-0j-d-dependency-");
		try {
			writeManifest(root, currentManifest);
			writeFileSync(
				resolve(root, "package.json"),
				`${JSON.stringify({
					dependencies: {
						"electron": "42.0.0",
						"electron-to-chromium": "1.5.0",
						"is-electron": "2.2.2",
					},
				})}\n`,
				"utf8"
			);
			const transitiveRoot = resolve(root, "node_modules/transitive-package");
			mkdirSync(transitiveRoot, { recursive: true });
			writeFileSync(
				resolve(transitiveRoot, "package.json"),
				`${JSON.stringify({
					dependencies: {
						"electron": "41.0.0",
						"electron-to-chromium": "1.5.0",
						"is-electron": "2.2.2",
					},
				})}\n`,
				"utf8"
			);
			writeFileSync(
				resolve(root, "shipping-targets.active.json"),
				`${JSON.stringify(syntheticShippedManifest)}\n`,
				"utf8"
			);
			const lookalikeDirectory = resolve(root, "apps/electron");
			mkdirSync(lookalikeDirectory, { recursive: true });
			writeFileSync(
				resolve(lookalikeDirectory, "shipping-targets.json"),
				`${JSON.stringify(syntheticShippedManifest)}\n`,
				"utf8"
			);

			const receipt = runDiscovery(root);
			expect(receipt.result).toBe("not-shipped");
			expect(receipt.discovery).toMatchObject({
				authoritativeManifestPaths: contract.authoritativeManifestPaths,
				dependencyInspection: false,
				source: "shipping-target-manifest-only",
			});
			expect(receipt.targets).toEqual(currentManifest.shippingTargets);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	it("fails closed on manifest read, parse, path escape and glob errors", () => {
		const roots: string[] = [];
		try {
			const missing = temporaryRepository("ts-drp-phase-0j-d-missing-");
			roots.push(missing);
			expectDiscoveryFailure(missing, /shipping-targets\.json.*(read|missing|ENOENT|not found)/iu);

			const malformed = temporaryRepository("ts-drp-phase-0j-d-malformed-");
			roots.push(malformed);
			writeFileSync(resolve(malformed, AUTHORITATIVE_MANIFEST_PATH), "{not-json\n", "utf8");
			expectDiscoveryFailure(malformed, /shipping-targets\.json.*(parse|JSON|syntax)/iu);

			for (const [name, runner] of [
				["absolute", "/tmp/electron-conformance.mjs"],
				["escape", "../electron-conformance.mjs"],
				["glob", "shipping/electron-*.mjs"],
			] as const) {
				const root = temporaryRepository(`ts-drp-phase-0j-d-${name}-`);
				roots.push(root);
				writeManifest(
					root,
					activeManifest((target) => {
						target.versions[0].runner = runner;
					})
				);
				expectDiscoveryFailure(root, new RegExp(`${name}|runner|path|glob|escape|relative`, "iu"));
			}
		} finally {
			for (const root of roots) rmSync(root, { force: true, recursive: true });
		}
	});

	it("fails closed on duplicate keys in authoritative manifest bytes", () => {
		const root = temporaryRepository("ts-drp-phase-0j-d-duplicate-manifest-");
		try {
			writeFileSync(
				resolve(root, AUTHORITATIVE_MANIFEST_PATH),
				[
					'{"schemaVersion":1,"shippingTargets":[{',
					'"id":"electron-desktop","runtime":"electron",',
					'"state":"shipped","state":"inactive","versions":[]',
					"}]}\n",
				].join(""),
				"utf8"
			);
			expectDiscoveryFailure(root, /duplicate.*state|state.*duplicate/iu);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	it("fails closed on duplicate keys in a shipped child machine receipt", () => {
		const root = temporaryRepository("ts-drp-phase-0j-d-duplicate-receipt-");
		try {
			writeManifest(root, activeManifest());
			const runnerPath = resolve(root, syntheticShippedManifest.shippingTargets[0].versions[0].runner);
			mkdirSync(dirname(runnerPath), { recursive: true });
			const rawReceipt = [
				`{"conformanceBinding":${JSON.stringify({ ...contract.conformanceBinding, tier: "pr" })},`,
				'"receiptSchemaVersion":1,"result":"failed","result":"passed",',
				'"runtime":"electron","targetId":"electron-desktop","version":"42.0.0"}',
			].join("");
			writeFileSync(runnerPath, rawRunnerSource(rawReceipt), "utf8");
			expectDiscoveryFailure(root, /duplicate.*result|result.*duplicate/iu);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	it("activates a synthetic shipped target and rejects absent or wrong exact version, runner and result", () => {
		const roots: string[] = [];
		try {
			const missingVersion = temporaryRepository("ts-drp-phase-0j-d-version-");
			roots.push(missingVersion);
			writeManifest(
				missingVersion,
				activeManifest((target) => {
					delete target.versions[0].version;
				})
			);
			expectDiscoveryFailure(missingVersion, /version.*(missing|required|exact|invalid)/iu);

			const missingRunner = temporaryRepository("ts-drp-phase-0j-d-runner-");
			roots.push(missingRunner);
			writeManifest(missingRunner, activeManifest());
			expectDiscoveryFailure(missingRunner, /runner.*(missing|read|ENOENT|not found|unavailable)/iu);

			const emptyVersions = temporaryRepository("ts-drp-phase-0j-d-empty-versions-");
			roots.push(emptyVersions);
			writeManifest(
				emptyVersions,
				activeManifest((target) => {
					target.versions = [];
				})
			);
			expectDiscoveryFailure(emptyVersions, /shipped.*version|version.*(empty|required|missing)/iu);

			const invalidState = temporaryRepository("ts-drp-phase-0j-d-invalid-state-");
			roots.push(invalidState);
			writeManifest(
				invalidState,
				activeManifest((target) => {
					target.state = "unknown";
				})
			);
			expectDiscoveryFailure(invalidState, /state.*(invalid|inactive|shipped|unknown)/iu);

			for (const [name, result, expected] of [
				["wrong-version", { result: "passed", version: "41.0.0" }, /version.*(mismatch|wrong|42\.0\.0)/iu],
				["missing-result", { version: "42.0.0" }, /result.*(missing|required|invalid)/iu],
				["wrong-result", { result: "skipped", version: "42.0.0" }, /result.*(passed|wrong|invalid)/iu],
			] as const) {
				const root = temporaryRepository(`ts-drp-phase-0j-d-${name}-`);
				roots.push(root);
				writeManifest(root, activeManifest());
				const runnerPath = resolve(root, syntheticShippedManifest.shippingTargets[0].versions[0].runner);
				mkdirSync(dirname(runnerPath), { recursive: true });
				writeFileSync(runnerPath, runnerSource(result), "utf8");
				expectDiscoveryFailure(root, expected);
			}
		} finally {
			for (const root of roots) rmSync(root, { force: true, recursive: true });
		}
	});

	it("accepts one exact synthetic shipped execution and cannot downgrade it to not-shipped", () => {
		for (const tier of SUPPORTED_TIERS) {
			const root = temporaryRepository(`ts-drp-phase-0j-d-passed-${tier}-`);
			try {
				writeManifest(root, activeManifest());
				const runnerRelativePath = syntheticShippedManifest.shippingTargets[0].versions[0].runner;
				const runnerPath = resolve(root, runnerRelativePath);
				mkdirSync(dirname(runnerPath), { recursive: true });
				writeFileSync(runnerPath, runnerSource({ result: "passed", version: "42.0.0" }, tier), "utf8");

				const receipt = runDiscovery(root, tier);
				expect(receipt.result).toBe("passed");
				expect(receipt.result).not.toBe("not-shipped");
				const expectedBinding = { ...contract.conformanceBinding, tier };
				expect(receipt.conformanceBinding).toEqual(expectedBinding);
				expect(receipt.executions).toEqual([
					{
						conformanceBinding: expectedBinding,
						result: "passed",
						runner: runnerRelativePath,
						runtime: "electron",
						targetId: "electron-desktop",
						version: "42.0.0",
					},
				]);
			} finally {
				rmSync(root, { force: true, recursive: true });
			}
		}
	});

	it("fails closed when a passed child exits nonzero or writes any stderr", () => {
		for (const [name, afterReceipt, expected] of [
			["nonzero-exit", ["process.exitCode = 1;"], /runner exited unsuccessfully/iu],
			[
				"stderr",
				['process.stderr.write("unexpected child diagnostics\\n");'],
				/runner wrote non-receipt diagnostics/iu,
			],
		] as const) {
			const root = temporaryRepository(`ts-drp-phase-0j-d-${name}-`);
			try {
				writeManifest(root, activeManifest());
				const runnerPath = resolve(root, syntheticShippedManifest.shippingTargets[0].versions[0].runner);
				mkdirSync(dirname(runnerPath), { recursive: true });
				writeFileSync(runnerPath, runnerSource({ result: "passed", version: "42.0.0" }, "pr", afterReceipt), "utf8");

				expectDiscoveryFailure(root, expected);
			} finally {
				rmSync(root, { force: true, recursive: true });
			}
		}
	});

	it("binds PR and release discovery to the existing exact 0j-c matrix", () => {
		expect(existsSync(EXACT_CONFORMANCE_RUNNER_PATH)).toBe(true);
		expect(existsSync(EXACT_CONFORMANCE_CONTRACT_PATH)).toBe(true);
		expect(contract.conformanceBinding).toEqual({
			runnerRelativePath: "packages/protocol-v3/scripts/run-blueprint-conformance-v1.mjs",
			contractRelativePath: "tests/fixtures/phase-0j-c-v3/blueprint-conformance-contract.json",
			receiptSchemaVersion: 1,
			supportedTiers: ["pr", "nightly"],
			requiredEngines: ["node", "chromium", "firefox", "webkit"],
		});

		const workflowPath = resolve(REPOSITORY_ROOT, contract.releaseBinding.workflowPath);
		const workflow = parseDocument(readFileSync(workflowPath, "utf8"), { schema: "core" });
		expect(workflow.errors.map((error) => error.message)).toEqual([]);
		const jobs = (workflow.toJS() as { jobs: Record<string, { steps: readonly { run?: string }[] }> }).jobs;
		for (const [jobId, tier] of [
			[contract.releaseBinding.prJobId, "pr"],
			[contract.releaseBinding.nightlyJobId, "nightly"],
		] as const) {
			const runs = jobs[jobId].steps
				.map((step) => step.run)
				.filter((value): value is string => typeof value === "string");
			const discoveryRun = runs.find((run) => run.includes(contract.runnerRelativePath));
			expect(discoveryRun, `${jobId} must execute the shipped-Electron discovery runner`).toBeTypeOf("string");
			expect(discoveryRun).toMatch(new RegExp(`--tier\\s+${tier}\\b`, "u"));
		}

		const releasePath = resolve(REPOSITORY_ROOT, contract.releaseBinding.releaseWorkflowPath);
		const release = parseDocument(readFileSync(releasePath, "utf8"), { schema: "core" });
		expect(release.errors.map((error) => error.message)).toEqual([]);
		const releaseJobs = (release.toJS() as { jobs: Record<string, { needs?: readonly string[]; uses?: string }> }).jobs;
		expect(releaseJobs[contract.releaseBinding.releaseGateJobId].uses).toBe(
			`./${contract.releaseBinding.workflowPath}`
		);
		expect(releaseJobs[contract.releaseBinding.npmPublishJobId].needs).toContain(
			contract.releaseBinding.releaseGateJobId
		);
	});

	it("keeps the shipping manifest free of Phase-0n policy and alternate conformance matrices", () => {
		const serialized = JSON.stringify(currentManifest);
		expect(serialized).not.toMatch(
			/Math\.|Intl|locale|transcendental|sin|cos|pow|numeric|corpus|artifactDigest|conformanceDigest/iu
		);
		expect(serialized).not.toContain(contract.conformanceBinding.contractRelativePath);
		expect(serialized).not.toContain(contract.conformanceBinding.runnerRelativePath);
		expect(relative(REPOSITORY_ROOT, EXACT_CONFORMANCE_RUNNER_PATH)).toBe(
			contract.conformanceBinding.runnerRelativePath
		);
	});
});
