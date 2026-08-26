import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { inspectCreatorTrustAdvance } from "@ts-drp/control-plane/creator-trust-advance";
import type { CurrentAnchorTrust } from "@ts-drp/protocol-v3";
import { openCreatorSuccessorTrust } from "@ts-drp/protocol-v3/creator-close";
import {
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
	consumeCreatorAdoptionIntent,
	createPreparedCreatorSuccessorAdoption,
	type CreatorAdoptionIntentMaterial,
	type PreparedCreatorSuccessorAdoption,
	resolveCreatorAdoptionFacts,
} from "./internal/creator-adoption-intent.js";

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

interface SealedAdoptionFacts {
	readonly closeResult: CreatorLiveCloseResult;
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

type Candidate = Readonly<{ readonly bytes: Uint8Array; readonly ref: GenerationRef }>;
type Terminal =
	| Readonly<{ readonly head: PresentHead; readonly kind: "active-new" }>
	| Readonly<{ readonly head: PresentHead; readonly kind: "pending-old" }>
	| Readonly<{ readonly kind: "stale-head" }>
	| Readonly<{ readonly kind: "recovery-failed" }>
	| Readonly<{ readonly kind: "chain-invalid" }>;

function failure(kind: FailureKind, detail: string): CommitFailure {
	return Object.freeze({ detail, kind, ok: false as const });
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
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
	objectId: SealedAdoptionFacts["objectId"]
): Promise<readonly GenerationRecord[] | undefined> {
	const output: GenerationRecord[] = [];
	const cursors = new Set<GenerationPageCursor>();
	let cursor: GenerationPageCursor | undefined;
	for (;;) {
		const result = await store.readGenerationPage({
			...(cursor === undefined ? {} : { cursor }),
			limit: 128,
			objectId,
		});
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
	references: readonly GenerationRef[]
): Promise<readonly Candidate[] | undefined> {
	const candidates: Candidate[] = [];
	for (const ref of references) {
		const loaded = await store.getBlob(ref.digest);
		if (!loaded.ok || loaded.value === null || loaded.value.byteLength !== ref.byteLength) return undefined;
		const digest = digestBlob(loaded.value);
		if (!digest.ok || digest.value !== ref.digest) return undefined;
		candidates.push(Object.freeze({ bytes: Uint8Array.from(loaded.value), ref: Object.freeze({ ...ref }) }));
	}
	return Object.freeze(candidates);
}

function candidateBytes(candidates: readonly Candidate[], ref: GenerationRef): Uint8Array | undefined {
	return candidates.find((candidate) => sameRef(candidate.ref, ref))?.bytes;
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
	for (const generation of generations) {
		if (new Set(generation.closure.map(({ digest }) => digest)).size !== generation.closure.length) return false;
		if (
			generation.baseExpectedHead.kind === "present" &&
			(generation.baseExpectedHead.generationId === generation.generationId ||
				!byId.has(generation.baseExpectedHead.generationId))
		) {
			return false;
		}
	}
	return true;
}

function validProjection(material: CreatorAdoptionIntentMaterial): Readonly<Record<string, unknown>> | undefined {
	const descriptor = canonicalRecord(material.exactCanonicalProjectionBytes);
	if (descriptor?.kind !== "v3-live-generation-2") return undefined;
	const digest = digestBlob(material.exactCanonicalProjectionBytes);
	if (!digest.ok) return undefined;
	const projectionRef = Object.freeze({
		byteLength: material.exactCanonicalProjectionBytes.byteLength,
		digest: digest.value,
	});
	const derived = Object.freeze(
		[...material.pendingReferences.filter((ref) => !sameRef(ref, material.predecessorLiveRef)), projectionRef].sort(
			(left, right) => (left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0)
		)
	);
	return material.pendingReferences.filter((ref) => sameRef(ref, material.predecessorLiveRef)).length === 1 &&
		new Set(derived.map(({ digest: value }) => value)).size === derived.length &&
		sameClosure(derived, material.candidateReferences)
		? Object.freeze(descriptor)
		: undefined;
}

function validTrustChain(
	facts: SealedAdoptionFacts,
	currentCandidates: readonly Candidate[],
	pendingCandidates: readonly Candidate[]
): boolean {
	const cutBytes = candidateBytes(pendingCandidates, facts.closeResult.cutValueRef);
	const commitBytes = candidateBytes(pendingCandidates, facts.closeResult.commitQcRef);
	const successorTrustBytes = candidateBytes(pendingCandidates, facts.closeResult.successorTrustRef);
	const currentTrustBytes = candidateBytes(currentCandidates, facts.closeResult.currentTrustRef);
	if (
		cutBytes === undefined ||
		commitBytes === undefined ||
		successorTrustBytes === undefined ||
		currentTrustBytes === undefined
	) {
		return false;
	}
	const opened = openCreatorSuccessorTrust({
		currentTrust: facts.currentTrust,
		exactCanonicalCommitQcBytes: commitBytes,
		exactCanonicalCutValueBytes: cutBytes,
		exactCanonicalTrustStateRecordBytes: successorTrustBytes,
	});
	if (
		!opened.ok ||
		opened.trust.currentAnchorDigest !== facts.closeResult.successorAnchorDigest ||
		opened.trust.currentEpoch !== facts.closeResult.successorEpoch
	) {
		return false;
	}
	return inspectCreatorTrustAdvance({
		current: { candidates: currentCandidates, closure: facts.currentReferences },
		proofRefs: [facts.closeResult.cutValueRef, facts.closeResult.commitQcRef],
		proposed: { candidates: pendingCandidates, closure: facts.proposedReferences },
	}).ok;
}

async function authenticatedTerminal(
	facts: SealedAdoptionFacts,
	material: CreatorAdoptionIntentMaterial
): Promise<Terminal> {
	try {
		if (
			!sameHead(material.pendingHead, facts.proposedHead) ||
			!sameClosure(material.pendingReferences, facts.proposedReferences) ||
			material.pendingHead.objectId !== facts.objectId
		) {
			return Object.freeze({ kind: "chain-invalid" });
		}
		const recovered = await facts.store.recoverActiveGeneration(facts.objectId);
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
		if (
			active.adoptedGeneration.state !== "Adopted" ||
			!sameClosure(active.references, pending ? material.pendingReferences : material.candidateReferences) ||
			!sameClosure(
				active.adoptedGeneration.closure,
				pending ? material.pendingReferences : material.candidateReferences
			) ||
			!exactClosureDigest(active.references, active.head.closureDigest)
		) {
			return Object.freeze({ kind: "chain-invalid" });
		}
		const [generations, currentCandidates, pendingCandidates, activeCandidates] = await Promise.all([
			readLineage(facts.store, facts.objectId),
			loadClosure(facts.store, facts.currentReferences),
			loadClosure(facts.store, facts.proposedReferences),
			loadClosure(facts.store, pending ? material.pendingReferences : material.candidateReferences),
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
				sameRef(ref, material.predecessorLiveRef) && canonicalRecord(bytes)?.kind === "v3-live-generation-1"
		);
		return predecessor.length === 1
			? Object.freeze({ head: Object.freeze({ ...active.head }), kind: candidate ? "active-new" : "pending-old" })
			: Object.freeze({ kind: "chain-invalid" });
	} catch {
		return Object.freeze({ kind: "recovery-failed" });
	}
}

function successfulMutation(result: unknown): boolean {
	return record(result) && result.ok === true && Object.hasOwn(result, "value");
}

async function stageCandidate(facts: SealedAdoptionFacts, material: CreatorAdoptionIntentMaterial): Promise<void> {
	const scope = Object.freeze({ generationId: material.generationId, objectId: facts.objectId });
	if (
		!successfulMutation(
			await facts.store.beginGeneration({
				...scope,
				baseExpectedHead: material.pendingHead,
				closure: material.candidateReferences,
			})
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
			})
		)
	) {
		throw new TypeError("creator successor projection cache failed");
	}
	for (const ref of material.candidateReferences) {
		if (!successfulMutation(await facts.store.promoteReference({ ...scope, digest: ref.digest }))) {
			throw new TypeError("creator successor promotion failed");
		}
	}
	if (!successfulMutation(await facts.store.completeGeneration(scope))) {
		throw new TypeError("creator successor completion failed");
	}
	if (
		!successfulMutation(
			await facts.store.swapHead({
				...scope,
				expectedHead: material.pendingHead,
			})
		)
	) {
		throw new TypeError("creator successor head swap failed");
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

/**
 * Commits a verified creator successor with one durable head comparison-and-swap.
 * @param input - Genuine close handle and its owner-bound, one-use intent.
 * @returns Exact prepared successor or a closed failure.
 */
export async function commitCreatorSuccessorAdoption(input: unknown): Promise<CommitFailure | CommitSuccess> {
	const captured = captureInput(input);
	if (captured === undefined) return failure("malformed-input", "creator adoption commit input is invalid");
	const facts = resolveCreatorAdoptionFacts<SealedAdoptionFacts>(captured.handle);
	const material = consumeCreatorAdoptionIntent(captured.intent, captured.handle);
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
	try {
		await stageCandidate(facts, material);
	} catch {
		// A fresh authenticated reopen below is the only authority after an ambiguous write.
	}
	terminal = await authenticatedTerminal(facts, material);
	if (terminal.kind === "active-new") return success(captured.handle, material, descriptor, terminal.head);
	if (terminal.kind === "pending-old") return failure("pending-old", "creator successor remains safely pending");
	if (terminal.kind === "stale-head") return failure("stale-head", "creator successor head is stale");
	if (terminal.kind === "chain-invalid") return failure("chain-invalid", "creator successor chain is invalid");
	if (terminal.kind === "recovery-failed") return failure("recovery-failed", "creator successor recovery failed");
	return failure("storage-failed", "creator successor storage failed");
}
