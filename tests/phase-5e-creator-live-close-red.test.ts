/* eslint import/no-unresolved: "off" */
import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { createCreatorCloseFixture } from "./fixtures/phase-5e-v3/creator-close-contract.js";
import {
	classifyIndependentAdvance,
	CREATOR_ADVANCE_REJECTIONS,
	CREATOR_CONTINUITY_STATES,
	CREATOR_LIFECYCLE_STATES,
	CREATOR_LIVE_CLOSE_EXPORTS,
	CREATOR_TRUST_TEXT,
	creatorLiveCloseReadiness,
	exactKeys,
	expectedCombinedClosure,
	REPOSITORY_ROOT,
	REQUIRED_GREEN_PATHS,
	REQUIRED_RED_PATHS,
	resolveIndependentAmbiguousSwap,
} from "./fixtures/phase-5e-v3/creator-live-close-contract.js";

const readiness = creatorLiveCloseReadiness();

function ref(digest: string, byteLength = 32): Readonly<{ byteLength: number; digest: string }> {
	return Object.freeze({ byteLength, digest });
}

describe.sequential("Phase 5e genuine creator live close RED", () => {
	it("freezes the exact five RED and exact eight GREEN owners", () => {
		expect(REQUIRED_RED_PATHS).toHaveLength(5);
		expect(REQUIRED_GREEN_PATHS).toHaveLength(8);
		expect(REQUIRED_RED_PATHS.every((path) => readFileSync(resolve(REPOSITORY_ROOT, path)).byteLength > 0)).toBe(true);
		expect(REQUIRED_GREEN_PATHS).toEqual([
			"packages/control-plane/src/creator-trust-advance.ts",
			"packages/control-plane/package.json",
			"packages/node/src/creator-close.ts",
			"packages/node/src/v3-live.ts",
			"packages/node/package.json",
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
		const current = { anchor: fixture.anchorDigest, epoch: 0 } as const;
		const successorTrustBytes = encodeCanonical({
			currentAnchorDigest: fixture.successorAnchorDigest,
			currentEpoch: 1,
		});
		expect(classifyIndependentAdvance(current, successorTrustBytes)).toEqual({
			kind: "successor",
			ok: true,
		});
		const successorTrust = decodeCanonical(successorTrustBytes) as Readonly<Record<string, unknown>>;
		expect(successorTrust.currentEpoch).toBe(1);
		for (const [candidate, reason] of [
			[encodeCanonical({ currentAnchorDigest: fixture.anchorDigest, currentEpoch: 0 }), "BYTE_REPLAY"],
			[encodeCanonical({ currentAnchorDigest: "f".repeat(64), currentEpoch: 0 }), "EPOCH_EQUIVOCATION"],
			[encodeCanonical({ currentAnchorDigest: "e".repeat(64), currentEpoch: -1 }), "ROLLBACK"],
			[encodeCanonical({ currentAnchorDigest: "d".repeat(64), currentEpoch: 2 }), "EPOCH_GAP"],
		] as const) {
			expect(classifyIndependentAdvance(current, candidate)).toEqual({ ok: false, reason });
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
			{ ...expected, revision: 3 },
		]) {
			expect(resolveIndependentAmbiguousSwap(expected, changed)).toBe("conflict");
		}
	});

	it("forbids duplicated consensus, activation, pruning and a second head owner", () => {
		for (const path of REQUIRED_GREEN_PATHS) {
			if (!readiness.ready && !readiness.missing.every((missing) => missing !== path)) continue;
			const source = readFileSync(resolve(REPOSITORY_ROOT, path), "utf8");
			if (path.endsWith("creator-close.ts") || path.endsWith("creator-trust-advance.ts")) continue;
			expect(source).not.toContain("activateSuccessorEpoch");
			expect(source).not.toContain("pruneSealedEpoch");
		}
	});

	it("[RED readiness] requires the live close and successor-classifier owners", () => {
		expect(readiness, `missing D.107d owners: ${readiness.missing.join(", ")}`).toEqual({ missing: [], ready: true });
	});

	it.skipIf(!readiness.ready)("keeps both new runtime subpaths closed", async () => {
		const [controlPlane, node] = await Promise.all([
			import("@ts-drp/control-plane/creator-trust-advance"),
			import("@ts-drp/node/creator-close"),
		]);
		expect(exactKeys(controlPlane)).toEqual(CREATOR_LIVE_CLOSE_EXPORTS.controlPlane);
		expect(exactKeys(node)).toEqual(CREATOR_LIVE_CLOSE_EXPORTS.node);
	});
});
