import { transformSync } from "esbuild";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import expectedPackage from "./fixtures/track-p2-b/forward-counter-package.json" with { type: "json" };
import { runBlueprintCli } from "../packages/blueprint-toolchain/src/index.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "../packages/canonical/src/index.js";

type Tier = "nightly" | "pr";
type Receipt = Readonly<Record<string, unknown>>;
type Telemetry = {
	readonly arguments: readonly string[];
	readonly contract: string;
	readonly contractPath: string;
	readonly cwd: string;
	readonly files: Readonly<Record<string, string>>;
	readonly receipt?: ChildReceipt;
};
type ChildReceipt = Readonly<Record<string, unknown>>;
type Mutation = {
	readonly copyPath?: readonly (number | string)[];
	readonly kind?: "empty" | "opposite-tier";
	readonly path: readonly (number | string)[];
};
type MutationLeaf = { readonly id: string; readonly path: readonly (number | string)[] };
type MutationCase = { readonly id: string; readonly mutation: Mutation; readonly tier: Tier };

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const AUTHORING = path.join(import.meta.dirname, "fixtures/track-p2-a/forward-counter");
const GOLDENS = path.join(import.meta.dirname, "fixtures/track-p2-c");
const CONTRACT_GOLDEN = path.join(GOLDENS, "contract.json");
const RUNNER = path.join(REPOSITORY_ROOT, "packages/protocol-v3/scripts/run-blueprint-conformance-v1.mjs");
const PRELOAD = path.join(GOLDENS, "child-preload.mjs");
const temporaryDirectories: string[] = [];
const realReceipts = new Map<Tier, string>();
const CONTROL_BINDINGS = {
	ambientBad: ["ambientReducer", "ambientReducer", "ambientReducer"],
	thenable: ["thenableReducer", "unchangedReducer", "unchangedReducer"],
	intrinsicMutation: ["unchangedReducer", "unchangedReducer", "unchangedReducer"],
	moduleGlobalDrift: ["driftReducer", "unchangedReducer", "unchangedReducer"],
	noncanonicalIntermediate: ["invalidReducer", "unchangedReducer", "unchangedReducer"],
	sparseIntermediate: ["sparseReducer", "unchangedReducer", "unchangedReducer"],
} as const;
const CONTROL_NAMES = Object.keys(CONTROL_BINDINGS) as readonly (keyof typeof CONTROL_BINDINGS)[];
const ENGINE_NAMES = ["node", "chromium", "firefox", "webkit"] as const;
const GENERAL_MUTATION_LEAVES: readonly MutationLeaf[] = [
	{ id: "receipt-schema", path: ["receiptSchemaVersion"] },
	{ id: "runtime-profile", path: ["runtimeProfile"] },
	{ id: "primary-artifact-digest", path: ["artifactDigest"] },
	{ id: "execution-tier", path: ["executionTier"] },
	...(["artifactDigest", "artifactId", "runtimeProfile"] as const).map((field) => ({
		id: `package-binding-${field}`,
		path: ["packageBinding", field],
	})),
	...(["primary", ...CONTROL_NAMES] as const).flatMap((artifact) =>
		(["artifactDigest", "exactBytesSha256"] as const).map((field) => ({
			id: `artifact-${artifact}-${field}`,
			path: ["artifacts", artifact, field],
		}))
	),
	...(["corpusVersion", "seed", "operationOrder"] as const).map((field) => ({
		id: `corpus-${field}`,
		path: ["corpus", field],
	})),
	...(["pr", "nightly"] as const).flatMap((corpusTier) =>
		(["total", "selected", "dropped", "selectedCaseIds"] as const).map((field) => ({
			id: `corpus-${corpusTier}-${field}`,
			path: ["corpus", corpusTier, field],
		}))
	),
	{ id: "intrinsic-targets", path: ["selectedIntrinsicDescriptorTargets"] },
	{ id: "module-global-detected", path: ["negativeControls", "moduleGlobalDrift", "detected"] },
	...(["sameModuleInstanceDigests", "freshInstanceDigests"] as const).flatMap((kind) =>
		[0, 1].map((index) => ({
			id: `module-global-${kind}-${index}`,
			path: ["negativeControls", "moduleGlobalDrift", kind, index],
		}))
	),
	{ id: "intrinsic-control-detected", path: ["negativeControls", "intrinsicMutation", "detected"] },
	{ id: "intrinsic-control-before", path: ["negativeControls", "intrinsicMutation", "snapshotBeforeEvaluation"] },
	{ id: "intrinsic-control-after", path: ["negativeControls", "intrinsicMutation", "snapshotAfterEvaluation"] },
];
const ENGINE_MUTATION_LEAVES: readonly MutationLeaf[] = [
	...(["name", "build", "conformanceDigest", "finalState", "outputs"] as const).map((field) => ({
		id: `engine-${field}`,
		path: [field],
	})),
	...(["Date", "Math.random", "performance", "timers", "io", "dom"] as const).flatMap((hook) =>
		(["installed", "probe"] as const).map((field) => ({ id: `hook-${hook}-${field}`, path: ["hooks", hook, field] }))
	),
	{ id: "executed-case-ids", path: ["executedCaseIds"] },
	{ id: "negative-zero-input", path: ["normalization", "negativeZeroOperationArguments"] },
	{ id: "negative-zero-output", path: ["normalization", "normalizedNegativeZeroOutputs"] },
	...(["freshInstances", "sameModuleInstance"] as const).flatMap((kind) =>
		[0, 1].map((index) => ({ id: `replay-${kind}-${index}`, path: ["replays", kind, index] }))
	),
	...(
		[
			"ambientHookConsumption",
			"badFixtureDigest",
			"badFixtureMismatch",
			"intrinsicMutationDetected",
			"throwModeFailedClosed",
		] as const
	).map((field) => ({ id: `sentinel-${field}`, path: ["sentinel", field] })),
	...(["thenable", "canonicalIntermediate", "sparseIntermediate"] as const).flatMap((control) =>
		(["executed", "rejected"] as const).map((field) => ({
			id: `${control}-${field}`,
			path: [control, field],
		}))
	),
	{ id: "intrinsic-snapshot-before", path: ["intrinsicSnapshots", "beforeEvaluation"] },
	{ id: "intrinsic-snapshot-after", path: ["intrinsicSnapshots", "afterEvaluation"] },
	...[0, 1, 2, 3].map((index) => ({
		id: `intrinsic-snapshot-replay-${index}`,
		path: ["intrinsicSnapshots", "afterEveryReplay", index],
	})),
];
const MUTATION_CASES: readonly MutationCase[] = (["pr", "nightly"] as const).flatMap((tier) => [
	...GENERAL_MUTATION_LEAVES.map(({ id, path: mutationPath }) => ({
		id: `${tier}-${id}`,
		mutation: { ...(id === "execution-tier" ? { kind: "opposite-tier" as const } : {}), path: mutationPath },
		tier,
	})),
	...ENGINE_NAMES.flatMap((engine, engineIndex) =>
		ENGINE_MUTATION_LEAVES.map(({ id, path: mutationPath }) => ({
			id: `${tier}-${engine}-${id}`,
			mutation: {
				...(id === "sentinel-badFixtureDigest"
					? { copyPath: ["engines", engineIndex === 0 ? 1 : 0, "sentinel", "badFixtureDigest"] }
					: {}),
				...(id === "engine-build" ? { kind: "empty" as const } : {}),
				path: ["engines", engineIndex, ...mutationPath],
			},
			tier,
		}))
	),
]);
const EXPECTED_GENERAL_LEAF_COUNT = 41;
const EXPECTED_ENGINE_LEAF_COUNT = 41;
const EXPECTED_MUTATION_CASE_COUNT =
	2 * (EXPECTED_GENERAL_LEAF_COUNT + ENGINE_NAMES.length * EXPECTED_ENGINE_LEAF_COUNT);
const RECEIPT_KEYS = [
	"schemaVersion",
	"kind",
	"artifactId",
	"runtimeProfile",
	"blueprintDigest",
	"artifactDigest",
	"lintEvidenceDigest",
	"corpusDigest",
	"executionTier",
	"result",
	"conformanceDigest",
	"corpusVersion",
	"seed",
	"operationOrder",
	"selectedCaseIds",
	"corpusAccounting",
	"engines",
	"controlArtifactDigests",
	"controlOutcomes",
	"runnerSha256",
] as const;
const TRANSFORM_OPTIONS = {
	charset: "ascii",
	format: "esm",
	keepNames: false,
	legalComments: "none",
	lineLimit: 0,
	loader: "ts",
	logLevel: "silent",
	minify: false,
	minifyIdentifiers: false,
	minifySyntax: false,
	minifyWhitespace: false,
	platform: "neutral",
	sourcemap: false,
	sourcefile: "blueprint.ts",
	target: "es2024",
	treeShaking: false,
	tsconfigRaw: { compilerOptions: { experimentalDecorators: false, useDefineForClassFields: true } },
} as const;

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function domainHex(domain: string, bytes: Uint8Array): string {
	return Buffer.from(hashDomain(domain, bytes)).toString("hex");
}

function workspace(label: string): string {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `track-p2-c-${label}-`));
	temporaryDirectories.push(root);
	return root;
}

function authoringCopy(root: string): string {
	const authoring = path.join(root, "authoring");
	fs.cpSync(AUTHORING, authoring, { recursive: true });
	fs.rmSync(path.join(authoring, "artifact.mjs"));
	return authoring;
}

function exactKeys(value: unknown, keys: readonly string[]): void {
	expect(value).not.toBeNull();
	expect(typeof value).toBe("object");
	expect(Array.isArray(value)).toBe(false);
	expect(Reflect.ownKeys(value as object).sort()).toEqual([...keys].sort());
}

function directChild(tier: Tier, root: string): string {
	const result = spawnSync(process.execPath, [RUNNER, "--contract", CONTRACT_GOLDEN, "--tier", tier], {
		cwd: REPOSITORY_ROOT,
		encoding: "utf8",
	});
	if (result.error !== undefined) throw result.error;
	expect(result.signal).toBeNull();
	expect(result.status, result.stderr).toBe(0);
	expect(result.stdout.trim().split("\n")).toHaveLength(1);
	const filename = path.join(root, `${tier}-child-receipt.json`);
	fs.writeFileSync(filename, result.stdout);
	return filename;
}

async function runCli(
	tier: Tier,
	label: string,
	mode = "base",
	baseTier: Tier = tier,
	mutation?: Mutation
): Promise<{ readonly output: string; readonly root: string; readonly telemetry: string }> {
	const root = workspace(label);
	const output = path.join(root, "bundle");
	const telemetry = path.join(root, "telemetry.json");
	const previous = {
		base: process.env.TRACK_P2_C_BASE_RECEIPT,
		mode: process.env.TRACK_P2_C_CHILD_MODE,
		mutation: process.env.TRACK_P2_C_MUTATION,
		nodeOptions: process.env.NODE_OPTIONS,
		telemetry: process.env.TRACK_P2_C_TELEMETRY,
	};
	process.env.NODE_OPTIONS = `${previous.nodeOptions === undefined ? "" : `${previous.nodeOptions} `}--import=${pathToFileURL(PRELOAD).href}`;
	process.env.TRACK_P2_C_BASE_RECEIPT = realReceipts.get(baseTier);
	process.env.TRACK_P2_C_CHILD_MODE = mode;
	if (mutation === undefined) delete process.env.TRACK_P2_C_MUTATION;
	else process.env.TRACK_P2_C_MUTATION = JSON.stringify(mutation);
	process.env.TRACK_P2_C_TELEMETRY = telemetry;
	try {
		const completion = runBlueprintCli(["build", "--dir", authoringCopy(root), "--out", output, "--tier", tier]);
		try {
			await completion;
		} catch (error) {
			throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
				trackP2CRoot: root,
				trackP2CTelemetry: telemetry,
			});
		}
	} finally {
		for (const [name, value] of Object.entries(previous)) {
			const key =
				name === "base"
					? "TRACK_P2_C_BASE_RECEIPT"
					: name === "mode"
						? "TRACK_P2_C_CHILD_MODE"
						: name === "mutation"
							? "TRACK_P2_C_MUTATION"
							: name === "telemetry"
								? "TRACK_P2_C_TELEMETRY"
								: "NODE_OPTIONS";
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
	return { output, root, telemetry };
}

function readTelemetry(filename: string): Telemetry {
	return JSON.parse(fs.readFileSync(filename, "utf8")) as Telemetry;
}

function emitControlArtifact(name: keyof typeof CONTROL_BINDINGS): Buffer {
	const source = fs.readFileSync(path.join(GOLDENS, `${name}.ts`), "utf8");
	const body = transformSync(source, TRANSFORM_OPTIONS).code.replace(/\n+$/u, "");
	const [add, read, set] = CONTROL_BINDINGS[name];
	const epilogue =
		`export const blueprint = {\n  exportSchemaVersion: 1,\n  artifactId: "counter.v1::${name}",\n` +
		`  runtimeProfile: "ecmascript-2024-sync-v1",\n  reducers: { "add": ${add}, "read-value": ${read}, "set": ${set} }\n};\n`;
	return Buffer.from(`${body}\n${epilogue}`);
}

function expectGeneratedBytes(telemetry: Telemetry, tier: Tier): void {
	expect(telemetry.arguments).toHaveLength(5);
	expect(path.resolve(telemetry.cwd, telemetry.arguments[0])).toBe(RUNNER);
	expect(telemetry.arguments.slice(1)).toEqual(["--contract", expect.any(String), "--tier", tier]);
	expect(path.resolve(telemetry.cwd, telemetry.arguments[2])).toBe(telemetry.contractPath);
	expect(Buffer.from(telemetry.contract, "base64")).toEqual(fs.readFileSync(CONTRACT_GOLDEN));
	expect(Object.keys(telemetry.files).sort()).toEqual(
		["primary.mjs", "primary.ts", ...CONTROL_NAMES.flatMap((name) => [`${name}.mjs`, `${name}.ts`])].sort()
	);
	const capturedPrimaryArtifact = Buffer.from(telemetry.files["primary.mjs"], "base64");
	const primaryArtifactGolden = fs.readFileSync(path.join(GOLDENS, "primary.mjs"));
	expect(capturedPrimaryArtifact).toEqual(primaryArtifactGolden);
	expect(primaryArtifactGolden).toEqual(fs.readFileSync(path.join(AUTHORING, "artifact.mjs")));
	expect(Buffer.from(telemetry.files["primary.ts"], "base64")).toEqual(
		fs.readFileSync(path.join(AUTHORING, "blueprint.ts"))
	);
	for (const name of CONTROL_NAMES) {
		const source = Buffer.from(telemetry.files[`${name}.ts`], "base64");
		const artifact = Buffer.from(telemetry.files[`${name}.mjs`], "base64");
		expect(source).toEqual(fs.readFileSync(path.join(GOLDENS, `${name}.ts`)));
		expect(artifact).toEqual(fs.readFileSync(path.join(GOLDENS, `${name}.mjs`)));
		expect(artifact).toEqual(emitControlArtifact(name));
		expect(domainHex("ts-drp/blueprint-artifact/v3", artifact)).toMatch(/^[0-9a-f]{64}$/u);
		expect(artifact.toString("utf8")).toContain(`artifactId: "counter.v1::${name}"`);
		expect(artifact.toString("utf8")).toContain('reducers: { "add":');
		expect(artifact.toString("utf8")).toContain('"read-value":');
		expect(artifact.toString("utf8")).toContain('"set":');
	}
}

function decodeReceipt(output: string): Receipt {
	const bytes = fs.readFileSync(path.join(output, "receipt.bin"));
	const receipt = decodeCanonical(bytes) as Receipt;
	expect(Buffer.from(encodeCanonical(receipt))).toEqual(bytes);
	return receipt;
}

function expectClosedReceipt(receipt: Receipt, tier: Tier, output: string, telemetry: Telemetry): void {
	exactKeys(receipt, RECEIPT_KEYS);
	expect(receipt).toMatchObject({
		artifactDigest: expectedPackage.artifactDigest,
		artifactId: "counter.v1",
		blueprintDigest: expectedPackage.blueprintDigest,
		corpusVersion: "track-p2-a-v1",
		executionTier: tier,
		kind: "ts-drp-blueprint-conformance-receipt",
		result: "passed",
		runtimeProfile: "ecmascript-2024-sync-v1",
		schemaVersion: 1,
		seed: "track-p2-a-seed-2026-08-12",
	});
	const selectedCaseIds =
		tier === "pr" ? ["pr-add-negative-zero", "pr-read"] : ["pr-add-negative-zero", "pr-read", "nightly-set"];
	expect(receipt.operationOrder).toEqual(tier === "pr" ? ["add", "read-value"] : ["add", "read-value", "set"]);
	expect(receipt.selectedCaseIds).toEqual(selectedCaseIds);
	expect(receipt.corpusAccounting).toEqual({
		pr: { total: 2, selected: 2, dropped: 0 },
		nightly: { total: 3, selected: 3, dropped: 0 },
	});
	const authoring = JSON.parse(fs.readFileSync(path.join(AUTHORING, "blueprint.json"), "utf8")) as {
		readonly conformance: Readonly<Record<string, unknown>>;
	};
	expect(receipt.corpusDigest).toBe(
		domainHex("ts-drp/blueprint-conformance-corpus/v1", encodeCanonical({ schemaVersion: 1, ...authoring.conformance }))
	);
	expect(receipt.lintEvidenceDigest).toBe(
		domainHex("ts-drp/blueprint-lint-evidence/v1", fs.readFileSync(path.join(output, "lint.bin")))
	);
	const childReceipt = telemetry.receipt as {
		readonly engines: ReadonlyArray<{
			readonly conformanceDigest: string;
			readonly finalState: unknown;
			readonly outputs: unknown;
		}>;
	};
	const exactConformanceDigests = childReceipt.engines.map((engine) =>
		domainHex("ts-drp/blueprint-conformance/v1", encodeCanonical({ state: engine.finalState, outputs: engine.outputs }))
	);
	expect(childReceipt.engines.map(({ conformanceDigest }) => conformanceDigest)).toEqual(exactConformanceDigests);
	expect(new Set(exactConformanceDigests).size).toBe(1);
	expect(receipt.conformanceDigest).toBe(exactConformanceDigests[0]);
	const engines = receipt.engines as ReadonlyArray<Readonly<Record<string, unknown>>>;
	expect(engines.map(({ name }) => name)).toEqual(["node", "chromium", "firefox", "webkit"]);
	for (const engine of engines) {
		exactKeys(engine, ["name", "build", "conformanceDigest"]);
		expect(engine.build).toMatch(/^[\x20-\x7e]{1,512}$/u);
		expect(engine.conformanceDigest).toBe(receipt.conformanceDigest);
	}
	expect(receipt.controlOutcomes).toEqual({
		ambientBad: { lintRejected: true, crossEngineDigestDisagreement: true },
		thenable: { executed: true, rejected: true },
		intrinsicMutation: { detected: true },
		moduleGlobalDrift: { detected: true },
		noncanonicalIntermediate: { executed: true, rejected: true },
		sparseIntermediate: { executed: true, rejected: true },
	});
	const controlDigests = receipt.controlArtifactDigests as Readonly<Record<string, string>>;
	exactKeys(controlDigests, CONTROL_NAMES);
	for (const name of CONTROL_NAMES)
		expect(controlDigests[name]).toBe(
			domainHex("ts-drp/blueprint-artifact/v3", fs.readFileSync(path.join(GOLDENS, `${name}.mjs`)))
		);
	expect(receipt.runnerSha256).toBe(sha256(fs.readFileSync(RUNNER)));
	expect(Object.hasOwn(receipt, "catalogable")).toBe(false);
	expect(receipt.executionTier === "nightly").toBe(tier === "nightly");
}

afterAll(() => {
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
});

describe.sequential("Track P2-c generated generic conformance causal RED", () => {
	it("proves the unchanged child executes the exact contract in all four real engines for PR and nightly", () => {
		const root = workspace("real-four-engine-controls");
		for (const tier of ["pr", "nightly"] as const) {
			const filename = directChild(tier, root);
			realReceipts.set(tier, filename);
			const receipt = JSON.parse(fs.readFileSync(filename, "utf8")) as {
				readonly engines: readonly { readonly build: string; readonly name: string }[];
				readonly executionTier: Tier;
			};
			expect(receipt.executionTier).toBe(tier);
			expect(receipt.engines.map(({ name }) => name)).toEqual(["node", "chromium", "firefox", "webkit"]);
			for (const engine of receipt.engines) expect(engine.build).not.toBe("");
		}
	}, 30_000);

	it.each(["pr", "nightly"] as const)(
		"routes the exact %s tier through the CLI and unchanged-child contract/source/artifact bytes",
		async (tier) => {
			const { output, telemetry } = await runCli(tier, `exact-${tier}`);
			const captured = readTelemetry(telemetry);
			expectGeneratedBytes(captured, tier);
			expect(fs.readdirSync(output).sort()).toEqual(["artifact.mjs", "lint.bin", "package.bin", "receipt.bin"]);
			expectClosedReceipt(decodeReceipt(output), tier, output, captured);
		}
	);

	it.each(["pr", "nightly"] as const)(
		"is deterministic for %s while diagnostic child stderr remains non-authoritative",
		async (tier) => {
			const first = await runCli(tier, `deterministic-${tier}`);
			const diagnostic = await runCli(tier, `diagnostic-stderr-${tier}`, "diagnostic-stderr");
			for (const filename of ["artifact.mjs", "lint.bin", "package.bin", "receipt.bin"])
				expect(fs.readFileSync(path.join(diagnostic.output, filename))).toEqual(
					fs.readFileSync(path.join(first.output, filename))
				);
			expectClosedReceipt(
				decodeReceipt(diagnostic.output),
				tier,
				diagnostic.output,
				readTelemetry(diagnostic.telemetry)
			);
		}
	);

	it("binds lint and conformance claims to independently mutated exact preimages", async () => {
		const built = await runCli("pr", "digest-preimage-controls");
		const receipt = decodeReceipt(built.output);
		const telemetry = readTelemetry(built.telemetry);
		expectClosedReceipt(receipt, "pr", built.output, telemetry);
		const badLintClaim = { ...receipt, lintEvidenceDigest: "00".repeat(32) };
		expect(() => expectClosedReceipt(badLintClaim, "pr", built.output, telemetry)).toThrow();
		const lintBytes = fs.readFileSync(path.join(built.output, "lint.bin"));
		fs.writeFileSync(path.join(built.output, "lint.bin"), Buffer.concat([lintBytes, Buffer.from([0])]));
		expect(() => expectClosedReceipt(receipt, "pr", built.output, telemetry)).toThrow();
		fs.writeFileSync(path.join(built.output, "lint.bin"), lintBytes);
		const badChildPreimage = structuredClone(telemetry);
		(badChildPreimage.receipt as { engines: Array<{ finalState: unknown }> }).engines[0].finalState = 1;
		expect(() => expectClosedReceipt(receipt, "pr", built.output, badChildPreimage)).toThrow();
		const badChildClaim = structuredClone(telemetry);
		(badChildClaim.receipt as { engines: Array<{ conformanceDigest: string }> }).engines[0].conformanceDigest =
			"00".repeat(32);
		expect(() => expectClosedReceipt(receipt, "pr", built.output, badChildClaim)).toThrow();
	});

	it.each(
		(["pr", "nightly"] as const).flatMap((tier) =>
			(["nonzero", "signal", "empty-stdout", "malformed-stdout", "double-stdout"] as const).map((mode) => ({
				id: `${tier}-${mode}`,
				mode,
				tier,
			}))
		)
	)("rejects child channel violation $id before an atomic four-product bundle exists", async ({ mode, tier }) => {
		let resolved = false;
		try {
			await runCli(tier, `channel-${mode}-${tier}`, mode);
			resolved = true;
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			const root = (error as Error & { readonly trackP2CRoot?: string }).trackP2CRoot;
			expect(root).toBeDefined();
			if (root !== undefined) {
				expect(fs.existsSync(path.join(root, "bundle"))).toBe(false);
				expect(fs.readdirSync(root).sort()).toEqual(["authoring", "telemetry.json"].sort());
			}
		}
		expect(resolved).toBe(false);
	});

	it.each(MUTATION_CASES)(
		"rejects closed-registry evidence mutation $id before an atomic four-product bundle exists",
		async ({ id, mutation, tier }) => {
			let resolved = false;
			try {
				await runCli(tier, `evidence-${id}`, "mutate", tier, mutation);
				resolved = true;
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				const root = (error as Error & { readonly trackP2CRoot?: string }).trackP2CRoot;
				expect(root).toBeDefined();
				if (root !== undefined) {
					expect(fs.existsSync(path.join(root, "bundle"))).toBe(false);
					expect(fs.readdirSync(root).sort()).toEqual(["authoring", "telemetry.json"].sort());
				}
			}
			expect(resolved).toBe(false);
		}
	);

	it("proves the closed mutation registry cardinality and unique tier/engine/leaf coverage", () => {
		expect(GENERAL_MUTATION_LEAVES).toHaveLength(EXPECTED_GENERAL_LEAF_COUNT);
		expect(ENGINE_MUTATION_LEAVES).toHaveLength(EXPECTED_ENGINE_LEAF_COUNT);
		expect(MUTATION_CASES).toHaveLength(EXPECTED_MUTATION_CASE_COUNT);
		expect(new Set(MUTATION_CASES.map(({ id }) => id)).size).toBe(EXPECTED_MUTATION_CASE_COUNT);
		for (const tier of ["pr", "nightly"] as const) {
			const childReceipt = JSON.parse(fs.readFileSync(realReceipts.get(tier) as string, "utf8")) as Record<
				string,
				unknown
			>;
			for (const leaf of GENERAL_MUTATION_LEAVES)
				expect(MUTATION_CASES.some(({ id }) => id === `${tier}-${leaf.id}`)).toBe(true);
			for (const engine of ENGINE_NAMES)
				for (const leaf of ENGINE_MUTATION_LEAVES)
					expect(MUTATION_CASES.some(({ id }) => id === `${tier}-${engine}-${leaf.id}`)).toBe(true);
			for (const { mutation } of MUTATION_CASES.filter((candidate) => candidate.tier === tier)) {
				let value: unknown = childReceipt;
				for (const segment of mutation.path) value = (value as Record<number | string, unknown>)[segment];
				expect(value).not.toBeUndefined();
			}
		}
	});

	it("pins the recursively compact nine-key contract, source-to-artifact goldens and domains", () => {
		const bytes = fs.readFileSync(CONTRACT_GOLDEN);
		const contract = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
		expect(bytes.at(-1)).toBe(0x0a);
		expect(bytes.subarray(0, -1).includes(0x0a)).toBe(false);
		expect(bytes.toString("utf8")).toContain('"value":-0');
		expect(Reflect.ownKeys(contract)).toEqual([
			"schemaVersion",
			"runner",
			"runtimeProfile",
			"artifactDigestDomain",
			"conformance",
			"packageTemplate",
			"artifacts",
			"prOperations",
			"nightlyOperations",
		]);
		expect((contract.packageTemplate as { implementation: unknown }).implementation).toEqual(
			expectedPackage.package.implementation
		);
		expect(domainHex("ts-drp/blueprint-artifact/v3", fs.readFileSync(path.join(AUTHORING, "artifact.mjs")))).toBe(
			expectedPackage.artifactDigest
		);
		for (const name of CONTROL_NAMES)
			expect(fs.readFileSync(path.join(GOLDENS, `${name}.mjs`))).toEqual(emitControlArtifact(name));
	});
});
