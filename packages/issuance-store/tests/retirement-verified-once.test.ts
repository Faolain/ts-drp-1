import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { beforeEach, describe, expect, it } from "vitest";
import {
	advanceIssuanceRetirementControl,
	captureIssuanceRetirementControl,
	clearIssuanceRetirementVerifiedOnce,
	closeIssuanceRetirementProtectedRecords,
	decodeIssuanceRetirementControl,
	encodeIssuanceRetirementControl,
	issuanceRetirementBytesEqual,
	issuanceRetirementPreparationWithPlanRewrite,
	issuanceRetirementVerificationCounts,
	reconstructIssuanceRetirementSourceRows,
	issuanceRetirementCommitRows,
	type DurableIssuanceRetirementControl,
	type IssuanceRetirementRows,
} from "../src/retirement.js";
import { d109bCommit } from "../../../tests/fixtures/phase-6b/issuance-retention-contract.js";

// Verify-once contract for the durable retirement control. Decoding is decode ->
// capture -> re-encode -> exact byte compare, and the control embeds whole canonical
// settlement-plan bytes (each re-verified the same way). The result is a pure function
// of the exact input bytes, so byte-identical input needs verifying only once; any other
// bytes must be verified on their own.

const scope = { objectId: "verified-once-room", author: "writer" };
const contextBytes = encodeCanonical({ historicalSource: new Uint8Array(40_000).map((_, index) => index % 251) });
const context = { digest: hashDomain("ts-drp/settlement-source-context/v1", contextBytes), exactCanonicalContextBytes: contextBytes };
const born: DurableIssuanceRetirementControl = { kind: "v3-issuance-retirement-control-1", objectId: scope.objectId,
	incarnation: "c".repeat(64), revision: 0, sequence: 0, active: null, completed: null };

function rows(): IssuanceRetirementRows {
	const commits = Array.from({ length: 5 }, (_, sequence) => d109bCommit(scope, sequence, sequence));
	return {
		lineages: [{ ...scope, next: 5, exhausted: false, prunedThroughAuthorSequence: null }],
		issued: commits.map((commit) => ({ ...scope, authorSequence: commit.authorSequence, ...commit.envelope })),
		outbox: commits.map((commit) => ({ ...scope, authorSequence: commit.authorSequence,
			digest: commit.envelope.digest, publishState: "published" as const })),
		plans: [{ scope, revision: 7, fenceSequence: 4, sourceContexts: [context], entries: [0, 1, 2].map((sequence) => ({
			sourceContextDigest: context.digest, sourceSequence: sequence, sourceDigest: commits[sequence]!.envelope.digest,
			disposition: "rebase" as const, replacementSequence: sequence + 1 })) }],
	};
}

/** A completed retirement whose plan rewrite carries ~40 KB on each side. */
function completedControl(revision: number): DurableIssuanceRetirementControl {
	const source = rows();
	const protectedRecords = closeIssuanceRetirementProtectedRecords({ control: born, rows: source, throughEpoch: 1,
		protectedRecords: [] });
	const completed = issuanceRetirementPreparationWithPlanRewrite(born, { throughEpoch: 1,
		decisionDigest: "a".repeat(64), sourceProofDigest: "b".repeat(64), protectedRecords }, source);
	return captureIssuanceRetirementControl({ ...born, revision, sequence: 1, active: null, completed });
}

const planBytes = (control: DurableIssuanceRetirementControl) => control.completed!.planRewrite!.plans[0]!;

beforeEach(() => clearIssuanceRetirementVerifiedOnce());

describe("retirement control verify-once work counts", () => {
	it("decodes byte-identical control bytes with one full verification and no embedded plan re-verification", () => {
		const control = completedControl(2);
		expect(planBytes(control).before.byteLength).toBeGreaterThan(40_000);
		expect(planBytes(control).after.byteLength).toBeGreaterThan(40_000);
		const bytes = encodeIssuanceRetirementControl(control);
		expect(bytes.byteLength).toBeGreaterThan(80_000);
		clearIssuanceRetirementVerifiedOnce();
		// Six reads of one unchanged row: census, prune, commit x2, quote check and retain.
		for (let read = 0; read < 6; read++) expect(decodeIssuanceRetirementControl(bytes)).toEqual(control);
		const counts = issuanceRetirementVerificationCounts();
		console.info("six decodes of one control image", JSON.stringify(counts));
		expect(counts.control.verifications).toBe(1);
		// Both embedded plans are verified once each, and never again.
		expect(counts.plan.verifications).toBeLessThanOrEqual(2);
	});

	it("re-encodes and advances a decoded control without re-verifying unchanged embedded plan bytes", () => {
		const bytes = encodeIssuanceRetirementControl(completedControl(2));
		const decoded = decodeIssuanceRetirementControl(bytes);
		const settled = issuanceRetirementVerificationCounts().plan.verifications;
		for (let write = 0; write < 6; write++) {
			expect(issuanceRetirementBytesEqual(encodeIssuanceRetirementControl(decoded), bytes)).toBe(true);
			expect(advanceIssuanceRetirementControl(decoded).revision).toBe(3);
		}
		const counts = issuanceRetirementVerificationCounts();
		console.info("six encode+advance of a decoded control", JSON.stringify(counts));
		expect(counts.plan.verifications - settled).toBe(0);
	});
});

describe("retirement control verify-once soundness", () => {
	it("verifies each distinct byte image on its own, including same-length neighbours", () => {
		const first = encodeIssuanceRetirementControl(completedControl(2));
		const second = encodeIssuanceRetirementControl(completedControl(3));
		expect(second.byteLength).toBe(first.byteLength);
		expect(decodeIssuanceRetirementControl(first).revision).toBe(2);
		expect(decodeIssuanceRetirementControl(second).revision).toBe(3);
		expect(decodeIssuanceRetirementControl(first).revision).toBe(2);
		expect(issuanceRetirementVerificationCounts().control.verifications).toBe(2);
	});

	it("refuses corrupted or non-canonical bytes after the valid image was verified", () => {
		const bytes = encodeIssuanceRetirementControl(completedControl(2));
		expect(decodeIssuanceRetirementControl(bytes).revision).toBe(2);
		// Same length, one byte different: an invalid incarnation character.
		const incarnation = new TextEncoder().encode("c".repeat(64));
		const at = (() => {
			for (let index = 0; index + incarnation.length <= bytes.length; index++)
				if (incarnation.every((byte, offset) => bytes[index + offset] === byte)) return index;
			throw new Error("incarnation not found");
		})();
		const corrupt = new Uint8Array(bytes);
		corrupt[at] = "z".charCodeAt(0);
		expect(() => decodeIssuanceRetirementControl(corrupt)).toThrow();
		expect(() => decodeIssuanceRetirementControl(corrupt)).toThrow();
		// Same length, one embedded plan byte different (inside the retained context).
		const plan = planBytes(completedControl(2)).before;
		const planAt = (() => {
			for (let index = 0; index + 64 <= bytes.length; index++)
				if (plan.subarray(1000, 1064).every((byte, offset) => bytes[index + offset] === byte)) return index;
			throw new Error("plan not found");
		})();
		const plansDiffer = new Uint8Array(bytes);
		plansDiffer[planAt] = (plansDiffer[planAt]! + 1) % 256;
		expect(() => decodeIssuanceRetirementControl(plansDiffer)).toThrow();
		// Decodes and captures, but is not the exact canonical encoding.
		const extended = new Uint8Array(bytes.length + 1);
		extended.set(bytes);
		expect(() => decodeIssuanceRetirementControl(extended)).toThrow();
		expect(decodeIssuanceRetirementControl(bytes).revision).toBe(2);
	});

	it("never lets a caller mutate the verified state behind a later read", () => {
		const bytes = encodeIssuanceRetirementControl(completedControl(2));
		const pristine = decodeCanonical(bytes);
		const first = decodeIssuanceRetirementControl(bytes);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.completed)).toBe(true);
		expect(Object.isFrozen(first.completed!.planRewrite!.plans)).toBe(true);
		planBytes(first).before.fill(0);
		planBytes(first).after.fill(0);
		const second = decodeIssuanceRetirementControl(bytes);
		expect(planBytes(second).before).not.toBe(planBytes(first).before);
		expect(encodeCanonical(second)).toEqual(encodeCanonical(pristine));
		expect(issuanceRetirementBytesEqual(encodeIssuanceRetirementControl(second), bytes)).toBe(true);
		// The caller's own mutated copy is still judged on its own current bytes.
		expect(() => encodeIssuanceRetirementControl(first)).toThrow();
	});

	it("never lets a mutated capture result poison the verified plan bytes", () => {
		const control = completedControl(2);
		const captured = captureIssuanceRetirementControl(control);
		const poisoned = planBytes(captured).before;
		poisoned.fill(0, 0, 64);
		// The poisoned bytes are judged on their own, never matched to the verified plan.
		expect(() => captureIssuanceRetirementControl({ ...control, completed: { ...control.completed!,
			planRewrite: { ...control.completed!.planRewrite!, plans: [{ before: poisoned, after: planBytes(control).after }] } } }))
			.toThrow();
		expect(captureIssuanceRetirementControl(control)).toEqual(control);
	});

	it("detaches every embedded plan read back from verified bytes", () => {
		const source = rows();
		const control = completedControl(2);
		const p = control.completed!;
		const target = issuanceRetirementCommitRows(born, p, source);
		const first = reconstructIssuanceRetirementSourceRows(control, p, target);
		expect(first).toEqual(source);
		(first.plans[0]!.sourceContexts![0]!.exactCanonicalContextBytes as Uint8Array).fill(0);
		(first.plans[0]!.entries as unknown[]).length = 0;
		expect(reconstructIssuanceRetirementSourceRows(control, p, target)).toEqual(source);
	});
});
