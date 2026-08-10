import { expect, test } from "@playwright/test";
import type { ExpectedHead } from "@ts-drp/storage";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { type AssetServer, startAssetServer } from "./fixtures/asset-server.js";
import { aggregatePhase2h, readPhase2hRunEntries } from "./fixtures/phase-2h-a-aggregate.js";
import { phase2hEvidenceImageDigest } from "./fixtures/phase-2h-a-evidence-digest.js";
import type { Phase2hRunLayout } from "./fixtures/phase-2h-a-publication.js";
import {
	type Phase2hPersistenceMode,
	type Phase2hScenarioEvidence,
	type Phase2hValidationRecord,
	type Phase2hWebLocksMode,
	validatePhase2hRecord,
} from "./fixtures/phase-2h-a-record.js";
import { type Phase2hEngineName, PHASE_2H_KILL_TUPLE_IDS, PHASE_2H_TUPLES } from "./fixtures/phase-2h-a-registry.js";

type BrowserSurfaceScenario = "browser-store" | "crypto-digest" | "worker-responsiveness";
type BrowserSurfaceEvidence = Extract<Phase2hScenarioEvidence, { tag: BrowserSurfaceScenario }>;

interface CryptoCustody {
	readonly digestCalls: 1;
	readonly inputBytes: readonly number[];
	readonly realmScope: "Window";
}

interface WorkerCustody {
	readonly acceptedOutputs: readonly Readonly<{
		readonly count: number;
		readonly items: number;
		readonly orderLength: number;
		readonly root: string;
		readonly workerCounter: number;
	}>[];
	readonly readyCount: number;
	readonly repeatedSequenceOracleRoot: string;
	readonly requestBeforeReady: boolean;
	readonly sampleOffsetsMs: readonly number[];
	readonly singleWorkloadOracleRoot: string;
	readonly workerConstructedInsideWindow: boolean;
	readonly workerResultInsideWindow: boolean;
}

interface StoreCustody {
	readonly databaseVersion: 1;
	readonly operationResults: readonly string[];
	readonly productionFactory: true;
	readonly recoveredImage: unknown;
	readonly storeNames: readonly string[];
}

interface Phase2hBBrowserObservation {
	readonly browserStore: Readonly<{
		evidence: Extract<BrowserSurfaceEvidence, { tag: "browser-store" }>;
		fullClosureDigest: string;
		recoveredHead: ExpectedHead;
		store: StoreCustody;
	}>;
	readonly cryptoDigest: Readonly<{
		crypto: CryptoCustody;
		evidence: Extract<BrowserSurfaceEvidence, { tag: "crypto-digest" }>;
	}>;
	readonly persistenceMode: Phase2hPersistenceMode;
	readonly userAgent: string;
	readonly webLocksMode: Phase2hWebLocksMode;
	readonly workerResponsiveness: Readonly<{
		evidence: Extract<BrowserSurfaceEvidence, { tag: "worker-responsiveness" }>;
		worker: WorkerCustody;
	}>;
}

const ENGINE_FACTS = Object.freeze({
	chromium: Object.freeze({ brand: "Playwright Chromium", profile: "Desktop Chrome" }),
	firefox: Object.freeze({ brand: "Playwright Firefox", profile: "Desktop Firefox" }),
	webkit: Object.freeze({ brand: "Playwright WebKit", profile: "Desktop Safari" }),
} as const);
const SURFACE_SCENARIOS = new Set<BrowserSurfaceScenario>(["crypto-digest", "worker-responsiveness", "browser-store"]);
const SURFACE_TUPLE_IDS = Object.freeze(
	PHASE_2H_TUPLES.filter(({ scenario }) => SURFACE_SCENARIOS.has(scenario as BrowserSurfaceScenario)).map(
		({ tupleId }) => tupleId
	)
);
const EXPECTED_DIGEST = "d4c3e8a11256ab82a4fc72560eb4a2b0e87bad820c290dd9b03616de240aa6db";
const OPERATION_SEQUENCE = Object.freeze([
	"beginGeneration",
	"putCachedBlob",
	"promoteReference",
	"completeGeneration",
	"swapHead",
	"close",
	"reopen",
	"recoverActiveGeneration",
]);
const require = createRequire(import.meta.url);
const PLAYWRIGHT_VERSION = String((require("@playwright/test/package.json") as Readonly<{ version: unknown }>).version);

let server: AssetServer;

function compareUtf8(left: string, right: string): number {
	const leftBytes = new TextEncoder().encode(left);
	const rightBytes = new TextEncoder().encode(right);
	const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
	for (let index = 0; index < length; index++) {
		const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return leftBytes.byteLength - rightBytes.byteLength;
}

function currentLayout(): Phase2hRunLayout {
	const packageDirectory = path.resolve(import.meta.dirname, "..");
	const gitSha = process.env.PHASE_2H_A_GIT_SHA;
	const runId = process.env.PHASE_2H_A_RUN_ID;
	if (gitSha === undefined || runId === undefined) throw new TypeError("Phase 2h invocation identity is absent");
	const outputBase = path.join(packageDirectory, "test-results/phase-2h");
	return Object.freeze({
		aggregatePath: path.join(outputBase, "ahe-storage-validation.json"),
		gitSha,
		outputBase,
		runId,
		runRoot: path.join(outputBase, runId),
	});
}

function engineName(value: string): Phase2hEngineName {
	if (value !== "chromium" && value !== "firefox" && value !== "webkit")
		throw new TypeError(`unexpected Phase 2h browser project ${value}`);
	return value;
}

function platform(): "darwin" | "linux" {
	if (process.platform !== "darwin" && process.platform !== "linux")
		throw new TypeError(`unsupported Phase 2h host platform ${process.platform}`);
	return process.platform;
}

function architecture(): "arm64" | "x64" {
	if (process.arch !== "arm64" && process.arch !== "x64")
		throw new TypeError(`unsupported Phase 2h host architecture ${process.arch}`);
	return process.arch;
}

function maxGap(offsets: readonly number[]): number {
	let maximum = 0;
	for (let index = 1; index < offsets.length; index++)
		maximum = Math.max(maximum, (offsets[index] ?? 0) - (offsets[index - 1] ?? 0));
	return maximum;
}

async function submitToParent(
	project: Phase2hEngineName,
	record: Phase2hValidationRecord
): Promise<Readonly<{ owner: string; project: string; status: string; tupleId: string }>> {
	const encoded = process.env.PHASE_2H_A_SUBMISSION_URLS;
	if (encoded === undefined) throw new TypeError("Phase 2h parent submission endpoints are absent");
	const endpoints = JSON.parse(encoded) as Readonly<Record<string, unknown>>;
	if (Object.keys(endpoints).sort().join("\0") !== "chromium\0firefox\0webkit")
		throw new TypeError("Phase 2h parent submission endpoint map is not closed");
	const endpoint = endpoints[project];
	if (typeof endpoint !== "string") throw new TypeError(`Phase 2h ${project} parent endpoint is absent`);
	const url = new URL(endpoint);
	if (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
		throw new TypeError("Phase 2h parent submission endpoint is not loopback-only");
	const response = await fetch(url, {
		body: JSON.stringify({ record }),
		headers: { "content-type": "application/json" },
		method: "POST",
	});
	if (!response.ok) throw new Error(`Phase 2h parent rejected ${record.tupleId}: ${response.status}`);
	return (await response.json()) as Readonly<{
		owner: string;
		project: string;
		status: string;
		tupleId: string;
	}>;
}

function record(
	engine: Phase2hEngineName,
	browserVersion: string,
	observation: Phase2hBBrowserObservation,
	scenario: BrowserSurfaceScenario
): Phase2hValidationRecord {
	const layout = currentLayout();
	const evidence = {
		"browser-store": observation.browserStore.evidence,
		"crypto-digest": observation.cryptoDigest.evidence,
		"worker-responsiveness": observation.workerResponsiveness.evidence,
	}[scenario];
	const storage = scenario === "browser-store";
	return Object.freeze({
		artifactKind: "ts-drp/ahe-storage-validation-record/v1",
		device: Object.freeze({ class: "desktop-playwright", emulated: false, profile: ENGINE_FACTS[engine].profile }),
		engine: Object.freeze({
			brand: ENGINE_FACTS[engine].brand,
			browserVersion,
			name: engine,
			playwrightVersion: PLAYWRIGHT_VERSION as "1.61.1",
			userAgent: observation.userAgent,
		}),
		fullClosureDigest: storage ? observation.browserStore.fullClosureDigest : null,
		gitSha: layout.gitSha,
		hardKillEvidence: null,
		killEdge: null,
		killPointId: null,
		os: Object.freeze({ arch: architecture(), platform: platform(), release: os.release() }),
		persistenceMode: observation.persistenceMode,
		recoveredHead: storage ? observation.browserStore.recoveredHead : null,
		runId: layout.runId,
		scenario,
		scenarioEvidence: evidence,
		schemaVersion: 1,
		tupleId: `${scenario}/${engine}`,
		verdict: "pass",
		webLocksMode: observation.webLocksMode,
	});
}

test.beforeAll(async () => {
	const assetDirectory = process.env.PHASE_2H_A_ASSET_DIR;
	if (assetDirectory === undefined) throw new TypeError("Phase 2h generated asset directory is absent");
	server = await startAssetServer(assetDirectory);
});

test.afterAll(async () => server.close());

test("publishes nine causal browser-surface records while the 60-tuple remainder stays missing", async ({
	browser,
	browserName,
	page,
}) => {
	const engine = engineName(browserName);
	await page.goto(server.issueTransitionURL("phase-2h-b.html"));
	await page.waitForFunction(() => "phase2hBBrowserSurfaces" in globalThis);
	const observation = await page.evaluate(async (): Promise<Phase2hBBrowserObservation> => {
		const harness = Reflect.get(globalThis, "phase2hBBrowserSurfaces") as Readonly<{
			run(): Promise<Phase2hBBrowserObservation>;
		}>;
		return harness.run();
	});

	expect(PLAYWRIGHT_VERSION).toBe("1.61.1");
	expect(observation.cryptoDigest).toEqual({
		crypto: { digestCalls: 1, inputBytes: [...new TextEncoder().encode("browser")], realmScope: "Window" },
		evidence: {
			expectedDigestHex: EXPECTED_DIGEST,
			observedDigestHex: EXPECTED_DIGEST,
			sameRealm: true,
			tag: "crypto-digest",
			vectorId: "sha-256/browser-utf8/v1",
		},
	});

	const worker = observation.workerResponsiveness;
	expect(worker.worker.readyCount).toBe(1);
	expect(worker.worker.requestBeforeReady).toBe(false);
	expect(worker.worker.workerConstructedInsideWindow).toBe(true);
	expect(worker.worker.workerResultInsideWindow).toBe(true);
	expect(worker.worker.sampleOffsetsMs).toHaveLength(worker.evidence.sampleCount);
	expect(worker.worker.sampleOffsetsMs[0]).toBeGreaterThanOrEqual(0);
	expect(maxGap(worker.worker.sampleOffsetsMs)).toBeCloseTo(worker.evidence.maxGapMs, 6);
	expect(worker.evidence.controlBlockMs).toBeGreaterThanOrEqual(200);
	expect(worker.evidence.controlGapMs).toBeGreaterThanOrEqual(150);
	expect(worker.evidence.targetIntervalMs).toBe(5);
	expect(worker.evidence.readyProtocolVersion).toBe(1);
	expect(worker.evidence.windowMs).toBeGreaterThanOrEqual(100);
	expect(worker.evidence.sampleCount).toBeGreaterThanOrEqual(Math.max(20, Math.floor(worker.evidence.windowMs / 25)));
	expect(worker.evidence.maxGapMs).toBeLessThan(50);
	expect(worker.worker.acceptedOutputs).toHaveLength(worker.evidence.repetitionCount);
	for (const output of worker.worker.acceptedOutputs) {
		expect(output).toEqual({
			count: 4_097,
			items: 4_097,
			orderLength: 4_097,
			root: worker.worker.singleWorkloadOracleRoot,
			workerCounter: 4_097,
		});
	}
	expect(worker.evidence.workloadOutputs).toEqual({
		count: 4_097 * worker.evidence.repetitionCount,
		items: 4_097 * worker.evidence.repetitionCount,
		orderLength: 4_097 * worker.evidence.repetitionCount,
		pageCounter: 0,
		pageScope: "Window",
		root: worker.worker.repeatedSequenceOracleRoot,
		workerCounter: 4_097 * worker.evidence.repetitionCount,
		workerScope: "DedicatedWorkerGlobalScope",
	});

	const stored = observation.browserStore;
	expect(stored.store.productionFactory).toBe(true);
	expect(stored.store.databaseVersion).toBe(1);
	expect(stored.store.storeNames).toEqual(["blobs", "generations", "objects", "promotions"]);
	expect(stored.store.operationResults).toEqual(OPERATION_SEQUENCE.map(() => "OK"));
	expect(stored.evidence).toEqual({
		allResults: "OK",
		expectedState: "new",
		operationSequence: OPERATION_SEQUENCE,
		recoveredImageDigest: phase2hEvidenceImageDigest(stored.store.recoveredImage),
		recoveryKind: "active",
		reopened: true,
		tag: "browser-store",
	});
	expect(stored.recoveredHead.kind).toBe("present");
	if (stored.recoveredHead.kind !== "present") throw new TypeError("browser-store recovered no active head");
	expect(stored.fullClosureDigest).toBe(stored.recoveredHead.closureDigest);

	const layout = currentLayout();
	for (const scenario of ["crypto-digest", "worker-responsiveness", "browser-store"] as const) {
		const candidate = record(engine, browser.version(), observation, scenario);
		const validation = validatePhase2hRecord(candidate, {
			gitSha: layout.gitSha,
			project: engine,
			runId: layout.runId,
		});
		expect(validation.errors).toEqual([]);
		expect(validation.record).toBe(candidate);
		expect(await submitToParent(engine, candidate)).toEqual({
			owner: "phase-2h-parent/v1",
			project: engine,
			status: "accepted",
			tupleId: candidate.tupleId,
		});
	}

	const aggregate = aggregatePhase2h({
		...readPhase2hRunEntries(layout.runRoot),
		gitSha: layout.gitSha,
		runId: layout.runId,
	});
	const ownIds = SURFACE_TUPLE_IDS.filter((tupleId) => tupleId.endsWith(`/${engine}`));
	expect(aggregate.records.map(({ tupleId }) => tupleId)).toEqual(expect.arrayContaining(ownIds));
	expect(aggregate.duplicateTupleIds).toEqual([]);
	expect(aggregate.extraTupleIds).toEqual([]);
	expect(aggregate.invalidRecordIds).toEqual([]);
	if (engine === "webkit") {
		const recordIds = aggregate.records.map(({ tupleId }) => tupleId);
		expect(recordIds.filter((tupleId) => SURFACE_TUPLE_IDS.includes(tupleId))).toEqual(SURFACE_TUPLE_IDS);
		expect(aggregate.missingTupleIds.filter((tupleId) => SURFACE_TUPLE_IDS.includes(tupleId))).toEqual([]);
		expect(aggregate.missingKillPoints).toEqual([...PHASE_2H_KILL_TUPLE_IDS].sort(compareUtf8));
		expect(aggregate.missingKillPoints).toHaveLength(54);
		expect(aggregate.verdict).toBe("fail");
	}
});
