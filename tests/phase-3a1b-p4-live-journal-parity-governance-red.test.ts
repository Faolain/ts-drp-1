import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

import { assertSharedDecisionAnalyzerCases } from "./fixtures/phase-3a1b-p4/analyzer-cases/shared-decision-analyzer-cases.js";
import {
	BROWSER_DEATH_TUPLES,
	BROWSER_SCHEMA,
	NO_WRITE_DEATH_TUPLES,
	NODE_DEATH_TUPLES,
	NODE_SCHEMA,
	NODE_SQLITE_CATALOG,
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
	P4_NODE_SQLITE_CATALOG,
} from "../packages/storage-node/tests/fixtures/phase-3a1b-p4-node-contract.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const temporaryDirectories: string[] = [];
const EXACT_EXPORT = Object.freeze({
	import: "./dist/src/live-journal.js",
	types: "./dist/src/live-journal.d.ts",
});
const SHARED_RUNTIME_EXPORTS = Object.freeze([
	"LIVE_JOURNAL_DOMAINS",
	"LIVE_JOURNAL_FAILURE_KINDS",
	"captureLiveJournalInput",
	"classifyLiveJournalMutationObservation",
	"decideLiveJournalDuplicate",
	"deriveLiveJournalSnapshot",
]);
const SHARED_DECLARATION_EXPORTS = Object.freeze([
	"AppendAcceptedVertexInput",
	"AppendAcceptedVertexResult",
	"DurableLiveJournalStore",
	"InstallLiveJournalGenesisInput",
	"InstallLiveJournalGenesisResult",
	"LIVE_JOURNAL_DOMAINS",
	"LIVE_JOURNAL_FAILURE_KINDS",
	"LiveJournalAcceptedRow",
	"LiveJournalFailureKind",
	"LiveJournalPageInput",
	"LiveJournalPageResult",
	"LiveJournalReadinessInput",
	"LiveJournalReadinessResult",
	"LiveJournalScope",
	"LiveJournalSnapshotToken",
	"captureLiveJournalInput",
	"classifyLiveJournalMutationObservation",
	"decideLiveJournalDuplicate",
	"deriveLiveJournalSnapshot",
]);
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

function adapterViolations(
	manifest: AdapterManifest,
	expectedDependencies: readonly string[],
	expectedExports: readonly string[] = [".", "./issuance", "./live-journal"]
): readonly string[] {
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
	if (JSON.stringify(Object.keys(exportsMap).sort()) !== JSON.stringify([...expectedExports].sort())) {
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

function resolvedExportNames(filename: string): readonly string[] {
	const program = ts.createProgram([filename], {
		allowJs: true,
		module: ts.ModuleKind.NodeNext,
		moduleResolution: ts.ModuleResolutionKind.NodeNext,
		noEmit: true,
		skipLibCheck: true,
		target: ts.ScriptTarget.ES2022,
	});
	const source = program.getSourceFile(filename);
	if (source === undefined) throw new Error(`${filename}: source was not loaded`);
	const symbol = program.getTypeChecker().getSymbolAtLocation(source);
	if (symbol === undefined) throw new Error(`${filename}: module symbol was not resolved`);
	return Object.freeze(
		program
			.getTypeChecker()
			.getExportsOfModule(symbol)
			.map(({ name }) => name)
			.sort()
	);
}

function addressedObservationFixture(sourceKind: "local-issued" | "received" = "received"): Readonly<{
	readonly actual: Readonly<Record<string, unknown>>;
	readonly before: Readonly<Record<string, unknown>>;
	readonly row: Readonly<Record<string, unknown>>;
	readonly scope: Readonly<Record<string, unknown>>;
	readonly target: Readonly<Record<string, unknown>>;
}> {
	const identity = Object.freeze({
		anchorDigest: "a".repeat(64),
		epoch: 0,
		objectId: `creator:${"1".repeat(32)}`,
	});
	const storedScope = Object.freeze({
		detachedAnchorSignature: new Uint8Array(64).fill(2),
		exactCanonicalAnchorPreimageBytes: new Uint8Array([1, 2, 3]),
		exactCanonicalParametersCarrierBytes: new Uint8Array([4, 5, 6]),
		nextJournalSequence: 0,
		parametersDigest: "b".repeat(64),
		scope: identity,
	});
	const row = Object.freeze(
		sourceKind === "received"
			? {
					detachedSignature: new Uint8Array(64).fill(3),
					exactCanonicalPreimageBytes: new Uint8Array([7, 8, 9]),
					journalSequence: 0,
					scope: identity,
					sourceKind,
					vertexDigest: "c".repeat(64),
				}
			: {
					author: "creator",
					authorSequence: 0,
					journalSequence: 0,
					scope: identity,
					sourceKind,
					vertexDigest: "c".repeat(64),
				}
	);
	const before = Object.freeze({ kind: "append-addressed", row: null, scope: storedScope });
	const actual = Object.freeze({
		kind: "append-addressed",
		row,
		scope: Object.freeze({ ...storedScope, nextJournalSequence: 1 }),
	});
	return Object.freeze({ actual, before, row, scope: storedScope, target: Object.freeze({ kind: "append", row }) });
}

function strictRecordMutants(
	record: Readonly<Record<string, unknown>>,
	accessorKey: string
): readonly Readonly<Record<string, unknown>>[] {
	return [
		Object.assign(Object.create(null) as Record<string, unknown>, record),
		Object.assign(Object.create({ testOwnedHostilePrototype: true }) as Record<string, unknown>, record),
		{ ...record, testOwnedExtraStringKey: true },
		{ ...record, [Symbol("test-owned-extra")]: true },
		Object.defineProperty({ ...record }, accessorKey, {
			enumerable: true,
			get: () => record[accessorKey],
		}),
		new Proxy(
			{ ...record },
			{
				ownKeys(): never {
					throw new Error("test-owned hostile nested ownKeys trap");
				},
			}
		),
		new Proxy(
			{ ...record },
			{
				getOwnPropertyDescriptor(): never {
					throw new Error("test-owned hostile nested descriptor trap");
				},
			}
		),
	];
}

describe("D.93.34 p4-d parity and governance RED", () => {
	it("binds both adapter schemas and complete death registries to the shared contract owner", () => {
		expect(P4_NODE_SCHEMA).toEqual(NODE_SCHEMA);
		expect(P4_NODE_SQLITE_CATALOG).toEqual(NODE_SQLITE_CATALOG);
		expect(P4_BROWSER_SCHEMA).toEqual(BROWSER_SCHEMA);
		expect(P4_NODE_DEATH_TUPLES).toEqual(NODE_DEATH_TUPLES);
		expect(P4_BROWSER_DEATH_TUPLES).toEqual(BROWSER_DEATH_TUPLES);
		expect(P4_NODE_NO_WRITE_DEATH_TUPLES).toEqual(NO_WRITE_DEATH_TUPLES);
		expect(P4_BROWSER_NO_WRITE_DEATH_TUPLES).toEqual(NO_WRITE_DEATH_TUPLES);
	});

	it("transitions only the two adapter manifests to exact additive exports and dependencies", () => {
		const node = json("packages/storage-node/package.json") as AdapterManifest;
		const browser = json("packages/storage-browser/package.json") as AdapterManifest;
		expect(
			adapterViolations(
				node,
				["@ts-drp/compaction", "@ts-drp/issuance-store", "@ts-drp/live-journal", "@ts-drp/storage"],
				[".", "./issuance", "./issuance-maintenance", "./live-journal", "./maintenance", "./snapshot-transfer"]
			)
		).toEqual([]);
		expect(
			adapterViolations(
				browser,
				[
					"@ts-drp/canonical",
					"@ts-drp/compaction",
					"@ts-drp/issuance-store",
					"@ts-drp/live-journal",
					"@ts-drp/seal",
					"@ts-drp/storage",
				],
				[
					".",
					"./issuance",
					"./issuance-maintenance",
					"./live-journal",
					"./maintenance",
					"./seal-evidence",
					"./seal-vote",
					"./snapshot-transfer",
				]
			)
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
		const journalRoot = await import("@ts-drp/live-journal");
		expect(Object.keys(journalRoot).sort()).toEqual([...SHARED_RUNTIME_EXPORTS].sort());
	});

	it("pins the exact explicit source and emitted declaration surfaces without backend or factory authority", () => {
		const sourcePath = path.join(ROOT, "packages/live-journal/src/index.ts");
		const declarationPath = path.join(ROOT, "packages/live-journal/dist/src/index.d.ts");
		const source = fs.readFileSync(sourcePath, "utf8");
		const declaration = fs.readFileSync(declarationPath, "utf8");
		expect(resolvedExportNames(sourcePath)).toEqual([...SHARED_DECLARATION_EXPORTS].sort());
		expect(resolvedExportNames(declarationPath)).toEqual([...SHARED_DECLARATION_EXPORTS].sort());
		for (const text of [source, declaration]) {
			expect(text).not.toMatch(/\b(?:LiveJournalBackend|createDurableLiveJournalStore)\b/u);
		}
		expect(sha256("packages/live-journal/dist/src/contract.d.ts")).toBe(
			"5faa4b32eb79e64aecf4d03a57dd366060714432c9f2086e4a1b5eed96441ec5"
		);
	});

	it("classifies the closed append-addressed observation matrix through the sole shared runtime owner", async () => {
		const runtime = await import("@ts-drp/live-journal");
		const classify = runtime.classifyLiveJournalMutationObservation as unknown as (
			input: Readonly<Record<string, unknown>>
		) => "exact-new" | "exact-old" | "mixed" | "unreadable";
		const fixture = addressedObservationFixture();
		const classifyWith = (input: Readonly<Record<string, unknown>>): string => classify(input);

		expect(classifyWith({ actual: fixture.actual, before: fixture.before, target: fixture.target })).toBe("exact-new");
		expect(classifyWith({ actual: undefined, before: fixture.before, target: fixture.target })).toBe("unreadable");
		expect(classifyWith({ actual: fixture.before, before: fixture.before, target: fixture.target })).toBe("exact-old");
		const localFixture = addressedObservationFixture("local-issued");
		expect(
			classifyWith({ actual: localFixture.actual, before: localFixture.before, target: localFixture.target })
		).toBe("exact-new");
		expect(
			classifyWith({ actual: localFixture.before, before: localFixture.before, target: localFixture.target })
		).toBe("exact-old");
		const localIdentity = localFixture.scope.scope as Readonly<Record<string, unknown>>;
		const localActuals = [
			{ rows: [localFixture.row], scope: localFixture.actual.scope },
			{ ...localFixture.actual, extra: true },
			{ ...localFixture.actual, row: null },
			{ ...localFixture.actual, row: { ...localFixture.row, author: "other" } },
			{ ...localFixture.actual, row: { ...localFixture.row, authorSequence: 1 } },
			{ ...localFixture.actual, row: { ...localFixture.row, vertexDigest: "d".repeat(64) } },
			{ ...localFixture.actual, row: { ...localFixture.row, journalSequence: 1 } },
			{ ...localFixture.actual, row: { ...localFixture.row, sourceKind: "received" } },
			{
				...localFixture.actual,
				row: { ...localFixture.row, scope: { ...localIdentity, objectId: `creator:${"5".repeat(32)}` } },
			},
			{ ...localFixture.actual, row: { ...localFixture.row, extra: true } },
			Object.assign(Object.create(null) as Record<string, unknown>, localFixture.actual),
			Object.defineProperty({ ...localFixture.actual }, "row", {
				enumerable: true,
				get: () => localFixture.row,
			}),
		];
		expect(
			localActuals.map((actual) => classifyWith({ actual, before: localFixture.before, target: localFixture.target }))
		).toEqual(Array(localActuals.length).fill("mixed"));
		const localTargets = [
			undefined,
			null,
			{ row: localFixture.row },
			{ ...localFixture.target, kind: "install" },
			{ ...localFixture.target, extra: true },
			{ ...localFixture.target, row: { ...localFixture.row, author: "other" } },
			{ ...localFixture.target, row: { ...localFixture.row, authorSequence: 1 } },
			{ ...localFixture.target, row: { ...localFixture.row, vertexDigest: "d".repeat(64) } },
			{ ...localFixture.target, row: { ...localFixture.row, journalSequence: 1 } },
			{ ...localFixture.target, row: { ...localFixture.row, sourceKind: "received" } },
			{
				...localFixture.target,
				row: { ...localFixture.row, scope: { ...localIdentity, anchorDigest: "e".repeat(64) } },
			},
			{ ...localFixture.target, row: { ...localFixture.row, extra: true } },
		];
		expect(
			localTargets.map((target) => classifyWith({ actual: localFixture.actual, before: localFixture.before, target }))
		).toEqual(Array(localTargets.length).fill("mixed"));

		for (const current of [fixture, localFixture]) {
			const other = current === fixture ? localFixture : fixture;
			const currentActualScope = current.actual.scope as Readonly<Record<string, unknown>>;
			const currentStoredScope = current.scope as Readonly<Record<string, unknown>>;
			const currentIdentity = current.scope.scope as Readonly<Record<string, unknown>>;
			const currentRow = current.row as Readonly<Record<string, unknown>>;
			expect(classifyWith({ actual: undefined, before: current.before, target: current.target })).toBe("unreadable");
			const semanticActuals: unknown[] = [
				null,
				{ rows: [current.row], scope: currentActualScope },
				{ row: current.row, scope: currentActualScope },
				{ ...current.actual, kind: "append" },
				{ ...current.actual, row: other.row },
				{ kind: "append-addressed", scope: currentActualScope },
				{ ...current.actual, scope: { ...currentActualScope, nextJournalSequence: 0 } },
				{ ...current.actual, scope: { ...currentActualScope, nextJournalSequence: 2 } },
				{
					...current.actual,
					scope: { ...currentActualScope, exactCanonicalAnchorPreimageBytes: new Uint8Array([9, 9, 9]) },
				},
				{
					...current.actual,
					scope: { ...currentActualScope, detachedAnchorSignature: new Uint8Array(64).fill(9) },
				},
				{
					...current.actual,
					scope: { ...currentActualScope, exactCanonicalParametersCarrierBytes: new Uint8Array([6, 5, 4]) },
				},
				{ ...current.actual, scope: { ...currentActualScope, parametersDigest: "d".repeat(64) } },
				{
					...current.actual,
					scope: { ...currentActualScope, scope: { ...currentIdentity, anchorDigest: "e".repeat(64) } },
				},
				{
					...current.actual,
					scope: { ...currentActualScope, scope: { ...currentIdentity, objectId: `creator:${"3".repeat(32)}` } },
				},
				{ ...current.actual, scope: { ...currentActualScope, scope: { ...currentIdentity, epoch: 1 } } },
			];
			const semanticBefores: unknown[] = [
				undefined,
				null,
				{ rows: [], scope: current.scope },
				{ row: null, scope: current.scope },
				{ kind: "append-addressed", row: null },
				{ ...current.before, kind: "append" },
				{ ...current.before, row: current.row },
				{ ...current.before, row: other.row },
				{ ...current.before, scope: { ...current.scope, nextJournalSequence: 1 } },
				{
					...current.before,
					scope: { ...current.scope, exactCanonicalAnchorPreimageBytes: new Uint8Array([9, 9, 9]) },
				},
				{
					...current.before,
					scope: { ...current.scope, detachedAnchorSignature: new Uint8Array(64).fill(9) },
				},
				{
					...current.before,
					scope: { ...current.scope, exactCanonicalParametersCarrierBytes: new Uint8Array([6, 5, 4]) },
				},
				{ ...current.before, scope: { ...current.scope, parametersDigest: "d".repeat(64) } },
				{
					...current.before,
					scope: { ...current.scope, scope: { ...currentIdentity, anchorDigest: "e".repeat(64) } },
				},
				{
					...current.before,
					scope: { ...current.scope, scope: { ...currentIdentity, objectId: `creator:${"4".repeat(32)}` } },
				},
				{ ...current.before, scope: { ...current.scope, scope: { ...currentIdentity, epoch: 1 } } },
			];
			const semanticTargets: unknown[] = [{ ...current.target, row: other.row }];
			if (typeof SharedArrayBuffer !== "undefined") {
				const sharedCopy = (value: unknown): Uint8Array => {
					if (!(value instanceof Uint8Array)) throw new TypeError("test-owned byte evidence is missing");
					const shared = new Uint8Array(new SharedArrayBuffer(value.byteLength));
					shared.set(value);
					return shared;
				};
				for (const field of [
					"detachedAnchorSignature",
					"exactCanonicalAnchorPreimageBytes",
					"exactCanonicalParametersCarrierBytes",
				] as const) {
					semanticActuals.push({
						...current.actual,
						scope: { ...currentActualScope, [field]: sharedCopy(currentActualScope[field]) },
					});
					semanticBefores.push({
						...current.before,
						scope: { ...current.scope, [field]: sharedCopy(currentStoredScope[field]) },
					});
				}
				if (current.row.sourceKind === "received") {
					for (const field of ["detachedSignature", "exactCanonicalPreimageBytes"] as const) {
						semanticActuals.push({
							...current.actual,
							row: { ...current.row, [field]: sharedCopy(currentRow[field]) },
						});
						semanticTargets.push({
							...current.target,
							row: { ...current.row, [field]: sharedCopy(currentRow[field]) },
						});
					}
				}
			}
			expect(
				semanticActuals.map((actual) => classifyWith({ actual, before: current.before, target: current.target }))
			).toEqual(Array(semanticActuals.length).fill("mixed"));
			expect(
				semanticBefores.map((before) => classifyWith({ actual: current.actual, before, target: current.target }))
			).toEqual(Array(semanticBefores.length).fill("mixed"));
			expect(
				semanticTargets.map((target) => classifyWith({ actual: current.actual, before: current.before, target }))
			).toEqual(Array(semanticTargets.length).fill("mixed"));
			const nestedActuals: readonly Readonly<Record<string, unknown>>[] = [
				...strictRecordMutants(current.actual, "row"),
				...strictRecordMutants(current.row, "vertexDigest").map((row) => ({ ...current.actual, row })),
				...strictRecordMutants(currentIdentity, "epoch").map((scope) => ({
					...current.actual,
					row: { ...current.row, scope },
				})),
				{ ...current.actual, row: { ...current.row, scope: { ...currentIdentity, epoch: 1 } } },
				...strictRecordMutants(currentActualScope, "parametersDigest").map((scope) => ({
					...current.actual,
					scope,
				})),
				...strictRecordMutants(currentIdentity, "epoch").map((scopeIdentity) => ({
					...current.actual,
					scope: { ...currentActualScope, scope: scopeIdentity },
				})),
			];
			expect(
				nestedActuals.map((actual) => classifyWith({ actual, before: current.before, target: current.target }))
			).toEqual(Array(nestedActuals.length).fill("mixed"));

			const nestedBefores: readonly Readonly<Record<string, unknown>>[] = [
				...strictRecordMutants(current.before, "row"),
				...strictRecordMutants(current.scope, "parametersDigest").map((scope) => ({
					...current.before,
					scope,
				})),
				...strictRecordMutants(currentIdentity, "epoch").map((scopeIdentity) => ({
					...current.before,
					scope: { ...current.scope, scope: scopeIdentity },
				})),
				{ ...current.before, scope: { ...current.scope, scope: { ...currentIdentity, epoch: 1 } } },
			];
			expect(
				nestedBefores.map((before) => classifyWith({ actual: current.actual, before, target: current.target }))
			).toEqual(Array(nestedBefores.length).fill("mixed"));

			const nestedTargets: readonly Readonly<Record<string, unknown>>[] = [
				...strictRecordMutants(current.target, "row"),
				...strictRecordMutants(current.row, "vertexDigest").map((row) => ({ ...current.target, row })),
				...strictRecordMutants(currentIdentity, "epoch").map((scope) => ({
					...current.target,
					row: { ...current.row, scope },
				})),
				{ ...current.target, row: { ...current.row, scope: { ...currentIdentity, epoch: 1 } } },
			];
			expect(
				nestedTargets.map((target) => classifyWith({ actual: current.actual, before: current.before, target }))
			).toEqual(Array(nestedTargets.length).fill("mixed"));
		}

		const identity = fixture.scope.scope as Readonly<Record<string, unknown>>;
		const mixedActuals: unknown[] = [
			{ ...fixture.actual, row: null },
			{ ...fixture.actual, row: { ...fixture.row, vertexDigest: "d".repeat(64) } },
			{ ...fixture.actual, row: { ...fixture.row, journalSequence: 1 } },
			{ ...fixture.actual, row: { ...fixture.row, sourceKind: "local-issued" } },
			{
				...fixture.actual,
				row: { ...fixture.row, detachedSignature: new Uint8Array(64).fill(8) },
			},
			{
				...fixture.actual,
				row: { ...fixture.row, exactCanonicalPreimageBytes: new Uint8Array([9, 8, 7]) },
			},
			{
				...fixture.actual,
				row: { ...fixture.row, scope: { ...identity, objectId: `creator:${"2".repeat(32)}` } },
			},
			{ ...fixture.actual, row: { ...fixture.row, extra: true } },
		];
		expect(
			mixedActuals.map((actual) => classifyWith({ actual, before: fixture.before, target: fixture.target }))
		).toEqual(Array(mixedActuals.length).fill("mixed"));

		const mixedTargets: readonly unknown[] = [
			undefined,
			null,
			{ row: fixture.row },
			{ ...fixture.target, kind: "install" },
			{ ...fixture.target, extra: true },
			{ ...fixture.target, row: { ...fixture.row, vertexDigest: "d".repeat(64) } },
			{ ...fixture.target, row: { ...fixture.row, journalSequence: 1 } },
			{
				...fixture.target,
				row: { ...fixture.row, detachedSignature: new Uint8Array(64).fill(9) },
			},
			{
				...fixture.target,
				row: { ...fixture.row, exactCanonicalPreimageBytes: new Uint8Array([9, 8, 7]) },
			},
			{
				...fixture.target,
				row: { ...fixture.row, scope: { ...identity, anchorDigest: "e".repeat(64) } },
			},
			{ ...fixture.target, row: { ...fixture.row, extra: true } },
		];
		expect(
			mixedTargets.map((target) => classifyWith({ actual: fixture.actual, before: fixture.before, target }))
		).toEqual(Array(mixedTargets.length).fill("mixed"));
	});

	it("pins both adapter source declarations and built runtime inventories exactly", async () => {
		for (const [packageName, factory, options] of [
			["storage-node", "createNodeDurableLiveJournalStore", "NodeDurableLiveJournalStoreOptions"],
			["storage-browser", "createBrowserDurableLiveJournalStore", "BrowserDurableLiveJournalStoreOptions"],
		] as const) {
			const directory = path.join(ROOT, `packages/${packageName}`);
			expect(resolvedExportNames(path.join(directory, "src/live-journal.ts"))).toEqual([factory, options].sort());
			expect(resolvedExportNames(path.join(directory, "dist/src/live-journal.d.ts"))).toEqual(
				[factory, options].sort()
			);
			const runtime = (await import(pathToFileURL(path.join(directory, "dist/src/live-journal.js")).href)) as Record<
				string,
				unknown
			>;
			expect(Object.keys(runtime).sort()).toEqual([factory]);
			expect(typeof runtime[factory]).toBe("function");
		}
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
			const manifest = json(`packages/${packageName}/package.json`);
			expect(manifest.files).toEqual(
				packageName === "storage-node"
					? ["src", "dist", "!dist/test", "!**/*.tsbuildinfo"]
					: ["src", "dist", "!dist/test", "!dist/tests", "!dist/playwright*", "!**/*.tsbuildinfo"]
			);
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
			expect(files.filter((file) => /(?:phase-3a1b-p4|live-journal-(?:observation|test-control))/u.test(file))).toEqual(
				[]
			);
			const packedTestControls = files
				.filter((file) => /(?:^|\/)(?:tests?|fixtures?)(?:\/|[-.])|test-(?:control|instrumentation)/u.test(file))
				.sort();
			if (packageName === "storage-browser") {
				expect(packedTestControls).toEqual([
					"dist/src/internal/issuance-test-control.d.ts",
					"dist/src/internal/issuance-test-control.d.ts.map",
					"dist/src/internal/issuance-test-control.js",
					"dist/src/internal/seal-vote-test-control.d.ts",
					"dist/src/internal/seal-vote-test-control.d.ts.map",
					"dist/src/internal/seal-vote-test-control.js",
					"src/internal/issuance-test-control.ts",
					"src/internal/seal-vote-test-control.ts",
				]);
			} else {
				expect(packedTestControls).toEqual([
					"dist/src/test-instrumentation.d.ts",
					"dist/src/test-instrumentation.d.ts.map",
					"dist/src/test-instrumentation.js",
					"src/test-instrumentation.ts",
				]);
			}
		}
	});

	it("keeps analyzer-only positive and negative semantic-equivalence fixtures", () => {
		assertSharedDecisionAnalyzerCases();
	});

	it("keeps production free of private p4 observation seams", () => {
		const node = fs.readFileSync(path.join(ROOT, "packages/storage-node/src/live-journal.ts"), "utf8");
		const browser = fs.readFileSync(path.join(ROOT, "packages/storage-browser/src/live-journal.ts"), "utf8");
		for (const source of [node, browser]) {
			expect(source).not.toMatch(/internal\/live-journal-observation|live-journal-(?:observation|test-control)/u);
		}
		for (const packageName of ["storage-node", "storage-browser"] as const) {
			expect(fs.existsSync(path.join(ROOT, `packages/${packageName}/src/internal/live-journal-observation.ts`))).toBe(
				false
			);
			expect(
				fs.existsSync(path.join(ROOT, `packages/${packageName}/dist/src/internal/live-journal-observation.js`))
			).toBe(false);
		}
	});

	it("keeps forbidden subsystem imports out of every p4 production owner", () => {
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
		expect(production).not.toMatch(/@ts-drp\/(?:control-plane|issuance-store|node|network)\b/u);
	});

	it("keeps fast and nightly browser ownership on the exact three configured engines", async () => {
		for (const config of [
			"packages/storage-browser/playwright.phase-3a1b-p4-live-journal.config.ts",
			"packages/storage-browser/playwright.phase-3a1b-p4-live-journal-death.config.ts",
		]) {
			const loaded = (await import(pathToFileURL(path.join(ROOT, config)).href)) as {
				readonly default: { readonly projects?: readonly { readonly name?: string }[] };
			};
			expect(loaded.default.projects?.map(({ name }) => name)).toEqual(["chromium", "firefox", "webkit"]);
		}
	});
});
