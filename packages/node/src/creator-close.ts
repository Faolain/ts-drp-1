import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { type AccumulatorSnapshot, deriveCloseSetHistoryCommitment, type EpochVertex } from "@ts-drp/compaction";
import {
	type SnapshotVerificationReceipt,
	verifySnapshotStreamWithReceipt,
} from "@ts-drp/compaction/snapshot-quarantine-receipt";
import { inspectTrustClosure } from "@ts-drp/control-plane";
import type { DurableIssuanceStore, DurableIssueScope } from "@ts-drp/issuance-store";
import { type FinalitySigner, signCreatorIssuanceRetirementRequest } from "@ts-drp/keychain/finality";
import type { DurableLiveJournalStore } from "@ts-drp/live-journal";
import type { CurrentAnchorTrust } from "@ts-drp/protocol-v3";
import {
	completeCreatorAuthorIssuanceFrontiers,
	CREATOR_AUTHOR_ISSUANCE_FRONTIERS_GENESIS_SENTINEL,
	CREATOR_AUTHOR_ISSUANCE_FRONTIERS_KIND,
	type CreatorAuthorIssuanceFrontier,
	openCreatorAuthorIssuanceFrontiers,
	prepareCreatorAuthorIssuanceFrontiers,
	resolveCreatorAuthorIssuanceFrontiers,
} from "@ts-drp/protocol-v3/creator-author-issuance-frontiers";
import { openCreatorSuccessorTrust, prepareCreatorClose } from "@ts-drp/protocol-v3/creator-close";
import {
	completeCreatorIssuanceRetirement,
	CREATOR_ISSUANCE_RETIREMENT_GENESIS_SENTINEL,
	CREATOR_ISSUANCE_RETIREMENT_KIND,
	CREATOR_ISSUANCE_RETIREMENT_UNAVAILABLE,
	openCreatorIssuanceRetirement,
	prepareCreatorIssuanceRetirement,
	resolveCreatorIssuanceRetirement,
} from "@ts-drp/protocol-v3/creator-issuance-retirement";
import {
	authorizeLatchedApplicationWrite,
	type LatchedAclSnapshot,
	openCanonicalLatchedAclSnapshot,
} from "@ts-drp/protocol-v3/latched-acl";
import { settlementProfileFor } from "@ts-drp/protocol-v3/settlement-profile";
import {
	decodeSnapshotManifest,
	encodeSnapshotTransfer,
	type SnapshotTransferProfile,
} from "@ts-drp/protocol-v3/snapshot-transfer";
import type { SealStorePort } from "@ts-drp/seal";
import { createCreatorSealActor } from "@ts-drp/seal/creator";
import {
	type AheDurableStore,
	digestBlob,
	digestClosure,
	type GenerationId,
	type GenerationRef,
	parseGenerationId,
	type PresentHead,
} from "@ts-drp/storage";
import type { SnapshotQuarantineDeclaration, SnapshotQuarantineStore } from "@ts-drp/storage/snapshot-transfer";

import { installCreatorAdoptionFacts, revokeCreatorAdoptionFacts } from "./internal/creator-adoption-intent.js";
import { deriveCreatorIssuanceRetirementBoundary } from "./internal/creator-issuance-retirement-boundary.js";
import { inspectCreatorTransitionAdvance } from "./internal/creator-transition-advance.js";
import {
	type CreatorCloseRuntimeReleaseCensus,
	type CreatorCloseRuntimeReleasePlan,
	installCreatorCloseRuntimeRelease,
} from "./internal/runtime-reclamation.js";
import type { V3PlaneHandle } from "./v3-live.js";

const PROFILE: SnapshotTransferProfile = Object.freeze({
	maxManifestBytes: 212_387,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
});
const SCANNABLE_BYTES = 8192;
const LEGACY_MULTI_AUTHOR_MIGRATION_REQUIRED = "D110C_0C1F1_LEGACY_MULTI_AUTHOR_MIGRATION_REQUIRED";
const AUTHOR_REENTRY_PROOF_REQUIRED = "D110C_0C1F1_AUTHOR_REENTRY_PROOF_REQUIRED";
const bindings = new WeakMap<V3PlaneHandle, CreatorLiveCloseHandle>();
const runtimeReleaseOwners = new WeakMap<V3PlaneHandle, () => CreatorCloseRuntimeReleasePlan | undefined>();
let creatorCloseRegistrationResolver: ((plane: V3PlaneHandle) => unknown) | undefined;

type CreatorTrustProjection = Readonly<{
	byzantineFaultTolerant: false;
	kind: "creator-certified";
	quorum: 1;
	signerCount: 1;
	text: "Creator-certified; one of one; not Byzantine-fault-tolerant.";
}>;

export type CreatorLiveCloseStatus = Readonly<{
	closeAuthority: "available" | "unavailable";
	continuity: "continuous" | "relearning" | "stalled";
	lifecycle: "active" | "sealed" | "successor-adopted" | "successor-pending-adoption";
	trust: CreatorTrustProjection;
}>;

export type CreatorLiveCloseResult = Readonly<{
	closedVertexCount: number;
	commitQcRef: GenerationRef;
	currentTrustRef: GenerationRef;
	cutValueRef: GenerationRef;
	epoch: number;
	lifecycle: "successor-pending-adoption";
	ok: true;
	successorAnchorDigest: string;
	successorEpoch: number;
	successorTrustRef: GenerationRef;
}>;

export interface CreatorLiveCloseHandle {
	close(): Promise<CreatorLiveCloseResult>;
	inspectDurableHead(): Promise<
		Readonly<{ head: PresentHead; references: readonly GenerationRef[]; trustRef: GenerationRef }>
	>;
	status(): CreatorLiveCloseStatus;
	stop(): Promise<void>;
}

export interface BindCreatorLiveCloseInput {
	readonly evidenceStore: unknown;
	readonly exactCanonicalAvailabilityPolicyBytes: Uint8Array;
	onObservation(event: Readonly<Record<string, unknown>>): void;
	readonly plane: V3PlaneHandle;
	readonly signer: FinalitySigner;
	readonly snapshotStore: SnapshotQuarantineStore<SnapshotVerificationReceipt>;
	readonly storageIncarnation: string;
	readonly voteStore: SealStorePort;
}

interface CreatorActor {
	close(input: Readonly<{ closeInput: Readonly<Record<string, unknown>> }>): Promise<Readonly<Record<string, unknown>>>;
	status(): Readonly<{ readonly phase: string; readonly terminal: boolean }>;
	stop(): Promise<void>;
}

interface V3CreatorCloseRegistration {
	abortSnapshotStage(): boolean;
	readonly currentTrust: CurrentAnchorTrust;
	readonly exactCanonicalAnchorPreimageBytes: Uint8Array;
	readonly exactCanonicalLatchedAclBytes: Uint8Array;
	readonly exactCanonicalParametersBytes: Uint8Array;
	readonly exactCanonicalPinnedGenesisBootstrapOperationBytes?: Uint8Array;
	readonly issuanceScope: DurableIssueScope;
	readonly issuanceStore: DurableIssuanceStore;
	readonly liveJournalStore: DurableLiveJournalStore;
	readonly maxEpochBytes: number;
	readonly maxEpochVertices: number;
	readonly objectId: Parameters<AheDurableStore["recoverActiveGeneration"]>[0];
	readonly previousHistorySnapshot: AccumulatorSnapshot;
	readonly store: AheDurableStore;
	captureCloseGraph():
		| Readonly<{
				readonly authors: ReadonlyMap<string, Readonly<{ readonly author: string; readonly authorSequence: number }>>;
				readonly charges: ReadonlyMap<string, number>;
				readonly frontier: readonly string[];
				readonly vertices: ReadonlyMap<string, EpochVertex>;
		  }>
		| undefined;
	stageSnapshot(): Promise<
		Readonly<
			| {
					readonly applicationStateDigest: string;
					readonly exactCanonicalPayloadBytes: Uint8Array;
					readonly kind: "exported";
					readonly ok: true;
			  }
			| { readonly detail: string; readonly kind: string; readonly ok: false }
		>
	>;
	sealDurableReplay(): Promise<Readonly<{ verify(): Promise<boolean> }> | undefined>;
	terminalize(): boolean;
}

interface CreatorAdoptionFacts {
	readonly closeResult: CreatorLiveCloseResult;
	readonly currentHead: PresentHead;
	readonly currentReferences: readonly GenerationRef[];
	readonly currentTrust: CurrentAnchorTrust;
	readonly durableReplay: Readonly<{ verify(): Promise<boolean> }>;
	readonly exactCanonicalLatchedAclBytes: Uint8Array;
	readonly exactCanonicalParametersCarrierBytes: Uint8Array;
	readonly exactCanonicalPinnedGenesisBootstrapOperationBytes?: Uint8Array;
	readonly history: Awaited<ReturnType<typeof deriveCloseSetHistoryCommitment>>;
	readonly issuanceScope: DurableIssueScope;
	readonly issuanceStore: DurableIssuanceStore;
	readonly liveJournalStore: DurableLiveJournalStore;
	readonly objectId: Parameters<AheDurableStore["recoverActiveGeneration"]>[0];
	readonly proposedHead: PresentHead;
	readonly proposedReferences: readonly GenerationRef[];
	readonly snapshotDeclaration: SnapshotQuarantineDeclaration;
	readonly snapshotStore: SnapshotQuarantineStore<SnapshotVerificationReceipt>;
	readonly sourceRuntimeHandle: WeakRef<object>;
	readonly store: AheDurableStore;
	terminalizeSource(): boolean;
}

function claimCreatorCloseRegistration(plane: V3PlaneHandle): V3CreatorCloseRegistration | undefined {
	const registration = creatorCloseRegistrationResolver?.(plane);
	return plainRecord(registration) ? (registration as unknown as V3CreatorCloseRegistration) : undefined;
}

function verifiedCreatorTrustRecord(
	registration: V3CreatorCloseRegistration,
	exactCanonicalTrustStateRecordBytes: Uint8Array
): Readonly<Record<string, unknown>> | undefined {
	try {
		const record = decodeCanonical(exactCanonicalTrustStateRecordBytes);
		if (!plainRecord(record) || !(record.exactCanonicalSignerSetBytes instanceof Uint8Array)) return undefined;
		const signerSet = decodeCanonical(record.exactCanonicalSignerSetBytes);
		const profileId = typeof record.profileId === "string" ? record.profileId : "";
		return record.currentAnchorDigest === registration.currentTrust.currentAnchorDigest &&
			record.currentEpoch === registration.currentTrust.currentEpoch &&
			record.genesisAnchorDigest === registration.currentTrust.genesisAnchorDigest &&
			record.objectId === registration.currentTrust.objectId &&
			profileId === registration.currentTrust.profileId &&
			(profileId === "creator-trusted-v1" || settlementProfileFor(profileId) !== "none") &&
			record.quorum === 1 &&
			Array.isArray(signerSet) &&
			signerSet.length === 1
			? record
			: undefined;
	} catch {
		return undefined;
	}
}

function copiedRef(ref: GenerationRef): GenerationRef {
	return Object.freeze({ byteLength: ref.byteLength, digest: ref.digest });
}

function compareRef(left: GenerationRef, right: GenerationRef): number {
	return left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0;
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function successfulValue<T>(value: unknown): T | undefined {
	if (!plainRecord(value) || value.ok !== true || !Object.hasOwn(value, "value")) return undefined;
	return value.value as T;
}

function successfulUndefined(value: unknown): boolean {
	return plainRecord(value) && value.ok === true && Object.hasOwn(value, "value") && value.value === undefined;
}

function refFor(bytes: Uint8Array): GenerationRef {
	const digest = digestBlob(bytes);
	if (!digest.ok) throw new TypeError("creator close blob digest failed");
	return Object.freeze({ byteLength: bytes.byteLength, digest: digest.value });
}

function sameRef(left: GenerationRef, right: GenerationRef): boolean {
	return left.byteLength === right.byteLength && left.digest === right.digest;
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type InspectedHead = Awaited<ReturnType<typeof inspectHead>>;

function uniqueRecordCandidate(
	candidates: InspectedHead["candidates"],
	kind: string,
	epoch?: number,
	phase?: string
): InspectedHead["candidates"][number] | undefined {
	const matches = candidates.filter((candidate) => {
		try {
			const value = decodeCanonical(candidate.bytes);
			const selectedEpoch =
				plainRecord(value) &&
				(value.kind === "drp-anchor-trust-state"
					? value.currentEpoch
					: value.kind === CREATOR_ISSUANCE_RETIREMENT_KIND || value.kind === CREATOR_AUTHOR_ISSUANCE_FRONTIERS_KIND
						? value.closedEpoch
						: value.epoch);
			return (
				plainRecord(value) &&
				value.kind === kind &&
				(epoch === undefined || selectedEpoch === epoch) &&
				(phase === undefined || value.phase === phase)
			);
		} catch {
			return false;
		}
	});
	return matches.length === 1 ? matches[0] : undefined;
}

async function issuanceRetirementCandidate(
	input: Readonly<{
		current: InspectedHead;
		currentTrust: CurrentAnchorTrust;
		cutValueDigest: string;
		durableReplay: Readonly<{ verify(): Promise<boolean> }>;
		graph: Exclude<ReturnType<V3CreatorCloseRegistration["captureCloseGraph"]>, undefined>;
		issuanceScope: DurableIssueScope;
		issuanceStore: DurableIssuanceStore;
		maxEpochVertices: number;
		qcRef: GenerationRef;
		signer: FinalitySigner;
		snapshotManifestDigest: string;
		successorTrust: CurrentAnchorTrust;
	}>
): Promise<
	Readonly<{
		admittedAuthorSequence: number;
		author: string;
		bytes: Uint8Array;
		priorRef?: GenerationRef;
		ref: GenerationRef;
	}>
> {
	if (!(await input.durableReplay.verify())) throw new TypeError(CREATOR_ISSUANCE_RETIREMENT_UNAVAILABLE);
	let priorAdmittedAuthorSequence: number | null = null;
	let priorRetirementCandidateDigest = CREATOR_ISSUANCE_RETIREMENT_GENESIS_SENTINEL;
	let priorRef: GenerationRef | undefined;
	if (input.currentTrust.currentEpoch > 0) {
		const candidate = uniqueRecordCandidate(input.current.candidates, CREATOR_ISSUANCE_RETIREMENT_KIND);
		const cut = uniqueRecordCandidate(
			input.current.candidates,
			"drp-hard-epoch-cut",
			input.currentTrust.currentEpoch - 1
		);
		const qc = uniqueRecordCandidate(
			input.current.candidates,
			"drp-seal-qc",
			input.currentTrust.currentEpoch - 1,
			"commit"
		);
		if (candidate === undefined || cut === undefined || qc === undefined) {
			throw new TypeError(CREATOR_ISSUANCE_RETIREMENT_UNAVAILABLE);
		}
		const cutRecord = decodeCanonical(cut.bytes);
		if (!plainRecord(cutRecord) || typeof cutRecord.snapshotManifestDigest !== "string") {
			throw new TypeError(CREATOR_ISSUANCE_RETIREMENT_UNAVAILABLE);
		}
		const opened = openCreatorIssuanceRetirement({
			exactCanonicalRecordBytes: candidate.bytes,
			expectedCommitQcRef: qc.ref,
			expectedCutValueDigest: hex(hashDomain("ts-drp/hard-epoch-cut/v3", cut.bytes)),
			expectedSnapshotManifestDigest: cutRecord.snapshotManifestDigest,
			floorTrust: input.currentTrust,
		});
		const identity = opened.ok ? resolveCreatorIssuanceRetirement(opened.capability) : undefined;
		if (identity === undefined || identity.author !== input.issuanceScope.author) {
			throw new TypeError(CREATOR_ISSUANCE_RETIREMENT_UNAVAILABLE);
		}
		priorAdmittedAuthorSequence = identity.admittedAuthorSequence;
		priorRetirementCandidateDigest = candidate.ref.digest;
		priorRef = candidate.ref;
	}
	const boundary = await deriveCreatorIssuanceRetirementBoundary({
		currentAnchorDigest: input.currentTrust.currentAnchorDigest,
		currentEpoch: input.currentTrust.currentEpoch,
		graphVertexDigests: input.graph.vertices,
		issuanceScope: input.issuanceScope,
		issuanceStore: input.issuanceStore,
		maxEpochVertices: input.maxEpochVertices,
		priorAdmittedAuthorSequence,
	});
	const prepared = prepareCreatorIssuanceRetirement({
		admittedAuthorSequence: boundary.admittedAuthorSequence,
		author: input.issuanceScope.author,
		commitQcRef: input.qcRef,
		currentTrust: input.currentTrust,
		cutValueDigest: input.cutValueDigest,
		observedLineage: boundary.observedLineage,
		priorAdmittedAuthorSequence,
		priorRetirementCandidateDigest,
		snapshotManifestDigest: input.snapshotManifestDigest,
		successorTrust: input.successorTrust,
	});
	if (!prepared.ok) throw new TypeError(CREATOR_ISSUANCE_RETIREMENT_UNAVAILABLE);
	const signature = await signCreatorIssuanceRetirementRequest({
		request: prepared.signingRequest,
		signer: input.signer,
	});
	const completed = completeCreatorIssuanceRetirement({
		detachedSignature: signature,
		preparation: prepared.preparation,
	});
	if (!completed.ok) throw new TypeError(CREATOR_ISSUANCE_RETIREMENT_UNAVAILABLE);
	const ref = refFor(completed.exactCanonicalRecordBytes);
	return Object.freeze({
		admittedAuthorSequence: boundary.admittedAuthorSequence,
		author: input.issuanceScope.author,
		bytes: Uint8Array.from(completed.exactCanonicalRecordBytes),
		...(priorRef === undefined ? {} : { priorRef: copiedRef(priorRef) }),
		ref,
	});
}

function openedLatchedAcl(
	exactCanonicalLatchedAclBytes: Uint8Array,
	trust: CurrentAnchorTrust,
	expectedAclDigest: string
): LatchedAclSnapshot | undefined {
	const opened = openCanonicalLatchedAclSnapshot({
		exactCanonicalLatchedAclBytes,
		expectedAclDigest,
		expectedEpoch: trust.currentEpoch,
		expectedObjectId: trust.objectId,
	});
	return opened.ok ? opened.snapshot : undefined;
}

function writeAuthorizedAuthors(snapshot: LatchedAclSnapshot): readonly string[] | undefined {
	const selected: string[] = [];
	for (const member of snapshot.members) {
		const authorized = authorizeLatchedApplicationWrite({ author: member.author, snapshot });
		if (!authorized.ok) return undefined;
		if (authorized.authorized) selected.push(member.author);
	}
	return Object.freeze(selected.sort());
}

function candidateAclDigest(candidate: Readonly<{ readonly bytes: Uint8Array }>): string {
	return hex(hashDomain("ts-drp/latched-acl/v3", candidate.bytes));
}

async function authorIssuanceFrontiersCandidate(
	input: Readonly<{
		current: InspectedHead;
		currentAclDigest: string;
		currentExactAclBytes: Uint8Array;
		currentTrust: CurrentAnchorTrust;
		cutValueDigest: string;
		graph: Exclude<ReturnType<V3CreatorCloseRegistration["captureCloseGraph"]>, undefined>;
		issuanceScope: DurableIssueScope;
		issuanceStore: DurableIssuanceStore;
		legacy: Awaited<ReturnType<typeof issuanceRetirementCandidate>>;
		qcRef: GenerationRef;
		signer: FinalitySigner;
		snapshotManifestDigest: string;
		successorAclDigest: string;
		successorExactAclBytes: Uint8Array;
		successorTrust: CurrentAnchorTrust;
	}>
): Promise<Readonly<{ bytes: Uint8Array; priorRef?: GenerationRef; ref: GenerationRef }>> {
	const currentAcl = openedLatchedAcl(input.currentExactAclBytes, input.currentTrust, input.currentAclDigest);
	const successorAcl = openedLatchedAcl(input.successorExactAclBytes, input.successorTrust, input.successorAclDigest);
	const successorAuthors = successorAcl === undefined ? undefined : writeAuthorizedAuthors(successorAcl);
	if (currentAcl === undefined || successorAcl === undefined || successorAuthors === undefined) {
		throw new TypeError("creator issuance-frontier ACL authority is unavailable");
	}

	const aggregateCandidates = input.current.candidates.filter((candidate) => {
		try {
			return (
				(decodeCanonical(candidate.bytes) as Readonly<Record<string, unknown>>)?.kind ===
				CREATOR_AUTHOR_ISSUANCE_FRONTIERS_KIND
			);
		} catch {
			return false;
		}
	});
	if (aggregateCandidates.length > 1 || (input.currentTrust.currentEpoch === 0 && aggregateCandidates.length !== 0)) {
		throw new TypeError("creator issuance-frontier candidate is ambiguous");
	}
	let priorIdentity: ReturnType<typeof resolveCreatorAuthorIssuanceFrontiers>;
	let priorRef: GenerationRef | undefined;
	if (aggregateCandidates.length === 1) {
		const candidate = aggregateCandidates[0] as (typeof aggregateCandidates)[number];
		const closedEpoch = input.currentTrust.currentEpoch - 1;
		const cut = uniqueRecordCandidate(input.current.candidates, "drp-hard-epoch-cut", closedEpoch);
		const qc = uniqueRecordCandidate(input.current.candidates, "drp-seal-qc", closedEpoch, "commit");
		const acl = uniqueRecordCandidate(input.current.candidates, "drp-v3-latched-acl", closedEpoch);
		const cutRecord = cut === undefined ? undefined : decodeCanonical(cut.bytes);
		if (cut === undefined || qc === undefined || acl === undefined || !plainRecord(cutRecord)) {
			throw new TypeError("creator issuance-frontier predecessor proof is unavailable");
		}
		const opened = openCreatorAuthorIssuanceFrontiers({
			exactCanonicalRecordBytes: candidate.bytes,
			expectedCommitQcRef: qc.ref,
			expectedCurrentAclDigest: candidateAclDigest(acl),
			expectedCutValueDigest: hex(hashDomain("ts-drp/hard-epoch-cut/v3", cut.bytes)),
			expectedSnapshotManifestDigest: cutRecord.snapshotManifestDigest,
			expectedSuccessorAclDigest: input.currentAclDigest,
			floorTrust: input.currentTrust,
		});
		priorIdentity = opened.ok ? resolveCreatorAuthorIssuanceFrontiers(opened.capability) : undefined;
		if (priorIdentity === undefined) {
			throw new TypeError("creator issuance-frontier predecessor proof is invalid");
		}
		priorRef = candidate.ref;
	}

	const byAuthor = new Map<string, number[]>();
	const duplicateAuthors = new Set<string>();
	for (const identity of input.graph.authors.values()) {
		const sequences = byAuthor.get(identity.author) ?? [];
		if (sequences.includes(identity.authorSequence)) {
			if (identity.author === input.issuanceScope.author) {
				throw new TypeError("creator issuance-frontier author slot is ambiguous");
			}
			duplicateAuthors.add(identity.author);
			continue;
		}
		sequences.push(identity.authorSequence);
		byAuthor.set(identity.author, sequences);
	}
	for (const sequences of byAuthor.values()) sequences.sort((left, right) => left - right);

	const prior = new Map(priorIdentity?.frontiers ?? []);
	let localNext: number | undefined;
	if (successorAuthors.includes(input.issuanceScope.author)) {
		const lineage = await input.issuanceStore.readLineage(input.issuanceScope);
		if (lineage.exhausted !== false || !Number.isSafeInteger(lineage.next) || lineage.next < 0) {
			throw new TypeError("creator issuance-frontier local lineage is invalid");
		}
		localNext = lineage.next;
	}
	const frontiers: CreatorAuthorIssuanceFrontier[] = [];
	for (const author of successorAuthors) {
		const priorBoundary = prior.get(author);
		const sequences = byAuthor.get(author) ?? [];
		if (priorIdentity === undefined && author === input.legacy.author) {
			frontiers.push(Object.freeze([author, input.legacy.admittedAuthorSequence] as const));
			continue;
		}
		if (priorBoundary === undefined) {
			const observedNext = author === input.issuanceScope.author ? localNext : undefined;
			if ((sequences[0] ?? observedNext ?? 0) > 1) {
				throw new TypeError(
					priorIdentity === undefined ? LEGACY_MULTI_AUTHOR_MIGRATION_REQUIRED : AUTHOR_REENTRY_PROOF_REQUIRED
				);
			}
		}
		let boundary = priorBoundary ?? null;
		const firstObserved = sequences[0];
		if (duplicateAuthors.has(author)) {
			frontiers.push(Object.freeze([author, boundary] as const));
			continue;
		}
		if (boundary === null && firstObserved !== undefined && firstObserved > 1) {
			if (author === input.issuanceScope.author) {
				throw new TypeError(LEGACY_MULTI_AUTHOR_MIGRATION_REQUIRED);
			}
			frontiers.push(Object.freeze([author, boundary] as const));
			continue;
		}
		const minimum = boundary === null && firstObserved === 1 ? 1 : boundary === null ? 0 : boundary + 1;
		if (sequences.some((sequence) => boundary !== null && sequence <= boundary)) {
			if (author === input.issuanceScope.author) {
				throw new TypeError("creator issuance-frontier boundary regressed");
			}
			frontiers.push(Object.freeze([author, boundary] as const));
			continue;
		}
		let expected = minimum;
		for (const sequence of sequences) {
			if (sequence !== expected) break;
			boundary = sequence;
			expected += 1;
		}
		frontiers.push(Object.freeze([author, boundary] as const));
	}

	const prepared = prepareCreatorAuthorIssuanceFrontiers({
		commitQcRef: input.qcRef,
		currentAclDigest: input.currentAclDigest,
		currentTrust: input.currentTrust,
		cutValueDigest: input.cutValueDigest,
		frontiers,
		priorAggregateCandidateDigest: priorRef?.digest ?? CREATOR_AUTHOR_ISSUANCE_FRONTIERS_GENESIS_SENTINEL,
		snapshotManifestDigest: input.snapshotManifestDigest,
		successorAclDigest: input.successorAclDigest,
		successorTrust: input.successorTrust,
	});
	if (!prepared.ok) throw new TypeError("creator issuance-frontier preparation failed");
	const signature = await signCreatorIssuanceRetirementRequest({
		request: prepared.signingRequest,
		signer: input.signer,
	});
	const completed = completeCreatorAuthorIssuanceFrontiers({
		detachedSignature: signature,
		preparation: prepared.preparation,
	});
	if (!completed.ok) throw new TypeError("creator issuance-frontier completion failed");
	const ref = refFor(completed.exactCanonicalRecordBytes);
	return Object.freeze({
		bytes: Uint8Array.from(completed.exactCanonicalRecordBytes),
		...(priorRef === undefined ? {} : { priorRef: copiedRef(priorRef) }),
		ref,
	});
}

function sameHead(left: PresentHead, right: PresentHead): boolean {
	return (
		left.closureDigest === right.closureDigest &&
		left.generationId === right.generationId &&
		left.objectId === right.objectId &&
		left.revision === right.revision
	);
}

function generationId(): GenerationId {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const parsed = parseGenerationId(Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""));
	if (!parsed.ok) throw new TypeError("creator close generation identity failed");
	return parsed.value;
}

async function inspectHead(
	store: AheDurableStore,
	objectId: Parameters<AheDurableStore["recoverActiveGeneration"]>[0]
): Promise<
	Readonly<{
		candidates: readonly Readonly<{ bytes: Uint8Array; ref: GenerationRef }>[];
		head: PresentHead;
		references: readonly GenerationRef[];
		trustRef: GenerationRef;
	}>
> {
	const recovered = successfulValue<Readonly<Record<string, unknown>>>(await store.recoverActiveGeneration(objectId));
	if (recovered?.kind !== "active" || !plainRecord(recovered.head) || !Array.isArray(recovered.references)) {
		throw new TypeError("creator close active generation is unavailable");
	}
	const references = Object.freeze((recovered.references as GenerationRef[]).map(copiedRef));
	const candidates: Array<Readonly<{ bytes: Uint8Array; ref: GenerationRef }>> = [];
	for (const ref of references) {
		if (ref.byteLength > SCANNABLE_BYTES) continue;
		const bytes = successfulValue<Uint8Array | null>(await store.getBlob(ref.digest));
		if (!(bytes instanceof Uint8Array)) throw new TypeError("creator close generation blob is unavailable");
		candidates.push(Object.freeze({ bytes: Uint8Array.from(bytes), ref }));
	}
	const inspected = inspectTrustClosure({ candidates, closure: references });
	if (!inspected.ok) throw new TypeError(`creator close trust scan failed: ${inspected.reason}`);
	return Object.freeze({
		candidates: Object.freeze(candidates),
		head: Object.freeze({ ...(recovered.head as PresentHead) }),
		references,
		trustRef: copiedRef(inspected.trustRef),
	});
}

async function persistSnapshot(
	store: SnapshotQuarantineStore<SnapshotVerificationReceipt>,
	input: Readonly<{
		aclDigest: string;
		anchor: string;
		epoch: number;
		exactCanonicalPayloadBytes: Uint8Array;
		objectId: string;
		stateDigest: string;
	}>
): Promise<
	Readonly<{
		declaration: SnapshotQuarantineDeclaration;
		exactCanonicalManifestBytes: Uint8Array;
		manifestDigest: string;
	}>
> {
	const encoded = encodeSnapshotTransfer({ ...input, profile: PROFILE, schemaVersion: 1 });
	const decoded = decodeSnapshotManifest({
		exactCanonicalManifestBytes: encoded.exactCanonicalManifestBytes,
		expectedManifestDigest: encoded.manifestDigest,
		profile: PROFILE,
	});
	const scopeKey = Object.freeze({
		anchor: input.anchor,
		epoch: input.epoch,
		manifestDigest: encoded.manifestDigest,
		objectId: input.objectId,
	});
	const scope = await store.openScope({
		chunks: decoded.chunks,
		exactCanonicalManifestBytes: encoded.exactCanonicalManifestBytes,
		scope: scopeKey,
		totalBytes: decoded.chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
	});
	try {
		const verified = verifySnapshotStreamWithReceipt({
			exactCanonicalManifestBytes: encoded.exactCanonicalManifestBytes,
			expectedManifestDigest: encoded.manifestDigest,
			expectedScope: scopeKey,
			profile: PROFILE,
			quarantine: scope.verificationQuarantine,
			source: Object.freeze({
				read: (descriptor: Readonly<{ readonly index: number }>) =>
					Promise.resolve(
						encoded.chunks[descriptor.index] === undefined ? undefined : encoded.chunks[descriptor.index]
					),
			}),
		});
		await verified.completion;
		await scope.complete(await verified.receipt);
		return Object.freeze({
			declaration: Object.freeze({
				chunks: Object.freeze(decoded.chunks.map((chunk) => Object.freeze({ ...chunk }))),
				exactCanonicalManifestBytes: Uint8Array.from(encoded.exactCanonicalManifestBytes),
				scope: scopeKey,
				totalBytes: decoded.chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
			}),
			exactCanonicalManifestBytes: Uint8Array.from(encoded.exactCanonicalManifestBytes),
			manifestDigest: encoded.manifestDigest,
		});
	} finally {
		await scope.release();
	}
}

async function stageCombinedGeneration(
	store: AheDurableStore,
	current: Awaited<ReturnType<typeof inspectHead>>,
	newBlobs: readonly Readonly<{ bytes: Uint8Array; ref: GenerationRef }>[],
	proposed: readonly GenerationRef[]
): Promise<PresentHead> {
	const selectedGenerationId = generationId();
	const closureDigest = digestClosure(proposed);
	if (!closureDigest.ok) throw new TypeError("creator close closure digest failed");
	const begun = successfulValue<Readonly<{ readonly closureDigest: string }>>(
		await store.beginGeneration({
			baseExpectedHead: current.head,
			closure: proposed,
			generationId: selectedGenerationId,
			objectId: current.head.objectId,
		})
	);
	if (begun?.closureDigest !== closureDigest.value) throw new TypeError("creator close generation staging failed");
	for (const blob of newBlobs) {
		const cached = successfulValue<Readonly<{ readonly inserted: boolean }>>(
			await store.putCachedBlob({
				bytes: blob.bytes,
				digest: blob.ref.digest,
				generationId: selectedGenerationId,
				objectId: current.head.objectId,
			})
		);
		if (cached === undefined) throw new TypeError("creator close blob staging failed");
	}
	for (const ref of proposed) {
		const promoted = await store.promoteReference({
			digest: ref.digest,
			generationId: selectedGenerationId,
			objectId: current.head.objectId,
		});
		if (!successfulUndefined(promoted)) throw new TypeError("creator close reference promotion failed");
	}
	const completed = successfulValue<Readonly<{ readonly closureDigest: string }>>(
		await store.completeGeneration({ generationId: selectedGenerationId, objectId: current.head.objectId })
	);
	if (completed?.closureDigest !== closureDigest.value)
		throw new TypeError("creator close generation completion failed");
	let swapped: PresentHead | undefined;
	try {
		const result = successfulValue<Readonly<{ readonly head: PresentHead }>>(
			await store.swapHead({
				expectedHead: current.head,
				generationId: selectedGenerationId,
				objectId: current.head.objectId,
			})
		);
		swapped = result?.head;
	} catch {
		// Reopen below decides whether an ambiguous write committed.
	}
	const reopened = await inspectHead(store, current.head.objectId);
	const expected = Object.freeze({
		closureDigest: closureDigest.value,
		generationId: selectedGenerationId,
		kind: "present" as const,
		objectId: current.head.objectId,
		revision: current.head.revision + 1,
	}) as PresentHead;
	if (!sameHead(reopened.head, expected) || (swapped !== undefined && !sameHead(swapped, expected))) {
		throw new TypeError("creator close head swap lost or remained ambiguous");
	}
	return reopened.head;
}

/**
 * Binds one creator-only close authority to a genuine active v3 plane.
 * @param input - Opaque signer, durable actor stores, quarantine and receiver-bound plane.
 * @returns The sole live close handle or a closed authority failure.
 */
export async function bindCreatorLiveClose(
	input: BindCreatorLiveCloseInput
): Promise<Readonly<{ handle: CreatorLiveCloseHandle; ok: true } | { ok: false; reason: string }>> {
	try {
		const existing = bindings.get(input.plane);
		if (existing !== undefined) return Object.freeze({ handle: existing, ok: true as const });
		const registration = claimCreatorCloseRegistration(input.plane);
		if (registration === undefined) return Object.freeze({ ok: false as const, reason: "CREATOR_CLOSE_UNAVAILABLE" });
		const epoch = registration.currentTrust.currentEpoch;
		if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch === Number.MAX_SAFE_INTEGER) {
			return Object.freeze({ ok: false as const, reason: "CREATOR_CLOSE_UNAVAILABLE" });
		}
		const successorEpoch = epoch + 1;
		const boundHead = await inspectHead(registration.store, registration.objectId);
		const boundTrustCandidate = boundHead.candidates.find(({ ref }) => sameRef(ref, boundHead.trustRef));
		if (
			boundTrustCandidate === undefined ||
			verifiedCreatorTrustRecord(registration, boundTrustCandidate.bytes) === undefined
		) {
			return Object.freeze({ ok: false as const, reason: "CREATOR_TRUST_UNAVAILABLE" });
		}
		const opened = await createCreatorSealActor({
			currentTrust: registration.currentTrust,
			evidenceStore: input.evidenceStore,
			onObservation: input.onObservation,
			signer: input.signer,
			storageIncarnation: input.storageIncarnation,
			voteStore: input.voteStore,
		});
		if (!opened.ok) return Object.freeze({ ok: false as const, reason: opened.reason });
		if (opened.actor.status().terminal) {
			await opened.actor.stop();
			return Object.freeze({ ok: false as const, reason: "CREATOR_CONTINUITY_TERMINAL" });
		}
		const actor = opened.actor as CreatorActor;
		let lifecycle: CreatorLiveCloseStatus["lifecycle"] = "active";
		let closeTask: Promise<CreatorLiveCloseResult> | undefined;
		let stagedSnapshot:
			| Extract<Awaited<ReturnType<V3CreatorCloseRegistration["stageSnapshot"]>>, { readonly ok: true }>
			| undefined;
		let capturedGraph: Exclude<ReturnType<V3CreatorCloseRegistration["captureCloseGraph"]>, undefined> | undefined;
		let persistedSnapshot: Awaited<ReturnType<typeof persistSnapshot>> | undefined;
		let derivedCommitment: Awaited<ReturnType<typeof deriveCloseSetHistoryCommitment>> | undefined;
		let durableReplay: Readonly<{ verify(): Promise<boolean> }> | undefined;
		const trust = Object.freeze({
			byzantineFaultTolerant: false as const,
			kind: "creator-certified" as const,
			quorum: 1 as const,
			signerCount: 1 as const,
			text: "Creator-certified; one of one; not Byzantine-fault-tolerant." as const,
		});
		const handle: CreatorLiveCloseHandle = Object.freeze({
			close: (): Promise<CreatorLiveCloseResult> => {
				if (
					closeTask !== undefined ||
					lifecycle === "successor-pending-adoption" ||
					lifecycle === "successor-adopted" ||
					actor.status().terminal
				) {
					return Promise.reject(new TypeError("creator close authority is unavailable"));
				}
				closeTask = (async (): Promise<CreatorLiveCloseResult> => {
					if (stagedSnapshot === undefined) {
						const snapshot = await registration.stageSnapshot();
						if (!snapshot.ok) {
							registration.abortSnapshotStage();
							throw new TypeError(`creator snapshot export failed: ${snapshot.kind}`);
						}
						stagedSnapshot = snapshot;
					}
					lifecycle = "sealed";
					capturedGraph ??= registration.captureCloseGraph();
					if (capturedGraph === undefined) throw new TypeError("creator close graph capture failed");
					const snapshot = stagedSnapshot;
					const graph = capturedGraph;
					const payload = decodeCanonical(snapshot.exactCanonicalPayloadBytes);
					const anchor = decodeCanonical(registration.exactCanonicalAnchorPreimageBytes);
					if (!plainRecord(payload) || !plainRecord(anchor))
						throw new TypeError("creator close snapshot identity failed");
					const acl = payload.acl;
					const stateDigest = snapshot.applicationStateDigest;
					const archiveIndexRoot = anchor.archiveIndexRoot;
					if (
						acl === undefined ||
						typeof stateDigest !== "string" ||
						typeof archiveIndexRoot !== "string" ||
						typeof anchor.aclDigest !== "string"
					) {
						throw new TypeError("creator close snapshot identity failed");
					}
					const aclDigest = hex(hashDomain("ts-drp/latched-acl/v3", encodeCanonical(acl)));
					persistedSnapshot ??= await persistSnapshot(input.snapshotStore, {
						aclDigest,
						anchor: registration.currentTrust.currentAnchorDigest,
						epoch: registration.currentTrust.currentEpoch,
						exactCanonicalPayloadBytes: snapshot.exactCanonicalPayloadBytes,
						objectId: registration.objectId,
						stateDigest,
					});
					derivedCommitment ??= await deriveCloseSetHistoryCommitment({
						authenticatedCanonicalPreimageByteLengths: graph.charges,
						exactCanonicalEpochAnchorPreimageBytes: registration.exactCanonicalAnchorPreimageBytes,
						frontier: graph.frontier,
						maxEpochBytes: registration.maxEpochBytes,
						maxEpochVertices: registration.maxEpochVertices,
						previousHistorySnapshot: registration.previousHistorySnapshot,
						vertices: graph.vertices,
					});
					const commitment = derivedCommitment;
					durableReplay ??= await registration.sealDurableReplay();
					if (durableReplay === undefined) throw new TypeError("creator close durable replay seal failed");
					const current = await inspectHead(registration.store, registration.objectId);
					const currentTrustCandidate = current.candidates.find(({ ref }) => sameRef(ref, current.trustRef));
					if (currentTrustCandidate === undefined) throw new TypeError("creator current trust bytes are unavailable");
					const decodedTrust = verifiedCreatorTrustRecord(registration, currentTrustCandidate.bytes);
					if (decodedTrust === undefined || !(decodedTrust.exactCanonicalSignerSetBytes instanceof Uint8Array)) {
						throw new TypeError("creator signer set is unavailable");
					}
					const closeInput = Object.freeze({
						aclDigest,
						archiveIndexRoot,
						blueprintDigest: anchor.blueprintDigest,
						closeReason: "creator-requested",
						closeSetCount: commitment.closeSetCount,
						closeSetRoot: commitment.closeSetRoot,
						currentTrust: registration.currentTrust,
						exactCanonicalAvailabilityPolicyBytes: Uint8Array.from(input.exactCanonicalAvailabilityPolicyBytes),
						exactCanonicalNextSignerSetBytes: Uint8Array.from(decodedTrust.exactCanonicalSignerSetBytes),
						exactCanonicalParametersBytes: Uint8Array.from(registration.exactCanonicalParametersBytes),
						exactCanonicalSnapshotManifestBytes: persistedSnapshot.exactCanonicalManifestBytes,
						historyRoot: commitment.historyRoot,
						historySize: commitment.historySize,
						snapshotManifestDigest: persistedSnapshot.manifestDigest,
						stateDigest,
					});
					const prepared = prepareCreatorClose(closeInput);
					if (!prepared.ok) throw new TypeError(`creator close preparation failed: ${prepared.reason}`);
					const finalized = await actor.close({ closeInput });
					if (
						finalized.ok !== true ||
						!(finalized.exactCanonicalCommitQcBytes instanceof Uint8Array) ||
						!(finalized.exactCanonicalTrustStateRecordBytes instanceof Uint8Array)
					)
						throw new TypeError(`creator close actor failed: ${String(finalized.reason)}`);
					const successor = openCreatorSuccessorTrust({
						currentTrust: registration.currentTrust,
						exactCanonicalCommitQcBytes: finalized.exactCanonicalCommitQcBytes,
						exactCanonicalCutValueBytes: prepared.exactCanonicalCutValueBytes,
						exactCanonicalTrustStateRecordBytes: finalized.exactCanonicalTrustStateRecordBytes,
					});
					if (!successor.ok) throw new TypeError(`creator successor reopen failed: ${successor.reason}`);
					if (
						successor.trust.currentEpoch !== successorEpoch ||
						successor.trust.objectId !== registration.currentTrust.objectId ||
						successor.trust.genesisAnchorDigest !== registration.currentTrust.genesisAnchorDigest
					) {
						throw new TypeError("creator successor epoch identity failed");
					}
					const successorTrustRef = refFor(finalized.exactCanonicalTrustStateRecordBytes);
					const cutValueRef = refFor(prepared.exactCanonicalCutValueBytes);
					const commitQcRef = refFor(finalized.exactCanonicalCommitQcBytes);
					const retirement = await issuanceRetirementCandidate({
						current,
						currentTrust: registration.currentTrust,
						cutValueDigest: prepared.valueDigest,
						durableReplay,
						graph,
						issuanceScope: registration.issuanceScope,
						issuanceStore: registration.issuanceStore,
						maxEpochVertices: registration.maxEpochVertices,
						qcRef: commitQcRef,
						signer: input.signer,
						snapshotManifestDigest: persistedSnapshot.manifestDigest,
						successorTrust: successor.trust,
					});
					const aggregate = await authorIssuanceFrontiersCandidate({
						current,
						currentAclDigest: anchor.aclDigest,
						currentExactAclBytes: registration.exactCanonicalLatchedAclBytes,
						currentTrust: registration.currentTrust,
						cutValueDigest: prepared.valueDigest,
						graph,
						issuanceScope: registration.issuanceScope,
						issuanceStore: registration.issuanceStore,
						legacy: retirement,
						qcRef: commitQcRef,
						signer: input.signer,
						snapshotManifestDigest: persistedSnapshot.manifestDigest,
						successorAclDigest: aclDigest,
						successorExactAclBytes: encodeCanonical(acl),
						successorTrust: successor.trust,
					});
					const proposed = Object.freeze(
						[
							...current.references.filter(
								({ digest }) =>
									digest !== current.trustRef.digest &&
									digest !== retirement.priorRef?.digest &&
									digest !== aggregate.priorRef?.digest
							),
							successorTrustRef,
							cutValueRef,
							commitQcRef,
							retirement.ref,
							aggregate.ref,
						].sort(compareRef)
					);
					const proposedCandidates = [
						...current.candidates.filter(
							({ ref }) =>
								ref.digest !== current.trustRef.digest &&
								ref.digest !== retirement.priorRef?.digest &&
								ref.digest !== aggregate.priorRef?.digest
						),
						{ bytes: finalized.exactCanonicalTrustStateRecordBytes, ref: successorTrustRef },
						{ bytes: prepared.exactCanonicalCutValueBytes, ref: cutValueRef },
						{ bytes: finalized.exactCanonicalCommitQcBytes, ref: commitQcRef },
						{ bytes: retirement.bytes, ref: retirement.ref },
						{ bytes: aggregate.bytes, ref: aggregate.ref },
					].filter(({ ref }) => ref.byteLength <= SCANNABLE_BYTES);
					const advance = inspectCreatorTransitionAdvance({
						current: { candidates: current.candidates, closure: current.references },
						currentTrust: registration.currentTrust,
						mode: "stage",
						proofRefs: [cutValueRef, commitQcRef],
						proposed: { candidates: proposedCandidates, closure: proposed },
						successorTrust: successor.trust,
					});
					if (!advance.ok) throw new TypeError(`creator trust advance failed: ${advance.reason}`);
					const acceptedProposed = advance.proposed.closure;
					const proposedHead = await stageCombinedGeneration(
						registration.store,
						current,
						[
							{ bytes: finalized.exactCanonicalTrustStateRecordBytes, ref: successorTrustRef },
							{ bytes: prepared.exactCanonicalCutValueBytes, ref: cutValueRef },
							{ bytes: finalized.exactCanonicalCommitQcBytes, ref: commitQcRef },
							{ bytes: retirement.bytes, ref: retirement.ref },
							{ bytes: aggregate.bytes, ref: aggregate.ref },
						],
						acceptedProposed
					);
					if (!registration.terminalize()) throw new TypeError("creator close terminalization failed");
					lifecycle = "successor-pending-adoption";
					const result = Object.freeze({
						closedVertexCount: commitment.closeSetCount,
						commitQcRef: copiedRef(commitQcRef),
						currentTrustRef: copiedRef(current.trustRef),
						cutValueRef: copiedRef(cutValueRef),
						epoch,
						lifecycle: "successor-pending-adoption" as const,
						ok: true as const,
						successorAnchorDigest: successor.trust.currentAnchorDigest,
						successorEpoch,
						successorTrustRef: copiedRef(successorTrustRef),
					});
					if (
						!installCreatorAdoptionFacts(
							handle,
							Object.freeze({
								closeResult: result,
								currentHead: Object.freeze({ ...current.head }),
								currentReferences: Object.freeze(current.references.map(copiedRef)),
								currentTrust: registration.currentTrust,
								durableReplay,
								exactCanonicalLatchedAclBytes: Uint8Array.from(registration.exactCanonicalLatchedAclBytes),
								exactCanonicalParametersCarrierBytes: Uint8Array.from(registration.exactCanonicalParametersBytes),
								exactCanonicalPinnedGenesisBootstrapOperationBytes:
									registration.exactCanonicalPinnedGenesisBootstrapOperationBytes === undefined
										? undefined
										: Uint8Array.from(registration.exactCanonicalPinnedGenesisBootstrapOperationBytes),
								history: commitment,
								issuanceScope: Object.freeze({ ...registration.issuanceScope }),
								issuanceStore: registration.issuanceStore,
								liveJournalStore: registration.liveJournalStore,
								objectId: registration.objectId,
								proposedHead: Object.freeze({ ...proposedHead }),
								proposedReferences: Object.freeze(acceptedProposed.map(copiedRef)),
								snapshotDeclaration: persistedSnapshot.declaration,
								snapshotStore: input.snapshotStore,
								sourceRuntimeHandle: new WeakRef(input.plane),
								store: registration.store,
								terminalizeSource: (): boolean => {
									if (lifecycle !== "successor-pending-adoption") return false;
									lifecycle = "successor-adopted";
									revokeCreatorAdoptionFacts(handle);
									return true;
								},
							}) satisfies CreatorAdoptionFacts
						)
					) {
						throw new TypeError("creator adoption facts already exist");
					}
					return result;
				})().catch((error) => {
					closeTask = undefined;
					if (stagedSnapshot === undefined && registration.abortSnapshotStage()) lifecycle = "active";
					else lifecycle = "sealed";
					throw error;
				});
				return closeTask;
			},
			inspectDurableHead: async () => {
				const inspected = await inspectHead(registration.store, registration.objectId);
				return Object.freeze({
					head: inspected.head,
					references: inspected.references,
					trustRef: inspected.trustRef,
				});
			},
			status: (): CreatorLiveCloseStatus => {
				const actorStatus = actor.status();
				const continuity = actorStatus.terminal
					? ("stalled" as const)
					: lifecycle === "successor-pending-adoption" ||
						  lifecycle === "successor-adopted" ||
						  actorStatus.phase === "empty"
						? ("continuous" as const)
						: ("relearning" as const);
				return Object.freeze({
					closeAuthority:
						lifecycle === "successor-pending-adoption" || lifecycle === "successor-adopted" || actorStatus.terminal
							? ("unavailable" as const)
							: ("available" as const),
					continuity,
					lifecycle,
					trust,
				});
			},
			stop: () => actor.stop(),
		});
		runtimeReleaseOwners.set(input.plane, (): CreatorCloseRuntimeReleasePlan | undefined => {
			if (lifecycle !== "successor-adopted") return undefined;
			const before: CreatorCloseRuntimeReleaseCensus = Object.freeze({
				derivedCommitment: derivedCommitment !== undefined,
				durableReplay: durableReplay !== undefined,
				graph: capturedGraph !== undefined,
				persistedSnapshot: persistedSnapshot !== undefined,
				stagedSnapshot: stagedSnapshot !== undefined,
			});
			const after: CreatorCloseRuntimeReleaseCensus = Object.freeze({
				derivedCommitment: false,
				durableReplay: false,
				graph: false,
				persistedSnapshot: false,
				stagedSnapshot: false,
			});
			let used = false;
			return Object.freeze({
				after,
				before,
				release: (): boolean => {
					if (used) return true;
					if (lifecycle !== "successor-adopted") return false;
					used = true;
					capturedGraph = undefined;
					stagedSnapshot = undefined;
					persistedSnapshot = undefined;
					derivedCommitment = undefined;
					durableReplay = undefined;
					return true;
				},
			});
		});
		bindings.set(input.plane, handle);
		return Object.freeze({ handle, ok: true as const });
	} catch {
		return Object.freeze({ ok: false as const, reason: "CREATOR_CLOSE_BIND_FAILED" });
	}
}

if (
	!installCreatorCloseRuntimeRelease((plane): CreatorCloseRuntimeReleasePlan | undefined =>
		runtimeReleaseOwners.get(plane as V3PlaneHandle)?.()
	)
) {
	throw new TypeError("creator close runtime release owner was already installed");
}

Object.defineProperty(bindCreatorLiveClose, "installV3CreatorCloseRegistrationResolver", {
	configurable: false,
	enumerable: false,
	value: function installV3CreatorCloseRegistrationResolver(this: unknown, resolver: unknown): boolean {
		if (
			this !== bindCreatorLiveClose ||
			creatorCloseRegistrationResolver !== undefined ||
			typeof resolver !== "function"
		) {
			return false;
		}
		creatorCloseRegistrationResolver = (plane): unknown => Reflect.apply(resolver, undefined, [plane]) as unknown;
		return true;
	},
	writable: false,
});
