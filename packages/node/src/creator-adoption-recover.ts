import "./creator-adoption.js";

import {
	consumeCreatorAdoptionPendingRecovery,
	type CreatorAdoptionPendingRecoveryInput,
} from "./internal/creator-adoption-recover.js";

const INPUT_KEYS = Object.freeze([
	"authenticationProfile",
	"catalog",
	"detachedSignature",
	"exactCanonicalAnchorPreimageBytes",
	"exactCanonicalParametersCarrierBytes",
	"expectedNextRoomHead",
	"expectedPreviousRoomHead",
	"pinnedGenesisAnchorDigest",
	"snapshotDeclaration",
	"snapshotStore",
	"store",
]);

function capture(value: unknown): CreatorAdoptionPendingRecoveryInput | undefined {
	try {
		if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
			return undefined;
		}
		const keys = Reflect.ownKeys(value);
		if (keys.length !== INPUT_KEYS.length || keys.some((key) => typeof key !== "string" || !INPUT_KEYS.includes(key))) {
			return undefined;
		}
		const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
		for (const key of INPUT_KEYS) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) return undefined;
			output[key] = descriptor.value;
		}
		return output as unknown as CreatorAdoptionPendingRecoveryInput;
	} catch {
		return undefined;
	}
}

/**
 * Authenticates and publishes a provider-selected pending successor without live activation.
 * @param input - Exact copied provider heads, genesis carriers, snapshot owners and AHE store.
 * @returns Published stable room head or a typed fail-closed result.
 */
export function recoverPendingCreatorSuccessorAdoption(input: unknown): Promise<Readonly<Record<string, unknown>>> {
	const captured = capture(input);
	return captured === undefined
		? Promise.resolve(
				Object.freeze({
					detail: "creator adoption pending recovery input is invalid",
					kind: "malformed-input",
					ok: false,
				})
			)
		: consumeCreatorAdoptionPendingRecovery(captured);
}
