export const NOT_MEASURED = Object.freeze([
	"pressure-eviction",
	"lru-ordering",
	"itp-eviction",
	"quota-driven-eviction",
	"eviction-ordering",
	"co-eviction-atomicity",
] as const);

export const DURABILITY_NOT_PROVEN = Object.freeze(["fsync", "power-loss", "torn-write"] as const);

export type Substrate = "opfs" | "idb-strict";

export interface MeasurementArm {
	readonly substrate: Substrate;
	readonly postState: "oracle-pass";
	readonly elapsedMilliseconds: number;
}

export interface MeasurementEvidence {
	readonly schemaVersion: 1;
	readonly artifactKind: "substrate-measurement";
	readonly arms: readonly [
		MeasurementArm & { readonly substrate: "opfs" },
		MeasurementArm & { readonly substrate: "idb-strict" },
	];
	readonly commandScriptDigest: string;
	readonly opsExecuted: number;
	readonly oracleId: string;
	readonly runId: string;
	readonly engineBuild: string;
	readonly executionOwner: "dedicated-worker";
	readonly crossOriginIsolated: true;
	readonly concurrencyShape: "single-writer";
	readonly contendedMultiTab: "unmeasured-for-2i";
	readonly commandParity: "byte-identical";
	readonly correctnessBeforeTiming: true;
	readonly timingPassingThreshold: "none";
}

export interface StrictIdbCapabilityEvidence {
	readonly schemaVersion: 1;
	readonly artifactKind: "strict-idb-capability";
	readonly requestedDurability: "strict";
	readonly observedDurability: "strict";
	readonly observedFrom: "live-transaction";
	readonly nonStrictOutcome: "typed-fatal-capability-error";
	readonly nonStrictWritesCommitted: 0;
	readonly durabilityEvidenceScope: "capability-and-no-fallback";
	readonly notProven: typeof DURABILITY_NOT_PROVEN;
}

export interface ClearControlEvidence {
	readonly schemaVersion: 1;
	readonly artifactKind: "bucket-clear-control";
	readonly method: "whole-bucket-clear";
	readonly claim: "deletion-not-eviction";
	readonly notMeasured: typeof NOT_MEASURED;
	readonly payloadsReadableAfterReopen: true;
	readonly payloadsAbsentAfterClear: true;
	readonly noClearControlSurvived: true;
	readonly secondOriginSurvived: true;
}

export interface PressureEvictionBoundary {
	readonly status: "unautomatable";
	readonly scope: "ordinary-web/playwright";
	readonly engineBuilds: readonly [string, ...string[]];
	readonly basis: readonly [string, ...string[]];
	readonly reason: string;
	readonly revisitTrigger: "deterministic-supported-trigger";
	readonly consumer: "phase-5-signer-profile-eviction-matrix-and-pre-release-real-device-blocker";
}

export interface DecisionEvidence {
	readonly schemaVersion: 1;
	readonly artifactKind: "storage-substrate-decision";
	readonly chosen: Substrate;
	readonly measurementArtifactDigests: readonly [string, ...string[]];
	readonly sameDefaultBucket: "normative";
	readonly sameEvictionBehavior: "unmeasured";
	readonly realPressureEviction: PressureEvictionBoundary;
	readonly clearEvidenceScoringWeight: "none";
	readonly custodyFateSharingSurface: string;
	readonly crashAtomicityMechanism: string;
	readonly implementationRisk: string;
	readonly consequences: readonly [string, ...string[]];
}

export type SpikeEvidence = MeasurementEvidence | StrictIdbCapabilityEvidence | ClearControlEvidence | DecisionEvidence;

const SHA256 = /^[0-9a-f]{64}$/u;
const MEASUREMENT_KEYS = [
	"schemaVersion",
	"artifactKind",
	"arms",
	"commandScriptDigest",
	"opsExecuted",
	"oracleId",
	"runId",
	"engineBuild",
	"executionOwner",
	"crossOriginIsolated",
	"concurrencyShape",
	"contendedMultiTab",
	"commandParity",
	"correctnessBeforeTiming",
	"timingPassingThreshold",
] as const;

export const VALID_MEASUREMENT_EVIDENCE: MeasurementEvidence = Object.freeze({
	schemaVersion: 1,
	artifactKind: "substrate-measurement",
	arms: Object.freeze([
		Object.freeze({ substrate: "opfs", postState: "oracle-pass", elapsedMilliseconds: 12.5 }),
		Object.freeze({ substrate: "idb-strict", postState: "oracle-pass", elapsedMilliseconds: 14.75 }),
	] as const),
	commandScriptDigest: "1".repeat(64),
	opsExecuted: 24,
	oracleId: "phase-2a-read-object-state-v1",
	runId: "phase-2-spike-measurement-001",
	engineBuild: "chromium-149.0.7827.55",
	executionOwner: "dedicated-worker",
	crossOriginIsolated: true,
	concurrencyShape: "single-writer",
	contendedMultiTab: "unmeasured-for-2i",
	commandParity: "byte-identical",
	correctnessBeforeTiming: true,
	timingPassingThreshold: "none",
});

export const VALID_STRICT_IDB_CAPABILITY_EVIDENCE: StrictIdbCapabilityEvidence = Object.freeze({
	schemaVersion: 1,
	artifactKind: "strict-idb-capability",
	requestedDurability: "strict",
	observedDurability: "strict",
	observedFrom: "live-transaction",
	nonStrictOutcome: "typed-fatal-capability-error",
	nonStrictWritesCommitted: 0,
	durabilityEvidenceScope: "capability-and-no-fallback",
	notProven: DURABILITY_NOT_PROVEN,
});

export const VALID_CLEAR_CONTROL_EVIDENCE: ClearControlEvidence = Object.freeze({
	schemaVersion: 1,
	artifactKind: "bucket-clear-control",
	method: "whole-bucket-clear",
	claim: "deletion-not-eviction",
	notMeasured: NOT_MEASURED,
	payloadsReadableAfterReopen: true,
	payloadsAbsentAfterClear: true,
	noClearControlSurvived: true,
	secondOriginSurvived: true,
});

export const VALID_DECISION_EVIDENCE: DecisionEvidence = Object.freeze({
	schemaVersion: 1,
	artifactKind: "storage-substrate-decision",
	chosen: "idb-strict",
	measurementArtifactDigests: Object.freeze(["2".repeat(64)] as const),
	sameDefaultBucket: "normative",
	sameEvictionBehavior: "unmeasured",
	realPressureEviction: Object.freeze({
		status: "unautomatable",
		scope: "ordinary-web/playwright",
		engineBuilds: Object.freeze(["chromium-149.0.7827.55"] as const),
		basis: Object.freeze(["WHATWG Storage has no deterministic pressure-eviction trigger"] as const),
		reason: "Ordinary-web and Playwright controls cannot invoke the user agent storage-pressure selection policy.",
		revisitTrigger: "deterministic-supported-trigger",
		consumer: "phase-5-signer-profile-eviction-matrix-and-pre-release-real-device-blocker",
	}),
	clearEvidenceScoringWeight: "none",
	custodyFateSharingSurface: "selected vote-log endpoint versus non-extractable CryptoKey endpoint",
	crashAtomicityMechanism: "substrate-specific and not proven by the benchmark",
	implementationRisk: "bounded spike assessment",
	consequences: Object.freeze(["Phase 2d consumes this decision and its cited measurement digest"] as const),
});

function requireClosed(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Object.getOwnPropertySymbols(value).length !== 0) {
		throw new TypeError(`${label} must be a closed object`);
	}
	const names = Object.getOwnPropertyNames(value).sort();
	const expected = [...keys].sort();
	if (
		names.length !== expected.length ||
		names.some((name, index) => name !== expected[index]) ||
		names.some((name) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, name);
			return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
		})
	) {
		throw new TypeError(`${label} has missing, extra, accessor, or non-enumerable fields`);
	}
	return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
	if (!Array.isArray(value) || Object.getOwnPropertySymbols(value).length !== 0) {
		throw new TypeError(`${label} must be an array`);
	}
	const names = Object.getOwnPropertyNames(value).sort();
	const expected = [...value.keys()].map(String).concat("length").sort();
	if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
		throw new TypeError(`${label} must be dense and expando-free`);
	}
	return value;
}

function requireExactStrings(value: unknown, expected: readonly string[], label: string): void {
	const items = requireArray(value, label);
	if (items.length !== expected.length || items.some((item, index) => item !== expected[index])) {
		throw new TypeError(`${label} is not the frozen ordered set`);
	}
}

function requireNonEmpty(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be non-empty`);
	return value;
}

function parseMeasurement(value: unknown): MeasurementEvidence {
	const initial = requireClosed(value, Object.getOwnPropertyNames(value as object), "measurement evidence");
	const forbiddenSelectionAliases = ["winner", "chosen", "preferred"].filter((key) => Object.hasOwn(initial, key));
	const candidate = requireClosed(value, [...MEASUREMENT_KEYS, ...forbiddenSelectionAliases], "measurement evidence");
	const arms = requireArray(candidate.arms, "measurement arms");
	if (arms.length !== 2) throw new TypeError("measurement evidence requires exactly two arms");
	const expectedSubstrates = ["opfs", "idb-strict"] as const;
	for (const [index, armValue] of arms.entries()) {
		const arm = requireClosed(armValue, ["substrate", "postState", "elapsedMilliseconds"], "measurement arm");
		if (
			arm.substrate !== expectedSubstrates[index] ||
			arm.postState !== "oracle-pass" ||
			typeof arm.elapsedMilliseconds !== "number" ||
			!Number.isFinite(arm.elapsedMilliseconds) ||
			arm.elapsedMilliseconds < 0
		) {
			throw new TypeError("measurement arm is malformed or lacks a passing post-state oracle");
		}
	}
	if (
		candidate.schemaVersion !== 1 ||
		candidate.artifactKind !== "substrate-measurement" ||
		typeof candidate.commandScriptDigest !== "string" ||
		!SHA256.test(candidate.commandScriptDigest) ||
		!Number.isSafeInteger(candidate.opsExecuted) ||
		Number(candidate.opsExecuted) <= 0 ||
		candidate.executionOwner !== "dedicated-worker" ||
		candidate.crossOriginIsolated !== true ||
		candidate.concurrencyShape !== "single-writer" ||
		candidate.contendedMultiTab !== "unmeasured-for-2i" ||
		candidate.commandParity !== "byte-identical" ||
		candidate.correctnessBeforeTiming !== true ||
		candidate.timingPassingThreshold !== "none"
	) {
		throw new TypeError("measurement evidence is outside the frozen S0 boundary");
	}
	requireNonEmpty(candidate.oracleId, "oracle ID");
	requireNonEmpty(candidate.runId, "run ID");
	requireNonEmpty(candidate.engineBuild, "engine build");
	return value as MeasurementEvidence;
}

function parseStrictIdbCapability(value: unknown): StrictIdbCapabilityEvidence {
	const candidate = requireClosed(
		value,
		[
			"schemaVersion",
			"artifactKind",
			"requestedDurability",
			"observedDurability",
			"observedFrom",
			"nonStrictOutcome",
			"nonStrictWritesCommitted",
			"durabilityEvidenceScope",
			"notProven",
		],
		"strict-IDB capability evidence"
	);
	if (
		candidate.schemaVersion !== 1 ||
		candidate.artifactKind !== "strict-idb-capability" ||
		candidate.requestedDurability !== "strict" ||
		candidate.observedDurability !== "strict" ||
		candidate.observedFrom !== "live-transaction" ||
		candidate.nonStrictOutcome !== "typed-fatal-capability-error" ||
		candidate.nonStrictWritesCommitted !== 0 ||
		candidate.durabilityEvidenceScope !== "capability-and-no-fallback"
	) {
		throw new TypeError("strict-IDB capability evidence is outside the frozen S0 boundary");
	}
	requireExactStrings(candidate.notProven, DURABILITY_NOT_PROVEN, "durability limits");
	return value as StrictIdbCapabilityEvidence;
}

function parseClearControl(value: unknown): ClearControlEvidence {
	const candidate = requireClosed(
		value,
		[
			"schemaVersion",
			"artifactKind",
			"method",
			"claim",
			"notMeasured",
			"payloadsReadableAfterReopen",
			"payloadsAbsentAfterClear",
			"noClearControlSurvived",
			"secondOriginSurvived",
		],
		"clear-control evidence"
	);
	if (
		candidate.schemaVersion !== 1 ||
		candidate.artifactKind !== "bucket-clear-control" ||
		candidate.method !== "whole-bucket-clear" ||
		candidate.claim !== "deletion-not-eviction" ||
		candidate.payloadsReadableAfterReopen !== true ||
		candidate.payloadsAbsentAfterClear !== true ||
		candidate.noClearControlSurvived !== true ||
		candidate.secondOriginSurvived !== true
	) {
		throw new TypeError("clear-control evidence is outside the frozen S0 boundary");
	}
	requireExactStrings(candidate.notMeasured, NOT_MEASURED, "not-measured claims");
	return value as ClearControlEvidence;
}

function parseDecision(value: unknown): DecisionEvidence {
	const candidate = requireClosed(
		value,
		[
			"schemaVersion",
			"artifactKind",
			"chosen",
			"measurementArtifactDigests",
			"sameDefaultBucket",
			"sameEvictionBehavior",
			"realPressureEviction",
			"clearEvidenceScoringWeight",
			"custodyFateSharingSurface",
			"crashAtomicityMechanism",
			"implementationRisk",
			"consequences",
		],
		"decision evidence"
	);
	const pressure = requireClosed(
		candidate.realPressureEviction,
		["status", "scope", "engineBuilds", "basis", "reason", "revisitTrigger", "consumer"],
		"pressure-eviction boundary"
	);
	const digests = requireArray(candidate.measurementArtifactDigests, "measurement artifact digests");
	const engineBuilds = requireArray(pressure.engineBuilds, "pressure engine builds");
	const basis = requireArray(pressure.basis, "pressure basis");
	const consequences = requireArray(candidate.consequences, "decision consequences");
	if (
		candidate.schemaVersion !== 1 ||
		candidate.artifactKind !== "storage-substrate-decision" ||
		(candidate.chosen !== "opfs" && candidate.chosen !== "idb-strict") ||
		digests.length === 0 ||
		digests.some((digest) => typeof digest !== "string" || !SHA256.test(digest)) ||
		candidate.sameDefaultBucket !== "normative" ||
		candidate.sameEvictionBehavior !== "unmeasured" ||
		pressure.status !== "unautomatable" ||
		pressure.scope !== "ordinary-web/playwright" ||
		engineBuilds.length === 0 ||
		engineBuilds.some((item) => typeof item !== "string" || item.length === 0) ||
		basis.length === 0 ||
		basis.some((item) => typeof item !== "string" || item.length === 0) ||
		pressure.revisitTrigger !== "deterministic-supported-trigger" ||
		pressure.consumer !== "phase-5-signer-profile-eviction-matrix-and-pre-release-real-device-blocker" ||
		candidate.clearEvidenceScoringWeight !== "none" ||
		consequences.length === 0 ||
		consequences.some((item) => typeof item !== "string" || item.length === 0)
	) {
		throw new TypeError("decision evidence is outside the frozen S0 boundary");
	}
	requireNonEmpty(pressure.reason, "pressure reason");
	requireNonEmpty(candidate.custodyFateSharingSurface, "custody fate-sharing surface");
	requireNonEmpty(candidate.crashAtomicityMechanism, "crash atomicity mechanism");
	requireNonEmpty(candidate.implementationRisk, "implementation risk");
	return value as DecisionEvidence;
}

/**
 * Parses one private Phase 2-spike evidence artifact against the S0 scaffold.
 * @param value - Untrusted candidate artifact.
 * @returns The validated private evidence variant.
 */
export function parseSpikeEvidence(value: unknown): SpikeEvidence {
	if (typeof value !== "object" || value === null) throw new TypeError("spike evidence must be an object");
	const kind = (value as Record<string, unknown>).artifactKind;
	if (kind === "substrate-measurement") return parseMeasurement(value);
	if (kind === "strict-idb-capability") return parseStrictIdbCapability(value);
	if (kind === "bucket-clear-control") return parseClearControl(value);
	if (kind === "storage-substrate-decision") return parseDecision(value);
	throw new TypeError("spike evidence has an unknown artifact kind");
}
