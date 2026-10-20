import type { DurableIssuanceStore } from "@ts-drp/issuance-store";
import type { FinalitySigner } from "@ts-drp/keychain/finality";
import type { OwnedSigningRequest } from "@ts-drp/protocol-v3/internal/owned-signing-request";
import type { DurableLiveJournalStore } from "@ts-drp/live-journal";
import type { CreatorCloseEvidenceStore } from "@ts-drp/seal/internal/creator-close-intent";
import type { SealStorePort } from "@ts-drp/seal/internal/storage-port";
import type {
	AheBoundedRecoveryRoleStore,
	NativeReadReservation,
	RoomHeadAuthority,
	RoomHeadInitialization,
} from "@ts-drp/storage";
import type { SnapshotRecoveryStore, SnapshotVerificationReceipt } from "@ts-drp/storage/snapshot-transfer";

import { registerV3RoomRetirementOpener, type V3RoomRetirementSession } from "./internal/room-retirement.js";

export type { V3RoomRetirementSession } from "./internal/room-retirement.js";

/** Native exclusion remains a storage premise, not authority minted by the room. */
export interface V3RoomNativeReadPort {
	acquireNativeReadReservation(input: Readonly<{ objectId: string }>): Promise<NativeReadReservation>;
}

export interface V3RoomSigningStore<Store> {
	readonly observation: Readonly<{ incarnation: string }>;
	readonly store: Store;
	close(): Promise<void>;
}

/** One backend-native lifetime may supply both existing signing facets. */
export interface V3RoomCreatorSigningStores {
	readonly vote: Pick<V3RoomSigningStore<SealStorePort>, "observation" | "store">;
	readonly evidence: Pick<V3RoomSigningStore<CreatorCloseEvidenceStore>, "observation" | "store">;
	close(): Promise<void>;
}

/**
 * Explicit durable host boundary for the single supported room lifecycle.
 * Names are host-local storage identities; the host chooses their native mapping.
 * Factories supply mechanics only. Authentication, head selection and eligibility
 * remain with their existing protocol owners. The external room head is acquired
 * separately; openRoomHead is used only for a room-owned migration target.
 */
export interface V3RoomStorageHost {
	openAhe(name: string): Promise<AheBoundedRecoveryRoleStore & V3RoomNativeReadPort>;
	openIssuance(name: string): Promise<DurableIssuanceStore & V3RoomNativeReadPort>;
	openJournal(name: string): Promise<DurableLiveJournalStore & V3RoomNativeReadPort>;
	openSnapshots(name: string): Promise<SnapshotRecoveryStore<SnapshotVerificationReceipt>>;
	openSealVote(name: string): Promise<V3RoomSigningStore<SealStorePort>>;
	openSealEvidence(name: string): Promise<V3RoomSigningStore<CreatorCloseEvidenceStore>>;
	/** Optional same-native-owner construction; never a room authorization source. */
	openCreatorSigningStores?(name: string): Promise<V3RoomCreatorSigningStores>;
	/**
	 * Optional (slice 14a): a retirement session over the single room database that
	 * holds every owner opened under `name` (the AHE store under `${name}--ahe`). Its
	 * presence selects the room retirement path; without it the current path runs.
	 */
	openRoomRetirement?(name: string): Promise<V3RoomRetirementSession>;
	openRoomHead(
		name: string,
		initialization: RoomHeadInitialization
	): Promise<RoomHeadAuthority & Readonly<{ close(): Promise<void> }>>;
}

/** Host-local incarnation custody only. Neither selectors nor admission grant wire authority. */
export interface V3RoomLocalSessionSelector {
	readonly slot: number;
	readonly incarnation: number;
}
export type V3RoomLocalSessionAcquisition = Readonly<{ kind: "create" }> |
	Readonly<{ kind: "reopen"; selector: V3RoomLocalSessionSelector }>;
export interface V3RoomLocalSessionLease {
	readonly selector: V3RoomLocalSessionSelector;
	readonly storageHost: V3RoomStorageHost;
	/** Local routing hint only; the native owner independently verifies profile custody. */
	readonly requiresAuthenticatedDisposition?: boolean;
	/** Actual separately owned key. Enrollment remains the authenticated ACL/profile owner's job. */
	readonly signing: Readonly<{ author: string; publicKeyBytes: Uint8Array; finalitySigner: FinalitySigner; signRequest(request: OwnedSigningRequest): Promise<Uint8Array>; signGenesisRequest(request: OwnedSigningRequest, accountHead: RoomHeadAuthority): Promise<Uint8Array> }>;
	bindAuthenticatedRoom(binding: unknown): void;
	assertCurrent(): void;
	/** Finite host-admitted jobs; original payload accounting remains with the room. */
	admit<T>(operation: () => T | Promise<T>): Promise<T>;
	close(): Promise<void>;
	retire(input: Readonly<{ join(): Promise<void>; disposition?: unknown }>): Promise<void>;
}
export interface V3RoomLocalSessionHost {
	acquireLocalSession(input: V3RoomLocalSessionAcquisition): Promise<V3RoomLocalSessionLease>;
}

const FACTORIES = [
	"openAhe",
	"openIssuance",
	"openJournal",
	"openSnapshots",
	"openSealVote",
	"openSealEvidence",
	"openRoomHead",
] as const;

/**
 * Captures one host's factory identity before any room storage is opened.
 * @param value - Product-selected native host, not a caller authorization flag.
 * @returns Receiver-preserving factories for this room lifetime.
 */
export function captureV3RoomStorageHost(value: V3RoomStorageHost): V3RoomStorageHost {
	if (value === null || typeof value !== "object") throw new TypeError("v3 room storage host is unavailable");
	const captured = {} as { -readonly [K in keyof V3RoomStorageHost]: V3RoomStorageHost[K] };
	const retirement = value.openRoomRetirement;
	if (retirement !== undefined && typeof retirement !== "function")
		throw new TypeError("v3 room storage host retirement factory is unavailable");
	const openRetirement = retirement?.bind(value);
	for (const name of FACTORIES) {
		const factory = value[name];
		if (typeof factory !== "function") throw new TypeError("v3 room storage host factory is unavailable");
		const bound = factory.bind(value) as V3RoomStorageHost[typeof name];
		Object.defineProperty(captured, name, {
			enumerable: true,
			value:
				name === "openAhe" && openRetirement !== undefined
					? roomAheFactory(bound as V3RoomStorageHost["openAhe"], openRetirement)
					: bound,
		});
	}
	const signing = value.openCreatorSigningStores;
	if (signing !== undefined) {
		if (typeof signing !== "function") throw new TypeError("v3 room storage host signing factory is unavailable");
		Object.defineProperty(captured, "openCreatorSigningStores", {enumerable: true, value: signing.bind(value)});
	}
	if (openRetirement !== undefined)
		Object.defineProperty(captured, "openRoomRetirement", { enumerable: true, value: openRetirement });
	return Object.freeze(captured);
}

const AHE_SUFFIX = "--ahe";

/**
 * Associates every AHE store a room-retirement host opens under `${name}--ahe` with
 * that host's session over `name`. The session verifies every owner it acts for.
 * @param openAhe - The captured AHE factory.
 * @param openRetirement - The captured room retirement factory.
 * @returns The AHE factory, unchanged in behaviour and result.
 */
function roomAheFactory(
	openAhe: V3RoomStorageHost["openAhe"],
	openRetirement: NonNullable<V3RoomStorageHost["openRoomRetirement"]>
): V3RoomStorageHost["openAhe"] {
	return async (name: string) => {
		const store = await openAhe(name);
		if (name.endsWith(AHE_SUFFIX)) {
			const room = name.slice(0, -AHE_SUFFIX.length);
			registerV3RoomRetirementOpener(store, () => openRetirement(room));
		}
		return store;
	};
}
