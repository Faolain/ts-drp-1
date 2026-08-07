import type { AheDurableStore } from "./types.js";

export type StoreContractFactory = () => AheDurableStore | Promise<AheDurableStore>;

export const STORE_CONTRACT_SCENARIOS = Object.freeze([
	Object.freeze({ id: "ephemeral-capability", branch: "common" }),
	Object.freeze({ id: "begin-cache-read-discard", branch: "common" }),
	Object.freeze({ id: "strict-transition-closure", branch: "strict" }),
] as const);

/**
 * Runs the 2a common branch without pretending that an ephemeral factory can
 * satisfy the frozen strict branch. Test wrappers own assertions and faults.
 * @param factory
 */
export async function runStoreContract(
	factory: StoreContractFactory
): Promise<Readonly<AheDurableStore["capabilities"]>> {
	const store = await factory();
	return store.capabilities;
}
