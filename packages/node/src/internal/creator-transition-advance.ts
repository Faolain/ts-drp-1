import { decodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DetachedClosureCandidate } from "@ts-drp/control-plane";
import { inspectCreatorTrustAdvance } from "@ts-drp/control-plane/creator-trust-advance";
import { inspectBoundedCreatorTrustAdvance } from "@ts-drp/control-plane/creator-trust-checkpoint-advance";
import type { CurrentAnchorTrust } from "@ts-drp/protocol-v3";
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
	type VerifiedCreatorAuthorSettlement,
} from "@ts-drp/protocol-v3/creator-author-issuance-frontiers";
import {
	CREATOR_ISSUANCE_RETIREMENT_GENESIS_SENTINEL,
	CREATOR_ISSUANCE_RETIREMENT_KIND,
	type CreatorIssuanceRetirementIdentity,
	openCreatorIssuanceRetirement,
	resolveCreatorIssuanceRetirement,
	type VerifiedCreatorIssuanceRetirement,
} from "@ts-drp/protocol-v3/creator-issuance-retirement";
import { type LatchedAclSnapshot, openCanonicalLatchedAclSnapshot } from "@ts-drp/protocol-v3/latched-acl";
import { settlementProfileFor } from "@ts-drp/protocol-v3/settlement-profile";
import { digestBlob, type GenerationRef } from "@ts-drp/storage";

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

const verifiedHistoricalIssuance = new WeakMap<VerifiedCreatorHistoricalIssuance, CreatorHistoricalIssuanceIdentity>();

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

function record(candidate: DetachedClosureCandidate): Readonly<Record<string, unknown>> | undefined {
	try {
		const decoded = decodeCanonical(candidate.bytes);
		return decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)
			? (decoded as Readonly<Record<string, unknown>>)
			: undefined;
	} catch {
		return undefined;
	}
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
	phase?: string
): DetachedClosureCandidate | undefined {
	const matches = candidates.filter((candidate) => {
		const decoded = record(candidate);
		return (
			decoded?.kind === kind &&
			(epoch === undefined ||
				(decoded.kind === "drp-anchor-trust-state" ? decoded.currentEpoch : decoded.epoch) === epoch) &&
			(phase === undefined || decoded.phase === phase)
		);
	});
	return matches.length === 1 ? matches[0] : undefined;
}

function failure(reason: string): InspectCreatorTransitionAdvanceResult {
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

function retirementCandidates(closure: CreatorTransitionClosure): readonly DetachedClosureCandidate[] {
	return closure.candidates.filter((candidate) => record(candidate)?.kind === CREATOR_ISSUANCE_RETIREMENT_KIND);
}

function aggregateCandidates(closure: CreatorTransitionClosure): readonly DetachedClosureCandidate[] {
	return closure.candidates.filter((candidate) => record(candidate)?.kind === CREATOR_AUTHOR_ISSUANCE_FRONTIERS_KIND);
}

function settlementCandidates(closure: CreatorTransitionClosure): readonly DetachedClosureCandidate[] {
	return closure.candidates.filter((candidate) => record(candidate)?.kind === CREATOR_AUTHOR_SETTLEMENT_KIND);
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

function currentAnchorAclDigest(closure: CreatorTransitionClosure, trust: CurrentAnchorTrust): string | undefined {
	const trustCandidate = uniqueCreatorTransitionCandidate(
		closure.candidates,
		"drp-anchor-trust-state",
		trust.currentEpoch
	);
	if (
		trustCandidate === undefined ||
		!exactCandidate(trustCandidate) ||
		!exactCreatorTransitionOccurrence(closure.closure, trustCandidate)
	) {
		return undefined;
	}
	const trustRecord = record(trustCandidate);
	const anchorBytes = trustRecord?.exactCanonicalCurrentAnchorPreimageBytes;
	if (!(anchorBytes instanceof Uint8Array)) return undefined;
	let anchor: Readonly<Record<string, unknown>> | undefined;
	try {
		const decoded = decodeCanonical(anchorBytes);
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
		: Object.freeze({ candidate, identity });
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
		verifiedHistoricalIssuance.set(capability, selected);
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
	const identity = verifiedHistoricalIssuance.get(capability);
	return identity === undefined ? undefined : Object.freeze({ ...identity });
}

function authenticatedRetirementPair(input: InspectCreatorTransitionAdvanceInput):
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
	const currentMatches = retirementCandidates(input.current);
	const proposedMatches = retirementCandidates(input.proposed);
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
		input.currentTrust.currentEpoch - 1
	);
	const retiringQc = uniqueCreatorTransitionCandidate(
		input.current.candidates,
		"drp-seal-qc",
		input.currentTrust.currentEpoch - 1,
		"commit"
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
	const epoch = input.floorTrust.currentEpoch - 1;
	const cut = uniqueCreatorTransitionCandidate(input.closure.candidates, "drp-hard-epoch-cut", epoch);
	const qc = uniqueCreatorTransitionCandidate(input.closure.candidates, "drp-seal-qc", epoch, "commit");
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
	const acl = uniqueCreatorTransitionCandidate(input.closure.candidates, "drp-v3-latched-acl", epoch);
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
	retirement: NonNullable<ReturnType<typeof authenticatedRetirementPair>>
):
	| Readonly<{
			readonly current?: DetachedClosureCandidate;
			readonly proposed: DetachedClosureCandidate;
	  }>
	| undefined {
	const currentMatches = aggregateCandidates(input.current);
	const proposedMatches = aggregateCandidates(input.proposed);
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
	const currentCut = uniqueCreatorTransitionCandidate(input.current.candidates, "drp-hard-epoch-cut", closedEpoch);
	const currentQc = uniqueCreatorTransitionCandidate(input.current.candidates, "drp-seal-qc", closedEpoch, "commit");
	const currentAcl = uniqueCreatorTransitionCandidate(input.current.candidates, "drp-v3-latched-acl", closedEpoch);
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

function authenticatedSettlementPair(input: InspectCreatorTransitionAdvanceInput):
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
		retirementCandidates(input.current).length !== 0 ||
		retirementCandidates(input.proposed).length !== 0 ||
		aggregateCandidates(input.current).length !== 0 ||
		aggregateCandidates(input.proposed).length !== 0
	) {
		return undefined;
	}
	const currentMatches = settlementCandidates(input.current);
	const proposedMatches = settlementCandidates(input.proposed);
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
	const currentAclDigest = currentAnchorAclDigest(input.current, input.currentTrust);
	if (proposedCut === undefined || proposedQc === undefined || currentAclDigest === undefined) return undefined;
	const openedProposed = openCreatorTransitionSettlement(
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
	const currentCut = uniqueCreatorTransitionCandidate(input.current.candidates, "drp-hard-epoch-cut", closedEpoch);
	const currentQc = uniqueCreatorTransitionCandidate(input.current.candidates, "drp-seal-qc", closedEpoch, "commit");
	const currentAcl = uniqueCreatorTransitionCandidate(input.current.candidates, "drp-v3-latched-acl", closedEpoch);
	if (currentCut === undefined || currentQc === undefined || currentAcl === undefined || !exactCandidate(currentAcl)) {
		return undefined;
	}
	const openedCurrent = openCreatorTransitionSettlement(
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
	try {
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
			const settlement = authenticatedSettlementPair(input);
			if (settlement === undefined) return failure("TRUST_CLOSURE_INVALID");
			normalizedCurrent = withoutControlCandidates(input.current, [settlement.current]);
			normalizedProposed = withoutControlCandidates(input.proposed, [settlement.proposed]);
			proposedControls = Object.freeze([settlement.proposed]);
		} else {
			const retirement = authenticatedRetirementPair(input);
			if (retirement === undefined) return failure("TRUST_CLOSURE_INVALID");
			const aggregate = authenticatedAggregatePair(input, retirement);
			if (aggregate === undefined) return failure("TRUST_CLOSURE_INVALID");
			normalizedCurrent = withoutControlCandidates(input.current, [retirement.current, aggregate.current]);
			normalizedProposed = withoutControlCandidates(input.proposed, [retirement.proposed, aggregate.proposed]);
			proposedControls = Object.freeze([retirement.proposed, aggregate.proposed]);
		}
		const trustCandidates = input.current.candidates.filter(
			(candidate) => record(candidate)?.kind === "drp-anchor-trust-state"
		);
		if (trustCandidates.length !== 1) return failure("TRUST_CLOSURE_INVALID");
		const trust = record(trustCandidates[0] as DetachedClosureCandidate);
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
		const retiringCut = uniqueCreatorTransitionCandidate(input.current.candidates, "drp-hard-epoch-cut", retiringEpoch);
		const retiringQc = uniqueCreatorTransitionCandidate(
			input.current.candidates,
			"drp-seal-qc",
			retiringEpoch,
			"commit"
		);
		const retiringAcl = uniqueCreatorTransitionCandidate(input.current.candidates, "drp-v3-latched-acl", retiringEpoch);
		if (retiringCut === undefined || retiringQc === undefined || retiringAcl === undefined) {
			return failure("RETIRING_PROOF_REFS_INVALID");
		}
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
