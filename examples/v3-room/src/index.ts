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
