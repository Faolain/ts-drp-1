import type { DurableIssuanceRetirementControlRead } from "@ts-drp/issuance-store/maintenance";
import type { LiveJournalRetirementControlRead, LiveJournalRetirementResult } from "@ts-drp/live-journal";
import type { SigningRetirementObservation } from "@ts-drp/seal/internal/storage-port";
import type { AheDurableStore, AheRetirementControlRead, StorageObjectId, StoreResult } from "@ts-drp/storage";
import type { AheReclamationMaintenance } from "@ts-drp/storage/maintenance";
import type { SnapshotRetirementControlRead } from "@ts-drp/storage/snapshot-transfer";

import { browserAheReclamationMaintenanceForStore } from "./internal/ahe-reclamation.js";
import {
	acquireBrowserRoomIssuanceRetirement,
	acquireBrowserRoomIssuanceStoreRetirement,
} from "./internal/browser-issuance-store.js";
import {
	acquireBrowserRoomAheRetirement,
	type BrowserAheDurableStore,
	createBrowserRoomAheDurableStore as createRoomAheStore,
} from "./internal/idb-adapter.js";
import { openRoomRetirementSession } from "./internal/native-read-reservation.js";
import { prepareBrowserRoomDatabase as prepareRoomDatabase } from "./internal/schema-idb.js";
import { acquireBrowserRoomSigningRetirement, browserRoomSigningStore } from "./internal/signing-retirement.js";
import { acquireBrowserRoomJournalRetirement } from "./live-journal.js";
import { acquireBrowserRoomSnapshotRetirement } from "./snapshot-transfer.js";

// Slice 14a: every room-mode owner factory from the module that owns the room retirement
// session, so a host that opens its room owners here shares one set of owner registries
// with the session, however the subpaths are bundled.
export { createBrowserRoomDurableIssuanceStore } from "./issuance.js";
export { createBrowserRoomLiveJournalStore } from "./live-journal.js";
export {
	openBrowserRoomSealEvidenceStore,
	openBrowserRoomSealSigningStore,
	openBrowserRoomSealVoteStore,
} from "./seal-signing.js";
export { createBrowserRoomSnapshotQuarantineStore } from "./snapshot-transfer.js";

/**
 * Resolves reclamation authority only for the exact genuine browser AHE facade.
 * @param store - Candidate ordinary AHE facade.
 * @returns Its browser-owned maintenance capability when identity matches.
 */
export function resolveBrowserAheReclamationMaintenance(store: AheDurableStore): AheReclamationMaintenance | undefined {
	return browserAheReclamationMaintenanceForStore(store);
}

/**
 * Slice 14a: creates or upgrades one room database to the version-7 layout. Owners
 * open only a ready room database; a migrating layout is refused by every owner.
 * @param input - The room database name.
 * @param input.databaseName - The room database name.
 * @returns The layout state.
 */
export function prepareBrowserRoomDatabase(input: Readonly<{ databaseName: string }>): Promise<unknown> {
	return prepareRoomDatabase(input);
}

/**
 * Slice 14a: the AHE durable store inside a ready room database (`ahe:` namespace).
 * @param options - The room database name.
 * @param options.databaseName - The room database name.
 * @returns The strict AHE durable-store adapter over its own room connection.
 */
export function createBrowserRoomAheDurableStore(
	options: Readonly<{ databaseName: string }>
): Promise<BrowserAheDurableStore> {
	return createRoomAheStore(options);
}

/**
 * Slice 14a: one room retirement session. Each owner's original retirement read and
 * transitions run on the session's strict transaction over the whole room database;
 * the session commits at a checkpoint or at the end, whole or not at all.
 */
export interface BrowserRoomRetirement {
	/** The original AHE retirement read of a genuine room-mode AHE store of this database. */
	acquireAhe(store: AheDurableStore, objectId: StorageObjectId): Promise<StoreResult<AheRetirementControlRead>>;
	/** The original snapshot retirement read of a genuine room-mode snapshot owner of this database. */
	acquireSnapshot(store: unknown, input: Readonly<{ objectId: string }>): Promise<SnapshotRetirementControlRead>;
	/** The original journal retirement result of a genuine room-mode journal of this database. */
	acquireJournal(
		store: unknown,
		input: Readonly<{ objectId: string }>
	): Promise<LiveJournalRetirementResult<LiveJournalRetirementControlRead>>;
	/**
	 * The original issuance retirement read over this database's issuance namespace.
	 * @param input - Exact addressed object.
	 * @param store - A genuine room-mode issuance store of this database; its lifetime
	 * and held-view refusals then apply, exactly as on its ordinary path.
	 */
	acquireIssuance(
		input: Readonly<{ objectId: string }>,
		store?: unknown
	): Promise<DurableIssuanceRetirementControlRead>;
	/**
	 * The original signing retirement observation over this database's signing stores.
	 * @param input - Exact addressed object.
	 * @param recovery - Received recovery may own a never-signing address.
	 * @param store - A genuine room-mode vote or evidence facet of this database; its
	 * captured incarnation is then required, exactly as on its ordinary path.
	 */
	acquireSigning(
		input: Readonly<{ objectId: string }>,
		recovery?: boolean,
		store?: unknown
	): Promise<SigningRetirementObservation>;
	/** Commits the current transaction strictly; a later acquisition opens a new one. */
	checkpoint(): Promise<void>;
	/** Commits the current transaction and ends the session. */
	commit(): Promise<void>;
	/** Discards every write since the last checkpoint and ends the session. */
	abort(cause?: unknown): Promise<void>;
}

/**
 * Slice 14a: opens one retirement session on a ready room database.
 * @param input - The room database name.
 * @param input.databaseName - The room database name.
 * @returns The session; it refuses a missing, migrating or foreign database.
 */
export async function openBrowserRoomRetirement(
	input: Readonly<{ databaseName: string }>
): Promise<BrowserRoomRetirement> {
	if (input === null || typeof input !== "object" || typeof input.databaseName !== "string")
		throw new TypeError("INVALID_ARGUMENT");
	const databaseName = input.databaseName;
	const session = await openRoomRetirementSession({ databaseName });
	return Object.freeze({
		acquireAhe: async (store: AheDurableStore, objectId: StorageObjectId) =>
			(await acquireBrowserRoomAheRetirement(
				store,
				databaseName,
				session,
				objectId
			)) as StoreResult<AheRetirementControlRead>,
		acquireSnapshot: async (store: unknown, request: Readonly<{ objectId: string }>) =>
			acquireBrowserRoomSnapshotRetirement(store, databaseName, session, request),
		acquireJournal: async (store: unknown, request: Readonly<{ objectId: string }>) =>
			acquireBrowserRoomJournalRetirement(store, databaseName, session, request),
		acquireIssuance: async (request: Readonly<{ objectId: string }>, store?: unknown) =>
			store === undefined
				? acquireBrowserRoomIssuanceRetirement(session, request)
				: acquireBrowserRoomIssuanceStoreRetirement(store, databaseName, session, request),
		acquireSigning: async (request: Readonly<{ objectId: string }>, recovery?: boolean, store?: unknown) => {
			let incarnation: string | undefined;
			if (store !== undefined) {
				const owner = browserRoomSigningStore(store);
				if (owner === undefined || owner.databaseName !== databaseName) throw new TypeError("RETENTION_FOREIGN_OWNER");
				if (owner.isClosed()) throw new Error("STORE_CLOSED");
				incarnation = owner.incarnation;
			}
			return acquireBrowserRoomSigningRetirement(session, request, recovery ?? false, incarnation);
		},
		checkpoint: () => session.checkpoint(),
		commit: () => session.commit(),
		abort: (cause?: unknown) => session.abort(cause),
	});
}
