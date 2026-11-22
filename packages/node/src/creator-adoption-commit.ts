import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import type { CurrentAnchorTrust } from "@ts-drp/protocol-v3";
import {
	openCreatorForwardPromotionSuccessorTrust,
	openCreatorSuccessorTrust,
} from "@ts-drp/protocol-v3/creator-close";
import {
	AHE_BOUNDED_READ_LIMITS,
	type AheBoundedRecoveryRoleStore,
	type AheDurableStore,
	digestBlob,
	digestClosure,
	type GenerationPageCursor,
	type GenerationRecord,
	type GenerationRef,
	type PresentHead,
} from "@ts-drp/storage";

import type { CreatorLiveCloseResult } from "./creator-close.js";
import {
	authorizeCreatorAdoptionNativeFuture,
	consumeCreatorAdoptionIntent,
	consumeStagedCreatorSuccessorAdoption,
	createPreparedCreatorSuccessorAdoption,
	createStagedCreatorSuccessorAdoption,
	type CreatorAdoptionIntentMaterial,
	type PreparedCreatorSuccessorAdoption,
	rebindCreatorAdoptionNativeNominee,
	resolveCreatorAdoptionFacts,
	type StagedCreatorSuccessorAdoption,
} from "./internal/creator-adoption-intent.js";
import { matchesCreatorAdoptionReferences } from "./internal/creator-adoption-references.js";
import { installCreatorAdoptionPublish, installCreatorAdoptionStage } from "./internal/creator-adoption-stage.js";
import type { CreatorClosedRollbackProofAccounting, CreatorForwardPromotionSourceMaterial } from "./internal/creator-closed-rollback-data.js";
import { completeCreatorSuccessorLiveMaterial } from "./internal/creator-successor-live.js";
import {
	inspectCreatorTransitionAdvance,
	inspectCreatorCheckpointTransition,
	resolveCreatorCheckpointAttachment,
	resolveCreatorForwardPromotion,
	type VerifiedCreatorCheckpointAttachment,
	type VerifiedCreatorForwardPromotion,
} from "./internal/creator-transition-advance.js";

type FailureKind =
	| "malformed-input"
	| "intent-unavailable"
	| "recovery-failed"
	| "chain-invalid"
	| "pending-old"
	| "stale-head"
	| "storage-failed"
	| "internal-invariant";

type CommitFailure = Readonly<{ readonly detail: string; readonly kind: FailureKind; readonly ok: false }>;
type CommitSuccess = Readonly<{
	readonly capability: PreparedCreatorSuccessorAdoption;
	readonly descriptor: Readonly<Record<string, unknown>>;
	readonly head: PresentHead;
	readonly lifecycle: "successor-prepared";
	readonly ok: true;
	readonly recovery: "active-new";
}>;
type StageSuccess = Readonly<{
	readonly capability: StagedCreatorSuccessorAdoption;
	readonly descriptor: Readonly<Record<string, unknown>>;
	readonly lifecycle: "successor-staged";
	readonly ok: true;
	readonly recovery: "pending-old";
}>;
type PublishSuccess = CommitSuccess;

interface SealedAdoptionFacts {
	readonly checkpoint?: VerifiedCreatorCheckpointAttachment;
	/** Original complete close/recovery ledger; grants no adoption or native authority. */
	readonly proofAccounting?: CreatorClosedRollbackProofAccounting;
	readonly origin: "local-close" | "received";
	readonly receivedCandidates?: readonly Candidate[];
	readonly promotion?: Readonly<{
		verified: VerifiedCreatorForwardPromotion;
		source: Pick<CreatorForwardPromotionSourceMaterial, "checkSnapshots"> &
			Partial<Pick<CreatorForwardPromotionSourceMaterial, "rebindAfterOwnedNomination">>;
		closedEpoch: number;
	}>;
	readonly transition: Pick<
		CreatorLiveCloseResult,
		| "commitQcRef"
		| "currentTrustRef"
		| "cutValueRef"
		| "epoch"
		| "successorAnchorDigest"
		| "successorEpoch"
		| "successorTrustRef"
	>;
	readonly currentHead: PresentHead;
	readonly currentReferences: readonly GenerationRef[];
	readonly currentTrust: CurrentAnchorTrust;
	readonly durableReplay: Readonly<{ verify(): Promise<boolean> }>;
	readonly history: object;
	readonly objectId: Parameters<AheDurableStore["recoverActiveGeneration"]>[0];
	readonly proposedHead: PresentHead;
	readonly proposedReferences: readonly GenerationRef[];
	readonly snapshotDeclaration: object;
	readonly snapshotStore: object;
	readonly store: AheDurableStore;
}

interface CapturedInput {
	readonly handle: object;
	readonly intent: object;
}

interface CapturedPublishInput {
	readonly capability: object;
	readonly handle: object;
}

type Candidate = Readonly<{ readonly bytes: Uint8Array; readonly ref: GenerationRef }>;
type Terminal =
	| Readonly<{ readonly head: PresentHead; readonly kind: "active-new" }>
	| Readonly<{ readonly head: PresentHead; readonly kind: "pending-old" }>
	| Readonly<{ readonly kind: "stale-head" }>
	| Readonly<{ readonly kind: "recovery-failed" }>
	| Readonly<{ readonly kind: "chain-invalid" }>;
type StagedTerminal =
	| Readonly<{ readonly kind: "staged" }>
	| Readonly<{ readonly kind: "pending-old" }>
	| Readonly<{ readonly kind: "stale-head" }>
	| Readonly<{ readonly kind: "recovery-failed" }>
	| Readonly<{ readonly kind: "chain-invalid" }>;

function failure(kind: FailureKind, detail: string): CommitFailure {
	return Object.freeze({ detail, kind, ok: false as const });
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function predecessorProjectionKind(
	material: CreatorAdoptionIntentMaterial
): "v3-live-generation-1" | "v3-live-generation-2" | undefined {
	const currentEpoch = material.activation.predecessor.trust.currentEpoch;
	const successorEpoch = material.activation.successor.trust.currentEpoch;
	const point = material.activation.checkpoint === undefined ? undefined : resolveCreatorCheckpointAttachment(material.activation.checkpoint);
	if (material.activation.checkpoint !== undefined && (point === undefined ||
		point.localBase.trust !== material.activation.predecessor.trust ||
		point.target.trust !== material.activation.successor.trust ||
		!sameHead(point.localBase.head, material.activation.predecessor.head))) return undefined;
	return Number.isSafeInteger(currentEpoch) &&
		currentEpoch >= 0 &&
		Number.isSafeInteger(successorEpoch) &&
		(point === undefined ? successorEpoch === currentEpoch + 1 : successorEpoch > currentEpoch + 1)
		? currentEpoch === 0
			? "v3-live-generation-1"
			: "v3-live-generation-2"
		: undefined;
}

function captureInput(value: unknown): CapturedInput | undefined {
	try {
		if (!record(value) || Object.keys(value).sort().join(",") !== "handle,intent") return undefined;
		const handle = Object.getOwnPropertyDescriptor(value, "handle");
		const intent = Object.getOwnPropertyDescriptor(value, "intent");
		return handle !== undefined &&
			"value" in handle &&
			record(handle.value) &&
			intent !== undefined &&
			"value" in intent &&
			record(intent.value)
			? Object.freeze({ handle: handle.value, intent: intent.value })
			: undefined;
	} catch {
		return undefined;
	}
}

function capturePublishInput(value: unknown): CapturedPublishInput | undefined {
	try {
		if (!record(value) || Object.keys(value).sort().join(",") !== "capability,handle") return undefined;
		const capability = Object.getOwnPropertyDescriptor(value, "capability");
		const handle = Object.getOwnPropertyDescriptor(value, "handle");
		return capability !== undefined &&
			"value" in capability &&
			record(capability.value) &&
			handle !== undefined &&
			"value" in handle &&
			record(handle.value)
			? Object.freeze({ capability: capability.value, handle: handle.value })
			: undefined;
	} catch {
		return undefined;
	}
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function sameRef(left: GenerationRef, right: GenerationRef): boolean {
	return left.byteLength === right.byteLength && left.digest === right.digest;
}

function sameClosure(left: readonly GenerationRef[], right: readonly GenerationRef[]): boolean {
	return left.length === right.length && left.every((ref, index) => sameRef(ref, right[index] as GenerationRef));
}

function sameHead(left: PresentHead, right: PresentHead): boolean {
	return (
		left.closureDigest === right.closureDigest &&
		left.generationId === right.generationId &&
		left.objectId === right.objectId &&
		left.revision === right.revision
	);
}

function canonicalRecord(bytes: Uint8Array): Readonly<Record<string, unknown>> | undefined {
	try {
		const decoded = decodeCanonical(bytes);
		return record(decoded) && sameBytes(encodeCanonical(decoded), bytes) ? decoded : undefined;
	} catch {
		return undefined;
	}
}

function exactClosureDigest(references: readonly GenerationRef[], expected: string): boolean {
	const digested = digestClosure(references);
	return digested.ok && digested.value === expected;
}

async function readLineage(
	store: AheDurableStore,
	objectId: SealedAdoptionFacts["objectId"],
	bounded = false,
	accounting?: CreatorClosedRollbackProofAccounting
): Promise<readonly GenerationRecord[] | undefined> {
	if (bounded) {
		const owner = store as Partial<AheBoundedRecoveryRoleStore>;
		if (typeof owner.acquireBoundedRecoveryRoleRead !== "function") return undefined;
		const acquired = await owner.acquireBoundedRecoveryRoleRead({ objectId, limits: AHE_BOUNDED_READ_LIMITS });
		if (!acquired.ok) return undefined;
		try {
			const view = acquired.value;
			if (accounting !== undefined) {
				if (!accounting.charge(encodeCanonical({ head: view.head, generations: view.generations, blobs: view.blobs }))) return undefined;
				for (const blob of view.blobs) if (!accounting.charge(blob.bytes)) return undefined;
			}
			const currency = await view.checkCurrency();
			return (accounting === undefined || accounting.charge(encodeCanonical(currency))) && currency.ok ? view.generations : undefined;
		} finally {
			await acquired.value.release();
		}
	}
	const output: GenerationRecord[] = [];
	const cursors = new Set<GenerationPageCursor>();
	let cursor: GenerationPageCursor | undefined;
	for (;;) {
		const result = await store.readGenerationPage({
			...(cursor === undefined ? {} : { cursor }),
			limit: 128,
			objectId,
		});
		if (accounting !== undefined && !accounting.charge(encodeCanonical(result))) return undefined;
		if (!result.ok || (result.value.generations.length === 0 && result.value.nextCursor !== null)) return undefined;
		output.push(...result.value.generations);
		if (result.value.nextCursor === null) return Object.freeze(output);
		if (cursors.has(result.value.nextCursor)) return undefined;
		cursors.add(result.value.nextCursor);
		cursor = result.value.nextCursor;
	}
}

async function loadClosure(
	store: AheDurableStore,
	references: readonly GenerationRef[],
	accounting?: CreatorClosedRollbackProofAccounting
): Promise<readonly Candidate[] | undefined> {
	const candidates: Candidate[] = [];
	if (accounting !== undefined && !accounting.charge(encodeCanonical(references))) return undefined;
	// Independent reads overlap; checks, charges and failures keep the serial per-ref order.
	const reads = await Promise.allSettled(references.map((ref) => store.getBlob(ref.digest)));
	for (const [index, ref] of references.entries()) {
		const read = reads[index];
		if (read === undefined) return undefined;
		if (read.status === "rejected") throw read.reason;
		const loaded = read.value;
		if (accounting !== undefined && !accounting.charge(encodeCanonical(loaded))) return undefined;
		if (!loaded.ok || loaded.value === null || loaded.value.byteLength !== ref.byteLength) return undefined;
		const digest = digestBlob(loaded.value);
		if (!digest.ok || digest.value !== ref.digest) return undefined;
		if (accounting !== undefined && !accounting.charge(loaded.value)) return undefined;
		candidates.push(Object.freeze({ bytes: Uint8Array.from(loaded.value), ref: Object.freeze({ ...ref }) }));
	}
	return Object.freeze(candidates);
}

function candidateBytes(candidates: readonly Candidate[], ref: GenerationRef): Uint8Array | undefined {
	return candidates.find((candidate) => sameRef(candidate.ref, ref))?.bytes;
}

function validGenerationGraph(generations: readonly GenerationRecord[]): boolean {
	const ids = new Set(generations.map(({ generationId }) => generationId));
	return (
		ids.size === generations.length &&
		generations.every(
			(generation) =>
				new Set(generation.closure.map(({ digest }) => digest)).size === generation.closure.length &&
				(generation.baseExpectedHead.kind !== "present" ||
					(generation.baseExpectedHead.generationId !== generation.generationId &&
						ids.has(generation.baseExpectedHead.generationId)))
		)
	);
}

function validLineage(
	generations: readonly GenerationRecord[],
	facts: SealedAdoptionFacts,
	material: CreatorAdoptionIntentMaterial,
	activeHead: PresentHead,
	activeIsCandidate: boolean
): boolean {
	const byId = new Map(generations.map((generation) => [generation.generationId, generation]));
	if (byId.size !== generations.length) return false;
	const current = byId.get(facts.currentHead.generationId);
	const pending = byId.get(facts.proposedHead.generationId);
	const active = byId.get(activeHead.generationId);
	if (facts.origin === "received") {
		return (
			current !== undefined &&
			pending === current &&
			active !== undefined &&
			sameHead(facts.currentHead, facts.proposedHead) &&
			sameClosure(current.closure, facts.currentReferences) &&
			(activeIsCandidate
				? current.state === "Superseded" &&
					active.state === "Adopted" &&
					active.baseExpectedHead.kind === "present" &&
					sameHead(active.baseExpectedHead, facts.currentHead) &&
					sameClosure(active.closure, material.candidateReferences)
				: current.state === "Adopted" && active === current) &&
			validGenerationGraph(generations)
		);
	}
	if (
		current === undefined ||
		pending === undefined ||
		active === undefined ||
		current.state !== "Superseded" ||
		!sameClosure(current.closure, facts.currentReferences) ||
		pending.baseExpectedHead.kind !== "present" ||
		!sameHead(pending.baseExpectedHead, facts.currentHead) ||
		!sameClosure(pending.closure, facts.proposedReferences) ||
		facts.proposedHead.revision !== facts.currentHead.revision + 1
	) {
		return false;
	}
	if (activeIsCandidate) {
		if (
			pending.state !== "Superseded" ||
			active.state !== "Adopted" ||
			active.baseExpectedHead.kind !== "present" ||
			!sameHead(active.baseExpectedHead, facts.proposedHead) ||
			!sameClosure(active.closure, material.candidateReferences)
		) {
			return false;
		}
	} else if (pending.state !== "Adopted" || active !== pending) {
		return false;
	}
	return validGenerationGraph(generations);
}

function validStagedLineage(
	generations: readonly GenerationRecord[],
	facts: SealedAdoptionFacts,
	material: CreatorAdoptionIntentMaterial
): boolean {
	const byId = new Map(generations.map((generation) => [generation.generationId, generation]));
	if (byId.size !== generations.length) return false;
	const current = byId.get(facts.currentHead.generationId);
	const pending = byId.get(facts.proposedHead.generationId);
	const staged = byId.get(material.generationId);
	if (facts.origin === "received") {
		return (
			current !== undefined &&
			pending === current &&
			staged !== undefined &&
			current.state === "Adopted" &&
			staged.state === "Complete" &&
			sameHead(facts.currentHead, facts.proposedHead) &&
			sameClosure(current.closure, facts.currentReferences) &&
			staged.baseExpectedHead.kind === "present" &&
			sameHead(staged.baseExpectedHead, facts.currentHead) &&
			sameClosure(staged.closure, material.candidateReferences) &&
			validGenerationGraph(generations)
		);
	}
	if (
		current === undefined ||
		pending === undefined ||
		staged === undefined ||
		current.state !== "Superseded" ||
		pending.state !== "Adopted" ||
		staged.state !== "Complete" ||
		!sameClosure(current.closure, facts.currentReferences) ||
		pending.baseExpectedHead.kind !== "present" ||
		!sameHead(pending.baseExpectedHead, facts.currentHead) ||
		!sameClosure(pending.closure, facts.proposedReferences) ||
		staged.baseExpectedHead.kind !== "present" ||
		!sameHead(staged.baseExpectedHead, material.pendingHead) ||
		!sameClosure(staged.closure, material.candidateReferences) ||
		facts.proposedHead.revision !== facts.currentHead.revision + 1
	) {
		return false;
	}
	return validGenerationGraph(generations);
}

function validProjection(material: CreatorAdoptionIntentMaterial): Readonly<Record<string, unknown>> | undefined {
	const descriptor = canonicalRecord(material.exactCanonicalProjectionBytes);
	const predecessorKind = predecessorProjectionKind(material);
	if (
		descriptor?.kind !== "v3-live-generation-2" ||
		predecessorKind === undefined ||
		descriptor.epoch !== material.activation.successor.trust.currentEpoch
	) {
		return undefined;
	}
	const cuts = material.activation.successor.candidates.filter(
		({ bytes }) => canonicalRecord(bytes)?.kind === "drp-hard-epoch-cut"
	);
	const cut = cuts[0];
	if (cuts.length !== 1 || cut === undefined) return undefined;
	const matches = matchesCreatorAdoptionReferences(
		{
			pendingReferences: material.pendingReferences,
			predecessorLiveRef: material.predecessorLiveRef,
			exactCanonicalProjectionBytes: material.exactCanonicalProjectionBytes,
			exactCanonicalCutValueBytes: cut.bytes,
			predecessorExactCanonicalLatchedAclBytes: closedAclBytes(material),
		},
		material.candidateReferences
	);
	return material.pendingReferences.filter((ref) => sameRef(ref, material.predecessorLiveRef)).length === 1 && matches
		? Object.freeze(descriptor)
		: undefined;
}

function validTrustChain(
	facts: SealedAdoptionFacts,
	currentCandidates: readonly Candidate[],
	pendingCandidates: readonly Candidate[]
): boolean {
	if (facts.checkpoint !== undefined) return inspectCreatorCheckpointTransition({checkpoint: facts.checkpoint,
		localHead: facts.currentHead, currentTrust: facts.currentTrust,
		current: {candidates: currentCandidates, closure: facts.currentReferences},
		proposed: {candidates: pendingCandidates, closure: facts.proposedReferences}});
	const cutBytes = candidateBytes(pendingCandidates, facts.transition.cutValueRef);
	const commitBytes = candidateBytes(pendingCandidates, facts.transition.commitQcRef);
	const successorTrustBytes = candidateBytes(pendingCandidates, facts.transition.successorTrustRef);
	const currentTrustBytes = candidateBytes(currentCandidates, facts.transition.currentTrustRef);
	if (
		cutBytes === undefined ||
		commitBytes === undefined ||
		successorTrustBytes === undefined ||
		currentTrustBytes === undefined
	) {
		return false;
	}
	const promotion =
		facts.promotion === undefined ? undefined : resolveCreatorForwardPromotion(facts.promotion.verified);
	if (
		facts.promotion !== undefined &&
		(promotion === undefined ||
			promotion.currentAnchorDigest !== facts.currentTrust.currentAnchorDigest ||
			promotion.successorAnchorDigest !== facts.transition.successorAnchorDigest)
	)
		return false;
	const opened = (promotion === undefined ? openCreatorSuccessorTrust : openCreatorForwardPromotionSuccessorTrust)({
		currentTrust: facts.currentTrust,
		exactCanonicalCommitQcBytes: commitBytes,
		exactCanonicalCutValueBytes: cutBytes,
		exactCanonicalTrustStateRecordBytes: successorTrustBytes,
	});
	if (
		!opened.ok ||
		opened.trust.currentAnchorDigest !== facts.transition.successorAnchorDigest ||
		opened.trust.currentEpoch !== facts.transition.successorEpoch
	) {
		return false;
	}
	return inspectCreatorTransitionAdvance({
		current: { candidates: currentCandidates, closure: facts.currentReferences },
		currentTrust: facts.currentTrust,
		mode: "verify",
		proofRefs: [facts.transition.cutValueRef, facts.transition.commitQcRef],
		proposed: { candidates: pendingCandidates, closure: facts.proposedReferences },
		successorTrust: opened.trust,
	}).ok;
}

function closedAclBytes(material: CreatorAdoptionIntentMaterial): Uint8Array {
	if (material.activation.checkpoint === undefined) return material.activation.predecessorExactCanonicalLatchedAclBytes;
	const point = resolveCreatorCheckpointAttachment(material.activation.checkpoint);
	if (point === undefined) throw new TypeError("creator checkpoint closed ACL is unavailable");
	return point.remoteCheckpoint.exactCanonicalPredecessorAclBytes;
}

async function authenticatedTerminal(
	facts: SealedAdoptionFacts,
	material: CreatorAdoptionIntentMaterial
): Promise<Terminal> {
	try {
		await facts.promotion?.source.checkSnapshots();
		if (
			!sameHead(material.pendingHead, facts.proposedHead) ||
			!sameClosure(material.pendingReferences, facts.proposedReferences) ||
			material.pendingHead.objectId !== facts.objectId
		) {
			return Object.freeze({ kind: "chain-invalid" });
		}
		const recovered = await facts.store.recoverActiveGeneration(facts.objectId);
		if (facts.proofAccounting !== undefined && !facts.proofAccounting.charge(encodeCanonical(recovered)))
			return Object.freeze({ kind: "recovery-failed" });
		if (!recovered.ok || recovered.value.kind !== "active") {
			return Object.freeze({ kind: "recovery-failed" });
		}
		const active = recovered.value;
		const pending = sameHead(active.head, material.pendingHead);
		const candidateDigest = digestClosure(material.candidateReferences);
		const candidate =
			candidateDigest.ok &&
			active.head.objectId === material.pendingHead.objectId &&
			active.head.revision === material.pendingHead.revision + 1 &&
			active.head.closureDigest === candidateDigest.value &&
			active.adoptedGeneration.state === "Adopted" &&
			sameClosure(active.references, material.candidateReferences) &&
			sameClosure(active.adoptedGeneration.closure, material.candidateReferences);
		if (!pending && !candidate) return Object.freeze({ kind: "stale-head" });
		const pendingReferences = facts.origin === "received" ? facts.currentReferences : material.pendingReferences;
		if (
			active.adoptedGeneration.state !== "Adopted" ||
			!sameClosure(active.references, pending ? pendingReferences : material.candidateReferences) ||
			!sameClosure(active.adoptedGeneration.closure, pending ? pendingReferences : material.candidateReferences) ||
			!exactClosureDigest(active.references, active.head.closureDigest)
		) {
			return Object.freeze({ kind: "chain-invalid" });
		}
		const currentLoad = loadClosure(facts.store, facts.currentReferences, facts.proofAccounting);
		const activeReferences = pending ? pendingReferences : material.candidateReferences;
		const [generations, currentCandidates, pendingCandidates, activeCandidates] = await Promise.all([
			readLineage(facts.store, facts.objectId, facts.origin === "received", facts.proofAccounting),
			currentLoad,
			facts.origin === "received"
				? Promise.resolve(facts.receivedCandidates)
				: loadClosure(facts.store, facts.proposedReferences, facts.proofAccounting),
			// The same closure is read once when no proof ledger counts each read.
			activeReferences === facts.currentReferences && facts.proofAccounting === undefined
				? currentLoad
				: loadClosure(facts.store, activeReferences, facts.proofAccounting),
		]);
		const descriptor = validProjection(material);
		if (
			generations === undefined ||
			currentCandidates === undefined ||
			pendingCandidates === undefined ||
			activeCandidates === undefined ||
			descriptor === undefined ||
			!validLineage(generations, facts, material, active.head, candidate) ||
			!validTrustChain(facts, currentCandidates, pendingCandidates)
		) {
			return Object.freeze({ kind: "chain-invalid" });
		}
		const predecessor = currentCandidates.filter(
			({ bytes, ref }) =>
				sameRef(ref, material.predecessorLiveRef) &&
				canonicalRecord(bytes)?.kind === predecessorProjectionKind(material)
		);
		return predecessor.length === 1
			? Object.freeze({ head: Object.freeze({ ...active.head }), kind: candidate ? "active-new" : "pending-old" })
			: Object.freeze({ kind: "chain-invalid" });
	} catch {
		return Object.freeze({ kind: "recovery-failed" });
	}
}

async function authenticatedStaged(
	facts: SealedAdoptionFacts,
	material: CreatorAdoptionIntentMaterial
): Promise<StagedTerminal> {
	try {
		await facts.promotion?.source.checkSnapshots();
		if (
			!sameHead(material.pendingHead, facts.proposedHead) ||
			!sameClosure(material.pendingReferences, facts.proposedReferences) ||
			material.pendingHead.objectId !== facts.objectId
		) {
			return Object.freeze({ kind: "chain-invalid" });
		}
		const recovered = await facts.store.recoverActiveGeneration(facts.objectId);
		if (facts.proofAccounting !== undefined && !facts.proofAccounting.charge(encodeCanonical(recovered)))
			return Object.freeze({ kind: "recovery-failed" });
		if (!recovered.ok || recovered.value.kind !== "active") {
			return Object.freeze({ kind: "recovery-failed" });
		}
		const active = recovered.value;
		if (!sameHead(active.head, material.pendingHead)) return Object.freeze({ kind: "stale-head" });
		const pendingReferences = facts.origin === "received" ? facts.currentReferences : material.pendingReferences;
		if (
			active.adoptedGeneration.state !== "Adopted" ||
			!sameClosure(active.references, pendingReferences) ||
			!sameClosure(active.adoptedGeneration.closure, pendingReferences) ||
			!exactClosureDigest(active.references, active.head.closureDigest)
		) {
			return Object.freeze({ kind: "chain-invalid" });
		}
		const [generations, currentCandidates, pendingCandidates, stagedCandidates] = await Promise.all([
			readLineage(facts.store, facts.objectId, facts.origin === "received", facts.proofAccounting),
			loadClosure(facts.store, facts.currentReferences, facts.proofAccounting),
			facts.origin === "received"
				? Promise.resolve(facts.receivedCandidates)
				: loadClosure(facts.store, facts.proposedReferences, facts.proofAccounting),
			loadClosure(facts.store, material.candidateReferences, facts.proofAccounting),
		]);
		const descriptor = validProjection(material);
		if (
			generations === undefined ||
			currentCandidates === undefined ||
			pendingCandidates === undefined ||
			stagedCandidates === undefined ||
			descriptor === undefined ||
			!validStagedLineage(generations, facts, material) ||
			!validTrustChain(facts, currentCandidates, pendingCandidates)
		) {
			return Object.freeze({ kind: "pending-old" });
		}
		const projection = stagedCandidates.filter(({ bytes }) => sameBytes(bytes, material.exactCanonicalProjectionBytes));
		const predecessor = currentCandidates.filter(
			({ bytes, ref }) =>
				sameRef(ref, material.predecessorLiveRef) &&
				canonicalRecord(bytes)?.kind === predecessorProjectionKind(material)
		);
		return projection.length === 1 && predecessor.length === 1
			? Object.freeze({ kind: "staged" })
			: Object.freeze({ kind: "chain-invalid" });
	} catch {
		return Object.freeze({ kind: "recovery-failed" });
	}
}

function successfulMutation(result: unknown, accounting?: CreatorClosedRollbackProofAccounting): boolean {
	if (accounting !== undefined) {
		// A void native acknowledgement has no encoded value. Preserve every
		// other observed field; the original value-presence check below remains.
		// Rich native replies and independently reopened postimages stay whole.
		let observation = result;
		if (record(result) && Object.hasOwn(result, "value") && result.value === undefined) {
			const fields: Record<string, unknown> = { ...result };
			delete fields.value;
			observation = fields;
		}
		if (!accounting.charge(encodeCanonical(observation))) return false;
	}
	return record(result) && result.ok === true && Object.hasOwn(result, "value");
}

async function stageCandidate(
	facts: SealedAdoptionFacts,
	material: CreatorAdoptionIntentMaterial
): Promise<CreatorAdoptionIntentMaterial> {
	await facts.promotion?.source.checkSnapshots();
	if (facts.proofAccounting !== undefined) {
		for (const bytes of [material.exactCanonicalProjectionBytes, encodeCanonical(material.candidateReferences),
			closedAclBytes(material),
			...(facts.origin === "received" ? material.activation.successor.candidates.map(({ bytes }) => bytes) : [])])
			if (!facts.proofAccounting.charge(bytes)) throw new TypeError("creator successor full proof charge is exhausted before stage");
	}
	const native = await nominatedFuture(facts, material, "stage");
	if (native) return native;
	const scope = Object.freeze({ generationId: material.generationId, objectId: facts.objectId });
	let existing: GenerationRecord | undefined;
	if (facts.origin === "received") {
		const lineage = await readLineage(facts.store, facts.objectId, true, facts.proofAccounting);
		if (lineage === undefined) throw new TypeError("creator successor bounded retry census failed");
		existing = lineage.find(({ generationId }) => generationId === material.generationId);
		if (
			existing !== undefined &&
			(existing.baseExpectedHead.kind !== "present" ||
				!sameHead(existing.baseExpectedHead, material.pendingHead) ||
				!sameClosure(existing.closure, material.candidateReferences) ||
				!exactClosureDigest(existing.closure, existing.closureDigest) ||
				(existing.state !== "Staged" && existing.state !== "Complete"))
		)
			throw new TypeError("creator successor retry custody conflicts");
		if (existing?.state === "Complete") return material;
	}
	if (
		existing === undefined &&
		!successfulMutation(
			await facts.store.beginGeneration({
				...scope,
				baseExpectedHead: material.pendingHead,
				closure: material.candidateReferences,
			}), facts.proofAccounting
		)
	) {
		throw new TypeError("creator successor begin failed");
	}
	const projectionDigest = digestBlob(material.exactCanonicalProjectionBytes);
	if (
		!projectionDigest.ok ||
		!successfulMutation(
			await facts.store.putCachedBlob({
				...scope,
				bytes: material.exactCanonicalProjectionBytes,
				digest: projectionDigest.value,
			}), facts.proofAccounting
		)
	) {
		throw new TypeError("creator successor projection cache failed");
	}
	for (const bytes of [
		closedAclBytes(material),
		...(facts.origin === "received" ? material.activation.successor.candidates.map(({ bytes }) => bytes) : []),
	]) {
		const digest = digestBlob(bytes);
		if (!digest.ok || !successfulMutation(await facts.store.putCachedBlob({ ...scope, bytes, digest: digest.value }), facts.proofAccounting)) {
			throw new TypeError("creator authenticated ACL cache failed");
		}
	}
	for (const ref of material.candidateReferences) {
		if (!successfulMutation(await facts.store.promoteReference({ ...scope, digest: ref.digest }), facts.proofAccounting)) {
			throw new TypeError("creator successor promotion failed");
		}
	}
	if (!successfulMutation(await facts.store.completeGeneration(scope), facts.proofAccounting)) {
		throw new TypeError("creator successor completion failed");
	}
	return material;
}

async function publishCandidate(facts: SealedAdoptionFacts, material: CreatorAdoptionIntentMaterial): Promise<void> {
	if (await nominatedFuture(facts, material, "publish")) return;
	const scope = Object.freeze({ generationId: material.generationId, objectId: facts.objectId });
	if (
		!successfulMutation(
			await facts.store.swapHead({
				...scope,
				expectedHead: material.pendingHead,
			}), facts.proofAccounting
		)
	) {
		throw new TypeError("creator successor head swap failed");
	}
}

/**
 * Original authenticated adoption owner composes only an existing completed native floor.
 * @param facts
 * @param material
 * @param phase
 */
async function nominatedFuture(
	facts: SealedAdoptionFacts,
	material: CreatorAdoptionIntentMaterial,
	phase: "stage" | "publish"
): Promise<CreatorAdoptionIntentMaterial | undefined> {
	const owner = facts.store as AheBoundedRecoveryRoleStore;
	if (owner.readRetirementControl === undefined) return undefined;
	const observed = await owner.readRetirementControl(facts.objectId);
	if (facts.proofAccounting !== undefined && !facts.proofAccounting.charge(encodeCanonical(observed)))
		throw new TypeError("creator native retirement full proof charge is exhausted");
	if (!observed.ok) throw new TypeError("creator native retirement metadata is unavailable");
	if (observed.value?.completed === null || observed.value === null) return undefined;
	if (!owner.acquireRetirementControl || !material.nativeIntent)
		throw new TypeError("creator native future admission is unavailable");
	const current = await owner.acquireRetirementControl(facts.objectId);
	if (!current.ok) throw new TypeError("creator native future observation refused");
	let submitted = false;
	let primary: unknown;
	try {
		if (facts.proofAccounting !== undefined && !facts.proofAccounting.charge(encodeCanonical({ control: current.value.control,
			head: current.value.head, imageDigest: current.value.imageDigest, metadataBytes: current.value.metadataBytes })))
			throw new TypeError("creator native observation full proof charge is exhausted");
		const nominee = current.value.control.nominee;
		if (phase === "stage" && nominee) {
			const candidate = Object.freeze({ ...material, generationId: nominee.generationId });
			if ((await authenticatedStaged(facts, candidate)).kind !== "staged")
				throw new TypeError("creator native nominee lacks original staged authentication");
			const rebound = rebindCreatorAdoptionNativeNominee(material, facts.store, nominee.generationId);
			if (!rebound) throw new TypeError("creator native nominee custody refused");
			material = rebound;
		}
		if (!authorizeCreatorAdoptionNativeFuture(material, facts.store, phase))
			throw new TypeError("creator native future custody refused");
		submitted = true;
		const result =
			phase === "stage"
				? await current.value.stageNominatedFutureGeneration(material.nativeIntent)
				: await current.value.publishNominatedFutureGeneration(material.nativeIntent);
		if (facts.proofAccounting !== undefined && !facts.proofAccounting.charge(encodeCanonical(result)))
			throw new TypeError("creator native stage/publication full proof charge is exhausted");
		if (!result.ok) throw new TypeError(`creator native future ${phase} refused:${result.reason}`);
		return material;
	} catch (error) {
		primary = error;
		throw error;
	} finally {
		try {
			await current.value.release();
			// Received/installed snapshot-only sources have no whole AHE role reader to rebind.
			if (submitted) await facts.promotion?.source.rebindAfterOwnedNomination?.(material, phase, current.value.control);
		} catch (cleanup) {
			if (primary !== undefined) throw new AggregateError([primary, cleanup], "creator native nomination readback failed", { cause: primary });
			throw cleanup;
		}
	}
}

function success(
	handle: object,
	material: CreatorAdoptionIntentMaterial,
	descriptor: Readonly<Record<string, unknown>>,
	head: PresentHead
): CommitSuccess {
	return Object.freeze({
		capability: createPreparedCreatorSuccessorAdoption(handle, {
			activation: completeCreatorSuccessorLiveMaterial(material.activation, head),
			exactCanonicalProjectionBytes: material.exactCanonicalProjectionBytes,
			head,
		}),
		descriptor,
		head: Object.freeze({ ...head }),
		lifecycle: "successor-prepared" as const,
		ok: true as const,
		recovery: "active-new" as const,
	});
}

function stagedSuccess(
	handle: object,
	material: CreatorAdoptionIntentMaterial,
	descriptor: Readonly<Record<string, unknown>>
): StageSuccess {
	return Object.freeze({
		capability: createStagedCreatorSuccessorAdoption(handle, { descriptor, intent: material }),
		descriptor,
		lifecycle: "successor-staged" as const,
		ok: true as const,
		recovery: "pending-old" as const,
	});
}

async function stageCreatorSuccessorAdoptionKernel(input: unknown): Promise<CommitFailure | StageSuccess> {
	const captured = captureInput(input);
	if (captured === undefined) return failure("malformed-input", "creator adoption stage input is invalid");
	const facts = resolveCreatorAdoptionFacts<SealedAdoptionFacts>(captured.handle);
	let material = consumeCreatorAdoptionIntent(captured.intent, captured.handle);
	if (facts === undefined || material === undefined) {
		return failure("intent-unavailable", "creator adoption intent is unavailable");
	}
	const descriptor = validProjection(material);
	if (descriptor === undefined) return failure("internal-invariant", "creator successor projection is invalid");
	const terminal = await authenticatedTerminal(facts, material);
	if (terminal.kind === "active-new") return failure("stale-head", "creator successor is already published");
	if (terminal.kind === "stale-head") return failure("stale-head", "creator successor head is stale");
	if (terminal.kind === "recovery-failed") return failure("recovery-failed", "creator successor recovery failed");
	if (terminal.kind === "chain-invalid") return failure("chain-invalid", "creator successor chain is invalid");
	let stageRequestFailed = false;
	let stageRequestFailure: unknown;
	try {
		material = await stageCandidate(facts, material);
	} catch (error) {
		stageRequestFailed = true;
		stageRequestFailure = error;
		// A fresh authenticated inspection below is the only authority after an ambiguous write.
	}
	const staged = await authenticatedStaged(facts, material);
	if (staged.kind === "staged") return stagedSuccess(captured.handle, material, descriptor);
	const stageFailure = (kind: FailureKind, detail: string): CommitFailure =>
		facts.origin === "received" && stageRequestFailed
			? Object.freeze({ ...failure(kind, detail), cause: stageRequestFailure })
			: failure(kind, detail);
	if (staged.kind === "stale-head") return stageFailure("stale-head", "creator successor head is stale");
	if (staged.kind === "chain-invalid") return stageFailure("chain-invalid", "creator successor chain is invalid");
	if (staged.kind === "recovery-failed") return stageFailure("recovery-failed", "creator successor recovery failed");
	return stageFailure("pending-old", "creator successor is not durably complete");
}

async function publishStagedCreatorSuccessorAdoptionKernel(input: unknown): Promise<CommitFailure | PublishSuccess> {
	const captured = capturePublishInput(input);
	if (captured === undefined) return failure("malformed-input", "creator adoption publish input is invalid");
	const facts = resolveCreatorAdoptionFacts<SealedAdoptionFacts>(captured.handle);
	const staged = consumeStagedCreatorSuccessorAdoption(captured.capability, captured.handle);
	if (facts === undefined || staged === undefined) {
		return failure("intent-unavailable", "creator adoption staged capability is unavailable");
	}
	let terminal = await authenticatedTerminal(facts, staged.intent);
	if (terminal.kind === "active-new") return success(captured.handle, staged.intent, staged.descriptor, terminal.head);
	if (terminal.kind === "stale-head") return failure("stale-head", "creator successor head is stale");
	if (terminal.kind === "recovery-failed") return failure("recovery-failed", "creator successor recovery failed");
	if (terminal.kind === "chain-invalid") return failure("chain-invalid", "creator successor chain is invalid");
	const authenticated = await authenticatedStaged(facts, staged.intent);
	if (authenticated.kind !== "staged") {
		return authenticated.kind === "recovery-failed"
			? failure("recovery-failed", "creator successor recovery failed")
			: authenticated.kind === "stale-head"
				? failure("stale-head", "creator successor head is stale")
				: failure("chain-invalid", "creator successor staged generation is invalid");
	}
	try {
		await publishCandidate(facts, staged.intent);
	} catch {
		// A fresh authenticated reopen below is the only authority after an ambiguous CAS.
	}
	terminal = await authenticatedTerminal(facts, staged.intent);
	if (terminal.kind === "active-new") return success(captured.handle, staged.intent, staged.descriptor, terminal.head);
	if (terminal.kind === "pending-old") return failure("pending-old", "creator successor remains safely pending");
	if (terminal.kind === "stale-head") return failure("stale-head", "creator successor head is stale");
	if (terminal.kind === "chain-invalid") return failure("chain-invalid", "creator successor chain is invalid");
	if (terminal.kind === "recovery-failed") return failure("recovery-failed", "creator successor recovery failed");
	return failure("storage-failed", "creator successor storage failed");
}

/**
 * Commits a verified creator successor with one durable head comparison-and-swap.
 * This retained one-call API does not publish provider freshness and must not
 * advance a provider-scoped product room.
 * @param input - Genuine close handle and its owner-bound, one-use intent.
 * @returns Exact prepared successor or a closed failure.
 */
export async function commitCreatorSuccessorAdoption(input: unknown): Promise<CommitFailure | CommitSuccess> {
	const captured = captureInput(input);
	if (captured === undefined) return failure("malformed-input", "creator adoption commit input is invalid");
	const facts = resolveCreatorAdoptionFacts<SealedAdoptionFacts>(captured.handle);
	let material = consumeCreatorAdoptionIntent(captured.intent, captured.handle);
	if (facts === undefined || material === undefined) {
		return failure("intent-unavailable", "creator adoption intent is unavailable");
	}
	const descriptor = validProjection(material);
	if (descriptor === undefined) return failure("internal-invariant", "creator successor projection is invalid");
	let terminal = await authenticatedTerminal(facts, material);
	if (terminal.kind === "active-new") return success(captured.handle, material, descriptor, terminal.head);
	if (terminal.kind === "stale-head") return failure("stale-head", "creator successor head is stale");
	if (terminal.kind === "recovery-failed") return failure("recovery-failed", "creator successor recovery failed");
	if (terminal.kind === "chain-invalid") return failure("chain-invalid", "creator successor chain is invalid");
	let stageRequestFailed = false;
	try {
		material = await stageCandidate(facts, material);
	} catch {
		stageRequestFailed = true;
		// A fresh authenticated reopen below is the only authority after an ambiguous write.
	}
	const staged = stageRequestFailed ? undefined : await authenticatedStaged(facts, material);
	if (staged?.kind === "staged") {
		try {
			await publishCandidate(facts, material);
		} catch {
			// A fresh authenticated reopen below is the only authority after an ambiguous CAS.
		}
	}
	terminal = await authenticatedTerminal(facts, material);
	if (terminal.kind === "active-new") return success(captured.handle, material, descriptor, terminal.head);
	if (terminal.kind === "pending-old") return failure("pending-old", "creator successor remains safely pending");
	if (terminal.kind === "stale-head") return failure("stale-head", "creator successor head is stale");
	if (terminal.kind === "chain-invalid") return failure("chain-invalid", "creator successor chain is invalid");
	if (terminal.kind === "recovery-failed") return failure("recovery-failed", "creator successor recovery failed");
	return failure("storage-failed", "creator successor storage failed");
}

if (!installCreatorAdoptionStage(stageCreatorSuccessorAdoptionKernel)) {
	throw new TypeError("creator adoption stage owner was already installed");
}
if (!installCreatorAdoptionPublish(publishStagedCreatorSuccessorAdoptionKernel)) {
	throw new TypeError("creator adoption publish owner was already installed");
}
