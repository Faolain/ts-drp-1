import type { DurableIssuanceRetirementControlRead } from "@ts-drp/issuance-store/maintenance";
import type { LiveJournalRetirementControlRead, LiveJournalRetirementResult } from "@ts-drp/live-journal";
import type { SigningRetirementObservation } from "@ts-drp/seal/internal/storage-port";
import type { AheDurableStore, AheRetirementControlRead, StorageObjectId, StoreResult } from "@ts-drp/storage";
import type { AheReclamationMaintenance } from "@ts-drp/storage/maintenance";
import {
	type RoomRetentionApplied,
	type RoomRetentionLabels,
	type RoomRetentionPlanned,
	type RoomRetentionSelection,
	type RoomRetentionTransactionLimits,
} from "@ts-drp/storage/room-head";
import type { SnapshotRetirementControlRead } from "@ts-drp/storage/snapshot-transfer";

import { aheRetentionSection, browserAheReclamationMaintenanceForStore } from "./internal/ahe-reclamation.js";
import {
	acquireBrowserRoomIssuanceRetirement,
	acquireBrowserRoomIssuanceStoreRetirement,
	browserRoomIssuanceRetentionSection,
} from "./internal/browser-issuance-store.js";
import {
	acquireBrowserRoomAheRetirement,
	type BrowserAheDurableStore,
	createBrowserRoomAheDurableStore as createRoomAheStore,
	isBrowserRoomAheStore,
} from "./internal/idb-adapter.js";
import { openRoomRetirementSession } from "./internal/native-read-reservation.js";
import { applyRoomRetention, planRoomRetention, type RoomRetentionSections } from "./internal/room-retention.js";
import { prepareBrowserRoomDatabase as prepareRoomDatabase } from "./internal/schema-idb.js";
import {
	acquireBrowserRoomSigningRetirement,
	browserRoomSigningRetentionSection,
	browserRoomSigningStore,
} from "./internal/signing-retirement.js";
import { acquireBrowserRoomJournalRetirement, browserRoomJournalRetentionSection } from "./live-journal.js";
import { acquireBrowserRoomSnapshotRetirement, browserRoomSnapshotRetentionSection } from "./snapshot-transfer.js";

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
	/**
	 * Slice 14b: plans one retention decision on the session's current transaction. Every
	 * owner section reads and charges its own rows; nothing is written.
	 * @param owners - The genuine room owners of this database the decision acts for.
	 * @param selection - The planner's selection.
	 * @param limits - Lowered per-transaction bounds (tests).
	 */
	planRetention(
		owners: BrowserRoomRetentionOwners,
		selection: RoomRetentionSelection,
		limits?: RoomRetentionTransactionLimits
	): Promise<RoomRetentionPlanned>;
	/**
	 * Slice 14b step B: re-plans the same selection inside the acting strict transaction,
	 * requires the planned decision digest, charges every byte before the first write, and
	 * writes every owner's deletes, rewrites and target control. The caller commits.
	 * @param owners - The genuine room owners of this database the decision acts for.
	 * @param selection - The planned selection.
	 * @param labels - The decision's labels (the floor fence already carries them).
	 * @param options - Lowered bounds (tests) and the creator's snapshot turnover authority.
	 */
	applyRetention(
		owners: BrowserRoomRetentionOwners,
		selection: RoomRetentionSelection,
		labels: RoomRetentionLabels,
		options?: Readonly<{
			limits?: RoomRetentionTransactionLimits;
			snapshotAuthority?: Readonly<{ capability: object; custody: object }>;
		}>
	): Promise<RoomRetentionApplied>;
	/** Commits the current transaction strictly; a later acquisition opens a new one. */
	checkpoint(): Promise<void>;
	/** Commits the current transaction and ends the session. */
	commit(): Promise<void>;
	/** Discards every write since the last checkpoint and ends the session. */
	abort(cause?: unknown): Promise<void>;
}

/** The genuine room owners one retention decision acts for (slice 14b). */
export interface BrowserRoomRetentionOwners {
	readonly ahe: AheDurableStore;
	readonly snapshot: unknown;
	readonly journal: unknown;
	/** A genuine room issuance store of this database, when the caller holds one. */
	readonly issuance?: unknown;
	/** A genuine room signing facet of this database, when the caller holds one. */
	readonly signing?: unknown;
}

/**
 * Slice 14b: the AHE retention section, for a genuine room-mode AHE store of this room
 * database only (composed here so the package root's declarations do not reach it).
 * @param store - Candidate AHE store.
 * @param databaseName - The session's room database.
 * @returns The section.
 */
function browserRoomAheRetentionSection(store: unknown, databaseName: string): RoomRetentionSections["ahe"] {
	if (!isBrowserRoomAheStore(store, databaseName)) throw new TypeError("RETENTION_FOREIGN_OWNER");
	return aheRetentionSection;
}

function retentionSections(
	databaseName: string,
	owners: BrowserRoomRetentionOwners,
	snapshotAuthority?: Readonly<{ capability: object; custody: object }>
): RoomRetentionSections {
	if (owners === null || typeof owners !== "object") throw new TypeError("INVALID_ARGUMENT");
	return Object.freeze({
		snapshot: browserRoomSnapshotRetentionSection(owners.snapshot, databaseName, snapshotAuthority),
		journal: browserRoomJournalRetentionSection(owners.journal, databaseName),
		signing: browserRoomSigningRetentionSection(databaseName, owners.signing),
		ahe: browserRoomAheRetentionSection(owners.ahe, databaseName),
		issuance: browserRoomIssuanceRetentionSection(databaseName, owners.issuance),
	});
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
		planRetention: async (
			owners: BrowserRoomRetentionOwners,
			selection: RoomRetentionSelection,
			limits?: RoomRetentionTransactionLimits
		) => planRoomRetention(session, retentionSections(databaseName, owners), selection, limits),
		applyRetention: async (
			owners: BrowserRoomRetentionOwners,
			selection: RoomRetentionSelection,
			labels: RoomRetentionLabels,
			options?: Readonly<{
				limits?: RoomRetentionTransactionLimits;
				snapshotAuthority?: Readonly<{ capability: object; custody: object }>;
			}>
		) =>
			applyRoomRetention(
				session,
				retentionSections(databaseName, owners, options?.snapshotAuthority),
				selection,
				labels,
				options?.limits
			),
		checkpoint: () => session.checkpoint(),
		commit: () => session.commit(),
		abort: (cause?: unknown) => session.abort(cause),
	});
}
