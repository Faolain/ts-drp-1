import {
	type ExpectedHead,
	parseClosureDigest,
	parseGenerationId,
	parseHeadRevision,
	parseStorageObjectId,
	type StorageCapabilityReport,
} from "@ts-drp/storage";

import { PHASE_2E5_BROWSER_REQUEST_INVENTORY } from "./phase-2e5-browser-request-inventory.js";
import {
	type Phase2e6CaseEvidence,
	phase2e6ExpectedTracePrefix,
	phase2e6OracleImages,
} from "./phase-2e6-real-process-death-contract.js";
import { type Phase2gQuotaCaseEvidence, type Phase2gWholeImage } from "./phase-2g-c-quota-fault-contract.js";
import { type Phase2hRawEntry, phase2hStructuralEntries } from "./phase-2h-a-aggregate.js";
import {
	type Phase2hArmingMeasurement,
	type Phase2hEngineEvidence,
	type Phase2hHardKillEvidence,
	phase2hPersistenceMode,
	type Phase2hScenarioEvidence,
	type Phase2hValidationRecord,
} from "./phase-2h-a-record.js";
import { type Phase2hEngineName, type Phase2hTupleDescriptor, PHASE_2H_TUPLES } from "./phase-2h-a-registry.js";

export const PHASE_2H_CONTROL_GIT_SHA = "a".repeat(40);
export const PHASE_2H_CONTROL_RUN_ID = `phase-2h/${PHASE_2H_CONTROL_GIT_SHA}/00000000-0000-4000-8000-000000000000`;

function required<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new TypeError(`missing Phase 2h control ${label}`);
	return value;
}

function must<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }, label: string): T {
	if (!result.ok) throw new TypeError(`invalid Phase 2h control ${label}`);
	return result.value;
}

const OBJECT_ID = must(parseStorageObjectId(`phase-2h-control:${"a".repeat(32)}`), "object id");
const GENERATION_ID = must(parseGenerationId("b".repeat(64)), "generation id");
const CLOSURE_DIGEST = must(parseClosureDigest("c".repeat(64)), "closure digest");
const REVISION = must(parseHeadRevision(1), "revision");
const PRESENT_HEAD: ExpectedHead = Object.freeze({
	closureDigest: CLOSURE_DIGEST,
	generationId: GENERATION_ID,
	kind: "present",
	objectId: OBJECT_ID,
	revision: REVISION,
});

const CAPACITY_REPORT: StorageCapabilityReport = Object.freeze({
	persistence: Object.freeze({ status: "unsupported" }),
	quota: Object.freeze({ reason: "unsupported", status: "unavailable" }),
});

function hex(value: string): string {
	return [...value].map((character) => character.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

function quotaImage(label: string): Phase2gWholeImage {
	return Object.freeze({
		schemaVersion: 1,
		storeCensus: Object.freeze(["blobs", "generations", "objects", "promotions"]),
		stores: Object.freeze({
			blobs: Object.freeze([{ keyBytesHex: hex("blob"), valueBytesHex: hex(`blob:${label}`) }]),
			generations: Object.freeze([{ keyBytesHex: hex("generation"), valueBytesHex: hex(`generation:${label}`) }]),
			objects: Object.freeze([{ keyBytesHex: hex("head"), valueBytesHex: hex(`head:${label}`) }]),
			promotions: Object.freeze([{ keyBytesHex: hex("promotion"), valueBytesHex: hex(`promotion:${label}`) }]),
		}),
	});
}

const QUOTA_OLD = quotaImage("old");
const QUOTA_NEW = quotaImage("new");
const QUOTA_CASE: Phase2gQuotaCaseEvidence = Object.freeze({
	adapterObservedIdenticalSettlementCause: true,
	afterReopen: QUOTA_OLD,
	before: QUOTA_OLD,
	causeIsSameObject: true,
	causeIsSameRealmDOMException: true,
	causeName: "QuotaExceededError",
	edgeId: "swap-head-certificate-match/request-05-put-objects/settlement",
	expectedNew: QUOTA_NEW,
	faultsFired: 1,
	operationReturnedAfterTerminal: true,
	quotaReasonAbsent: true,
	resultReason: "SUBSTRATE_FAILURE",
	retry: QUOTA_NEW,
	retryResult: "OK",
	selectedOccurrenceInTrace: true,
	settlementAbortAttributedToRequestError: true,
	settlementExplicitHarnessAbortCalls: 0,
	settlementIndependentAbortScheduled: false,
	settlementNativeRequestFailureObserved: true,
	settlementNativeRequestFailureDefaultAllowed: true,
	settlementRequestErrorBeforeAbortConsequence: true,
	settlementRequestErrorEvents: 1,
	settlementRequestErrorIsSameRealmQuotaFault: true,
	settlementRequestReadyStateDoneAtTrustedError: true,
	settlementRequestSuccessEvents: 0,
	settlementSyntheticDispatchCalls: 0,
	settlementSyntheticRequestSuccessEvents: 0,
	settlementTransactionAbortAfterRequestError: true,
	settlementTransactionAbortAfterTrustedRequestError: true,
	settlementTrustedRequestErrorEvents: 1,
	settlementTrustedRequestSuccessEvents: 0,
	settlementTrustedTransactionAbortEvents: 1,
	staleRecoveryCertificateCleared: true,
	storeRemainedOpenAndUnpoisoned: true,
});

const ENGINE_BRANDS = Object.freeze({
	chromium: "Playwright Chromium",
	firefox: "Playwright Firefox",
	webkit: "Playwright WebKit",
} as const);

const CONTENT_PROCESS_CLASSES = Object.freeze({
	chromium: "chromium-renderer",
	firefox: "firefox-contentproc",
	webkit: "webkit-webcontent",
} as const);

const DEVICE_PROFILES = Object.freeze({
	chromium: "Desktop Chrome",
	firefox: "Desktop Firefox",
	webkit: "Desktop Safari",
} as const);

function processCase(tuple: Phase2hTupleDescriptor, ordinal: number): Phase2e6CaseEvidence {
	const edge = required(tuple.edge ?? undefined, "process edge");
	const row = required(
		PHASE_2E5_BROWSER_REQUEST_INVENTORY.find(({ id }) => id === edge.scenarioId),
		"process row"
	);
	const expectedState = edge.target === "request" ? "old" : "new";
	const childPid = 20_000 + ordinal * 10;
	const browserPid = childPid + 1;
	const profilePath = `/tmp/phase-2h-${tuple.engine}-${ordinal}`;
	const child = Object.freeze({
		birthToken: `child-${ordinal}`,
		command: "node phase-2h-crash-child",
		pgid: childPid,
		pid: childPid,
		ppid: 19_000,
		state: "T",
	});
	const browserRoot = Object.freeze({
		birthToken: `browser-${ordinal}`,
		command: `/opt/${tuple.engine} --user-data-dir=${profilePath}`,
		pgid: browserPid,
		pid: browserPid,
		ppid: childPid,
		state: "T",
	});
	const processToken = {
		chromium: "renderer",
		firefox: "contentproc renderer",
		webkit: "WebContent renderer",
	}[tuple.engine];
	const content = Object.freeze({
		birthToken: `content-${ordinal}`,
		command: `${tuple.engine} ${processToken}`,
		pgid: browserPid,
		pid: childPid + 2,
		ppid: browserPid,
		state: "T",
	});
	const forest = Object.freeze([child, browserRoot, content]);
	const tracePrefix = phase2e6ExpectedTracePrefix(edge);
	const oldHead = row.operation === "swapHead" ? `head-${ordinal}` : null;
	return Object.freeze({
		armReachCount: 1,
		browserExecutable: `/opt/${tuple.engine}`,
		browserRoot,
		child,
		childExit: Object.freeze({ code: null, signal: "SIGKILL" }),
		controllerPgid: 19_000,
		databaseCreateCountAfterSeed: 0,
		databaseDeleteCount: 0,
		databaseIdentityPreserved: true,
		databaseName: `phase-2h-${tuple.engine}-${ordinal}`,
		edgeId: edge.id,
		expectedState,
		frozenForest: forest,
		head:
			row.operation === "swapHead"
				? Object.freeze({
						kind: "swap" as const,
						monotone: true,
						new: `head-${ordinal + 1}`,
						old: oldHead,
						recovered: expectedState === "old" ? oldHead : `head-${ordinal + 1}`,
					})
				: Object.freeze({ kind: "unchanged" as const, old: oldHead, recovered: oldHead }),
		initialForest: forest,
		killedGroups: Object.freeze([
			Object.freeze({ absent: true, killAccepted: true, pgid: browserPid, role: "browser", rootPid: browserPid }),
			Object.freeze({ absent: true, killAccepted: true, pgid: childPid, role: "child", rootPid: childPid }),
		] as const),
		operationTransactionCount: 1,
		profilePath,
		reachedRequestedArm: true,
		recordedProcessDeaths: Object.freeze(
			forest.map(({ birthToken, pid }) =>
				Object.freeze({ birthToken, currentBirthToken: null, outcome: "absent" as const, pid })
			)
		),
		recoveredDatabaseName: `phase-2h-${tuple.engine}-${ordinal}`,
		recoveredImage: phase2e6OracleImages(edge.scenarioId)[expectedState],
		recoveryResult: "OK",
		scenarioOperation: row.operation,
		sentinelRetained: true,
		tracePrefix,
		unsupported: false,
		workerCrossOriginIsolated: true,
		workerRealm: true,
		writeRequestCount: tracePrefix.filter(({ id, kind }) => kind === "request-success" && /-(?:add|put)-/u.test(id))
			.length,
	});
}

function engineEvidence(engine: Phase2hEngineName): Phase2hEngineEvidence {
	return Object.freeze({
		brand: ENGINE_BRANDS[engine],
		browserVersion: "control-browser-1",
		name: engine,
		playwrightVersion: "1.61.1",
		userAgent: `phase-2h-control/${engine}`,
	});
}

function arming(engine: Phase2hEngineName): Phase2hArmingMeasurement {
	return Object.freeze({
		armHitCount: 1,
		blockedForMs: 100,
		cellAtHit: 1,
		detail: null,
		engine,
		finalCellValue: 2,
		mechanism: "idb-success-callback-sab-atomics-wait/v1",
		notifyWoken: 1,
		outcome: "supported",
		probeEdgeId: "swap-head-certificate-match/request-05-put-objects/after",
		schemaVersion: 1,
		transactionTerminalAfterResume: "complete",
		transactionTerminalWhileBlocked: false,
		workerCrossOriginIsolated: true,
		workerScope: "DedicatedWorkerGlobalScope",
	});
}

function scenarioEvidence(tuple: Phase2hTupleDescriptor, ordinal: number): Phase2hScenarioEvidence {
	switch (tuple.scenario) {
		case "crypto-digest": {
			const digest = "d4c3e8a11256ab82a4fc72560eb4a2b0e87bad820c290dd9b03616de240aa6db";
			return Object.freeze({
				expectedDigestHex: digest,
				observedDigestHex: digest,
				sameRealm: true,
				tag: "crypto-digest",
				vectorId: "sha-256/browser-utf8/v1",
			});
		}
		case "worker-responsiveness":
			return Object.freeze({
				controlBlockMs: 200,
				controlGapMs: 150,
				maxGapMs: 10,
				readyProtocolVersion: 1,
				repetitionCount: 1,
				sampleCount: 20,
				tag: "worker-responsiveness",
				targetIntervalMs: 5,
				windowMs: 100,
				workloadOutputs: Object.freeze({
					count: 4_097,
					items: 4_097,
					orderLength: 4_097,
					pageCounter: 0,
					pageScope: "Window",
					root: "d".repeat(64),
					workerCounter: 4_097,
					workerScope: "DedicatedWorkerGlobalScope",
				}),
			});
		case "browser-store":
			return Object.freeze({
				allResults: "OK",
				expectedState: "new",
				operationSequence: Object.freeze([
					"beginGeneration",
					"putCachedBlob",
					"promoteReference",
					"completeGeneration",
					"swapHead",
					"close",
					"reopen",
					"recoverActiveGeneration",
				]),
				recoveredImageDigest: "e".repeat(64),
				recoveryKind: "active",
				reopened: true,
				tag: "browser-store",
			});
		case "capacity":
			return Object.freeze({ report: CAPACITY_REPORT, tag: "capacity" });
		case "quota-fault":
			return Object.freeze({
				afterReopenImageDigest: "1".repeat(64),
				caseEvidence: QUOTA_CASE,
				edgeId: "swap-head-certificate-match/request-05-put-objects/settlement",
				edgeTarget: "settlement",
				expectedState: "old",
				newImageDigest: "2".repeat(64),
				oldImageDigest: "1".repeat(64),
				retryImageDigest: "2".repeat(64),
				retryOutcome: "OK",
				tag: "quota-fault",
			});
		case "process-death": {
			const caseEvidence = processCase(tuple, ordinal);
			return Object.freeze({
				armReachCount: 1,
				caseEvidence,
				edgeId: caseEvidence.edgeId,
				edgeTarget: required(tuple.edge ?? undefined, "process edge").target,
				expectedState: caseEvidence.expectedState,
				recoveredImageDigest: "3".repeat(64),
				tag: "process-death",
				tracePrefixLength: caseEvidence.tracePrefix.length,
			});
		}
	}
}

function hardKill(
	tuple: Phase2hTupleDescriptor,
	evidence: Extract<Phase2hScenarioEvidence, { tag: "process-death" }>
): Phase2hHardKillEvidence {
	return Object.freeze({
		armingMeasurement: arming(tuple.engine),
		browserRootLocator: "profile-and-executable-argument-match",
		caseEvidence: evidence.caseEvidence,
		contentProcessClass: CONTENT_PROCESS_CLASSES[tuple.engine],
		mechanism: "posix-two-pgid-sigstop-sigkill/v1",
		processForestCommand: "LC_ALL=C ps -A -ww -o pid=,ppid=,pgid=,lstart=,state=,command=",
	});
}

/**
 * Builds the complete controlled positive record set independently of the candidate.
 * @returns Exact 69 valid records in registry order.
 */
export function phase2hControlRecords(): readonly Phase2hValidationRecord[] {
	return Object.freeze(
		PHASE_2H_TUPLES.map((tuple, ordinal): Phase2hValidationRecord => {
			const evidence = scenarioEvidence(tuple, ordinal);
			const storageScenario = ["browser-store", "quota-fault", "process-death"].includes(tuple.scenario);
			return Object.freeze({
				artifactKind: "ts-drp/ahe-storage-validation-record/v1",
				device: Object.freeze({
					class: "desktop-playwright",
					emulated: false,
					profile: DEVICE_PROFILES[tuple.engine],
				}),
				engine: engineEvidence(tuple.engine),
				fullClosureDigest: storageScenario ? CLOSURE_DIGEST : null,
				gitSha: PHASE_2H_CONTROL_GIT_SHA,
				hardKillEvidence: evidence.tag === "process-death" ? hardKill(tuple, evidence) : null,
				killEdge: tuple.killEdge,
				killPointId: tuple.killPointId,
				os: Object.freeze({ arch: "x64", platform: "linux", release: "control-os-1" }),
				persistenceMode: phase2hPersistenceMode(CAPACITY_REPORT),
				recoveredHead: storageScenario ? PRESENT_HEAD : null,
				runId: PHASE_2H_CONTROL_RUN_ID,
				scenario: tuple.scenario,
				scenarioEvidence: evidence,
				schemaVersion: 1,
				tupleId: tuple.tupleId,
				verdict: "pass",
				webLocksMode: "unavailable",
			});
		})
	);
}

/**
 * Encodes one record as a raw project-scoped scanner entry.
 * @param record - Controlled or mutated record body.
 * @param options - Optional filename or trusted-project mutation.
 * @returns Raw entry with canonical JSON bytes.
 */
export function phase2hRecordEntry(
	record: unknown,
	options: Readonly<{ filenameIdentity?: string; project?: Phase2hEngineName; rawName?: Uint8Array }> = {}
): Phase2hRawEntry {
	const tupleId = String(Reflect.get(record as object, "tupleId"));
	const engine =
		options.project ??
		required(
			PHASE_2H_TUPLES.find(({ tupleId: id }) => id === tupleId),
			"tuple"
		).engine;
	const identity = options.filenameIdentity ?? tupleId;
	return Object.freeze({
		basename: options.rawName ?? new TextEncoder().encode(`${encodeURIComponent(identity)}.json`),
		body: new TextEncoder().encode(JSON.stringify(record)),
		kind: "file",
		scope: `records/${engine}`,
	});
}

/**
 * Builds the complete controlled raw-entry fixture.
 * @returns Structural topology followed by 69 canonical record entries.
 */
export function phase2hControlEntries(): readonly Phase2hRawEntry[] {
	return Object.freeze([
		...phase2hStructuralEntries(),
		...phase2hControlRecords().map((record) => phase2hRecordEntry(record)),
	]);
}
