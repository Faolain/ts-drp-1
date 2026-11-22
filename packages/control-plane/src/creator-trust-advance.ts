import { decodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { GenerationRef } from "@ts-drp/storage";

import { type DetachedClosureCandidate, inspectTrustClosure, trustScannableClosure } from "./anchor-trust.js";

const DIGEST_HEX = /^[0-9a-f]{64}$/u;

export type CreatorTrustAdvanceRejection =
	| "BYTE_REPLAY"
	| "EPOCH_EQUIVOCATION"
	| "EPOCH_GAP"
	| "ROLLBACK"
	| "TRUST_CLOSURE_INVALID";

export type CreatorTrustAdvanceResult =
	| Readonly<{ readonly kind: "successor"; readonly ok: true }>
	| Readonly<{ readonly ok: false; readonly reason: CreatorTrustAdvanceRejection }>;

export interface DetachedTrustClosure {
	readonly candidates: readonly DetachedClosureCandidate[];
	readonly closure: readonly GenerationRef[];
}

export interface InspectCreatorTrustAdvanceInput {
	readonly current: DetachedTrustClosure;
	readonly proofRefs: readonly GenerationRef[];
	readonly proposed: DetachedTrustClosure;
}

interface TrustRecord extends Readonly<Record<string, unknown>> {
	readonly currentAnchorDigest: string;
	readonly currentEpoch: number;
	readonly exactCanonicalCurrentAnchorPreimageBytes: Uint8Array;
	readonly exactCanonicalProfileBytes: Uint8Array;
	readonly exactCanonicalSignerSetBytes: Uint8Array;
	readonly genesisAnchorDigest: string;
	readonly objectId: string;
	readonly profileId: string;
	readonly quorum: number;
	readonly version: number;
}

function rejected(reason: CreatorTrustAdvanceRejection): CreatorTrustAdvanceResult {
	return Object.freeze({ ok: false as const, reason });
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function sameRef(left: GenerationRef, right: GenerationRef): boolean {
	return left.byteLength === right.byteLength && left.digest === right.digest;
}

function compareRef(left: GenerationRef, right: GenerationRef): number {
	return left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0;
}

function copyRef(value: unknown): GenerationRef | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Readonly<Record<string, unknown>>;
	if (
		Object.keys(record).length !== 2 ||
		!Object.hasOwn(record, "byteLength") ||
		!Object.hasOwn(record, "digest") ||
		typeof record.byteLength !== "number" ||
		!Number.isSafeInteger(record.byteLength) ||
		record.byteLength < 0 ||
		typeof record.digest !== "string" ||
		!DIGEST_HEX.test(record.digest)
	)
		return undefined;
	return Object.freeze({ byteLength: record.byteLength, digest: record.digest }) as GenerationRef;
}

function copyProofRefs(value: unknown): readonly [GenerationRef, GenerationRef] | undefined {
	if (!Array.isArray(value) || value.length !== 2) return undefined;
	const first = copyRef(value[0]);
	const second = copyRef(value[1]);
	if (first === undefined || second === undefined || first.digest === second.digest) return undefined;
	return Object.freeze([first, second]);
}

function exactCombinedClosure(
	current: readonly GenerationRef[],
	currentTrustRef: GenerationRef,
	proofRefs: readonly [GenerationRef, GenerationRef],
	successorTrustRef: GenerationRef
): readonly GenerationRef[] | undefined {
	const retained = current.filter((ref) => ref.digest !== currentTrustRef.digest);
	if (retained.length !== current.length - 1) return undefined;
	const combined = [...retained, successorTrustRef, ...proofRefs];
	if (new Set(combined.map(({ digest }) => digest)).size !== combined.length) return undefined;
	return Object.freeze([...combined].sort(compareRef));
}

function bytesHex(bytes: Uint8Array): string {
	let value = "";
	for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
	return value;
}

function decodeTrust(bytes: Uint8Array): TrustRecord | undefined {
	try {
		const value = decodeCanonical(bytes);
		return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as TrustRecord) : undefined;
	} catch {
		return undefined;
	}
}

function validSuccessorBinding(current: TrustRecord, successor: TrustRecord): boolean {
	try {
		if (
			successor.version !== 1 ||
			successor.objectId !== current.objectId ||
			successor.genesisAnchorDigest !== current.genesisAnchorDigest ||
			successor.profileId !== current.profileId ||
			successor.quorum !== current.quorum ||
			!(successor.exactCanonicalProfileBytes instanceof Uint8Array) ||
			!(current.exactCanonicalProfileBytes instanceof Uint8Array) ||
			!sameBytes(successor.exactCanonicalProfileBytes, current.exactCanonicalProfileBytes) ||
			!(successor.exactCanonicalSignerSetBytes instanceof Uint8Array) ||
			!(current.exactCanonicalSignerSetBytes instanceof Uint8Array) ||
			!sameBytes(successor.exactCanonicalSignerSetBytes, current.exactCanonicalSignerSetBytes) ||
			!(successor.exactCanonicalCurrentAnchorPreimageBytes instanceof Uint8Array)
		)
			return false;
		const anchorValue = decodeCanonical(successor.exactCanonicalCurrentAnchorPreimageBytes);
		if (anchorValue === null || typeof anchorValue !== "object" || Array.isArray(anchorValue)) return false;
		const anchor = anchorValue as Readonly<Record<string, unknown>>;
		return (
			anchor.objectId === current.objectId &&
			anchor.epoch === successor.currentEpoch &&
			anchor.previousAnchor === current.currentAnchorDigest &&
			successor.currentAnchorDigest ===
				bytesHex(hashDomain("ts-drp/epoch-anchor/v3", successor.exactCanonicalCurrentAnchorPreimageBytes))
		);
	} catch {
		return false;
	}
}

/**
 * Classifies one exact creator-trust successor closure without writing storage.
 * @param input - Detached current/proposed closures and the certified CutValue/QC refs.
 * @returns The closed advancement verdict.
 */
export function inspectCreatorTrustAdvance(input: InspectCreatorTrustAdvanceInput): CreatorTrustAdvanceResult {
	try {
		if (input === null || typeof input !== "object" || Array.isArray(input)) return rejected("TRUST_CLOSURE_INVALID");
		const currentClosure = Object.freeze([...input.current.closure].sort(compareRef));
		const current = inspectTrustClosure(
			trustScannableClosure({ candidates: input.current.candidates, closure: currentClosure })
		);
		const proposed = inspectTrustClosure(trustScannableClosure(input.proposed));
		const proofRefs = copyProofRefs(input.proofRefs);
		if (!current.ok || !proposed.ok || proofRefs === undefined) return rejected("TRUST_CLOSURE_INVALID");
		const combined = exactCombinedClosure(currentClosure, current.trustRef, proofRefs, proposed.trustRef);
		if (
			combined === undefined ||
			combined.length !== input.proposed.closure.length ||
			combined.some((ref, index) => !sameRef(ref, input.proposed.closure[index] as GenerationRef))
		)
			return rejected("TRUST_CLOSURE_INVALID");
		if (sameBytes(current.exactCanonicalTrustStateRecordBytes, proposed.exactCanonicalTrustStateRecordBytes)) {
			return rejected("BYTE_REPLAY");
		}
		const currentRecord = decodeTrust(current.exactCanonicalTrustStateRecordBytes);
		const proposedRecord = decodeTrust(proposed.exactCanonicalTrustStateRecordBytes);
		if (currentRecord === undefined || proposedRecord === undefined || typeof currentRecord.currentEpoch !== "number") {
			return rejected("TRUST_CLOSURE_INVALID");
		}
		if (proposedRecord.currentEpoch === currentRecord.currentEpoch) return rejected("EPOCH_EQUIVOCATION");
		if (typeof proposedRecord.currentEpoch !== "number" || proposedRecord.currentEpoch < currentRecord.currentEpoch) {
			return rejected("ROLLBACK");
		}
		if (proposedRecord.currentEpoch !== currentRecord.currentEpoch + 1) return rejected("EPOCH_GAP");
		if (!validSuccessorBinding(currentRecord, proposedRecord)) return rejected("TRUST_CLOSURE_INVALID");
		return Object.freeze({ kind: "successor" as const, ok: true as const });
	} catch {
		return rejected("TRUST_CLOSURE_INVALID");
	}
}
