import type { TrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog";
import { compareBytes } from "@ts-drp/canonical";
import type { DurableLiveJournalStore, InstallLiveJournalGenesisInput } from "@ts-drp/live-journal";
import { type CurrentAnchorTrust, openCurrentAnchorTrust } from "@ts-drp/protocol-v3";
import { openCreatorCheckpointTrust } from "@ts-drp/protocol-v3/creator-checkpoint";
import {
	inspectCreatorClosedCutSuccessorBinding,
	inspectCreatorHistoricalAnchorEnvelope,
	openCreatorSuccessorTrust,
} from "@ts-drp/protocol-v3/creator-close";
import { resolveCreatorIssuanceRetirement } from "@ts-drp/protocol-v3/creator-issuance-retirement";
import { openCanonicalLatchedAclSnapshot } from "@ts-drp/protocol-v3/latched-acl";
import registry from "@ts-drp/protocol-v3/registry/registry-v1.json" with { type: "json" };
import { settlementProfileFor } from "@ts-drp/protocol-v3/settlement-profile";
import { decodeSnapshotManifest, snapshotChunkDigest } from "@ts-drp/protocol-v3/snapshot-transfer";
import {
	AHE_BOUNDED_READ_LIMITS,
	type AheBoundedActiveRead,
	type AheBoundedRecoveryRoleRead,
	type AheBoundedRecoveryRoleStore,
	type AheDurableStore,
	type GenerationRecord,
	type GenerationRef,
	parseStorageObjectId,
	type PresentHead,
	type StorageRejectionReason,
} from "@ts-drp/storage";
import {
	type SnapshotChunkDescriptor,
	snapshotQuarantineContract,
	type SnapshotQuarantineFailureCode,
	type SnapshotQuarantineScopeKey,
	type SnapshotRecoveryStore,
	type SnapshotVerificationReceipt,
} from "@ts-drp/storage/snapshot-transfer";

import {
	captureCreatorRoomFloor,
	captureCreatorRoomHeadState,
	type CreatorExpectedRoomHead,
	sameCreatorRoomHead,
} from "./creator-room-head.js";
import {
	canonicalCreatorDataRecord,
	creatorDataDigest,
	creatorSnapshotCatalogIdentity,
	creatorSnapshotProjectionAuthorityMatches,
	creatorSnapshotProjectionMatches,
	validateCreatorSnapshotData,
	verifiedCreatorSnapshotCatalog,
} from "./creator-snapshot-data.js";
import {
	type CreatorTransitionClosure,
	exactCreatorTransitionOccurrence,
	inspectCreatorAdoptionCandidateLineage,
	inspectCreatorTransitionAdvance,
	openCreatorTransitionClosedCutEvidence,
	uniqueCreatorTransitionCandidate,
} from "./creator-transition-advance.js";

export type VerifiedCreatorClosedRollbackData = Readonly<Record<never, never>>;
type VerifiedClosedAnchorDependency = Readonly<Record<never, never>>;
type ClosedAclAnchorRequirement = Readonly<Record<never, never>>;
export type CreatorClosedRollbackProofLedger = Readonly<Record<never, never>>;
export type VerifiedInstalledHistoricalAnchor = Readonly<Record<never, never>>;
export type CreatorClosedRollbackAnchorImportFailureKind =
	| "malformed-input"
	| "requirement-unavailable"
	| "authority-invalid"
	| "authority-stale"
	| "source-unavailable"
	| "source-invalid"
	| "destination-unavailable"
	| "destination-invalid"
	| "proof-budget-exceeded"
	| "install-outcome-unknown"
	| "aborted"
	| "release-failed"
	| "internal-invariant";
export type CreatorClosedRollbackAnchorImportInput = Readonly<{
	requirement: ClosedAclAnchorRequirement;
	sourceJournal: DurableLiveJournalStore;
	proofLedger: CreatorClosedRollbackProofLedger;
	signal?: AbortSignal;
}>;
type ImportFailure = Readonly<{
	ok: false;
	kind: CreatorClosedRollbackAnchorImportFailureKind;
	cause?: Readonly<{ owner: "ahe" | "floor" | "source-journal" | "destination-journal"; reason: string }>;
}>;
export type CreatorClosedRollbackAnchorImportResult =
	| Readonly<{ ok: true; material: VerifiedInstalledHistoricalAnchor }>
	| ImportFailure;

export interface CreatorRollbackFloorReader {
	read(input: Readonly<{ scope: Readonly<{ objectId: string; pinnedGenesisAnchorDigest: string }> }>): Promise<
		| Readonly<{ ok: false; reason: "conflict" | "unavailable" }>
		| Readonly<{
				ok: true;
				state: null | Readonly<{
					stable: CreatorExpectedRoomHead;
					pending: null | Readonly<{ previous: CreatorExpectedRoomHead; next: CreatorExpectedRoomHead }>;
				}>;
		  }>
	>;
}
export interface CreatorClosedRollbackDataInput {
	readonly objectId: string;
	readonly pinnedGenesisAnchorDigest: string;
	readonly exactCanonicalPinnedGenesisTrustStateRecordBytes: Uint8Array;
	readonly roomHeadAuthority: CreatorRollbackFloorReader;
	readonly catalog: TrustedBlueprintCatalog;
	readonly store: AheDurableStore;
	readonly snapshotStore: SnapshotRecoveryStore<SnapshotVerificationReceipt>;
	readonly liveJournalStore: DurableLiveJournalStore;
	readonly signal?: AbortSignal;
}
export type CreatorProtectedRecoveryRoleObservation = Readonly<Record<never, never>>;
export interface CreatorProtectedRecoveryRoleInput {
	readonly objectId: string;
	readonly pinnedGenesisAnchorDigest: string;
	readonly exactCanonicalPinnedGenesisTrustStateRecordBytes: Uint8Array;
	readonly roomHeadAuthority: CreatorRollbackFloorReader;
	readonly catalog: TrustedBlueprintCatalog;
	readonly store: AheBoundedRecoveryRoleStore;
	readonly snapshotStore: SnapshotRecoveryStore<SnapshotVerificationReceipt>;
	readonly signal?: AbortSignal;
}
export type CreatorProtectedRecoveryRoleFailureKind =
	| "malformed-input"
	| "floor-unavailable"
	| "floor-invalid"
	| "floor-stale"
	| "ahe-empty"
	| "ahe-rejected"
	| "ahe-stale"
	| "chain-invalid"
	| "role-missing"
	| "role-ambiguous"
	| "pending-policy-unavailable"
	| "inherited-scope-unclassified"
	| "snapshot-unavailable"
	| "snapshot-not-ready"
	| "snapshot-invalid"
	| "blueprint-invalid"
	| "proof-budget-exceeded"
	| "aborted"
	| "release-failed"
	| "internal-invariant";
export type CreatorProtectedRecoveryRoleDebt = Readonly<{
	owner: "floor" | "ahe" | "snapshot";
	role: "current" | "pending-adoption" | "unclassified";
	objectId: string;
	generationId?: string;
	snapshotScope?: SnapshotQuarantineScopeKey;
}>;
export type CreatorProtectedRecoveryRoleCause =
	| Readonly<{ owner: "ahe"; reason: StorageRejectionReason }>
	| Readonly<{ owner: "snapshot"; reason: SnapshotQuarantineFailureCode }>
	| Readonly<{ owner: "floor"; reason: "conflict" | "unavailable" }>
	| Readonly<{ owner: "role-policy"; reason: "RETIREMENT_ONLY_ADVANCE_UNAVAILABLE" }>;
export type CreatorProtectedRecoveryRoleResult =
	| Readonly<{ ok: true; observation: CreatorProtectedRecoveryRoleObservation }>
	| Readonly<{
			ok: false;
			kind: CreatorProtectedRecoveryRoleFailureKind;
			debt: CreatorProtectedRecoveryRoleDebt;
			cause?: CreatorProtectedRecoveryRoleCause;
	  }>;
export type CreatorProtectedRecoveryRoleIdentity = Readonly<{
	roomHead: CreatorExpectedRoomHead;
	profileId: string;
	generation: Readonly<GenerationRecord & { derivedHead: PresentHead }>;
	controls: readonly Readonly<{
		kind: "projection" | "trust" | "cut" | "commit-qc" | "retirement" | "aggregate" | "settlement" | "closed-acl";
		ref: GenerationRef;
	}>[];
	snapshot: null | Readonly<{
		scope: SnapshotQuarantineScopeKey;
		manifestByteLength: number;
		payloadDigest: string;
		stateDigest: string;
		closedAclDigest: string;
		successorAclDigest: string;
		totalBytes: number;
		chunks: readonly SnapshotChunkDescriptor[];
	}>;
}>;
export type CreatorProtectedRecoveryRoleSummary = Readonly<{
	floor: Readonly<{
		stable: CreatorExpectedRoomHead;
		pending: null | Readonly<{ previous: CreatorExpectedRoomHead; next: CreatorExpectedRoomHead }>;
	}>;
	head: PresentHead;
	current: CreatorProtectedRecoveryRoleIdentity;
	pending: null | Readonly<{
		role: CreatorProtectedRecoveryRoleIdentity;
		publication: "before-publication" | "already-published";
	}>;
	supportGenerations: readonly GenerationRecord[];
	heldGenerations: readonly GenerationRecord[];
	currency: "point-observed-no-incarnation";
}>;
export type CreatorClosedRollbackDataFailureKind =
	| "malformed-input"
	| "floor-unavailable"
	| "floor-invalid"
	| "floor-pending"
	| "floor-stale"
	| "ahe-empty"
	| "ahe-rejected"
	| "chain-invalid"
	| "snapshot-unavailable"
	| "snapshot-not-ready"
	| "snapshot-invalid"
	| "anchor-unavailable"
	| "anchor-invalid"
	| "proof-budget-exceeded"
	| "blueprint-invalid"
	| "aborted"
	| "release-failed"
	| "internal-invariant";
type Failure = Readonly<{
	ok: false;
	kind: CreatorClosedRollbackDataFailureKind;
	cause?: Readonly<{ owner: "ahe" | "snapshot" | "journal" | "floor"; reason: string }>;
}>;
export type CreatorClosedRollbackDataResult =
	| Readonly<{ ok: true; observation: VerifiedCreatorClosedRollbackData }>
	| Failure;

export interface CreatorClosedRollbackProofAccounting {
	readonly chargedBytes: number;
	charge(exactBytes: Uint8Array): boolean;
}
/**
 * Owns the fixed whole-proof U, borrowing actual reader bytes only for this operation.
 * @param initialBlobs - Complete verified distinct AHE union, including generic refs.
 * @returns One non-authority operation-local accounting owner.
 */
export function createCreatorClosedRollbackProofAccounting(
	initialBlobs: AheBoundedActiveRead["blobs"]
): CreatorClosedRollbackProofAccounting {
	const sequences = initialBlobs.map((blob) => blob.bytes);
	let chargedBytes = sequences.reduce((sum, bytes) => sum + bytes.byteLength, 0);
	return Object.freeze({
		get chargedBytes(): number {
			return chargedBytes;
		},
		charge(exactBytes: Uint8Array): boolean {
			if (sequences.some((bytes) => compareBytes(bytes, exactBytes) === 0)) return true;
			if (exactBytes.byteLength > AHE_BOUNDED_READ_LIMITS.maxUnionBytes - chargedBytes) return false;
			sequences.push(exactBytes);
			chargedBytes += exactBytes.byteLength;
			return true;
		},
	});
}

interface CutSummary {
	readonly objectId: string;
	readonly epoch: number;
	readonly closedAnchorDigest: string;
	readonly successorAnchorDigest: string;
	readonly cutRef: GenerationRef;
	readonly commitQcRef: GenerationRef;
	readonly manifestDigest: string;
	readonly payloadDigest: string;
	readonly stateDigest: string;
	readonly closedAclDigest: string;
	readonly successorAclDigest: string;
	readonly payloadByteLength: number;
	readonly representation: "settlement" | "aggregate-retirement" | "retirement-only";
}
interface Summary {
	readonly floor: CreatorExpectedRoomHead;
	readonly head: AheBoundedActiveRead["head"];
	readonly profileId: string;
	readonly cuts: readonly CutSummary[];
}
interface ObservationFacts {
	readonly summary: Summary;
	readonly owners: readonly object[];
	readonly dependencies: readonly VerifiedClosedAnchorDependency[];
}
const observations = new WeakMap<VerifiedCreatorClosedRollbackData, ObservationFacts>();

/**
 * Resolves only genuine private custody into detached immutable compact identities.
 * @param capability - Candidate fieldless observation.
 * @returns Summary, never owners/payload/readers/ledger or protocol capabilities.
 */
export function resolveCreatorClosedRollbackDataObservation(capability: unknown): Summary | undefined {
	if (capability === null || typeof capability !== "object") return undefined;
	const facts = observations.get(capability);
	return facts === undefined
		? undefined
		: Object.freeze({
				floor: Object.freeze({ ...facts.summary.floor }),
				head: Object.freeze({ ...facts.summary.head }),
				profileId: facts.summary.profileId,
				cuts: Object.freeze(
					facts.summary.cuts.map((cut) =>
						Object.freeze({
							...cut,
							cutRef: Object.freeze({ ...cut.cutRef }),
							commitQcRef: Object.freeze({ ...cut.commitQcRef }),
						})
					)
				),
			});
}

function failure(
	kind: CreatorClosedRollbackDataFailureKind,
	owner?: NonNullable<Failure["cause"]>["owner"],
	reason?: string
): Failure {
	return Object.freeze({
		ok: false,
		kind,
		...(owner === undefined || reason === undefined ? {} : { cause: Object.freeze({ owner, reason }) }),
	});
}
class Refusal {
	constructor(readonly result: Failure) {}
}
function requireLaw(value: unknown, kind: CreatorClosedRollbackDataFailureKind = "chain-invalid"): asserts value {
	if (!value) throw new Refusal(failure(kind));
}
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
function isAborted(signal: AbortSignal | undefined): boolean {
	return signal !== undefined && Reflect.apply(abortedGetter as (this: AbortSignal) => boolean, signal, []);
}
function checkAbort(signal: AbortSignal | undefined): void {
	if (isAborted(signal)) throw new Refusal(failure("aborted"));
}
function bindMethod<T extends (...args: never[]) => unknown>(owner: object, name: string): T {
	const method = Reflect.get(owner, name);
	if (typeof method !== "function") throw new TypeError("missing trusted port");
	return ((...args: never[]) => Reflect.apply(method, owner, args)) as T;
}
interface CapturedSnapshot extends Omit<CreatorClosedRollbackDataInput, "store" | "liveJournalStore"> {
	readonly floorRead: CreatorRollbackFloorReader["read"];
	readonly lookup: CreatorClosedRollbackDataInput["snapshotStore"]["lookupRecoveryDeclaration"];
	readonly snapshotAcquire: CreatorClosedRollbackDataInput["snapshotStore"]["acquireRecoveryRead"];
	readonly readiness: CreatorClosedRollbackDataInput["snapshotStore"]["recoveryStatus"];
	readonly capturedCatalog: TrustedBlueprintCatalog;
}
interface Captured extends CapturedSnapshot {
	readonly store: AheDurableStore;
	readonly liveJournalStore: DurableLiveJournalStore;
	readonly acquire: AheDurableStore["acquireBoundedActiveRead"];
	readonly anchorRead: DurableLiveJournalStore["readAnchorPreimage"];
}
interface CapturedRole extends CapturedSnapshot {
	readonly store: AheBoundedRecoveryRoleStore;
	readonly acquire: AheBoundedRecoveryRoleStore["acquireBoundedRecoveryRoleRead"];
}
function captureSnapshot(
	value: unknown,
	journal: boolean
): (CapturedSnapshot & { store: AheDurableStore; liveJournalStore?: DurableLiveJournalStore }) | undefined {
	try {
		if (value === null || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
			return undefined;
		const required = [
			"objectId",
			"pinnedGenesisAnchorDigest",
			"exactCanonicalPinnedGenesisTrustStateRecordBytes",
			"roomHeadAuthority",
			"catalog",
			"store",
			"snapshotStore",
			...(journal ? ["liveJournalStore"] : []),
		];
		const keys = Reflect.ownKeys(value);
		if (
			keys.some((key) => typeof key !== "string" || ![...required, "signal"].includes(key)) ||
			required.some((key) => !keys.includes(key))
		)
			return undefined;
		const fields: Record<string, unknown> = Object.create(null);
		for (const key of keys) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor?.enumerable !== true || !("value" in descriptor)) return undefined;
			fields[key as string] = descriptor.value;
		}
		if (
			typeof fields.objectId !== "string" ||
			!parseStorageObjectId(fields.objectId).ok ||
			typeof fields.pinnedGenesisAnchorDigest !== "string" ||
			!/^[0-9a-f]{64}$/u.test(fields.pinnedGenesisAnchorDigest)
		)
			return undefined;
		const bytes = snapshotQuarantineContract.captureExactBytes(
			fields.exactCanonicalPinnedGenesisTrustStateRecordBytes,
			"pinned genesis",
			8192
		);
		if (fields.signal !== undefined) Reflect.apply(abortedGetter as (this: AbortSignal) => boolean, fields.signal, []);
		const input = fields as unknown as CreatorClosedRollbackDataInput;
		const catalogResolve = bindMethod<TrustedBlueprintCatalog["resolve"]>(input.catalog, "resolve");
		const catalogDigest = input.catalog.catalogDigest;
		return Object.freeze({
			...input,
			exactCanonicalPinnedGenesisTrustStateRecordBytes: bytes,
			floorRead: bindMethod<CreatorRollbackFloorReader["read"]>(input.roomHeadAuthority, "read"),
			lookup: bindMethod<Captured["lookup"]>(input.snapshotStore, "lookupRecoveryDeclaration"),
			snapshotAcquire: bindMethod<Captured["snapshotAcquire"]>(input.snapshotStore, "acquireRecoveryRead"),
			readiness: bindMethod<Captured["readiness"]>(input.snapshotStore, "recoveryStatus"),
			capturedCatalog: Object.freeze({ resolve: catalogResolve, catalogDigest }) as TrustedBlueprintCatalog,
		});
	} catch {
		return undefined;
	}
}
function capture(value: unknown): Captured | undefined {
	try {
		const input = captureSnapshot(value, true);
		if (input === undefined || input.liveJournalStore === undefined) return undefined;
		return Object.freeze({
			...input,
			liveJournalStore: input.liveJournalStore,
			acquire: bindMethod<Captured["acquire"]>(input.store, "acquireBoundedActiveRead"),
			anchorRead: bindMethod<Captured["anchorRead"]>(input.liveJournalStore, "readAnchorPreimage"),
		});
	} catch {
		return undefined;
	}
}
function captureRole(value: unknown): CapturedRole | undefined {
	try {
		const input = captureSnapshot(value, false);
		if (input === undefined) return undefined;
		return Object.freeze({
			...input,
			store: input.store as AheBoundedRecoveryRoleStore,
			acquire: bindMethod<CapturedRole["acquire"]>(input.store, "acquireBoundedRecoveryRoleRead"),
		});
	} catch {
		return undefined;
	}
}
function snapshotFailure(error: unknown): Failure {
	if (!snapshotQuarantineContract.isError(error)) return failure("snapshot-unavailable");
	const reason = error.code;
	return failure(
		reason === "aborted"
			? "aborted"
			: ["poisoned", "conflict", "invalid-carrier"].includes(reason)
				? "snapshot-invalid"
				: "snapshot-unavailable",
		"snapshot",
		reason
	);
}
function snapshotCall<T>(call: () => Promise<T>): Promise<T> {
	return call().catch((error) => {
		throw new Refusal(snapshotFailure(error));
	});
}
function view(reader: Pick<AheBoundedActiveRead, "generations" | "blobs">, index: number): CreatorTransitionClosure {
	const generation = reader.generations[index];
	requireLaw(generation !== undefined);
	const candidates = generation.closure.map((ref) => {
		const matches = reader.blobs.filter(
			(blob) => blob.ref.digest === ref.digest && blob.ref.byteLength === ref.byteLength
		);
		requireLaw(matches.length === 1);
		return matches[0] as AheBoundedActiveRead["blobs"][number];
	});
	return Object.freeze({ closure: generation.closure, candidates: Object.freeze(candidates) });
}
function unique(
	closure: CreatorTransitionClosure,
	kind: string,
	epoch?: number
): CreatorTransitionClosure["candidates"][number] {
	const selected = uniqueCreatorTransitionCandidate(
		closure.candidates,
		kind,
		epoch,
		kind === "drp-seal-qc" ? "commit" : undefined
	);
	requireLaw(selected !== undefined && exactCreatorTransitionOccurrence(closure.closure, selected));
	// Contradictory recognized candidates cannot be hidden by an epoch filter.
	requireLaw(
		closure.candidates.filter((candidate) => canonicalCreatorDataRecord(candidate.bytes)?.kind === kind).length === 1
	);
	return selected;
}
function record(bytes: Uint8Array): Readonly<Record<string, unknown>> {
	const decoded = canonicalCreatorDataRecord(bytes);
	requireLaw(decoded !== undefined);
	return decoded;
}
function anchorOf(trustRecord: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	requireLaw(trustRecord.exactCanonicalCurrentAnchorPreimageBytes instanceof Uint8Array);
	return record(trustRecord.exactCanonicalCurrentAnchorPreimageBytes);
}

interface AnchorRequirementFacts {
	readonly source: DurableLiveJournalStore;
	readonly scope: Readonly<{ objectId: string; epoch: number; anchorDigest: string }>;
	readonly successorTrust: CurrentAnchorTrust;
	readonly retirement: NonNullable<
		NonNullable<ReturnType<typeof openCreatorTransitionClosedCutEvidence>>["retirement"]
	>;
	readonly target: Readonly<{ cutRef: GenerationRef; commitQcRef: GenerationRef; manifestDigest: string }>;
	readonly dependentTargets: readonly Readonly<{
		cutRef: GenerationRef;
		commitQcRef: GenerationRef;
		manifestDigest: string;
	}>[];
	readonly head: AheBoundedActiveRead["head"];
	readonly floor: CreatorExpectedRoomHead;
	readonly closedAclDigest: string;
	readonly frame: ImportFrame;
}
interface ImportFrame {
	readonly input: Captured;
	readonly reader: AheBoundedActiveRead;
	readonly accounting: CreatorClosedRollbackProofAccounting;
	readonly pending: Set<Promise<CreatorClosedRollbackAnchorImportResult>>;
	readonly requirements: Set<ClosedAclAnchorRequirement>;
	alive: boolean;
}
const frames = new WeakMap<AheBoundedActiveRead, ImportFrame>();
const ledgers = new WeakMap<CreatorClosedRollbackProofLedger, ImportFrame>();
const requirements = new WeakMap<ClosedAclAnchorRequirement, AnchorRequirementFacts>();
const installedMaterials = new WeakMap<
	VerifiedInstalledHistoricalAnchor,
	Readonly<{
		scope: AnchorRequirementFacts["scope"];
		target: AnchorRequirementFacts["target"];
		dependentTargets: AnchorRequirementFacts["dependentTargets"];
		head: AnchorRequirementFacts["head"];
		floor: AnchorRequirementFacts["floor"];
		profileId: string;
		source: DurableLiveJournalStore;
		destination: DurableLiveJournalStore;
		disposition: "present-in-place" | "installed-empty";
		lengths: readonly number[];
		anchorDigest: string;
		parametersDigest: string;
		signatureHex: string;
	}>
>();
const dependencies = new WeakMap<
	VerifiedClosedAnchorDependency,
	Readonly<{
		source: DurableLiveJournalStore;
		scope: AnchorRequirementFacts["scope"];
		actualByteLength: number;
		target: AnchorRequirementFacts["target"];
		dependentTargets: AnchorRequirementFacts["dependentTargets"];
		profileId: string;
		retirementCapability: AnchorRequirementFacts["retirement"]["capability"];
		head: AheBoundedActiveRead["head"];
		floor: CreatorExpectedRoomHead;
	}>
>();
function deriveAnchorRequirement(
	input: Captured,
	reader: AheBoundedActiveRead,
	floor: CreatorExpectedRoomHead,
	evidence: NonNullable<ReturnType<typeof openCreatorTransitionClosedCutEvidence>>,
	trust: CurrentAnchorTrust,
	binding: Extract<ReturnType<typeof inspectCreatorClosedCutSuccessorBinding>, { ok: true }>,
	closure: CreatorTransitionClosure,
	previousTargets: readonly CutSummary[]
): ClosedAclAnchorRequirement | undefined {
	const retirement = evidence.retirement;
	if (evidence.representation !== "retirement-only" || retirement === undefined || Number(binding.cut.epoch) <= 0)
		return undefined;
	const identity = resolveCreatorIssuanceRetirement(retirement.capability);
	if (
		identity === undefined ||
		identity.closedEpoch !== binding.cut.epoch ||
		identity.objectId !== input.objectId ||
		identity.closedAnchorDigest !== binding.cut.previousAnchor ||
		identity.closedAnchorDigest !== binding.successorAnchor.previousAnchor ||
		identity.successorAnchorDigest !== trust.currentAnchorDigest ||
		identity.successorEpoch !== trust.currentEpoch ||
		identity.genesisAnchorDigest !== input.pinnedGenesisAnchorDigest ||
		identity.commitQcRef.digest !== evidence.qc.ref.digest ||
		identity.commitQcRef.byteLength !== evidence.qc.ref.byteLength ||
		identity.snapshotManifestDigest !== binding.cut.snapshotManifestDigest ||
		identity.cutValueDigest !== creatorDataDigest("ts-drp/hard-epoch-cut/v3", evidence.cut.bytes) ||
		!exactCreatorTransitionOccurrence(closure.closure, retirement.candidate)
	)
		return undefined;
	const frame = frames.get(reader);
	if (frame === undefined || !frame.alive) return undefined;
	const closedAcl = unique(closure, "drp-v3-latched-acl", identity.closedEpoch);
	const closedAclDigest = creatorDataDigest("ts-drp/latched-acl/v3", closedAcl.bytes);
	if (
		!openCanonicalLatchedAclSnapshot({
			exactCanonicalLatchedAclBytes: closedAcl.bytes,
			expectedAclDigest: closedAclDigest,
			expectedEpoch: identity.closedEpoch,
			expectedObjectId: input.objectId,
			expectedProfileId: trust.profileId,
		}).ok
	)
		return undefined;
	const requirement = Object.freeze({});
	frame.requirements.add(requirement);
	requirements.set(
		requirement,
		Object.freeze({
			source: input.liveJournalStore,
			scope: Object.freeze({
				objectId: input.objectId,
				epoch: identity.closedEpoch,
				anchorDigest: identity.closedAnchorDigest,
			}),
			successorTrust: trust,
			retirement,
			dependentTargets: Object.freeze(
				previousTargets.map((target) =>
					Object.freeze({
						cutRef: Object.freeze({ ...target.cutRef }),
						commitQcRef: Object.freeze({ ...target.commitQcRef }),
						manifestDigest: target.manifestDigest,
					})
				)
			),
			target: Object.freeze({
				cutRef: Object.freeze({ ...evidence.cut.ref }),
				commitQcRef: Object.freeze({ ...evidence.qc.ref }),
				manifestDigest: String(binding.cut.snapshotManifestDigest),
			}),
			head: Object.freeze({ ...reader.head }),
			floor: Object.freeze({ ...floor }),
			closedAclDigest,
			frame,
		})
	);
	return requirement;
}
async function observeAnchor(
	input: Captured,
	requirement: ClosedAclAnchorRequirement,
	accounting: CreatorClosedRollbackProofAccounting,
	successorAnchor: Readonly<Record<string, unknown>>
): Promise<Readonly<{ dependency: VerifiedClosedAnchorDependency; aclDigest: string }>> {
	const facts = requirements.get(requirement);
	requireLaw(facts !== undefined && facts.source === input.liveJournalStore, "internal-invariant");
	checkAbort(input.signal);
	const allowance = Math.min(8192, AHE_BOUNDED_READ_LIMITS.maxUnionBytes - accounting.chargedBytes);
	if (allowance < 1) throw new Refusal(failure("proof-budget-exceeded"));
	let result: Awaited<ReturnType<DurableLiveJournalStore["readAnchorPreimage"]>>;
	try {
		result = await input.anchorRead({ scope: facts.scope, maxBytes: allowance });
	} catch {
		throw new Refusal(failure("anchor-unavailable"));
	}
	if (!result.ok) {
		const kind = result.kind;
		const unavailable = ["store-closed", "substrate-failure", "unsupported-schema", "durability-unavailable"];
		throw new Refusal(
			failure(
				kind === "read-budget-exceeded"
					? "proof-budget-exceeded"
					: kind === "store-poisoned"
						? "anchor-invalid"
						: unavailable.includes(kind)
							? "anchor-unavailable"
							: "internal-invariant",
				"journal",
				kind
			)
		);
	}
	if (result.kind === "missing") throw new Refusal(failure("anchor-unavailable"));
	checkAbort(input.signal);
	const bytes = result.exactCanonicalAnchorPreimageBytes;
	const anchor = canonicalCreatorDataRecord(bytes);
	const identity = resolveCreatorIssuanceRetirement(facts.retirement.capability);
	const digest = creatorDataDigest("ts-drp/epoch-anchor/v3", bytes);
	requireLaw(
		identity !== undefined &&
			anchor !== undefined &&
			bytes.byteLength <= allowance &&
			result.scope.objectId === facts.scope.objectId &&
			result.scope.epoch === facts.scope.epoch &&
			result.scope.anchorDigest === facts.scope.anchorDigest &&
			Reflect.ownKeys(anchor).length === registry.kinds.epochAnchor.fields.length &&
			registry.kinds.epochAnchor.fields.every((field) => Object.hasOwn(anchor, field.name)) &&
			anchor.kind === "drp-epoch-anchor" &&
			anchor.protocolMajor === 3 &&
			anchor.objectId === facts.scope.objectId &&
			anchor.epoch === facts.scope.epoch &&
			digest === successorAnchor.previousAnchor &&
			digest === identity.closedAnchorDigest &&
			digest === facts.scope.anchorDigest,
		"anchor-invalid"
	);
	for (const key of ["parametersDigest", "profileDigest", "signerSetDigest", "cryptoSuiteId", "blueprintDigest"])
		requireLaw(anchor[key] === successorAnchor[key], "anchor-invalid");
	requireLaw(typeof anchor.aclDigest === "string" && /^[0-9a-f]{64}$/u.test(anchor.aclDigest), "anchor-invalid");
	if (!accounting.charge(bytes)) throw new Refusal(failure("proof-budget-exceeded"));
	const dependency = Object.freeze({});
	dependencies.set(
		dependency,
		Object.freeze({
			source: facts.source,
			scope: facts.scope,
			actualByteLength: bytes.byteLength,
			target: facts.target,
			dependentTargets: facts.dependentTargets,
			profileId: facts.successorTrust.profileId,
			retirementCapability: facts.retirement.capability,
			head: facts.head,
			floor: facts.floor,
		})
	);
	return Object.freeze({ dependency, aclDigest: anchor.aclDigest });
}

interface Target {
	readonly cut: Readonly<Record<string, unknown>>;
	readonly successorAnchor: Readonly<Record<string, unknown>>;
	readonly successorTrust: CurrentAnchorTrust;
	readonly evidence: NonNullable<ReturnType<typeof openCreatorTransitionClosedCutEvidence>>;
	readonly closedAclBytes: Uint8Array;
	readonly closedAclDigest: string;
	readonly projection: Readonly<Record<string, unknown>>;
}
async function readTarget(
	input: CapturedSnapshot,
	target: Target
): Promise<
	Readonly<{
		summary: CutSummary;
		successorAclBytes: Uint8Array;
		snapshot: NonNullable<CreatorProtectedRecoveryRoleIdentity["snapshot"]>;
	}>
> {
	checkAbort(input.signal);
	const scope = Object.freeze({
		objectId: input.objectId,
		epoch: Number(target.cut.epoch),
		anchor: String(target.cut.previousAnchor),
		manifestDigest: String(target.cut.snapshotManifestDigest),
	});
	const lookup = await snapshotCall(() => input.lookup(scope, { signal: input.signal }));
	if (lookup.kind === "missing") throw new Refusal(failure("snapshot-unavailable"));
	requireLaw(lookup.state !== "poisoned", "snapshot-invalid");
	requireLaw(lookup.state === "verified" && lookup.retention === "recovery", "snapshot-not-ready");
	checkAbort(input.signal);
	const acquired = await snapshotCall(() => input.snapshotAcquire(lookup.declaration, { signal: input.signal }));
	if (acquired.kind === "missing") throw new Refusal(failure("snapshot-unavailable"));
	const release = bindMethod<typeof acquired.reader.release>(acquired.reader, "release");
	let primary: unknown;
	let observed:
		| Readonly<{
				summary: CutSummary;
				successorAclBytes: Uint8Array;
				snapshot: NonNullable<CreatorProtectedRecoveryRoleIdentity["snapshot"]>;
		  }>
		| undefined;
	try {
		const read = bindMethod<typeof acquired.reader.read>(acquired.reader, "read");
		requireLaw(acquired.state === "verified" && acquired.retention === "recovery", "snapshot-not-ready");
		const declaration = acquired.declaration;
		let decoded: ReturnType<typeof decodeSnapshotManifest>;
		try {
			decoded = decodeSnapshotManifest({
				exactCanonicalManifestBytes: declaration.exactCanonicalManifestBytes,
				expectedManifestDigest: scope.manifestDigest,
				profile: snapshotQuarantineContract.limits,
			});
		} catch {
			throw new Refusal(failure("snapshot-invalid"));
		}
		requireLaw(
			decoded.manifest.totalBytes === declaration.totalBytes && decoded.chunks.length === declaration.chunks.length,
			"snapshot-invalid"
		);
		const payload = new Uint8Array(declaration.totalBytes);
		let offset = 0;
		for (const descriptor of decoded.chunks) {
			checkAbort(input.signal);
			const actual = await snapshotCall(() => read(descriptor, { signal: input.signal }));
			if (actual === undefined) throw new Refusal(failure("snapshot-unavailable"));
			requireLaw(
				actual.byteLength === descriptor.byteLength &&
					snapshotChunkDigest(descriptor.index, actual) === descriptor.digest,
				"snapshot-invalid"
			);
			payload.set(actual, offset);
			offset += actual.byteLength;
		}
		checkAbort(input.signal);
		requireLaw(offset === payload.byteLength, "snapshot-invalid");
		const data = validateCreatorSnapshotData(
			payload,
			declaration.exactCanonicalManifestBytes,
			target.cut,
			target.successorTrust.profileId
		);
		requireLaw(data !== undefined, "snapshot-invalid");
		const catalog = creatorSnapshotCatalogIdentity(target.projection);
		requireLaw(
			catalog !== undefined &&
				verifiedCreatorSnapshotCatalog(input.capturedCatalog, target.cut.blueprintDigest, catalog) !== undefined,
			"blueprint-invalid"
		);
		requireLaw(
			creatorSnapshotProjectionMatches(
				target.projection,
				target.successorAnchor,
				target.successorTrust.currentAnchorDigest,
				scope.manifestDigest,
				data.manifest
			)
		);
		observed = Object.freeze({
			successorAclBytes: data.successorAclBytes,
			snapshot: Object.freeze({
				scope,
				manifestByteLength: declaration.exactCanonicalManifestBytes.byteLength,
				payloadDigest: String(data.manifest.payloadDigest),
				stateDigest: String(target.cut.stateDigest),
				closedAclDigest: target.closedAclDigest,
				successorAclDigest: String(target.cut.aclDigest),
				totalBytes: payload.byteLength,
				chunks: Object.freeze(decoded.chunks.map((chunk) => Object.freeze({ ...chunk }))),
			}),
			summary: Object.freeze({
				objectId: input.objectId,
				epoch: scope.epoch,
				closedAnchorDigest: scope.anchor,
				successorAnchorDigest: target.successorTrust.currentAnchorDigest,
				cutRef: Object.freeze({ ...target.evidence.cut.ref }),
				commitQcRef: Object.freeze({ ...target.evidence.qc.ref }),
				manifestDigest: scope.manifestDigest,
				payloadDigest: String(data.manifest.payloadDigest),
				stateDigest: String(target.cut.stateDigest),
				closedAclDigest: target.closedAclDigest,
				successorAclDigest: String(target.cut.aclDigest),
				payloadByteLength: payload.byteLength,
				representation: target.evidence.representation,
			}),
		});
	} catch (error) {
		primary = error;
	} finally {
		try {
			await release();
		} catch {
			primary ??= new Refusal(failure("release-failed"));
		}
	}
	if (primary !== undefined) throw primary;
	requireLaw(observed !== undefined, "internal-invariant");
	return observed;
}

async function authenticate(
	input: Captured,
	reader: AheBoundedActiveRead,
	checkCurrent: AheBoundedActiveRead["checkCurrent"],
	floor: CreatorExpectedRoomHead,
	pin: CurrentAnchorTrust,
	pinRecord: Readonly<Record<string, unknown>>
): Promise<ObservationFacts> {
	const n = floor.epoch;
	const live = view(reader, 0);
	const currentCarrier = unique(live, "drp-anchor-trust-state", n);
	let currentTrust: CurrentAnchorTrust = pin;
	let predecessorTrust = pin;
	let transitionInput: Parameters<typeof inspectCreatorTransitionAdvance>[0] | undefined;
	const accounting = createCreatorClosedRollbackProofAccounting(reader.blobs);
	const frame: ImportFrame = { input, reader, accounting, pending: new Set(), requirements: new Set(), alive: true };
	frames.set(reader, frame);
	ledgers.set(accounting, frame);
	const retainedDependencies: VerifiedClosedAnchorDependency[] = [];
	const cuts: CutSummary[] = [];
	if (n === 0) {
		requireLaw(
			compareBytes(currentCarrier.bytes, input.exactCanonicalPinnedGenesisTrustStateRecordBytes) === 0 &&
				sameCreatorRoomHead(floor, pin)
		);
		const projection = record(unique(live, "v3-live-generation-1", 0).bytes);
		const anchor = anchorOf(pinRecord);
		const catalog = creatorSnapshotCatalogIdentity(projection);
		requireLaw(creatorSnapshotProjectionAuthorityMatches(projection, anchor, pin.currentAnchorDigest));
		requireLaw(
			catalog !== undefined &&
				verifiedCreatorSnapshotCatalog(input.capturedCatalog, anchor.blueprintDigest, catalog) !== undefined,
			"blueprint-invalid"
		);
	} else {
		const proposed = view(reader, 1),
			predecessor = view(reader, 2);
		const cut = unique(proposed, "drp-hard-epoch-cut", n - 1);
		const qc = unique(proposed, "drp-seal-qc", n - 1);
		const predecessorCarrier = unique(predecessor, "drp-anchor-trust-state", n - 1);
		requireLaw(compareBytes(unique(proposed, "drp-anchor-trust-state", n).bytes, currentCarrier.bytes) === 0);
		if (n === 1) {
			requireLaw(compareBytes(predecessorCarrier.bytes, input.exactCanonicalPinnedGenesisTrustStateRecordBytes) === 0);
			const opened = openCreatorSuccessorTrust({
				currentTrust: pin,
				exactCanonicalCommitQcBytes: qc.bytes,
				exactCanonicalCutValueBytes: cut.bytes,
				exactCanonicalTrustStateRecordBytes: currentCarrier.bytes,
			});
			requireLaw(opened.ok);
			currentTrust = opened.trust;
		} else {
			const opened = openCreatorCheckpointTrust({
				detachedGenesisSignature: pinRecord.detachedCurrentAnchorSignature,
				exactCanonicalCommitQcBytes: qc.bytes,
				exactCanonicalCurrentTrustStateRecordBytes: currentCarrier.bytes,
				exactCanonicalCutValueBytes: cut.bytes,
				exactCanonicalGenesisAnchorPreimageBytes: pinRecord.exactCanonicalCurrentAnchorPreimageBytes,
				exactCanonicalPredecessorTrustStateRecordBytes: predecessorCarrier.bytes,
				expectedCurrentHead: floor,
				expectedObjectId: input.objectId,
				pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest,
			});
			requireLaw(opened.ok);
			currentTrust = opened.currentTrust;
			predecessorTrust = opened.predecessorTrust;
		}
		requireLaw(sameCreatorRoomHead(floor, currentTrust));
		transitionInput = {
			current: predecessor,
			proposed,
			currentTrust: predecessorTrust,
			successorTrust: currentTrust,
			mode: "verify",
			proofRefs: [cut.ref, qc.ref],
		};
		requireLaw(inspectCreatorTransitionAdvance(transitionInput).ok);
		const priorProjection = unique(predecessor, n === 1 ? "v3-live-generation-1" : "v3-live-generation-2", n - 1);
		requireLaw(
			creatorSnapshotProjectionAuthorityMatches(
				record(priorProjection.bytes),
				anchorOf(record(predecessorCarrier.bytes)),
				predecessorTrust.currentAnchorDigest
			)
		);
		requireLaw(
			compareBytes(
				unique(proposed, n === 1 ? "v3-live-generation-1" : "v3-live-generation-2", n - 1).bytes,
				priorProjection.bytes
			) === 0
		);
		const liveProjection = unique(live, "v3-live-generation-2", n);
		const latestClosedAcl = unique(live, "drp-v3-latched-acl", n - 1);
		const expected = new Set(
			proposed.closure.filter((ref) => ref.digest !== priorProjection.ref.digest).map((ref) => ref.digest)
		);
		expected.add(liveProjection.ref.digest);
		expected.add(latestClosedAcl.ref.digest);
		requireLaw(expected.size === live.closure.length && live.closure.every((ref) => expected.has(ref.digest)));
		checkAbort(input.signal);
		const ready = await snapshotCall(() => input.readiness({ signal: input.signal }));
		requireLaw(ready.migration === "ready", "snapshot-not-ready");
		let newestAcl: Uint8Array | undefined;
		let newestSuccessorAcl: Uint8Array | undefined;
		for (const k of n === 1 ? [0] : [n - 1, n - 2]) {
			const latest = k === n - 1;
			const closure = latest ? proposed : predecessor;
			const successorClosure = latest ? live : predecessor;
			const trust = latest ? currentTrust : predecessorTrust;
			const evidence = openCreatorTransitionClosedCutEvidence({
				closure,
				floorTrust: trust,
				...(latest ? { currentTrust: predecessorTrust } : {}),
			});
			requireLaw(evidence !== undefined);
			const binding = inspectCreatorClosedCutSuccessorBinding({
				successorTrust: trust,
				exactCanonicalCutValueBytes: evidence.cut.bytes,
			});
			requireLaw(binding.ok);
			let aclDigest: string;
			if (latest) aclDigest = String(anchorOf(record(predecessorCarrier.bytes)).aclDigest);
			else if (evidence.currentAclDigest !== undefined) aclDigest = evidence.currentAclDigest;
			else if (k === 0) {
				requireLaw(binding.cut.previousAnchor === pin.currentAnchorDigest);
				aclDigest = String(anchorOf(pinRecord).aclDigest);
			} else {
				const requirement = deriveAnchorRequirement(input, reader, floor, evidence, trust, binding, closure, cuts);
				requireLaw(requirement !== undefined);
				const observed = await observeAnchor(input, requirement, accounting, binding.successorAnchor);
				aclDigest = observed.aclDigest;
				retainedDependencies.push(observed.dependency);
			}
			const closedAcl = unique(successorClosure, "drp-v3-latched-acl", k);
			requireLaw(
				openCanonicalLatchedAclSnapshot({
					exactCanonicalLatchedAclBytes: closedAcl.bytes,
					expectedAclDigest: aclDigest,
					expectedEpoch: k,
					expectedObjectId: input.objectId,
					expectedProfileId: trust.profileId,
				}).ok,
				"snapshot-invalid"
			);
			const projection = record(unique(successorClosure, "v3-live-generation-2", k + 1).bytes);
			const data = await readTarget(input, {
				cut: binding.cut,
				successorAnchor: binding.successorAnchor,
				successorTrust: trust,
				evidence,
				closedAclBytes: closedAcl.bytes,
				closedAclDigest: aclDigest,
				projection,
			});
			if (latest) {
				newestAcl = closedAcl.bytes;
				newestSuccessorAcl = data.successorAclBytes;
			} else
				requireLaw(
					newestAcl !== undefined && compareBytes(newestAcl, data.successorAclBytes) === 0,
					"snapshot-invalid"
				);
			cuts.push(data.summary);
		}
		if (settlementProfileFor(currentTrust.profileId) === "v1") {
			requireLaw(
				newestAcl !== undefined &&
					newestSuccessorAcl !== undefined &&
					inspectCreatorTransitionAdvance({
						...transitionInput,
						settlementAcl: { current: newestAcl, successor: newestSuccessorAcl },
					}).ok
			);
		}
		for (const target of cuts) {
			checkAbort(input.signal);
			const lookup = await snapshotCall(() =>
				input.lookup(
					{
						objectId: input.objectId,
						epoch: target.epoch,
						anchor: target.closedAnchorDigest,
						manifestDigest: target.manifestDigest,
					},
					{ signal: input.signal }
				)
			);
			requireLaw(lookup.kind === "present", "snapshot-unavailable");
			requireLaw(lookup.state === "verified" && lookup.retention === "recovery", "snapshot-not-ready");
		}
		checkAbort(input.signal);
		requireLaw(
			(await snapshotCall(() => input.readiness({ signal: input.signal }))).migration === "ready",
			"snapshot-not-ready"
		);
	}
	checkAbort(input.signal);
	const currency = await checkCurrent();
	if (!currency.ok)
		throw new Refusal(
			failure(
				currency.reason === "READ_BUDGET_EXCEEDED" ? "proof-budget-exceeded" : "ahe-rejected",
				"ahe",
				currency.reason
			)
		);
	checkAbort(input.signal);
	let rawFloor: unknown;
	try {
		rawFloor = await input.floorRead({
			scope: { objectId: input.objectId, pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest },
		});
	} catch {
		throw new Refusal(failure("floor-stale"));
	}
	const finalFloor = captureCreatorRoomFloor(rawFloor, input.objectId, input.pinnedGenesisAnchorDigest);
	if (!finalFloor.ok || !sameCreatorRoomHead(finalFloor.stable, currentTrust))
		throw new Refusal(
			failure(
				"floor-stale",
				!finalFloor.ok && finalFloor.reason !== undefined ? "floor" : undefined,
				!finalFloor.ok ? finalFloor.reason : undefined
			)
		);
	checkAbort(input.signal);
	return Object.freeze({
		summary: Object.freeze({
			floor: Object.freeze({ ...floor }),
			head: Object.freeze({ ...reader.head }),
			profileId: currentTrust.profileId,
			cuts: Object.freeze(cuts),
		}),
		owners: Object.freeze([
			input.store,
			input.snapshotStore,
			input.liveJournalStore,
			input.roomHeadAuthority,
			input.catalog,
		]),
		dependencies: Object.freeze(retainedDependencies),
	});
}

/**
 * Authenticates all required actual closed-cut bytes without creating or protecting durable state.
 * Capture precedes await; every admitted owner call is joined and every reader is released.
 * @param value - Closed exact input and admitted borrowed infrastructure.
 * @returns Whole private observation or typed whole refusal, never partial custody.
 */
export async function authenticateCreatorClosedRollbackData(
	value: CreatorClosedRollbackDataInput
): Promise<CreatorClosedRollbackDataResult> {
	const input = capture(value);
	if (input === undefined) return failure("malformed-input");
	let reader: AheBoundedActiveRead | undefined;
	let release: AheBoundedActiveRead["release"] | undefined;
	let result: Failure | undefined;
	let facts: ObservationFacts | undefined;
	try {
		checkAbort(input.signal);
		let rawFloor: unknown;
		try {
			rawFloor = await input.floorRead({
				scope: { objectId: input.objectId, pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest },
			});
		} catch {
			throw new Refusal(failure("floor-unavailable"));
		}
		const floor = captureCreatorRoomFloor(rawFloor, input.objectId, input.pinnedGenesisAnchorDigest);
		if (!floor.ok)
			throw new Refusal(failure(floor.kind, floor.reason === undefined ? undefined : "floor", floor.reason));
		checkAbort(input.signal);
		const pin = openCurrentAnchorTrust({
			exactCanonicalTrustStateRecordBytes: input.exactCanonicalPinnedGenesisTrustStateRecordBytes,
			expectedObjectId: input.objectId,
			pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest,
		});
		requireLaw(pin.ok && pin.trust.currentEpoch === 0);
		const objectId = parseStorageObjectId(input.objectId);
		requireLaw(objectId.ok, "internal-invariant");
		const acquired = await input.acquire({
			objectId: objectId.value,
			ancestorCount: floor.stable.epoch === 0 ? 0 : 2,
			limits: AHE_BOUNDED_READ_LIMITS,
		});
		if (!acquired.ok)
			throw new Refusal(
				failure(
					acquired.reason === "READ_BUDGET_EXCEEDED" ? "proof-budget-exceeded" : "ahe-rejected",
					"ahe",
					acquired.reason
				)
			);
		if (acquired.value.kind === "empty") throw new Refusal(failure("ahe-empty"));
		reader = acquired.value.reader;
		release = bindMethod<AheBoundedActiveRead["release"]>(reader, "release");
		const checkCurrent = bindMethod<AheBoundedActiveRead["checkCurrent"]>(reader, "checkCurrent");
		checkAbort(input.signal);
		facts = await authenticate(
			input,
			reader,
			checkCurrent,
			floor.stable,
			pin.trust,
			record(input.exactCanonicalPinnedGenesisTrustStateRecordBytes)
		);
	} catch (error) {
		result = error instanceof Refusal ? error.result : failure("internal-invariant");
	} finally {
		if (reader !== undefined) {
			const frame = frames.get(reader);
			if (frame !== undefined) {
				frame.alive = false;
				ledgers.delete(frame.accounting);
				for (const requirement of frame.requirements) requirements.delete(requirement);
				frames.delete(reader);
				await Promise.allSettled([...frame.pending]);
			}
		}
		if (release !== undefined) {
			try {
				await release();
			} catch {
				result ??= failure("release-failed");
			}
		}
	}
	if (result !== undefined) return result;
	if (facts === undefined) return failure("internal-invariant");
	if (isAborted(input.signal)) return failure("aborted");
	const observation = Object.freeze({});
	observations.set(observation, facts);
	return Object.freeze({ ok: true, observation });
}

type RoleFailure = Extract<CreatorProtectedRecoveryRoleResult, { ok: false }>;
interface RoleFacts {
	readonly summary: CreatorProtectedRecoveryRoleSummary;
	readonly owners: readonly object[];
	readonly custody: readonly CurrentAnchorTrust[];
	readonly controls: readonly object[];
}
const roleObservations = new WeakMap<CreatorProtectedRecoveryRoleObservation, RoleFacts>();
/**
 * Resolves only this module's genuine fieldless role facts, never structural copies.
 * @param value - Candidate fact.
 * @returns Frozen detached diagnostics or undefined.
 */
export function resolveCreatorProtectedRecoveryRoleObservation(
	value: unknown
): CreatorProtectedRecoveryRoleSummary | undefined {
	return value !== null && typeof value === "object" ? roleObservations.get(value)?.summary : undefined;
}
class RoleRefusal {
	constructor(readonly result: RoleFailure) {}
}
function roleFailure(
	kind: CreatorProtectedRecoveryRoleFailureKind,
	debt: CreatorProtectedRecoveryRoleDebt,
	cause?: CreatorProtectedRecoveryRoleCause
): RoleFailure {
	return Object.freeze({
		ok: false,
		kind,
		debt: Object.freeze({ ...debt }),
		...(cause === undefined ? {} : { cause: Object.freeze({ ...cause }) }),
	});
}
function detachedGeneration(generation: GenerationRecord): GenerationRecord {
	return Object.freeze({
		...generation,
		baseExpectedHead: Object.freeze({ ...generation.baseExpectedHead }),
		closure: Object.freeze(generation.closure.map((ref) => Object.freeze({ ...ref }))),
	});
}
function roleHead(generation: GenerationRecord): PresentHead {
	return Object.freeze({
		kind: "present",
		objectId: generation.objectId,
		generationId: generation.generationId,
		closureDigest: generation.closureDigest,
		revision: ((generation.baseExpectedHead.kind === "present" ? generation.baseExpectedHead.revision : 0) +
			1) as PresentHead["revision"],
	});
}
function sameRoleHead(left: PresentHead, right: PresentHead): boolean {
	return (
		left.objectId === right.objectId &&
		left.generationId === right.generationId &&
		left.closureDigest === right.closureDigest &&
		left.revision === right.revision
	);
}
const roleControlKinds: Readonly<Record<string, CreatorProtectedRecoveryRoleIdentity["controls"][number]["kind"]>> =
	Object.freeze({
		"v3-live-generation-1": "projection",
		"v3-live-generation-2": "projection",
		"drp-anchor-trust-state": "trust",
		"drp-hard-epoch-cut": "cut",
		"drp-seal-qc": "commit-qc",
		"drp-creator-issuance-retirement-state": "retirement",
		"drp-creator-author-issuance-frontiers-state": "aggregate",
		"drp-creator-author-settlement-state": "settlement",
		"drp-v3-latched-acl": "closed-acl",
	});
interface AuthenticatedRole {
	readonly identity: CreatorProtectedRecoveryRoleIdentity;
	readonly trust: CurrentAnchorTrust;
	readonly support: readonly GenerationRecord[];
	readonly target?: Target;
	readonly transition?: Parameters<typeof inspectCreatorTransitionAdvance>[0];
}
function strictRoleControls(closure: CreatorTransitionClosure, debt: CreatorProtectedRecoveryRoleDebt): void {
	const counts = new Map<string, number>();
	for (const candidate of closure.candidates) {
		const kind = canonicalCreatorDataRecord(candidate.bytes)?.kind;
		if (typeof kind !== "string" || roleControlKinds[kind] === undefined) continue;
		const category = roleControlKinds[kind];
		counts.set(category, (counts.get(category) ?? 0) + 1);
	}
	if ([...counts.values()].some((count) => count > 1)) throw new RoleRefusal(roleFailure("role-ambiguous", debt));
}
function selectedRoleRows(
	reader: AheBoundedRecoveryRoleRead,
	epoch: number,
	debt: CreatorProtectedRecoveryRoleDebt
): GenerationRecord[] {
	const has = (generation: GenerationRecord, kind: string, expectedEpoch: number): boolean =>
		view(reader, reader.generations.indexOf(generation)).candidates.some((candidate) => {
			const decoded = canonicalCreatorDataRecord(candidate.bytes);
			return (
				decoded?.kind === kind &&
				(kind === "drp-anchor-trust-state" ? decoded.currentEpoch : decoded.epoch) === expectedEpoch
			);
		});
	const matches = reader.generations.filter((generation) => {
		if (!["Complete", "Adopted", "Superseded"].includes(generation.state)) return false;
		const projection = has(generation, epoch === 0 ? "v3-live-generation-1" : "v3-live-generation-2", epoch);
		if (projection && (generation.state === "Complete" || has(generation, "drp-anchor-trust-state", epoch)))
			return true;
		if (epoch === 0 || generation.baseExpectedHead.kind !== "present") return false;
		const proposed = reader.generations.find(
			(row) =>
				generation.baseExpectedHead.kind === "present" && row.generationId === generation.baseExpectedHead.generationId
		);
		// A recognized publication cannot disappear because its own trust/projection
		// contradicts its exact raw Q tuple. Authentication follows the whole census.
		return (
			proposed !== undefined &&
			has(proposed, "drp-anchor-trust-state", epoch) &&
			has(proposed, "drp-hard-epoch-cut", epoch - 1) &&
			has(proposed, epoch === 1 ? "v3-live-generation-1" : "v3-live-generation-2", epoch - 1)
		);
	});
	if (matches.length > 1) throw new RoleRefusal(roleFailure("role-ambiguous", debt));
	if (matches.length === 0) throw new RoleRefusal(roleFailure("role-missing", debt));
	const live = matches[0] as GenerationRecord;
	if (epoch === 0) return [live];
	requireLaw(live.baseExpectedHead.kind === "present");
	// Resolve exact persisted bases, not epoch-near or cryptographic survivors.
	const q = reader.generations.find(
		(g) => live.baseExpectedHead.kind === "present" && g.generationId === live.baseExpectedHead.generationId
	);
	requireLaw(q !== undefined && q.baseExpectedHead.kind === "present");
	const p = reader.generations.find(
		(g) => q.baseExpectedHead.kind === "present" && g.generationId === q.baseExpectedHead.generationId
	);
	requireLaw(
		(p !== undefined && p.state === "Superseded" && q.state === "Superseded") ||
			(p !== undefined && p.state === "Superseded" && q.state === "Adopted")
	);
	requireLaw(p !== undefined && new Set([live.generationId, q.generationId, p.generationId]).size === 3);
	requireLaw(
		live.objectId === q.objectId &&
			q.objectId === p.objectId &&
			sameRoleHead(live.baseExpectedHead, roleHead(q)) &&
			q.baseExpectedHead.kind === "present" &&
			q.baseExpectedHead.objectId === p.objectId &&
			q.baseExpectedHead.generationId === p.generationId &&
			q.baseExpectedHead.closureDigest === p.closureDigest &&
			// Native retained-lineage floors deliberately have no older base.
			// Their exact revision is witnessed by Q's authenticated persisted base,
			// not reconstructed as revision one from an absent historical edge.
			(p.baseExpectedHead.kind === "none" || sameRoleHead(q.baseExpectedHead, roleHead(p)))
	);
	return [live, q, p];
}
function authenticateRole(
	input: CapturedRole,
	reader: AheBoundedRecoveryRoleRead,
	rows: readonly GenerationRecord[],
	roomHead: CreatorExpectedRoomHead,
	pin: CurrentAnchorTrust,
	pinRecord: Readonly<Record<string, unknown>>,
	accounting: CreatorClosedRollbackProofAccounting,
	debt: CreatorProtectedRecoveryRoleDebt
): AuthenticatedRole {
	const generation = rows[0] as GenerationRecord;
	const closures = rows.map((g) => view(reader, reader.generations.indexOf(g)));
	for (const closure of closures) strictRoleControls(closure, debt);
	const live = closures[0] as CreatorTransitionClosure;
	const n = roomHead.epoch;
	const carrier = unique(live, "drp-anchor-trust-state", n);
	const projectionCarrier = unique(live, n === 0 ? "v3-live-generation-1" : "v3-live-generation-2", n);
	const projection = record(projectionCarrier.bytes);
	let trust = pin;
	let target: Target | undefined;
	let transition: Parameters<typeof inspectCreatorTransitionAdvance>[0] | undefined;
	if (n === 0)
		requireLaw(
			compareBytes(carrier.bytes, input.exactCanonicalPinnedGenesisTrustStateRecordBytes) === 0 &&
				sameCreatorRoomHead(roomHead, pin)
		);
	else {
		const proposed = closures[1] as CreatorTransitionClosure,
			predecessor = closures[2] as CreatorTransitionClosure;
		const cut = unique(proposed, "drp-hard-epoch-cut", n - 1),
			qc = unique(proposed, "drp-seal-qc", n - 1);
		const predecessorCarrier = unique(predecessor, "drp-anchor-trust-state", n - 1);
		requireLaw(compareBytes(unique(proposed, "drp-anchor-trust-state", n).bytes, carrier.bytes) === 0);
		let predecessorTrust = pin;
		if (n === 1) {
			requireLaw(compareBytes(predecessorCarrier.bytes, input.exactCanonicalPinnedGenesisTrustStateRecordBytes) === 0);
			const opened = openCreatorSuccessorTrust({
				currentTrust: pin,
				exactCanonicalCommitQcBytes: qc.bytes,
				exactCanonicalCutValueBytes: cut.bytes,
				exactCanonicalTrustStateRecordBytes: carrier.bytes,
			});
			requireLaw(opened.ok);
			trust = opened.trust;
		} else {
			const opened = openCreatorCheckpointTrust({
				detachedGenesisSignature: pinRecord.detachedCurrentAnchorSignature,
				exactCanonicalCommitQcBytes: qc.bytes,
				exactCanonicalCurrentTrustStateRecordBytes: carrier.bytes,
				exactCanonicalCutValueBytes: cut.bytes,
				exactCanonicalGenesisAnchorPreimageBytes: pinRecord.exactCanonicalCurrentAnchorPreimageBytes,
				exactCanonicalPredecessorTrustStateRecordBytes: predecessorCarrier.bytes,
				expectedCurrentHead: roomHead,
				expectedObjectId: input.objectId,
				pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest,
			});
			requireLaw(opened.ok);
			trust = opened.currentTrust;
			predecessorTrust = opened.predecessorTrust;
		}
		requireLaw(sameCreatorRoomHead(roomHead, trust));
		const previousProjection = unique(predecessor, n === 1 ? "v3-live-generation-1" : "v3-live-generation-2", n - 1);
		requireLaw(
			creatorSnapshotProjectionAuthorityMatches(
				record(previousProjection.bytes),
				anchorOf(record(predecessorCarrier.bytes)),
				predecessorTrust.currentAnchorDigest
			)
		);
		requireLaw(
			compareBytes(
				unique(proposed, n === 1 ? "v3-live-generation-1" : "v3-live-generation-2", n - 1).bytes,
				previousProjection.bytes
			) === 0
		);
		const closedAcl = unique(live, "drp-v3-latched-acl", n - 1);
		const expected = [
			...proposed.closure.filter(
				(ref) => !(ref.digest === previousProjection.ref.digest && ref.byteLength === previousProjection.ref.byteLength)
			),
			projectionCarrier.ref,
			closedAcl.ref,
		];
		const exact = new Map(expected.map((ref) => [ref.digest, ref.byteLength]));
		requireLaw(
			exact.size === expected.length &&
				live.closure.length === exact.size &&
				live.closure.every((ref) => exact.get(ref.digest) === ref.byteLength)
		);
		const evidence = openCreatorTransitionClosedCutEvidence({
			closure: proposed,
			floorTrust: trust,
			currentTrust: predecessorTrust,
		});
		requireLaw(evidence !== undefined);
		const binding = inspectCreatorClosedCutSuccessorBinding({
			successorTrust: trust,
			exactCanonicalCutValueBytes: evidence.cut.bytes,
		});
		requireLaw(binding.ok);
		if (debt.role === "pending-adoption" && evidence.representation === "retirement-only")
			throw new RoleRefusal(
				roleFailure("pending-policy-unavailable", debt, {
					owner: "role-policy",
					reason: "RETIREMENT_ONLY_ADVANCE_UNAVAILABLE",
				})
			);
		transition = {
			current: predecessor,
			proposed,
			currentTrust: predecessorTrust,
			successorTrust: trust,
			mode: "verify",
			proofRefs: [cut.ref, qc.ref],
		};
		requireLaw(inspectCreatorTransitionAdvance(transition).ok);
		const aclDigest = String(anchorOf(record(predecessorCarrier.bytes)).aclDigest);
		target = {
			cut: binding.cut,
			successorAnchor: binding.successorAnchor,
			successorTrust: trust,
			evidence,
			closedAclBytes: closedAcl.bytes,
			closedAclDigest: aclDigest,
			projection,
		};
	}
	const anchor = anchorOf(record(carrier.bytes));
	requireLaw(creatorSnapshotProjectionAuthorityMatches(projection, anchor, trust.currentAnchorDigest));
	const catalog = creatorSnapshotCatalogIdentity(projection);
	requireLaw(
		catalog !== undefined &&
			verifiedCreatorSnapshotCatalog(input.capturedCatalog, anchor.blueprintDigest, catalog) !== undefined,
		"blueprint-invalid"
	);
	// One ledger borrows the whole native union; these controls share actual bytes by equality.
	for (const closure of closures)
		for (const candidate of closure.candidates)
			if (!accounting.charge(candidate.bytes)) throw new Refusal(failure("proof-budget-exceeded"));
	const controls = live.candidates.flatMap((candidate) => {
		const r = canonicalCreatorDataRecord(candidate.bytes),
			kind = roleControlKinds[String(r?.kind)];
		return kind === undefined || (r?.kind === "drp-seal-qc" && r.phase !== "commit")
			? []
			: [Object.freeze({ kind, ref: Object.freeze({ ...candidate.ref }) })];
	});
	return {
		identity: Object.freeze({
			roomHead,
			profileId: trust.profileId,
			generation: Object.freeze({ ...detachedGeneration(generation), derivedHead: roleHead(generation) }),
			controls: Object.freeze(controls),
			snapshot: null,
		}),
		trust,
		support: rows.slice(1),
		...(target === undefined ? {} : { target, transition }),
	};
}
/**
 * Observes independent current and pending creator recovery roles at qualified points.
 * @param input - Closed input with borrowed native owners and genuine genesis pin.
 * @returns A whole fieldless fact only after actual data, full currency and joined cleanup.
 */
export async function observeCreatorProtectedRecoveryRoles(
	input: CreatorProtectedRecoveryRoleInput
): Promise<CreatorProtectedRecoveryRoleResult> {
	const captured = captureRole(input);
	if (captured === undefined)
		return roleFailure("malformed-input", { owner: "ahe", role: "unclassified", objectId: "" });
	let debt: CreatorProtectedRecoveryRoleDebt = { owner: "floor", role: "current", objectId: captured.objectId };
	let release: AheBoundedRecoveryRoleRead["release"] | undefined;
	let primary: RoleFailure | undefined;
	let facts: RoleFacts | undefined;
	try {
		checkAbort(captured.signal);
		const readFloor = async (final = false): Promise<ReturnType<typeof captureCreatorRoomHeadState>> => {
			let raw: unknown;
			try {
				raw = await captured.floorRead({
					scope: { objectId: captured.objectId, pinnedGenesisAnchorDigest: captured.pinnedGenesisAnchorDigest },
				});
			} catch {
				throw new RoleRefusal(roleFailure(final ? "floor-stale" : "floor-unavailable", debt));
			}
			return captureCreatorRoomHeadState(raw, captured.objectId, captured.pinnedGenesisAnchorDigest);
		};
		const floor = await readFloor();
		if (!floor.ok)
			throw new RoleRefusal(
				roleFailure(floor.kind, debt, floor.reason === undefined ? undefined : { owner: "floor", reason: floor.reason })
			);
		checkAbort(captured.signal);
		debt = { ...debt, owner: "ahe" };
		const pin = openCurrentAnchorTrust({
			exactCanonicalTrustStateRecordBytes: captured.exactCanonicalPinnedGenesisTrustStateRecordBytes,
			expectedObjectId: captured.objectId,
			pinnedGenesisAnchorDigest: captured.pinnedGenesisAnchorDigest,
		});
		requireLaw(pin.ok && pin.trust.currentEpoch === 0);
		const objectId = parseStorageObjectId(captured.objectId);
		requireLaw(objectId.ok, "internal-invariant");
		const acquired = await captured.acquire({ objectId: objectId.value, limits: AHE_BOUNDED_READ_LIMITS });
		const aheFailure = (reason: StorageRejectionReason): RoleFailure =>
			roleFailure(
				reason === "READ_BUDGET_EXCEEDED"
					? "proof-budget-exceeded"
					: reason === "READ_STALE_ROLE_VIEW"
						? "ahe-stale"
						: "ahe-rejected",
				debt,
				{ owner: "ahe", reason }
			);
		if (!acquired.ok) throw new RoleRefusal(aheFailure(acquired.reason));
		const reader = acquired.value;
		release = bindMethod<typeof reader.release>(reader, "release");
		const currency = bindMethod<typeof reader.checkCurrency>(reader, "checkCurrency");
		if (reader.head.kind !== "present") throw new RoleRefusal(roleFailure("ahe-empty", debt));
		checkAbort(captured.signal);
		const accounting = createCreatorClosedRollbackProofAccounting(reader.blobs);
		const currentRows = selectedRoleRows(reader, floor.state.stable.epoch, debt);
		const currentGeneration = currentRows[0] as GenerationRecord;
		let pendingRows: GenerationRecord[] = [];
		let publication: "before-publication" | "already-published" = "before-publication";
		if (floor.state.pending === null) {
			if (currentGeneration.state !== "Adopted" || !sameRoleHead(roleHead(currentGeneration), reader.head))
				throw new RoleRefusal(roleFailure("role-missing", debt));
		} else {
			debt = { owner: "ahe", role: "pending-adoption", objectId: captured.objectId };
			pendingRows = selectedRoleRows(reader, floor.state.pending.next.epoch, debt);
			const l = pendingRows[0] as GenerationRecord,
				q = pendingRows[1] as GenerationRecord;
			const structure = inspectCreatorAdoptionCandidateLineage({
				objectId: objectId.value,
				lineage: reader.generations,
				candidate: l,
			});
			requireLaw(
				structure !== undefined &&
					structure.currentGeneration.generationId === currentGeneration.generationId &&
					currentGeneration.state === "Superseded"
			);
			if (l.state === "Complete" && q.state === "Adopted" && sameRoleHead(structure.proposedHead, reader.head))
				publication = "before-publication";
			else if (l.state === "Adopted" && q.state === "Superseded" && sameRoleHead(structure.candidateHead, reader.head))
				publication = "already-published";
			else throw new RoleRefusal(roleFailure("role-missing", debt));
		}
		const used = new Set([...currentRows, ...pendingRows].map((g) => g.generationId));
		for (const generation of reader.generations)
			if (generation.state === "Complete" && !used.has(generation.generationId))
				throw new RoleRefusal(
					roleFailure("inherited-scope-unclassified", {
						owner: "ahe",
						role: "unclassified",
						objectId: captured.objectId,
						generationId: generation.generationId,
					})
				);
		const pinRecord = record(captured.exactCanonicalPinnedGenesisTrustStateRecordBytes);
		debt = { owner: "ahe", role: "current", objectId: captured.objectId, generationId: currentGeneration.generationId };
		let current = authenticateRole(
			captured,
			reader,
			currentRows,
			floor.state.stable,
			pin.trust,
			pinRecord,
			accounting,
			debt
		);
		let pending: AuthenticatedRole | undefined;
		if (floor.state.pending !== null) {
			debt = {
				owner: "ahe",
				role: "pending-adoption",
				objectId: captured.objectId,
				generationId: pendingRows[0]?.generationId,
			};
			pending = authenticateRole(
				captured,
				reader,
				pendingRows,
				floor.state.pending.next,
				pin.trust,
				pinRecord,
				accounting,
				debt
			);
		}
		const roles = [current, ...(pending === undefined ? [] : [pending])];
		let successorAcl: Uint8Array | undefined;
		for (let index = 0; index < roles.length; index++) {
			const role = roles[index] as AuthenticatedRole,
				target = role.target;
			if (target === undefined) continue;
			const scope = Object.freeze({
				objectId: captured.objectId,
				epoch: Number(target.cut.epoch),
				anchor: String(target.cut.previousAnchor),
				manifestDigest: String(target.cut.snapshotManifestDigest),
			});
			debt = {
				owner: "snapshot",
				role: index === 0 ? "current" : "pending-adoption",
				objectId: captured.objectId,
				generationId: role.identity.generation.generationId,
				snapshotScope: scope,
			};
			checkAbort(captured.signal);
			requireLaw(
				(await snapshotCall(() => captured.readiness({ signal: captured.signal }))).migration === "ready",
				"snapshot-not-ready"
			);
			requireLaw(
				openCanonicalLatchedAclSnapshot({
					exactCanonicalLatchedAclBytes: target.closedAclBytes,
					expectedAclDigest: target.closedAclDigest,
					expectedEpoch: scope.epoch,
					expectedObjectId: captured.objectId,
					expectedProfileId: role.trust.profileId,
				}).ok,
				"snapshot-invalid"
			);
			if (index === 1 && successorAcl !== undefined)
				requireLaw(compareBytes(successorAcl, target.closedAclBytes) === 0, "snapshot-invalid");
			const data = await readTarget(captured, target);
			if (!accounting.charge(data.successorAclBytes)) throw new Refusal(failure("proof-budget-exceeded"));
			if (settlementProfileFor(role.trust.profileId) === "v1") {
				requireLaw(
					role.transition !== undefined &&
						inspectCreatorTransitionAdvance({
							...role.transition,
							settlementAcl: { current: target.closedAclBytes, successor: data.successorAclBytes },
						}).ok
				);
			}
			successorAcl = data.successorAclBytes;
			const observed = { ...role, identity: Object.freeze({ ...role.identity, snapshot: data.snapshot }) };
			roles[index] = observed;
			if (index === 0) current = observed;
			else pending = observed;
		}
		for (let index = 0; index < roles.length; index++) {
			const role = roles[index] as AuthenticatedRole,
				snapshot = role.identity.snapshot;
			if (snapshot === null) continue;
			debt = {
				owner: "snapshot",
				role: index === 0 ? "current" : "pending-adoption",
				objectId: captured.objectId,
				generationId: role.identity.generation.generationId,
				snapshotScope: snapshot.scope,
			};
			checkAbort(captured.signal);
			const lookup = await snapshotCall(() => captured.lookup(snapshot.scope, { signal: captured.signal }));
			requireLaw(lookup.kind === "present", "snapshot-unavailable");
			requireLaw(lookup.state === "verified" && lookup.retention === "recovery", "snapshot-not-ready");
			requireLaw(
				lookup.declaration.totalBytes === snapshot.totalBytes &&
					lookup.declaration.exactCanonicalManifestBytes.byteLength === snapshot.manifestByteLength &&
					lookup.declaration.chunks.length === snapshot.chunks.length &&
					lookup.declaration.chunks.every(
						(chunk, i) =>
							chunk.index === snapshot.chunks[i]?.index &&
							chunk.digest === snapshot.chunks[i]?.digest &&
							chunk.byteLength === snapshot.chunks[i]?.byteLength
					),
				"snapshot-invalid"
			);
		}
		if (roles.some((role) => role.target !== undefined))
			requireLaw(
				(await snapshotCall(() => captured.readiness({ signal: captured.signal }))).migration === "ready",
				"snapshot-not-ready"
			);
		debt = { owner: "ahe", role: "current", objectId: captured.objectId };
		checkAbort(captured.signal);
		const finalCurrency = await currency();
		if (!finalCurrency.ok) throw new RoleRefusal(aheFailure(finalCurrency.reason));
		checkAbort(captured.signal);
		debt = { owner: "floor", role: "current", objectId: captured.objectId };
		const finalFloor = await readFloor(true);
		if (!finalFloor.ok || JSON.stringify(finalFloor.state) !== JSON.stringify(floor.state))
			throw new RoleRefusal(
				roleFailure(
					"floor-stale",
					debt,
					!finalFloor.ok && finalFloor.reason !== undefined ? { owner: "floor", reason: finalFloor.reason } : undefined
				)
			);
		const support = [
			...new Map([...current.support, ...(pending?.support ?? [])].map((g) => [g.generationId, g])).values(),
		];
		facts = Object.freeze({
			summary: Object.freeze({
				floor: floor.state,
				head: Object.freeze({ ...reader.head }),
				current: current.identity,
				pending: pending === undefined ? null : Object.freeze({ role: pending.identity, publication }),
				supportGenerations: Object.freeze(support.map(detachedGeneration)),
				heldGenerations: Object.freeze(
					reader.generations.filter((g) => !used.has(g.generationId)).map(detachedGeneration)
				),
				currency: "point-observed-no-incarnation",
			}),
			owners: Object.freeze([captured.store, captured.snapshotStore, captured.roomHeadAuthority, captured.catalog]),
			custody: Object.freeze(roles.map((role) => role.trust)),
			controls: Object.freeze(
				roles.flatMap((role) => {
					const evidence = role.target?.evidence;
					return evidence === undefined
						? []
						: [
								...(evidence.retirement === undefined ? [] : [evidence.retirement.capability]),
								...(evidence.settlement === undefined ? [] : [evidence.settlement.capability]),
								...(evidence.aggregate === undefined ? [] : [evidence.aggregate.capability]),
							];
				})
			),
		});
	} catch (error) {
		if (error instanceof RoleRefusal) primary = error.result;
		else if (error instanceof Refusal) {
			const result = error.result;
			const kind =
				result.kind === "anchor-invalid" || result.kind === "anchor-unavailable" || result.kind === "floor-pending"
					? "internal-invariant"
					: result.kind;
			primary = roleFailure(kind, debt, result.cause as CreatorProtectedRecoveryRoleCause | undefined);
		} else primary = roleFailure("internal-invariant", debt);
	} finally {
		if (release !== undefined)
			try {
				await release();
			} catch {
				primary ??= roleFailure("release-failed", debt);
			}
	}
	if (primary !== undefined) return primary;
	if (facts === undefined) return roleFailure("internal-invariant", debt);
	if (isAborted(captured.signal)) return roleFailure("aborted", debt);
	const observation = Object.freeze({});
	roleObservations.set(observation, facts);
	return Object.freeze({ ok: true, observation });
}

function importFailure(
	kind: CreatorClosedRollbackAnchorImportFailureKind,
	owner?: NonNullable<ImportFailure["cause"]>["owner"],
	reason?: string
): ImportFailure {
	return Object.freeze({
		ok: false,
		kind,
		...(owner === undefined || reason === undefined ? {} : { cause: Object.freeze({ owner, reason }) }),
	});
}
class ImportRefusal {
	constructor(readonly result: ImportFailure) {}
}
interface CapturedImport extends CreatorClosedRollbackAnchorImportInput {
	readonly sourceRead: DurableLiveJournalStore["readSignedAnchorEnvelope"];
	readonly destinationRead: DurableLiveJournalStore["readSignedAnchorEnvelope"];
	readonly install: DurableLiveJournalStore["importHistoricalAnchor"];
}
function captureImport(value: unknown): CreatorClosedRollbackAnchorImportInput | undefined {
	try {
		if (value === null || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
			return undefined;
		const required = ["requirement", "sourceJournal", "proofLedger"];
		const keys = Reflect.ownKeys(value);
		if (
			keys.some((key) => typeof key !== "string" || ![...required, "signal"].includes(key)) ||
			required.some((key) => !keys.includes(key))
		)
			return undefined;
		const fields: Record<string, unknown> = Object.create(null);
		for (const key of keys) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor?.enumerable !== true || !("value" in descriptor)) return undefined;
			fields[key as string] = descriptor.value;
		}
		for (const key of required) if (fields[key] === null || typeof fields[key] !== "object") return undefined;
		if (fields.signal !== undefined) Reflect.apply(abortedGetter as (this: AbortSignal) => boolean, fields.signal, []);
		return Object.freeze(fields) as unknown as CreatorClosedRollbackAnchorImportInput;
	} catch {
		return undefined;
	}
}
function importCheck(input: CreatorClosedRollbackAnchorImportInput, facts: AnchorRequirementFacts): void {
	if (isAborted(input.signal) || isAborted(facts.frame.input.signal)) throw new ImportRefusal(importFailure("aborted"));
	if (!facts.frame.alive || ledgers.get(input.proofLedger) !== facts.frame)
		throw new ImportRefusal(importFailure("requirement-unavailable"));
}
function nativeImportRefusal(reason: string, owner: "source-journal" | "destination-journal"): ImportRefusal {
	const side = owner === "source-journal" ? "source" : "destination";
	return new ImportRefusal(
		importFailure(
			reason === "read-budget-exceeded"
				? "proof-budget-exceeded"
				: reason === "outcome-unknown"
					? "install-outcome-unknown"
					: ["store-poisoned", "genesis-conflict"].includes(reason)
						? `${side}-invalid`
						: [
									"store-closed",
									"substrate-failure",
									"unsupported-schema",
									"durability-unavailable",
									"import-populated",
							  ].includes(reason)
							? `${side}-unavailable`
							: "internal-invariant",
			owner,
			reason
		)
	);
}
function sameImportGeneration(left: GenerationRecord, right: GenerationRecord): boolean {
	const a = left.baseExpectedHead,
		b = right.baseExpectedHead;
	return (
		left.objectId === right.objectId &&
		left.generationId === right.generationId &&
		left.closureDigest === right.closureDigest &&
		left.state === right.state &&
		a.kind === b.kind &&
		a.objectId === b.objectId &&
		(a.kind === "none" ||
			(b.kind === "present" &&
				a.generationId === b.generationId &&
				a.closureDigest === b.closureDigest &&
				a.revision === b.revision)) &&
		left.closure.length === right.closure.length &&
		left.closure.every(
			(ref, index) => ref.digest === right.closure[index]?.digest && ref.byteLength === right.closure[index]?.byteLength
		)
	);
}
async function importCurrency(input: CapturedImport, facts: AnchorRequirementFacts): Promise<void> {
	importCheck(input, facts);
	const frame = facts.frame;
	let rawFloor: unknown;
	try {
		rawFloor = await frame.input.floorRead({
			scope: {
				objectId: frame.input.objectId,
				pinnedGenesisAnchorDigest: frame.input.pinnedGenesisAnchorDigest,
			},
		});
	} catch {
		throw new ImportRefusal(importFailure("authority-stale", "floor", "unavailable"));
	}
	importCheck(input, facts);
	const floor = captureCreatorRoomFloor(rawFloor, frame.input.objectId, frame.input.pinnedGenesisAnchorDigest);
	if (
		!floor.ok ||
		!sameCreatorRoomHead(floor.stable, {
			objectId: facts.floor.objectId,
			currentEpoch: facts.floor.epoch,
			currentAnchorDigest: facts.floor.currentAnchorDigest,
		})
	)
		throw new ImportRefusal(
			importFailure("authority-stale", "floor", !floor.ok ? (floor.reason ?? floor.kind) : "changed")
		);
	const objectId = parseStorageObjectId(frame.input.objectId);
	if (!objectId.ok) throw new ImportRefusal(importFailure("internal-invariant"));
	let fresh: Awaited<ReturnType<Captured["acquire"]>>;
	try {
		fresh = await frame.input.acquire({
			objectId: objectId.value,
			ancestorCount: facts.floor.epoch === 0 ? 0 : 2,
			limits: AHE_BOUNDED_READ_LIMITS,
		});
	} catch {
		throw new ImportRefusal(importFailure("authority-invalid", "ahe", "unavailable"));
	}
	if (!fresh.ok)
		throw new ImportRefusal(
			importFailure(
				fresh.reason === "READ_BUDGET_EXCEEDED" ? "proof-budget-exceeded" : "authority-stale",
				"ahe",
				fresh.reason
			)
		);
	if (fresh.value.kind === "empty") throw new ImportRefusal(importFailure("authority-stale", "ahe", "empty"));
	const reader = fresh.value.reader;
	const release = bindMethod<AheBoundedActiveRead["release"]>(reader, "release");
	let primary: unknown;
	try {
		importCheck(input, facts);
		const keys = Object.keys(facts.head) as (keyof typeof facts.head)[];
		if (
			Object.keys(reader.head).length !== keys.length ||
			keys.some((key) => reader.head[key] !== facts.head[key]) ||
			reader.generations.length !== frame.reader.generations.length ||
			reader.generations.some((generation, index) => {
				const original = frame.reader.generations[index];
				return original === undefined || !sameImportGeneration(generation, original);
			}) ||
			reader.blobs.length !== frame.reader.blobs.length ||
			reader.blobs.some(
				(blob) =>
					!frame.reader.blobs.some(
						(original) =>
							blob.ref.digest === original.ref.digest &&
							blob.ref.byteLength === original.ref.byteLength &&
							compareBytes(blob.bytes, original.bytes) === 0
					)
			)
		)
			throw new ImportRefusal(importFailure("authority-stale", "ahe", "changed"));
		const current = await bindMethod<AheBoundedActiveRead["checkCurrent"]>(reader, "checkCurrent")();
		if (!current.ok)
			throw new ImportRefusal(
				importFailure(
					current.reason === "READ_BUDGET_EXCEEDED" ? "proof-budget-exceeded" : "authority-stale",
					"ahe",
					current.reason
				)
			);
		importCheck(input, facts);
	} catch (error) {
		primary = error;
	} finally {
		try {
			await release();
		} catch {
			primary ??= new ImportRefusal(importFailure("release-failed"));
		}
	}
	if (primary !== undefined) throw primary;
	importCheck(input, facts);
}
async function acquireImportEnvelope(
	input: CapturedImport,
	facts: AnchorRequirementFacts,
	owner: "source-journal" | "destination-journal"
): Promise<InstallLiveJournalGenesisInput | undefined> {
	importCheck(input, facts);
	const allowance = Math.min(
		AHE_BOUNDED_READ_LIMITS.maxUnionBytes - facts.frame.accounting.chargedBytes,
		8192 + 64 + 65536
	);
	let result: Awaited<ReturnType<CapturedImport["sourceRead"]>>;
	try {
		result = await (owner === "source-journal" ? input.sourceRead : input.destinationRead)({
			scope: facts.scope,
			maxBytes: allowance,
		});
	} catch {
		throw new ImportRefusal(
			importFailure(owner === "source-journal" ? "source-unavailable" : "destination-unavailable")
		);
	}
	if (!result.ok) throw nativeImportRefusal(result.kind, owner);
	importCheck(input, facts);
	if (result.kind === "missing") return undefined;
	const envelope = result.envelope;
	const bytes = [
		envelope.exactCanonicalAnchorPreimageBytes,
		envelope.detachedAnchorSignature,
		envelope.exactCanonicalParametersCarrierBytes,
	];
	if (bytes.reduce((sum, carrier) => sum + carrier.byteLength, 0) > allowance)
		throw new ImportRefusal(importFailure("internal-invariant"));
	for (const carrier of bytes)
		if (!facts.frame.accounting.charge(carrier)) throw new ImportRefusal(importFailure("proof-budget-exceeded"));
	const inspected = inspectCreatorHistoricalAnchorEnvelope({ successorTrust: facts.successorTrust, envelope });
	const identity = resolveCreatorIssuanceRetirement(facts.retirement.capability);
	if (
		!inspected.ok ||
		identity === undefined ||
		inspected.anchorDigest !== facts.scope.anchorDigest ||
		inspected.anchorDigest !== identity.closedAnchorDigest ||
		inspected.aclDigest !== facts.closedAclDigest ||
		result.scope.objectId !== facts.scope.objectId ||
		result.scope.epoch !== facts.scope.epoch ||
		result.scope.anchorDigest !== facts.scope.anchorDigest ||
		result.parametersDigest !== inspected.parametersDigest
	)
		throw new ImportRefusal(importFailure(owner === "source-journal" ? "source-invalid" : "destination-invalid"));
	return envelope;
}
function equalImportEnvelope(a: InstallLiveJournalGenesisInput, b: InstallLiveJournalGenesisInput): boolean {
	return (
		a.objectId === b.objectId &&
		compareBytes(a.exactCanonicalAnchorPreimageBytes, b.exactCanonicalAnchorPreimageBytes) === 0 &&
		compareBytes(a.detachedAnchorSignature, b.detachedAnchorSignature) === 0 &&
		compareBytes(a.exactCanonicalParametersCarrierBytes, b.exactCanonicalParametersCarrierBytes) === 0
	);
}
async function runImport(
	input: CapturedImport,
	facts: AnchorRequirementFacts
): Promise<CreatorClosedRollbackAnchorImportResult> {
	try {
		await importCurrency(input, facts);
		let envelope = await acquireImportEnvelope(input, facts, "destination-journal");
		let disposition: "present-in-place" | "installed-empty" = "present-in-place";
		if (envelope === undefined) {
			envelope = await acquireImportEnvelope(input, facts, "source-journal");
			if (envelope === undefined) throw new ImportRefusal(importFailure("source-unavailable"));
			const reread = await acquireImportEnvelope(input, facts, "source-journal");
			if (reread === undefined || !equalImportEnvelope(envelope, reread))
				throw new ImportRefusal(importFailure("source-invalid"));
			await importCurrency(input, facts);
			importCheck(input, facts);
			let installed: Awaited<ReturnType<CapturedImport["install"]>>;
			try {
				installed = await input.install({
					envelope,
					maxBytes: Math.min(
						AHE_BOUNDED_READ_LIMITS.maxUnionBytes - facts.frame.accounting.chargedBytes,
						8192 + 64 + 65536
					),
				});
			} catch {
				throw new ImportRefusal(importFailure("install-outcome-unknown"));
			}
			if (!installed.ok) throw nativeImportRefusal(installed.kind, "destination-journal");
			importCheck(input, facts);
			disposition = "installed-empty";
		}
		const confirmed = await acquireImportEnvelope(input, facts, "destination-journal");
		if (confirmed === undefined || !equalImportEnvelope(envelope, confirmed))
			throw new ImportRefusal(importFailure("destination-invalid"));
		await importCurrency(input, facts);
		importCheck(input, facts);
		const anchor = record(confirmed.exactCanonicalAnchorPreimageBytes);
		const material = Object.freeze({});
		installedMaterials.set(
			material,
			Object.freeze({
				scope: facts.scope,
				target: facts.target,
				dependentTargets: facts.dependentTargets,
				head: facts.head,
				floor: facts.floor,
				profileId: facts.successorTrust.profileId,
				source: input.sourceJournal,
				destination: facts.source,
				disposition,
				anchorDigest: facts.scope.anchorDigest,
				parametersDigest: String(anchor.parametersDigest),
				signatureHex: Array.from(confirmed.detachedAnchorSignature, (byte) => byte.toString(16).padStart(2, "0")).join(
					""
				),
				lengths: Object.freeze([
					confirmed.exactCanonicalAnchorPreimageBytes.byteLength,
					confirmed.detachedAnchorSignature.byteLength,
					confirmed.exactCanonicalParametersCarrierBytes.byteLength,
				]),
			})
		);
		return Object.freeze({ ok: true, material });
	} catch (error) {
		return error instanceof ImportRefusal ? error.result : importFailure("internal-invariant");
	}
}
/**
 * Authenticates existing destination material or imports only into a genuine empty closure.
 * The original operation's live requirement/ledger pair is mandatory; stores remain borrowed.
 * @param value - Closed input containing genuine private live provenance.
 * @returns A private signed-material fact or typed refusal, not protected custody or replay readiness.
 */
export async function importCreatorClosedRollbackAnchor(
	value: CreatorClosedRollbackAnchorImportInput
): Promise<CreatorClosedRollbackAnchorImportResult> {
	const captured = captureImport(value);
	if (captured === undefined) return importFailure("malformed-input");
	if (isAborted(captured.signal)) return importFailure("aborted");
	const facts = requirements.get(captured.requirement);
	if (facts === undefined || !facts.frame.alive || ledgers.get(captured.proofLedger) !== facts.frame)
		return importFailure("requirement-unavailable");
	let input: CapturedImport;
	try {
		input = Object.freeze({
			...captured,
			sourceRead: bindMethod<CapturedImport["sourceRead"]>(captured.sourceJournal, "readSignedAnchorEnvelope"),
			destinationRead: bindMethod<CapturedImport["destinationRead"]>(facts.source, "readSignedAnchorEnvelope"),
			install: bindMethod<CapturedImport["install"]>(facts.source, "importHistoricalAnchor"),
		});
	} catch {
		return importFailure("malformed-input");
	}
	const admitted = runImport(input, facts);
	facts.frame.pending.add(admitted);
	try {
		return await admitted;
	} finally {
		facts.frame.pending.delete(admitted);
	}
}
