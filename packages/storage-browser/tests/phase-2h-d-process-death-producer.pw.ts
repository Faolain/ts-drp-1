import { chromium, expect, firefox, type Page, test, webkit } from "@playwright/test";
import type { ExpectedHead } from "@ts-drp/storage";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { type AssetServer, startAssetServer } from "./fixtures/asset-server.js";
import { createProcessDeathRunner } from "./fixtures/phase-2e6-process-death-runner.js";
import { PHASE_2E6_DECLARED_EDGES } from "./fixtures/phase-2e6-real-process-death-contract.js";
import { phase2e6CaseErrors } from "./fixtures/phase-2e6-real-process-death-validator.js";
import { aggregatePhase2h, readPhase2hRunEntries } from "./fixtures/phase-2h-a-aggregate.js";
import { phase2hEvidenceImageDigest } from "./fixtures/phase-2h-a-evidence-digest.js";
import type { Phase2hRunLayout } from "./fixtures/phase-2h-a-publication.js";
import {
	type Phase2hArmingMeasurement,
	type Phase2hValidationRecord,
	validatePhase2hRecord,
} from "./fixtures/phase-2h-a-record.js";
import { type Phase2hEngineName, PHASE_2H_TUPLES } from "./fixtures/phase-2h-a-registry.js";

const PROCESS_FOREST_COMMAND = "LC_ALL=C ps -A -ww -o pid=,ppid=,pgid=,lstart=,state=,command=";
const ARMING_EDGE = PHASE_2E6_DECLARED_EDGES.find(
	({ id }) => id === "swap-head-certificate-match/request-05-put-objects/after"
);
if (
	ARMING_EDGE === undefined ||
	ARMING_EDGE.scenarioId !== "swap-head-certificate-match" ||
	ARMING_EDGE.target !== "request"
)
	throw new TypeError("Phase 2h-d source-owned fixed arming edge is absent or drifted");
const ENGINE = Object.freeze({
	chromium: Object.freeze({
		brand: "Playwright Chromium",
		browserType: chromium,
		contentProcessClass: "chromium-renderer",
		profile: "Desktop Chrome",
	}),
	firefox: Object.freeze({
		brand: "Playwright Firefox",
		browserType: firefox,
		contentProcessClass: "firefox-contentproc",
		profile: "Desktop Firefox",
	}),
	webkit: Object.freeze({
		brand: "Playwright WebKit",
		browserType: webkit,
		contentProcessClass: "webkit-webcontent",
		profile: "Desktop Safari",
	}),
} as const);
const require = createRequire(import.meta.url);
const PLAYWRIGHT_VERSION = String((require("@playwright/test/package.json") as { version: unknown }).version);
let server: AssetServer;

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

function capacityRecord(engine: Phase2hEngineName): Phase2hValidationRecord {
	const layout = currentLayout();
	const aggregate = aggregatePhase2h({
		...readPhase2hRunEntries(layout.runRoot),
		gitSha: layout.gitSha,
		runId: layout.runId,
	});
	const capacity = aggregate.records.find(({ tupleId }) => tupleId === `capacity/${engine}`);
	if (capacity === undefined || capacity.scenarioEvidence.tag !== "capacity")
		throw new TypeError(`accepted real capacity/${engine} is absent before process publication`);
	return capacity;
}

async function submitToParent(engine: Phase2hEngineName, record: Phase2hValidationRecord): Promise<void> {
	const encoded = process.env.PHASE_2H_A_SUBMISSION_URLS;
	if (encoded === undefined) throw new TypeError("Phase 2h parent submission endpoints are absent");
	const endpoints = JSON.parse(encoded) as Readonly<Record<string, unknown>>;
	const endpoint = endpoints[engine];
	if (typeof endpoint !== "string") throw new TypeError(`Phase 2h ${engine} parent endpoint is absent`);
	const url = new URL(endpoint);
	if (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
		throw new TypeError("Phase 2h parent submission endpoint is not loopback-only");
	const response = await fetch(url, {
		body: JSON.stringify({ record }),
		headers: { "content-type": "application/json" },
		method: "POST",
	});
	if (!response.ok) throw new Error(`Phase 2h parent rejected ${record.tupleId}: ${response.status}`);
	const receipt = (await response.json()) as Record<string, unknown>;
	expect(receipt).toEqual({
		owner: "phase-2h-parent/v1",
		project: engine,
		status: "accepted",
		tupleId: record.tupleId,
	});
}

async function armingMeasurement(engine: Phase2hEngineName, page: Page): Promise<Phase2hArmingMeasurement> {
	await page.goto(server.issueTransitionURL("phase-2e6.html"), { waitUntil: "load" });
	await page.waitForFunction(() => typeof Reflect.get(globalThis, "phase2e6MeasureArming") === "function");
	const observed = await page.evaluate(async (edge) => {
		const harness = Reflect.get(globalThis, "phase2e6MeasureArming") as (
			edge: unknown
		) => Promise<Record<string, unknown>>;
		return harness(edge);
	}, ARMING_EDGE);
	if (
		observed.armHitCount !== 1 ||
		observed.cellAtHit !== 1 ||
		typeof observed.blockedForMs !== "number" ||
		!Number.isFinite(observed.blockedForMs) ||
		observed.blockedForMs < 100 ||
		observed.transactionTerminalWhileBlocked !== false ||
		observed.notifyWoken !== 1 ||
		observed.finalCellValue !== 2 ||
		observed.transactionTerminalAfterResume !== "complete" ||
		observed.workerCrossOriginIsolated !== true ||
		observed.workerScope !== "DedicatedWorkerGlobalScope"
	)
		throw new TypeError(`Phase 2h-d ${engine} arming measurement failed: ${JSON.stringify(observed)}`);
	return Object.freeze({
		armHitCount: observed.armHitCount,
		blockedForMs: observed.blockedForMs,
		cellAtHit: observed.cellAtHit,
		detail: null,
		engine,
		finalCellValue: observed.finalCellValue,
		mechanism: "idb-success-callback-sab-atomics-wait/v1",
		notifyWoken: observed.notifyWoken,
		outcome: "supported",
		probeEdgeId: "swap-head-certificate-match/request-05-put-objects/after",
		schemaVersion: 1,
		transactionTerminalAfterResume: observed.transactionTerminalAfterResume,
		transactionTerminalWhileBlocked: observed.transactionTerminalWhileBlocked,
		workerCrossOriginIsolated: observed.workerCrossOriginIsolated,
		workerScope: observed.workerScope,
	});
}

test.beforeAll(async () => {
	const assetDirectory = process.env.PHASE_2H_A_ASSET_DIR;
	if (assetDirectory === undefined) throw new TypeError("Phase 2h generated asset directory is absent");
	server = await startAssetServer(assetDirectory);
});

test.afterAll(async () => server.close());

test("publishes the exact real 18-edge process-death batch for this engine", async ({ browser, browserName, page }) => {
	if (process.platform !== "linux")
		throw new TypeError("UNSUPPORTED_PLATFORM: Phase 2h process-death requires Linux before arming or publication");
	const engine = engineName(browserName);
	const facts = ENGINE[engine];
	const capacity = capacityRecord(engine);
	const userAgent = await page.evaluate(() => navigator.userAgent);
	const assetDirectory = process.env.PHASE_2H_A_ASSET_DIR;
	if (assetDirectory === undefined) throw new TypeError("Phase 2h generated asset directory is absent");
	const runner = createProcessDeathRunner({
		assetDirectory,
		engine: {
			browserType: facts.browserType,
			contentProcessClass: facts.contentProcessClass,
			executablePath: facts.browserType.executablePath(),
			name: engine,
		},
		identityPrefix: `phase-2h-d-${engine}-${process.pid}`,
		platform: "linux",
		scope: "phase2h",
		server,
	});
	const tuples = PHASE_2H_TUPLES.filter((tuple) => tuple.engine === engine && tuple.scenario === "process-death");
	expect(tuples).toHaveLength(18);
	const measurement = await armingMeasurement(engine, page);
	const records: Phase2hValidationRecord[] = [];
	for (const [ordinal, tuple] of tuples.entries()) {
		if (tuple.edge === null) throw new TypeError(`process tuple lacks edge ${tuple.tupleId}`);
		const result = await runner.runEdge(tuple.edge, ordinal);
		expect(
			phase2e6CaseErrors(tuple.edge, result.caseEvidence, {
				contentProcessClass: facts.contentProcessClass,
				platform: "linux",
				scope: "phase2h",
			}),
			tuple.tupleId
		).toEqual([]);
		const recoveredHead: ExpectedHead = result.recoveredHead;
		const record: Phase2hValidationRecord = Object.freeze({
			artifactKind: "ts-drp/ahe-storage-validation-record/v1",
			device: Object.freeze({ class: "desktop-playwright", emulated: false, profile: facts.profile }),
			engine: Object.freeze({
				brand: facts.brand,
				browserVersion: browser.version(),
				name: engine,
				playwrightVersion: PLAYWRIGHT_VERSION as "1.61.1",
				userAgent,
			}),
			fullClosureDigest: recoveredHead.kind === "present" ? recoveredHead.closureDigest : null,
			gitSha: currentLayout().gitSha,
			hardKillEvidence: Object.freeze({
				armingMeasurement: measurement,
				browserRootLocator: "profile-and-executable-argument-match",
				caseEvidence: result.caseEvidence,
				contentProcessClass: facts.contentProcessClass,
				mechanism: "posix-two-pgid-sigstop-sigkill/v1",
				processForestCommand: PROCESS_FOREST_COMMAND,
			}),
			killEdge: tuple.killEdge,
			killPointId: tuple.killPointId,
			os: Object.freeze({ arch: architecture(), platform: platform(), release: os.release() }),
			persistenceMode: capacity.persistenceMode,
			recoveredHead,
			runId: currentLayout().runId,
			scenario: "process-death",
			scenarioEvidence: Object.freeze({
				armReachCount: 1,
				caseEvidence: result.caseEvidence,
				edgeId: tuple.edge.id,
				edgeTarget: tuple.edge.target,
				expectedState: tuple.edge.target === "request" ? "old" : "new",
				recoveredImageDigest: phase2hEvidenceImageDigest(result.caseEvidence.recoveredImage),
				tag: "process-death",
				tracePrefixLength: result.caseEvidence.tracePrefix.length,
			}),
			schemaVersion: 1,
			tupleId: tuple.tupleId,
			verdict: "pass",
			webLocksMode: capacity.webLocksMode,
		});
		const layout = currentLayout();
		const validation = validatePhase2hRecord(record, { gitSha: layout.gitSha, project: engine, runId: layout.runId });
		expect(validation.errors, tuple.tupleId).toEqual([]);
		expect(validation.record).toBe(record);
		records.push(record);
	}
	for (const record of records) await submitToParent(engine, record);
});
