/* eslint import/no-unresolved: "off" */
import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
	createCreatorCloseFixture,
	CREATOR_PRIVATE_KEY_SEED_HEX,
	successorTrustRecord,
	trustRecordForAnchor,
} from "./fixtures/phase-5e-v3/creator-close-contract.js";
import {
	classifyIndependentAdvance,
	classifyIndependentTrustClosure,
	CREATOR_ADVANCE_REJECTIONS,
	CREATOR_CONTINUITY_STATES,
	CREATOR_LIFECYCLE_STATES,
	CREATOR_LIVE_CLOSE_EXPORTS,
	CREATOR_TRUST_TEXT,
	creatorLiveCloseReadiness,
	exactKeys,
	expectedCombinedClosure,
	type IndependentAdvanceClassification,
	REPOSITORY_ROOT,
	REQUIRED_GREEN_PATHS,
	REQUIRED_RED_PATHS,
	resolveIndependentAmbiguousSwap,
} from "./fixtures/phase-5e-v3/creator-live-close-contract.js";

const readiness = creatorLiveCloseReadiness();

function ref(digest: string, byteLength = 32): Readonly<{ byteLength: number; digest: string }> {
	return Object.freeze({ byteLength, digest });
}

function bytesRef(bytes: Uint8Array): Readonly<{ byteLength: number; digest: string }> {
	return ref(Buffer.from(hashDomain("ts-drp-storage/blob/v1", bytes)).toString("hex"), bytes.byteLength);
}

function hexBytes(value: string): Uint8Array {
	return new Uint8Array(Buffer.from(value, "hex"));
}

function changedTrustBytes(bytes: Uint8Array, changes: Readonly<Record<string, unknown>>): Uint8Array {
	return encodeCanonical({ ...(decodeCanonical(bytes) as Readonly<Record<string, unknown>>), ...changes });
}

describe.sequential("Phase 5e genuine creator live close RED", () => {
	it("freezes the exact five RED and exact nine GREEN owners", () => {
		expect(REQUIRED_RED_PATHS).toHaveLength(5);
		expect(REQUIRED_GREEN_PATHS).toHaveLength(9);
		expect(REQUIRED_RED_PATHS.every((path) => readFileSync(resolve(REPOSITORY_ROOT, path)).byteLength > 0)).toBe(true);
		expect(REQUIRED_GREEN_PATHS).toEqual([
			"packages/control-plane/src/creator-trust-advance.ts",
			"packages/control-plane/package.json",
			"packages/node/src/creator-close.ts",
			"packages/node/src/v3-live.ts",
			"packages/node/package.json",
			"pnpm-lock.yaml",
			"examples/v3-room/src/index.ts",
			"examples/v3-chat/src/index.ts",
			"vite.config.mts",
		]);
	});

	it("pins separate honest trust, continuity and lifecycle projections", () => {
		expect(CREATOR_TRUST_TEXT).toBe("Creator-certified; one of one; not Byzantine-fault-tolerant.");
		expect(CREATOR_CONTINUITY_STATES).toEqual(["continuous", "relearning", "stalled"]);
		expect(CREATOR_LIFECYCLE_STATES).toEqual(["active", "sealed", "successor-pending-adoption"]);
		expect(CREATOR_ADVANCE_REJECTIONS).toEqual([
			"BYTE_REPLAY",
			"EPOCH_EQUIVOCATION",
			"EPOCH_GAP",
			"ROLLBACK",
			"TRUST_CLOSURE_INVALID",
		]);
	});

	it("independently classifies replay, equivocation, rollback, gap and the exact successor without writes", async () => {
		const fixture = await createCreatorCloseFixture();
		const currentTrustBytes = trustRecordForAnchor(
			fixture,
			fixture.exactCanonicalCurrentAnchorPreimageBytes,
			fixture.currentAnchorSignature
		);
		const successorSignature = ed25519.sign(
			hexBytes(fixture.successorAnchorDigest),
			hexBytes(CREATOR_PRIVATE_KEY_SEED_HEX)
		);
		const successorTrustBytes = successorTrustRecord(fixture, successorSignature);
		expect(classifyIndependentAdvance(currentTrustBytes, successorTrustBytes)).toEqual({
			kind: "successor",
			ok: true,
		});
		const successorTrust = decodeCanonical(successorTrustBytes) as Readonly<Record<string, unknown>>;
		expect(successorTrust.currentEpoch).toBe(1);
		for (const [candidate, reason] of [
			[currentTrustBytes, "BYTE_REPLAY"],
			[changedTrustBytes(currentTrustBytes, { currentAnchorDigest: "f".repeat(64) }), "EPOCH_EQUIVOCATION"],
			[changedTrustBytes(currentTrustBytes, { currentEpoch: -1 }), "ROLLBACK"],
			[changedTrustBytes(successorTrustBytes, { currentEpoch: 2 }), "EPOCH_GAP"],
			[
				changedTrustBytes(successorTrustBytes, {
					exactCanonicalCurrentAnchorPreimageBytes: encodeCanonical({
						...(decodeCanonical(fixture.exactCanonicalSuccessorAnchorPreimageBytes) as Readonly<
							Record<string, unknown>
						>),
						previousAnchor: "c".repeat(64),
					}),
				}),
				"TRUST_CLOSURE_INVALID",
			],
		] as const) {
			expect(classifyIndependentAdvance(currentTrustBytes, candidate)).toEqual({ ok: false, reason });
		}
	});

	it("replaces exactly one trust ref while preserving every non-trust ref and adding proof refs", () => {
		const currentTrust = ref("1".repeat(64), 100);
		const liveProjection = ref("2".repeat(64), 200);
		const retainedAuxiliary = ref("3".repeat(64), 300);
		const successorTrust = ref("4".repeat(64), 101);
		const cut = ref("5".repeat(64), 500);
		const commitQc = ref("6".repeat(64), 600);
		const closure = expectedCombinedClosure({
			current: [currentTrust, liveProjection, retainedAuxiliary],
			currentTrustRef: currentTrust,
			proofRefs: [cut, commitQc],
			successorTrustRef: successorTrust,
		});
		expect(closure).toEqual([liveProjection, retainedAuxiliary, successorTrust, cut, commitQc]);
		expect(closure).not.toContainEqual(currentTrust);
		expect(
			classifyIndependentTrustClosure({
				current: [currentTrust, liveProjection, retainedAuxiliary],
				currentTrustRef: currentTrust,
				proofRefs: [cut, commitQc],
				proposed: closure,
				successorTrustRef: successorTrust,
			})
		).toEqual({ kind: "successor", ok: true });
		for (const proposed of [
			closure.filter(({ digest }) => digest !== cut.digest),
			closure.filter(({ digest }) => digest !== commitQc.digest),
			[...closure, currentTrust],
		]) {
			expect(
				classifyIndependentTrustClosure({
					current: [currentTrust, liveProjection, retainedAuxiliary],
					currentTrustRef: currentTrust,
					proofRefs: [cut, commitQc],
					proposed,
					successorTrustRef: successorTrust,
				})
			).toEqual({ ok: false, reason: "TRUST_CLOSURE_INVALID" });
		}
		expect(() =>
			expectedCombinedClosure({
				current: [currentTrust, liveProjection],
				currentTrustRef: currentTrust,
				proofRefs: [liveProjection],
				successorTrustRef: successorTrust,
			})
		).toThrow("unique");
	});

	it("accepts ambiguous head success only by exact successor reopen", () => {
		const expected = {
			closureDigest: "a".repeat(64),
			generationId: "b".repeat(64),
			objectId: `creator:${"c".repeat(32)}`,
			revision: 2,
		};
		expect(resolveIndependentAmbiguousSwap(expected, expected)).toBe("committed");
		for (const changed of [
			{ ...expected, closureDigest: "d".repeat(64) },
			{ ...expected, generationId: "e".repeat(64) },
			{ ...expected, objectId: `creator:${"d".repeat(32)}` },
			{ ...expected, revision: 3 },
		]) {
			expect(resolveIndependentAmbiguousSwap(expected, changed)).toBe("conflict");
		}
	});

	it.skipIf(!readiness.ready)("forbids activation, pruning and a second combined-head owner", () => {
		const closeSource = readFileSync(resolve(REPOSITORY_ROOT, "packages/node/src/creator-close.ts"), "utf8");
		const advanceSource = readFileSync(
			resolve(REPOSITORY_ROOT, "packages/control-plane/src/creator-trust-advance.ts"),
			"utf8"
		);
		expect(closeSource.match(/\.swapHead\s*\(/gu) ?? []).toHaveLength(1);
		expect(advanceSource).not.toMatch(/\.swapHead\s*\(/u);
		for (const source of [closeSource, advanceSource]) {
			expect(source).not.toMatch(/activateV3LivePlane|activateSnapshotTransfer|prune|adoptSuccessor/iu);
		}
	});

	it("[RED readiness] requires the live close and successor-classifier owners", () => {
		expect(readiness, `missing D.107d owners: ${readiness.missing.join(", ")}`).toEqual({ missing: [], ready: true });
	});

	it.skipIf(!readiness.ready)("keeps both new runtime subpaths closed and binds every classifier verdict", async () => {
		const [controlPlane, node] = await Promise.all([
			import("@ts-drp/control-plane/creator-trust-advance"),
			import("@ts-drp/node/creator-close"),
		]);
		expect(exactKeys(controlPlane)).toEqual(CREATOR_LIVE_CLOSE_EXPORTS.controlPlane);
		expect(exactKeys(node)).toEqual(CREATOR_LIVE_CLOSE_EXPORTS.node);

		const fixture = await createCreatorCloseFixture();
		const currentBytes = trustRecordForAnchor(
			fixture,
			fixture.exactCanonicalCurrentAnchorPreimageBytes,
			fixture.currentAnchorSignature
		);
		const successorBytes = successorTrustRecord(
			fixture,
			ed25519.sign(hexBytes(fixture.successorAnchorDigest), hexBytes(CREATOR_PRIVATE_KEY_SEED_HEX))
		);
		const liveRef = ref("a".repeat(64), 9_000);
		const cutRef = ref("b".repeat(64), 9_001);
		const commitQcRef = ref("c".repeat(64), 9_002);
		const inspect = controlPlane.inspectCreatorTrustAdvance as (input: unknown) => IndependentAdvanceClassification;
		for (const candidateBytes of [
			successorBytes,
			currentBytes,
			changedTrustBytes(currentBytes, { currentAnchorDigest: "f".repeat(64) }),
			changedTrustBytes(currentBytes, { currentEpoch: -1 }),
			changedTrustBytes(successorBytes, { currentEpoch: 2 }),
		]) {
			const currentTrustRef = bytesRef(currentBytes);
			const successorTrustRef = bytesRef(candidateBytes);
			const current = [currentTrustRef, liveRef];
			const proposed = expectedCombinedClosure({
				current,
				currentTrustRef,
				proofRefs: [cutRef, commitQcRef],
				successorTrustRef,
			});
			expect(
				inspect({
					current: { candidates: [{ bytes: currentBytes, ref: currentTrustRef }], closure: current },
					proofRefs: [cutRef, commitQcRef],
					proposed: { candidates: [{ bytes: candidateBytes, ref: successorTrustRef }], closure: proposed },
				})
			).toEqual(classifyIndependentAdvance(currentBytes, candidateBytes));
		}

		const currentTrustRef = bytesRef(currentBytes);
		const successorTrustRef = bytesRef(successorBytes);
		const secondTrustBytes = changedTrustBytes(currentBytes, { currentAnchorDigest: "e".repeat(64) });
		const secondTrustRef = bytesRef(secondTrustBytes);
		for (const proposed of [
			{ candidates: [], closure: [liveRef, cutRef, commitQcRef] },
			{
				candidates: [
					{ bytes: successorBytes, ref: successorTrustRef },
					{ bytes: secondTrustBytes, ref: secondTrustRef },
				],
				closure: [liveRef, successorTrustRef, secondTrustRef, cutRef, commitQcRef],
			},
			{
				candidates: [{ bytes: successorBytes, ref: successorTrustRef }],
				closure: [liveRef, successorTrustRef, commitQcRef],
			},
			{
				candidates: [{ bytes: successorBytes, ref: successorTrustRef }],
				closure: [liveRef, successorTrustRef, cutRef],
			},
		]) {
			expect(
				inspect({
					current: { candidates: [{ bytes: currentBytes, ref: currentTrustRef }], closure: [currentTrustRef, liveRef] },
					proofRefs: [cutRef, commitQcRef],
					proposed,
				})
			).toEqual({ ok: false, reason: "TRUST_CLOSURE_INVALID" });
		}
	});
});
