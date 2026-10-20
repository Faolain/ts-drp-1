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
import { openBrowserSealVoteStore } from "@ts-drp/storage-browser/seal-vote";
import { openBrowserSealSigningStore } from "@ts-drp/storage-browser/seal-signing";
import { createBrowserSnapshotQuarantineStore } from "@ts-drp/storage-browser/snapshot-transfer";

export { createV3RoomCreatorInviteMaterial, waitForV3RoomStartupForDiagnostics } from "@ts-drp/node/v3-room";
export type {
	V3RoomAcceptedOperation,
	V3RoomAcceptedVertex,
	V3RoomApplication,
	V3RoomAuthenticatedProjectionBase,
	V3RoomCreatorInviteMaterial,
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
	V3RoomSuccessorAuthority,
	V3RoomTransport,
} from "@ts-drp/node/v3-room";
export type { V3RoomStorageHost } from "@ts-drp/node/v3-room-host";

const browserStorageHost: V3RoomStorageHost = Object.freeze({
	openAhe: (databaseName: string) => createBrowserAheDurableStore({ databaseName }),
	openIssuance: (primaryDatabaseName: string) => createBrowserDurableIssuanceStore({ primaryDatabaseName }),
	openJournal: (primaryDatabaseName: string) => createBrowserDurableLiveJournalStore({ primaryDatabaseName }),
	openSnapshots: (primaryDatabaseName: string) => createBrowserSnapshotQuarantineStore({ primaryDatabaseName }),
	openSealVote: (databaseName: string) => openBrowserSealVoteStore({ databaseName }),
	openSealEvidence: (databaseName: string) => openBrowserSealEvidenceStore({ databaseName }),
	openCreatorSigningStores: (databaseName: string) => openBrowserSealSigningStore({databaseName}),
	openRoomHead: (databaseName: string, initialization: V3RoomHeadInitialization) =>
		createBrowserRoomHeadAuthority({ databaseName, initialization }),
});

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
 * Opt-in (slice 14a): every owner of a room in ONE version-7 IndexedDB database. The
 * AHE store the room opens under `${name}--ahe` lives in database `name` with the
 * others; its retirement session then runs each owner's original retirement on one
 * strict transaction per stage. The host floor (`--room-head`) stays its own database.
 * The default host is unchanged.
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
		openCreatorSigningStores: async (name: string) => openBrowserRoomSealSigningStore({ databaseName: await room(name) }),
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

/**
 * Selects native IndexedDB mechanics for the browser application boundary.
 * External head freshness, application catalog and signer selection stay explicit.
 * @param input - Existing application and host-acquired room authority.
 * @returns The shared SDK room lifecycle, with no browser-only protocol owner.
 */
export async function createV3RoomSession<Projection extends V3RoomProjectionAuthority>(
	input: CreateV3RoomSessionInput<Projection>
): Promise<V3RoomSession<Projection>> {
	return openHostRoom({ ...input, storageHost: input.storageHost ?? browserStorageHost });
}
