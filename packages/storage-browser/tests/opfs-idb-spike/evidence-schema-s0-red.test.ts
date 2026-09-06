import { describe, expect, it } from "vitest";

import {
	DURABILITY_NOT_PROVEN,
	NOT_MEASURED,
	parseSpikeEvidence,
	VALID_CLEAR_CONTROL_EVIDENCE,
	VALID_DECISION_EVIDENCE,
	VALID_MEASUREMENT_EVIDENCE,
	VALID_STRICT_IDB_CAPABILITY_EVIDENCE,
} from "./fixtures/evidence-schema.js";

describe("Phase 2-spike S0 evidence boundary", () => {
	it("accepts the positive measurement, deletion control, and separate decision fixtures", () => {
		for (const fixture of [
			VALID_MEASUREMENT_EVIDENCE,
			VALID_STRICT_IDB_CAPABILITY_EVIDENCE,
			VALID_CLEAR_CONTROL_EVIDENCE,
			VALID_DECISION_EVIDENCE,
		]) {
			expect(parseSpikeEvidence(fixture)).toEqual(fixture);
		}
	});

	it("rejects measurement artifacts that select or recommend a substrate", () => {
		const acceptedAliases = (["winner", "chosen", "preferred"] as const).filter((alias) => {
			try {
				parseSpikeEvidence({ ...VALID_MEASUREMENT_EVIDENCE, [alias]: "idb-strict" });
				return true;
			} catch {
				return false;
			}
		});
		expect(acceptedAliases).toEqual([]);
	});

	it("requires exactly the outcome-neutral OPFS and strict-IDB arms", () => {
		const wrongOrder = {
			...VALID_MEASUREMENT_EVIDENCE,
			arms: [VALID_MEASUREMENT_EVIDENCE.arms[1], VALID_MEASUREMENT_EVIDENCE.arms[0]],
		};
		const failedOracle = {
			...VALID_MEASUREMENT_EVIDENCE,
			arms: [{ ...VALID_MEASUREMENT_EVIDENCE.arms[0], postState: "oracle-fail" }, VALID_MEASUREMENT_EVIDENCE.arms[1]],
		};
		const threshold = { ...VALID_MEASUREMENT_EVIDENCE, passingThresholdMilliseconds: 20 };
		const malformed = [
			{ ...VALID_MEASUREMENT_EVIDENCE, arms: [VALID_MEASUREMENT_EVIDENCE.arms[0]] },
			wrongOrder,
			failedOracle,
			threshold,
			{ ...VALID_MEASUREMENT_EVIDENCE, commandScriptDigest: "not-a-digest" },
			{ ...VALID_MEASUREMENT_EVIDENCE, opsExecuted: 0 },
		];
		for (const candidate of malformed) expect(() => parseSpikeEvidence(candidate)).toThrow(TypeError);
	});

	it("freezes Worker context, command parity, engine identity, and timing admission", () => {
		const malformed = [
			{ ...VALID_MEASUREMENT_EVIDENCE, executionOwner: "page" },
			{ ...VALID_MEASUREMENT_EVIDENCE, crossOriginIsolated: false },
			{ ...VALID_MEASUREMENT_EVIDENCE, engineBuild: "" },
			{ ...VALID_MEASUREMENT_EVIDENCE, concurrencyShape: "multi-writer" },
			{ ...VALID_MEASUREMENT_EVIDENCE, contendedMultiTab: "measured" },
			{ ...VALID_MEASUREMENT_EVIDENCE, commandParity: "arm-specific" },
			{ ...VALID_MEASUREMENT_EVIDENCE, correctnessBeforeTiming: false },
			{ ...VALID_MEASUREMENT_EVIDENCE, timingPassingThreshold: "20ms" },
		];
		for (const candidate of malformed) expect(() => parseSpikeEvidence(candidate)).toThrow(TypeError);
	});

	it("requires live strict-IDB read-back and a zero-write fatal downgrade control", () => {
		const malformed = [
			{ ...VALID_STRICT_IDB_CAPABILITY_EVIDENCE, requestedDurability: "relaxed" },
			{ ...VALID_STRICT_IDB_CAPABILITY_EVIDENCE, observedDurability: "relaxed" },
			{ ...VALID_STRICT_IDB_CAPABILITY_EVIDENCE, observedFrom: "requested-option-echo" },
			{ ...VALID_STRICT_IDB_CAPABILITY_EVIDENCE, nonStrictOutcome: "fallback" },
			{ ...VALID_STRICT_IDB_CAPABILITY_EVIDENCE, nonStrictWritesCommitted: 1 },
			{ ...VALID_STRICT_IDB_CAPABILITY_EVIDENCE, durabilityEvidenceScope: "capability-only" },
			{ ...VALID_STRICT_IDB_CAPABILITY_EVIDENCE, notProven: DURABILITY_NOT_PROVEN.slice(0, 2) },
		];
		for (const candidate of malformed) expect(() => parseSpikeEvidence(candidate)).toThrow(TypeError);
	});

	it("keeps whole-bucket clearing deletion-only and requires every non-claim control", () => {
		const reordered = [...NOT_MEASURED].reverse();
		const malformed = [
			{ ...VALID_CLEAR_CONTROL_EVIDENCE, method: "pressure-eviction" },
			{ ...VALID_CLEAR_CONTROL_EVIDENCE, claim: "co-eviction" },
			{ ...VALID_CLEAR_CONTROL_EVIDENCE, notMeasured: NOT_MEASURED.slice(1) },
			{ ...VALID_CLEAR_CONTROL_EVIDENCE, notMeasured: reordered },
			{ ...VALID_CLEAR_CONTROL_EVIDENCE, payloadsReadableAfterReopen: false },
			{ ...VALID_CLEAR_CONTROL_EVIDENCE, payloadsAbsentAfterClear: false },
			{ ...VALID_CLEAR_CONTROL_EVIDENCE, noClearControlSurvived: false },
			{ ...VALID_CLEAR_CONTROL_EVIDENCE, secondOriginSurvived: false },
			{ ...VALID_CLEAR_CONTROL_EVIDENCE, evictionVerdict: "same" },
		];
		for (const candidate of malformed) expect(() => parseSpikeEvidence(candidate)).toThrow(TypeError);
	});

	it("keeps selection in the decision and cites measured artifact digests", () => {
		const malformed = [
			{ ...VALID_DECISION_EVIDENCE, chosen: "sqlite" },
			{ ...VALID_DECISION_EVIDENCE, measurementArtifactDigests: [] },
			{ ...VALID_DECISION_EVIDENCE, measurementArtifactDigests: ["x".repeat(64)] },
			{ ...VALID_DECISION_EVIDENCE, sameDefaultBucket: "measured" },
			{ ...VALID_DECISION_EVIDENCE, sameEvictionBehavior: "same" },
			{ ...VALID_DECISION_EVIDENCE, clearEvidenceScoringWeight: "tie-breaker" },
			{ ...VALID_DECISION_EVIDENCE, custodyFateSharingSurface: "" },
			{ ...VALID_DECISION_EVIDENCE, crashAtomicityMechanism: "" },
			{ ...VALID_DECISION_EVIDENCE, implementationRisk: "" },
			{ ...VALID_DECISION_EVIDENCE, consequences: [] },
		];
		for (const candidate of malformed) expect(() => parseSpikeEvidence(candidate)).toThrow(TypeError);
	});

	it("scopes unautomatable pressure eviction and freezes its revisit owner", () => {
		const base = VALID_DECISION_EVIDENCE.realPressureEviction;
		const malformedPressure = [
			{ ...base, status: "measured" },
			{ ...base, scope: "all-browser-behavior" },
			{ ...base, engineBuilds: [] },
			{ ...base, basis: [] },
			{ ...base, reason: "" },
			{ ...base, revisitTrigger: "manual-opinion" },
			{ ...base, consumer: "phase-2d" },
		];
		for (const realPressureEviction of malformedPressure) {
			expect(() => parseSpikeEvidence({ ...VALID_DECISION_EVIDENCE, realPressureEviction })).toThrow(TypeError);
		}
	});

	it("rejects unknown kinds and closed-record violations", () => {
		const hidden = { ...VALID_MEASUREMENT_EVIDENCE };
		Object.defineProperty(hidden, "hidden", { enumerable: false, value: true });
		const symbol = { ...VALID_MEASUREMENT_EVIDENCE, [Symbol("extra")]: true };
		const accessor = { ...VALID_MEASUREMENT_EVIDENCE };
		Object.defineProperty(accessor, "runId", { enumerable: true, get: (): string => "accessor" });
		const malformed = [
			null,
			{},
			{ ...VALID_MEASUREMENT_EVIDENCE, artifactKind: "other" },
			{ ...VALID_MEASUREMENT_EVIDENCE, runId: "", extra: true },
			hidden,
			symbol,
			accessor,
		];
		for (const candidate of malformed) expect(() => parseSpikeEvidence(candidate)).toThrow(TypeError);
	});
});
