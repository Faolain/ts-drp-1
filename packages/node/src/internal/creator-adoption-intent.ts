import { decodeCanonical } from "@ts-drp/canonical";
import type { GenerationId, GenerationRef, PresentHead } from "@ts-drp/storage";

export type CreatorAdoptionIntent = Readonly<Record<never, never>>;
export type PreparedCreatorSuccessorAdoption = Readonly<Record<never, never>>;

export interface CreatorAdoptionIntentMaterial {
	readonly candidateReferences: readonly GenerationRef[];
	readonly exactCanonicalProjectionBytes: Uint8Array;
	readonly generationId: GenerationId;
	readonly pendingHead: PresentHead;
	readonly pendingReferences: readonly GenerationRef[];
	readonly predecessorLiveRef: GenerationRef;
}

export interface PreparedCreatorSuccessorAdoptionMaterial {
	readonly descriptor: Readonly<Record<string, unknown>>;
	readonly exactCanonicalProjectionBytes: Uint8Array;
	readonly head: PresentHead;
}

export type PreparedCreatorSuccessorAdoptionInput = Omit<PreparedCreatorSuccessorAdoptionMaterial, "descriptor">;

const custody = new WeakMap<
	object,
	Readonly<{ readonly material: CreatorAdoptionIntentMaterial; readonly owner: object }>
>();
const sealedFacts = new WeakMap<object, object>();
const preparedCustody = new WeakMap<
	object,
	Readonly<{ readonly material: PreparedCreatorSuccessorAdoptionInput; readonly owner: object }>
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
			material: Object.freeze({
				candidateReferences: Object.freeze(material.candidateReferences.map(copiedRef)),
				exactCanonicalProjectionBytes: Uint8Array.from(material.exactCanonicalProjectionBytes),
				generationId: material.generationId,
				pendingHead: copiedHead(material.pendingHead),
				pendingReferences: Object.freeze(material.pendingReferences.map(copiedRef)),
				predecessorLiveRef: copiedRef(material.predecessorLiveRef),
			}),
			owner,
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
	if (retained === undefined || retained.owner !== owner) return undefined;
	custody.delete(intent);
	return Object.freeze({
		candidateReferences: Object.freeze(retained.material.candidateReferences.map(copiedRef)),
		exactCanonicalProjectionBytes: Uint8Array.from(retained.material.exactCanonicalProjectionBytes),
		generationId: retained.material.generationId,
		pendingHead: copiedHead(retained.material.pendingHead),
		pendingReferences: Object.freeze(retained.material.pendingReferences.map(copiedRef)),
		predecessorLiveRef: copiedRef(retained.material.predecessorLiveRef),
	});
}

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
		descriptor: decodedDescriptor(exactCanonicalProjectionBytes),
		exactCanonicalProjectionBytes,
		head: copiedHead(retained.material.head),
	});
}
