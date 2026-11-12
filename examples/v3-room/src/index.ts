import {
	type CreateV3RoomSessionInput as HostRoomInput,
	createV3RoomSession as openHostRoom,
	type V3RoomHeadInitialization,
	type V3RoomProjectionAuthority,
	type V3RoomSession,
} from "@ts-drp/node/v3-room";
import type { V3RoomStorageHost } from "@ts-drp/node/v3-room-host";
import { createBrowserAheDurableStore } from "@ts-drp/storage-browser";
import { createBrowserDurableIssuanceStore } from "@ts-drp/storage-browser/issuance";
import { createBrowserDurableLiveJournalStore } from "@ts-drp/storage-browser/live-journal";
// Every room-mode owner comes from the module that owns the room retirement session.
import {
	createBrowserRoomAheDurableStore,
	createBrowserRoomDurableIssuanceStore,
	createBrowserRoomLiveJournalStore,
	createBrowserRoomSnapshotQuarantineStore,
	openBrowserRoomRetirement,
	openBrowserRoomSealEvidenceStore,
	openBrowserRoomSealSigningStore,
	openBrowserRoomSealVoteStore,
	prepareBrowserRoomDatabase,
} from "@ts-drp/storage-browser/maintenance";
import { createBrowserRoomHeadAuthority } from "@ts-drp/storage-browser/room-head";
import { openBrowserSealEvidenceStore } from "@ts-drp/storage-browser/seal-evidence";
import { openBrowserSealSigningStore } from "@ts-drp/storage-browser/seal-signing";
import { openBrowserSealVoteStore } from "@ts-drp/storage-browser/seal-vote";
import { createBrowserSnapshotQuarantineStore } from "@ts-drp/storage-browser/snapshot-transfer";

export {
	createV3RoomCreatorInviteMaterial,
	V3_ROOM_CREATOR_RESTORE_ANSWER_BOUND_MS,
	V3_ROOM_CREATOR_RESTORE_CURRENCY_BOUND_MS,
	V3_ROOM_CREATOR_RESTORE_HOLD_MS,
	V3_ROOM_LOCAL_BACKLOG_LIMIT,
	V3RoomLocalBacklogFull,
	V3RoomNotYetCurrent,
	waitForV3RoomStartupForDiagnostics,
} from "@ts-drp/node/v3-room";
export type {
	V3RoomAcceptedOperation,
	V3RoomAcceptedVertex,
	V3RoomApplication,
	V3RoomAuthenticatedProjectionBase,
	V3RoomCreatorCurrencyEvidence,
	V3RoomCreatorInviteMaterial,
	V3RoomCreatorMemberView,
	V3RoomCreatorInviteMaterialInput,
	V3RoomEphemeralAuthorizationProvider,
	V3RoomHead,
	V3RoomHeadAuthority,
	V3RoomHeadAuthorityResult,
	V3RoomHeadInitialization,
	V3RoomHeadScope,
	V3RoomHeadState,
	V3RoomMigrationActivationInput,
	V3RoomMigrationActivationReceipt,
	V3RoomMigrationCapability,
	V3RoomMigrationProjection,
	V3RoomMigrationRehearsalInput,
	V3RoomMigrationRehearsalReceipt,
	V3RoomProjectionAuthority,
	V3RoomProjectionInput,
	V3RoomSession,
	V3RoomSettlementStatus,
	V3RoomSuccessorAuthority,
	V3RoomTransport,
} from "@ts-drp/node/v3-room";
export type { V3RoomStorageHost } from "@ts-drp/node/v3-room-host";
export {
	createV3RoomRolloverPolicy,
	V3_ROOM_MEMBER_SUCCESSOR_WAIT_MS,
	V3_ROOM_NOT_REACHING_HOST_MARGIN,
	V3RoomAwaitingFence,
	V3RoomNotReachingHost,
	V3RoomReadOnly,
	type V3RoomRolloverBudget,
	type V3RoomRolloverEvent,
	type V3RoomRolloverHooks,
	type V3RoomRolloverPolicy,
	type V3RoomRolloverStatus,
	V3RoomSuccessorUnavailable,
	type V3RoomSuccessorOffer,
} from "./rollover.js";
export {
	createV3RoomSuccessorChannel,
	createV3RoomSuccessorDelivery,
	openV3RoomSuccessorDelivery,
	V3_ROOM_SUCCESSOR_OFFER_MAX_BYTES,
	V3_ROOM_SUCCESSOR_POLL_MS,
	v3RoomCreatorPeer,
	type V3RoomSuccessorChannel,
	type V3RoomSuccessorDelivery,
	type V3RoomSuccessorDeliveryHooks,
	type V3RoomSuccessorDeliveryStats,
	type V3RoomSuccessorNode,
} from "./successor-delivery.js";
export {
	migrateV3RoomPlayerDatabase,
	prepareV3RoomPlayerDatabase,
	type V3RoomPlayerDatabaseApplication,
	type V3RoomPlayerDatabaseMigration,
	V3RoomPlayerDatabaseMigrationUnavailable,
	v3RoomLegacyDatabaseName,
	v3RoomPlayerDatabaseName,
} from "./player-database.js";
export {
	V3_ROOM_WORKER_ERROR_CODECS,
	v3RoomWorkerNodeConfig,
	type V3RoomWorkerIdentity,
	v3RoomWorkerPeerCacheKeys,
} from "./worker.js";
export { forwardV3RoomWorkerObservation } from "./worker-observation.js";

const browserStorageHost: V3RoomStorageHost = Object.freeze({
	openAhe: (databaseName: string) => createBrowserAheDurableStore({ databaseName }),
	openIssuance: (primaryDatabaseName: string) => createBrowserDurableIssuanceStore({ primaryDatabaseName }),
	openJournal: (primaryDatabaseName: string) => createBrowserDurableLiveJournalStore({ primaryDatabaseName }),
	openSnapshots: (primaryDatabaseName: string) => createBrowserSnapshotQuarantineStore({ primaryDatabaseName }),
	openSealVote: (databaseName: string) => openBrowserSealVoteStore({ databaseName }),
	openSealEvidence: (databaseName: string) => openBrowserSealEvidenceStore({ databaseName }),
	openCreatorSigningStores: (databaseName: string) => openBrowserSealSigningStore({ databaseName }),
	openRoomHead: (databaseName: string, initialization: V3RoomHeadInitialization) =>
		createBrowserRoomHeadAuthority({ databaseName, initialization }),
});

/**
 * The six-database host: each room owner in its own IndexedDB database (the room's
 * signing, seal vote and evidence database `name`, `name--ahe`, its live journal,
 * snapshot quarantine and issuance databases). Rooms created in six databases reopen on
 * it when the application passes no storage host; an application passes it explicitly to
 * create a new room in six databases.
 * @returns The six-database storage host.
 */
export function createBrowserV3SixDatabaseStorageHost(): V3RoomStorageHost {
	return browserStorageHost;
}

const ROOM_AHE_SUFFIX = "--ahe";
const ROOM_DATABASE_VERSION = 7;

/**
 * The version of an existing database, or undefined when none exists. It never creates
 * a database: the creating upgrade of a missing one is aborted.
 * @param databaseName - Database to inspect.
 * @returns Its version, or undefined.
 */
function existingDatabaseVersion(databaseName: string): Promise<number | undefined> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(databaseName);
		let absent = false;
		request.onupgradeneeded = (event): void => {
			if (event.oldVersion !== 0) return;
			absent = true;
			request.transaction?.abort();
		};
		request.onsuccess = (): void => {
			const version = request.result.version;
			request.result.close();
			resolve(version);
		};
		request.onerror = (): void => {
			if (absent) resolve(undefined);
			else reject(request.error ?? new Error("V3_ROOM_DATABASE_UNAVAILABLE"));
		};
	});
}

/**
 * Slice 14a: every owner of a room in ONE version-7 IndexedDB database. The
 * AHE store the room opens under `${name}--ahe` lives in database `name` with the
 * others; its retirement session then runs each owner's original retirement on one
 * strict transaction per stage. The host floor (`--room-head`) stays its own database.
 * `createV3RoomSession` uses it, with retention, for every new room when the application
 * passes no storage host (Track Z); rooms created in six databases keep that host.
 * @param options - `roomRetention` (slice 14b, opt-in on top of the room database):
 * recovery-pool maintenance retires each closed-epoch boundary by verified retention
 * decisions, one room transaction each, instead of the existing per-class passes.
 * @returns A storage host whose factories prepare the room database before opening.
 */
export function createBrowserV3RoomDatabaseStorageHost(
	options: Readonly<{ roomRetention?: true }> = {}
): V3RoomStorageHost {
	// Until a migration exists (slice 14d), only a new room or an existing room database
	// is served. A room in the six-database layout is refused before its main database
	// changes, so the default host can still open it.
	const prepared = new Map<string, Promise<void>>();
	const prepare = async (databaseName: string): Promise<void> => {
		const version = await existingDatabaseVersion(databaseName);
		if (version !== undefined && version !== ROOM_DATABASE_VERSION)
			throw new Error("V3_ROOM_DATABASE_MIGRATION_UNAVAILABLE");
		await prepareBrowserRoomDatabase({ databaseName });
	};
	const room = async (name: string): Promise<string> => {
		const databaseName = name.endsWith(ROOM_AHE_SUFFIX) ? name.slice(0, -ROOM_AHE_SUFFIX.length) : name;
		let ready = prepared.get(databaseName);
		if (ready === undefined) {
			ready = prepare(databaseName);
			prepared.set(databaseName, ready);
			// A refusal is not remembered: a later open checks again.
			ready.catch(() => prepared.delete(databaseName));
		}
		await ready;
		return databaseName;
	};
	return Object.freeze({
		openAhe: async (name: string) => createBrowserRoomAheDurableStore({ databaseName: await room(name) }),
		openIssuance: async (name: string) => createBrowserRoomDurableIssuanceStore({ databaseName: await room(name) }),
		openJournal: async (name: string) => createBrowserRoomLiveJournalStore({ databaseName: await room(name) }),
		openSnapshots: async (name: string) => createBrowserRoomSnapshotQuarantineStore({ databaseName: await room(name) }),
		openSealVote: async (name: string) => openBrowserRoomSealVoteStore({ databaseName: await room(name) }),
		openSealEvidence: async (name: string) => openBrowserRoomSealEvidenceStore({ databaseName: await room(name) }),
		openCreatorSigningStores: async (name: string) =>
			openBrowserRoomSealSigningStore({ databaseName: await room(name) }),
		openRoomRetirement: (name: string) => openBrowserRoomRetirement({ databaseName: name }),
		openRoomHead: (databaseName: string, initialization: V3RoomHeadInitialization) =>
			createBrowserRoomHeadAuthority({ databaseName, initialization }),
		...(options.roomRetention === true ? { roomRetention: true as const } : {}),
	});
}

export type CreateV3RoomSessionInput<Projection extends V3RoomProjectionAuthority = V3RoomProjectionAuthority> = Omit<
	HostRoomInput<Projection>,
	"storageHost"
> &
	Readonly<{ storageHost?: V3RoomStorageHost }>;

// The six-database layout's per-room databases besides `name` itself (the issuance
// database is named by the issuance primary name).
const SIX_DATABASE_SUFFIXES = [ROOM_AHE_SUFFIX, "--drp-live-journal-v1", "--drp-snapshot-quarantine-v1"] as const;
const SIX_DATABASE_ISSUANCE_SUFFIX = "--drp-issuance-v1";

/** The layout an existing room was created in, or "new" when none of its databases exists. */
type ExistingRoomLayout = "room" | "six-database" | "new";

/**
 * Which existing databases of `names` exist, with their versions. It never creates a
 * database: it lists them when the engine can, and otherwise probes each one with an
 * aborted creating upgrade. Without IndexedDB nothing exists.
 * @param names - Candidate database names.
 * @returns The existing ones with their versions.
 */
async function existingDatabases(names: readonly string[]): Promise<ReadonlyMap<string, number>> {
	const existing = new Map<string, number>();
	const factory = Reflect.get(globalThis, "indexedDB") as IDBFactory | undefined;
	if (factory === undefined) return existing;
	if (typeof factory.databases === "function") {
		for (const { name, version } of await factory.databases())
			if (name !== undefined && names.includes(name)) existing.set(name, version ?? 0);
		return existing;
	}
	for (const name of names) {
		const version = await existingDatabaseVersion(name);
		if (version !== undefined) existing.set(name, version);
	}
	return existing;
}

/**
 * The layout a room was created in, read from its database names alone (a rebase source
 * counts as part of the room: the session opens its journal through the same host).
 * - its main database at the room database's version: the room database;
 * - any six-database name (the main database at another version, or `--ahe`, a journal,
 *   snapshot or issuance database; a recipient may have no main database yet): six databases;
 * - none of its databases: a new room.
 * Local mechanics only: a wrong answer can only fail to open (the room host refuses a
 * six-database main database; the six-database owners refuse version 7). It grants nothing.
 * @param input - The room's database names.
 * @returns The layout.
 */
async function existingRoomLayout(
	input: Pick<CreateV3RoomSessionInput, "databaseName" | "issuanceDatabaseName" | "rebaseSourceStorage">
): Promise<ExistingRoomLayout> {
	const own = input.databaseName;
	const source = input.rebaseSourceStorage?.databaseName;
	const sixDatabaseNames = (name: string): string[] => SIX_DATABASE_SUFFIXES.map((suffix) => `${name}${suffix}`);
	const issuance = `${(input.issuanceDatabaseName as string | undefined) ?? own}${SIX_DATABASE_ISSUANCE_SUFFIX}`;
	const legacy = [issuance, ...sixDatabaseNames(own), ...(source === undefined ? [] : sixDatabaseNames(source))];
	const existing = await existingDatabases([own, ...(source === undefined ? [] : [source]), ...legacy]);
	const main = existing.get(own);
	if (main === ROOM_DATABASE_VERSION) return "room";
	if (main !== undefined || legacy.some((name) => existing.has(name))) return "six-database";
	if (source !== undefined && existing.has(source))
		return existing.get(source) === ROOM_DATABASE_VERSION ? "room" : "six-database";
	return "new";
}

// The layout a NEW room is created in when the application passes no storage host: the
// room database with retention and the scheduled lull (the owner's choice, 2026-10-21).
const NEW_ROOM_LAYOUT: Exclude<ExistingRoomLayout, "new"> = "room";

/**
 * Selects native IndexedDB mechanics for the browser application boundary.
 * External head freshness, application catalog and signer selection stay explicit.
 * Without an explicit `storageHost`, a room opens on the host it was created on: one in
 * the room database on the room database with retention (and the scheduled lull, unless
 * the application passes `recoveryPoolScheduledLull: false`), one in six databases on the
 * six-database host, unchanged. Nothing is migrated.
 * @param input - Existing application and host-acquired room authority.
 * @returns The shared SDK room lifecycle, with no browser-only protocol owner.
 */
export async function createV3RoomSession<Projection extends V3RoomProjectionAuthority>(
	input: CreateV3RoomSessionInput<Projection>
): Promise<V3RoomSession<Projection>> {
	if (input.storageHost !== undefined) return openHostRoom({ ...input, storageHost: input.storageHost });
	const existing = await existingRoomLayout(input);
	const layout = existing === "new" ? NEW_ROOM_LAYOUT : existing;
	if (layout === "six-database")
		return openHostRoom({ ...input, storageHost: createBrowserV3SixDatabaseStorageHost() });
	return openHostRoom({
		...input,
		storageHost: createBrowserV3RoomDatabaseStorageHost({ roomRetention: true }),
		recoveryPoolScheduledLull: input.recoveryPoolScheduledLull ?? true,
	});
}
