import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import phase2hConfig from "../playwright.protocol-v2.config.js";
import {
	aggregatePhase2h,
	consumeCurrentPhase2hAggregate,
	type Phase2hAggregate,
	type Phase2hAggregationInput,
	type Phase2hRawEntry,
	phase2hStructuralEntries,
} from "./fixtures/phase-2h-a-aggregate.js";
import * as phase2hControls from "./fixtures/phase-2h-a-controls.js";
import {
	phase2hControlRecords,
	phase2hRecordEntry,
	PHASE_2H_CONTROL_GIT_SHA,
	PHASE_2H_CONTROL_RUN_ID,
} from "./fixtures/phase-2h-a-controls.js";
import * as phase2hPublication from "./fixtures/phase-2h-a-publication.js";
import {
	type Phase2hRecordExpectation,
	type Phase2hRecordValidation,
	type Phase2hValidationRecord,
	validatePhase2hRecord,
} from "./fixtures/phase-2h-a-record.js";
import {
	type Phase2hEngineName,
	phase2hTuple,
	PHASE_2H_ENGINES,
	PHASE_2H_REQUIRED_TUPLE_IDS,
	PHASE_2H_SCENARIOS,
} from "./fixtures/phase-2h-a-registry.js";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");
const CURRENT_PLAYWRIGHT_VERSION = "1.62.1";
const HISTORICAL_PLAYWRIGHT_VERSION = "1.61.1";
const CONTROL_BROWSER_VERSIONS = Object.freeze({
	chromium: "control-browser-1",
	firefox: "control-browser-1",
	webkit: "control-browser-1",
} as const);
const CURRENT_BROWSER_VERSIONS = Object.freeze({
	chromium: "151.0.7922.34",
	firefox: "153.0",
	webkit: "26.5",
} as const);

interface VersionExpectation extends Phase2hRecordExpectation {
	readonly browserVersions: Readonly<Record<Phase2hEngineName, string>>;
	readonly playwrightVersion: string;
}

interface VersionedAggregationInput extends Phase2hAggregationInput {
	readonly browserVersions: Readonly<Record<Phase2hEngineName, string>>;
	readonly playwrightVersion: string;
}

interface VersionedCurrentInvocation {
	readonly browserVersions: Readonly<Record<Phase2hEngineName, string>>;
	readonly gitSha: string;
	readonly playwrightVersion: string;
	readonly runId: string;
}

interface MutableRecord {
	engine: {
		browserVersion: string;
		playwrightVersion: string;
	};
	tupleId: string;
}

interface GraphInput {
	browserRegistry: {
		browsers: { browserVersion: string; installByDefault: boolean; name: string }[];
		browsersJsonRealpath: string;
		corePackageRealpath: string;
	};
	installedPackageEntries: string[];
	installedVersions: Record<"@playwright/test" | "playwright" | "playwright-core", string[]>;
	lockImporters: Record<string, { devDependencies: Record<string, unknown> }>;
	manifests: Record<string, { devDependencies: Record<string, string> }>;
	resolutionContexts: { callerRealpath: string; packageRealpath: string; version: string }[];
	rootPin: string;
	runtimeVersions: Record<"@playwright/test" | "playwright" | "playwright-core", string>;
}

interface Phase2hInvocationDependencies {
	resolvePlaywrightIdentity(callerRealpath: string): Readonly<{
		browserVersions: Readonly<Record<Phase2hEngineName, string>>;
		playwrightVersion: string;
	}>;
}

interface Phase2kGraphOwner {
	auditPlaywrightGraph(input: unknown): { readonly errors: readonly string[] };
}

type InjectableGlobalSetup = (
	config: unknown,
	dependencies: Phase2hInvocationDependencies
) => Promise<() => Promise<void>>;

type AssertWorkerVersion = (environment: NodeJS.ProcessEnv, observedVersion: string) => void;

afterEach(() => {
	vi.restoreAllMocks();
});

function expectation(record: MutableRecord, playwrightVersion: string): VersionExpectation {
	const tuple = phase2hTuple(record.tupleId);
	if (tuple === undefined) throw new TypeError(`missing Phase 2h tuple ${record.tupleId}`);
	return {
		browserVersions: CONTROL_BROWSER_VERSIONS,
		gitSha: PHASE_2H_CONTROL_GIT_SHA,
		playwrightVersion,
		project: tuple.engine,
		runId: PHASE_2H_CONTROL_RUN_ID,
	};
}

function mutable(record: Phase2hValidationRecord): MutableRecord & Record<string, unknown> {
	return structuredClone(record) as unknown as MutableRecord & Record<string, unknown>;
}

function withPlaywrightVersion(record: Phase2hValidationRecord, playwrightVersion: string): MutableRecord {
	const result = mutable(record);
	result.engine.playwrightVersion = playwrightVersion;
	return result;
}

function validateVersioned(record: MutableRecord, playwrightVersion: string): Phase2hRecordValidation {
	return validatePhase2hRecord(record, expectation(record, playwrightVersion));
}

function entries(records: readonly MutableRecord[]): readonly Phase2hRawEntry[] {
	return [...phase2hStructuralEntries(), ...records.map((record) => phase2hRecordEntry(record))];
}

function aggregate(records: readonly MutableRecord[], playwrightVersion: string): Phase2hAggregate {
	const input: VersionedAggregationInput = {
		browserVersions: CONTROL_BROWSER_VERSIONS,
		entries: entries(records),
		gitSha: PHASE_2H_CONTROL_GIT_SHA,
		playwrightVersion,
		runId: PHASE_2H_CONTROL_RUN_ID,
	};
	return aggregatePhase2h(input);
}

function currentInvocation(playwrightVersion: string): VersionedCurrentInvocation {
	return {
		browserVersions: CONTROL_BROWSER_VERSIONS,
		gitSha: PHASE_2H_CONTROL_GIT_SHA,
		playwrightVersion,
		runId: PHASE_2H_CONTROL_RUN_ID,
	};
}

function currentRecords(): readonly MutableRecord[] {
	return phase2hControlRecords().map((record) => withPlaywrightVersion(record, CURRENT_PLAYWRIGHT_VERSION));
}

function historicalAggregate(): Phase2hAggregate {
	return aggregate(
		phase2hControlRecords().map((record) => mutable(record)),
		HISTORICAL_PLAYWRIGHT_VERSION
	);
}

function rewrittenAggregate(version: string): Phase2hAggregate {
	const historical = historicalAggregate();
	return {
		...historical,
		records: historical.records.map(
			(record) => withPlaywrightVersion(record, version) as unknown as Phase2hValidationRecord
		),
	};
}

function graphInput(version = CURRENT_PLAYWRIGHT_VERSION): GraphInput {
	const graphRoot = "/candidate/node_modules/.pnpm";
	return {
		browserRegistry: {
			browsers: Object.entries(CURRENT_BROWSER_VERSIONS).map(([name, browserVersion]) => ({
				browserVersion,
				installByDefault: true,
				name,
			})),
			browsersJsonRealpath: `${graphRoot}/playwright-core@${version}/node_modules/playwright-core/browsers.json`,
			corePackageRealpath: `${graphRoot}/playwright-core@${version}/node_modules/playwright-core/package.json`,
		},
		installedPackageEntries: [`@playwright+test@${version}`, `playwright@${version}`, `playwright-core@${version}`],
		installedVersions: {
			"@playwright/test": [version],
			"playwright": [version],
			"playwright-core": [version],
		},
		lockImporters: {
			".": { devDependencies: { "@playwright/test": { specifier: version, version } } },
			"packages/storage-browser": { devDependencies: {} },
		},
		manifests: {
			"package.json": { devDependencies: { "@playwright/test": version } },
			"packages/storage-browser/package.json": { devDependencies: {} },
		},
		resolutionContexts: [
			{
				callerRealpath: "/candidate/packages/storage-browser/playwright.protocol-v2.config.ts",
				packageRealpath: `${graphRoot}/@playwright+test@${version}/node_modules/@playwright/test/package.json`,
				version,
			},
			{
				callerRealpath: "/candidate/packages/storage-browser/tests/phase-2h-a-global-setup.ts",
				packageRealpath: `${graphRoot}/@playwright+test@${version}/node_modules/@playwright/test/package.json`,
				version,
			},
		],
		rootPin: version,
		runtimeVersions: { "@playwright/test": version, "playwright": version, "playwright-core": version },
	};
}

async function loadPhase2kGraphOwner(): Promise<Phase2kGraphOwner> {
	const ownerUrl = pathToFileURL(path.join(REPOSITORY_ROOT, "scripts/phase-2k-browser-currency.mjs")).href;
	return (await import(/* @vite-ignore */ ownerUrl)) as Phase2kGraphOwner;
}

const GRAPH_DIVERGENCES = Object.freeze([
	[
		"root manifest",
		(input: GraphInput): void => {
			input.manifests["package.json"].devDependencies["@playwright/test"] = HISTORICAL_PLAYWRIGHT_VERSION;
		},
	],
	[
		"workspace importer manifest",
		(input: GraphInput): void => {
			input.manifests["packages/storage-browser/package.json"].devDependencies["@playwright/test"] =
				HISTORICAL_PLAYWRIGHT_VERSION;
		},
	],
	[
		"root lock importer resolution",
		(input: GraphInput): void => {
			const declaration = input.lockImporters["."].devDependencies["@playwright/test"] as Record<string, string>;
			declaration.version = HISTORICAL_PLAYWRIGHT_VERSION;
		},
	],
	[
		"single installed graph",
		(input: GraphInput): void => {
			input.installedVersions["playwright-core"] = [HISTORICAL_PLAYWRIGHT_VERSION];
		},
	],
	[
		"Phase 2h config realpath context",
		(input: GraphInput): void => {
			input.resolutionContexts[0].version = HISTORICAL_PLAYWRIGHT_VERSION;
		},
	],
	[
		"independently resolved runtime",
		(input: GraphInput): void => {
			input.runtimeVersions.playwright = HISTORICAL_PLAYWRIGHT_VERSION;
		},
	],
	[
		"playwright-core browsers.json graph",
		(input: GraphInput): void => {
			input.browserRegistry.browsersJsonRealpath =
				"/candidate/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/browsers.json";
		},
	],
] as const);

const S4_FROZEN_FILES = Object.freeze({
	"tests/opfs-idb-spike/artifacts/bucket-clear-control.json":
		"2b7be12a9ab4cbf8eca0f4c6b293a83b0ce29a24a9fb9df54dfc2ee21f435786",
	"tests/opfs-idb-spike/artifacts/phase-2d-storage-substrate-decision-link-v1.json":
		"40f0175e5d7a0c4aa9855e61324639b71045ffbcf197c12caf788824c2d8e19c",
	"tests/opfs-idb-spike/artifacts/storage-substrate-decision-v1.json":
		"fc14fcde6aa4032fcb883a967a63b4af0ac522fb9030f120b49d14374c7ea901",
	"tests/opfs-idb-spike/artifacts/storage-substrate-decision-v1.md":
		"f6d33fa230978ef9a6b6dd793262285ee1b0f15099ca8d7411e887f1f7606c4d",
	"tests/opfs-idb-spike/artifacts/strict-idb-capability.json":
		"7f76bb252a3d3f7347c02ea49f418c10a5e26c56dad3f6f510d526b71f21e80f",
	"tests/opfs-idb-spike/artifacts/substrate-measurement.json":
		"68a9a5d91d277ec909ebe1171a3a87c3b4975ee12566c86689f6cae1ed7aff85",
	"tests/opfs-idb-spike/s4-artifact-generator.pw.ts":
		"a78b4458aa7151e780414de96e175916a5b1336359fcd84bce0e4baa3fb28a10",
} as const);

describe("Phase 2h invocation-owned Playwright version requalification RED", () => {
	it("preserves the exact v1 kinds, key shapes, 69 tuples, three engines and six scenarios", () => {
		const record = phase2hControlRecords()[0];
		const aggregateValue = historicalAggregate();
		expect(record?.artifactKind).toBe("ts-drp/ahe-storage-validation-record/v1");
		expect(record?.schemaVersion).toBe(1);
		expect(Object.keys(record ?? {}).sort()).toEqual([
			"artifactKind",
			"device",
			"engine",
			"fullClosureDigest",
			"gitSha",
			"hardKillEvidence",
			"killEdge",
			"killPointId",
			"os",
			"persistenceMode",
			"recoveredHead",
			"runId",
			"scenario",
			"scenarioEvidence",
			"schemaVersion",
			"tupleId",
			"verdict",
			"webLocksMode",
		]);
		expect(Object.keys(record?.engine ?? {}).sort()).toEqual([
			"brand",
			"browserVersion",
			"name",
			"playwrightVersion",
			"userAgent",
		]);
		expect(aggregateValue.artifactKind).toBe("ts-drp/ahe-storage-validation/v1");
		expect(aggregateValue.schemaVersion).toBe(1);
		expect(Object.keys(aggregateValue).sort()).toEqual([
			"artifactKind",
			"duplicateTupleIds",
			"extraTupleIds",
			"gitSha",
			"invalidRecordIds",
			"missingKillPoints",
			"missingTupleIds",
			"records",
			"requiredTupleIds",
			"runId",
			"schemaVersion",
			"verdict",
		]);
		expect(PHASE_2H_REQUIRED_TUPLE_IDS).toHaveLength(69);
		expect(PHASE_2H_ENGINES).toEqual(["chromium", "firefox", "webkit"]);
		expect(PHASE_2H_SCENARIOS).toHaveLength(6);
	});

	it("exports one explicit historical control value instead of an ambient default", () => {
		expect(Reflect.get(phase2hControls, "PHASE_2H_HISTORICAL_PLAYWRIGHT_VERSION")).toBe(HISTORICAL_PLAYWRIGHT_VERSION);
	});

	it.each([
		["current under current", CURRENT_PLAYWRIGHT_VERSION, CURRENT_PLAYWRIGHT_VERSION, true],
		["current under historical", CURRENT_PLAYWRIGHT_VERSION, HISTORICAL_PLAYWRIGHT_VERSION, false],
		["historical under historical", HISTORICAL_PLAYWRIGHT_VERSION, HISTORICAL_PLAYWRIGHT_VERSION, true],
		["historical under current", HISTORICAL_PLAYWRIGHT_VERSION, CURRENT_PLAYWRIGHT_VERSION, false],
	] as const)("binds a record body to the trusted expectation: %s", (_label, bodyVersion, expectedVersion, valid) => {
		const record = withPlaywrightVersion(phase2hControlRecords()[0], bodyVersion);
		const observed = validateVersioned(record, expectedVersion);
		expect(observed.errors).toEqual(valid ? [] : expect.arrayContaining([expect.any(String)]));
		expect(observed.record === null).toBe(!valid);
	});

	it("rejects an absent required expectation instead of consulting a default or ambient install", () => {
		const record = mutable(phase2hControlRecords()[0]);
		const observed = validatePhase2hRecord(record, {
			gitSha: PHASE_2H_CONTROL_GIT_SHA,
			project: "chromium",
			runId: PHASE_2H_CONTROL_RUN_ID,
		});
		expect(observed.record).toBeNull();
		expect(observed.errors).toContain("tooling-identity:playwright-expectation-absent");
	});

	it.each([
		["current candidate", currentRecords(), CURRENT_PLAYWRIGHT_VERSION, "pass"],
		["wrong historical expectation", currentRecords(), HISTORICAL_PLAYWRIGHT_VERSION, "fail"],
		[
			"one mixed historical record",
			currentRecords().map((record, index) =>
				index === 17
					? { ...record, engine: { ...record.engine, playwrightVersion: HISTORICAL_PLAYWRIGHT_VERSION } }
					: record
			),
			CURRENT_PLAYWRIGHT_VERSION,
			"fail",
		],
	] as const)(
		"aggregates a complete cloned 69-record set only at one trusted version: %s",
		(_label, records, version, verdict) => {
			const observed = aggregate(records, version);
			expect(observed.verdict).toBe(verdict);
			if (verdict === "pass") {
				expect(observed.records).toHaveLength(69);
				expect(observed.records.map(({ tupleId }) => tupleId)).toEqual(PHASE_2H_REQUIRED_TUPLE_IDS);
			}
		}
	);

	it("deeply consumes a uniform current aggregate under the current expectation", () => {
		const aggregateValue = rewrittenAggregate(CURRENT_PLAYWRIGHT_VERSION);
		expect(consumeCurrentPhase2hAggregate(aggregateValue, currentInvocation(CURRENT_PLAYWRIGHT_VERSION))).toEqual(
			aggregateValue
		);
	});

	it("rejects a current aggregate under the historical expectation", () => {
		const aggregateValue = rewrittenAggregate(CURRENT_PLAYWRIGHT_VERSION);
		expect(() =>
			consumeCurrentPhase2hAggregate(aggregateValue, currentInvocation(HISTORICAL_PLAYWRIGHT_VERSION))
		).toThrow(/Playwright|tooling|version/iu);
	});

	it("rejects one mixed record during current aggregate consumption", () => {
		const aggregateValue = rewrittenAggregate(CURRENT_PLAYWRIGHT_VERSION);
		const records = [...aggregateValue.records];
		const mixed = mutable(records[9]);
		mixed.engine.playwrightVersion = HISTORICAL_PLAYWRIGHT_VERSION;
		records[9] = mixed as unknown as Phase2hValidationRecord;
		expect(() =>
			consumeCurrentPhase2hAggregate({ ...aggregateValue, records }, currentInvocation(CURRENT_PLAYWRIGHT_VERSION))
		).toThrow(/Playwright|tooling|version/iu);
	});

	it("accepts the exact stable-1.x seven-leg graph agreement", async () => {
		const owner = await loadPhase2kGraphOwner();
		expect(owner.auditPlaywrightGraph(graphInput()).errors).toEqual([]);
	});

	it.each(GRAPH_DIVERGENCES)("rejects one-at-a-time %s divergence", async (_label, mutate) => {
		const owner = await loadPhase2kGraphOwner();
		const input = graphInput();
		mutate(input);
		expect(owner.auditPlaywrightGraph(input).errors.length).toBeGreaterThan(0);
	});

	it.each([
		[
			"range",
			(input: GraphInput): void => {
				input.rootPin = "^1.62.1";
			},
		],
		[
			"duplicate installed version",
			(input: GraphInput): void => {
				input.installedVersions.playwright = [CURRENT_PLAYWRIGHT_VERSION, CURRENT_PLAYWRIGHT_VERSION];
			},
		],
		[
			"duplicate default browser row",
			(input: GraphInput): void => {
				input.browserRegistry.browsers.push({ ...input.browserRegistry.browsers[0] });
			},
		],
	] as const)("rejects non-singleton graph authority: %s", async (_label, mutate) => {
		const owner = await loadPhase2kGraphOwner();
		const input = graphInput();
		mutate(input);
		expect(owner.auditPlaywrightGraph(input).errors.length).toBeGreaterThan(0);
	});

	it("rejects an otherwise exact non-1.x graph", async () => {
		const owner = await loadPhase2kGraphOwner();
		expect(owner.auditPlaywrightGraph(graphInput("2.0.0")).errors.length).toBeGreaterThan(0);
	});

	it("publishes only the exact config-owned Playwright metadata", () => {
		expect(phase2hConfig.metadata).toEqual({ phase2hPlaywrightVersion: CURRENT_PLAYWRIGHT_VERSION });
	});

	it("aborts disagreeing config/setup realpath contexts before every run side effect", async () => {
		vi.resetModules();
		const build = vi.fn(() => Promise.resolve());
		const mkdirSync = vi.fn();
		const mkdtempSync = vi.fn(() => "/tmp/phase-2h-requalification-assets");
		const writeFileSync = vi.fn();
		const rmSync = vi.fn();
		const preparePhase2hRun = vi.fn(() => ({
			aggregatePath: "/tmp/ahe-storage-validation.json",
			gitSha: PHASE_2H_CONTROL_GIT_SHA,
			outputBase: "/tmp",
			runId: PHASE_2H_CONTROL_RUN_ID,
			runRoot: "/tmp/phase-2h-run",
		}));
		const createPhase2hPublisher = vi.fn(() => ({
			census: (): { duplicateIdentities: never[]; invalidIdentities: never[] } => ({
				duplicateIdentities: [],
				invalidIdentities: [],
			}),
			submit: (): "accepted" => "accepted",
		}));
		const startPhase2hParentPublisher = vi.fn(() =>
			Promise.resolve({
				close: (): Promise<void> => Promise.resolve(),
				submissionURLs: {
					chromium: "http://127.0.0.1/1",
					firefox: "http://127.0.0.1/2",
					webkit: "http://127.0.0.1/3",
				},
			})
		);
		vi.doMock("esbuild", () => ({ build }));
		vi.doMock("node:fs", () => ({ default: { mkdirSync, mkdtempSync, rmSync, writeFileSync } }));
		vi.doMock("./fixtures/phase-2h-a-aggregate.js", () => ({
			aggregatePhase2h: vi.fn(() => historicalAggregate()),
			readPhase2hRunEntries: vi.fn(() => ({ directoryEntryOverflow: false, entries: [] })),
		}));
		vi.doMock("./fixtures/phase-2h-a-publication.js", () => ({
			createPhase2hPublisher,
			phase2hGitSha: vi.fn(() => PHASE_2H_CONTROL_GIT_SHA),
			preparePhase2hRun,
			writePhase2hAggregate: vi.fn(),
		}));
		vi.doMock("./fixtures/phase-2h-b-parent-publisher.js", () => ({ startPhase2hParentPublisher }));
		try {
			const setupModule = await import("./phase-2h-a-global-setup.js");
			const setup = setupModule.default as unknown as InjectableGlobalSetup;
			const resolvePlaywrightIdentity = vi.fn(() => ({
				browserVersions: CURRENT_BROWSER_VERSIONS,
				playwrightVersion: HISTORICAL_PLAYWRIGHT_VERSION,
			}));
			await expect(
				setup({ metadata: { phase2hPlaywrightVersion: CURRENT_PLAYWRIGHT_VERSION } }, { resolvePlaywrightIdentity })
			).rejects.toThrow(/context|metadata|Playwright|version/iu);
			expect(resolvePlaywrightIdentity).toHaveBeenCalledTimes(1);
			expect(build).not.toHaveBeenCalled();
			expect(mkdirSync).not.toHaveBeenCalled();
			expect(mkdtempSync).not.toHaveBeenCalled();
			expect(preparePhase2hRun).not.toHaveBeenCalled();
			expect(createPhase2hPublisher).not.toHaveBeenCalled();
			expect(startPhase2hParentPublisher).not.toHaveBeenCalled();
		} finally {
			vi.doUnmock("esbuild");
			vi.doUnmock("node:fs");
			vi.doUnmock("./fixtures/phase-2h-a-aggregate.js");
			vi.doUnmock("./fixtures/phase-2h-a-publication.js");
			vi.doUnmock("./fixtures/phase-2h-b-parent-publisher.js");
			vi.resetModules();
		}
	});

	it.each([
		["matching", CURRENT_PLAYWRIGHT_VERSION, false],
		["absent", undefined, true],
		["malformed", "^1.62.1", true],
		["forged", HISTORICAL_PLAYWRIGHT_VERSION, true],
	] as const)("uses environment only as a mandatory child comparand: %s", (_label, transported, shouldThrow) => {
		const environment: NodeJS.ProcessEnv = {};
		if (transported !== undefined) environment.PHASE_2H_A_PLAYWRIGHT_VERSION = transported;
		const owner = phase2hPublication as typeof phase2hPublication & {
			assertPhase2hWorkerPlaywrightVersion?: AssertWorkerVersion;
		};
		const assertWorkerVersion: AssertWorkerVersion =
			owner.assertPhase2hWorkerPlaywrightVersion ?? ((_environment, _observedVersion): void => undefined);
		if (shouldThrow) {
			expect(() => assertWorkerVersion(environment, CURRENT_PLAYWRIGHT_VERSION)).toThrow(
				/tooling|environment|Playwright|version/iu
			);
		} else {
			expect(assertWorkerVersion(environment, CURRENT_PLAYWRIGHT_VERSION)).toBeUndefined();
		}
	});

	it("attributes browser.version() disagreement to a distinct tooling-identity code", () => {
		const record = mutable(phase2hControlRecords()[0]);
		record.engine.browserVersion = "control-browser-drift";
		const observed = validateVersioned(record, HISTORICAL_PLAYWRIGHT_VERSION);
		expect(observed.errors).toContain("tooling-identity:browser-version");
		expect(observed.record).toBeNull();
	});

	it("exposes no public Playwright identity cast or alternate mint", () => {
		const publicNames = [...Object.keys(phase2hControls), ...Object.keys(phase2hPublication)].filter(
			(name) => /playwright/iu.test(name) && /(cast|mint)/iu.test(name)
		);
		expect(publicNames).toEqual([]);
	});

	it("imports the Phase 2k graph owner without running its CLI even when argv resembles a command", () => {
		const ownerUrl = pathToFileURL(path.join(REPOSITORY_ROOT, "scripts/phase-2k-browser-currency.mjs")).href;
		const probe = spawnSync(
			process.execPath,
			["--input-type=module", "--eval", `process.argv[2] = "release-gate"; await import(${JSON.stringify(ownerUrl)});`],
			{ cwd: REPOSITORY_ROOT, encoding: "utf8", timeout: 10_000 }
		);
		expect({ signal: probe.signal, status: probe.status, stderr: probe.stderr, stdout: probe.stdout }).toEqual({
			signal: null,
			status: 0,
			stderr: "",
			stdout: "",
		});
	});

	it("keeps the historical S4 generator and decision artifacts byte-identical", () => {
		const packageDirectory = path.resolve(import.meta.dirname, "..");
		for (const [relativePath, expected] of Object.entries(S4_FROZEN_FILES)) {
			const observed = createHash("sha256")
				.update(fs.readFileSync(path.join(packageDirectory, relativePath)))
				.digest("hex");
			expect(observed, relativePath).toBe(expected);
		}
	});
});
