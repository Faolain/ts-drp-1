import { type AheDurableStore, createMemoryAheDurableStore, type StoreCapabilities } from "@ts-drp/storage";

import type { SqliteAheDurableStoreOptions } from "../index.js";

export type SqliteMutationOperation = "beginGeneration";

export type SqliteMutationFault = (
	checkpoint: Readonly<{ readonly edge: "before-commit"; readonly operation: SqliteMutationOperation }>
) => void;

const STRICT_CAPABILITIES: Readonly<StoreCapabilities> = Object.freeze({
	durability: "strict",
	signingEligibility: "backend-capability-required",
});

/**
 * Keeps the RED executable without implementing SQLite persistence or a second
 * lifecycle owner. GREEN must replace this adapter with the shared transition
 * owner backed by one real SQLite transaction.
 * @param options - SQLite construction options reserved by the contract.
 * @param _fault - Test-only mutation fault reserved by the transaction RED.
 * @returns An inert strict-labeled adapter over the public ephemeral model.
 * @internal
 */
export function createSqliteScaffold(
	options: SqliteAheDurableStoreOptions,
	_fault?: SqliteMutationFault
): AheDurableStore {
	void options.filename;
	const delegate = createMemoryAheDurableStore();
	return {
		capabilities: STRICT_CAPABILITIES,
		readObjectState: (objectId) => delegate.readObjectState(objectId),
		getBlob: (digest) => delegate.getBlob(digest),
		beginGeneration: (input) => delegate.beginGeneration(input),
		putCachedBlob: (input) => delegate.putCachedBlob(input),
		promoteReference: (input) => delegate.promoteReference(input),
		completeGeneration: (input) => delegate.completeGeneration(input),
		swapHead: (input) => delegate.swapHead(input),
		discardGeneration: (input) => delegate.discardGeneration(input),
		close: () => delegate.close(),
	};
}
