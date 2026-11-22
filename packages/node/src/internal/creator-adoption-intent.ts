import { decodeCanonical } from "@ts-drp/canonical";
import type { CurrentAnchorTrust } from "@ts-drp/protocol-v3";
import {
	AHE_BOUNDED_READ_LIMITS,
	type AheRetirementFutureMaterial,
	createAheRetirementControlRead,
	digestBlob,
	encodeGenerationRecordV1,
	type GenerationId,
	type GenerationRecord,
	type GenerationRef,
	type PresentHead,
} from "@ts-drp/storage";

import type { CreatorSuccessorLiveMaterial, CreatorSuccessorLiveSeed } from "./creator-successor-live.js";
import { resolveCreatorCheckpointAttachment } from "./creator-transition-advance.js";
import type { CreatorExpectedRoomHead } from "./creator-room-head.js";

export type CreatorAdoptionIntent = Readonly<Record<never, never>>;
export type PreparedCreatorSuccessorAdoption = Readonly<Record<never, never>>;
export type StagedCreatorSuccessorAdoption = Readonly<Record<never, never>>;

export interface CreatorAdoptionIntentMaterial {
	/** Same original custody entry after public intent consumption; not a new registry. */
	readonly nativeIntent?: CreatorAdoptionIntent;
	readonly activation: CreatorSuccessorLiveSeed;
	readonly candidateReferences: readonly GenerationRef[];
	readonly exactCanonicalProjectionBytes: Uint8Array;
	readonly generationId: GenerationId;
	readonly pendingHead: PresentHead;
	readonly pendingReferences: readonly GenerationRef[];
	readonly predecessorLiveRef: GenerationRef;
}

export interface PreparedCreatorSuccessorAdoptionMaterial {
	readonly activation: CreatorSuccessorLiveMaterial;
	readonly descriptor: Readonly<Record<string, unknown>>;
	readonly exactCanonicalProjectionBytes: Uint8Array;
	readonly head: PresentHead;
}

export type PreparedCreatorSuccessorAdoptionInput = Omit<PreparedCreatorSuccessorAdoptionMaterial, "descriptor">;

export interface StagedCreatorSuccessorAdoptionMaterial {
	readonly descriptor: Readonly<Record<string, unknown>>;
	readonly intent: CreatorAdoptionIntentMaterial;
}

const custody = new WeakMap<
	object,
	| {
			readonly kind: "adoption";
			readonly material: CreatorAdoptionIntentMaterial;
			readonly owner: object;
			consumed: boolean;
			ready?: "stage" | "publish";
			stageUsed: boolean;
			publishUsed: boolean;
	  }
	| {
			readonly kind: "authenticated-native-future";
			readonly owner: object;
			readonly store: object;
			readonly trust: CurrentAnchorTrust;
			readonly material: AheRetirementFutureMaterial;
			stageUsed: boolean;
			publishUsed: boolean;
	  }
>();
const sealedFacts = new WeakMap<object, object>();
const preparedCustody = new WeakMap<
	object,
	Readonly<{ readonly material: PreparedCreatorSuccessorAdoptionInput; readonly owner: object }>
>();
const stagedCustody = new WeakMap<
	object,
	Readonly<{ readonly material: StagedCreatorSuccessorAdoptionMaterial; readonly owner: object }>
>();

function copiedRef(ref: GenerationRef): GenerationRef {
	return Object.freeze({ byteLength: ref.byteLength, digest: ref.digest });
}

function copiedHead(head: PresentHead): PresentHead {
	return Object.freeze({ ...head });
}

function decodedDescriptor(bytes: Uint8Array): Readonly<Record<string, unknown>> {
	const decoded = decodeCanonical(bytes);
	if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
		throw new TypeError("prepared creator successor descriptor is invalid");
	}
	return Object.freeze(decoded as Record<string, unknown>);
}

/**
 * Retains facts authenticated by a genuine close behind the internal module boundary.
 * @param owner - Genuine sealed close handle.
 * @param facts - Private detached close facts.
 * @returns Whether this was the first installation for the owner.
 */
export function installCreatorAdoptionFacts(owner: object, facts: object): boolean {
	if (sealedFacts.has(owner)) return false;
	sealedFacts.set(owner, facts);
	return true;
}

/**
 * Resolves private close facts for the verifier without exposing them on a public export.
 * @param owner - Candidate genuine sealed close handle.
 * @returns Private facts, or undefined for an unknown handle.
 */
export function resolveCreatorAdoptionFacts<T extends object>(owner: object): T | undefined {
	return sealedFacts.get(owner) as T | undefined;
}

/**
 * Revokes the predecessor's private verifier facts after successor activation.
 * @param owner - Genuine sealed predecessor handle.
 * @returns Whether private facts were present and revoked.
 */
export function revokeCreatorAdoptionFacts(owner: object): boolean {
	return sealedFacts.delete(owner);
}

/**
 * Creates one opaque, owner-bound, destructively consumable adoption intent.
 * @param owner - Genuine close handle that owns consumption.
 * @param material - Detached verified successor projection.
 * @returns Opaque intent with no serializable authority.
 */
export function createCreatorAdoptionIntent(
	owner: object,
	material: CreatorAdoptionIntentMaterial
): CreatorAdoptionIntent {
	const intent = Object.freeze({}) as CreatorAdoptionIntent;
	custody.set(
		intent,
		Object.freeze({
			kind: "adoption" as const,
			material: Object.freeze({
				activation: material.activation,
				candidateReferences: Object.freeze(material.candidateReferences.map(copiedRef)),
				exactCanonicalProjectionBytes: Uint8Array.from(material.exactCanonicalProjectionBytes),
				generationId: material.generationId,
				pendingHead: copiedHead(material.pendingHead),
				pendingReferences: Object.freeze(material.pendingReferences.map(copiedRef)),
				predecessorLiveRef: copiedRef(material.predecessorLiveRef),
			}),
			owner,
			consumed: false,
			stageUsed: false,
			publishUsed: false,
		})
	);
	return intent;
}

/**
 * Consumes a genuine intent exactly once when presented by its bound close handle.
 * @param intent - Opaque candidate intent.
 * @param owner - Expected genuine close handle.
 * @returns Detached verified projection material, or undefined.
 */
export function consumeCreatorAdoptionIntent(
	intent: unknown,
	owner: unknown
): CreatorAdoptionIntentMaterial | undefined {
	if (intent === null || typeof intent !== "object" || owner === null || typeof owner !== "object") return undefined;
	const retained = custody.get(intent);
	if (retained === undefined || retained.kind !== "adoption" || retained.owner !== owner || retained.consumed)
		return undefined;
	custody.set(intent, { ...retained, consumed: true });
	return Object.freeze({
		nativeIntent: intent as CreatorAdoptionIntent,
		activation: retained.material.activation,
		candidateReferences: Object.freeze(retained.material.candidateReferences.map(copiedRef)),
		exactCanonicalProjectionBytes: Uint8Array.from(retained.material.exactCanonicalProjectionBytes),
		generationId: retained.material.generationId,
		pendingHead: copiedHead(retained.material.pendingHead),
		pendingReferences: Object.freeze(retained.material.pendingReferences.map(copiedRef)),
		predecessorLiveRef: copiedRef(retained.material.predecessorLiveRef),
	});
}

/**
 * Called only after the original commit owner's authenticated terminal/staged checks.
 * @param material
 * @param store
 * @param phase
 */
export function authorizeCreatorAdoptionNativeFuture(
	material: CreatorAdoptionIntentMaterial,
	store: object,
	phase: "stage" | "publish"
): boolean {
	const capability = material.nativeIntent,
		facts = capability && custody.get(capability);
	if (
		!capability ||
		!facts ||
		facts.kind !== "adoption" ||
		!facts.consumed ||
		facts.material.activation.store !== store ||
		material.activation !== facts.material.activation ||
		material.generationId !== facts.material.generationId ||
		(phase === "stage" ? facts.stageUsed : facts.publishUsed)
	)
		return false;
	const original = sealedFacts.get(facts.owner);
	if (!original || Object.getOwnPropertyDescriptor(original, "store")?.value !== store) return false;
	custody.set(capability, { ...facts, ready: phase });
	return true;
}

/** Original commit owner calls only AFTER authenticatedStaged proves this exact
 * durable nominee. Retargets the same consumed custody entry; no replay or new registry.
 */
export function rebindCreatorAdoptionNativeNominee(
	material: CreatorAdoptionIntentMaterial,
	store: object,
	generationId: GenerationId
): CreatorAdoptionIntentMaterial | undefined {
	if (!authorizeCreatorAdoptionNativeFuture(material, store, "stage")) return undefined;
	const capability = material.nativeIntent,
		facts = capability && custody.get(capability);
	if (!capability || !facts || facts.kind !== "adoption" || facts.publishUsed) return undefined;
	custody.set(capability, { ...facts, ready: undefined, material: Object.freeze({ ...facts.material, generationId }) });
	return Object.freeze({ ...material, generationId });
}

function adoptionFutureMaterial(material: CreatorAdoptionIntentMaterial, store: object): AheRetirementFutureMaterial | undefined {
	const m = material,
		closure = m.candidateReferences,
		blobs = new Map<string, { ref: GenerationRef; bytes: Uint8Array }>();
	for (const bytes of [
		m.exactCanonicalProjectionBytes,
		m.activation.predecessorExactCanonicalLatchedAclBytes,
		...(m.activation.origin === "received" ? m.activation.successor.candidates.map((c) => c.bytes) : []),
	]) {
		const actual = digestBlob(bytes);
		if (!actual.ok) return undefined;
		const ref = closure.find((r) => r.digest === actual.value);
		if (ref) {
			if (ref.byteLength !== bytes.byteLength) return undefined;
			blobs.set(ref.digest, { ref: copiedRef(ref), bytes: Uint8Array.from(bytes) });
		}
	}
	return {
		objectId: m.activation.store === store ? m.pendingHead.objectId : m.activation.predecessor.head.objectId,
		epoch: m.activation.successor.trust.currentEpoch,
		generationId: m.generationId,
		baseExpectedHead: copiedHead(m.pendingHead),
		closure: closure.map(copiedRef),
		blobs: [...blobs.values()],
	};
}

/** Reads an already-used original native intent for exact source readback only. */
export function resolveCreatorAdoptionOwnedNomination(
	material: CreatorAdoptionIntentMaterial,
	store: object,
	phase: "stage" | "publish"
): AheRetirementFutureMaterial | undefined {
	if (phase !== "stage" && phase !== "publish") return undefined;
	const facts = material.nativeIntent && custody.get(material.nativeIntent);
	if (!facts || facts.kind !== "adoption" || !facts.consumed ||
		facts.material.activation !== material.activation || facts.material.activation.store !== store ||
		facts.material.generationId !== material.generationId ||
		(!(phase === "stage" ? facts.stageUsed : facts.publishUsed) && facts.ready !== phase) ||
		Object.getOwnPropertyDescriptor(sealedFacts.get(facts.owner) ?? {}, "store")?.value !== store)
		return undefined;
	return adoptionFutureMaterial(facts.material, store);
}

/**
 * Internal authenticated-owner composition only: successor trust and accepted closure
 * were authenticated by the original close or pending-recovery path. Native adapters
 * do not verify that premise.
 * This retains a distinct purpose in the same custody map, without premature sealed facts.
 * @param input
 */
export function createCreatorAuthenticatedNativeFuture(
	input: Readonly<{
		owner: object;
		store: object;
		successorTrust: CurrentAnchorTrust;
		currentHead: PresentHead;
		generationId: GenerationId;
		acceptedClosure: readonly GenerationRef[];
		newBlobs: readonly Readonly<{ ref: GenerationRef; bytes: Uint8Array }>[];
		existingCompleteGeneration?: GenerationRecord;
	}>
): CreatorAdoptionIntent {
	if (
		input.acceptedClosure.length > AHE_BOUNDED_READ_LIMITS.maxClosureReferences ||
		input.newBlobs.length > AHE_BOUNDED_READ_LIMITS.maxClosureReferences ||
		input.newBlobs.reduce((sum, b) => sum + b.bytes.byteLength, 0) > AHE_BOUNDED_READ_LIMITS.maxUnionBytes
	)
		throw new TypeError("local close future material exceeds native budget");
	const existing = input.existingCompleteGeneration;
	const existingDigest = existing === undefined ? undefined : digestBlob(encodeGenerationRecordV1(existing));
	if (existing !== undefined &&
		(existing.state !== "Complete" || existing.objectId !== input.currentHead.objectId ||
			existing.generationId !== input.generationId || input.newBlobs.length !== 0 ||
			existingDigest?.ok !== true))
		throw new TypeError("authenticated existing future generation differs");
	const capability = Object.freeze({}) as CreatorAdoptionIntent;
	custody.set(capability, {
		kind: "authenticated-native-future",
		owner: input.owner,
		store: input.store,
		trust: input.successorTrust,
		material: Object.freeze({
			objectId: input.currentHead.objectId,
			epoch: input.successorTrust.currentEpoch,
			generationId: input.generationId,
			baseExpectedHead: copiedHead(input.currentHead),
			closure: Object.freeze(input.acceptedClosure.map(copiedRef)),
			blobs: Object.freeze(
				input.newBlobs.map((b) => Object.freeze({ ref: copiedRef(b.ref), bytes: Uint8Array.from(b.bytes) }))
			),
			...(existingDigest?.ok === true ? {existingGenerationRecordDigest: existingDigest.value} : {}),
		}),
		stageUsed: false,
		publishUsed: false,
	});
	return capability;
}

const installFuture = Reflect.get(createAheRetirementControlRead, "installCreatorFutureGenerationResolver");
if (
	typeof installFuture !== "function" ||
	!Reflect.apply(installFuture, createAheRetirementControlRead, [
		(capability: unknown, store: object, phase: "stage" | "publish"): AheRetirementFutureMaterial | undefined => {
			if (capability === null || typeof capability !== "object") return undefined;
			const facts = custody.get(capability);
			if (facts?.kind === "authenticated-native-future") {
				if (facts.store !== store || (phase === "stage" ? facts.stageUsed : !facts.stageUsed || facts.publishUsed))
					return undefined;
				custody.set(capability, { ...facts, ...(phase === "stage" ? { stageUsed: true } : { publishUsed: true }) });
				return facts.material;
			}
			if (
				!facts ||
				facts.kind !== "adoption" ||
				!facts.consumed ||
				facts.ready !== phase ||
				facts.material.activation.store !== store ||
				(phase === "stage" ? facts.stageUsed : facts.publishUsed)
			)
				return undefined;
			custody.set(capability, {
				...facts,
				ready: undefined,
				...(phase === "stage" ? { stageUsed: true } : { publishUsed: true }),
			});
			return adoptionFutureMaterial(facts.material, store);
		},
	])
)
	throw new TypeError("creator native future resolver is unavailable or already owned");

/**
 * Creates one opaque successor-preparation capability for the later activation owner.
 * @param owner - Genuine sealed close handle.
 * @param material - Authenticated durable successor result.
 * @returns Opaque process-local capability.
 */
export function createPreparedCreatorSuccessorAdoption(
	owner: object,
	material: PreparedCreatorSuccessorAdoptionInput
): PreparedCreatorSuccessorAdoption {
	const capability = Object.freeze({}) as PreparedCreatorSuccessorAdoption;
	preparedCustody.set(
		capability,
		Object.freeze({
			material: Object.freeze({
				activation: material.activation,
				exactCanonicalProjectionBytes: Uint8Array.from(material.exactCanonicalProjectionBytes),
				head: copiedHead(material.head),
			}),
			owner,
		})
	);
	return capability;
}

/**
 * Destructively consumes one genuine successor-preparation capability.
 * @param capability - Opaque candidate capability.
 * @param owner - Genuine sealed close owner.
 * @returns Detached successor material, or undefined.
 */
export function consumePreparedCreatorSuccessorAdoption(
	capability: unknown,
	owner: unknown
): PreparedCreatorSuccessorAdoptionMaterial | undefined {
	if (capability === null || typeof capability !== "object" || owner === null || typeof owner !== "object") {
		return undefined;
	}
	const retained = preparedCustody.get(capability);
	if (retained === undefined || retained.owner !== owner) return undefined;
	preparedCustody.delete(capability);
	const exactCanonicalProjectionBytes = Uint8Array.from(retained.material.exactCanonicalProjectionBytes);
	return Object.freeze({
		activation: retained.material.activation,
		descriptor: decodedDescriptor(exactCanonicalProjectionBytes),
		exactCanonicalProjectionBytes,
		head: copiedHead(retained.material.head),
	});
}

/**
 * Creates one opaque owner-bound capability for a complete unpublished successor.
 * @param owner - Genuine sealed close handle.
 * @param material - Authenticated staged successor material.
 * @returns Opaque process-local staged capability.
 */
export function createStagedCreatorSuccessorAdoption(
	owner: object,
	material: StagedCreatorSuccessorAdoptionMaterial
): StagedCreatorSuccessorAdoption {
	const capability = Object.freeze({}) as StagedCreatorSuccessorAdoption;
	stagedCustody.set(
		capability,
		Object.freeze({
			material: Object.freeze({
				descriptor: Object.freeze({ ...material.descriptor }),
				intent: material.intent,
			}),
			owner,
		})
	);
	return capability;
}

/**
 * Destructively consumes one genuine staged capability for its bound close handle.
 * @param capability - Opaque staged capability candidate.
 * @param owner - Expected genuine close handle.
 * @returns Authenticated staged material, or undefined.
 */
export function consumeStagedCreatorSuccessorAdoption(
	capability: unknown,
	owner: unknown
): StagedCreatorSuccessorAdoptionMaterial | undefined {
	if (capability === null || typeof capability !== "object" || owner === null || typeof owner !== "object") {
		return undefined;
	}
	const retained = stagedCustody.get(capability);
	if (retained === undefined || retained.owner !== owner) return undefined;
	stagedCustody.delete(capability);
	return Object.freeze({
		descriptor: Object.freeze({ ...retained.material.descriptor }),
		intent: retained.material.intent,
	});
}

/** A floor jump requires the original unconsumed, owner-bound staged checkpoint. */
export function permitsStagedCreatorCheckpointFloorAdvance(
	capability: unknown,
	owner: unknown,
	previous: CreatorExpectedRoomHead,
	next: CreatorExpectedRoomHead
): boolean {
	if (capability === null || typeof capability !== "object" || owner === null || typeof owner !== "object") return false;
	const staged = stagedCustody.get(capability);
	if (staged === undefined || staged.owner !== owner) return false;
	const activation = staged.material.intent.activation;
	const point = activation.checkpoint === undefined ? undefined : resolveCreatorCheckpointAttachment(activation.checkpoint);
	return point !== undefined && point.localBase.trust === activation.predecessor.trust &&
		previous.objectId === point.localBase.trust.objectId && previous.epoch === point.localBase.trust.currentEpoch &&
		previous.currentAnchorDigest === point.localBase.trust.currentAnchorDigest &&
		next.objectId === point.target.trust.objectId && next.epoch === point.target.trust.currentEpoch &&
		next.currentAnchorDigest === point.target.trust.currentAnchorDigest;
}
