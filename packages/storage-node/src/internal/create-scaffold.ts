import { type AheDurableStore, createMemoryAheDurableStore, type StoreCapabilities } from "@ts-drp/storage";
import { DatabaseSync } from "node:sqlite";

import type { SqliteAheDurableStoreOptions } from "../index.js";

export type SqliteMutationOperation = "beginGeneration";

export type SqliteMutationFault = (
	checkpoint: Readonly<{ readonly edge: "before-commit"; readonly operation: SqliteMutationOperation }>
) => void;

export type SqlitePragma = "foreign_keys" | "integrity_check" | "journal_mode" | "synchronous";

export type SqliteScaffoldInstrumentation = Readonly<{
	attemptInvalidForeignKeyInsert(): void;
	readPragma(pragma: SqlitePragma): unknown;
	store: AheDurableStore;
}>;

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
	return createInstrumentedSqliteScaffold(options, _fault).store;
}

/**
 * Creates the deliberately unconfigured RED scaffold and exposes bounded raw
 * connection probes to the non-exported test module. It owns a real SQLite
 * connection but no schema or persistence behavior.
 * @param options - SQLite construction options reserved by the contract.
 * @param _fault - Test-only mutation fault reserved by the transaction RED.
 * @returns The inert store and probes over its exact live connection.
 * @internal
 */
export function createInstrumentedSqliteScaffold(
	options: SqliteAheDurableStoreOptions,
	_fault?: SqliteMutationFault
): SqliteScaffoldInstrumentation {
	const connection = new DatabaseSync(options.filename);
	const delegate = createMemoryAheDurableStore();
	let connectionClosed = false;
	const store: AheDurableStore = {
		capabilities: STRICT_CAPABILITIES,
		readObjectState: (objectId) => delegate.readObjectState(objectId),
		getBlob: (digest) => delegate.getBlob(digest),
		beginGeneration: (input) => delegate.beginGeneration(input),
		putCachedBlob: (input) => delegate.putCachedBlob(input),
		promoteReference: (input) => delegate.promoteReference(input),
		completeGeneration: (input) => delegate.completeGeneration(input),
		swapHead: (input) => delegate.swapHead(input),
		discardGeneration: (input) => delegate.discardGeneration(input),
		close: async () => {
			await delegate.close();
			if (!connectionClosed) {
				connection.close();
				connectionClosed = true;
			}
		},
	};
	return {
		attemptInvalidForeignKeyInsert: (): void => {
			connection.exec(
				"CREATE TEMP TABLE phase_2c_parent(id INTEGER PRIMARY KEY);" +
					"CREATE TEMP TABLE phase_2c_child(parent_id INTEGER REFERENCES phase_2c_parent(id));"
			);
			try {
				connection.prepare("INSERT INTO phase_2c_child(parent_id) VALUES (?)").run(1);
			} finally {
				connection.exec("DROP TABLE phase_2c_child;DROP TABLE phase_2c_parent;");
			}
		},
		readPragma: (pragma): unknown => {
			const row = connection.prepare(`PRAGMA ${pragma}`).get();
			return row === undefined ? undefined : Object.values(row)[0];
		},
		store,
	};
}
