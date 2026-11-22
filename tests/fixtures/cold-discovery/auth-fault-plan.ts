import type { AuthMutationReceipt, RecoveryCase, RestartBootstrap } from "./types.js";
import { decodeCanonical, encodeCanonical } from "../../../packages/canonical/dist/src/index.js";
import {
	decodeGenerationRecordV1,
	decodeHeadRecordV1,
	digestBlob,
	digestClosure,
	encodeGenerationRecordV1,
	encodeHeadRecordV1,
	type GenerationRef,
} from "../../../packages/storage/dist/src/index.js";

export interface AuthFaultGraph {
	headRecord: Uint8Array;
	generations: { generationId: string; record: Uint8Array }[];
	blobs: { digest: string; bytes: Uint8Array }[];
	promotions: { generationId: string; digest: string }[];
}
export interface AuthFaultPlan {
	blob: { digest: string; bytes: Uint8Array };
	generations: AuthFaultGraph["generations"];
	headRecord?: Uint8Array;
	promotions: { generationId: string; fromDigest: string; toDigest: string }[];
	receipt: AuthMutationReceipt;
}
const authCases = [
	"bad-trust",
	"bad-cut",
	"bad-qc",
	"storage-corrupt-trust",
	"storage-corrupt-cut",
	"storage-corrupt-qc",
	"rehash-noop",
] as const;
type AuthFaultCase = (typeof authCases)[number];

/**
 * Identify only the separately authorized AHE fault modes.
 * @param mode - Native recovery case.
 * @returns Whether the shared AHE fault planner owns this case.
 */
export function isAuthFaultCase(mode: RecoveryCase): mode is AuthFaultCase {
	return (authCases as readonly string[]).includes(mode);
}
function requireFact(condition: unknown, detail: string): asserts condition {
	if (!condition) throw new Error(`AUTH_FAULT_PLAN:${detail}`);
}
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}
function canonicalRecord(bytes: Uint8Array): Record<string, unknown> {
	const decoded: unknown = decodeCanonical(bytes);
	requireFact(decoded !== null && typeof decoded === "object" && !Array.isArray(decoded), "BLOB_RECORD");
	requireFact(equalBytes(encodeCanonical(decoded), bytes), "BLOB_CANONICAL");
	return decoded as Record<string, unknown>;
}

/**
 * Plan fixture-only durable corruption; this does not implement recovery or authentication.
 * @param graph - Native rows read in the write transaction.
 * @param bootstrap - Trusted object and epoch selection, never a snapshot hint.
 * @param mode - Original field fault, raw bitrot, or byte-identical rewrite control.
 * @returns Storage-only writes, leaving every signed dependent blob unchanged.
 */
export function planAuthFault(graph: AuthFaultGraph, bootstrap: RestartBootstrap, mode: AuthFaultCase): AuthFaultPlan {
	const objectId = bootstrap.expectedRoomHead.objectId;
	const decodedHead = decodeHeadRecordV1(graph.headRecord);
	requireFact(decodedHead.ok && decodedHead.value.kind === "present", "HEAD");
	const head = decodedHead.value;
	requireFact(head.objectId === objectId, "HEAD_OBJECT");
	const generations = graph.generations.map((row) => {
		const decoded = decodeGenerationRecordV1(row.record);
		requireFact(
			decoded.ok && decoded.value.generationId === row.generationId && decoded.value.objectId === objectId,
			"GENERATION"
		);
		return decoded.value;
	});
	requireFact(
		new Set(generations.map((generation) => generation.generationId)).size === generations.length,
		"DUPLICATE_GENERATION"
	);
	const active = generations.find((generation) => generation.generationId === head.generationId);
	requireFact(
		active?.state === "Adopted" &&
			active.closureDigest === head.closureDigest &&
			active.baseExpectedHead.kind === "present",
		"ACTIVE"
	);
	const proposedId = active.baseExpectedHead.generationId;
	const proposed = generations.find((generation) => generation.generationId === proposedId);
	requireFact(proposed !== undefined && proposed.closureDigest === active.baseExpectedHead.closureDigest, "PROPOSED");
	const blobs = new Map(graph.blobs.map((blob) => [blob.digest, blob.bytes]));
	requireFact(blobs.size === graph.blobs.length, "DUPLICATE_BLOB");
	const desired = mode.endsWith("cut")
		? "drp-hard-epoch-cut"
		: mode.endsWith("qc")
			? "drp-seal-qc"
			: "drp-anchor-trust-state";
	const candidates = proposed.closure.flatMap((ref) => {
		const bytes = blobs.get(ref.digest);
		requireFact(bytes !== undefined, "PROPOSED_BLOB_MISSING");
		const actual = digestBlob(bytes);
		requireFact(
			actual.ok && actual.value === ref.digest && bytes.byteLength === ref.byteLength,
			"ORIGINAL_BLOB_DIGEST"
		);
		const record = canonicalRecord(bytes);
		return record.kind === desired &&
			record.objectId === objectId &&
			(desired === "drp-anchor-trust-state"
				? record.currentEpoch === bootstrap.expectedRoomHead.epoch
				: record.epoch === bootstrap.expectedRoomHead.epoch - 1) &&
			(desired !== "drp-seal-qc" || record.phase === "commit")
			? [{ ref, bytes, record }]
			: [];
	});
	requireFact(candidates.length === 1, `TARGET_COUNT:${candidates.length}`);
	const target = candidates[0];
	requireFact(
		target !== undefined && active.closure.some((ref) => ref.digest === target.ref.digest),
		"TARGET_NOT_ACTIVE"
	);
	if (mode !== "rehash-noop") {
		if (desired === "drp-anchor-trust-state") {
			const signature = target.record.detachedCurrentAnchorSignature;
			requireFact(signature instanceof Uint8Array && signature.byteLength === 64, "SIGNATURE_SHAPE");
			const changed = Uint8Array.from(signature);
			changed[0] = (changed[0] as number) ^ 1;
			target.record.detachedCurrentAnchorSignature = changed;
		} else target.record[desired === "drp-hard-epoch-cut" ? "previousAnchor" : "proposalDigest"] = "f".repeat(64);
	}
	const bytes = encodeCanonical(target.record);
	const computed = digestBlob(bytes);
	requireFact(computed.ok, "NEW_DIGEST");
	const newRef: GenerationRef = { digest: computed.value, byteLength: bytes.byteLength };
	const bitrot = mode.startsWith("storage-corrupt-");
	requireFact(
		mode === "rehash-noop" ? equalBytes(bytes, target.bytes) : newRef.digest !== target.ref.digest,
		"FAULT_NOT_EFFECTIVE"
	);
	const changes = new Map<string, string>();
	const rewritten = generations.map((generation) => {
		const closure = generation.closure
			.map((ref) => (ref.digest === target.ref.digest ? newRef : ref))
			.sort((left, right) => (left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0));
		const digest = digestClosure(closure);
		requireFact(digest.ok, "NEW_CLOSURE");
		if (digest.value !== generation.closureDigest) changes.set(generation.generationId, digest.value);
		return { ...generation, closure, closureDigest: digest.value };
	});
	let changedBases = 0;
	const generationWrites = rewritten.map((generation) => {
		const base = generation.baseExpectedHead;
		const digest = base.kind === "present" ? changes.get(base.generationId) : undefined;
		if (digest !== undefined && base.kind === "present") {
			const parsed = rewritten.find((candidate) => candidate.generationId === base.generationId);
			requireFact(parsed !== undefined, "BASE_TARGET");
			generation.baseExpectedHead = { ...base, closureDigest: parsed.closureDigest };
			changedBases += 1;
		}
		return { generationId: generation.generationId, record: encodeGenerationRecordV1(generation) };
	});
	const promotions =
		newRef.digest === target.ref.digest
			? []
			: generations
					.filter((generation) => generation.closure.some((ref) => ref.digest === target.ref.digest))
					.map((generation) => {
						requireFact(
							graph.promotions.filter(
								(row) => row.generationId === generation.generationId && row.digest === target.ref.digest
							).length === 1,
							"PROMOTION_MISSING_OR_DUPLICATE"
						);
						requireFact(
							!graph.promotions.some(
								(row) => row.generationId === generation.generationId && row.digest === newRef.digest
							),
							"NEW_PROMOTION_EXISTS"
						);
						return { generationId: generation.generationId, fromDigest: target.ref.digest, toDigest: newRef.digest };
					});
	const nextActive = rewritten.find((generation) => generation.generationId === head.generationId);
	requireFact(nextActive !== undefined, "NEXT_ACTIVE");
	return {
		blob: { digest: bitrot ? target.ref.digest : newRef.digest, bytes },
		generations: bitrot ? [] : generationWrites,
		...(bitrot ? {} : { headRecord: encodeHeadRecordV1({ ...head, closureDigest: nextActive.closureDigest }) }),
		promotions: bitrot ? [] : promotions,
		receipt: {
			mode,
			kind: bitrot ? "storage-corrupt" : "digest-consistent",
			faultApplications: mode === "rehash-noop" ? 0 : 1,
			oldRef: { ...target.ref },
			newRef,
			changedClosures: bitrot ? 0 : changes.size,
			changedBases: bitrot ? 0 : changedBases,
			promotionChanges: bitrot ? 0 : promotions.length,
			originalBlobCount: graph.blobs.length,
		},
	};
}

/**
 * Check the real post-write rows before commit, including untouched original blobs.
 * @param before - Original transaction rows.
 * @param after - Actual rows reread from the same native transaction.
 * @param plan - Exact authorized writes.
 */
export function verifyAuthFaultPersistence(before: AuthFaultGraph, after: AuthFaultGraph, plan: AuthFaultPlan): void {
	const expectedBlobs = new Map(before.blobs.map((row) => [row.digest, row.bytes]));
	expectedBlobs.set(plan.blob.digest, plan.blob.bytes);
	requireFact(after.blobs.length === expectedBlobs.size, "BLOB_ROW_COUNT");
	for (const row of after.blobs) {
		const expected = expectedBlobs.get(row.digest);
		requireFact(expected !== undefined && equalBytes(row.bytes, expected), "BLOB_PRESERVATION");
		expectedBlobs.delete(row.digest);
	}
	requireFact(expectedBlobs.size === 0, "BLOB_MISSING");
	const expectedGenerations = new Map(before.generations.map((row) => [row.generationId, row.record]));
	for (const row of plan.generations) expectedGenerations.set(row.generationId, row.record);
	requireFact(after.generations.length === expectedGenerations.size, "GENERATION_ROW_COUNT");
	for (const row of after.generations) {
		const expected = expectedGenerations.get(row.generationId);
		requireFact(expected !== undefined && equalBytes(row.record, expected), "GENERATION_PERSISTENCE");
		expectedGenerations.delete(row.generationId);
	}
	requireFact(expectedGenerations.size === 0, "GENERATION_MISSING");
	requireFact(equalBytes(after.headRecord, plan.headRecord ?? before.headRecord), "HEAD_PERSISTENCE");
	const key = (row: AuthFaultGraph["promotions"][number]): string => `${row.generationId}:${row.digest}`;
	const expectedPromotions = new Set(before.promotions.map(key));
	for (const row of plan.promotions) {
		expectedPromotions.delete(key({ generationId: row.generationId, digest: row.fromDigest }));
		expectedPromotions.add(key({ generationId: row.generationId, digest: row.toDigest }));
	}
	requireFact(
		after.promotions.length === expectedPromotions.size &&
			after.promotions.every((row) => expectedPromotions.delete(key(row))) &&
			expectedPromotions.size === 0,
		"PROMOTION_PERSISTENCE"
	);
}
