import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DetachedClosureCandidate } from "@ts-drp/control-plane";
import { inspectCreatorTrustAdvance } from "@ts-drp/control-plane/creator-trust-advance";
import { inspectBoundedCreatorTrustAdvance } from "@ts-drp/control-plane/creator-trust-checkpoint-advance";
import { type CurrentAnchorTrust, openCurrentAnchorTrust } from "@ts-drp/protocol-v3";
import { readCreatorSettlementSourceAnchor } from "@ts-drp/protocol-v3/internal/received-vertex-authentication";
import {
	CREATOR_AUTHOR_ISSUANCE_FRONTIERS_GENESIS_SENTINEL,
	CREATOR_AUTHOR_ISSUANCE_FRONTIERS_KIND,
	CREATOR_AUTHOR_SETTLEMENT_GENESIS_SENTINEL,
	CREATOR_AUTHOR_SETTLEMENT_KIND,
	type CreatorAuthorIssuanceFrontiersIdentity,
	type CreatorAuthorSettlementIdentity,
	frontierFor,
	openCreatorAuthorIssuanceFrontiers,
	openCreatorAuthorSettlement,
	resolveCreatorAuthorIssuanceFrontiers,
	resolveCreatorAuthorSettlement,
	type VerifiedCreatorAuthorIssuanceFrontiers,
	type VerifiedCreatorAuthorSettlement,
} from "@ts-drp/protocol-v3/creator-author-issuance-frontiers";
import { openCreatorCheckpointTrust, openCreatorForwardPromotionCheckpointTrust } from "@ts-drp/protocol-v3/creator-checkpoint";
import {
	inspectCreatorClosedCutSuccessorBinding,
	inspectCreatorForwardPromotionClosedCutSuccessorBinding,
	inspectCreatorHistoricalAnchorChain,
	inspectCreatorHistoricalAnchorEnvelope,
	openCreatorForwardPromotionSuccessorTrust,
	openCreatorSuccessorTrust,
} from "@ts-drp/protocol-v3/creator-close";
import {
	CREATOR_ISSUANCE_RETIREMENT_GENESIS_SENTINEL,
	CREATOR_ISSUANCE_RETIREMENT_KIND,
	type CreatorIssuanceRetirementIdentity,
	openCreatorIssuanceRetirement,
	resolveCreatorIssuanceRetirement,
	type VerifiedCreatorIssuanceRetirement,
} from "@ts-drp/protocol-v3/creator-issuance-retirement";
import {
	captureCreatorSnapshotRecoveryRoles,
	type CreatorSnapshotRecoveryRoles,
	type CreatorSnapshotRecoveryScope,
	captureForwardPromotion,
	capturePromotionArray,
	capturePromotionBytes,
	capturePromotionRecord,
	capturePromotionRef,
	type ForwardPromotion,
	type PromotionControlRef,
	type PromotionSource,
} from "@ts-drp/protocol-v3/internal/creator-forward-promotion";
import {
	authorizeLatchedApplicationWrite,
	type LatchedAclSnapshot,
	openCanonicalLatchedAclSnapshot,
} from "@ts-drp/protocol-v3/latched-acl";
import { openSealAuthority, resolveSealRecoveryTrust } from "@ts-drp/protocol-v3/seal";
import { settlementProfileFor } from "@ts-drp/protocol-v3/settlement-profile";
import { decodeSnapshotManifest, snapshotChunkDigest } from "@ts-drp/protocol-v3/snapshot-transfer";
import {
	AHE_BOUNDED_READ_LIMITS,
	digestBlob,
	digestClosure,
	type GenerationRecord,
	type GenerationRef,
	type PresentHead,
	type StorageObjectId,
} from "@ts-drp/storage";

import { openCreatorCloseHistory } from "./creator-close-history.js";
import { matchesCreatorAdoptionReferences } from "./creator-adoption-references.js";
import { consumeCreatorRecoveryRoleRetiredReadback, createCreatorClosedRollbackProofAccounting } from "./creator-closed-rollback-data.js";
import { canonicalCreatorDataRecord, createCreatorCanonicalSyntaxReader, creatorDataDigest, creatorPromotedSnapshotProjectionMatches, creatorSnapshotProjectionMatches, validateCreatorSnapshotData } from "./creator-snapshot-data.js";

/**
 * Shares only structural adoption lineage, never protocol trust or selection policy.
 * @param input - Physical lineage and candidate from the original owner.
 * @param input.objectId - Exact object scope.
 * @param input.lineage - Existing physical lineage.
 * @param input.candidate - Candidate publication row.
 * @param input.direct - Received final candidate based on the still-active predecessor.
 * @returns The existing P/Q/L structure or undefined.
 */
export function inspectCreatorAdoptionCandidateLineage(input: {
	objectId: StorageObjectId;
	lineage: readonly GenerationRecord[];
	candidate: GenerationRecord;
	/** Received adoption publishes directly from the independently active predecessor. */
	direct?: boolean;
}):
	| Readonly<{
			currentGeneration: GenerationRecord;
			proposedGeneration: GenerationRecord;
			candidateGeneration: GenerationRecord;
			currentHead: PresentHead;
			proposedHead: PresentHead;
			candidateHead: PresentHead;
	  }>
	| undefined {
	const { objectId, lineage, candidate } = input;
	if (candidate.state !== "Complete" && candidate.state !== "Adopted") return undefined;
	const proposedHead = candidate.baseExpectedHead.kind === "present" ? candidate.baseExpectedHead : undefined;
	const byId = new Map(lineage.map((generation) => [generation.generationId, generation]));
	if (byId.size !== lineage.length || proposedHead === undefined) return undefined;
	const proposedGeneration = byId.get(proposedHead.generationId);
	const currentHead =
		input.direct === true
			? proposedHead
			: proposedGeneration?.baseExpectedHead.kind === "present"
				? proposedGeneration.baseExpectedHead
				: undefined;
	const currentGeneration = currentHead === undefined ? undefined : byId.get(currentHead.generationId);
	if (
		proposedGeneration === undefined ||
		currentHead === undefined ||
		currentGeneration === undefined ||
		(input.direct === true
			? candidate.state === "Complete"
				? currentGeneration.state !== "Adopted"
				: currentGeneration.state !== "Superseded"
			: currentGeneration.state !== "Superseded" ||
				(proposedGeneration.state !== "Adopted" && proposedGeneration.state !== "Superseded")) ||
		candidate.objectId !== objectId ||
		proposedGeneration.objectId !== objectId ||
		currentGeneration.objectId !== objectId ||
		(input.direct !== true && proposedHead.revision !== currentHead.revision + 1)
	)
		return undefined;
	const closureDigest = digestClosure(candidate.closure);
	if (!closureDigest.ok || candidate.closureDigest !== closureDigest.value) return undefined;
	return Object.freeze({
		currentGeneration,
		proposedGeneration: input.direct === true ? candidate : proposedGeneration,
		candidateGeneration: candidate,
		currentHead: Object.freeze({ ...currentHead }),
		proposedHead: Object.freeze({ ...proposedHead }),
		candidateHead: Object.freeze({
			closureDigest: closureDigest.value,
			generationId: candidate.generationId,
			kind: "present",
			objectId,
			revision: (proposedHead.revision + 1) as PresentHead["revision"],
		}),
	});
}

export interface CreatorTransitionClosure {
	readonly candidates: readonly DetachedClosureCandidate[];
	readonly closure: readonly GenerationRef[];
}

export interface InspectCreatorTransitionAdvanceInput {
	readonly current: CreatorTransitionClosure;
	readonly currentTrust: CurrentAnchorTrust;
	readonly mode: "stage" | "verify";
	readonly proofRefs: readonly GenerationRef[];
	readonly proposed: CreatorTransitionClosure;
	readonly successorTrust: CurrentAnchorTrust;
	/** Final settlement validation requires the ACL bytes from the authenticated snapshot owner. */
	readonly settlementAcl?: Readonly<{ current: Uint8Array; successor: Uint8Array }>;
}

export type InspectCreatorTransitionAdvanceResult =
	| Readonly<{ readonly ok: false; readonly reason: string }>
	| Readonly<{
			readonly kind: "successor";
			readonly ok: true;
			readonly proposed: CreatorTransitionClosure;
	  }>;

export interface VerifiedCreatorHistoricalIssuance {
	readonly __verifiedCreatorHistoricalIssuance?: never;
}

export interface CreatorHistoricalIssuanceIdentity {
	readonly admissionEpoch?: number;
	readonly admittedAuthorSequence: number | null;
	readonly author: string;
	readonly closedAnchorDigest: string;
	readonly closedEpoch: number;
	readonly objectId: string;
	readonly successorAnchorDigest: string;
	readonly successorEpoch: number;
}

const verifiedHistoricalIssuance = new WeakMap<VerifiedCreatorHistoricalIssuance, Readonly<{
	identity: CreatorHistoricalIssuanceIdentity;
	exactCanonicalLatchedAclBytes: Uint8Array;
	exactCanonicalSourceAnchorPreimageBytes?: Uint8Array;
	detachedSourceAnchorSignature?: Uint8Array;
	profileId: string;
	settlement?: VerifiedCreatorAuthorSettlement;
}>>();

type SettlementFrontier = readonly [author: string, admissionEpoch: number, terminalThrough: number | null];

const SETTLEMENT_ADVANCE_KEYS = ["currentAcl", "predecessor", "proposed", "successorAcl"] as const;
const SETTLEMENT_ACL_KEYS = ["epoch", "kind", "members", "objectId", "permissionless", "version"] as const;
const SETTLEMENT_MEMBER_KEYS = ["author", "finalityKey", "groups"] as const;
const SETTLEMENT_PREDECESSOR_KEYS = ["candidateDigest", "closedEpoch", "frontiers", "successorEpoch"] as const;
const SETTLEMENT_PROPOSED_KEYS = [
	"closedEpoch",
	"frontiers",
	"priorCheckpointDigest",
	"priorCheckpointKind",
	"successorEpoch",
] as const;

function exactSettlementRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | undefined {
	try {
		if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
			return undefined;
		}
		const actual = Reflect.ownKeys(value);
		if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) {
			return undefined;
		}
		const output = Object.create(null) as Record<string, unknown>;
		for (const key of keys) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) return undefined;
			output[key] = descriptor.value;
		}
		return Object.freeze(output);
	} catch {
		return undefined;
	}
}

function exactSettlementArray(value: unknown): readonly unknown[] | undefined {
	try {
		if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
		const length = value.length;
		if (!Number.isSafeInteger(length) || length < 0) return undefined;
		const keys = Reflect.ownKeys(value);
		if (keys.length !== length + 1 || keys[length] !== "length") return undefined;
		for (let index = 0; index < length; index += 1) {
			const key = String(index);
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (
				keys[index] !== key ||
				descriptor === undefined ||
				descriptor.enumerable !== true ||
				!("value" in descriptor)
			) {
				return undefined;
			}
		}
		return value;
	} catch {
		return undefined;
	}
}

function exactSettlementAcl(value: unknown): Readonly<Record<string, unknown>> | undefined {
	const acl = exactSettlementRecord(value, SETTLEMENT_ACL_KEYS);
	const members = exactSettlementArray(acl?.members);
	if (acl === undefined || members === undefined) return undefined;
	for (const memberValue of members) {
		const member = exactSettlementRecord(memberValue, SETTLEMENT_MEMBER_KEYS);
		const groups = exactSettlementArray(member?.groups);
		if (member === undefined || groups === undefined) return undefined;
	}
	return acl;
}

function exactSettlementFrontierArray(value: unknown): readonly unknown[] | undefined {
	const frontiers = exactSettlementArray(value);
	if (frontiers === undefined) return undefined;
	for (const frontier of frontiers) {
		const tuple = exactSettlementArray(frontier);
		if (tuple === undefined || tuple.length !== 3) return undefined;
	}
	return frontiers;
}

function settlementMembers(value: unknown): readonly string[] | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const acl = value as Readonly<Record<string, unknown>>;
	const epoch = acl.epoch;
	const members = exactSettlementArray(acl.members);
	if (
		!Number.isSafeInteger(epoch) ||
		(epoch as number) < 0 ||
		!Array.isArray(members) ||
		members.length < 1 ||
		members.length > 256
	) {
		return undefined;
	}
	const authors: string[] = [];
	let previous: string | undefined;
	for (const memberValue of members) {
		const member = exactSettlementRecord(memberValue, SETTLEMENT_MEMBER_KEYS);
		if (member === undefined) return undefined;
		const author = member.author;
		if (
			typeof author !== "string" ||
			!/^[0-9a-f]{64}$/u.test(author) ||
			(previous !== undefined && author <= previous)
		) {
			return undefined;
		}
		previous = author;
		authors.push(author);
	}
	return Object.freeze(authors);
}

function settlementFrontiers(value: unknown): readonly SettlementFrontier[] | undefined {
	const frontiers = exactSettlementFrontierArray(value);
	if (frontiers === undefined || frontiers.length > 256) return undefined;
	const output: SettlementFrontier[] = [];
	let previous: string | undefined;
	for (const entry of frontiers) {
		if (!Array.isArray(entry)) return undefined;
		const [author, admissionEpoch, terminalThrough] = entry;
		if (
			typeof author !== "string" ||
			!/^[0-9a-f]{64}$/u.test(author) ||
			(previous !== undefined && author <= previous) ||
			!Number.isSafeInteger(admissionEpoch) ||
			(admissionEpoch as number) < 0 ||
			(terminalThrough !== null && (!Number.isSafeInteger(terminalThrough) || (terminalThrough as number) < 0))
		) {
			return undefined;
		}
		previous = author;
		output.push(Object.freeze([author, admissionEpoch as number, terminalThrough as number | null]));
	}
	return Object.freeze(output);
}

/**
 * Validates the bounded adjacency and ACL transition laws for one settlement checkpoint.
 * The checkpoint opener deliberately does not perform these predecessor-relative checks.
 * @param input - Opened current/successor ACLs and proposed/predecessor settlement identities.
 * @returns A fail-closed transition verdict.
 */
export function inspectCreatorAuthorSettlementAdvance(
	input: unknown
): Readonly<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
	try {
		const captured = exactSettlementRecord(input, SETTLEMENT_ADVANCE_KEYS);
		const currentAcl = exactSettlementAcl(captured?.currentAcl);
		const successorAcl = exactSettlementAcl(captured?.successorAcl);
		const predecessor = captured?.predecessor;
		const proposed = exactSettlementRecord(captured?.proposed, SETTLEMENT_PROPOSED_KEYS);
		const capturedPredecessor =
			predecessor === null ? null : exactSettlementRecord(predecessor, SETTLEMENT_PREDECESSOR_KEYS);
		if (
			captured === undefined ||
			currentAcl === undefined ||
			successorAcl === undefined ||
			proposed === undefined ||
			(predecessor !== null && capturedPredecessor === undefined) ||
			exactSettlementFrontierArray(proposed.frontiers) === undefined ||
			(capturedPredecessor !== null &&
				(capturedPredecessor === undefined ||
					exactSettlementFrontierArray(capturedPredecessor.frontiers) === undefined))
		) {
			return Object.freeze({ ok: false, reason: "SETTLEMENT_ADVANCE_SHAPE_INVALID" });
		}
		if (capturedPredecessor === undefined) {
			return Object.freeze({ ok: false, reason: "SETTLEMENT_ADVANCE_SHAPE_INVALID" });
		}
		const currentMembers = settlementMembers(currentAcl);
		const successorMembers = settlementMembers(successorAcl);
		const proposedFrontiers = settlementFrontiers(proposed.frontiers);
		const currentEpoch = currentAcl.epoch;
		const successorEpoch = successorAcl.epoch;
		const closedEpoch = proposed.closedEpoch;
		const proposedSuccessorEpoch = proposed.successorEpoch;
		if (currentMembers === undefined || successorMembers === undefined || proposedFrontiers === undefined) {
			return Object.freeze({ ok: false, reason: "SETTLEMENT_ADVANCE_SHAPE_INVALID" });
		}
		if (
			closedEpoch !== currentEpoch ||
			proposedSuccessorEpoch !== successorEpoch ||
			!Number.isSafeInteger(closedEpoch) ||
			(successorEpoch as number) !== (closedEpoch as number) + 1 ||
			proposedFrontiers.length !== successorMembers.length ||
			proposedFrontiers.some((frontier, index) => frontier[0] !== successorMembers[index])
		) {
			return Object.freeze({ ok: false, reason: "SETTLEMENT_ADVANCE_INVALID" });
		}
		const currentSet = new Set(currentMembers);
		if (capturedPredecessor === null) {
			if (
				closedEpoch !== 0 ||
				proposed.priorCheckpointKind !== "genesis" ||
				proposed.priorCheckpointDigest !== CREATOR_AUTHOR_SETTLEMENT_GENESIS_SENTINEL
			) {
				return Object.freeze({ ok: false, reason: "SETTLEMENT_ADVANCE_INVALID" });
			}
			for (const [author, admissionEpoch, terminalThrough] of proposedFrontiers) {
				if (currentSet.has(author)) {
					if (admissionEpoch !== 0) return Object.freeze({ ok: false, reason: "SETTLEMENT_ADVANCE_INVALID" });
				} else if (admissionEpoch !== successorEpoch || terminalThrough !== null) {
					return Object.freeze({ ok: false, reason: "SETTLEMENT_ADVANCE_INVALID" });
				}
			}
			return Object.freeze({ ok: true });
		}
		const predecessorDigest = capturedPredecessor.candidateDigest;
		const predecessorClosedEpoch = capturedPredecessor.closedEpoch;
		const predecessorSuccessorEpoch = capturedPredecessor.successorEpoch;
		const predecessorFrontiers = settlementFrontiers(capturedPredecessor.frontiers);
		if (
			proposed.priorCheckpointKind !== "settled-v1" ||
			proposed.priorCheckpointDigest !== predecessorDigest ||
			typeof predecessorDigest !== "string" ||
			!/^[0-9a-f]{64}$/u.test(predecessorDigest) ||
			predecessorFrontiers === undefined ||
			predecessorSuccessorEpoch !== closedEpoch ||
			predecessorClosedEpoch !== (closedEpoch as number) - 1
		) {
			return Object.freeze({ ok: false, reason: "SETTLEMENT_ADVANCE_INVALID" });
		}
		const priorByAuthor = new Map(predecessorFrontiers.map((frontier) => [frontier[0], frontier]));
		for (const [author, admissionEpoch, terminalThrough] of proposedFrontiers) {
			if (!currentSet.has(author)) {
				if (admissionEpoch !== successorEpoch || terminalThrough !== null) {
					return Object.freeze({ ok: false, reason: "SETTLEMENT_ADVANCE_INVALID" });
				}
				continue;
			}
			const prior = priorByAuthor.get(author);
			if (
				prior === undefined ||
				admissionEpoch !== prior[1] ||
				(prior[2] !== null && (terminalThrough === null || terminalThrough < prior[2]))
			) {
				return Object.freeze({ ok: false, reason: "SETTLEMENT_ADVANCE_INVALID" });
			}
		}
		return Object.freeze({ ok: true });
	} catch {
		return Object.freeze({ ok: false, reason: "SETTLEMENT_ADVANCE_INVALID" });
	}
}

type CreatorTransitionSyntax = ReturnType<typeof createCreatorCanonicalSyntaxReader>;

function record(candidate: DetachedClosureCandidate, syntax?: CreatorTransitionSyntax): Readonly<Record<string, unknown>> | undefined {
	try {
		// The original selector is decode-only, NOT canonicalCreatorDataRecord.
		// Full-field users receive the existing syntax owner's detached copy.
		const decoded = syntax === undefined ? decodeCanonical(candidate.bytes) : syntax.decode(candidate.bytes);
		return decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)
			? (decoded as Readonly<Record<string, unknown>>)
			: undefined;
	} catch {
		return undefined;
	}
}

function candidateSelection(candidate: DetachedClosureCandidate, syntax?: CreatorTransitionSyntax): Readonly<Record<string, unknown>> | undefined {
	return syntax === undefined ? record(candidate) : syntax.selection(candidate.bytes);
}

function compareRef(left: GenerationRef, right: GenerationRef): number {
	return left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0;
}

/**
 * Shared exact-byte selection and signed-control authentication law.
 * @param candidates - Exact candidate bytes from the selected closure.
 * @param kind - Required recognized record kind.
 * @param epoch - Required authenticated epoch, when applicable.
 * @param phase - Required certificate phase, when applicable.
 * @returns Unique validated evidence, or undefined on ambiguity or refusal.
 */
export function uniqueCreatorTransitionCandidate(
	candidates: readonly DetachedClosureCandidate[],
	kind: string,
	epoch?: number,
	phase?: string,
	/** Internal synchronous syntax owner, never authentication or selection authority. */
	syntax?: ReturnType<typeof createCreatorCanonicalSyntaxReader>
): DetachedClosureCandidate | undefined {
	const matches = candidates.filter((candidate) => {
		const decoded = candidateSelection(candidate, syntax);
		return (
			decoded?.kind === kind &&
			(epoch === undefined ||
				(decoded.kind === "drp-anchor-trust-state" ? decoded.currentEpoch : decoded.epoch) === epoch) &&
			(phase === undefined || decoded.phase === phase)
		);
	});
	return matches.length === 1 ? matches[0] : undefined;
}

function failure(reason: string): Readonly<{ ok: false; reason: string }> {
	return Object.freeze({ ok: false as const, reason });
}

function sameRef(left: GenerationRef, right: GenerationRef): boolean {
	return left.byteLength === right.byteLength && left.digest === right.digest;
}

function exactCandidate(candidate: DetachedClosureCandidate): boolean {
	const digest = digestBlob(candidate.bytes);
	return digest.ok && digest.value === candidate.ref.digest && candidate.bytes.byteLength === candidate.ref.byteLength;
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function retirementCandidates(closure: CreatorTransitionClosure, syntax?: CreatorTransitionSyntax): readonly DetachedClosureCandidate[] {
	return closure.candidates.filter((candidate) => candidateSelection(candidate, syntax)?.kind === CREATOR_ISSUANCE_RETIREMENT_KIND);
}

function aggregateCandidates(closure: CreatorTransitionClosure, syntax?: CreatorTransitionSyntax): readonly DetachedClosureCandidate[] {
	return closure.candidates.filter((candidate) => candidateSelection(candidate, syntax)?.kind === CREATOR_AUTHOR_ISSUANCE_FRONTIERS_KIND);
}

function settlementCandidates(closure: CreatorTransitionClosure, syntax?: CreatorTransitionSyntax): readonly DetachedClosureCandidate[] {
	return closure.candidates.filter((candidate) => candidateSelection(candidate, syntax)?.kind === CREATOR_AUTHOR_SETTLEMENT_KIND);
}

/**
 * Shared exact-byte selection and signed-control authentication law.
 * @param closure - Exact authenticated closure refs.
 * @param candidate - Actual selected signed carrier.
 * @returns Unique validated evidence, or undefined on ambiguity or refusal.
 */
export function exactCreatorTransitionOccurrence(
	closure: readonly GenerationRef[],
	candidate: DetachedClosureCandidate
): boolean {
	return closure.filter((ref) => sameRef(ref, candidate.ref)).length === 1;
}

function currentAnchorAclDigest(closure: CreatorTransitionClosure, trust: CurrentAnchorTrust, syntax?: CreatorTransitionSyntax): string | undefined {
	const trustCandidate = uniqueCreatorTransitionCandidate(
		closure.candidates,
		"drp-anchor-trust-state",
		trust.currentEpoch,
		undefined,
		syntax
	);
	if (
		trustCandidate === undefined ||
		!exactCandidate(trustCandidate) ||
		!exactCreatorTransitionOccurrence(closure.closure, trustCandidate)
	) {
		return undefined;
	}
	const trustRecord = record(trustCandidate, syntax);
	const anchorBytes = trustRecord?.exactCanonicalCurrentAnchorPreimageBytes;
	if (!(anchorBytes instanceof Uint8Array)) return undefined;
	let anchor: Readonly<Record<string, unknown>> | undefined;
	try {
		const decoded = syntax === undefined ? decodeCanonical(anchorBytes) : syntax.decode(anchorBytes);
		anchor =
			decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)
				? (decoded as Readonly<Record<string, unknown>>)
				: undefined;
	} catch {
		return undefined;
	}
	return trustRecord?.currentAnchorDigest !== trust.currentAnchorDigest ||
		trustRecord.currentEpoch !== trust.currentEpoch ||
		trustRecord.genesisAnchorDigest !== trust.genesisAnchorDigest ||
		trustRecord.objectId !== trust.objectId ||
		trustRecord.profileId !== trust.profileId ||
		hex(hashDomain("ts-drp/epoch-anchor/v3", anchorBytes)) !== trust.currentAnchorDigest ||
		anchor?.kind !== "drp-epoch-anchor" ||
		anchor.objectId !== trust.objectId ||
		anchor.epoch !== trust.currentEpoch ||
		typeof anchor.aclDigest !== "string"
		? undefined
		: anchor.aclDigest;
}

/**
 * Shared exact-byte selection and signed-control authentication law.
 * @param candidate - Actual selected signed carrier.
 * @param floorTrust - Genuine authenticated successor trust.
 * @param cut - Exact actual closed CutValue occurrence.
 * @param qc - Exact actual commit-QC occurrence.
 * @returns Unique validated evidence, or undefined on ambiguity or refusal.
 */
export function openCreatorTransitionRetirement(
	candidate: DetachedClosureCandidate,
	floorTrust: CurrentAnchorTrust,
	cut: DetachedClosureCandidate,
	qc: DetachedClosureCandidate
):
	| Readonly<{
			readonly candidate: DetachedClosureCandidate;
			readonly identity: CreatorIssuanceRetirementIdentity;
			readonly capability: VerifiedCreatorIssuanceRetirement;
	  }>
	| undefined {
	const decodedCut = record(cut);
	if (
		!exactCandidate(candidate) ||
		!exactCandidate(cut) ||
		!exactCandidate(qc) ||
		typeof decodedCut?.snapshotManifestDigest !== "string"
	) {
		return undefined;
	}
	const opened = openCreatorIssuanceRetirement({
		exactCanonicalRecordBytes: candidate.bytes,
		expectedCommitQcRef: qc.ref,
		expectedCutValueDigest: hex(hashDomain("ts-drp/hard-epoch-cut/v3", cut.bytes)),
		expectedSnapshotManifestDigest: decodedCut.snapshotManifestDigest,
		floorTrust,
	});
	if (!opened.ok) return undefined;
	const identity = resolveCreatorIssuanceRetirement(opened.capability);
	return identity === undefined ||
		decodedCut.kind !== "drp-hard-epoch-cut" ||
		decodedCut.objectId !== identity.objectId ||
		decodedCut.epoch !== identity.closedEpoch ||
		decodedCut.previousAnchor !== identity.closedAnchorDigest
		? undefined
		: Object.freeze({ candidate, identity, capability: opened.capability });
}

/**
 * Shared exact-byte selection and signed-control authentication law.
 * @param candidate - Actual selected signed carrier.
 * @param floorTrust - Genuine authenticated successor trust.
 * @param cut - Exact actual closed CutValue occurrence.
 * @param qc - Exact actual commit-QC occurrence.
 * @param currentAuthority - Genuine current trust or actual closed ACL bytes.
 * @returns Unique validated evidence, or undefined on ambiguity or refusal.
 */
export function openCreatorTransitionAggregate(
	candidate: DetachedClosureCandidate,
	floorTrust: CurrentAnchorTrust,
	cut: DetachedClosureCandidate,
	qc: DetachedClosureCandidate,
	currentAuthority: Readonly<{
		readonly acl?: DetachedClosureCandidate;
		readonly trust?: CurrentAnchorTrust;
	}>
):
	| Readonly<{
			readonly candidate: DetachedClosureCandidate;
			readonly identity: CreatorAuthorIssuanceFrontiersIdentity;
			readonly capability: VerifiedCreatorAuthorIssuanceFrontiers;
	  }>
	| undefined {
	const decodedCut = record(cut);
	const decodedAcl = currentAuthority.acl === undefined ? undefined : record(currentAuthority.acl);
	const decodedAggregate = record(candidate);
	if (
		!exactCandidate(candidate) ||
		!exactCandidate(cut) ||
		!exactCandidate(qc) ||
		(currentAuthority.acl !== undefined && !exactCandidate(currentAuthority.acl)) ||
		typeof decodedCut?.snapshotManifestDigest !== "string" ||
		(currentAuthority.acl === undefined
			? currentAuthority.trust === undefined
			: decodedAcl?.kind !== "drp-v3-latched-acl") ||
		typeof decodedAggregate?.successorAclDigest !== "string"
	) {
		return undefined;
	}
	const expectedCurrentAclDigest =
		currentAuthority.acl === undefined
			? decodedAggregate.currentAclDigest
			: hex(hashDomain("ts-drp/latched-acl/v3", currentAuthority.acl.bytes));
	const opened = openCreatorAuthorIssuanceFrontiers({
		...(currentAuthority.trust === undefined ? {} : { currentTrust: currentAuthority.trust }),
		exactCanonicalRecordBytes: candidate.bytes,
		expectedCommitQcRef: qc.ref,
		expectedCurrentAclDigest,
		expectedCutValueDigest: hex(hashDomain("ts-drp/hard-epoch-cut/v3", cut.bytes)),
		expectedSnapshotManifestDigest: decodedCut.snapshotManifestDigest,
		expectedSuccessorAclDigest: decodedAggregate.successorAclDigest,
		floorTrust,
	});
	if (!opened.ok) return undefined;
	const identity = resolveCreatorAuthorIssuanceFrontiers(opened.capability);
	return identity === undefined ||
		decodedCut.kind !== "drp-hard-epoch-cut" ||
		decodedCut.objectId !== identity.objectId ||
		decodedCut.epoch !== identity.closedEpoch ||
		decodedCut.previousAnchor !== identity.closedAnchorDigest ||
		(decodedAcl !== undefined &&
			(decodedAcl.objectId !== identity.objectId || decodedAcl.epoch !== identity.closedEpoch))
		? undefined
		: Object.freeze({ candidate, identity, capability: opened.capability });
}

/**
 * Shared exact-byte selection and signed-control authentication law.
 * @param candidate - Actual selected signed carrier.
 * @param floorTrust - Genuine authenticated successor trust.
 * @param cut - Exact actual closed CutValue occurrence.
 * @param qc - Exact actual commit-QC occurrence.
 * @param expectedCurrentAclDigest - Authenticated closed ACL expectation.
 * @returns Unique validated evidence, or undefined on ambiguity or refusal.
 */
export function openCreatorTransitionSettlement(
	candidate: DetachedClosureCandidate,
	floorTrust: CurrentAnchorTrust,
	cut: DetachedClosureCandidate,
	qc: DetachedClosureCandidate,
	expectedCurrentAclDigest: string
):
	| Readonly<{
			readonly candidate: DetachedClosureCandidate;
			readonly identity: CreatorAuthorSettlementIdentity;
			readonly capability: VerifiedCreatorAuthorSettlement;
	  }>
	| undefined {
	const decodedCut = record(cut);
	const decodedSettlement = record(candidate);
	if (
		!exactCandidate(candidate) ||
		!exactCandidate(cut) ||
		!exactCandidate(qc) ||
		typeof decodedCut?.snapshotManifestDigest !== "string" ||
		typeof decodedSettlement?.successorAclDigest !== "string"
	) {
		return undefined;
	}
	const opened = openCreatorAuthorSettlement({
		exactCanonicalRecordBytes: candidate.bytes,
		expectedCommitQcRef: qc.ref,
		expectedCurrentAclDigest,
		expectedCutValueDigest: hex(hashDomain("ts-drp/hard-epoch-cut/v3", cut.bytes)),
		expectedSnapshotManifestDigest: decodedCut.snapshotManifestDigest,
		expectedSuccessorAclDigest: decodedSettlement.successorAclDigest,
		floorTrust,
	});
	if (!opened.ok) return undefined;
	const identity = resolveCreatorAuthorSettlement(opened.capability);
	return identity === undefined ||
		decodedCut.kind !== "drp-hard-epoch-cut" ||
		decodedCut.objectId !== identity.objectId ||
		decodedCut.epoch !== identity.closedEpoch ||
		decodedCut.previousAnchor !== identity.closedAnchorDigest ||
		decodedCut.historyRoot !== identity.historyRoot ||
		decodedCut.historySize !== identity.historySize ||
		identity.successorAnchorDigest !== floorTrust.currentAnchorDigest ||
		identity.successorEpoch !== floorTrust.currentEpoch
		? undefined
		: Object.freeze({ candidate, identity, capability: opened.capability });
}

/**
 * Opens the sole retirement carrier in one authenticated successor generation.
 * The returned capability is private to the Node lifecycle and cannot be
 * manufactured from durable row bytes alone.
 * @param input - Exact successor closure and its independently authenticated floor.
 * @returns An opaque historical-issuance capability or undefined on any ambiguity.
 */
export function openVerifiedCreatorHistoricalIssuance(
	input: Readonly<{
		readonly author: string;
		readonly closure: CreatorTransitionClosure;
		readonly floorTrust: CurrentAnchorTrust;
		readonly sourceTrust?: CurrentAnchorTrust;
	}>
): VerifiedCreatorHistoricalIssuance | undefined {
	try {
		if (input.floorTrust.currentEpoch < 1) return undefined;
		const closedEpoch = input.floorTrust.currentEpoch - 1;

		const acl = uniqueCreatorTransitionCandidate(input.closure.candidates, "drp-v3-latched-acl", closedEpoch);
		if (acl === undefined) return undefined;
		const evidence = openCreatorTransitionClosedCutEvidence(input);
		if (evidence === undefined) return undefined;
		let selected: CreatorHistoricalIssuanceIdentity | undefined;
		if (evidence.settlement !== undefined) {
			const opened = evidence.settlement;
			if (evidence.currentAclDigest !== hex(hashDomain("ts-drp/latched-acl/v3", acl.bytes))) return undefined;
			const frontier = frontierFor(opened.capability, input.author);
			if (frontier !== undefined)
				selected = Object.freeze({
					admissionEpoch: frontier[1],
					admittedAuthorSequence: frontier[2],
					author: frontier[0],
					closedAnchorDigest: opened.identity.closedAnchorDigest,
					closedEpoch: opened.identity.closedEpoch,
					objectId: opened.identity.objectId,
					successorAnchorDigest: opened.identity.successorAnchorDigest,
					successorEpoch: opened.identity.successorEpoch,
				});
		} else if (evidence.aggregate !== undefined) {
			const opened = evidence.aggregate;
			const frontier = opened.identity.frontiers.find(([author]) => author === input.author);
			if (frontier !== undefined)
				selected = Object.freeze({
					admittedAuthorSequence: frontier[1],
					author: frontier[0],
					closedAnchorDigest: opened.identity.closedAnchorDigest,
					closedEpoch: opened.identity.closedEpoch,
					objectId: opened.identity.objectId,
					successorAnchorDigest: opened.identity.successorAnchorDigest,
					successorEpoch: opened.identity.successorEpoch,
				});
		} else if (evidence.retirement !== undefined && evidence.retirement.identity.author === input.author) {
			const identity = evidence.retirement.identity;
			selected = Object.freeze({
				admittedAuthorSequence: identity.admittedAuthorSequence,
				author: identity.author,
				closedAnchorDigest: identity.closedAnchorDigest,
				closedEpoch: identity.closedEpoch,
				objectId: identity.objectId,
				successorAnchorDigest: identity.successorAnchorDigest,
				successorEpoch: identity.successorEpoch,
			});
		}
		if (
			selected === undefined ||
			selected.closedEpoch !== closedEpoch ||
			selected.successorEpoch !== input.floorTrust.currentEpoch ||
			selected.successorAnchorDigest !== input.floorTrust.currentAnchorDigest
		) {
			return undefined;
		}
		const capability = Object.freeze({}) as VerifiedCreatorHistoricalIssuance;
		const closedTrustCandidate = uniqueCreatorTransitionCandidate(input.closure.candidates, "drp-anchor-trust-state", closedEpoch);
		const closedTrustRecord = closedTrustCandidate === undefined ? undefined : record(closedTrustCandidate);
		const sourceMaterial = input.sourceTrust?.objectId === selected.objectId && input.sourceTrust.currentEpoch === selected.closedEpoch &&
			input.sourceTrust.currentAnchorDigest === selected.closedAnchorDigest ? readCreatorSettlementSourceAnchor(input.sourceTrust) : undefined;
		const sourceAnchor = sourceMaterial?.anchorPreimage ?? closedTrustRecord?.exactCanonicalCurrentAnchorPreimageBytes;
		const sourceSignature = sourceMaterial?.anchorSignature ?? closedTrustRecord?.detachedCurrentAnchorSignature;
		verifiedHistoricalIssuance.set(capability, Object.freeze({identity:selected,exactCanonicalLatchedAclBytes:new Uint8Array(acl.bytes),profileId:input.floorTrust.profileId,
			...(sourceAnchor instanceof Uint8Array && sourceSignature instanceof Uint8Array ? {
				exactCanonicalSourceAnchorPreimageBytes: new Uint8Array(sourceAnchor), detachedSourceAnchorSignature: new Uint8Array(sourceSignature),
			} : {}),
			...(evidence.settlement === undefined ? {} : {settlement:evidence.settlement.capability})}));
		return capability;
	} catch {
		return undefined;
	}
}

/**
 * Resolves a detached identity from a genuine Node-private capability.
 * @param capability - Capability returned by openVerifiedCreatorHistoricalIssuance.
 * @returns A detached frozen identity or undefined for foreign custody.
 */
export function resolveVerifiedCreatorHistoricalIssuance(
	capability: VerifiedCreatorHistoricalIssuance
): CreatorHistoricalIssuanceIdentity | undefined {
	const identity = verifiedHistoricalIssuance.get(capability)?.identity;
	return identity === undefined ? undefined : Object.freeze({ ...identity });
}

/** Original closed ACL retained by its genuine historical owner; not current-role authority. */
export function resolveVerifiedHistoricalSourceAcl(
	capability: VerifiedCreatorHistoricalIssuance,
	source: Readonly<{epoch:number;anchor:string;objectId:string}>
): LatchedAclSnapshot | undefined {
	const material = verifiedHistoricalIssuance.get(capability);
	if (material === undefined || material.identity.closedEpoch !== source.epoch ||
		material.identity.closedAnchorDigest !== source.anchor || material.identity.objectId !== source.objectId) return undefined;
	const opened = openCanonicalLatchedAclSnapshot({exactCanonicalLatchedAclBytes:new Uint8Array(material.exactCanonicalLatchedAclBytes),
		expectedAclDigest: hex(hashDomain("ts-drp/latched-acl/v3",material.exactCanonicalLatchedAclBytes)),
		expectedEpoch:source.epoch,expectedObjectId:source.objectId,expectedProfileId:material.profileId});
	return opened.ok ? opened.snapshot : undefined;
}

/** Selects many authors from the SAME genuine historical owner's complete
 * settlement, not a new authentication opener or current-role authority.
 * Source/target bindings and the owner's retained closed ACL are checked once;
 * each requested occurrence receives a detached frontier in its original order.
 * The existing v3 ACL/settlement roster bound caps this synchronous output, and
 * no input, parsed proof or selection survives the call in another owner.
 * @returns Frozen scalar frontiers, or undefined to retain the original opener.
 */
export function resolveVerifiedHistoricalSettlementFrontiers(
	capability: VerifiedCreatorHistoricalIssuance,
	source: Readonly<{epoch:number;anchor:string;objectId:string}>,
	target: Readonly<{epoch:number;anchor:string;objectId:string;profileId:string}>,
	authors: readonly string[]
): readonly SettlementFrontier[] | undefined {
	try {
		const material = verifiedHistoricalIssuance.get(capability);
		if (material?.settlement === undefined) return undefined;
		const closed = capturePromotionRecord(source, ["epoch", "anchor", "objectId"]);
		const successor = capturePromotionRecord(target, ["epoch", "anchor", "objectId", "profileId"]);
		const requested = capturePromotionArray(authors, 256);
		if (closed === undefined || successor === undefined || requested === undefined ||
			requested.some(author => typeof author !== "string") ||
			material.identity.closedEpoch !== closed.epoch ||
			material.identity.closedAnchorDigest !== closed.anchor ||
			material.identity.objectId !== closed.objectId ||
			material.identity.successorEpoch !== successor.epoch ||
			material.identity.successorAnchorDigest !== successor.anchor ||
			material.identity.objectId !== successor.objectId || material.profileId !== successor.profileId)
			return undefined;
		if (resolveVerifiedHistoricalSourceAcl(capability, {
			epoch: material.identity.closedEpoch,
			anchor: material.identity.closedAnchorDigest,
			objectId: material.identity.objectId,
		}) === undefined) return undefined;
		const output: SettlementFrontier[] = [];
		for (const author of requested as readonly string[]) {
			const frontier = frontierFor(material.settlement, author);
			if (frontier !== undefined) output.push(frontier);
		}
		return Object.freeze(output);
	} catch {
		return undefined;
	}
}

/** Exact original signed context retained by the authenticated native closed owner. */
export function resolveVerifiedHistoricalSourceContext(
	capability: VerifiedCreatorHistoricalIssuance,
	source: Readonly<{epoch:number;anchor:string;objectId:string}>
): Readonly<{anchorPreimage: Uint8Array; anchorSignature: Uint8Array; aclBytes: Uint8Array}> | undefined {
	const material = verifiedHistoricalIssuance.get(capability);
	if (material?.exactCanonicalSourceAnchorPreimageBytes === undefined || material.detachedSourceAnchorSignature === undefined ||
		resolveVerifiedHistoricalSourceAcl(capability, source) === undefined ||
		hex(hashDomain("ts-drp/epoch-anchor/v3", material.exactCanonicalSourceAnchorPreimageBytes)) !== source.anchor) return undefined;
	return Object.freeze({anchorPreimage: new Uint8Array(material.exactCanonicalSourceAnchorPreimageBytes),
		anchorSignature: new Uint8Array(material.detachedSourceAnchorSignature), aclBytes: new Uint8Array(material.exactCanonicalLatchedAclBytes)});
}

/**
 * Another author's frontier from the same authenticated closed settlement.
 * @param capability - Original native closed-history owner.
 * @param source - Exact original context and author.
 * @returns Independently authenticated admission incarnation and settled sequence.
 */
export function resolveVerifiedHistoricalSourceFrontier(
	capability: VerifiedCreatorHistoricalIssuance,
	source: Readonly<{ epoch: number; anchor: string; objectId: string; author: string }>
): Readonly<{ admissionEpoch: number; terminalThrough: number | null }> | undefined {
	const material = verifiedHistoricalIssuance.get(capability);
	if (material?.settlement === undefined || resolveVerifiedHistoricalSourceAcl(capability, source) === undefined)
		return undefined;
	const frontier = frontierFor(material.settlement, source.author);
	return frontier === undefined
		? undefined
		: Object.freeze({ admissionEpoch: frontier[1], terminalThrough: frontier[2] });
}

function authenticatedRetirementPair(input: InspectCreatorTransitionAdvanceInput, syntax?: CreatorTransitionSyntax):
	| Readonly<{
			readonly current?: DetachedClosureCandidate;
			readonly currentIdentity?: CreatorIssuanceRetirementIdentity;
			readonly proposed: DetachedClosureCandidate;
			readonly proposedIdentity: CreatorIssuanceRetirementIdentity;
	  }>
	| undefined {
	if (
		input.currentTrust.currentEpoch < 0 ||
		input.successorTrust.currentEpoch !== input.currentTrust.currentEpoch + 1 ||
		input.currentTrust.objectId !== input.successorTrust.objectId ||
		input.currentTrust.genesisAnchorDigest !== input.successorTrust.genesisAnchorDigest ||
		input.proofRefs.length !== 2
	) {
		return undefined;
	}
	const currentMatches = retirementCandidates(input.current, syntax);
	const proposedMatches = retirementCandidates(input.proposed, syntax);
	if (proposedMatches.length !== 1 || currentMatches.length !== (input.currentTrust.currentEpoch === 0 ? 0 : 1)) {
		return undefined;
	}
	const proposedRetirement = proposedMatches[0] as DetachedClosureCandidate;
	if (!exactCreatorTransitionOccurrence(input.proposed.closure, proposedRetirement)) return undefined;
	if (
		currentMatches.length === 1 &&
		!exactCreatorTransitionOccurrence(input.current.closure, currentMatches[0] as DetachedClosureCandidate)
	) {
		return undefined;
	}
	const proposedCut = input.proposed.candidates.find((candidate) =>
		sameRef(candidate.ref, input.proofRefs[0] as GenerationRef)
	);
	const proposedQc = input.proposed.candidates.find((candidate) =>
		sameRef(candidate.ref, input.proofRefs[1] as GenerationRef)
	);
	if (proposedCut === undefined || proposedQc === undefined) return undefined;
	const openedProposed = openCreatorTransitionRetirement(
		proposedRetirement,
		input.successorTrust,
		proposedCut,
		proposedQc
	);
	if (
		openedProposed === undefined ||
		openedProposed.identity.closedEpoch !== input.currentTrust.currentEpoch ||
		openedProposed.identity.closedAnchorDigest !== input.currentTrust.currentAnchorDigest
	) {
		return undefined;
	}
	if (input.currentTrust.currentEpoch === 0) {
		return openedProposed.identity.priorAdmittedAuthorSequence === null &&
			openedProposed.identity.priorRetirementCandidateDigest === CREATOR_ISSUANCE_RETIREMENT_GENESIS_SENTINEL
			? Object.freeze({ proposed: openedProposed.candidate, proposedIdentity: openedProposed.identity })
			: undefined;
	}
	const currentCandidate = currentMatches[0] as DetachedClosureCandidate;
	const retiringCut = uniqueCreatorTransitionCandidate(
		input.current.candidates,
		"drp-hard-epoch-cut",
		input.currentTrust.currentEpoch - 1,
		undefined,
		syntax
	);
	const retiringQc = uniqueCreatorTransitionCandidate(
		input.current.candidates,
		"drp-seal-qc",
		input.currentTrust.currentEpoch - 1,
		"commit",
		syntax
	);
	if (retiringCut === undefined || retiringQc === undefined) return undefined;
	const openedCurrent = openCreatorTransitionRetirement(currentCandidate, input.currentTrust, retiringCut, retiringQc);
	return openedCurrent !== undefined &&
		openedProposed.identity.author === openedCurrent.identity.author &&
		openedProposed.identity.priorRetirementCandidateDigest === currentCandidate.ref.digest &&
		openedProposed.identity.priorAdmittedAuthorSequence === openedCurrent.identity.admittedAuthorSequence &&
		openedProposed.identity.admittedAuthorSequence >= openedCurrent.identity.admittedAuthorSequence
		? Object.freeze({
				current: currentCandidate,
				currentIdentity: openedCurrent.identity,
				proposed: openedProposed.candidate,
				proposedIdentity: openedProposed.identity,
			})
		: undefined;
}

/**
 * Authenticates the sole closed-cut representation using the shared control openers.
 * This does not reconstruct the erased closed-epoch trust or replay its seal.
 * @param input - Authenticated successor and exact selected closure.
 * @returns Genuine signed evidence, or undefined on ambiguity/binding failure.
 */
export function openCreatorTransitionClosedCutEvidence(
	input: Readonly<{
		closure: CreatorTransitionClosure;
		floorTrust: CurrentAnchorTrust;
		currentTrust?: CurrentAnchorTrust;
	}>
):
	| Readonly<{
			cut: DetachedClosureCandidate;
			qc: DetachedClosureCandidate;
			representation: "settlement" | "aggregate-retirement" | "retirement-only";
			currentAclDigest?: string;
			retirement?: NonNullable<ReturnType<typeof openCreatorTransitionRetirement>>;
			aggregate?: NonNullable<ReturnType<typeof openCreatorTransitionAggregate>>;
			settlement?: NonNullable<ReturnType<typeof openCreatorTransitionSettlement>>;
	  }>
	| undefined {
	// One synchronous opener owns syntax for all of its candidate selectors.
	// Full authentication below still opens the original exact bytes and trust;
	// the reader compares mutable input bytes on every repeated syntax access.
	const syntax = createCreatorCanonicalSyntaxReader();
	const record = (candidate: DetachedClosureCandidate) => syntax.selection(candidate.bytes);
	const select = (
		candidates: readonly DetachedClosureCandidate[], kind: string, epoch?: number, phase?: string
	) => uniqueCreatorTransitionCandidate(candidates, kind, epoch, phase, syntax);
	const retirementCandidates = (closure: CreatorTransitionClosure) =>
		closure.candidates.filter(candidate => record(candidate)?.kind === CREATOR_ISSUANCE_RETIREMENT_KIND);
	const aggregateCandidates = (closure: CreatorTransitionClosure) =>
		closure.candidates.filter(candidate => record(candidate)?.kind === CREATOR_AUTHOR_ISSUANCE_FRONTIERS_KIND);
	const settlementCandidates = (closure: CreatorTransitionClosure) =>
		closure.candidates.filter(candidate => record(candidate)?.kind === CREATOR_AUTHOR_SETTLEMENT_KIND);
	const epoch = input.floorTrust.currentEpoch - 1;
	const cut = select(input.closure.candidates, "drp-hard-epoch-cut", epoch);
	const qc = select(input.closure.candidates, "drp-seal-qc", epoch, "commit");
	if (
		cut === undefined ||
		qc === undefined ||
		!exactCreatorTransitionOccurrence(input.closure.closure, cut) ||
		!exactCreatorTransitionOccurrence(input.closure.closure, qc)
	)
		return undefined;
	const retirements = retirementCandidates(input.closure);
	const aggregates = aggregateCandidates(input.closure);
	const settlements = settlementCandidates(input.closure);
	if (settlementProfileFor(input.floorTrust.profileId) === "v1") {
		const candidate = settlements[0];
		const digest = candidate === undefined ? undefined : record(candidate)?.currentAclDigest;
		if (
			retirements.length !== 0 ||
			aggregates.length !== 0 ||
			settlements.length !== 1 ||
			candidate === undefined ||
			typeof digest !== "string" ||
			!exactCreatorTransitionOccurrence(input.closure.closure, candidate)
		)
			return undefined;
		const opened = openCreatorTransitionSettlement(candidate, input.floorTrust, cut, qc, digest);
		return opened === undefined
			? undefined
			: Object.freeze({
					cut,
					qc,
					representation: "settlement",
					settlement: opened,
					currentAclDigest: opened.identity.currentAclDigest,
				});
	}
	if (settlements.length !== 0 || retirements.length !== 1 || aggregates.length > 1) return undefined;
	const retirementCandidate = retirements[0];
	if (
		retirementCandidate === undefined ||
		!exactCreatorTransitionOccurrence(input.closure.closure, retirementCandidate)
	)
		return undefined;
	const retirement = openCreatorTransitionRetirement(retirementCandidate, input.floorTrust, cut, qc);
	if (retirement === undefined) return undefined;
	if (aggregates.length === 0) return Object.freeze({ cut, qc, representation: "retirement-only", retirement });
	const aggregate = aggregates[0];
	const acl = select(input.closure.candidates, "drp-v3-latched-acl", epoch);
	if (aggregate === undefined || !exactCreatorTransitionOccurrence(input.closure.closure, aggregate)) return undefined;
	const opened = openCreatorTransitionAggregate(
		aggregate,
		input.floorTrust,
		cut,
		qc,
		input.currentTrust === undefined ? { acl } : { trust: input.currentTrust }
	);
	return opened === undefined
		? undefined
		: Object.freeze({
				cut,
				qc,
				representation: "aggregate-retirement",
				retirement,
				aggregate: opened,
				currentAclDigest: opened.identity.currentAclDigest,
			});
}

function authenticatedAggregatePair(
	input: InspectCreatorTransitionAdvanceInput,
	retirement: NonNullable<ReturnType<typeof authenticatedRetirementPair>>,
	syntax?: CreatorTransitionSyntax
):
	| Readonly<{
			readonly current?: DetachedClosureCandidate;
			readonly proposed: DetachedClosureCandidate;
	  }>
	| undefined {
	const currentMatches = aggregateCandidates(input.current, syntax);
	const proposedMatches = aggregateCandidates(input.proposed, syntax);
	if (currentMatches.length > 1 || proposedMatches.length !== 1) return undefined;
	const proposed = proposedMatches[0] as DetachedClosureCandidate;
	if (!exactCreatorTransitionOccurrence(input.proposed.closure, proposed)) return undefined;
	const proposedCut = input.proposed.candidates.find((candidate) =>
		sameRef(candidate.ref, input.proofRefs[0] as GenerationRef)
	);
	const proposedQc = input.proposed.candidates.find((candidate) =>
		sameRef(candidate.ref, input.proofRefs[1] as GenerationRef)
	);
	if (proposedCut === undefined || proposedQc === undefined) return undefined;
	const openedProposed = openCreatorTransitionAggregate(proposed, input.successorTrust, proposedCut, proposedQc, {
		trust: input.currentTrust,
	});
	if (
		openedProposed === undefined ||
		openedProposed.identity.closedEpoch !== input.currentTrust.currentEpoch ||
		openedProposed.identity.closedAnchorDigest !== input.currentTrust.currentAnchorDigest
	) {
		return undefined;
	}
	const legacyFrontier = openedProposed.identity.frontiers.find(
		([author]) => author === retirement.proposedIdentity.author
	);
	if (legacyFrontier !== undefined && legacyFrontier[1] !== retirement.proposedIdentity.admittedAuthorSequence) {
		return undefined;
	}
	if (currentMatches.length === 0) {
		return openedProposed.identity.priorAggregateCandidateDigest === CREATOR_AUTHOR_ISSUANCE_FRONTIERS_GENESIS_SENTINEL
			? Object.freeze({ proposed })
			: undefined;
	}
	const current = currentMatches[0] as DetachedClosureCandidate;
	if (!exactCreatorTransitionOccurrence(input.current.closure, current)) return undefined;
	const closedEpoch = input.currentTrust.currentEpoch - 1;
	const currentCut = uniqueCreatorTransitionCandidate(input.current.candidates, "drp-hard-epoch-cut", closedEpoch, undefined, syntax);
	const currentQc = uniqueCreatorTransitionCandidate(input.current.candidates, "drp-seal-qc", closedEpoch, "commit", syntax);
	const currentAcl = uniqueCreatorTransitionCandidate(input.current.candidates, "drp-v3-latched-acl", closedEpoch, undefined, syntax);
	if (currentCut === undefined || currentQc === undefined || currentAcl === undefined) return undefined;
	const openedCurrent = openCreatorTransitionAggregate(current, input.currentTrust, currentCut, currentQc, {
		acl: currentAcl,
	});
	if (openedCurrent === undefined || openedProposed.identity.priorAggregateCandidateDigest !== current.ref.digest) {
		return undefined;
	}
	const proposedByAuthor = new Map(openedProposed.identity.frontiers);
	for (const [author, boundary] of openedCurrent.identity.frontiers) {
		const next = proposedByAuthor.get(author);
		if (next !== undefined && boundary !== null && (next === null || next < boundary)) return undefined;
	}
	return Object.freeze({ current, proposed });
}

function authenticatedSettlementPair(
	input: InspectCreatorTransitionAdvanceInput,
	syntax?: CreatorTransitionSyntax,
	openSettlement: typeof openCreatorTransitionSettlement = openCreatorTransitionSettlement
):
	| Readonly<{
			readonly current?: DetachedClosureCandidate;
			readonly proposed: DetachedClosureCandidate;
	  }>
	| undefined {
	if (
		settlementProfileFor(input.currentTrust.profileId) !== "v1" ||
		settlementProfileFor(input.successorTrust.profileId) !== "v1" ||
		input.successorTrust.currentEpoch !== input.currentTrust.currentEpoch + 1 ||
		input.currentTrust.objectId !== input.successorTrust.objectId ||
		input.currentTrust.genesisAnchorDigest !== input.successorTrust.genesisAnchorDigest ||
		input.proofRefs.length !== 2 ||
		retirementCandidates(input.current, syntax).length !== 0 ||
		retirementCandidates(input.proposed, syntax).length !== 0 ||
		aggregateCandidates(input.current, syntax).length !== 0 ||
		aggregateCandidates(input.proposed, syntax).length !== 0
	) {
		return undefined;
	}
	const currentMatches = settlementCandidates(input.current, syntax);
	const proposedMatches = settlementCandidates(input.proposed, syntax);
	if (currentMatches.length !== (input.currentTrust.currentEpoch === 0 ? 0 : 1) || proposedMatches.length !== 1) {
		return undefined;
	}
	const proposed = proposedMatches[0] as DetachedClosureCandidate;
	if (!exactCreatorTransitionOccurrence(input.proposed.closure, proposed)) return undefined;
	const proposedCut = input.proposed.candidates.find((candidate) =>
		sameRef(candidate.ref, input.proofRefs[0] as GenerationRef)
	);
	const proposedQc = input.proposed.candidates.find((candidate) =>
		sameRef(candidate.ref, input.proofRefs[1] as GenerationRef)
	);
	const currentAclDigest = currentAnchorAclDigest(input.current, input.currentTrust, syntax);
	if (proposedCut === undefined || proposedQc === undefined || currentAclDigest === undefined) return undefined;
	const openedProposed = openSettlement(
		proposed,
		input.successorTrust,
		proposedCut,
		proposedQc,
		currentAclDigest
	);
	if (
		openedProposed === undefined ||
		openedProposed.identity.closedEpoch !== input.currentTrust.currentEpoch ||
		openedProposed.identity.closedAnchorDigest !== input.currentTrust.currentAnchorDigest
	) {
		return undefined;
	}
	const openAcl = (bytes: Uint8Array, trust: CurrentAnchorTrust, digest: string): LatchedAclSnapshot | undefined => {
		const opened = openCanonicalLatchedAclSnapshot({
			exactCanonicalLatchedAclBytes: bytes,
			expectedAclDigest: digest,
			expectedEpoch: trust.currentEpoch,
			expectedObjectId: trust.objectId,
			expectedProfileId: trust.profileId,
		});
		return opened.ok ? opened.snapshot : undefined;
	};
	if (input.mode === "stage" && input.settlementAcl === undefined) return undefined;
	const boundCurrentAcl =
		input.settlementAcl === undefined
			? undefined
			: openAcl(input.settlementAcl.current, input.currentTrust, currentAclDigest);
	const boundSuccessorAcl =
		input.settlementAcl === undefined
			? undefined
			: openAcl(input.settlementAcl.successor, input.successorTrust, openedProposed.identity.successorAclDigest);
	if (input.settlementAcl !== undefined && (boundCurrentAcl === undefined || boundSuccessorAcl === undefined))
		return undefined;
	const advance = (
		predecessor: null | {
			candidateDigest: string;
			closedEpoch: number;
			successorEpoch: number;
			frontiers: CreatorAuthorSettlementIdentity["frontiers"];
		}
	): ReturnType<typeof inspectCreatorAuthorSettlementAdvance> => {
		// The early verify pass authenticates the cryptographic closure before
		// snapshot I/O. Its caller must repeat with snapshot ACLs before acceptance.
		if (input.settlementAcl === undefined) return Object.freeze({ ok: true });
		return inspectCreatorAuthorSettlementAdvance({
			currentAcl: boundCurrentAcl,
			successorAcl: boundSuccessorAcl,
			predecessor,
			proposed: {
				closedEpoch: openedProposed.identity.closedEpoch,
				successorEpoch: openedProposed.identity.successorEpoch,
				frontiers: openedProposed.identity.frontiers,
				priorCheckpointDigest: openedProposed.identity.priorCheckpointDigest,
				priorCheckpointKind: openedProposed.identity.priorCheckpointKind,
			},
		});
	};
	if (input.currentTrust.currentEpoch === 0) {
		return openedProposed.identity.priorCheckpointKind === "genesis" &&
			openedProposed.identity.priorCheckpointDigest === CREATOR_AUTHOR_SETTLEMENT_GENESIS_SENTINEL &&
			advance(null).ok
			? Object.freeze({ proposed })
			: undefined;
	}
	const current = currentMatches[0] as DetachedClosureCandidate;
	if (!exactCreatorTransitionOccurrence(input.current.closure, current)) return undefined;
	const closedEpoch = input.currentTrust.currentEpoch - 1;
	const currentCut = uniqueCreatorTransitionCandidate(input.current.candidates, "drp-hard-epoch-cut", closedEpoch, undefined, syntax);
	const currentQc = uniqueCreatorTransitionCandidate(input.current.candidates, "drp-seal-qc", closedEpoch, "commit", syntax);
	const currentAcl = uniqueCreatorTransitionCandidate(input.current.candidates, "drp-v3-latched-acl", closedEpoch, undefined, syntax);
	if (currentCut === undefined || currentQc === undefined || currentAcl === undefined || !exactCandidate(currentAcl)) {
		return undefined;
	}
	const openedCurrent = openSettlement(
		current,
		input.currentTrust,
		currentCut,
		currentQc,
		hex(hashDomain("ts-drp/latched-acl/v3", currentAcl.bytes))
	);
	return openedCurrent !== undefined &&
		openedProposed.identity.priorCheckpointKind === "settled-v1" &&
		openedProposed.identity.priorCheckpointDigest === current.ref.digest &&
		advance({
			candidateDigest: current.ref.digest,
			closedEpoch: openedCurrent.identity.closedEpoch,
			successorEpoch: openedCurrent.identity.successorEpoch,
			frontiers: openedCurrent.identity.frontiers,
		}).ok
		? Object.freeze({ current, proposed })
		: undefined;
}

/**
 * Selects the compatibility or bounded transition predicate and owns stale-ref derivation.
 * @param input - Current/proposed closure pair, new proof refs, and staging/verification mode.
 * @returns The authenticated proposal (normalized only for in-memory staging) or a rejection.
 */
export function inspectCreatorTransitionAdvance(
	input: InspectCreatorTransitionAdvanceInput
): InspectCreatorTransitionAdvanceResult {
	return inspectCreatorTransitionAdvanceOwned(input);
}

function inspectCreatorTransitionAdvanceOwned(
	input: InspectCreatorTransitionAdvanceInput,
	openSettlement: typeof openCreatorTransitionSettlement = openCreatorTransitionSettlement
): InspectCreatorTransitionAdvanceResult {
	try {
		// One bounded synchronous owner shares decode-only syntax across the full
		// current/proposed selection tree. Nothing retains this reader after return;
		// selected bytes, refs, hashes and every authentication opener remain fresh.
		const syntax = createCreatorCanonicalSyntaxReader();
		const withoutControlCandidates = (
			closure: CreatorTransitionClosure,
			candidates: readonly (DetachedClosureCandidate | undefined)[]
		): CreatorTransitionClosure =>
			Object.freeze({
				candidates: Object.freeze(
					closure.candidates.filter(
						(item) => !candidates.some((candidate) => candidate !== undefined && sameRef(item.ref, candidate.ref))
					)
				),
				closure: Object.freeze(
					closure.closure.filter(
						(ref) => !candidates.some((candidate) => candidate !== undefined && sameRef(ref, candidate.ref))
					)
				),
			});
		let normalizedCurrent: CreatorTransitionClosure;
		let normalizedProposed: CreatorTransitionClosure;
		let proposedControls: readonly DetachedClosureCandidate[];
		const currentSettlementProfile = settlementProfileFor(input.currentTrust.profileId);
		const successorSettlementProfile = settlementProfileFor(input.successorTrust.profileId);
		if (currentSettlementProfile !== "none" || successorSettlementProfile !== "none") {
			const settlement = authenticatedSettlementPair(input, syntax, openSettlement);
			if (settlement === undefined) return failure("TRUST_CLOSURE_INVALID");
			normalizedCurrent = withoutControlCandidates(input.current, [settlement.current]);
			normalizedProposed = withoutControlCandidates(input.proposed, [settlement.proposed]);
			proposedControls = Object.freeze([settlement.proposed]);
		} else {
			const retirement = authenticatedRetirementPair(input, syntax);
			if (retirement === undefined) return failure("TRUST_CLOSURE_INVALID");
			const aggregate = authenticatedAggregatePair(input, retirement, syntax);
			if (aggregate === undefined) return failure("TRUST_CLOSURE_INVALID");
			normalizedCurrent = withoutControlCandidates(input.current, [retirement.current, aggregate.current]);
			normalizedProposed = withoutControlCandidates(input.proposed, [retirement.proposed, aggregate.proposed]);
			proposedControls = Object.freeze([retirement.proposed, aggregate.proposed]);
		}
		const trustCandidates = input.current.candidates.filter(
			(candidate) => candidateSelection(candidate, syntax)?.kind === "drp-anchor-trust-state"
		);
		const historyKind = "creator-close-history-1";
		const oldHistory = input.current.candidates.filter((candidate) => candidateSelection(candidate, syntax)?.kind === historyKind);
		const histories = input.proposed.candidates.filter((candidate) => candidateSelection(candidate, syntax)?.kind === historyKind);
		const newCut = input.proposed.candidates.find((candidate) =>
			sameRef(candidate.ref, input.proofRefs[0] as GenerationRef)
		);
		const history = histories.find(
			(candidate) =>
				record(candidate, syntax)?.cutValueDigest ===
				(newCut === undefined ? undefined : hex(hashDomain("ts-drp/hard-epoch-cut/v3", newCut.bytes)))
		);
		if (oldHistory.length > 1 || histories.length > 2) return failure("TRUST_CLOSURE_INVALID");
		if (history !== undefined) {
			if (
				histories.some(
					(candidate) =>
						!sameRef(candidate.ref, history.ref) && !oldHistory.some((old) => sameRef(old.ref, candidate.ref))
				)
			)
				return failure("TRUST_CLOSURE_INVALID");
			const decoded = record(history, syntax);
			const cut = newCut === undefined ? undefined : record(newCut, syntax);
			if (
				!exactCandidate(history) ||
				decoded === undefined ||
				cut === undefined ||
				newCut === undefined ||
				openCreatorCloseHistory({
					bytes: history.bytes,
					exactCanonicalCutValueBytes: newCut.bytes,
					historyRoot: cut.historyRoot,
					historySize: cut.historySize,
				}) === undefined
			)
				return failure("TRUST_CLOSURE_INVALID");
			if (input.mode === "verify" && histories.length !== 1) return failure("TRUST_CLOSURE_INVALID");
			normalizedCurrent = withoutControlCandidates(normalizedCurrent, oldHistory);
			normalizedProposed = withoutControlCandidates(normalizedProposed, histories);
			proposedControls = Object.freeze([...proposedControls, history]);
		} else if (histories.length !== 0 || oldHistory.length !== 0) return failure("TRUST_CLOSURE_INVALID");
		if (trustCandidates.length !== 1) return failure("TRUST_CLOSURE_INVALID");
		const trust = record(trustCandidates[0] as DetachedClosureCandidate, syntax);
		if (typeof trust?.currentEpoch !== "number" || !Number.isSafeInteger(trust.currentEpoch)) {
			return failure("TRUST_CLOSURE_INVALID");
		}
		if (trust.currentEpoch === 0) {
			const result = inspectCreatorTrustAdvance({
				current: normalizedCurrent,
				proofRefs: input.proofRefs,
				proposed: normalizedProposed,
			});
			return result.ok
				? Object.freeze({ kind: result.kind, ok: true as const, proposed: input.proposed })
				: failure(result.reason);
		}
		const retiringEpoch = trust.currentEpoch - 1;
		const retiringCut = uniqueCreatorTransitionCandidate(input.current.candidates, "drp-hard-epoch-cut", retiringEpoch, undefined, syntax);
		const retiringQc = uniqueCreatorTransitionCandidate(
			input.current.candidates,
			"drp-seal-qc",
			retiringEpoch,
			"commit",
			syntax
		);
		const retiringAcl = uniqueCreatorTransitionCandidate(input.current.candidates, "drp-v3-latched-acl", retiringEpoch, undefined, syntax);
		if (retiringCut === undefined || retiringQc === undefined || retiringAcl === undefined) {
			return failure("RETIRING_PROOF_REFS_INVALID");
		}
		const previousHistory = oldHistory[0];
		const previousCut = record(retiringCut, syntax);
		if (
			previousHistory !== undefined &&
			(!exactCandidate(previousHistory) ||
				previousCut === undefined ||
				openCreatorCloseHistory({
					bytes: previousHistory.bytes,
					exactCanonicalCutValueBytes: retiringCut.bytes,
					historyRoot: previousCut.historyRoot,
					historySize: previousCut.historySize,
				}) === undefined)
		)
			return failure("TRUST_CLOSURE_INVALID");
		const retiring = new Set([retiringCut.ref.digest, retiringQc.ref.digest, retiringAcl.ref.digest]);
		const proposedWithoutRetiring =
			input.mode === "stage"
				? Object.freeze({
						candidates: Object.freeze(
							normalizedProposed.candidates.filter((candidate) => !retiring.has(candidate.ref.digest))
						),
						closure: Object.freeze(
							normalizedProposed.closure.filter((ref) => !retiring.has(ref.digest)).sort(compareRef)
						),
					})
				: normalizedProposed;
		const result = inspectBoundedCreatorTrustAdvance({
			current: normalizedCurrent,
			proofRefs: input.proofRefs,
			proposed: proposedWithoutRetiring,
			retiringPredecessorAclRef: retiringAcl.ref,
			retiringProofRefs: [retiringCut.ref, retiringQc.ref],
		});
		if (!result.ok) return failure(result.reason);
		const proposed =
			input.mode === "verify"
				? input.proposed
				: Object.freeze({
						candidates: Object.freeze(
							[...proposedWithoutRetiring.candidates, ...proposedControls].sort((left, right) =>
								compareRef(left.ref, right.ref)
							)
						),
						closure: Object.freeze(
							[...proposedWithoutRetiring.closure, ...proposedControls.map(({ ref }) => ref)].sort(compareRef)
						),
					});
		return Object.freeze({ kind: result.kind, ok: true as const, proposed });
	} catch {
		return failure("TRUST_CLOSURE_INVALID");
	}
}

/**
 * Owns only the early/late settlement signature facts of one authentication
 * frame. The late call still executes the complete transition predicate and
 * opens its snapshot ACLs; this handle is never admission or storage authority.
 * Capture is optional: unsupported or changed inputs use the original opener.
 * @param input - Original independently authenticated closure/trust pair.
 * @returns Original early result, a fresh late predicate, and bounded cleanup.
 */
export function prepareCreatorTransitionAdvanceRecheck(input: InspectCreatorTransitionAdvanceInput): Readonly<{
	initial: InspectCreatorTransitionAdvanceResult;
	recheck(settlementAcl: InspectCreatorTransitionAdvanceInput["settlementAcl"]): InspectCreatorTransitionAdvanceResult;
	release(): void;
}> {
	type Opening = NonNullable<ReturnType<typeof openCreatorTransitionSettlement>>;
	type Arguments = Parameters<typeof openCreatorTransitionSettlement>;
	type Fact = Readonly<{
		args: Arguments;
		capability: VerifiedCreatorAuthorSettlement;
		trust: CurrentAnchorTrust;
		material: NonNullable<ReturnType<typeof resolveSealRecoveryTrust>>;
	}>;
	let original: InspectCreatorTransitionAdvanceInput | undefined = input;
	let basis: Readonly<{ current: CreatorTransitionClosure; proposed: CreatorTransitionClosure; refs: readonly GenerationRef[] }> | undefined;
	let facts: readonly Fact[] = [];
	const opened: { args: Arguments; result: Opening }[] = [];
	const initial = inspectCreatorTransitionAdvanceOwned(input, (...args) => {
		const result = openCreatorTransitionSettlement(...args);
		if (result !== undefined && opened.length < 2) opened.push({ args, result });
		return result;
	});
	// This optional copying happens only after the original early result. A
	// capture refusal cannot replace the original result or narrow supported work.
	if (initial.ok && opened.length > 0) {
		try {
			let retainedBytes = 0;
			const charge = (bytes: Uint8Array): boolean => {
				retainedBytes += bytes.byteLength;
				return retainedBytes <= AHE_BOUNDED_READ_LIMITS.maxUnionBytes;
			};
			const current = capturePromotionClosure(input.current, charge),
				proposed = capturePromotionClosure(input.proposed, charge),
				refs = input.proofRefs.map((ref) => capturePromotionRef(ref));
			if (current !== undefined && proposed !== undefined && refs.every((ref) => ref !== undefined)) {
				const candidates = [...current.candidates, ...proposed.candidates];
				const captured: Fact[] = [];
				for (const opening of opened) {
					const [candidate, trust, cut, qc, aclDigest] = opening.args;
					const copy = (item: DetachedClosureCandidate): DetachedClosureCandidate | undefined =>
						candidates.find((value) => sameRef(value.ref, item.ref) && compareBytes(value.bytes, item.bytes) === 0);
					const copiedCandidate = copy(candidate), copiedCut = copy(cut), copiedQc = copy(qc);
					// Original nominal trust custody supplies detached immutable input
					// material; no candidate schema or copied trust can manufacture it.
					const material = resolveSealRecoveryTrust(trust);
					if (copiedCandidate === undefined || copiedCut === undefined || copiedQc === undefined || material === undefined ||
						!openSealAuthority({ trust, signerPublicKey: material.publicKey }).ok)
						throw new TypeError("settlement frame capture unavailable");
					if (![material.publicKey, material.exactCanonicalCurrentAnchorPreimageBytes, material.detachedCurrentAnchorSignature,
						material.exactCanonicalProfileBytes, material.exactCanonicalSignerSetBytes].every(charge))
						throw new TypeError("settlement frame capture budget exceeded");
					captured.push(Object.freeze({
						args: [copiedCandidate, trust, copiedCut, copiedQc, aclDigest] as Arguments,
						capability: opening.result.capability,
						trust: Object.freeze({ currentEpoch: trust.currentEpoch, currentAnchorDigest: trust.currentAnchorDigest,
							objectId: trust.objectId, genesisAnchorDigest: trust.genesisAnchorDigest, profileId: trust.profileId }),
						material,
					}));
				}
				basis = Object.freeze({ current, proposed, refs: refs as GenerationRef[] });
				facts = Object.freeze(captured);
			}
		} catch { basis = undefined; facts = []; }
	}
	opened.length = 0;
	const sameClosure = (a: CreatorTransitionClosure, b: CreatorTransitionClosure): boolean =>
		a.closure.length === b.closure.length && a.candidates.length === b.candidates.length &&
		a.closure.every((ref, index) => sameRef(ref, b.closure[index] as GenerationRef)) &&
		a.candidates.every((item, index) => sameRef(item.ref, (b.candidates[index] as DetachedClosureCandidate).ref) &&
			compareBytes(item.bytes, (b.candidates[index] as DetachedClosureCandidate).bytes) === 0);
	return Object.freeze({
		initial,
		recheck(settlementAcl: InspectCreatorTransitionAdvanceInput["settlementAcl"]): InspectCreatorTransitionAdvanceResult {
			if (original === undefined) return failure("TRUST_CLOSURE_INVALID");
			const late = { ...original, settlementAcl };
			try {
				if (basis === undefined || !sameClosure(original.current, basis.current) || !sameClosure(original.proposed, basis.proposed) ||
					original.proofRefs.length !== basis.refs.length || !original.proofRefs.every((ref, index) => sameRef(ref, basis?.refs[index] as GenerationRef)))
					return inspectCreatorTransitionAdvance(late);
				return inspectCreatorTransitionAdvanceOwned(late, (candidate, trust, cut, qc, aclDigest) => {
					const fact = facts.find(({ args, trust: capturedTrust }) => args[1] === trust && args[4] === aclDigest &&
						trust.currentEpoch === capturedTrust.currentEpoch && trust.currentAnchorDigest === capturedTrust.currentAnchorDigest &&
						trust.objectId === capturedTrust.objectId && trust.genesisAnchorDigest === capturedTrust.genesisAnchorDigest && trust.profileId === capturedTrust.profileId &&
						[candidate, cut, qc].every((item, index) => {
							const captured = args[index === 0 ? 0 : index + 1] as DetachedClosureCandidate;
							return sameRef(item.ref, captured.ref) && compareBytes(item.bytes, captured.bytes) === 0;
						}));
					const material = fact === undefined ? undefined : resolveSealRecoveryTrust(trust);
					if (fact === undefined || material === undefined || material.currentEpoch !== fact.material.currentEpoch ||
						material.currentAnchorDigest !== fact.material.currentAnchorDigest || material.genesisAnchorDigest !== fact.material.genesisAnchorDigest ||
						material.objectId !== fact.material.objectId || material.quorum !== fact.material.quorum ||
						compareBytes(material.publicKey, fact.material.publicKey) !== 0 ||
						compareBytes(material.exactCanonicalCurrentAnchorPreimageBytes, fact.material.exactCanonicalCurrentAnchorPreimageBytes) !== 0 ||
						compareBytes(material.detachedCurrentAnchorSignature, fact.material.detachedCurrentAnchorSignature) !== 0 ||
						compareBytes(material.exactCanonicalProfileBytes, fact.material.exactCanonicalProfileBytes) !== 0 ||
						compareBytes(material.exactCanonicalSignerSetBytes, fact.material.exactCanonicalSignerSetBytes) !== 0 ||
						!openSealAuthority({ trust, signerPublicKey: material.publicKey }).ok)
						return openCreatorTransitionSettlement(candidate, trust, cut, qc, aclDigest);
					const identity = resolveCreatorAuthorSettlement(fact.capability);
					return identity === undefined ? openCreatorTransitionSettlement(candidate, trust, cut, qc, aclDigest)
						: Object.freeze({ candidate, identity, capability: fact.capability });
				});
			} catch { return inspectCreatorTransitionAdvance(late); }
		},
		release(): void { original = undefined; basis = undefined; facts = []; },
	});
}

declare const creatorForwardPromotionBrand: unique symbol;
/** Pure decision custody, distinct from close, live material, trust, and installation. */
export interface VerifiedCreatorForwardPromotion {
	readonly [creatorForwardPromotionBrand]: true;
}
export interface CreatorForwardPromotionIdentity {
	readonly objectId: string;
	readonly genesisAnchorDigest: string;
	readonly currentEpoch: number;
	readonly currentAnchorDigest: string;
	readonly successorEpoch: number;
	readonly successorAnchorDigest: string;
	readonly source: PromotionSource;
	readonly roles: ForwardPromotion["roles"];
}
const forwardPromotions = new WeakMap<VerifiedCreatorForwardPromotion, CreatorForwardPromotionIdentity>();
type PromotionSnapshot = Readonly<{ exactCanonicalManifestBytes: Uint8Array; exactCanonicalPayloadBytes: Uint8Array }>;
type HistoricalPromotionSnapshot = PromotionSnapshot &
	Readonly<{
		closedEpoch: number;
		originalAnchorEnvelope: null | Readonly<{
			objectId: string;
			exactCanonicalAnchorPreimageBytes: Uint8Array;
			detachedAnchorSignature: Uint8Array;
			exactCanonicalParametersCarrierBytes: Uint8Array;
		}>;
	}>;

function capturePromotionClosure(
	value: unknown,
	charge: (bytes: Uint8Array) => boolean
): CreatorTransitionClosure | undefined {
	const captured = capturePromotionRecord(value, ["candidates", "closure"]);
	const candidates = capturePromotionArray(captured?.candidates, AHE_BOUNDED_READ_LIMITS.maxClosureReferences);
	const refs = capturePromotionArray(captured?.closure, AHE_BOUNDED_READ_LIMITS.maxClosureReferences);
	if (candidates === undefined || refs === undefined || candidates.length !== refs.length) return undefined;
	const closure = refs.map((ref) => capturePromotionRef(ref));
	if (closure.some((ref) => ref === undefined) || new Set(closure.map((ref) => ref?.digest)).size !== closure.length)
		return undefined;
	const output: DetachedClosureCandidate[] = [];
	for (const value of candidates) {
		const candidate = capturePromotionRecord(value, ["bytes", "ref"]),
			ref = capturePromotionRef(candidate?.ref);
		const bytes = capturePromotionBytes(candidate?.bytes, AHE_BOUNDED_READ_LIMITS.maxBlobBytes, charge);
		if (ref === undefined || bytes === undefined) return undefined;
		const item = Object.freeze({ bytes, ref: ref as GenerationRef });
		if (!exactCandidate(item) || !exactCreatorTransitionOccurrence(closure as GenerationRef[], item)) return undefined;
		output.push(item);
	}
	if (new Set(output.map((item) => item.ref.digest)).size !== output.length) return undefined;
	return Object.freeze({ candidates: Object.freeze(output), closure: Object.freeze(closure as GenerationRef[]) });
}
function capturePromotionSnapshot(value: unknown): PromotionSnapshot | undefined {
	const snapshot = capturePromotionRecord(value, ["exactCanonicalManifestBytes", "exactCanonicalPayloadBytes"]);
	const manifest = capturePromotionBytes(snapshot?.exactCanonicalManifestBytes, 212_387);
	const payload = capturePromotionBytes(snapshot?.exactCanonicalPayloadBytes, 268_435_456);
	return manifest === undefined || payload === undefined
		? undefined
		: Object.freeze({ exactCanonicalManifestBytes: manifest, exactCanonicalPayloadBytes: payload });
}
function captureHistoricalPromotionSnapshot(
	value: unknown,
	charge: (bytes: Uint8Array) => boolean
): HistoricalPromotionSnapshot | undefined {
	const captured = capturePromotionRecord(value, [
		"closedEpoch",
		"exactCanonicalManifestBytes",
		"exactCanonicalPayloadBytes",
		"originalAnchorEnvelope",
	]);
	if (
		captured === undefined ||
		typeof captured.closedEpoch !== "number" ||
		!Number.isSafeInteger(captured.closedEpoch) ||
		captured.closedEpoch < 0
	)
		return undefined;
	const snapshot = capturePromotionSnapshot({
		exactCanonicalManifestBytes: captured.exactCanonicalManifestBytes,
		exactCanonicalPayloadBytes: captured.exactCanonicalPayloadBytes,
	});
	if (snapshot === undefined) return undefined;
	let originalAnchorEnvelope: HistoricalPromotionSnapshot["originalAnchorEnvelope"] = null;
	if (captured.originalAnchorEnvelope !== null) {
		const envelope = capturePromotionRecord(captured.originalAnchorEnvelope, [
			"objectId",
			"exactCanonicalAnchorPreimageBytes",
			"detachedAnchorSignature",
			"exactCanonicalParametersCarrierBytes",
		]);
		const anchor = capturePromotionBytes(envelope?.exactCanonicalAnchorPreimageBytes, 8192, charge);
		const signature = capturePromotionBytes(envelope?.detachedAnchorSignature, 64, charge);
		const parameters = capturePromotionBytes(envelope?.exactCanonicalParametersCarrierBytes, 65_536, charge);
		if (
			typeof envelope?.objectId !== "string" ||
			anchor === undefined ||
			signature?.byteLength !== 64 ||
			parameters === undefined
		)
			return undefined;
		originalAnchorEnvelope = Object.freeze({
			objectId: envelope.objectId,
			exactCanonicalAnchorPreimageBytes: anchor,
			detachedAnchorSignature: signature,
			exactCanonicalParametersCarrierBytes: parameters,
		});
	}
	return Object.freeze({ ...snapshot, closedEpoch: captured.closedEpoch, originalAnchorEnvelope });
}
function promotionSnapshotData(
	snapshot: PromotionSnapshot,
	cut: Readonly<Record<string, unknown>>,
	profileId: string,
	syntax?: CreatorTransitionSyntax
): ReturnType<typeof validateCreatorSnapshotData> {
	try {
		const decoded = decodeSnapshotManifest({
			exactCanonicalManifestBytes: snapshot.exactCanonicalManifestBytes,
			expectedManifestDigest: String(cut.snapshotManifestDigest),
			profile: { maxManifestBytes: 212_387, maxSnapshotBytes: 268_435_456, snapshotChunkBytes: 131_072 },
		});
		let offset = 0;
		for (const chunk of decoded.chunks) {
			const end = offset + chunk.byteLength;
			if (
				end > snapshot.exactCanonicalPayloadBytes.byteLength ||
				snapshotChunkDigest(chunk.index, snapshot.exactCanonicalPayloadBytes.subarray(offset, end)) !== chunk.digest
			)
				return undefined;
			offset = end;
		}
		return offset !== snapshot.exactCanonicalPayloadBytes.byteLength
			? undefined
			: (syntax === undefined ? validateCreatorSnapshotData : syntax.snapshot)(
					snapshot.exactCanonicalPayloadBytes,
					snapshot.exactCanonicalManifestBytes,
					cut,
					profileId
				);
	} catch {
		return undefined;
	}
}
function promotionControls(
	evidence: NonNullable<ReturnType<typeof openCreatorTransitionClosedCutEvidence>>
): readonly PromotionControlRef[] {
	return Object.freeze(
		[evidence.settlement, evidence.retirement, evidence.aggregate]
			.filter((item) => item !== undefined)
			.map((item) =>
				Object.freeze([String(record(item!.candidate)?.kind), Object.freeze({ ...item!.candidate.ref })] as const)
			)
	);
}
function samePromotionValue(left: unknown, right: unknown): boolean {
	return compareBytes(encodeCanonical(left), encodeCanonical(right)) === 0;
}

/**
 * Authenticates exact retained history under independent current/pinned custody; performs no I/O or mutation.
 * @param input
 */
export function openCreatorForwardPromotion(
	input: unknown
): Readonly<{ ok: false; reason: string } | { ok: true; promotion: VerifiedCreatorForwardPromotion }> {
	try {
		const captured = capturePromotionRecord(input, [
			"currentTrust",
			"exactCanonicalPinnedGenesisTrustStateRecordBytes",
			"expectedRoomHeadState",
			"current",
			"predecessor",
			"proposed",
			"currentAclBytes",
			"authorizedSuccessorAclBytes",
			"currentCloseSnapshot",
			"historicalSnapshots",
		]);
		if (captured === undefined) return failure("PROMOTION_INPUT_INVALID");
		const ledger = createCreatorClosedRollbackProofAccounting([]),
			charge = (bytes: Uint8Array): boolean => ledger.charge(bytes);
		const current = capturePromotionClosure(captured.current, charge),
			predecessor = capturePromotionClosure(captured.predecessor, charge),
			proposed = capturePromotionClosure(captured.proposed, charge);
		const pinBytes = capturePromotionBytes(captured.exactCanonicalPinnedGenesisTrustStateRecordBytes, 8192, charge);
		const currentAclBytes = capturePromotionBytes(captured.currentAclBytes, 65_536, charge),
			successorAclBytes = capturePromotionBytes(captured.authorizedSuccessorAclBytes, 65_536, charge);
		const closeSnapshot = capturePromotionSnapshot(captured.currentCloseSnapshot);
		const historicalValues = capturePromotionArray(captured.historicalSnapshots, 2);
		const histories = historicalValues?.map((value) => captureHistoricalPromotionSnapshot(value, charge));
		const head = capturePromotionRecord(captured.expectedRoomHeadState, ["stable", "pending"]),
			stable = capturePromotionRecord(head?.stable, ["objectId", "epoch", "currentAnchorDigest"]);
		if (
			current === undefined ||
			predecessor === undefined ||
			proposed === undefined ||
			pinBytes === undefined ||
			currentAclBytes === undefined ||
			successorAclBytes === undefined ||
			closeSnapshot === undefined ||
			histories === undefined ||
			histories.some((h) => h === undefined) ||
			head?.pending !== null ||
			stable === undefined
		)
			return failure("PROMOTION_INPUT_INVALID");
		const currentTrust = captured.currentTrust as CurrentAnchorTrust;
		const pinRecord = canonicalCreatorDataRecord(pinBytes);
		if (
			pinRecord === undefined ||
			pinRecord.currentEpoch !== 0 ||
			typeof pinRecord.objectId !== "string" ||
			typeof pinRecord.genesisAnchorDigest !== "string"
		)
			return failure("PROMOTION_PIN_INVALID");
		const pin = openCurrentAnchorTrust({
			exactCanonicalTrustStateRecordBytes: pinBytes,
			expectedObjectId: pinRecord.objectId,
			pinnedGenesisAnchorDigest: pinRecord.genesisAnchorDigest,
		});
		if (!pin.ok) return failure("PROMOTION_PIN_INVALID");
		// Genuine current capability is required, not a copied observer fact.
		const signerSet = canonicalCreatorDataRecord(pinBytes)?.exactCanonicalSignerSetBytes;
		const signers = signerSet instanceof Uint8Array ? decodeCanonical(signerSet) : undefined;
		const publicKey =
			Array.isArray(signers) && typeof signers[0]?.publicKey === "string"
				? Uint8Array.from(signers[0].publicKey.match(/../gu) ?? [], (part: string) => Number.parseInt(part, 16))
				: undefined;
		if (publicKey === undefined || !openSealAuthority({ trust: currentTrust, signerPublicKey: publicKey }).ok)
			return failure("PROMOTION_CURRENT_UNTRUSTED");
		if (
			currentTrust.objectId !== pin.trust.objectId ||
			currentTrust.genesisAnchorDigest !== pin.trust.genesisAnchorDigest ||
			currentTrust.profileId !== pin.trust.profileId ||
			stable.objectId !== currentTrust.objectId ||
			stable.epoch !== currentTrust.currentEpoch ||
			stable.currentAnchorDigest !== currentTrust.currentAnchorDigest ||
			currentTrust.currentEpoch < 1
		)
			return failure("PROMOTION_FLOOR_INVALID");
		const n = currentTrust.currentEpoch;
		const currentCarrier = uniqueCreatorTransitionCandidate(current.candidates, "drp-anchor-trust-state", n),
			predecessorCarrier = uniqueCreatorTransitionCandidate(predecessor.candidates, "drp-anchor-trust-state", n - 1);
		const oldCut = uniqueCreatorTransitionCandidate(current.candidates, "drp-hard-epoch-cut", n - 1),
			oldQc = uniqueCreatorTransitionCandidate(current.candidates, "drp-seal-qc", n - 1, "commit");
		if (currentCarrier === undefined || predecessorCarrier === undefined || oldCut === undefined || oldQc === undefined)
			return failure("PROMOTION_LINEAGE_INVALID");
		let predecessorTrust = pin.trust;
		if (n === 1) {
			if (compareBytes(predecessorCarrier.bytes, pinBytes) !== 0) return failure("PROMOTION_LINEAGE_INVALID");
			const opened = openCreatorSuccessorTrust({
				currentTrust: pin.trust,
				exactCanonicalCutValueBytes: oldCut.bytes,
				exactCanonicalCommitQcBytes: oldQc.bytes,
				exactCanonicalTrustStateRecordBytes: currentCarrier.bytes,
			});
			if (!opened.ok || opened.trust.currentAnchorDigest !== currentTrust.currentAnchorDigest)
				return failure("PROMOTION_LINEAGE_INVALID");
		} else {
			const opened = (
				record(oldCut)?.forwardPromotion === undefined
					? openCreatorCheckpointTrust
					: openCreatorForwardPromotionCheckpointTrust
			)({
				detachedGenesisSignature: pinRecord.detachedCurrentAnchorSignature,
				exactCanonicalGenesisAnchorPreimageBytes: pinRecord.exactCanonicalCurrentAnchorPreimageBytes,
				exactCanonicalPredecessorTrustStateRecordBytes: predecessorCarrier.bytes,
				exactCanonicalCurrentTrustStateRecordBytes: currentCarrier.bytes,
				exactCanonicalCutValueBytes: oldCut.bytes,
				exactCanonicalCommitQcBytes: oldQc.bytes,
				expectedObjectId: currentTrust.objectId,
				pinnedGenesisAnchorDigest: currentTrust.genesisAnchorDigest,
				expectedCurrentHead: {
					objectId: stable.objectId,
					epoch: stable.epoch,
					currentAnchorDigest: stable.currentAnchorDigest,
				},
			});
			if (!opened.ok || opened.currentTrust.profileId !== currentTrust.profileId)
				return failure("PROMOTION_LINEAGE_INVALID");
			predecessorTrust = opened.predecessorTrust;
		}
		const currentAnchor = canonicalCreatorDataRecord(
			record(currentCarrier)!.exactCanonicalCurrentAnchorPreimageBytes as Uint8Array
		);
		const predecessorAnchor = canonicalCreatorDataRecord(
			record(predecessorCarrier)!.exactCanonicalCurrentAnchorPreimageBytes as Uint8Array
		);
		if (currentAnchor === undefined || predecessorAnchor === undefined) return failure("PROMOTION_LINEAGE_INVALID");
		const openAcl = (bytes: Uint8Array, digest: string, epoch: number): boolean =>
			openCanonicalLatchedAclSnapshot({
				exactCanonicalLatchedAclBytes: bytes,
				expectedAclDigest: digest,
				expectedEpoch: epoch,
				expectedObjectId: currentTrust.objectId,
				expectedProfileId: currentTrust.profileId,
			}).ok;
		const currentAcl = uniqueCreatorTransitionCandidate(current.candidates, "drp-v3-latched-acl", n);
		if (
			current.candidates.filter((candidate) => {
				const value = canonicalCreatorDataRecord(candidate.bytes);
				return value?.kind === "drp-v3-latched-acl" && value.epoch === n;
			}).length > 1 ||
			(currentAcl !== undefined && compareBytes(currentAcl.bytes, currentAclBytes) !== 0) ||
			!openAcl(currentAclBytes, String(currentAnchor.aclDigest), n)
		)
			return failure("PROMOTION_ACL_INVALID");
		// The signed latest retained snapshot below authenticates this operational ACL byte-exactly.
		// It need not duplicate an eighth native live-closure ref beside the runtime projection.
		const available: PromotionSource[] = [];
		const availableData: NonNullable<ReturnType<typeof validateCreatorSnapshotData>>[] = [];
		const availableEvidence: NonNullable<ReturnType<typeof openCreatorTransitionClosedCutEvidence>>[] = [];
		for (const epoch of n === 1 ? [0] : [n - 1, n - 2]) {
			const latest = epoch === n - 1,
				material = latest ? current : predecessor,
				floorTrust = latest ? currentTrust : predecessorTrust;
			const evidence = openCreatorTransitionClosedCutEvidence({
				closure: material,
				floorTrust,
				...(latest ? { currentTrust: predecessorTrust } : {}),
			});
			if (evidence === undefined) return failure("PROMOTION_SOURCE_INVALID");
			const binding = (
				record(evidence.cut)?.forwardPromotion === undefined
					? inspectCreatorClosedCutSuccessorBinding
					: inspectCreatorForwardPromotionClosedCutSuccessorBinding
			)({
				successorTrust: floorTrust,
				exactCanonicalCutValueBytes: evidence.cut.bytes,
			});
			const matches = histories.filter((h) => h!.closedEpoch === epoch);
			const historical = matches[0];
			if (!binding.ok || matches.length !== 1 || historical === undefined) return failure("PROMOTION_SOURCE_INVALID");
			let aclDigest = latest ? String(predecessorAnchor.aclDigest) : evidence.currentAclDigest;
			if (aclDigest === undefined && epoch === 0) {
				const genesisAnchor = canonicalCreatorDataRecord(
					pinRecord.exactCanonicalCurrentAnchorPreimageBytes as Uint8Array
				);
				if (binding.cut.previousAnchor !== pin.trust.currentAnchorDigest) return failure("PROMOTION_SOURCE_INVALID");
				aclDigest = String(genesisAnchor?.aclDigest);
			}
			if (evidence.representation === "retirement-only" && epoch > 0) {
				if (historical.originalAnchorEnvelope === null) return failure("PROMOTION_ANCHOR_REQUIRED");
				const inspected = inspectCreatorHistoricalAnchorEnvelope({
					successorTrust: floorTrust,
					envelope: historical.originalAnchorEnvelope,
				});
				if (
					!inspected.ok ||
					inspected.anchorDigest !== binding.cut.previousAnchor ||
					(aclDigest !== undefined && aclDigest !== inspected.aclDigest)
				)
					return failure("PROMOTION_ANCHOR_INVALID");
				aclDigest = inspected.aclDigest;
			} else if (historical.originalAnchorEnvelope !== null) return failure("PROMOTION_ANCHOR_UNEXPECTED");
			const closedAcl = uniqueCreatorTransitionCandidate(material.candidates, "drp-v3-latched-acl", epoch);
			const data = promotionSnapshotData(historical, binding.cut, currentTrust.profileId);
			if (
				closedAcl === undefined ||
				aclDigest === undefined ||
				!openAcl(closedAcl.bytes, aclDigest, epoch) ||
				data === undefined
			)
				return failure("PROMOTION_SNAPSHOT_INVALID");
			available.push(
				Object.freeze({
					closedEpoch: epoch,
					closedAnchorDigest: String(binding.cut.previousAnchor),
					successorEpoch: floorTrust.currentEpoch,
					successorAnchorDigest: floorTrust.currentAnchorDigest,
					cutValueDigest: creatorDataDigest("ts-drp/hard-epoch-cut/v3", evidence.cut.bytes),
					cutRef: Object.freeze({ ...evidence.cut.ref }),
					commitQcRef: Object.freeze({ ...evidence.qc.ref }),
					manifestRef: Object.freeze({
						digest: String(binding.cut.snapshotManifestDigest),
						byteLength: historical.exactCanonicalManifestBytes.byteLength,
					}),
					payloadDigest: String(data.manifest.payloadDigest),
					stateDigest: String(binding.cut.stateDigest),
					closedAclDigest: aclDigest,
					snapshotAclDigest: String(binding.cut.aclDigest),
					checkpointRepresentation: evidence.representation,
					checkpointRefs: promotionControls(evidence),
				})
			);
			availableData.push(data);
			availableEvidence.push(evidence);
		}
		if (
			histories.length !== available.length ||
			compareBytes(availableData[0]!.successorAclBytes, currentAclBytes) !== 0 ||
			(availableData.length === 2 &&
				compareBytes(
					availableData[1]!.successorAclBytes,
					uniqueCreatorTransitionCandidate(current.candidates, "drp-v3-latched-acl", n - 1)!.bytes
				) !== 0)
		)
			return failure("PROMOTION_SNAPSHOT_CHAIN_INVALID");
		// Authenticate the existing current control continuity, with the final ACL-bound settlement law.
		{
			const continuity: InspectCreatorTransitionAdvanceInput = {
				current: predecessor,
				currentTrust: predecessorTrust,
				proposed: current,
				successorTrust: currentTrust,
				proofRefs: [oldCut.ref, oldQc.ref],
				mode: "verify",
				settlementAcl: {
					current: uniqueCreatorTransitionCandidate(current.candidates, "drp-v3-latched-acl", n - 1)!.bytes,
					successor: currentAclBytes,
				},
			};
			if (settlementProfileFor(currentTrust.profileId) === "v1") {
				if (authenticatedSettlementPair(continuity) === undefined)
					return failure("PROMOTION_CURRENT_CONTINUITY_INVALID");
			} else {
				const retirement = authenticatedRetirementPair(continuity);
				if (
					retirement === undefined ||
					(availableEvidence[0]!.aggregate !== undefined &&
						authenticatedAggregatePair(continuity, retirement) === undefined)
				)
					return failure("PROMOTION_CURRENT_CONTINUITY_INVALID");
				// Retirement-only retained evidence is not a new forward-output or pending-policy exception.
				if (availableEvidence[0]!.aggregate === undefined && aggregateCandidates(predecessor).length !== 0)
					return failure("PROMOTION_CURRENT_CONTINUITY_INVALID");
			}
		}
		const newCut = uniqueCreatorTransitionCandidate(proposed.candidates, "drp-hard-epoch-cut", n),
			newQc = uniqueCreatorTransitionCandidate(proposed.candidates, "drp-seal-qc", n, "commit"),
			nextCarrier = uniqueCreatorTransitionCandidate(proposed.candidates, "drp-anchor-trust-state", n + 1);
		if (newCut === undefined || newQc === undefined || nextCarrier === undefined)
			return failure("PROMOTION_PROPOSED_INVALID");
		const cut = canonicalCreatorDataRecord(newCut.bytes),
			forward = cut === undefined ? undefined : captureForwardPromotion(cut.forwardPromotion);
		if (
			cut === undefined ||
			forward === undefined ||
			forward.genesisAnchorDigest !== currentTrust.genesisAnchorDigest ||
			forward.authorizedSuccessorAclDigest !== cut.aclDigest
		)
			return failure("PROMOTION_VALUE_INVALID");
		const selected = available.find((s) => s.cutValueDigest === forward.source.cutValueDigest);
		if (
			selected === undefined ||
			!samePromotionValue(selected, forward.source) ||
			!samePromotionValue(
				available.filter((s) => s !== selected),
				forward.roles.retainedSources
			) ||
			!samePromotionValue(promotionControls(availableEvidence[0]!), forward.roles.currentControlRefs)
		)
			return failure("PROMOTION_ROLES_INVALID");
		const data = promotionSnapshotData(closeSnapshot, cut, currentTrust.profileId);
		if (
			data === undefined ||
			compareBytes(data.successorAclBytes, successorAclBytes) !== 0 ||
			!openAcl(successorAclBytes, forward.authorizedSuccessorAclDigest, n + 1)
		)
			return failure("PROMOTION_CLOSE_SNAPSHOT_INVALID");
		const successor = openCreatorForwardPromotionSuccessorTrust({
			currentTrust,
			exactCanonicalCutValueBytes: newCut.bytes,
			exactCanonicalCommitQcBytes: newQc.bytes,
			exactCanonicalTrustStateRecordBytes: nextCarrier.bytes,
		});
		if (!successor.ok) return failure(successor.reason);
		if (
			!inspectCreatorTransitionAdvance({
				current,
				currentTrust,
				proposed,
				successorTrust: successor.trust,
				proofRefs: [newCut.ref, newQc.ref],
				mode: "verify",
				settlementAcl: { current: currentAclBytes, successor: successorAclBytes },
			}).ok
		)
			return failure("PROMOTION_CONTINUITY_INVALID");
		const output = openCreatorTransitionClosedCutEvidence({
			closure: proposed,
			currentTrust,
			floorTrust: successor.trust,
		});
		if (
			output === undefined ||
			!samePromotionValue(
				output.settlement?.identity.frontiers ?? output.aggregate?.identity.frontiers ?? null,
				forward.roles.frontiers
			)
		)
			return failure("PROMOTION_FRONTIERS_INVALID");
		if (output.aggregate !== undefined) {
			const authorizedAcl = openCanonicalLatchedAclSnapshot({
				exactCanonicalLatchedAclBytes: successorAclBytes,
				expectedAclDigest: forward.authorizedSuccessorAclDigest,
				expectedEpoch: n + 1,
				expectedObjectId: currentTrust.objectId,
				expectedProfileId: currentTrust.profileId,
			});
			if (!authorizedAcl.ok) return failure("PROMOTION_FRONTIERS_INVALID");
			const writers: string[] = [];
			for (const member of authorizedAcl.snapshot.members) {
				const authorized = authorizeLatchedApplicationWrite({
					author: member.author,
					snapshot: authorizedAcl.snapshot,
				});
				if (!authorized.ok) return failure("PROMOTION_FRONTIERS_INVALID");
				if (authorized.authorized) writers.push(member.author);
			}
			if (
				!samePromotionValue(
					writers.sort(),
					output.aggregate.identity.frontiers.map(([author]) => author)
				)
			)
				return failure("PROMOTION_FRONTIERS_INVALID");
		}
		const promotion = Object.freeze({}) as VerifiedCreatorForwardPromotion;
		forwardPromotions.set(
			promotion,
			Object.freeze({
				objectId: currentTrust.objectId,
				genesisAnchorDigest: currentTrust.genesisAnchorDigest,
				currentEpoch: n,
				currentAnchorDigest: currentTrust.currentAnchorDigest,
				successorEpoch: successor.trust.currentEpoch,
				successorAnchorDigest: successor.trust.currentAnchorDigest,
				source: forward.source,
				roles: forward.roles,
			})
		);
		return Object.freeze({ ok: true, promotion });
	} catch {
		return failure("PROMOTION_INPUT_INVALID");
	}
}

/**
 * Resolves immutable detached identities only from genuine private decision custody.
 * @param promotion
 */
export function resolveCreatorForwardPromotion(
	promotion: VerifiedCreatorForwardPromotion
): CreatorForwardPromotionIdentity | undefined {
	return forwardPromotions.get(promotion);
}

declare const recoveryRoleTransferBrand: unique symbol;
/** Pure semantic decision only; native inventory and lifetime custody remain mandatory. */
export interface VerifiedCreatorSnapshotRecoveryRoleTransfer {
	readonly [recoveryRoleTransferBrand]: true;
}
const recoveryRoleTransfers = new WeakMap<VerifiedCreatorSnapshotRecoveryRoleTransfer, CreatorSnapshotRecoveryRoles>();
function recoveryScopeForCut(cut: Readonly<Record<string, unknown>>): CreatorSnapshotRecoveryScope {
	return Object.freeze({
		objectId: String(cut.objectId),
		epoch: Number(cut.epoch),
		anchor: String(cut.previousAnchor),
		manifestDigest: String(cut.snapshotManifestDigest),
	});
}
function recoveryScopeKey(scope: CreatorSnapshotRecoveryScope): string {
	return JSON.stringify([scope.objectId, scope.epoch, scope.anchor, scope.manifestDigest]);
}
function recoveryScopeForSource(source: PromotionSource, objectId: string): CreatorSnapshotRecoveryScope {
	return Object.freeze({
		objectId,
		epoch: source.closedEpoch,
		anchor: source.closedAnchorDigest,
		manifestDigest: source.manifestRef.digest,
	});
}

/**
 * Refuses foreign trust before reading any caller-provided capability properties.
 * @param value - Proposed nominal current trust.
 * @param pinBytes - Exact canonical pinned genesis carrier.
 * @returns Whether the original seal owner authenticates the nominal trust.
 */
function genuineRecoveryTrust(value: unknown, pinBytes: Uint8Array): boolean {
	const pin = canonicalCreatorDataRecord(pinBytes),
		signerBytes = pin?.exactCanonicalSignerSetBytes;
	if (!(signerBytes instanceof Uint8Array)) return false;
	const signers = decodeCanonical(signerBytes);
	const key =
		Array.isArray(signers) && typeof signers[0]?.publicKey === "string" && /^[0-9a-f]{64}$/u.test(signers[0].publicKey)
			? Uint8Array.from(signers[0].publicKey.match(/../gu) ?? [], (part: string) => Number.parseInt(part, 16))
			: undefined;
	return key !== undefined && openSealAuthority({ trust: value, signerPublicKey: key }).ok;
}

/**
 * Verifies an exact signed successor recovery-role transfer, not arbitrary classification.
 * Native owners must independently bind the complete inventory, all debt and currency;
 * this pure capability cannot authorize any storage command on its own.
 * @param input - Exact authenticated closures, whole snapshot data and nominal promotion decisions.
 * @returns A foreign-refusing semantic decision or a whole typed refusal.
 */
export function openCreatorSnapshotRecoveryRoleTransfer(
	input: unknown
): Readonly<{ ok: false; reason: string } | { ok: true; transfer: VerifiedCreatorSnapshotRecoveryRoleTransfer }> {
	try {
		const keys = [
			"currentTrust",
			"successorTrust",
			"current",
			"predecessor",
			"proposed",
			"currentAclBytes",
			"currentCloseSnapshot",
			"historicalSnapshots",
			"currentInstalledPromotion",
			"proposedPromotion",
			"exactCanonicalPinnedGenesisTrustStateRecordBytes",
		];
		const captured =
			capturePromotionRecord(input, keys) ?? capturePromotionRecord(input, [...keys, "currentRoleTransfer"]);
		if (captured === undefined) return failure("RECOVERY_ROLE_INPUT_INVALID");
		const ledger = createCreatorClosedRollbackProofAccounting([]),
			charge = (bytes: Uint8Array): boolean => ledger.charge(bytes);
		const current = capturePromotionClosure(captured.current, charge),
			predecessor = capturePromotionClosure(captured.predecessor, charge),
			proposed = capturePromotionClosure(captured.proposed, charge),
			pinBytes = capturePromotionBytes(captured.exactCanonicalPinnedGenesisTrustStateRecordBytes, 8192, charge),
			acl = capturePromotionBytes(captured.currentAclBytes, 65_536, charge),
			close = capturePromotionSnapshot(captured.currentCloseSnapshot),
			values = capturePromotionArray(captured.historicalSnapshots, 2),
			histories = values?.map((value) => captureHistoricalPromotionSnapshot(value, charge));
		if (
			current === undefined ||
			predecessor === undefined ||
			proposed === undefined ||
			pinBytes === undefined ||
			acl === undefined ||
			close === undefined ||
			histories === undefined ||
			histories.some((value) => value === undefined)
		)
			return failure("RECOVERY_ROLE_INPUT_INVALID");
		if (
			!genuineRecoveryTrust(captured.currentTrust, pinBytes) ||
			!genuineRecoveryTrust(captured.successorTrust, pinBytes)
		)
			return failure("RECOVERY_ROLE_TRUST_INVALID");
		const currentTrust = captured.currentTrust as CurrentAnchorTrust,
			successorTrust = captured.successorTrust as CurrentAnchorTrust,
			n = currentTrust.currentEpoch;
		if (
			!Number.isSafeInteger(n) ||
			n < 1 ||
			successorTrust.currentEpoch !== n + 1 ||
			currentTrust.objectId !== successorTrust.objectId ||
			currentTrust.genesisAnchorDigest !== successorTrust.genesisAnchorDigest
		)
			return failure("RECOVERY_ROLE_TRUST_INVALID");
		if (
			histories.length !== (n === 1 ? 1 : 2) ||
			new Set(histories.map((snapshot) => snapshot?.closedEpoch)).size !== histories.length
		)
			return failure("RECOVERY_ROLE_INPUT_INVALID");
		const currentCarrier = uniqueCreatorTransitionCandidate(current.candidates, "drp-anchor-trust-state", n),
			currentCut = uniqueCreatorTransitionCandidate(current.candidates, "drp-hard-epoch-cut", n - 1),
			cut = uniqueCreatorTransitionCandidate(proposed.candidates, "drp-hard-epoch-cut", n),
			qc = uniqueCreatorTransitionCandidate(proposed.candidates, "drp-seal-qc", n, "commit");
		if (currentCarrier === undefined || currentCut === undefined || cut === undefined || qc === undefined)
			return failure("RECOVERY_ROLE_LINEAGE_INVALID");
		const oldCut = record(currentCut),
			nextCut = record(cut),
			roles = captureCreatorSnapshotRecoveryRoles(nextCut?.recoveryRoles);
		if (
			oldCut === undefined ||
			nextCut === undefined ||
			roles === undefined ||
			roles.previousClose === null ||
			roles.genesisAnchorDigest !== currentTrust.genesisAnchorDigest ||
			!samePromotionValue(roles.currentClose, recoveryScopeForCut(nextCut)) ||
			!samePromotionValue(roles.previousClose, recoveryScopeForCut(oldCut))
		)
			return failure("RECOVERY_ROLE_TRANSFER_INVALID");
		const pinRecord = canonicalCreatorDataRecord(pinBytes),
			pin = openCurrentAnchorTrust({
				exactCanonicalTrustStateRecordBytes: pinBytes,
				expectedObjectId: currentTrust.objectId,
				pinnedGenesisAnchorDigest: currentTrust.genesisAnchorDigest,
			}),
			oldQc = uniqueCreatorTransitionCandidate(current.candidates, "drp-seal-qc", n - 1, "commit"),
			previousCarrier = uniqueCreatorTransitionCandidate(predecessor.candidates, "drp-anchor-trust-state", n - 1);
		if (
			!pin.ok ||
			pinRecord === undefined ||
			pin.trust.currentEpoch !== 0 ||
			oldQc === undefined ||
			previousCarrier === undefined
		)
			return failure("RECOVERY_ROLE_TRUST_INVALID");
		let predecessorTrust = pin.trust;
		if (n === 1) {
			if (compareBytes(previousCarrier.bytes, pinBytes) !== 0) return failure("RECOVERY_ROLE_LINEAGE_INVALID");
			const opened = openCreatorSuccessorTrust({
				currentTrust: pin.trust,
				exactCanonicalCutValueBytes: currentCut.bytes,
				exactCanonicalCommitQcBytes: oldQc.bytes,
				exactCanonicalTrustStateRecordBytes: currentCarrier.bytes,
			});
			if (!opened.ok || opened.trust.currentAnchorDigest !== currentTrust.currentAnchorDigest)
				return failure("RECOVERY_ROLE_LINEAGE_INVALID");
		} else {
			const opened = (
				oldCut.forwardPromotion === undefined ? openCreatorCheckpointTrust : openCreatorForwardPromotionCheckpointTrust
			)({
				detachedGenesisSignature: pinRecord.detachedCurrentAnchorSignature,
				exactCanonicalGenesisAnchorPreimageBytes: pinRecord.exactCanonicalCurrentAnchorPreimageBytes,
				exactCanonicalPredecessorTrustStateRecordBytes: previousCarrier.bytes,
				exactCanonicalCurrentTrustStateRecordBytes: currentCarrier.bytes,
				exactCanonicalCutValueBytes: currentCut.bytes,
				exactCanonicalCommitQcBytes: oldQc.bytes,
				expectedObjectId: currentTrust.objectId,
				pinnedGenesisAnchorDigest: currentTrust.genesisAnchorDigest,
				expectedCurrentHead: {
					objectId: currentTrust.objectId,
					epoch: n,
					currentAnchorDigest: currentTrust.currentAnchorDigest,
				},
			});
			if (!opened.ok || opened.currentTrust.profileId !== currentTrust.profileId)
				return failure("RECOVERY_ROLE_LINEAGE_INVALID");
			predecessorTrust = opened.predecessorTrust;
		}
		const checkPromotion = (
			value: unknown,
			signed: unknown,
			epoch: number,
			anchor: string
		): CreatorForwardPromotionIdentity | undefined | null => {
			if (signed === undefined) return value === null ? null : undefined;
			const p = captureForwardPromotion(signed),
				identity = resolveCreatorForwardPromotion(value as VerifiedCreatorForwardPromotion);
			return p !== undefined &&
				identity !== undefined &&
				identity.objectId === currentTrust.objectId &&
				identity.genesisAnchorDigest === currentTrust.genesisAnchorDigest &&
				identity.successorEpoch === epoch &&
				identity.successorAnchorDigest === anchor &&
				samePromotionValue(identity.source, p.source) &&
				samePromotionValue(identity.roles, p.roles)
				? identity
				: undefined;
		};
		const installed = checkPromotion(
				captured.currentInstalledPromotion,
				oldCut.forwardPromotion,
				n,
				currentTrust.currentAnchorDigest
			),
			promoted = checkPromotion(
				captured.proposedPromotion,
				nextCut.forwardPromotion,
				n + 1,
				successorTrust.currentAnchorDigest
			);
		if (installed === undefined || promoted === undefined) return failure("RECOVERY_ROLE_PROMOTION_UNTRUSTED");
		const expectedSources = [
			...new Map(
				[promoted?.source, installed?.source]
					.filter((value): value is PromotionSource => value !== undefined)
					.map((source) => [source.cutValueDigest, source])
			).values(),
		];
		if (!samePromotionValue(roles.operationalSources, expectedSources)) return failure("RECOVERY_ROLE_SOURCE_INVALID");
		const newData = promotionSnapshotData(close, nextCut, currentTrust.profileId);
		if (newData === undefined) return failure("RECOVERY_ROLE_SNAPSHOT_INVALID");
		for (const bytes of [close.exactCanonicalManifestBytes, close.exactCanonicalPayloadBytes])
			if (!charge(bytes)) return failure("RECOVERY_ROLE_INPUT_INVALID");
		if (
			!inspectCreatorTransitionAdvance({
				current,
				proposed,
				currentTrust,
				successorTrust,
				mode: "verify",
				proofRefs: [cut.ref, qc.ref],
				settlementAcl: { current: acl, successor: newData.successorAclBytes },
			}).ok
		)
			return failure("RECOVERY_ROLE_LINEAGE_INVALID");
		const known = new Map<string, CreatorSnapshotRecoveryScope>();
		for (const epoch of n === 1 ? [0] : [n - 1, n - 2]) {
			const material = epoch === n - 1 ? current : predecessor,
				old = uniqueCreatorTransitionCandidate(material.candidates, "drp-hard-epoch-cut", epoch),
				snapshot = histories.find((value) => value?.closedEpoch === epoch);
			const oldRecord = old === undefined ? undefined : record(old);
			if (
				old === undefined ||
				oldRecord === undefined ||
				snapshot === undefined ||
				promotionSnapshotData(snapshot, oldRecord, currentTrust.profileId) === undefined ||
				!charge(snapshot.exactCanonicalManifestBytes) ||
				!charge(snapshot.exactCanonicalPayloadBytes)
			)
				return failure("RECOVERY_ROLE_SNAPSHOT_INVALID");
			const trust = epoch === n - 1 ? currentTrust : predecessorTrust,
				evidence = openCreatorTransitionClosedCutEvidence({
					closure: material,
					floorTrust: trust,
					...(epoch === n - 1 ? { currentTrust: predecessorTrust } : {}),
				});
			if (evidence === undefined) return failure("RECOVERY_ROLE_LINEAGE_INVALID");
			const binding = (
				oldRecord.forwardPromotion === undefined
					? inspectCreatorClosedCutSuccessorBinding
					: inspectCreatorForwardPromotionClosedCutSuccessorBinding
			)({ successorTrust: trust, exactCanonicalCutValueBytes: old.bytes });
			if (!binding.ok) return failure("RECOVERY_ROLE_LINEAGE_INVALID");
			if (evidence.representation === "retirement-only" && epoch > 0) {
				if (snapshot.originalAnchorEnvelope === null) return failure("RECOVERY_ROLE_ANCHOR_REQUIRED");
				const original = inspectCreatorHistoricalAnchorEnvelope({
					successorTrust: trust,
					envelope: snapshot.originalAnchorEnvelope,
				});
				if (!original.ok || original.anchorDigest !== binding.cut.previousAnchor)
					return failure("RECOVERY_ROLE_ANCHOR_INVALID");
			} else if (snapshot.originalAnchorEnvelope !== null) return failure("RECOVERY_ROLE_ANCHOR_UNEXPECTED");
			const scope = recoveryScopeForCut(oldRecord);
			known.set(recoveryScopeKey(scope), scope);
		}
		const priorRoles = Object.hasOwn(oldCut, "recoveryRoles")
			? captureCreatorSnapshotRecoveryRoles(oldCut.recoveryRoles)
			: undefined;
		if (
			Object.hasOwn(oldCut, "recoveryRoles") &&
			(priorRoles === undefined ||
				priorRoles.genesisAnchorDigest !== currentTrust.genesisAnchorDigest ||
				!samePromotionValue(priorRoles.currentClose, recoveryScopeForCut(oldCut)))
		)
			return failure("RECOVERY_ROLE_TRANSFER_INVALID");
		const priorTransfer = recoveryRoleTransfers.get(
			captured.currentRoleTransfer as VerifiedCreatorSnapshotRecoveryRoleTransfer
		);
		if (
			priorRoles === undefined
				? Object.hasOwn(captured, "currentRoleTransfer")
				: priorTransfer === undefined || !samePromotionValue(priorRoles, priorTransfer)
		)
			return failure("RECOVERY_ROLE_CURRENT_TRANSFER_UNTRUSTED");
		if (priorRoles !== undefined)
			for (const scope of [
				priorRoles.currentClose,
				...(priorRoles.previousClose === null ? [] : [priorRoles.previousClose]),
				...priorRoles.operationalSources.map((source) => recoveryScopeForSource(source, currentTrust.objectId)),
				...priorRoles.classifiedScopes,
			])
				known.set(recoveryScopeKey(scope), scope);
		for (const identity of [installed, promoted])
			if (identity !== null)
				for (const source of [identity.source, ...identity.roles.retainedSources]) {
					const scope = recoveryScopeForSource(source, currentTrust.objectId);
					known.set(recoveryScopeKey(scope), scope);
				}
		const protectedKeys = new Set(
			[
				roles.currentClose,
				roles.previousClose,
				...roles.operationalSources.map((source) => recoveryScopeForSource(source, currentTrust.objectId)),
			].map(recoveryScopeKey)
		);
		for (const scope of roles.classifiedScopes)
			if (protectedKeys.has(recoveryScopeKey(scope)) || !known.has(recoveryScopeKey(scope)))
				return failure("RECOVERY_ROLE_CLASSIFICATION_INVALID");
		const transfer = Object.freeze({}) as VerifiedCreatorSnapshotRecoveryRoleTransfer;
		recoveryRoleTransfers.set(transfer, roles);
		return Object.freeze({ ok: true, transfer });
	} catch {
		return failure("RECOVERY_ROLE_INPUT_INVALID");
	}
}

/**
 * Resolves detached roles from genuine semantic custody only; copies remain foreign.
 * @param value - Genuine private semantic transfer capability.
 * @returns Detached exact authenticated roles, or undefined for foreign custody.
 */
export function resolveCreatorSnapshotRecoveryRoleTransfer(
	value: VerifiedCreatorSnapshotRecoveryRoleTransfer
): CreatorSnapshotRecoveryRoles | undefined {
	return recoveryRoleTransfers.get(value);
}

/**
 * Operation-private retrospective source proof through the existing checkpoint owner.
 * The derived predecessor carrier is built only from pinned immutable key/profile
 * carriers and an original signed envelope on the actual current predecessor chain;
 * it is not asserted to occur in any supplied AHE closure and grants no room floor.
 * @param input - Genuine current trust, exact original source closure, native chain and pin.
 * @returns Retrospective source and predecessor trusts and charged derived bytes, or a whole refusal.
 */
export function openCreatorSnapshotRecoverySourceTrust(
	input: unknown
): Readonly<
	| { ok: false; reason: string }
	| {
			ok: true;
			trust: CurrentAnchorTrust;
			predecessorTrust: CurrentAnchorTrust;
			derivedPredecessorTrustStateRecordBytes: Uint8Array;
	  }
> {
	return openCreatorSnapshotRecoverySourceTrustOwned(input);
}

type CreatorRecoverySourceResult = ReturnType<typeof openCreatorSnapshotRecoverySourceTrust>;
type CreatorRecoveryEnvelope = Readonly<{objectId: string; exactCanonicalAnchorPreimageBytes: Uint8Array;
	detachedAnchorSignature: Uint8Array; exactCanonicalParametersCarrierBytes: Uint8Array}>;
type CreatorRecoveryVerifiedBranch = Readonly<{
	currentTrust: CurrentAnchorTrust;
	envelopes: readonly (CreatorRecoveryEnvelope | undefined)[];
	chain: Extract<ReturnType<typeof inspectCreatorHistoricalAnchorChain>, {ok: true}>;
	pin: Extract<ReturnType<typeof openCurrentAnchorTrust>, {ok: true}>;
	pinRecord: NonNullable<ReturnType<typeof canonicalCreatorDataRecord>>;
	pinBytes: Uint8Array;
}>;

function verifyCreatorRecoveryBranch(currentTrust: CurrentAnchorTrust,
	envelopes: readonly (CreatorRecoveryEnvelope | undefined)[], pinBytes: Uint8Array): CreatorRecoveryVerifiedBranch | undefined {
	const chain = inspectCreatorHistoricalAnchorChain({currentTrust, envelopes});
	const pinRecord = canonicalCreatorDataRecord(pinBytes), pin = openCurrentAnchorTrust({
		exactCanonicalTrustStateRecordBytes: pinBytes, expectedObjectId: currentTrust.objectId,
		pinnedGenesisAnchorDigest: currentTrust.genesisAnchorDigest,
	});
	return chain.ok && pin.ok && pin.trust.currentEpoch === 0 && pinRecord !== undefined &&
		pin.trust.profileId === currentTrust.profileId ? {currentTrust, envelopes, chain, pin, pinRecord, pinBytes} : undefined;
}

/** One original acquisition's immutable signed evidence, not native authority.
 * Inputs reach this owner only AFTER the original bounded defensive capture and
 * complete proof charges. Exact pin, nominal trust and every signed envelope
 * byte bind a branch; exact ordered candidate bytes AND refs bind each source.
 * Changed branches replace the inventory. Overflow is an uncached original
 * verification, never an admission refusal or proof credit. No native image,
 * floor, progress, inventory or retirement capability is retained here. */
function createCreatorRecoveryEvidenceOwner() {
	let branch: CreatorRecoveryVerifiedBranch | undefined;
	let context: CurrentAnchorTrust | undefined;
	let retainedBytes = 0;
	const sources: {closure: CreatorTransitionClosure; result: Extract<CreatorRecoverySourceResult, {ok: true}>}[] = [];
	const branchBytes = (value: CreatorRecoveryVerifiedBranch): number => value.pinBytes.byteLength + value.envelopes.reduce(
		(sum, envelope) => sum + (envelope === undefined ? 0 : envelope.exactCanonicalAnchorPreimageBytes.byteLength +
			envelope.detachedAnchorSignature.byteLength + envelope.exactCanonicalParametersCarrierBytes.byteLength), 0);
	const sameBranch = (currentTrust: CurrentAnchorTrust, envelopes: readonly (CreatorRecoveryEnvelope | undefined)[], pinBytes: Uint8Array) =>
		branch !== undefined && branch.currentTrust === currentTrust && context !== undefined &&
		context.objectId === currentTrust.objectId && context.currentEpoch === currentTrust.currentEpoch &&
		context.currentAnchorDigest === currentTrust.currentAnchorDigest && context.genesisAnchorDigest === currentTrust.genesisAnchorDigest &&
		context.profileId === currentTrust.profileId && compareBytes(branch.pinBytes, pinBytes) === 0 &&
		branch.envelopes.length === envelopes.length && branch.envelopes.every((old, index) => {
			const current = envelopes[index];
			return old !== undefined && current !== undefined && old.objectId === current.objectId &&
				compareBytes(old.exactCanonicalAnchorPreimageBytes, current.exactCanonicalAnchorPreimageBytes) === 0 &&
				compareBytes(old.detachedAnchorSignature, current.detachedAnchorSignature) === 0 &&
				compareBytes(old.exactCanonicalParametersCarrierBytes, current.exactCanonicalParametersCarrierBytes) === 0;
		});
	const sameClosure = (a: CreatorTransitionClosure, b: CreatorTransitionClosure): boolean =>
		a.closure.length === b.closure.length && a.candidates.length === b.candidates.length &&
		a.closure.every((ref, index) => sameRef(ref, b.closure[index]!)) &&
		a.candidates.every((candidate, index) => sameRef(candidate.ref, b.candidates[index]!.ref) &&
			compareBytes(candidate.bytes, b.candidates[index]!.bytes) === 0);
	const detachedResult = (result: Extract<CreatorRecoverySourceResult, {ok: true}>) => Object.freeze({
		...result, derivedPredecessorTrustStateRecordBytes: result.derivedPredecessorTrustStateRecordBytes.slice(),
	});
	return Object.freeze({
		branch(currentTrust: CurrentAnchorTrust, envelopes: readonly (CreatorRecoveryEnvelope | undefined)[], pinBytes: Uint8Array) {
			if (sameBranch(currentTrust, envelopes, pinBytes)) return branch;
			branch = undefined; context = undefined; sources.length = 0; retainedBytes = 0;
			const verified = verifyCreatorRecoveryBranch(currentTrust, envelopes, pinBytes);
			if (verified !== undefined && branchBytes(verified) <= AHE_BOUNDED_READ_LIMITS.maxUnionBytes) {
				branch = verified; context = Object.freeze({...currentTrust}); retainedBytes = branchBytes(verified);
			}
			return verified;
		},
		source(verified: CreatorRecoveryVerifiedBranch, closure: CreatorTransitionClosure,
			charge: (bytes: Uint8Array) => boolean): CreatorRecoverySourceResult {
			const previous = verified === branch ? sources.find(source => sameClosure(source.closure, closure)) : undefined;
			if (previous !== undefined) return charge(previous.result.derivedPredecessorTrustStateRecordBytes)
				? detachedResult(previous.result) : failure("RECOVERY_ROLE_INPUT_INVALID");
			const result = openCreatorSnapshotRecoverySourceTrustFromVerifiedBranch({...verified, closure}, charge);
			const bytes = closure.candidates.reduce((sum, candidate) => sum + candidate.bytes.byteLength, 0) +
				(result.ok ? result.derivedPredecessorTrustStateRecordBytes.byteLength : 0);
			if (result.ok && verified === branch && sources.length < AHE_BOUNDED_READ_LIMITS.maxObjectGenerations &&
				bytes <= AHE_BOUNDED_READ_LIMITS.maxUnionBytes - retainedBytes) {
				sources.push({closure, result: detachedResult(result)}); retainedBytes += bytes;
			}
			return result;
		},
	});
}
type CreatorRecoveryEvidenceOwner = ReturnType<typeof createCreatorRecoveryEvidenceOwner>;

/** Internal acquisition job only; no portable preverified input or authority is
 * accepted. Public byte openers retain their full defensive paths. Releasing
 * after the acquisition's original joins discards all immutable facts; deferred
 * callers then use the original cold implementation. */
export function createCreatorSnapshotRecoveryEvidenceJob() {
	let owner: CreatorRecoveryEvidenceOwner | undefined = createCreatorRecoveryEvidenceOwner();
	return Object.freeze({
		sourceTrust: (input: unknown): CreatorRecoverySourceResult => openCreatorSnapshotRecoverySourceTrustOwned(input, owner),
		readback: (input: unknown): ReturnType<typeof openCreatorSnapshotRecoveryRoleReadback> =>
			openCreatorSnapshotRecoveryRoleReadbackOwned(input, owner),
		release: (): void => {owner = undefined;},
	});
}

function openCreatorSnapshotRecoverySourceTrustOwned(
	input: unknown, evidence?: CreatorRecoveryEvidenceOwner
): CreatorRecoverySourceResult {
	try {
		const c = capturePromotionRecord(input, [
			"currentTrust",
			"closure",
			"anchorChain",
			"exactCanonicalPinnedGenesisTrustStateRecordBytes",
		]);
		if (c === undefined) return failure("RECOVERY_ROLE_INPUT_INVALID");
		const ledger = createCreatorClosedRollbackProofAccounting([]),
			charge = (bytes: Uint8Array): boolean => ledger.charge(bytes);
		const closure = capturePromotionClosure(c.closure, charge),
			pinBytes = capturePromotionBytes(c.exactCanonicalPinnedGenesisTrustStateRecordBytes, 8192, charge),
			values = capturePromotionArray(c.anchorChain, 6);
		if (closure === undefined || pinBytes === undefined || values === undefined)
			return failure("RECOVERY_ROLE_INPUT_INVALID");
		if (!genuineRecoveryTrust(c.currentTrust, pinBytes)) return failure("RECOVERY_ROLE_TRUST_INVALID");
		const envelopes = values.map((value) => {
			const e = capturePromotionRecord(value, [
				"objectId",
				"exactCanonicalAnchorPreimageBytes",
				"detachedAnchorSignature",
				"exactCanonicalParametersCarrierBytes",
			]);
			const anchor = capturePromotionBytes(e?.exactCanonicalAnchorPreimageBytes, 8192, charge),
				signature = capturePromotionBytes(e?.detachedAnchorSignature, 64, charge),
				parameters = capturePromotionBytes(e?.exactCanonicalParametersCarrierBytes, 65_536, charge);
			return e !== undefined &&
				typeof e.objectId === "string" &&
				anchor !== undefined &&
				signature?.byteLength === 64 &&
				parameters !== undefined
				? {
						objectId: e.objectId,
						exactCanonicalAnchorPreimageBytes: anchor,
						detachedAnchorSignature: signature,
						exactCanonicalParametersCarrierBytes: parameters,
					}
				: undefined;
		});
		if (envelopes.some((value) => value === undefined)) return failure("RECOVERY_ROLE_ANCHOR_INVALID");
		const currentTrust = c.currentTrust as CurrentAnchorTrust,
			branch = evidence === undefined ? verifyCreatorRecoveryBranch(currentTrust, envelopes, pinBytes)
				: evidence.branch(currentTrust, envelopes, pinBytes);
		if (branch === undefined) return failure("RECOVERY_ROLE_ANCHOR_INVALID");
		return evidence === undefined ? openCreatorSnapshotRecoverySourceTrustFromVerifiedBranch({...branch, closure}, charge)
			: evidence.source(branch, closure, charge);
	} catch {
		return failure("RECOVERY_ROLE_INPUT_INVALID");
	}
}

/** The synchronous semantic caller has captured and charged these exact bytes
 * and authenticated this entire branch and genesis pin. Share only that local
 * fact across its source verifications: no caller input, native view, allowance
 * or authority is retained or exported. Every source still opens its ORIGINAL
 * Cut/QC/checkpoint and binds both exact chain identities independently. */
function openCreatorSnapshotRecoverySourceTrustFromVerifiedBranch(
	input: Readonly<{
		closure: CreatorTransitionClosure;
		currentTrust: CurrentAnchorTrust;
		envelopes: readonly (Readonly<{objectId: string; exactCanonicalAnchorPreimageBytes: Uint8Array;
			detachedAnchorSignature: Uint8Array; exactCanonicalParametersCarrierBytes: Uint8Array}> | undefined)[];
		chain: Extract<ReturnType<typeof inspectCreatorHistoricalAnchorChain>, {ok: true}>;
		pin: Extract<ReturnType<typeof openCurrentAnchorTrust>, {ok: true}>;
		pinRecord: NonNullable<ReturnType<typeof canonicalCreatorDataRecord>>;
		pinBytes: Uint8Array;
	}>,
	charge: (bytes: Uint8Array) => boolean
): ReturnType<typeof openCreatorSnapshotRecoverySourceTrust> {
	try {
		const {closure, currentTrust, envelopes, chain, pin, pinRecord, pinBytes} = input;
		const carrier = uniqueCreatorTransitionCandidate(closure.candidates, "drp-anchor-trust-state"),
			recordValue = carrier === undefined ? undefined : record(carrier),
			n = Number(recordValue?.currentEpoch);
		const identity = chain.identities.find((value) => value.epoch === n),
			previousIdentity = chain.identities.find((value) => value.epoch === n - 1),
			predecessorEnvelope = envelopes.find(
				(value) =>
					value !== undefined && canonicalCreatorDataRecord(value.exactCanonicalAnchorPreimageBytes)?.epoch === n - 1
			);
		const cut = uniqueCreatorTransitionCandidate(closure.candidates, "drp-hard-epoch-cut", n - 1),
			qc = uniqueCreatorTransitionCandidate(closure.candidates, "drp-seal-qc", n - 1, "commit");
		// The signed chain must still contain this source's exact identity. Its
		// genesis predecessor is independently authenticated by the original pin
		// and the original successor verifier, not a fabricated chain identity.
		const previousAnchorDigest = n === 1 ? pin.trust.currentAnchorDigest : previousIdentity?.anchorDigest;
		if (
			carrier === undefined ||
			identity === undefined ||
			previousAnchorDigest === undefined ||
			(n !== 1 && predecessorEnvelope === undefined) ||
			cut === undefined ||
			qc === undefined ||
			identity.anchorDigest !== recordValue?.currentAnchorDigest ||
			recordValue?.genesisAnchorDigest !== currentTrust.genesisAnchorDigest ||
			recordValue?.profileId !== currentTrust.profileId
		)
			return failure("RECOVERY_ROLE_SOURCE_INVALID");
		const derived =
			n === 1
				? pinBytes
				: predecessorEnvelope === undefined
					? undefined
					: encodeCanonical({
							...pinRecord,
							currentEpoch: n - 1,
							currentAnchorDigest: previousAnchorDigest,
							exactCanonicalCurrentAnchorPreimageBytes: predecessorEnvelope.exactCanonicalAnchorPreimageBytes,
							detachedCurrentAnchorSignature: predecessorEnvelope.detachedAnchorSignature,
						});
		if (derived === undefined || !charge(derived)) return failure("RECOVERY_ROLE_INPUT_INVALID");
		const cutRecord = record(cut),
			opened =
				n === 1
					? openCreatorSuccessorTrust({
							currentTrust: pin.trust,
							exactCanonicalTrustStateRecordBytes: carrier.bytes,
							exactCanonicalCutValueBytes: cut.bytes,
							exactCanonicalCommitQcBytes: qc.bytes,
						})
					: (cutRecord?.forwardPromotion === undefined
							? openCreatorCheckpointTrust
							: openCreatorForwardPromotionCheckpointTrust)({
							detachedGenesisSignature: pinRecord.detachedCurrentAnchorSignature,
							exactCanonicalGenesisAnchorPreimageBytes: pinRecord.exactCanonicalCurrentAnchorPreimageBytes,
							exactCanonicalPredecessorTrustStateRecordBytes: derived,
							exactCanonicalCurrentTrustStateRecordBytes: carrier.bytes,
							exactCanonicalCutValueBytes: cut.bytes,
							exactCanonicalCommitQcBytes: qc.bytes,
							expectedObjectId: currentTrust.objectId,
							pinnedGenesisAnchorDigest: currentTrust.genesisAnchorDigest,
							expectedCurrentHead: {
								objectId: currentTrust.objectId,
								epoch: n,
								currentAnchorDigest: identity.anchorDigest,
							},
						});
		const trust = opened.ok ? ("trust" in opened ? opened.trust : opened.currentTrust) : undefined;
		const predecessorTrust = opened.ok
			? "predecessorTrust" in opened
				? opened.predecessorTrust
				: pin.trust
			: undefined;
		return trust !== undefined &&
			predecessorTrust !== undefined &&
			predecessorTrust.currentEpoch === n - 1 &&
			predecessorTrust.currentAnchorDigest === previousAnchorDigest &&
			predecessorTrust.objectId === currentTrust.objectId &&
			predecessorTrust.genesisAnchorDigest === currentTrust.genesisAnchorDigest &&
			predecessorTrust.profileId === currentTrust.profileId &&
			trust.currentEpoch === n &&
			trust.currentAnchorDigest === identity.anchorDigest &&
			trust.objectId === currentTrust.objectId &&
			trust.genesisAnchorDigest === currentTrust.genesisAnchorDigest &&
			trust.profileId === currentTrust.profileId
			? Object.freeze({ ok: true, trust, predecessorTrust, derivedPredecessorTrustStateRecordBytes: derived })
			: failure("RECOVERY_ROLE_SOURCE_INVALID");
	} catch {
		return failure("RECOVERY_ROLE_INPUT_INVALID");
	}
}

/**
 * Reconstructs a published ordinary recovery-role certificate from current native proof bytes.
 * Unlike initial construction, retired verification-only payloads are not claimed present.
 * Original signed branch/control identities remain required for every classification, and
 * every operational source and both usable rollback payloads are verified in full.
 * This semantic capability alone has no storage retirement authority.
 * @param input - Genuine current floor trust, exact native closures, source data and original signed chain.
 * @returns Nominal semantic custody or a whole refusal.
 */
export function openCreatorSnapshotRecoveryRoleReadback(
	input: unknown
): Readonly<{ ok: false; reason: string } | { ok: true; transfer: VerifiedCreatorSnapshotRecoveryRoleTransfer }> {
	return openCreatorSnapshotRecoveryRoleReadbackOwned(input);
}

function openCreatorSnapshotRecoveryRoleReadbackOwned(
	input: unknown, evidenceOwner?: CreatorRecoveryEvidenceOwner
): ReturnType<typeof openCreatorSnapshotRecoveryRoleReadback> {
	try {
		const keys = [
			"currentTrust",
			"current",
			"predecessor",
			"currentSnapshot",
			"previousSnapshot",
			"sourceMaterials",
			"anchorChain",
			"exactCanonicalPinnedGenesisTrustStateRecordBytes",
		];
		const captured =
			capturePromotionRecord(input, keys) ??
			capturePromotionRecord(input, [...keys, "currentLive"]) ??
			capturePromotionRecord(input, [...keys, "nativeRetirementCustody"]) ??
			capturePromotionRecord(input, [...keys, "currentLive", "nativeRetirementCustody"]);
		if (captured === undefined) return failure("RECOVERY_ROLE_INPUT_INVALID");
		const ledger = createCreatorClosedRollbackProofAccounting([]),
			charge = (bytes: Uint8Array): boolean => ledger.charge(bytes);
		const current = capturePromotionClosure(captured.current, charge),
			predecessor = capturePromotionClosure(captured.predecessor, charge),
			latest = capturePromotionSnapshot(captured.currentSnapshot),
			previous = capturePromotionSnapshot(captured.previousSnapshot),
			pinBytes = capturePromotionBytes(captured.exactCanonicalPinnedGenesisTrustStateRecordBytes, 8192, charge),
			materialValues = capturePromotionArray(captured.sourceMaterials, 4),
			chainValues = capturePromotionArray(captured.anchorChain, 6);
		if (
			current === undefined ||
			predecessor === undefined ||
			latest === undefined ||
			previous === undefined ||
			pinBytes === undefined ||
			materialValues === undefined ||
			chainValues === undefined
		)
			return failure("RECOVERY_ROLE_INPUT_INVALID");
		if (!genuineRecoveryTrust(captured.currentTrust, pinBytes)) return failure("RECOVERY_ROLE_TRUST_INVALID");
		const live = Object.hasOwn(captured, "currentLive")
			? capturePromotionClosure(captured.currentLive, charge)
			: current;
		if (live === undefined) return failure("RECOVERY_ROLE_INPUT_INVALID");
		const currentTrust = captured.currentTrust as CurrentAnchorTrust,
			n = currentTrust.currentEpoch;
		if (!Number.isSafeInteger(n) || n < 3) return failure("RECOVERY_ROLE_TRUST_INVALID");
		// This synchronous semantic owner already captured/charged each bounded
		// closure and authenticated its genuine current trust. Share syntax only
		// across its repeated metadata reads; exact byte comparisons, detached
		// full values and every original independent opener remain unchanged.
		const syntax = createCreatorCanonicalSyntaxReader();
		const select = (
			candidates: readonly DetachedClosureCandidate[], kind: string, epoch?: number, phase?: string
		) => uniqueCreatorTransitionCandidate(candidates, kind, epoch, phase, syntax);
		const carrier = select(current.candidates, "drp-anchor-trust-state", n),
			cut = select(current.candidates, "drp-hard-epoch-cut", n - 1),
			qc = select(current.candidates, "drp-seal-qc", n - 1, "commit"),
			priorCarrier = select(predecessor.candidates, "drp-anchor-trust-state", n - 1),
			priorCut = select(predecessor.candidates, "drp-hard-epoch-cut", n - 2);
		if (
			carrier === undefined ||
			cut === undefined ||
			qc === undefined ||
			priorCarrier === undefined ||
			priorCut === undefined
		)
			return failure("RECOVERY_ROLE_LINEAGE_INVALID");
		const cutRecord = record(cut, syntax),
			priorRecord = record(priorCut, syntax),
			pinRecord = canonicalCreatorDataRecord(pinBytes);
		const roles = captureCreatorSnapshotRecoveryRoles(cutRecord?.recoveryRoles);
		if (
			cutRecord === undefined ||
			priorRecord === undefined ||
			roles === undefined ||
			roles.previousClose === null ||
			pinRecord === undefined ||
			cutRecord.forwardPromotion !== undefined ||
			roles.genesisAnchorDigest !== currentTrust.genesisAnchorDigest ||
			!samePromotionValue(roles.currentClose, recoveryScopeForCut(cutRecord)) ||
			!samePromotionValue(roles.previousClose, recoveryScopeForCut(priorRecord))
		)
			return failure("RECOVERY_ROLE_TRANSFER_INVALID");
		const opened = openCreatorCheckpointTrust({
			detachedGenesisSignature: pinRecord.detachedCurrentAnchorSignature,
			exactCanonicalGenesisAnchorPreimageBytes: pinRecord.exactCanonicalCurrentAnchorPreimageBytes,
			exactCanonicalPredecessorTrustStateRecordBytes: priorCarrier.bytes,
			exactCanonicalCurrentTrustStateRecordBytes: carrier.bytes,
			exactCanonicalCutValueBytes: cut.bytes,
			exactCanonicalCommitQcBytes: qc.bytes,
			expectedObjectId: currentTrust.objectId,
			pinnedGenesisAnchorDigest: currentTrust.genesisAnchorDigest,
			expectedCurrentHead: {
				objectId: currentTrust.objectId,
				epoch: n,
				currentAnchorDigest: currentTrust.currentAnchorDigest,
			},
		});
		const currentBinding = inspectCreatorClosedCutSuccessorBinding({
			successorTrust: currentTrust,
			exactCanonicalCutValueBytes: cut.bytes,
		});
		if (!opened.ok) return failure(`RECOVERY_ROLE_LINEAGE_INVALID:checkpoint:${opened.reason}`);
		if (!currentBinding.ok) return failure(`RECOVERY_ROLE_LINEAGE_INVALID:binding:${currentBinding.reason}`);
		if (opened.currentTrust.profileId !== currentTrust.profileId)
			return failure("RECOVERY_ROLE_LINEAGE_INVALID:profile");
		const priorTrust = opened.predecessorTrust;
		const priorBinding = (
			priorRecord.forwardPromotion === undefined
				? inspectCreatorClosedCutSuccessorBinding
				: inspectCreatorForwardPromotionClosedCutSuccessorBinding
		)({ successorTrust: priorTrust, exactCanonicalCutValueBytes: priorCut.bytes });
		const latestData = promotionSnapshotData(latest, cutRecord, currentTrust.profileId, syntax),
			priorData = promotionSnapshotData(previous, priorRecord, currentTrust.profileId, syntax);
		if (
			!priorBinding.ok ||
			latestData === undefined ||
			priorData === undefined ||
			![
				latest.exactCanonicalManifestBytes,
				latest.exactCanonicalPayloadBytes,
				previous.exactCanonicalManifestBytes,
				previous.exactCanonicalPayloadBytes,
			].every(charge)
		)
			return failure("RECOVERY_ROLE_SNAPSHOT_INVALID");
		const closedAcl = select(live.candidates, "drp-v3-latched-acl", n - 1);
		if (closedAcl === undefined || compareBytes(closedAcl.bytes, priorData.successorAclBytes) !== 0)
			return failure("RECOVERY_ROLE_LINEAGE_INVALID:acl");
		const continuity = inspectCreatorTransitionAdvance({
			current: predecessor,
			proposed: current,
			currentTrust: priorTrust,
			successorTrust: currentTrust,
			mode: "verify",
			proofRefs: [cut.ref, qc.ref],
			settlementAcl: { current: priorData.successorAclBytes, successor: latestData.successorAclBytes },
		});
		if (!continuity.ok) return failure(`RECOVERY_ROLE_LINEAGE_INVALID:advance:${continuity.reason}`);
		if (Object.hasOwn(captured, "currentLive")) {
			const oldProjection = select(current.candidates, "v3-live-generation-2", n - 1),
				priorProjection = select(predecessor.candidates, "v3-live-generation-2", n - 1),
				newProjection = select(live.candidates, "v3-live-generation-2", n);
			if (
				oldProjection === undefined ||
				priorProjection === undefined ||
				newProjection === undefined ||
				!sameRef(oldProjection.ref, priorProjection.ref) ||
				live.candidates.filter((value) => candidateSelection(value, syntax)?.kind === "v3-live-generation-2").length !== 1 ||
				current.candidates.filter((value) => candidateSelection(value, syntax)?.kind === "v3-live-generation-2").length !== 1
			)
				return failure("RECOVERY_ROLE_PROJECTION_INVALID:bridge");
			if (
				!matchesCreatorAdoptionReferences({
					pendingReferences: current.closure,
					predecessorLiveRef: oldProjection.ref,
					exactCanonicalProjectionBytes: newProjection.bytes,
					exactCanonicalCutValueBytes: cut.bytes,
					predecessorExactCanonicalLatchedAclBytes: closedAcl.bytes,
				}, live.closure)
			)
				return failure("RECOVERY_ROLE_LINEAGE_INVALID");
		}
		const projection = select(live.candidates, "v3-live-generation-2", n);
		const projectionRecord = projection === undefined ? undefined : record(projection, syntax);
		if (
			projectionRecord === undefined ||
			!creatorSnapshotProjectionMatches(
				projectionRecord,
				currentBinding.successorAnchor,
				currentTrust.currentAnchorDigest,
				String(cutRecord.snapshotManifestDigest),
				latestData.manifest
			)
		)
			return failure("RECOVERY_ROLE_PROJECTION_INVALID:latest");
		const envelopes = chainValues.map((value) => {
			const e = capturePromotionRecord(value, [
				"objectId",
				"exactCanonicalAnchorPreimageBytes",
				"detachedAnchorSignature",
				"exactCanonicalParametersCarrierBytes",
			]);
			const anchor = capturePromotionBytes(e?.exactCanonicalAnchorPreimageBytes, 8192, charge),
				signature = capturePromotionBytes(e?.detachedAnchorSignature, 64, charge),
				parameters = capturePromotionBytes(e?.exactCanonicalParametersCarrierBytes, 65_536, charge);
			return e !== undefined &&
				typeof e.objectId === "string" &&
				anchor !== undefined &&
				signature?.byteLength === 64 &&
				parameters !== undefined
				? {
						objectId: e.objectId,
						exactCanonicalAnchorPreimageBytes: anchor,
						detachedAnchorSignature: signature,
						exactCanonicalParametersCarrierBytes: parameters,
					}
				: undefined;
		});
		if (envelopes.some((e) => e === undefined)) return failure("RECOVERY_ROLE_ANCHOR_INVALID");
		const verifiedBranch = evidenceOwner === undefined ? verifyCreatorRecoveryBranch(currentTrust, envelopes, pinBytes)
			: evidenceOwner.branch(currentTrust, envelopes, pinBytes);
		if (verifiedBranch === undefined) return failure("RECOVERY_ROLE_ANCHOR_INVALID");
		const identities = new Map(verifiedBranch.chain.identities.map((identity) => [identity.epoch, identity]));
		const materials = new Map<
			string,
			Readonly<{
				scope: CreatorSnapshotRecoveryScope;
				cut: Readonly<Record<string, unknown>>;
				source?: PromotionSource;
				data?: NonNullable<ReturnType<typeof promotionSnapshotData>>;
			}>
		>();
		for (const value of materialValues) {
			const m = capturePromotionRecord(value, ["closure", "snapshot"]),
				closure = capturePromotionClosure(m?.closure, charge),
				snapshot = m?.snapshot === null ? null : capturePromotionSnapshot(m?.snapshot);
			if (m === undefined || closure === undefined || snapshot === undefined)
				return failure("RECOVERY_ROLE_INPUT_INVALID");
			const c = select(closure.candidates, "drp-anchor-trust-state"),
				cRecord = c === undefined ? undefined : record(c, syntax),
				epoch = Number(cRecord?.currentEpoch);
			const original = identities.get(epoch),
				closedIdentity = identities.get(epoch - 1);
			if (
				c === undefined ||
				original === undefined ||
				closedIdentity === undefined ||
				cRecord?.currentAnchorDigest !== original.anchorDigest ||
				cRecord?.objectId !== currentTrust.objectId ||
				cRecord?.genesisAnchorDigest !== currentTrust.genesisAnchorDigest ||
				cRecord?.profileId !== currentTrust.profileId
			)
				return failure("RECOVERY_ROLE_SOURCE_INVALID");
			const trust = evidenceOwner === undefined ? openCreatorSnapshotRecoverySourceTrustFromVerifiedBranch({
				...verifiedBranch, closure,
			}, charge) : evidenceOwner.source(verifiedBranch, closure, charge);
			if (!trust.ok)
				return failure("RECOVERY_ROLE_SOURCE_INVALID");
			const evidence = openCreatorTransitionClosedCutEvidence({ closure, floorTrust: trust.trust });
			const sourceCut = evidence === undefined ? undefined : record(evidence.cut, syntax);
			if (evidence === undefined || sourceCut === undefined || sourceCut.previousAnchor !== closedIdentity.anchorDigest)
				return failure("RECOVERY_ROLE_SOURCE_INVALID");
			const binding = (
				sourceCut.forwardPromotion === undefined
					? inspectCreatorClosedCutSuccessorBinding
					: inspectCreatorForwardPromotionClosedCutSuccessorBinding
			)({ successorTrust: trust.trust, exactCanonicalCutValueBytes: evidence.cut.bytes });
			if (!binding.ok) return failure("RECOVERY_ROLE_SOURCE_INVALID");
			const scope = recoveryScopeForCut(sourceCut),
				key = recoveryScopeKey(scope);
			if (materials.has(key)) return failure("RECOVERY_ROLE_SOURCE_INVALID");
			const data = snapshot === null ? undefined : promotionSnapshotData(snapshot, sourceCut, currentTrust.profileId, syntax);
			if (
				snapshot !== null &&
				(data === undefined ||
					!charge(snapshot.exactCanonicalManifestBytes) ||
					!charge(snapshot.exactCanonicalPayloadBytes))
			)
				return failure("RECOVERY_ROLE_SNAPSHOT_INVALID");
			const aclCandidate = select(closure.candidates, "drp-v3-latched-acl", epoch - 1);
			if (
				aclCandidate === undefined ||
				!openCanonicalLatchedAclSnapshot({
					exactCanonicalLatchedAclBytes: aclCandidate.bytes,
					expectedAclDigest: closedIdentity.aclDigest,
					expectedEpoch: epoch - 1,
					expectedObjectId: currentTrust.objectId,
					expectedProfileId: currentTrust.profileId,
				}).ok
			)
				return failure("RECOVERY_ROLE_SOURCE_INVALID");
			const source =
				snapshot === null || data === undefined
					? undefined
					: Object.freeze({
							closedEpoch: epoch - 1,
							closedAnchorDigest: closedIdentity.anchorDigest,
							successorEpoch: epoch,
							successorAnchorDigest: original.anchorDigest,
							cutValueDigest: creatorDataDigest("ts-drp/hard-epoch-cut/v3", evidence.cut.bytes),
							cutRef: evidence.cut.ref,
							commitQcRef: evidence.qc.ref,
							manifestRef: {
								digest: String(sourceCut.snapshotManifestDigest),
								byteLength: snapshot.exactCanonicalManifestBytes.byteLength,
							},
							payloadDigest: String(data.manifest.payloadDigest),
							stateDigest: String(sourceCut.stateDigest),
							closedAclDigest: closedIdentity.aclDigest,
							snapshotAclDigest: String(sourceCut.aclDigest),
							checkpointRepresentation: evidence.representation,
							checkpointRefs: promotionControls(evidence),
						});
			materials.set(
				key,
				Object.freeze({
					scope,
					cut: sourceCut,
					...(source === undefined || data === undefined ? {} : { source, data }),
				})
			);
		}
		const signedPromotion =
			priorRecord.forwardPromotion === undefined ? null : captureForwardPromotion(priorRecord.forwardPromotion);
		if (
			signedPromotion === undefined ||
			!samePromotionValue(roles.operationalSources, signedPromotion === null ? [] : [signedPromotion.source])
		)
			return failure("RECOVERY_ROLE_SOURCE_INVALID");
		for (const source of roles.operationalSources) {
			const actual = materials.get(recoveryScopeKey(recoveryScopeForSource(source, currentTrust.objectId)));
			if (actual?.source === undefined || !samePromotionValue(actual.source, source))
				return failure("RECOVERY_ROLE_SOURCE_INVALID");
		}
		const priorProjection = select(predecessor.candidates, "v3-live-generation-2", n - 1);
		const priorProjectionRecord = priorProjection === undefined ? undefined : record(priorProjection, syntax);
		const operationalData =
			signedPromotion === null
				? priorData
				: materials.get(recoveryScopeKey(recoveryScopeForSource(signedPromotion.source, currentTrust.objectId)))?.data;
		if (
			priorProjectionRecord === undefined ||
			operationalData === undefined ||
			!(signedPromotion === null
				? creatorSnapshotProjectionMatches(
						priorProjectionRecord,
						priorBinding.successorAnchor,
						priorTrust.currentAnchorDigest,
						String(priorRecord.snapshotManifestDigest),
						operationalData.manifest
					)
				: creatorPromotedSnapshotProjectionMatches(
						priorProjectionRecord,
						priorBinding.successorAnchor,
						priorTrust.currentAnchorDigest,
						signedPromotion.source,
						operationalData.manifest
					))
		)
			return failure("RECOVERY_ROLE_PROJECTION_INVALID:previous");
		const allowed = new Set<string>();
		// Reconstruct the original ordinary C0 -> C1 shift only from the
		// already authenticated branch, exact controls and both full snapshots.
		// Field-free C1 has no parent role spelling to inherit on the next close.
		const bootstrapClassification = (
			parentCut: Readonly<Record<string, unknown>>,
			parentData: NonNullable<ReturnType<typeof promotionSnapshotData>> | undefined
		): string | undefined => {
			if (
				parentCut.epoch !== 1 ||
				parentCut.objectId !== currentTrust.objectId ||
				Object.hasOwn(parentCut, "recoveryRoles") ||
				Object.hasOwn(parentCut, "forwardPromotion") ||
				parentData === undefined
			)
				return undefined;
			const matches = [...materials].filter(([, material]) => {
				const source = material.source;
				return (
					source !== undefined &&
					material.data !== undefined &&
					source.closedEpoch === 0 &&
					source.closedAnchorDigest === currentTrust.genesisAnchorDigest &&
					source.successorEpoch === 1 &&
					source.successorAnchorDigest === parentCut.previousAnchor &&
					samePromotionValue(material.scope, recoveryScopeForSource(source, currentTrust.objectId))
				);
			});
			return matches.length === 1 ? matches[0]?.[0] : undefined;
		};
		if (signedPromotion !== null)
			for (const source of signedPromotion.roles.retainedSources)
				allowed.add(recoveryScopeKey(recoveryScopeForSource(source, currentTrust.objectId)));
		else if (n === 3 && !Object.hasOwn(priorRecord, "recoveryRoles")) {
			const bootstrap = bootstrapClassification(priorRecord, priorData);
			if (bootstrap !== undefined) allowed.add(bootstrap);
		} else if (Object.hasOwn(priorRecord, "recoveryRoles")) {
			const priorRoles = captureCreatorSnapshotRecoveryRoles(priorRecord.recoveryRoles);
			if (
				priorRoles === undefined ||
				!samePromotionValue(priorRoles.currentClose, recoveryScopeForCut(priorRecord)) ||
				priorRoles.genesisAnchorDigest !== currentTrust.genesisAnchorDigest ||
				priorRoles.previousClose === null
			)
				return failure("RECOVERY_ROLE_TRANSFER_INVALID");
			const originalPrior = materials.get(recoveryScopeKey(priorRoles.previousClose));
			if (originalPrior === undefined) return failure("RECOVERY_ROLE_SOURCE_INVALID");
			const priorPromotion =
				originalPrior.cut.forwardPromotion === undefined
					? null
					: captureForwardPromotion(originalPrior.cut.forwardPromotion);
			if (
				priorPromotion === undefined ||
				!samePromotionValue(priorRoles.operationalSources, priorPromotion === null ? [] : [priorPromotion.source])
			)
				return failure("RECOVERY_ROLE_TRANSFER_INVALID");
			for (const scope of [
				priorRoles.previousClose,
				...priorRoles.operationalSources.map((source) => recoveryScopeForSource(source, currentTrust.objectId)),
			])
				allowed.add(recoveryScopeKey(scope));
			// Capacity need not force retirement at every close. A still-native
			// classified scope can survive one more role transfer, but the prior
			// signed classification alone is not authority: reconstruct its exact
			// earlier rollback-to-classified shift from the authenticated parent
			// source Cut and the actual same-branch source material.
			const parentRoles = captureCreatorSnapshotRecoveryRoles(originalPrior.cut.recoveryRoles);
			if (
				parentRoles !== undefined &&
				parentRoles.genesisAnchorDigest === currentTrust.genesisAnchorDigest &&
				samePromotionValue(parentRoles.currentClose, originalPrior.scope) &&
				parentRoles.previousClose !== null
			) {
				const key = recoveryScopeKey(parentRoles.previousClose);
				const source = materials.get(key);
				if (
					source !== undefined &&
					samePromotionValue(source.scope, parentRoles.previousClose) &&
					priorRoles.classifiedScopes.some((scope) => recoveryScopeKey(scope) === key)
				)
					allowed.add(key);
			}
			if (parentRoles === undefined && priorRecord.epoch === 2 && priorRoles.operationalSources.length === 0) {
				const bootstrap = bootstrapClassification(originalPrior.cut, originalPrior.data);
				if (
					bootstrap !== undefined &&
					priorRoles.classifiedScopes.some((scope) => recoveryScopeKey(scope) === bootstrap)
				)
					allowed.add(bootstrap);
			}
		}
		const protectedKeys = new Set(
			[
				roles.currentClose,
				roles.previousClose,
				...roles.operationalSources.map((source) => recoveryScopeForSource(source, currentTrust.objectId)),
			].map(recoveryScopeKey)
		);
		if (Object.hasOwn(captured, "nativeRetirementCustody")) {
			const retired = consumeCreatorRecoveryRoleRetiredReadback(
				captured.nativeRetirementCustody,
				input,
				currentTrust,
				creatorDataDigest("ts-drp/hard-epoch-cut/v3", cut.bytes)
			);
			if (retired === undefined || retired.length === 0) return failure("RECOVERY_ROLE_CLASSIFICATION_INVALID");
			const retiredKeys = new Set(retired.map(recoveryScopeKey));
			const absent = [...materials].filter(([, material]) => material.data === undefined).map(([key]) => key);
			if (
				retiredKeys.size !== retired.length ||
				retiredKeys.size !== absent.length ||
				absent.some((key) => !retiredKeys.has(key)) ||
				retired.some(
					(scope) =>
						protectedKeys.has(recoveryScopeKey(scope)) ||
						!roles.classifiedScopes.some((classified) => samePromotionValue(classified, scope))
				)
			)
				return failure("RECOVERY_ROLE_CLASSIFICATION_INVALID");
			for (const key of retiredKeys) allowed.add(key);
		}
		for (const scope of roles.classifiedScopes)
			if (
				protectedKeys.has(recoveryScopeKey(scope)) ||
				!allowed.has(recoveryScopeKey(scope)) ||
				!materials.has(recoveryScopeKey(scope))
			)
				return failure("RECOVERY_ROLE_CLASSIFICATION_INVALID");
		const transfer = Object.freeze({}) as VerifiedCreatorSnapshotRecoveryRoleTransfer;
		recoveryRoleTransfers.set(transfer, roles);
		return Object.freeze({ ok: true, transfer });
	} catch {
		return failure("RECOVERY_ROLE_INPUT_INVALID");
	}
}
