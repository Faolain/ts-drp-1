import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { CompactMerkleAccumulator, deriveCloseSetHistoryCommitment, type EpochVertex } from "@ts-drp/compaction";
import {
	type SnapshotVerificationReceipt,
	verifySnapshotStreamWithReceipt,
} from "@ts-drp/compaction/snapshot-quarantine-receipt";
import { inspectTrustClosure } from "@ts-drp/control-plane";
import { inspectCreatorTrustAdvance } from "@ts-drp/control-plane/creator-trust-advance";
import type { FinalitySigner } from "@ts-drp/keychain/finality";
import type { CurrentAnchorTrust } from "@ts-drp/protocol-v3";
import { openCreatorSuccessorTrust, prepareCreatorClose } from "@ts-drp/protocol-v3/creator-close";
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

import { installCreatorAdoptionFacts } from "./internal/creator-adoption-intent.js";
import type { V3PlaneHandle } from "./v3-live.js";

const PROFILE: SnapshotTransferProfile = Object.freeze({
	maxManifestBytes: 212_387,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
});
const SCANNABLE_BYTES = 8192;
const bindings = new WeakMap<V3PlaneHandle, CreatorLiveCloseHandle>();
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
	lifecycle: "active" | "sealed" | "successor-pending-adoption";
	trust: CreatorTrustProjection;
}>;

export type CreatorLiveCloseResult = Readonly<{
	closedVertexCount: number;
	commitQcRef: GenerationRef;
	currentTrustRef: GenerationRef;
	cutValueRef: GenerationRef;
	epoch: 0;
	lifecycle: "successor-pending-adoption";
	ok: true;
	successorAnchorDigest: string;
	successorEpoch: 1;
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
	readonly exactCanonicalParametersBytes: Uint8Array;
	readonly maxEpochBytes: number;
	readonly maxEpochVertices: number;
	readonly objectId: Parameters<AheDurableStore["recoverActiveGeneration"]>[0];
	readonly store: AheDurableStore;
	captureCloseGraph():
		| Readonly<{
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
	readonly history: Awaited<ReturnType<typeof deriveCloseSetHistoryCommitment>>;
	readonly objectId: Parameters<AheDurableStore["recoverActiveGeneration"]>[0];
	readonly proposedHead: PresentHead;
	readonly proposedReferences: readonly GenerationRef[];
	readonly snapshotDeclaration: SnapshotQuarantineDeclaration;
	readonly snapshotStore: SnapshotQuarantineStore<SnapshotVerificationReceipt>;
	readonly store: AheDurableStore;
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
		return record.currentAnchorDigest === registration.currentTrust.currentAnchorDigest &&
			record.currentEpoch === registration.currentTrust.currentEpoch &&
			record.genesisAnchorDigest === registration.currentTrust.genesisAnchorDigest &&
			record.objectId === registration.currentTrust.objectId &&
			record.profileId === registration.currentTrust.profileId &&
			record.profileId === "creator-trusted-v1" &&
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
				if (closeTask !== undefined || lifecycle === "successor-pending-adoption" || actor.status().terminal) {
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
					if (acl === undefined || typeof stateDigest !== "string" || typeof archiveIndexRoot !== "string") {
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
						previousHistorySnapshot: new CompactMerkleAccumulator().snapshot(),
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
					const successorTrustRef = refFor(finalized.exactCanonicalTrustStateRecordBytes);
					const cutValueRef = refFor(prepared.exactCanonicalCutValueBytes);
					const commitQcRef = refFor(finalized.exactCanonicalCommitQcBytes);
					const proposed = Object.freeze(
						[
							...current.references.filter(({ digest }) => digest !== current.trustRef.digest),
							successorTrustRef,
							cutValueRef,
							commitQcRef,
						].sort(compareRef)
					);
					const proposedCandidates = [
						...current.candidates.filter(({ ref }) => ref.digest !== current.trustRef.digest),
						{ bytes: finalized.exactCanonicalTrustStateRecordBytes, ref: successorTrustRef },
						{ bytes: prepared.exactCanonicalCutValueBytes, ref: cutValueRef },
						{ bytes: finalized.exactCanonicalCommitQcBytes, ref: commitQcRef },
					].filter(({ ref }) => ref.byteLength <= SCANNABLE_BYTES);
					const advance = inspectCreatorTrustAdvance({
						current: { candidates: current.candidates, closure: current.references },
						proofRefs: [cutValueRef, commitQcRef],
						proposed: { candidates: proposedCandidates, closure: proposed },
					});
					if (!advance.ok) throw new TypeError(`creator trust advance failed: ${advance.reason}`);
					const proposedHead = await stageCombinedGeneration(
						registration.store,
						current,
						[
							{ bytes: finalized.exactCanonicalTrustStateRecordBytes, ref: successorTrustRef },
							{ bytes: prepared.exactCanonicalCutValueBytes, ref: cutValueRef },
							{ bytes: finalized.exactCanonicalCommitQcBytes, ref: commitQcRef },
						],
						proposed
					);
					if (!registration.terminalize()) throw new TypeError("creator close terminalization failed");
					lifecycle = "successor-pending-adoption";
					const result = Object.freeze({
						closedVertexCount: commitment.closeSetCount,
						commitQcRef: copiedRef(commitQcRef),
						currentTrustRef: copiedRef(current.trustRef),
						cutValueRef: copiedRef(cutValueRef),
						epoch: 0 as const,
						lifecycle: "successor-pending-adoption" as const,
						ok: true as const,
						successorAnchorDigest: successor.trust.currentAnchorDigest,
						successorEpoch: 1 as const,
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
								history: commitment,
								objectId: registration.objectId,
								proposedHead: Object.freeze({ ...proposedHead }),
								proposedReferences: Object.freeze(proposed.map(copiedRef)),
								snapshotDeclaration: persistedSnapshot.declaration,
								snapshotStore: input.snapshotStore,
								store: registration.store,
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
					: lifecycle === "successor-pending-adoption" || actorStatus.phase === "empty"
						? ("continuous" as const)
						: ("relearning" as const);
				return Object.freeze({
					closeAuthority:
						lifecycle === "successor-pending-adoption" || actorStatus.terminal
							? ("unavailable" as const)
							: ("available" as const),
					continuity,
					lifecycle,
					trust,
				});
			},
			stop: () => actor.stop(),
		});
		bindings.set(input.plane, handle);
		return Object.freeze({ handle, ok: true as const });
	} catch {
		return Object.freeze({ ok: false as const, reason: "CREATOR_CLOSE_BIND_FAILED" });
	}
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
