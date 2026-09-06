import { describe, expect, it, vi } from "vitest";

import {
	EXPECTED_REFERENCE_SAMPLES,
	SHADOW_CLOSES,
	type ShadowCloseObservation,
	type ShadowComparisonModule,
} from "./fixtures/phase-4d-v3/shadow-contract.js";
import {
	assertReferenceAuthorizationRejectsForeignWriter,
	assertReferenceSubset,
	authenticateReferenceClosure,
	buildShadowRun,
	currentAndReferenceAgree,
	runLivePeerCheckpoint,
} from "./fixtures/phase-4d-v3/shadow-driver.js";

const OWNER_SPECIFIER = "@ts-drp/test-utils/shadow-comparison";
let owner: ShadowComparisonModule | undefined;
try {
	owner = await vi.importActual<ShadowComparisonModule>(OWNER_SPECIFIER);
} catch {
	owner = undefined;
}

const observations = await buildShadowRun();
const ownerReady = owner !== undefined && typeof owner.compareShadowRun === "function";

function cloneObservation(
	entry: ShadowCloseObservation,
	overrides: Partial<ShadowCloseObservation> = {}
): ShadowCloseObservation {
	return { ...entry, ...overrides };
}

function compareRun(
	selected: readonly ShadowCloseObservation[]
): ReturnType<ShadowComparisonModule["compareShadowRun"]> {
	if (owner === undefined) throw new TypeError("shadow comparator owner is absent");
	return owner.compareShadowRun({
		expectedCloses: SHADOW_CLOSES,
		expectedReferenceSamples: EXPECTED_REFERENCE_SAMPLES,
		observations: selected,
	});
}

describe("Phase 4d independent shadow comparison RED", () => {
	it("authenticates the pinned reference closure and independently binds the v3 state domain", async () => {
		expect(Object.keys(authenticateReferenceClosure())).toHaveLength(4);
		expect(await currentAndReferenceAgree({ map: { alpha: "one" }, set: ["red"], total: 7 })).toBe(true);
	});

	it("rejects permissive reference authorization and values outside the byte-identical subset", async () => {
		await expect(assertReferenceAuthorizationRejectsForeignWriter()).resolves.toBeUndefined();
		expect(() => assertReferenceSubset(-0)).toThrow(/integer subset/u);
		expect(() => assertReferenceSubset(new Float32Array([1]))).toThrow(/plain object/u);
	});

	it("generates all 100 close observations with positive liveness and an explicit fixed reference sample", () => {
		expect(observations).toHaveLength(SHADOW_CLOSES);
		expect(observations.every((entry) => entry.appliedVertices > 0)).toBe(true);
		expect(observations.every((entry) => entry.engineA.exactCanonicalStateBytes.byteLength > 0)).toBe(true);
		expect(observations.filter((entry) => entry.reference.kind === "observed")).toHaveLength(
			EXPECTED_REFERENCE_SAMPLES
		);
	});

	it("observes two independently recovered live peers with identical order, state, and D.99 payload", async () => {
		const live = await runLivePeerCheckpoint();
		expect(live.engineA.order.length).toBeGreaterThan(0);
		expect(live.engineA).toMatchObject({
			anchor: live.engineB.anchor,
			blueprintDigest: live.engineB.blueprintDigest,
			epoch: live.engineB.epoch,
			objectId: live.engineB.objectId,
			order: live.engineB.order,
			payloadDigest: live.engineB.payloadDigest,
			stateDigest: live.engineB.stateDigest,
		});
		expect(live.engineA.exactCanonicalStateBytes).toEqual(live.engineB.exactCanonicalStateBytes);
	});

	it("has exactly one missing comparator readiness failure", () => {
		expect(ownerReady).toBe(true);
	});

	it.skipIf(!ownerReady)("accepts the complete genuine run and reports exact liveness", () => {
		expect(compareRun(observations)).toMatchObject({
			appliedVertices: SHADOW_CLOSES * 3,
			closes: SHADOW_CLOSES,
			kind: "agreement",
			nonemptyStates: SHADOW_CLOSES,
			ok: true,
			referenceSamples: EXPECTED_REFERENCE_SAMPLES,
		});
	});

	it.skipIf(!ownerReady)("distinguishes identity, state, order, payload, and partial-run mutants", () => {
		const first = observations[0];
		if (first === undefined) throw new TypeError("shadow fixture is empty");
		const identityMutant = [
			cloneObservation(first, {
				archival: { ...first.archival, anchor: "ff".repeat(32) },
			}),
			...observations.slice(1),
		];
		expect(compareRun(identityMutant)).toMatchObject({
			kind: "identity-mismatch",
			ok: false,
		});

		const stateBytes = first.archival.exactCanonicalStateBytes.slice();
		stateBytes[stateBytes.length - 1] = (stateBytes[stateBytes.length - 1] ?? 0) ^ 1;
		const stateMutant = [
			cloneObservation(first, {
				archival: { ...first.archival, exactCanonicalStateBytes: stateBytes },
			}),
			...observations.slice(1),
		];
		expect(compareRun(stateMutant)).toMatchObject({
			kind: "state-mismatch",
			ok: false,
		});

		const orderMutant = [
			cloneObservation(first, {
				engineB: { ...first.engineB, order: [...first.engineB.order].reverse() },
			}),
			...observations.slice(1),
		];
		expect(compareRun(orderMutant)).toMatchObject({
			kind: "order-mismatch",
			ok: false,
		});

		const payloadMutant = [
			cloneObservation(first, {
				engineB: { ...first.engineB, payloadDigest: "00".repeat(32) },
			}),
			...observations.slice(1),
		];
		expect(compareRun(payloadMutant)).toMatchObject({
			kind: "payload-mismatch",
			ok: false,
		});

		expect(compareRun(observations.slice(0, -1))).toMatchObject({ kind: "invalid-observation", ok: false });
	});

	it.skipIf(!ownerReady)("rejects ignored reference, digest-only, and zero-liveness mutants", () => {
		const sampledIndex = observations.findIndex((entry) => entry.reference.kind === "observed");
		const sampled = observations[sampledIndex];
		if (sampled === undefined || sampled.reference.kind !== "observed") {
			throw new TypeError("shadow reference sample is absent");
		}
		const referenceBytes = sampled.reference.value.exactCanonicalStateBytes.slice();
		referenceBytes[referenceBytes.length - 1] = (referenceBytes[referenceBytes.length - 1] ?? 0) ^ 1;
		const referenceMutant = observations.map((entry, index) =>
			index === sampledIndex
				? cloneObservation(entry, {
						reference: {
							kind: "observed",
							value: { ...sampled.reference.value, exactCanonicalStateBytes: referenceBytes },
						},
					})
				: entry
		);
		expect(referenceBytes).not.toEqual(sampled.reference.value.exactCanonicalStateBytes);
		expect(compareRun(referenceMutant)).toMatchObject({ kind: "state-mismatch", ok: false });

		const missingReference = observations.map((entry, index) =>
			index === sampledIndex ? cloneObservation(entry, { reference: { kind: "not-sampled" } }) : entry
		);
		expect(compareRun(missingReference)).toMatchObject({ kind: "invalid-observation", ok: false });

		const first = observations[0];
		if (first === undefined) throw new TypeError("shadow fixture is empty");
		const digestMutant = [
			cloneObservation(first, { archival: { ...first.archival, stateDigest: "00".repeat(32) } }),
			...observations.slice(1),
		];
		expect(compareRun(digestMutant)).toMatchObject({ kind: "state-mismatch", ok: false });

		const zeroVertices = observations.map((entry) => cloneObservation(entry, { appliedVertices: 0 }));
		expect(compareRun(zeroVertices)).toMatchObject({ kind: "invalid-observation", ok: false });

		const emptyStates = observations.map((entry) =>
			cloneObservation(entry, {
				archival: { ...entry.archival, exactCanonicalStateBytes: new Uint8Array() },
				engineA: { ...entry.engineA, exactCanonicalStateBytes: new Uint8Array() },
				engineB: { ...entry.engineB, exactCanonicalStateBytes: new Uint8Array() },
				reference:
					entry.reference.kind === "observed"
						? {
								kind: "observed",
								value: { ...entry.reference.value, exactCanonicalStateBytes: new Uint8Array() },
							}
						: entry.reference,
			})
		);
		expect(compareRun(emptyStates)).toMatchObject({ kind: "invalid-observation", ok: false });
	});
});
