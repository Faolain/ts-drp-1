import { compareBytes, decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import type { GenerationRef } from "@ts-drp/storage";

import { type DetachedClosureCandidate, inspectTrustClosure } from "./anchor-trust.js";
import {
	type CreatorTrustAdvanceRejection,
	type CreatorTrustAdvanceResult,
	type DetachedTrustClosure,
	inspectCreatorTrustAdvance,
} from "./creator-trust-advance.js";

const DIGEST_HEX = /^[0-9a-f]{64}$/u;
const INPUT_KEYS = Object.freeze([
	"current",
	"proofRefs",
	"proposed",
	"retiringPredecessorAclRef",
	"retiringProofRefs",
]);

export type BoundedCreatorTrustAdvanceRejection =
	| CreatorTrustAdvanceRejection
	| "RETIRING_PREDECESSOR_ACL_INVALID"
	| "RETIRING_PROOF_REFS_INVALID";

export type BoundedCreatorTrustAdvanceResult =
	| Readonly<{ readonly kind: "successor"; readonly ok: true }>
	| Readonly<{ readonly ok: false; readonly reason: BoundedCreatorTrustAdvanceRejection }>;

export interface InspectBoundedCreatorTrustAdvanceInput {
	readonly current: DetachedTrustClosure;
	readonly proofRefs: readonly GenerationRef[];
	readonly proposed: DetachedTrustClosure;
	readonly retiringPredecessorAclRef: GenerationRef;
	readonly retiringProofRefs: readonly GenerationRef[];
}

function rejected(reason: BoundedCreatorTrustAdvanceRejection): BoundedCreatorTrustAdvanceResult {
	return Object.freeze({ ok: false as const, reason });
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
	const actual = Reflect.ownKeys(value);
	return (
		actual.length === keys.length &&
		actual.every((key) => typeof key === "string" && keys.includes(key)) &&
		keys.every((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			return descriptor?.enumerable === true && "value" in descriptor;
		})
	);
}

function copyRef(value: unknown): GenerationRef | undefined {
	if (!plainRecord(value) || !exactKeys(value, ["byteLength", "digest"])) return undefined;
	if (
		typeof value.byteLength !== "number" ||
		!Number.isSafeInteger(value.byteLength) ||
		value.byteLength < 0 ||
		typeof value.digest !== "string" ||
		!DIGEST_HEX.test(value.digest)
	) {
		return undefined;
	}
	return Object.freeze({ byteLength: value.byteLength, digest: value.digest }) as GenerationRef;
}

function copyPair(value: unknown): readonly [GenerationRef, GenerationRef] | undefined {
	if (!Array.isArray(value) || value.length !== 2) return undefined;
	const first = copyRef(value[0]);
	const second = copyRef(value[1]);
	if (first === undefined || second === undefined || first.digest === second.digest) return undefined;
	return Object.freeze([first, second]);
}

function sameRef(left: GenerationRef, right: GenerationRef): boolean {
	return left.byteLength === right.byteLength && left.digest === right.digest;
}

function compareRef(left: GenerationRef, right: GenerationRef): number {
	return left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0;
}

function candidateFor(
	candidates: readonly DetachedClosureCandidate[],
	ref: GenerationRef
): DetachedClosureCandidate | undefined {
	const matches = candidates.filter((candidate) => sameRef(candidate.ref, ref));
	return matches.length === 1 ? matches[0] : undefined;
}

function exactRecord(candidate: DetachedClosureCandidate): Readonly<Record<string, unknown>> | undefined {
	try {
		const decoded = decodeCanonical(candidate.bytes);
		if (!plainRecord(decoded) || compareBytes(encodeCanonical(decoded), candidate.bytes) !== 0) return undefined;
		return decoded;
	} catch {
		return undefined;
	}
}

function exactClosure(left: readonly GenerationRef[], right: readonly GenerationRef[]): boolean {
	if (left.length !== right.length) return false;
	const sortedLeft = [...left].sort(compareRef);
	const sortedRight = [...right].sort(compareRef);
	return sortedLeft.every((ref, index) => sameRef(ref, sortedRight[index] as GenerationRef));
}

function trustIdentity(
	bytes: Uint8Array
): Readonly<{ readonly currentEpoch: number; readonly objectId: string }> | undefined {
	try {
		const decoded = decodeCanonical(bytes);
		return plainRecord(decoded) &&
			typeof decoded.currentEpoch === "number" &&
			Number.isSafeInteger(decoded.currentEpoch) &&
			decoded.currentEpoch >= 1 &&
			typeof decoded.objectId === "string"
			? Object.freeze({ currentEpoch: decoded.currentEpoch, objectId: decoded.objectId })
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * Classifies one bounded creator-trust checkpoint advance without writing storage.
 * @param input - Current/proposed closures, the new Cut/QC, and exact stale proof/ACL refs to retire.
 * @returns The existing successor verdict or a frozen retirement rejection.
 */
export function inspectBoundedCreatorTrustAdvance(input: unknown): BoundedCreatorTrustAdvanceResult {
	try {
		if (!plainRecord(input) || !exactKeys(input, INPUT_KEYS)) return rejected("TRUST_CLOSURE_INVALID");
		const typed = input as unknown as InspectBoundedCreatorTrustAdvanceInput;
		const current = inspectTrustClosure(typed.current);
		const proposed = inspectTrustClosure(typed.proposed);
		const proofRefs = copyPair(typed.proofRefs);
		const retiringProofRefs = copyPair(typed.retiringProofRefs);
		const retiringAclRef = copyRef(typed.retiringPredecessorAclRef);
		if (!current.ok || !proposed.ok || proofRefs === undefined) return rejected("TRUST_CLOSURE_INVALID");
		if (retiringProofRefs === undefined) return rejected("RETIRING_PROOF_REFS_INVALID");
		if (retiringAclRef === undefined) return rejected("RETIRING_PREDECESSOR_ACL_INVALID");
		const identity = trustIdentity(current.exactCanonicalTrustStateRecordBytes);
		if (identity === undefined) return rejected("TRUST_CLOSURE_INVALID");
		const [retiringCutRef, retiringQcRef] = retiringProofRefs;
		const [newCutRef, newQcRef] = proofRefs;
		const retiringCut = candidateFor(typed.current.candidates, retiringCutRef);
		const retiringQc = candidateFor(typed.current.candidates, retiringQcRef);
		const retiringAcl = candidateFor(typed.current.candidates, retiringAclRef);
		const newCut = candidateFor(typed.proposed.candidates, newCutRef);
		const newQc = candidateFor(typed.proposed.candidates, newQcRef);
		const retiringCutRecord = retiringCut === undefined ? undefined : exactRecord(retiringCut);
		const retiringQcRecord = retiringQc === undefined ? undefined : exactRecord(retiringQc);
		const retiringAclRecord = retiringAcl === undefined ? undefined : exactRecord(retiringAcl);
		const newCutRecord = newCut === undefined ? undefined : exactRecord(newCut);
		const newQcRecord = newQc === undefined ? undefined : exactRecord(newQc);
		if (
			retiringCut === undefined ||
			retiringQc === undefined ||
			retiringCutRecord?.kind !== "drp-hard-epoch-cut" ||
			retiringCutRecord.objectId !== identity.objectId ||
			retiringCutRecord.epoch !== identity.currentEpoch - 1 ||
			retiringQcRecord?.kind !== "drp-seal-qc" ||
			retiringQcRecord.objectId !== identity.objectId ||
			retiringQcRecord.epoch !== identity.currentEpoch - 1 ||
			retiringQcRecord.phase !== "commit"
		) {
			return rejected("RETIRING_PROOF_REFS_INVALID");
		}
		if (
			retiringAcl === undefined ||
			retiringAclRecord?.kind !== "drp-v3-latched-acl" ||
			retiringAclRecord.objectId !== identity.objectId ||
			retiringAclRecord.epoch !== identity.currentEpoch - 1
		) {
			return rejected("RETIRING_PREDECESSOR_ACL_INVALID");
		}
		if (
			newCut === undefined ||
			newQc === undefined ||
			newCutRecord?.kind !== "drp-hard-epoch-cut" ||
			newCutRecord.objectId !== identity.objectId ||
			newCutRecord.epoch !== identity.currentEpoch ||
			newQcRecord?.kind !== "drp-seal-qc" ||
			newQcRecord.objectId !== identity.objectId ||
			newQcRecord.epoch !== identity.currentEpoch ||
			newQcRecord.phase !== "commit"
		) {
			return rejected("TRUST_CLOSURE_INVALID");
		}
		const retiring = new Set([retiringCutRef.digest, retiringQcRef.digest, retiringAclRef.digest]);
		if (
			retiring.has(current.trustRef.digest) ||
			retiring.size !== 3 ||
			typed.proposed.closure.some((ref) => retiring.has(ref.digest))
		) {
			return rejected("TRUST_CLOSURE_INVALID");
		}
		const retained = typed.current.closure.filter(
			(ref) => ref.digest !== current.trustRef.digest && !retiring.has(ref.digest)
		);
		if (retained.length !== typed.current.closure.length - 4) return rejected("TRUST_CLOSURE_INVALID");
		const expected = [...retained, proposed.trustRef, newCutRef, newQcRef];
		if (
			new Set(expected.map((ref) => ref.digest)).size !== expected.length ||
			!exactClosure(expected, typed.proposed.closure)
		) {
			return rejected("TRUST_CLOSURE_INVALID");
		}
		const syntheticClosure = Object.freeze(
			[...typed.proposed.closure, retiringCutRef, retiringQcRef, retiringAclRef].sort(compareRef)
		);
		const syntheticCandidates = Object.freeze([...typed.proposed.candidates, retiringCut, retiringQc, retiringAcl]);
		return inspectCreatorTrustAdvance({
			current: typed.current,
			proofRefs,
			proposed: { candidates: syntheticCandidates, closure: syntheticClosure },
		}) as CreatorTrustAdvanceResult;
	} catch {
		return rejected("TRUST_CLOSURE_INVALID");
	}
}
