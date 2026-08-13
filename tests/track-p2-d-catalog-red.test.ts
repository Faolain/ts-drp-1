/* eslint-disable import/order -- the protocol-v3 observation mock must precede the catalog import */

import { decodeCanonical, encodeCanonical, hashDomain } from "../packages/canonical/src/index.js";

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import catalogManifest from "../packages/blueprint-catalog/package.json" with { type: "json" };
import fixtureMetadata from "./fixtures/track-p2-d/fixture-metadata.json" with { type: "json" };
import packageGolden from "./fixtures/track-p2-b/forward-counter-package.json" with { type: "json" };

type AdmissionInput = {
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly expectedBlueprintDigest: string;
};
type RuntimeInput = AdmissionInput & {
	readonly exactArtifactBytes: Uint8Array;
	readonly preparedBlueprintAdmission: unknown;
};

const preparationProbe = vi.hoisted(() => ({
	admissionFailure: false,
	admissionInputs: [] as AdmissionInput[],
	runtimeInputs: [] as RuntimeInput[],
}));
const lexerProbe = vi.hoisted(() => ({ initSyncCalls: 0 }));

// The catalog owns its own workspace dependency symlink. Mock that concrete
// resolution so this probe observes the module evaluated by the catalog rather
// than a separate optimizer identity rooted at this test file.
vi.mock("../packages/blueprint-catalog/node_modules/es-module-lexer/dist/lexer.js", async (importOriginal) => {
	const genuine = (await importOriginal()) as { initSync(): void };
	return {
		...(await importOriginal()),
		initSync(): void {
			lexerProbe.initSyncCalls++;
			genuine.initSync();
		},
	};
});

vi.mock("@ts-drp/protocol-v3", async (importOriginal) => {
	const genuine = (await importOriginal()) as {
		prepareBlueprintAdmission(input: AdmissionInput): unknown;
		prepareBlueprintRuntime(input: RuntimeInput): Promise<unknown>;
	};
	return {
		...genuine,
		prepareBlueprintAdmission(input: AdmissionInput): unknown {
			preparationProbe.admissionInputs.push({
				canonicalBlueprintPackageBytes: new Uint8Array(input.canonicalBlueprintPackageBytes),
				expectedBlueprintDigest: input.expectedBlueprintDigest,
			});
			if (preparationProbe.admissionFailure) throw new TypeError("synthetic genuine admission failure");
			return genuine.prepareBlueprintAdmission(input);
		},
		async prepareBlueprintRuntime(input: RuntimeInput): Promise<unknown> {
			preparationProbe.runtimeInputs.push(input);
			return genuine.prepareBlueprintRuntime(input);
		},
	};
});

import * as catalogNamespace from "../packages/blueprint-catalog/src/index.js";
import { DRP_ERROR_CODES, DRPError } from "../packages/errors/src/index.js";
import { runBlueprintCli } from "../packages/blueprint-toolchain/src/index.js";

// Static imports above have finished, while no open/resolve/CLI call has run.
// This snapshot therefore distinguishes required module-evaluation
// initialization from an impermissible lazy first-use initialization.
const lexerInitializationCallsAtModuleEvaluation = lexerProbe.initSyncCalls;

type CatalogEntry = {
	artifactDigest: string;
	artifactId: string;
	blueprintDigest: string;
	conformanceReceiptDigest: string;
	lintEvidenceDigest: string;
	runtimeProfile: string;
};
type CatalogValue = {
	entries: CatalogEntry[];
	kind: string;
	schemaVersion: number;
};
type Evidence = {
	readonly catalogDigest: string;
	readonly conformanceDigest: string;
	readonly conformanceReceiptDigest: string;
	readonly conformanceResult: "passed";
	readonly conformanceTier: "nightly";
	readonly engines: readonly { readonly build: string; readonly name: string }[];
	readonly lintEvidenceDigest: string;
};
type ResolvedBlueprintBytes = {
	readonly artifactDigest: string;
	readonly artifactId: string;
	readonly blueprintDigest: string;
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly evidence: Evidence;
	readonly exactArtifactBytes: Uint8Array;
	readonly runtimeProfile: string;
};
type TrustedBlueprintCatalog = {
	readonly blueprintDigests: readonly string[];
	readonly catalogDigest: string;
	resolve(blueprintDigest: string): ResolvedBlueprintBytes;
};
type CatalogApi = {
	readonly BlueprintCatalogError: new (code: string, message?: string) => DRPError;
	openTrustedBlueprintCatalog(options: { readonly catalogDirectory: string }): TrustedBlueprintCatalog;
};
type Fixture = {
	readonly artifactBytes: Buffer;
	readonly blueprintDigest: string;
	readonly catalogBytes: Buffer;
	readonly catalogDigest: string;
	readonly catalogValue: CatalogValue;
	readonly lintBytes: Buffer;
	readonly lintEvidenceDigest: string;
	readonly packageBytes: Buffer;
	readonly receiptBytes: Buffer;
	readonly receiptDigest: string;
};
type Workspace = Fixture & { readonly directory: string; readonly root: string };

const api = catalogNamespace as unknown as CatalogApi;
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const ARTIFACT = path.join(import.meta.dirname, "fixtures/track-p2-c/primary.mjs");
const AUTHORING = path.join(import.meta.dirname, "fixtures/track-p2-a/forward-counter/blueprint.json");
const SOURCE = path.join(import.meta.dirname, "fixtures/track-p2-a/forward-counter/blueprint.ts");
const RUNNER = path.join(REPOSITORY_ROOT, "packages/protocol-v3/scripts/run-blueprint-conformance-v1.mjs");
const CONTROL_NAMES = [
	"ambientBad",
	"thenable",
	"intrinsicMutation",
	"moduleGlobalDrift",
	"noncanonicalIntermediate",
	"sparseIntermediate",
] as const;
const ENGINE_NAMES = ["node", "chromium", "firefox", "webkit"] as const;
const CATALOG_ERROR_CODES = [
	"BLUEPRINT_CATALOG_DIRECTORY_INVALID",
	"BLUEPRINT_CATALOG_FILE_UNREADABLE",
	"BLUEPRINT_CATALOG_BYTES_NONCANONICAL",
	"BLUEPRINT_CATALOG_SCHEMA_INVALID",
	"BLUEPRINT_CATALOG_ORDER_INVALID",
	"BLUEPRINT_CATALOG_DUPLICATE_IDENTITY",
	"BLUEPRINT_ENTRY_FILE_UNREADABLE",
	"BLUEPRINT_PACKAGE_BYTES_NONCANONICAL",
	"BLUEPRINT_PACKAGE_DIGEST_MISMATCH",
	"BLUEPRINT_PACKAGE_SCHEMA_INVALID",
	"BLUEPRINT_ARTIFACT_BYTES_INVALID",
	"BLUEPRINT_ARTIFACT_DIGEST_MISMATCH",
	"BLUEPRINT_ARTIFACT_PACKAGE_CROSS_PAIR",
	"BLUEPRINT_RUNTIME_PROFILE_UNSUPPORTED",
	"BLUEPRINT_LINT_EVIDENCE_INVALID",
	"BLUEPRINT_LINT_EVIDENCE_UNBOUND",
	"BLUEPRINT_CONFORMANCE_RECEIPT_INVALID",
	"BLUEPRINT_CONFORMANCE_RECEIPT_UNBOUND",
	"BLUEPRINT_CONFORMANCE_TIER_INSUFFICIENT",
	"BLUEPRINT_CONFORMANCE_ENGINE_MATRIX_INCOMPLETE",
	"BLUEPRINT_CONFORMANCE_RESULT_NOT_PASSED",
	"BLUEPRINT_REQUEST_MALFORMED",
	"BLUEPRINT_NOT_CATALOGUED",
] as const;
const temporaryDirectories: string[] = [];

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function domainHex(domain: string, bytes: Uint8Array): string {
	return Buffer.from(hashDomain(domain, bytes)).toString("hex");
}

function canonicalBytes(value: unknown): Buffer {
	return Buffer.from(encodeCanonical(value));
}

function fixture(): Fixture {
	const artifactBytes = fs.readFileSync(ARTIFACT);
	const packageBytes = canonicalBytes(packageGolden.package);
	const authoring = JSON.parse(fs.readFileSync(AUTHORING, "utf8")) as {
		readonly conformance: {
			readonly corpusVersion: string;
			readonly initialState: unknown;
			readonly nightlyAdditionalCases: readonly { readonly action: string; readonly id: string }[];
			readonly prCases: readonly { readonly action: string; readonly id: string }[];
			readonly seed: string;
		};
	};
	const lint = {
		schemaVersion: 1,
		kind: "ts-drp-blueprint-lint-evidence",
		artifactDigest: fixtureMetadata.artifactDigest,
		artifactSha256: fixtureMetadata.artifactSha256,
		sourceSha256: fixtureMetadata.sourceSha256,
		authoringSha256: fixtureMetadata.authoringSha256,
		ruleId: "drp/no-ambient-in-reducer",
		rulePackage: "eslint-plugin-ts-drp",
		ruleSourceSha256: fixtureMetadata.ruleSourceSha256,
		lintContractSha256: fixtureMetadata.lintContractSha256,
		eslintVersion: "9.23.0",
		parserVersion: "8.29.0",
		targets: [
			{ kind: "artifact", sha256: fixtureMetadata.artifactSha256, diagnosticCount: 0 },
			{ kind: "source", sha256: fixtureMetadata.sourceSha256, diagnosticCount: 0 },
		],
		result: "clean",
	};
	const lintBytes = canonicalBytes(lint);
	const lintEvidenceDigest = domainHex("ts-drp/blueprint-lint-evidence/v1", lintBytes);
	const corpusBytes = canonicalBytes({
		schemaVersion: 1,
		corpusVersion: authoring.conformance.corpusVersion,
		seed: authoring.conformance.seed,
		initialState: authoring.conformance.initialState,
		prCases: authoring.conformance.prCases,
		nightlyAdditionalCases: authoring.conformance.nightlyAdditionalCases,
	});
	const conformanceDigest = domainHex(
		"ts-drp/blueprint-conformance/v1",
		canonicalBytes({ state: 7, outputs: [0, 0, 7] })
	);
	const controlArtifactDigests = Object.fromEntries(
		CONTROL_NAMES.map((name) => [
			name,
			domainHex(
				"ts-drp/blueprint-artifact/v3",
				fs.readFileSync(path.join(import.meta.dirname, `fixtures/track-p2-c/${name}.mjs`))
			),
		])
	);
	const selectedCases = [...authoring.conformance.prCases, ...authoring.conformance.nightlyAdditionalCases];
	const receipt = {
		schemaVersion: 1,
		kind: "ts-drp-blueprint-conformance-receipt",
		artifactId: fixtureMetadata.artifactId,
		runtimeProfile: fixtureMetadata.runtimeProfile,
		blueprintDigest: fixtureMetadata.blueprintDigest,
		artifactDigest: fixtureMetadata.artifactDigest,
		lintEvidenceDigest,
		corpusDigest: domainHex("ts-drp/blueprint-conformance-corpus/v1", corpusBytes),
		executionTier: "nightly",
		result: "passed",
		conformanceDigest,
		corpusVersion: authoring.conformance.corpusVersion,
		seed: authoring.conformance.seed,
		operationOrder: selectedCases.map(({ action }) => action),
		selectedCaseIds: selectedCases.map(({ id }) => id),
		corpusAccounting: {
			pr: { total: authoring.conformance.prCases.length, selected: authoring.conformance.prCases.length, dropped: 0 },
			nightly: { total: selectedCases.length, selected: selectedCases.length, dropped: 0 },
		},
		engines: ENGINE_NAMES.map((name) => ({
			name,
			build: `${fixtureMetadata.syntheticEngineBuild}-${name}`,
			conformanceDigest,
		})),
		controlArtifactDigests,
		controlOutcomes: {
			ambientBad: { lintRejected: true, crossEngineDigestDisagreement: true },
			thenable: { executed: true, rejected: true },
			intrinsicMutation: { detected: true },
			moduleGlobalDrift: { detected: true },
			noncanonicalIntermediate: { executed: true, rejected: true },
			sparseIntermediate: { executed: true, rejected: true },
		},
		runnerSha256: fixtureMetadata.runnerSha256,
	};
	const receiptBytes = canonicalBytes(receipt);
	const receiptDigest = domainHex("ts-drp/blueprint-conformance-receipt/v1", receiptBytes);
	const catalogValue = {
		schemaVersion: 1,
		kind: "ts-drp-trusted-blueprint-catalog",
		entries: [
			{
				blueprintDigest: fixtureMetadata.blueprintDigest,
				artifactDigest: fixtureMetadata.artifactDigest,
				artifactId: fixtureMetadata.artifactId,
				runtimeProfile: fixtureMetadata.runtimeProfile,
				lintEvidenceDigest,
				conformanceReceiptDigest: receiptDigest,
			},
		],
	};
	const catalogBytes = canonicalBytes(catalogValue);
	return {
		artifactBytes,
		blueprintDigest: fixtureMetadata.blueprintDigest,
		catalogBytes,
		catalogDigest: domainHex("ts-drp/blueprint-catalog/v1", catalogBytes),
		catalogValue,
		lintBytes,
		lintEvidenceDigest,
		packageBytes,
		receiptBytes,
		receiptDigest,
	};
}

function temporaryRoot(label: string): string {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `track-p2-d-${label}-`));
	temporaryDirectories.push(root);
	return root;
}

function materialize(label: string, value = fixture()): Workspace {
	const root = temporaryRoot(label);
	const directory = path.join(root, "catalog");
	fs.mkdirSync(directory);
	fs.writeFileSync(path.join(directory, "catalog.bin"), value.catalogBytes);
	fs.writeFileSync(path.join(directory, `${value.blueprintDigest}.artifact.mjs`), value.artifactBytes);
	fs.writeFileSync(path.join(directory, `${value.blueprintDigest}.package.bin`), value.packageBytes);
	fs.writeFileSync(path.join(directory, `${value.blueprintDigest}.lint.bin`), value.lintBytes);
	fs.writeFileSync(path.join(directory, `${value.blueprintDigest}.receipt.bin`), value.receiptBytes);
	return { ...value, directory, root };
}

function asset(workspace: Workspace, suffix: string, digest = workspace.blueprintDigest): string {
	return path.join(workspace.directory, `${digest}.${suffix}`);
}

function readValue<T>(filename: string): T {
	return decodeCanonical(fs.readFileSync(filename)) as T;
}

function writeValue(filename: string, value: unknown): Buffer {
	const bytes = canonicalBytes(value);
	fs.writeFileSync(filename, bytes);
	return bytes;
}

function updateCatalog(workspace: Workspace, update: (value: CatalogValue) => void): void {
	const filename = path.join(workspace.directory, "catalog.bin");
	const value = readValue<CatalogValue>(filename);
	update(value);
	writeValue(filename, value);
}

function soleEntry(catalog: CatalogValue): CatalogEntry {
	const [entry] = catalog.entries;
	if (entry === undefined) throw new TypeError("test oracle requires exactly one catalog entry");
	return entry;
}

function updateReceipt(workspace: Workspace, update: (value: Record<string, unknown>) => void): void {
	const filename = asset(workspace, "receipt.bin");
	const value = readValue<Record<string, unknown>>(filename);
	update(value);
	const bytes = writeValue(filename, value);
	updateCatalog(workspace, (catalog) => {
		soleEntry(catalog).conformanceReceiptDigest = domainHex("ts-drp/blueprint-conformance-receipt/v1", bytes);
	});
}

function updateLint(workspace: Workspace, update: (value: Record<string, unknown>) => void): void {
	const filename = asset(workspace, "lint.bin");
	const value = readValue<Record<string, unknown>>(filename);
	update(value);
	const bytes = writeValue(filename, value);
	updateCatalog(workspace, (catalog) => {
		soleEntry(catalog).lintEvidenceDigest = domainHex("ts-drp/blueprint-lint-evidence/v1", bytes);
	});
}

function rekeyPackage(
	workspace: Workspace,
	update: (value: typeof packageGolden.package) => void,
	entryUpdate?: (entry: CatalogEntry) => void
): void {
	const previousDigest = workspace.blueprintDigest;
	const value = readValue<typeof packageGolden.package>(asset(workspace, "package.bin"));
	update(value);
	const bytes = canonicalBytes(value);
	const nextDigest = domainHex("ts-drp/blueprint-admission/v3", bytes);
	for (const suffix of ["artifact.mjs", "package.bin", "lint.bin", "receipt.bin"]) {
		fs.renameSync(asset(workspace, suffix, previousDigest), asset(workspace, suffix, nextDigest));
	}
	fs.writeFileSync(asset(workspace, "package.bin", nextDigest), bytes);
	updateCatalog(workspace, (catalog) => {
		const entry = soleEntry(catalog);
		entry.blueprintDigest = nextDigest;
		entryUpdate?.(entry);
	});
}

function replaceArtifact(workspace: Workspace, changed: Buffer): void {
	const artifactDigest = domainHex("ts-drp/blueprint-artifact/v3", changed);
	rekeyPackage(
		workspace,
		(value) => {
			value.implementation.artifactDigest = artifactDigest;
		},
		(entry) => {
			entry.artifactDigest = artifactDigest;
		}
	);
	const nextDigest = soleEntry(readValue<CatalogValue>(path.join(workspace.directory, "catalog.bin"))).blueprintDigest;
	fs.writeFileSync(asset(workspace, "artifact.mjs", nextDigest), changed);
}

function catalogFilenames(workspace: Workspace): readonly string[] {
	return [
		path.join(workspace.directory, "catalog.bin"),
		asset(workspace, "artifact.mjs"),
		asset(workspace, "package.bin"),
		asset(workspace, "lint.bin"),
		asset(workspace, "receipt.bin"),
	];
}

function expectCode(
	operation: () => unknown,
	code: (typeof CATALOG_ERROR_CODES)[number],
	hiddenPaths: readonly string[] = []
): void {
	let thrown: unknown;
	try {
		operation();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(api.BlueprintCatalogError);
	expect(thrown).toBeInstanceOf(DRPError);
	expect(thrown).toMatchObject({ code, name: "BlueprintCatalogError" });
	for (const hiddenPath of hiddenPaths) expect((thrown as Error).message).not.toContain(hiddenPath);
}

beforeEach(() => {
	preparationProbe.admissionFailure = false;
	preparationProbe.admissionInputs.length = 0;
	preparationProbe.runtimeInputs.length = 0;
	vi.restoreAllMocks();
});

afterAll(() => {
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
});

describe("Track P2-d canonical catalog fixture and public resolver RED", () => {
	it("opens the exact one-entry synthetic nightly catalog and exposes only frozen byte provenance", () => {
		const workspace = materialize("open-exact");
		const realpath = vi.spyOn(fs, "realpathSync");
		const read = vi.spyOn(fs, "readFileSync");
		const handle = api.openTrustedBlueprintCatalog({ catalogDirectory: workspace.directory });
		expect(realpath.mock.calls.filter(([filename]) => filename === workspace.directory)).toHaveLength(1);
		for (const filename of catalogFilenames(workspace)) {
			expect(
				read.mock.calls.filter(([input]) => input === filename),
				filename
			).toHaveLength(1);
		}
		expect(handle.blueprintDigests).toEqual([workspace.blueprintDigest]);
		expect(handle.catalogDigest).toBe(workspace.catalogDigest);
		expect(Reflect.ownKeys(handle).sort()).toEqual(["blueprintDigests", "catalogDigest", "resolve"]);
		expect(Object.isFrozen(handle)).toBe(true);
		expect(Object.isFrozen(handle.blueprintDigests)).toBe(true);
		const resolved = handle.resolve(workspace.blueprintDigest);
		expect(resolved).toMatchObject({
			artifactDigest: fixtureMetadata.artifactDigest,
			artifactId: fixtureMetadata.artifactId,
			blueprintDigest: fixtureMetadata.blueprintDigest,
			runtimeProfile: fixtureMetadata.runtimeProfile,
			evidence: {
				catalogDigest: workspace.catalogDigest,
				lintEvidenceDigest: workspace.lintEvidenceDigest,
				conformanceReceiptDigest: workspace.receiptDigest,
				conformanceTier: "nightly",
				conformanceResult: "passed",
			},
		});
		expect(resolved.canonicalBlueprintPackageBytes).toEqual(workspace.packageBytes);
		expect(resolved.exactArtifactBytes).toEqual(workspace.artifactBytes);
		expect(Reflect.ownKeys(resolved).sort()).toEqual(
			[
				"artifactDigest",
				"artifactId",
				"blueprintDigest",
				"canonicalBlueprintPackageBytes",
				"evidence",
				"exactArtifactBytes",
				"runtimeProfile",
			].sort()
		);
		expect(Reflect.ownKeys(resolved.evidence).sort()).toEqual(
			[
				"catalogDigest",
				"conformanceDigest",
				"conformanceReceiptDigest",
				"conformanceResult",
				"conformanceTier",
				"engines",
				"lintEvidenceDigest",
			].sort()
		);
		expect(resolved.evidence.engines.map(({ name }) => name)).toEqual(ENGINE_NAMES);
		expect(Object.isFrozen(resolved)).toBe(true);
		expect(Object.isFrozen(resolved.evidence)).toBe(true);
		expect(Object.isFrozen(resolved.evidence.engines)).toBe(true);
		for (const engine of resolved.evidence.engines) expect(Object.isFrozen(engine)).toBe(true);
		expect(preparationProbe.admissionInputs).toEqual([
			{
				canonicalBlueprintPackageBytes: new Uint8Array(workspace.packageBytes),
				expectedBlueprintDigest: workspace.blueprintDigest,
			},
		]);
		expect(preparationProbe.runtimeInputs).toEqual([]);
	});

	it("keeps resolve synchronous, zero-I/O, repeatable, and detached from disk and prior results", () => {
		const workspace = materialize("pure-resolve");
		const handle = api.openTrustedBlueprintCatalog({ catalogDirectory: workspace.directory });
		fs.writeFileSync(asset(workspace, "artifact.mjs"), "changed after open\n");
		fs.writeFileSync(asset(workspace, "package.bin"), "changed after open\n");
		const read = vi.spyOn(fs, "readFileSync");
		const first = handle.resolve(workspace.blueprintDigest);
		first.exactArtifactBytes.fill(0);
		first.canonicalBlueprintPackageBytes.fill(0);
		const second = handle.resolve(workspace.blueprintDigest);
		expect(read).not.toHaveBeenCalled();
		expect(second.exactArtifactBytes).toEqual(workspace.artifactBytes);
		expect(second.canonicalBlueprintPackageBytes).toEqual(workspace.packageBytes);
		expect(second.exactArtifactBytes).not.toBe(first.exactArtifactBytes);
		expect(second.canonicalBlueprintPackageBytes).not.toBe(first.canonicalBlueprintPackageBytes);
		expect(preparationProbe.admissionInputs).toHaveLength(1);
		expect(preparationProbe.runtimeInputs).toEqual([]);
	});

	it("accepts an empty canonical catalog and unrelated directory entries", () => {
		const root = temporaryRoot("empty-extra");
		const directory = path.join(root, "catalog");
		fs.mkdirSync(directory);
		const catalogBytes = canonicalBytes({ schemaVersion: 1, kind: "ts-drp-trusted-blueprint-catalog", entries: [] });
		fs.writeFileSync(path.join(directory, "catalog.bin"), catalogBytes);
		fs.writeFileSync(path.join(directory, "operator-note.txt"), "unrelated\n");
		const handle = api.openTrustedBlueprintCatalog({ catalogDirectory: directory });
		expect(handle.blueprintDigests).toEqual([]);
		expect(handle.catalogDigest).toBe(domainHex("ts-drp/blueprint-catalog/v1", catalogBytes));
		expect(() => handle.resolve("00".repeat(32))).toThrowError(
			expect.objectContaining({ code: "BLUEPRINT_NOT_CATALOGUED" })
		);
	});

	it("allows a symlink only in an absolute ancestor above the supplied catalog directory", () => {
		const workspace = materialize("symlink-ancestor");
		const alias = path.join(workspace.root, "ancestor-alias");
		fs.symlinkSync(workspace.root, alias, "dir");
		const suppliedDirectory = path.join(alias, "catalog");
		const handle = api.openTrustedBlueprintCatalog({ catalogDirectory: suppliedDirectory });
		expect(handle.blueprintDigests).toEqual([workspace.blueprintDigest]);
		expect(handle.catalogDigest).toBe(workspace.catalogDigest);
	});
});

type OpenMutation = {
	readonly code: (typeof CATALOG_ERROR_CODES)[number];
	readonly label: string;
	mutate(workspace: Workspace): unknown;
};

const OPEN_MUTATIONS: readonly OpenMutation[] = [
	{
		label: "relative directory",
		code: "BLUEPRINT_CATALOG_DIRECTORY_INVALID",
		mutate: () => "relative/catalog",
	},
	{
		label: "symlinked directory",
		code: "BLUEPRINT_CATALOG_DIRECTORY_INVALID",
		mutate(workspace): string {
			const link = path.join(workspace.root, "catalog-link");
			fs.symlinkSync(workspace.directory, link, "dir");
			return link;
		},
	},
	{
		label: "absolute non-directory catalog path",
		code: "BLUEPRINT_CATALOG_DIRECTORY_INVALID",
		mutate(workspace): string {
			const filename = path.join(workspace.root, "not-a-directory");
			fs.writeFileSync(filename, "regular file\n");
			return filename;
		},
	},
	{
		label: "empty catalog file",
		code: "BLUEPRINT_CATALOG_FILE_UNREADABLE",
		mutate(workspace): void {
			fs.truncateSync(path.join(workspace.directory, "catalog.bin"), 0);
		},
	},
	{
		label: "catalog symlink escaping the root",
		code: "BLUEPRINT_CATALOG_FILE_UNREADABLE",
		mutate(workspace): void {
			const filename = path.join(workspace.directory, "catalog.bin");
			const outside = path.join(workspace.root, "outside-catalog.bin");
			fs.renameSync(filename, outside);
			fs.symlinkSync(outside, filename);
		},
	},
	{
		label: "noncanonical catalog bytes",
		code: "BLUEPRINT_CATALOG_BYTES_NONCANONICAL",
		mutate(workspace): void {
			fs.appendFileSync(path.join(workspace.directory, "catalog.bin"), Buffer.of(0));
		},
	},
	{
		label: "closed catalog schema",
		code: "BLUEPRINT_CATALOG_SCHEMA_INVALID",
		mutate(workspace): void {
			const value = structuredClone(workspace.catalogValue) as CatalogValue & { extra?: boolean };
			value.extra = true;
			writeValue(path.join(workspace.directory, "catalog.bin"), value);
		},
	},
	{
		label: "closed nested catalog-entry schema",
		code: "BLUEPRINT_CATALOG_SCHEMA_INVALID",
		mutate(workspace): void {
			updateCatalog(workspace, (catalog) => {
				(soleEntry(catalog) as CatalogEntry & { extra?: boolean }).extra = true;
			});
		},
	},
	{
		label: "descending entry order before entry reads",
		code: "BLUEPRINT_CATALOG_ORDER_INVALID",
		mutate(workspace): void {
			updateCatalog(workspace, (catalog) => {
				const entry = soleEntry(catalog);
				catalog.entries = [{ ...entry, blueprintDigest: "ff".repeat(32), artifactId: "second.v1" }, entry];
			});
		},
	},
	{
		label: "duplicate artifact identity",
		code: "BLUEPRINT_CATALOG_DUPLICATE_IDENTITY",
		mutate(workspace): void {
			updateCatalog(workspace, (catalog) => {
				const entry = soleEntry(catalog);
				catalog.entries.push({
					...entry,
					artifactId: "second.v1",
					blueprintDigest: "ff".repeat(32),
				});
			});
		},
	},
	{
		label: "duplicate artifact id only",
		code: "BLUEPRINT_CATALOG_DUPLICATE_IDENTITY",
		mutate(workspace): void {
			updateCatalog(workspace, (catalog) => {
				const entry = soleEntry(catalog);
				catalog.entries.push({
					...entry,
					artifactDigest: "00".repeat(32),
					blueprintDigest: "ff".repeat(32),
				});
			});
		},
	},
	{
		label: "duplicate blueprint digest violates strict order first",
		code: "BLUEPRINT_CATALOG_ORDER_INVALID",
		mutate(workspace): void {
			updateCatalog(workspace, (catalog) => {
				const entry = soleEntry(catalog);
				catalog.entries.push({ ...entry, artifactDigest: "00".repeat(32), artifactId: "second.v1" });
			});
		},
	},
	{
		label: "catalog artifact-digest occurrence mismatch",
		code: "BLUEPRINT_ARTIFACT_DIGEST_MISMATCH",
		mutate(workspace): void {
			updateCatalog(workspace, (catalog) => {
				soleEntry(catalog).artifactDigest = "00".repeat(32);
			});
		},
	},
	{
		label: "catalog lint-digest occurrence mismatch",
		code: "BLUEPRINT_LINT_EVIDENCE_UNBOUND",
		mutate(workspace): void {
			updateCatalog(workspace, (catalog) => {
				soleEntry(catalog).lintEvidenceDigest = "00".repeat(32);
			});
		},
	},
	{
		label: "catalog receipt-digest occurrence mismatch",
		code: "BLUEPRINT_CONFORMANCE_RECEIPT_UNBOUND",
		mutate(workspace): void {
			updateCatalog(workspace, (catalog) => {
				soleEntry(catalog).conformanceReceiptDigest = "00".repeat(32);
			});
		},
	},
	{
		label: "missing derived asset",
		code: "BLUEPRINT_ENTRY_FILE_UNREADABLE",
		mutate(workspace): void {
			fs.rmSync(asset(workspace, "artifact.mjs"));
		},
	},
	{
		label: "symlinked derived asset",
		code: "BLUEPRINT_ENTRY_FILE_UNREADABLE",
		mutate(workspace): void {
			const filename = asset(workspace, "artifact.mjs");
			const outside = path.join(workspace.root, "outside-artifact.mjs");
			fs.renameSync(filename, outside);
			fs.symlinkSync(outside, filename);
		},
	},
	{
		label: "empty derived asset",
		code: "BLUEPRINT_ENTRY_FILE_UNREADABLE",
		mutate(workspace): void {
			fs.truncateSync(asset(workspace, "artifact.mjs"), 0);
		},
	},
	{
		label: "noncanonical package bytes",
		code: "BLUEPRINT_PACKAGE_BYTES_NONCANONICAL",
		mutate(workspace): void {
			fs.appendFileSync(asset(workspace, "package.bin"), Buffer.of(0));
		},
	},
	{
		label: "package digest mismatch",
		code: "BLUEPRINT_PACKAGE_DIGEST_MISMATCH",
		mutate(workspace): void {
			const value = readValue<typeof packageGolden.package>(asset(workspace, "package.bin"));
			value.implementation.artifactId = "different.v1";
			writeValue(asset(workspace, "package.bin"), value);
		},
	},
	{
		label: "closed package schema",
		code: "BLUEPRINT_PACKAGE_SCHEMA_INVALID",
		mutate(workspace): void {
			rekeyPackage(workspace, (value) => {
				(value as typeof value & { extra?: boolean }).extra = true;
			});
		},
	},
	{
		label: "closed nested package implementation schema",
		code: "BLUEPRINT_PACKAGE_SCHEMA_INVALID",
		mutate(workspace): void {
			rekeyPackage(workspace, (value) => {
				(value.implementation as typeof value.implementation & { extra?: boolean }).extra = true;
			});
		},
	},
	{
		label: "artifact import is invalid",
		code: "BLUEPRINT_ARTIFACT_BYTES_INVALID",
		mutate(workspace): void {
			const changed = Buffer.concat([Buffer.from('import "forbidden";\n'), workspace.artifactBytes]);
			replaceArtifact(workspace, changed);
		},
	},
	{
		label: "artifact missing its sole export",
		code: "BLUEPRINT_ARTIFACT_BYTES_INVALID",
		mutate(workspace): void {
			const changed = Buffer.from(
				workspace.artifactBytes.toString("utf8").replace("export const blueprint", "const blueprint")
			);
			replaceArtifact(workspace, changed);
		},
	},
	{
		label: "artifact has an additional export",
		code: "BLUEPRINT_ARTIFACT_BYTES_INVALID",
		mutate(workspace): void {
			const changed = Buffer.concat([workspace.artifactBytes, Buffer.from("export const extra = 1;\n")]);
			replaceArtifact(workspace, changed);
		},
	},
	{
		label: "artifact digest mismatch",
		code: "BLUEPRINT_ARTIFACT_DIGEST_MISMATCH",
		mutate(workspace): void {
			fs.appendFileSync(asset(workspace, "artifact.mjs"), Buffer.from("\n"));
		},
	},
	{
		label: "artifact and package cross-pair",
		code: "BLUEPRINT_ARTIFACT_PACKAGE_CROSS_PAIR",
		mutate(workspace): void {
			const changed = Buffer.from(workspace.artifactBytes.toString("utf8").replace('"counter.v1"', '"counter.v2"'));
			replaceArtifact(workspace, changed);
		},
	},
	{
		label: "unsupported runtime profile",
		code: "BLUEPRINT_RUNTIME_PROFILE_UNSUPPORTED",
		mutate(workspace): void {
			rekeyPackage(
				workspace,
				(value) => {
					value.implementation.runtimeProfile = "future-profile";
				},
				(entry) => {
					entry.runtimeProfile = "future-profile";
				}
			);
		},
	},
	{
		label: "closed lint evidence schema",
		code: "BLUEPRINT_LINT_EVIDENCE_INVALID",
		mutate(workspace): void {
			updateLint(workspace, (value) => {
				value.extra = true;
			});
		},
	},
	{
		label: "closed nested lint-target schema",
		code: "BLUEPRINT_LINT_EVIDENCE_INVALID",
		mutate(workspace): void {
			updateLint(workspace, (value) => {
				const targets = value.targets as Array<Record<string, unknown>>;
				const [target] = targets;
				if (target === undefined) throw new TypeError("test oracle requires a lint target");
				target.extra = true;
			});
		},
	},
	{
		label: "lint artifact SHA occurrence mismatch",
		code: "BLUEPRINT_LINT_EVIDENCE_UNBOUND",
		mutate(workspace): void {
			updateLint(workspace, (value) => {
				value.artifactSha256 = "00".repeat(32);
			});
		},
	},
	{
		label: "lint artifact-target SHA occurrence mismatch",
		code: "BLUEPRINT_LINT_EVIDENCE_UNBOUND",
		mutate(workspace): void {
			updateLint(workspace, (value) => {
				const [target] = value.targets as Array<Record<string, unknown>>;
				if (target === undefined) throw new TypeError("test oracle requires an artifact lint target");
				target.sha256 = "00".repeat(32);
			});
		},
	},
	{
		label: "invalid lint rule literal",
		code: "BLUEPRINT_LINT_EVIDENCE_INVALID",
		mutate(workspace): void {
			updateLint(workspace, (value) => {
				value.ruleId = "drp/other-rule";
			});
		},
	},
	{
		label: "invalid lint result literal",
		code: "BLUEPRINT_LINT_EVIDENCE_INVALID",
		mutate(workspace): void {
			updateLint(workspace, (value) => {
				value.result = "rejected";
			});
		},
	},
	{
		label: "lint evidence cross-pair",
		code: "BLUEPRINT_LINT_EVIDENCE_UNBOUND",
		mutate(workspace): void {
			updateLint(workspace, (value) => {
				value.artifactDigest = "00".repeat(32);
			});
		},
	},
	{
		label: "closed receipt schema",
		code: "BLUEPRINT_CONFORMANCE_RECEIPT_INVALID",
		mutate(workspace): void {
			updateReceipt(workspace, (value) => {
				value.extra = true;
			});
		},
	},
	{
		label: "closed nested receipt accounting schema",
		code: "BLUEPRINT_CONFORMANCE_RECEIPT_INVALID",
		mutate(workspace): void {
			updateReceipt(workspace, (value) => {
				((value.corpusAccounting as Record<string, unknown>).pr as Record<string, unknown>).extra = true;
			});
		},
	},
	{
		label: "closed nested receipt engine schema",
		code: "BLUEPRINT_CONFORMANCE_RECEIPT_INVALID",
		mutate(workspace): void {
			updateReceipt(workspace, (value) => {
				((value.engines as Array<Record<string, unknown>>)[0] as Record<string, unknown>).extra = true;
			});
		},
	},
	{
		label: "closed nested receipt control schema",
		code: "BLUEPRINT_CONFORMANCE_RECEIPT_INVALID",
		mutate(workspace): void {
			updateReceipt(workspace, (value) => {
				((value.controlOutcomes as Record<string, unknown>).thenable as Record<string, unknown>).extra = true;
			});
		},
	},
	{
		label: "receipt cross-pair",
		code: "BLUEPRINT_CONFORMANCE_RECEIPT_UNBOUND",
		mutate(workspace): void {
			updateReceipt(workspace, (value) => {
				value.artifactDigest = "00".repeat(32);
			});
		},
	},
	{
		label: "PR-only receipt",
		code: "BLUEPRINT_CONFORMANCE_TIER_INSUFFICIENT",
		mutate(workspace): void {
			updateReceipt(workspace, (value) => {
				value.executionTier = "pr";
				value.operationOrder = (value.operationOrder as unknown[]).slice(0, 2);
				value.selectedCaseIds = (value.selectedCaseIds as unknown[]).slice(0, 2);
			});
		},
	},
	{
		label: "incomplete engine matrix",
		code: "BLUEPRINT_CONFORMANCE_ENGINE_MATRIX_INCOMPLETE",
		mutate(workspace): void {
			updateReceipt(workspace, (value) => {
				value.engines = (value.engines as unknown[]).slice(0, 3);
			});
		},
	},
	{
		label: "incorrect engine name",
		code: "BLUEPRINT_CONFORMANCE_ENGINE_MATRIX_INCOMPLETE",
		mutate(workspace): void {
			updateReceipt(workspace, (value) => {
				const [engine] = value.engines as Array<Record<string, unknown>>;
				if (engine === undefined) throw new TypeError("test oracle requires an engine");
				engine.name = "electron";
			});
		},
	},
	{
		label: "duplicate engine name",
		code: "BLUEPRINT_CONFORMANCE_ENGINE_MATRIX_INCOMPLETE",
		mutate(workspace): void {
			updateReceipt(workspace, (value) => {
				const engines = value.engines as Array<Record<string, unknown>>;
				if (engines[0] === undefined || engines[1] === undefined) {
					throw new TypeError("test oracle requires two engines");
				}
				engines[1].name = engines[0].name;
			});
		},
	},
	{
		label: "non-passed result",
		code: "BLUEPRINT_CONFORMANCE_RESULT_NOT_PASSED",
		mutate(workspace): void {
			updateReceipt(workspace, (value) => {
				value.result = "rejected";
			});
		},
	},
];

describe("Track P2-d closed verifier taxonomy and precedence RED", () => {
	it.each(OPEN_MUTATIONS)("maps $label to $code", ({ code, label, mutate }) => {
		const workspace = materialize(`mutant-${label.replaceAll(" ", "-")}`);
		const replacement = mutate(workspace);
		expectCode(
			() =>
				api.openTrustedBlueprintCatalog({
					catalogDirectory: typeof replacement === "string" ? replacement : workspace.directory,
				}),
			code,
			[workspace.root, workspace.directory]
		);
	});

	it("maps a genuine admission-preparer failure to the closed package-schema code", () => {
		const workspace = materialize("genuine-admission-failure");
		preparationProbe.admissionFailure = true;
		expectCode(
			() => api.openTrustedBlueprintCatalog({ catalogDirectory: workspace.directory }),
			"BLUEPRINT_PACKAGE_SCHEMA_INVALID",
			[workspace.root, workspace.directory]
		);
		expect(preparationProbe.admissionInputs).toHaveLength(1);
		expect(preparationProbe.runtimeInputs).toEqual([]);
	});

	it.each(["", "A".repeat(64), "0".repeat(63), ` ${"0".repeat(64)}`])(
		"rejects malformed resolve request %j before lookup",
		(request) => {
			const workspace = materialize("request-malformed");
			const handle = api.openTrustedBlueprintCatalog({ catalogDirectory: workspace.directory });
			expectCode(() => handle.resolve(request), "BLUEPRINT_REQUEST_MALFORMED");
		}
	);

	it.each([undefined, null, 7, {}, []])(
		"maps malformed JavaScript open options %j into the public taxonomy",
		(options) => {
			expectCode(
				() => api.openTrustedBlueprintCatalog(options as { readonly catalogDirectory: string }),
				"BLUEPRINT_CATALOG_DIRECTORY_INVALID"
			);
		}
	);

	it.each([undefined, null, 7, {}, []])(
		"maps malformed JavaScript resolve input %j into the public taxonomy",
		(request) => {
			const workspace = materialize("request-non-string");
			const handle = api.openTrustedBlueprintCatalog({ catalogDirectory: workspace.directory });
			expectCode(() => handle.resolve(request as string), "BLUEPRINT_REQUEST_MALFORMED");
		}
	);

	it("distinguishes a valid absent digest from malformed requests", () => {
		const workspace = materialize("not-catalogued");
		const handle = api.openTrustedBlueprintCatalog({ catalogDirectory: workspace.directory });
		expectCode(() => handle.resolve("00".repeat(32)), "BLUEPRINT_NOT_CATALOGUED");
	});

	it("uses semantic taxonomy precedence before later entry faults", () => {
		const workspace = materialize("precedence");
		fs.rmSync(asset(workspace, "artifact.mjs"));
		fs.appendFileSync(path.join(workspace.directory, "catalog.bin"), Buffer.of(0));
		expectCode(
			() => api.openTrustedBlueprintCatalog({ catalogDirectory: workspace.directory }),
			"BLUEPRINT_CATALOG_BYTES_NONCANONICAL"
		);
	});
});

describe("Track P2-d private catalog construction and verify CLI RED", () => {
	function bundle(label: string): { readonly bundle: string; readonly output: string; readonly root: string } {
		const value = fixture();
		const root = temporaryRoot(`bundle-${label}`);
		const bundleDirectory = path.join(root, "bundle");
		fs.mkdirSync(bundleDirectory);
		fs.writeFileSync(path.join(bundleDirectory, "artifact.mjs"), value.artifactBytes);
		fs.writeFileSync(path.join(bundleDirectory, "package.bin"), value.packageBytes);
		fs.writeFileSync(path.join(bundleDirectory, "lint.bin"), value.lintBytes);
		fs.writeFileSync(path.join(bundleDirectory, "receipt.bin"), value.receiptBytes);
		return { bundle: bundleDirectory, output: path.join(root, "catalog"), root };
	}

	it("constructs the exact flat digest-derived catalog atomically from four detached bundle products", async () => {
		const value = fixture();
		const workspace = bundle("exact");
		await expect(
			runBlueprintCli(["catalog", "--directory", workspace.output, "--bundle", workspace.bundle])
		).resolves.toBeUndefined();
		expect(fs.readdirSync(workspace.output).sort()).toEqual(
			[
				`${value.blueprintDigest}.artifact.mjs`,
				`${value.blueprintDigest}.lint.bin`,
				`${value.blueprintDigest}.package.bin`,
				`${value.blueprintDigest}.receipt.bin`,
				"catalog.bin",
			].sort()
		);
		expect(fs.readFileSync(path.join(workspace.output, "catalog.bin"))).toEqual(value.catalogBytes);
		for (const [suffix, bytes] of [
			["artifact.mjs", value.artifactBytes],
			["package.bin", value.packageBytes],
			["lint.bin", value.lintBytes],
			["receipt.bin", value.receiptBytes],
		] as const) {
			const filename = path.join(workspace.output, `${value.blueprintDigest}.${suffix}`);
			const stat = fs.lstatSync(filename);
			expect(stat.isFile()).toBe(true);
			expect(stat.isSymbolicLink()).toBe(false);
			expect(fs.readFileSync(filename)).toEqual(bytes);
		}
		const catalogStat = fs.lstatSync(path.join(workspace.output, "catalog.bin"));
		expect(catalogStat.isFile()).toBe(true);
		expect(catalogStat.isSymbolicLink()).toBe(false);
		fs.rmSync(workspace.bundle, { force: true, recursive: true });
		const handle = api.openTrustedBlueprintCatalog({ catalogDirectory: workspace.output });
		expect(handle.resolve(value.blueprintDigest).exactArtifactBytes).toEqual(value.artifactBytes);
	});

	it("verify is exactly synchronous open plus resolve for one digest", async () => {
		const value = fixture();
		const workspace = materialize("verify-cli", value);
		await expect(
			runBlueprintCli(["verify", "--directory", workspace.directory, "--blueprint-digest", value.blueprintDigest])
		).resolves.toBeUndefined();
		expect(preparationProbe.admissionInputs).toHaveLength(1);
		expect(preparationProbe.runtimeInputs).toEqual([]);
	});

	it.each([
		["missing bundle", ["catalog", "--directory", "/tmp/catalog"]],
		["unknown flag", ["catalog", "--directory", "/tmp/catalog", "--bundle", "/tmp/bundle", "--unknown", "x"]],
		["duplicate scalar flag", ["catalog", "--directory", "/tmp/a", "--directory", "/tmp/b", "--bundle", "/tmp/c"]],
		["malformed verify", ["verify", "--directory", "/tmp/catalog"]],
	] as const)("rejects %s CLI grammar before creating output", async (_label, arguments_) => {
		await expect(runBlueprintCli([...arguments_])).rejects.toThrow();
	});

	it("rejects repeated resolved bundle directories and leaves no stage or partial output", async () => {
		const workspace = bundle("duplicate");
		await expect(
			runBlueprintCli([
				"catalog",
				"--directory",
				workspace.output,
				"--bundle",
				workspace.bundle,
				"--bundle",
				path.join(workspace.bundle, "."),
			])
		).rejects.toThrow();
		expect(fs.existsSync(workspace.output)).toBe(false);
		expect(fs.readdirSync(workspace.root).sort()).toEqual(["bundle"]);
	});

	it("rejects a nonempty destination before bundle reads and preserves its bytes", async () => {
		const workspace = bundle("nonempty");
		fs.mkdirSync(workspace.output);
		fs.writeFileSync(path.join(workspace.output, "owned.txt"), "preserve\n");
		const read = vi.spyOn(fs, "readFileSync");
		await expect(
			runBlueprintCli(["catalog", "--directory", workspace.output, "--bundle", workspace.bundle])
		).rejects.toThrow();
		expect(fs.readdirSync(workspace.output)).toEqual(["owned.txt"]);
		expect(fs.readFileSync(path.join(workspace.output, "owned.txt"), "utf8")).toBe("preserve\n");
		expect(
			read.mock.calls.some(([filename]) => typeof filename === "string" && filename.startsWith(workspace.bundle))
		).toBe(false);
	});

	it("rejects PR evidence and cross-paired assets without leaving an admissible directory", async () => {
		for (const mutation of ["pr", "cross-pair"] as const) {
			const workspace = bundle(mutation);
			if (mutation === "pr") {
				const receipt = readValue<Record<string, unknown>>(path.join(workspace.bundle, "receipt.bin"));
				receipt.executionTier = "pr";
				writeValue(path.join(workspace.bundle, "receipt.bin"), receipt);
			} else {
				fs.appendFileSync(path.join(workspace.bundle, "artifact.mjs"), Buffer.from("\n"));
			}
			await expect(
				runBlueprintCli(["catalog", "--directory", workspace.output, "--bundle", workspace.bundle])
			).rejects.toThrow();
			expect(fs.existsSync(workspace.output)).toBe(false);
			expect(fs.readdirSync(workspace.root).sort()).toEqual(["bundle"]);
		}
	});

	it("removes the complete same-parent stage when the final directory rename fails", async () => {
		const workspace = bundle("rename-failure");
		const renameSync = fs.renameSync.bind(fs);
		const rename = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
			if (destination === workspace.output) {
				expect(path.dirname(source.toString())).toBe(path.dirname(workspace.output));
				const filenames = fs.readdirSync(source.toString()).sort();
				expect(filenames).toEqual(
					[
						`${fixture().blueprintDigest}.artifact.mjs`,
						`${fixture().blueprintDigest}.lint.bin`,
						`${fixture().blueprintDigest}.package.bin`,
						`${fixture().blueprintDigest}.receipt.bin`,
						"catalog.bin",
					].sort()
				);
				for (const filename of filenames) {
					const stat = fs.lstatSync(path.join(source.toString(), filename));
					expect(stat.isFile()).toBe(true);
					expect(stat.isSymbolicLink()).toBe(false);
				}
				throw new Error("synthetic final rename failure");
			}
			return renameSync(source, destination);
		});
		await expect(
			runBlueprintCli(["catalog", "--directory", workspace.output, "--bundle", workspace.bundle])
		).rejects.toThrow("synthetic final rename failure");
		expect(rename).toHaveBeenCalled();
		expect(fs.existsSync(workspace.output)).toBe(false);
		expect(fs.readdirSync(workspace.root).sort()).toEqual(["bundle"]);
	});
});

describe("Track P2-d public/package/governance and preservation controls", () => {
	it("publishes exactly the closed Blueprint additions in alphabetized registry order", () => {
		expect(DRP_ERROR_CODES.filter((code) => code.startsWith("BLUEPRINT_"))).toEqual([...CATALOG_ERROR_CODES].sort());
		expect([...DRP_ERROR_CODES]).toEqual([...DRP_ERROR_CODES].sort());
		expect(new Set(DRP_ERROR_CODES).size).toBe(DRP_ERROR_CODES.length);
	});

	it("keeps the catalog at its package root with only the frozen runtime dependencies", () => {
		expect(Object.keys(catalogManifest.exports)).toEqual(["."]);
		expect(catalogManifest.dependencies).toEqual({
			"@ts-drp/canonical": "0.11.0",
			"@ts-drp/errors": "0.11.0",
			"@ts-drp/protocol-v3": "0.11.0",
			"es-module-lexer": "1.6.0",
		});
		expect(catalogManifest.version).toBe("0.11.0");
	});

	it("pins the exact checked-in fixture provenance without modifying P2-a/b/c assets", () => {
		expect(sha256(fs.readFileSync(ARTIFACT))).toBe(fixtureMetadata.artifactSha256);
		expect(sha256(fs.readFileSync(SOURCE))).toBe(fixtureMetadata.sourceSha256);
		expect(sha256(fs.readFileSync(AUTHORING))).toBe(fixtureMetadata.authoringSha256);
		expect(sha256(fs.readFileSync(RUNNER))).toBe(fixtureMetadata.runnerSha256);
		expect(domainHex("ts-drp/blueprint-artifact/v3", fs.readFileSync(ARTIFACT))).toBe(fixtureMetadata.artifactDigest);
		expect(domainHex("ts-drp/blueprint-admission/v3", canonicalBytes(packageGolden.package))).toBe(
			fixtureMetadata.blueprintDigest
		);
	});

	it("defines a non-hollow exact synthetic fixture with four distinct digest domains", () => {
		const value = fixture();
		const receipt = decodeCanonical(value.receiptBytes) as { conformanceDigest: string; corpusDigest: string };
		expect(receipt.corpusDigest).toBe(fixtureMetadata.corpusDigest);
		expect(receipt.conformanceDigest).toBe(fixtureMetadata.conformanceDigest);
		expect(value.lintBytes.byteLength).toBe(fixtureMetadata.lintByteLength);
		expect(sha256(value.lintBytes)).toBe(fixtureMetadata.lintSha256);
		expect(value.lintEvidenceDigest).toBe(fixtureMetadata.lintEvidenceDigest);
		expect(value.receiptBytes.byteLength).toBe(fixtureMetadata.receiptByteLength);
		expect(sha256(value.receiptBytes)).toBe(fixtureMetadata.receiptSha256);
		expect(value.receiptDigest).toBe(fixtureMetadata.conformanceReceiptDigest);
		expect(value.catalogBytes.byteLength).toBe(fixtureMetadata.catalogByteLength);
		expect(sha256(value.catalogBytes)).toBe(fixtureMetadata.catalogSha256);
		expect(value.catalogDigest).toBe(fixtureMetadata.catalogDigest);
		expect(
			new Set([
				value.blueprintDigest,
				fixtureMetadata.artifactDigest,
				value.lintEvidenceDigest,
				value.receiptDigest,
				value.catalogDigest,
			]).size
		).toBe(5);
		expect(value.catalogBytes).toEqual(canonicalBytes(value.catalogValue));
		expect(value.catalogValue.entries.map(({ blueprintDigest }) => blueprintDigest)).toEqual(
			[value.blueprintDigest].sort()
		);
		expect(sha256(value.packageBytes)).toBe(packageGolden.packageSha256);
	});

	it("requires module-evaluation lexer initialization and forbids runtime authority in catalog source", () => {
		const source = fs.readFileSync(path.join(REPOSITORY_ROOT, "packages/blueprint-catalog/src/index.ts"), "utf8");
		// This test graph evaluates the catalog twice by design: once from the
		// direct source import above and once through the private toolchain's
		// published package-root dependency. Each independent catalog module
		// identity must initialize its exact lexer during module evaluation.
		expect(lexerInitializationCallsAtModuleEvaluation).toBe(2);
		expect(lexerProbe.initSyncCalls).toBe(lexerInitializationCallsAtModuleEvaluation);
		expect(source).not.toContain("prepareBlueprintRuntime");
		expect(source).not.toMatch(/\bimport\s*\(/u);
	});

	it("exports exactly the normative resolver root and no schema constant or runtime authority", () => {
		expect(Object.keys(catalogNamespace).sort()).toEqual(["BlueprintCatalogError", "openTrustedBlueprintCatalog"]);
	});
});
