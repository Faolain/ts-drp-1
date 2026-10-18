import { expect, type Page, test } from "@playwright/test";
import type { ExpectedHead, StorageCapabilityReport } from "@ts-drp/storage";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type AssetServer, startAssetServer } from "./fixtures/asset-server.js";
import {
	declaredPhase2gObservations,
	derivePhase2gQuotaEdges,
	phase2gQuotaCaseErrors,
	type Phase2gQuotaCaseEvidence,
} from "./fixtures/phase-2g-c-quota-fault-contract.js";
import { aggregatePhase2h, readPhase2hRunEntries } from "./fixtures/phase-2h-a-aggregate.js";
import { phase2hEvidenceImageDigest } from "./fixtures/phase-2h-a-evidence-digest.js";
import { assertPhase2hWorkerPlaywrightVersion, type Phase2hRunLayout } from "./fixtures/phase-2h-a-publication.js";
import {
	phase2hPersistenceMode,
	type Phase2hPersistenceMode,
	type Phase2hValidationRecord,
	type Phase2hWebLocksMode,
	validatePhase2hRecord,
} from "./fixtures/phase-2h-a-record.js";
import { type Phase2hEngineName } from "./fixtures/phase-2h-a-registry.js";
import { phase2hCampaignCheckpointErrors } from "./fixtures/phase-2h-d-composed-campaign.js";
import { resolvePhase2hPlaywrightIdentity } from "./fixtures/phase-2h-playwright-identity.js";

interface CapacityObservation {
	readonly factoryArity: 0;
	readonly persistCalls: number;
	readonly realFactory: boolean;
	readonly report: StorageCapabilityReport;
	readonly reportValidAndFrozen: boolean;
	readonly trapReady: boolean;
}

interface QuotaObservation {
	readonly caseEvidence: Phase2gQuotaCaseEvidence;
	readonly recoveredHead: ExpectedHead;
}

interface Phase2gCapacityHarness {
	run(): Promise<CapacityObservation>;
}

interface Phase2gQuotaHarness {
	runRepresentativeSettlement(): Promise<QuotaObservation>;
}

interface EngineObservation {
	readonly browserVersion: string;
	readonly persistenceMode: Phase2hPersistenceMode;
	readonly userAgent: string;
	readonly webLocksMode: Phase2hWebLocksMode;
}

const ENGINE_FACTS = Object.freeze({
	chromium: Object.freeze({ brand: "Playwright Chromium", profile: "Desktop Chrome" }),
	firefox: Object.freeze({ brand: "Playwright Firefox", profile: "Desktop Firefox" }),
	webkit: Object.freeze({ brand: "Playwright WebKit", profile: "Desktop Safari" }),
} as const);
const ACCEPTED_SURFACE_SCENARIOS = Object.freeze(["crypto-digest", "worker-responsiveness", "browser-store"]);
const REPRESENTATIVE_EDGE_ID = "swap-head-certificate-match/request-05-put-objects/settlement";
const REPRESENTATIVE_EDGE = derivePhase2gQuotaEdges(declaredPhase2gObservations()).find(
	({ id }) => id === REPRESENTATIVE_EDGE_ID
);
if (REPRESENTATIVE_EDGE === undefined) throw new TypeError("Phase 2h-c representative quota edge is absent");

const PLAYWRIGHT_IDENTITY = resolvePhase2hPlaywrightIdentity(fileURLToPath(import.meta.url));
const engineObservations = new Map<Phase2hEngineName, EngineObservation>();
let server: AssetServer;

function currentLayout(): Phase2hRunLayout {
	const packageDirectory = path.resolve(import.meta.dirname, "..");
	const gitSha = process.env.PHASE_2H_A_GIT_SHA;
	const runId = process.env.PHASE_2H_A_RUN_ID;
	if (gitSha === undefined || runId === undefined) throw new TypeError("Phase 2h invocation identity is absent");
	const outputBase = path.join(packageDirectory, "test-results/phase-2h");
	return Object.freeze({
		aggregatePath: path.join(outputBase, "ahe-storage-validation.json"),
		browserVersions: PLAYWRIGHT_IDENTITY.browserVersions,
		gitSha,
		outputBase,
		playwrightVersion: PLAYWRIGHT_IDENTITY.playwrightVersion,
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

function expectAcceptedSurfaceControls(engine: Phase2hEngineName): void {
	const layout = currentLayout();
	const diagnostic = aggregatePhase2h({
		...readPhase2hRunEntries(layout.runRoot),
		browserVersions: layout.browserVersions,
		gitSha: layout.gitSha,
		playwrightVersion: layout.playwrightVersion,
		runId: layout.runId,
	});
	const acceptedIds = diagnostic.records
		.map(({ tupleId }) => tupleId)
		.filter(
			(tupleId) =>
				tupleId.endsWith(`/${engine}`) && !tupleId.startsWith("capacity/") && !tupleId.startsWith("quota-fault/")
		);
	expect(acceptedIds).toEqual(ACCEPTED_SURFACE_SCENARIOS.map((scenario) => `${scenario}/${engine}`));
	expect(diagnostic.duplicateTupleIds).toEqual([]);
	expect(diagnostic.extraTupleIds).toEqual([]);
	expect(diagnostic.invalidRecordIds).toEqual([]);
}

async function capacityProducer(page: Page): Promise<
	| Readonly<{ kind: "absent" }>
	| Readonly<{
			kind: "present";
			userAgent: string;
			value: CapacityObservation;
			webLocksMode: Phase2hWebLocksMode;
	  }>
> {
	return page.evaluate(async () => {
		const harness = Reflect.get(globalThis, "phase2gACapacitySmoke") as Phase2gCapacityHarness | undefined;
		if (typeof harness?.run !== "function") return { kind: "absent" } as const;
		const locks = Reflect.get(navigator, "locks") as unknown as Readonly<Record<string, unknown>> | undefined;
		return {
			kind: "present",
			userAgent: navigator.userAgent,
			value: await harness.run(),
			webLocksMode:
				locks !== undefined && typeof Reflect.get(locks, "request") === "function"
					? ("available-not-used" as const)
					: ("unavailable" as const),
		} as const;
	});
}

async function quotaProducer(
	page: Page
): Promise<Readonly<{ kind: "absent" }> | Readonly<{ kind: "present"; value: QuotaObservation }>> {
	return page.evaluate(async () => {
		const harness = Reflect.get(globalThis, "phase2gCQuotaFaultHarness") as Phase2gQuotaHarness | undefined;
		if (typeof harness?.runRepresentativeSettlement !== "function") return { kind: "absent" } as const;
		return { kind: "present", value: await harness.runRepresentativeSettlement() } as const;
	});
}

async function submitToParent(engine: Phase2hEngineName, record: Phase2hValidationRecord): Promise<void> {
	const encoded = process.env.PHASE_2H_A_SUBMISSION_URLS;
	if (encoded === undefined) throw new TypeError("Phase 2h parent submission endpoints are absent");
	const endpoints = JSON.parse(encoded) as Readonly<Record<string, unknown>>;
	const endpoint = endpoints[engine];
	if (typeof endpoint !== "string") throw new TypeError(`Phase 2h ${engine} project-owned endpoint is absent`);
	const url = new URL(endpoint);
	if (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
		throw new TypeError("Phase 2h parent submission endpoint is not loopback-only");
	const response = await fetch(url, {
		body: JSON.stringify({ record }),
		headers: { "content-type": "application/json" },
		method: "POST",
	});
	if (!response.ok) throw new Error(`Phase 2h parent rejected ${record.tupleId}: ${response.status}`);
	expect(await response.json()).toEqual({
		owner: "phase-2h-parent/v1",
		project: engine,
		status: "accepted",
		tupleId: record.tupleId,
	});
}

function commonRecord(
	engine: Phase2hEngineName,
	observation: EngineObservation
): Pick<
	Phase2hValidationRecord,
	| "artifactKind"
	| "device"
	| "engine"
	| "gitSha"
	| "hardKillEvidence"
	| "killEdge"
	| "killPointId"
	| "os"
	| "persistenceMode"
	| "runId"
	| "schemaVersion"
	| "verdict"
	| "webLocksMode"
> {
	const layout = currentLayout();
	return {
		artifactKind: "ts-drp/ahe-storage-validation-record/v1",
		device: { class: "desktop-playwright", emulated: false, profile: ENGINE_FACTS[engine].profile },
		engine: {
			brand: ENGINE_FACTS[engine].brand,
			browserVersion: observation.browserVersion,
			name: engine,
			playwrightVersion: PLAYWRIGHT_IDENTITY.playwrightVersion,
			userAgent: observation.userAgent,
		},
		gitSha: layout.gitSha,
		hardKillEvidence: null,
		killEdge: null,
		killPointId: null,
		os: { arch: architecture(), platform: platform(), release: os.release() },
		persistenceMode: observation.persistenceMode,
		runId: layout.runId,
		schemaVersion: 1,
		verdict: "pass",
		webLocksMode: observation.webLocksMode,
	};
}

function validateRecord(engine: Phase2hEngineName, record: Phase2hValidationRecord): void {
	const layout = currentLayout();
	const validation = validatePhase2hRecord(record, {
		browserVersions: layout.browserVersions,
		gitSha: layout.gitSha,
		playwrightVersion: layout.playwrightVersion,
		project: engine,
		runId: layout.runId,
	});
	expect(validation.errors).toEqual([]);
	expect(validation.record).toBe(record);
}

test.beforeAll(async () => {
	assertPhase2hWorkerPlaywrightVersion(process.env, PLAYWRIGHT_IDENTITY.playwrightVersion);
	const assetDirectory = process.env.PHASE_2H_A_ASSET_DIR;
	if (assetDirectory === undefined) throw new TypeError("Phase 2h generated asset directory is absent");
	server = await startAssetServer(assetDirectory);
});

test.afterAll(async () => server.close());

test("RED: publishes one complete real capacity report without requesting persistence", async ({
	browser,
	browserName,
	page,
}) => {
	const engine = engineName(browserName);
	expectAcceptedSurfaceControls(engine);
	await page.goto(server.issueTransitionURL("phase-2h-b.html"));
	const result = await capacityProducer(page);
	expect(result.kind, `missing real capacity producer for capacity/${engine}`).toBe("present");
	if (result.kind !== "present") return;

	const capacity = result.value;
	expect(capacity.factoryArity).toBe(0);
	expect(capacity.persistCalls).toBe(0);
	expect(capacity.realFactory).toBe(true);
	expect(capacity.reportValidAndFrozen).toBe(true);
	expect(capacity.trapReady).toBe(true);
	const observed: EngineObservation = Object.freeze({
		browserVersion: browser.version(),
		persistenceMode: phase2hPersistenceMode(capacity.report),
		userAgent: result.userAgent,
		webLocksMode: result.webLocksMode,
	});
	engineObservations.set(engine, observed);
	const prior = aggregatePhase2h({
		...readPhase2hRunEntries(currentLayout().runRoot),
		browserVersions: currentLayout().browserVersions,
		gitSha: currentLayout().gitSha,
		playwrightVersion: currentLayout().playwrightVersion,
		runId: currentLayout().runId,
	});
	for (const record of prior.records.filter(({ tupleId }) => tupleId.endsWith(`/${engine}`)))
		expect(record.persistenceMode).toBe(observed.persistenceMode);
	const record: Phase2hValidationRecord = Object.freeze({
		...commonRecord(engine, observed),
		fullClosureDigest: null,
		recoveredHead: null,
		scenario: "capacity",
		scenarioEvidence: Object.freeze({ report: capacity.report, tag: "capacity" }),
		tupleId: `capacity/${engine}`,
	});
	validateRecord(engine, record);
	await submitToParent(engine, record);
});

test("RED: publishes only the exact trace-derived settlement quota case", async ({ browserName, page }) => {
	const engine = engineName(browserName);
	expectAcceptedSurfaceControls(engine);
	await page.goto(server.issueTransitionURL("phase-2h-b.html"));
	const result = await quotaProducer(page);
	expect(result.kind, `missing real quota producer for quota-fault/${engine}`).toBe("present");
	if (result.kind !== "present") return;

	const common = engineObservations.get(engine);
	if (common === undefined) throw new TypeError(`capacity/${engine} did not establish engine observations first`);
	const quota = result.value;
	expect(phase2gQuotaCaseErrors(REPRESENTATIVE_EDGE, quota.caseEvidence)).toEqual([]);
	expect(quota.caseEvidence.edgeId).toBe(REPRESENTATIVE_EDGE_ID);
	expect(quota.recoveredHead.kind).toBe("present");
	if (quota.recoveredHead.kind !== "present") return;
	const oldImageDigest = phase2hEvidenceImageDigest(quota.caseEvidence.before);
	const newImageDigest = phase2hEvidenceImageDigest(quota.caseEvidence.expectedNew);
	const record: Phase2hValidationRecord = Object.freeze({
		...commonRecord(engine, common),
		fullClosureDigest: quota.recoveredHead.closureDigest,
		recoveredHead: quota.recoveredHead,
		scenario: "quota-fault",
		scenarioEvidence: Object.freeze({
			afterReopenImageDigest: phase2hEvidenceImageDigest(quota.caseEvidence.afterReopen),
			caseEvidence: quota.caseEvidence,
			edgeId: REPRESENTATIVE_EDGE_ID,
			edgeTarget: "settlement",
			expectedState: "old",
			newImageDigest,
			oldImageDigest,
			retryImageDigest: phase2hEvidenceImageDigest(quota.caseEvidence.retry),
			retryOutcome: "OK",
			tag: "quota-fault",
		}),
		tupleId: `quota-fault/${engine}`,
	});
	validateRecord(engine, record);
	await submitToParent(engine, record);

	const layout = currentLayout();
	const diagnostic = aggregatePhase2h({
		...readPhase2hRunEntries(layout.runRoot),
		browserVersions: layout.browserVersions,
		gitSha: layout.gitSha,
		playwrightVersion: layout.playwrightVersion,
		runId: layout.runId,
	});
	expect(phase2hCampaignCheckpointErrors(diagnostic, { checkpoint: "non-kill-complete", engine })).toEqual([]);
});
