export type CreatorAdoptionIntent = Readonly<Record<never, never>>;

export interface CreatorAdoptionIntentMaterial {
	readonly exactCanonicalProjectionBytes: Uint8Array;
}

const custody = new WeakMap<
	object,
	Readonly<{ readonly material: CreatorAdoptionIntentMaterial; readonly owner: object }>
>();
const sealedFacts = new WeakMap<object, object>();

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
				exactCanonicalProjectionBytes: Uint8Array.from(material.exactCanonicalProjectionBytes),
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
		exactCanonicalProjectionBytes: Uint8Array.from(retained.material.exactCanonicalProjectionBytes),
	});
}
