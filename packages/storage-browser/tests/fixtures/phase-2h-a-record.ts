import {
	decodeHeadRecordV1,
	type ExpectedHead,
	parseClosureDigest,
	parseGenerationId,
	parseHeadRevision,
	parseStorageObjectId,
	type StorageCapabilityReport,
} from "@ts-drp/storage";

import type { Phase2e6CaseEvidence } from "./phase-2e6-real-process-death-contract.js";
import { type Phase2e6CampaignPlatform, phase2e6CaseErrors } from "./phase-2e6-real-process-death-validator.js";
import {
	declaredPhase2gObservations,
	derivePhase2gQuotaEdges,
	phase2gQuotaCaseErrors,
	type Phase2gQuotaCaseEvidence,
	type Phase2gQuotaEdge,
} from "./phase-2g-c-quota-fault-contract.js";
import { phase2hBoundedStableEvidenceJson, phase2hEvidenceImageDigest } from "./phase-2h-a-evidence-digest.js";
import {
	type Phase2hEngineName,
	type Phase2hScenario,
	phase2hTuple,
	type Phase2hTupleDescriptor,
} from "./phase-2h-a-registry.js";

export type Phase2hWebLocksMode = "available-not-used" | "unavailable";
export type Phase2hPersistenceMode =
	| "granted"
	| "not-granted"
	| "unsupported"
	| "unavailable-exception"
	| "unavailable-invalid-response";

const CONTENT_PROCESS_CLASS = Object.freeze({
	chromium: "chromium-renderer",
	firefox: "firefox-contentproc",
	webkit: "webkit-webcontent",
} as const);

export interface Phase2hEngineEvidence {
	readonly brand: "Playwright Chromium" | "Playwright Firefox" | "Playwright WebKit";
	readonly browserVersion: string;
	readonly name: Phase2hEngineName;
	readonly playwrightVersion: "1.61.1";
	readonly userAgent: string;
}

export interface Phase2hArmingMeasurement {
	readonly armHitCount: number;
	readonly blockedForMs: number;
	readonly cellAtHit: 1 | null;
	readonly detail: string | null;
	readonly engine: Phase2hEngineName;
	readonly finalCellValue: 2 | null;
	readonly mechanism: "idb-success-callback-sab-atomics-wait/v1";
	readonly notifyWoken: 1 | null;
	readonly outcome: "supported" | "unsupported" | "failed";
	readonly probeEdgeId: "swap-head-certificate-match/request-05-put-objects/after";
	readonly schemaVersion: 1;
	readonly transactionTerminalAfterResume: "complete" | "abort" | null;
	readonly transactionTerminalWhileBlocked: boolean | null;
	readonly workerCrossOriginIsolated: boolean;
	readonly workerScope: "DedicatedWorkerGlobalScope" | "unreached";
}

export interface Phase2hHardKillEvidence {
	readonly armingMeasurement: Phase2hArmingMeasurement;
	readonly browserRootLocator: "profile-and-executable-argument-match";
	readonly caseEvidence: Phase2e6CaseEvidence;
	readonly contentProcessClass: "chromium-renderer" | "firefox-contentproc" | "webkit-webcontent";
	readonly mechanism: "posix-two-pgid-sigstop-sigkill/v1";
	readonly processForestCommand: "LC_ALL=C ps -A -ww -o pid=,ppid=,pgid=,lstart=,state=,command=";
}

export type Phase2hScenarioEvidence =
	| Readonly<{
			expectedDigestHex: string;
			observedDigestHex: string;
			sameRealm: boolean;
			tag: "crypto-digest";
			vectorId: "sha-256/browser-utf8/v1";
	  }>
	| Readonly<{
			controlBlockMs: number;
			controlGapMs: number;
			maxGapMs: number;
			readyProtocolVersion: 1;
			repetitionCount: number;
			sampleCount: number;
			tag: "worker-responsiveness";
			targetIntervalMs: 5;
			windowMs: number;
			workloadOutputs: Readonly<{
				count: number;
				items: number;
				orderLength: number;
				pageCounter: 0;
				pageScope: "Window";
				root: string;
				workerCounter: number;
				workerScope: "DedicatedWorkerGlobalScope";
			}>;
	  }>
	| Readonly<{
			allResults: "OK";
			expectedState: "new";
			operationSequence: readonly string[];
			recoveredImageDigest: string;
			recoveryKind: "active";
			reopened: true;
			tag: "browser-store";
	  }>
	| Readonly<{ report: StorageCapabilityReport; tag: "capacity" }>
	| Readonly<{
			afterReopenImageDigest: string;
			caseEvidence: Phase2gQuotaCaseEvidence;
			edgeId: "swap-head-certificate-match/request-05-put-objects/settlement";
			edgeTarget: "settlement";
			expectedState: "old";
			newImageDigest: string;
			oldImageDigest: string;
			retryImageDigest: string;
			retryOutcome: "OK";
			tag: "quota-fault";
	  }>
	| Readonly<{
			armReachCount: 1;
			caseEvidence: Phase2e6CaseEvidence;
			edgeId: string;
			edgeTarget: "request" | "transaction-terminal";
			expectedState: "old" | "new";
			recoveredImageDigest: string;
			tag: "process-death";
			tracePrefixLength: number;
	  }>;

export interface Phase2hValidationRecord {
	readonly artifactKind: "ts-drp/ahe-storage-validation-record/v1";
	readonly device: Readonly<{
		class: "desktop-playwright";
		emulated: false;
		profile: "Desktop Chrome" | "Desktop Firefox" | "Desktop Safari";
	}>;
	readonly engine: Phase2hEngineEvidence;
	readonly fullClosureDigest: string | null;
	readonly gitSha: string;
	readonly hardKillEvidence: Phase2hHardKillEvidence | null;
	readonly killEdge: "after:request" | "after:transaction-terminal" | null;
	readonly killPointId: string | null;
	readonly os: Readonly<{ arch: "x64" | "arm64"; platform: "linux" | "darwin"; release: string }>;
	readonly persistenceMode: Phase2hPersistenceMode;
	readonly recoveredHead: ExpectedHead | null;
	readonly runId: string;
	readonly scenario: Phase2hScenario;
	readonly scenarioEvidence: Phase2hScenarioEvidence;
	readonly schemaVersion: 1;
	readonly tupleId: string;
	readonly verdict: "pass" | "fail";
	readonly webLocksMode: Phase2hWebLocksMode;
}

export interface Phase2hRecordExpectation {
	readonly gitSha: string;
	readonly project: Phase2hEngineName;
	readonly runId: string;
}

export interface Phase2hRecordValidation {
	readonly errors: readonly string[];
	readonly record: Phase2hValidationRecord | null;
}

const RECORD_KEYS = Object.freeze([
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

const ENGINE = Object.freeze({
	chromium: Object.freeze({ brand: "Playwright Chromium", profile: "Desktop Chrome" }),
	firefox: Object.freeze({ brand: "Playwright Firefox", profile: "Desktop Firefox" }),
	webkit: Object.freeze({ brand: "Playwright WebKit", profile: "Desktop Safari" }),
} as const);

const QUOTA_EDGE_ID = "swap-head-certificate-match/request-05-put-objects/settlement";
const quotaEdge = ((): Phase2gQuotaEdge => {
	const edge = derivePhase2gQuotaEdges(declaredPhase2gObservations()).find(({ id }) => id === QUOTA_EDGE_ID);
	if (edge === undefined) throw new TypeError("Phase 2h representative quota edge is absent from the derived trace");
	return edge;
})();

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return isObject(value) && sameStrings(Object.keys(value).sort(), [...keys].sort());
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return isNonNegativeSafeInteger(value) && value > 0;
}

function isHex(value: unknown, length: 40 | 64): value is string {
	return typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`, "u").test(value);
}

function containsUnpairedSurrogate(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 0xd800 || code > 0xdfff) continue;
		if (code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				index += 1;
				continue;
			}
		}
		return true;
	}
	return false;
}

function isBoundedText(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!value.includes("\0") &&
		!containsUnpairedSurrogate(value) &&
		new TextEncoder().encode(value).byteLength <= 1_024
	);
}

function expectedHead(value: unknown, errors: string[]): ExpectedHead | null {
	if (!isObject(value) || (value.kind !== "none" && value.kind !== "present")) {
		errors.push("recoveredHead is not a closed ExpectedHead");
		return null;
	}
	if (value.kind === "none") {
		if (
			!hasKeys(value, ["kind", "objectId"]) ||
			typeof value.objectId !== "string" ||
			!parseStorageObjectId(value.objectId).ok
		) {
			errors.push("recoveredHead none arm is invalid");
			return null;
		}
		return value as unknown as ExpectedHead;
	}
	if (
		!hasKeys(value, ["closureDigest", "generationId", "kind", "objectId", "revision"]) ||
		typeof value.objectId !== "string" ||
		typeof value.generationId !== "string" ||
		typeof value.revision !== "number" ||
		typeof value.closureDigest !== "string" ||
		!parseStorageObjectId(value.objectId).ok ||
		!parseGenerationId(value.generationId).ok ||
		!parseHeadRevision(value.revision).ok ||
		!parseClosureDigest(value.closureDigest).ok
	) {
		errors.push("recoveredHead present arm is invalid");
		return null;
	}
	return value as unknown as ExpectedHead;
}

function storageCapability(value: unknown): value is StorageCapabilityReport {
	if (!hasKeys(value, ["persistence", "quota"])) return false;
	const persistence = value.persistence;
	const quota = value.quota;
	const persistenceValid =
		hasKeys(persistence, ["status"]) &&
		(persistence.status === "unsupported" || persistence.status === "granted" || persistence.status === "not-granted")
			? true
			: hasKeys(persistence, ["reason", "status"]) &&
				persistence.status === "unavailable" &&
				(persistence.reason === "exception" || persistence.reason === "invalid-response");
	if (!persistenceValid) return false;
	if (hasKeys(quota, ["availableBytes", "quotaBytes", "status", "usageBytes"])) {
		return (
			quota.status === "available" &&
			isNonNegativeSafeInteger(quota.usageBytes) &&
			isNonNegativeSafeInteger(quota.quotaBytes) &&
			isNonNegativeSafeInteger(quota.availableBytes) &&
			quota.usageBytes <= quota.quotaBytes &&
			quota.availableBytes === quota.quotaBytes - quota.usageBytes
		);
	}
	return (
		hasKeys(quota, ["reason", "status"]) &&
		quota.status === "unavailable" &&
		["unsupported", "exception", "incomplete", "unsafe", "inconsistent"].includes(String(quota.reason))
	);
}

/**
 * Flattens the source-owned persistence observation into the record vocabulary.
 * @param report - Complete storage-capability report.
 * @returns Exact record persistence mode.
 */
export function phase2hPersistenceMode(report: StorageCapabilityReport): Phase2hPersistenceMode {
	const observation = report.persistence;
	if (observation.status !== "unavailable") return observation.status;
	return observation.reason === "exception" ? "unavailable-exception" : "unavailable-invalid-response";
}

function validateArming(
	value: unknown,
	engine: Phase2hEngineName,
	errors: string[]
): value is Phase2hArmingMeasurement {
	if (
		!hasKeys(value, [
			"armHitCount",
			"blockedForMs",
			"cellAtHit",
			"detail",
			"engine",
			"finalCellValue",
			"mechanism",
			"notifyWoken",
			"outcome",
			"probeEdgeId",
			"schemaVersion",
			"transactionTerminalAfterResume",
			"transactionTerminalWhileBlocked",
			"workerCrossOriginIsolated",
			"workerScope",
		]) ||
		value.schemaVersion !== 1 ||
		value.mechanism !== "idb-success-callback-sab-atomics-wait/v1" ||
		value.engine !== engine ||
		value.probeEdgeId !== "swap-head-certificate-match/request-05-put-objects/after" ||
		value.outcome !== "supported" ||
		value.workerCrossOriginIsolated !== true ||
		value.workerScope !== "DedicatedWorkerGlobalScope" ||
		value.armHitCount !== 1 ||
		value.cellAtHit !== 1 ||
		!isFiniteNonNegative(value.blockedForMs) ||
		value.blockedForMs < 100 ||
		value.transactionTerminalWhileBlocked !== false ||
		value.notifyWoken !== 1 ||
		value.finalCellValue !== 2 ||
		value.transactionTerminalAfterResume !== "complete" ||
		value.detail !== null
	) {
		errors.push("hard-kill arming measurement is not the sole passing shape");
		return false;
	}
	return true;
}

function validateHardKill(
	value: unknown,
	tuple: Phase2hTupleDescriptor,
	caseEvidence: Phase2e6CaseEvidence,
	errors: string[]
): value is Phase2hHardKillEvidence {
	const observedCase = isObject(value) ? phase2hBoundedStableEvidenceJson(value.caseEvidence) : null;
	const scenarioCase = phase2hBoundedStableEvidenceJson(caseEvidence);
	if (
		!hasKeys(value, [
			"armingMeasurement",
			"browserRootLocator",
			"caseEvidence",
			"contentProcessClass",
			"mechanism",
			"processForestCommand",
		]) ||
		value.mechanism !== "posix-two-pgid-sigstop-sigkill/v1" ||
		value.processForestCommand !== "LC_ALL=C ps -A -ww -o pid=,ppid=,pgid=,lstart=,state=,command=" ||
		value.browserRootLocator !== "profile-and-executable-argument-match" ||
		value.contentProcessClass !== CONTENT_PROCESS_CLASS[tuple.engine] ||
		observedCase === null ||
		observedCase !== scenarioCase
	) {
		errors.push("hardKillEvidence is invalid or is not bound to scenario caseEvidence");
		return false;
	}
	if (!validateArming(value.armingMeasurement, tuple.engine, errors)) return false;
	return true;
}

function physicalValue(hex: unknown): unknown {
	if (typeof hex !== "string" || !/^(?:[0-9a-f]{2})*$/u.test(hex)) throw new TypeError("invalid physical hex");
	return JSON.parse(Buffer.from(hex, "hex").toString("utf8")) as unknown;
}

function physicalBytes(value: unknown): Uint8Array {
	const candidate = Array.isArray(value)
		? value
		: hasKeys(value, ["$bytes"]) && Array.isArray(value.$bytes)
			? value.$bytes
			: null;
	if (candidate === null || !candidate.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255))
		throw new TypeError("physical bytes are malformed");
	return Uint8Array.from(candidate as number[]);
}

function quotaOldPresentHead(value: Phase2gQuotaCaseEvidence): ExpectedHead | null {
	try {
		const present: ExpectedHead[] = [];
		for (const row of value.before.stores.objects) {
			const key = physicalValue(row.keyBytesHex);
			const stored = physicalValue(row.valueBytesHex);
			if (typeof key !== "string" || !parseStorageObjectId(key).ok || !isObject(stored)) return null;
			const decoded = decodeHeadRecordV1(physicalBytes(stored.record));
			if (!decoded.ok || decoded.value.objectId !== key) return null;
			if (decoded.value.kind === "present") present.push(decoded.value);
		}
		return present.length === 1 ? (present[0] ?? null) : null;
	} catch {
		return null;
	}
}

function validateScenario(
	value: unknown,
	tuple: Phase2hTupleDescriptor,
	recovered: ExpectedHead | null,
	persistenceMode: Phase2hPersistenceMode,
	platform: Phase2e6CampaignPlatform | undefined,
	errors: string[]
): value is Phase2hScenarioEvidence {
	if (!isObject(value) || value.tag !== tuple.scenario) {
		errors.push("scenarioEvidence tag does not match tuple scenario");
		return false;
	}
	switch (tuple.scenario) {
		case "crypto-digest": {
			const expected = "d4c3e8a11256ab82a4fc72560eb4a2b0e87bad820c290dd9b03616de240aa6db";
			if (
				!hasKeys(value, ["expectedDigestHex", "observedDigestHex", "sameRealm", "tag", "vectorId"]) ||
				value.vectorId !== "sha-256/browser-utf8/v1" ||
				value.expectedDigestHex !== expected ||
				value.observedDigestHex !== expected ||
				value.sameRealm !== true
			)
				errors.push("crypto-digest evidence failed the same-realm known-answer control");
			break;
		}
		case "worker-responsiveness": {
			if (
				!hasKeys(value, [
					"controlBlockMs",
					"controlGapMs",
					"maxGapMs",
					"readyProtocolVersion",
					"repetitionCount",
					"sampleCount",
					"tag",
					"targetIntervalMs",
					"windowMs",
					"workloadOutputs",
				]) ||
				!isFiniteNonNegative(value.controlBlockMs) ||
				value.controlBlockMs < 200 ||
				!isFiniteNonNegative(value.controlGapMs) ||
				value.controlGapMs < 150 ||
				!isFiniteNonNegative(value.windowMs) ||
				value.windowMs < 100 ||
				!isNonNegativeSafeInteger(value.sampleCount) ||
				value.sampleCount < Math.max(20, Math.floor(value.windowMs / 25)) ||
				value.targetIntervalMs !== 5 ||
				!isFiniteNonNegative(value.maxGapMs) ||
				value.maxGapMs >= 50 ||
				value.readyProtocolVersion !== 1 ||
				!isPositiveSafeInteger(value.repetitionCount) ||
				value.repetitionCount > 256 ||
				!hasKeys(value.workloadOutputs, [
					"count",
					"items",
					"orderLength",
					"pageCounter",
					"pageScope",
					"root",
					"workerCounter",
					"workerScope",
				])
			) {
				errors.push("worker responsiveness evidence is malformed or unbound");
				break;
			}
			const expectedTotal = 4_097 * value.repetitionCount;
			const outputs = value.workloadOutputs;
			if (
				!isHex(outputs.root, 64) ||
				outputs.orderLength !== expectedTotal ||
				outputs.count !== expectedTotal ||
				outputs.items !== expectedTotal ||
				outputs.workerCounter !== expectedTotal ||
				outputs.workerScope !== "DedicatedWorkerGlobalScope" ||
				outputs.pageCounter !== 0 ||
				outputs.pageScope !== "Window"
			)
				errors.push("worker responsiveness workload oracle is hollow or inconsistent");
			break;
		}
		case "browser-store": {
			const operationSequence = Array.isArray(value.operationSequence) ? value.operationSequence : [];
			if (
				!hasKeys(value, [
					"allResults",
					"expectedState",
					"operationSequence",
					"recoveredImageDigest",
					"recoveryKind",
					"reopened",
					"tag",
				]) ||
				!sameStrings(operationSequence as readonly string[], [
					"beginGeneration",
					"putCachedBlob",
					"promoteReference",
					"completeGeneration",
					"swapHead",
					"close",
					"reopen",
					"recoverActiveGeneration",
				]) ||
				value.allResults !== "OK" ||
				value.reopened !== true ||
				value.recoveryKind !== "active" ||
				value.expectedState !== "new" ||
				!isHex(value.recoveredImageDigest, 64) ||
				recovered?.kind !== "present"
			)
				errors.push("browser-store evidence does not prove the production recovery path");
			break;
		}
		case "capacity": {
			if (
				!hasKeys(value, ["report", "tag"]) ||
				!storageCapability(value.report) ||
				phase2hPersistenceMode(value.report) !== persistenceMode
			)
				errors.push("capacity evidence is incomplete or persistence flattening drifted");
			break;
		}
		case "quota-fault": {
			if (
				!hasKeys(value, [
					"afterReopenImageDigest",
					"caseEvidence",
					"edgeId",
					"edgeTarget",
					"expectedState",
					"newImageDigest",
					"oldImageDigest",
					"retryImageDigest",
					"retryOutcome",
					"tag",
				]) ||
				value.edgeId !== QUOTA_EDGE_ID ||
				value.edgeTarget !== "settlement" ||
				value.expectedState !== "old" ||
				value.retryOutcome !== "OK" ||
				!isHex(value.oldImageDigest, 64) ||
				value.afterReopenImageDigest !== value.oldImageDigest ||
				!isHex(value.newImageDigest, 64) ||
				value.newImageDigest === value.oldImageDigest ||
				value.retryImageDigest !== value.newImageDigest ||
				recovered?.kind !== "present"
			) {
				errors.push("quota-fault evidence digest or edge contract is invalid");
				break;
			}
			try {
				errors.push(
					...phase2gQuotaCaseErrors(quotaEdge, value.caseEvidence as Phase2gQuotaCaseEvidence).map(
						(error) => `quota-fault: ${error}`
					)
				);
				const oldHead = quotaOldPresentHead(value.caseEvidence as Phase2gQuotaCaseEvidence);
				if (
					oldHead?.kind !== "present" ||
					recovered?.kind !== "present" ||
					phase2hBoundedStableEvidenceJson(oldHead) !== phase2hBoundedStableEvidenceJson(recovered)
				)
					errors.push("quota-fault recoveredHead is not the unique present head in source-owned old-image bytes");
			} catch {
				errors.push("quota-fault source-owned case evidence threw during validation");
			}
			break;
		}
		case "process-death": {
			const edge = tuple.edge;
			if (
				edge === null ||
				!hasKeys(value, [
					"armReachCount",
					"caseEvidence",
					"edgeId",
					"edgeTarget",
					"expectedState",
					"recoveredImageDigest",
					"tag",
					"tracePrefixLength",
				]) ||
				value.edgeId !== tuple.killPointId ||
				value.edgeTarget !== edge.target ||
				value.expectedState !== (edge.target === "request" ? "old" : "new") ||
				value.armReachCount !== 1 ||
				!isPositiveSafeInteger(value.tracePrefixLength) ||
				!isHex(value.recoveredImageDigest, 64) ||
				recovered === null
			) {
				errors.push("process-death scenario evidence is malformed or mismatched");
				break;
			}
			if (!isObject(value.caseEvidence) || !Array.isArray(value.caseEvidence.tracePrefix)) {
				errors.push("process-death case evidence is malformed");
				break;
			}
			const caseEvidence = value.caseEvidence as unknown as Phase2e6CaseEvidence;
			if (value.tracePrefixLength !== caseEvidence.tracePrefix.length) {
				errors.push("process-death trace prefix length is unbound");
				break;
			}
			try {
				if (platform === undefined) {
					errors.push("process-death host platform is unavailable");
					break;
				}
				if (value.recoveredImageDigest !== phase2hEvidenceImageDigest(caseEvidence.recoveredImage)) {
					errors.push("process-death recovered image digest is unbound");
					break;
				}
				errors.push(
					...phase2e6CaseErrors(edge, caseEvidence, {
						contentProcessClass: CONTENT_PROCESS_CLASS[tuple.engine],
						platform,
						scope: "phase2h",
					})
				);
			} catch {
				errors.push("process-death source-owned case evidence threw during validation");
			}
			break;
		}
	}
	return errors.length === 0;
}

/**
 * Validates one untrusted schema-v1 browser-validation record.
 * @param value - Parsed candidate body.
 * @param expected - Trusted Git, run and Playwright-project provenance.
 * @returns Closed errors and a typed record only when schema/evidence validate.
 */
export function validatePhase2hRecord(value: unknown, expected: Phase2hRecordExpectation): Phase2hRecordValidation {
	const errors: string[] = [];
	if (!hasKeys(value, RECORD_KEYS))
		return Object.freeze({ errors: ["record top-level schema is not closed"], record: null });
	const tuple = phase2hTuple(value.tupleId);
	if (tuple === undefined) errors.push("tupleId is not a required registry member");
	if (value.schemaVersion !== 1 || value.artifactKind !== "ts-drp/ahe-storage-validation-record/v1")
		errors.push("record schema identity is invalid");
	if (!isHex(value.gitSha, 40) || value.gitSha !== expected.gitSha) errors.push("record GitSha is invalid or stale");
	if (
		value.runId !== expected.runId ||
		!new RegExp(
			`^phase-2h/${expected.gitSha}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
			"u"
		).test(String(value.runId))
	)
		errors.push("record RunId is invalid or stale");
	if (
		tuple !== undefined &&
		(value.scenario !== tuple.scenario || value.killPointId !== tuple.killPointId || value.killEdge !== tuple.killEdge)
	)
		errors.push("record scenario or kill mapping does not match the derived tuple");
	if (tuple !== undefined && expected.project !== tuple.engine)
		errors.push("trusted submitting project does not match tuple engine");

	const engineExpected = tuple === undefined ? undefined : ENGINE[tuple.engine];
	if (
		engineExpected === undefined ||
		!hasKeys(value.engine, ["brand", "browserVersion", "name", "playwrightVersion", "userAgent"]) ||
		value.engine.name !== tuple?.engine ||
		value.engine.brand !== engineExpected.brand ||
		value.engine.playwrightVersion !== "1.61.1" ||
		!isBoundedText(value.engine.browserVersion) ||
		!isBoundedText(value.engine.userAgent)
	)
		errors.push("engine evidence is invalid or disagrees with tuple/project");
	if (
		!hasKeys(value.os, ["arch", "platform", "release"]) ||
		(value.os.platform !== "linux" && value.os.platform !== "darwin") ||
		(value.os.arch !== "x64" && value.os.arch !== "arm64") ||
		!isBoundedText(value.os.release)
	)
		errors.push("OS evidence is invalid");
	if (tuple?.scenario === "process-death" && isObject(value.os) && value.os.platform !== "linux")
		errors.push("process-death records require Linux host authority");
	if (
		engineExpected === undefined ||
		!hasKeys(value.device, ["class", "emulated", "profile"]) ||
		value.device.class !== "desktop-playwright" ||
		value.device.emulated !== false ||
		value.device.profile !== engineExpected.profile
	)
		errors.push("device evidence is invalid or overclaims a real device");
	if (value.webLocksMode !== "available-not-used" && value.webLocksMode !== "unavailable")
		errors.push("webLocksMode is outside the closed observation vocabulary");
	if (
		!["granted", "not-granted", "unsupported", "unavailable-exception", "unavailable-invalid-response"].includes(
			String(value.persistenceMode)
		)
	)
		errors.push("persistenceMode is outside the closed observation vocabulary");
	if (value.verdict !== "pass" && value.verdict !== "fail") errors.push("record verdict is invalid");

	let recovered: ExpectedHead | null = null;
	if (tuple !== undefined && ["browser-store", "quota-fault", "process-death"].includes(tuple.scenario)) {
		recovered = expectedHead(value.recoveredHead, errors);
	} else if (value.recoveredHead !== null) errors.push("non-storage scenario carries recoveredHead");
	if (recovered === null || recovered.kind === "none") {
		if (value.fullClosureDigest !== null) errors.push("fullClosureDigest is non-null without a present recovered head");
	} else if (
		typeof value.fullClosureDigest !== "string" ||
		!parseClosureDigest(value.fullClosureDigest).ok ||
		value.fullClosureDigest !== recovered.closureDigest
	) {
		errors.push("fullClosureDigest does not equal the present recovered head closure");
	}

	if (tuple !== undefined) {
		const os = isObject(value.os) ? value.os : undefined;
		const platform =
			os?.platform === "darwin" || os?.platform === "linux" ? (os.platform as Phase2e6CampaignPlatform) : undefined;
		const scenarioValid = validateScenario(
			value.scenarioEvidence,
			tuple,
			recovered,
			value.persistenceMode as Phase2hPersistenceMode,
			platform,
			errors
		);
		if (tuple.scenario === "process-death") {
			if (scenarioValid) {
				const scenario = value.scenarioEvidence as Extract<Phase2hScenarioEvidence, { tag: "process-death" }>;
				validateHardKill(value.hardKillEvidence, tuple, scenario.caseEvidence, errors);
			}
		} else if (value.hardKillEvidence !== null) errors.push("non-process scenario carries hardKillEvidence");
	}

	return Object.freeze({
		errors: Object.freeze(errors),
		record: errors.length === 0 ? (value as unknown as Phase2hValidationRecord) : null,
	});
}
