import type { DurableIssuanceRetirementControlRead } from "@ts-drp/issuance-store/maintenance";
import type { LiveJournalRetirementControlRead, LiveJournalRetirementResult } from "@ts-drp/live-journal";
import type { SigningRetirementObservation } from "@ts-drp/seal/internal/storage-port";
import type {
	AheRetirementControlRead,
	RoomRetentionApplied,
	RoomRetentionLabels,
	RoomRetentionPlanned,
	RoomRetentionSelection,
	RoomRetentionTransactionLimits,
	StorageObjectId,
	StoreResult,
} from "@ts-drp/storage";
import type { SnapshotRetirementControlRead } from "@ts-drp/storage/snapshot-transfer";

/** The genuine room owners one retention decision acts for (slice 14b). */
export interface V3RoomRetentionOwners {
	readonly ahe: unknown;
	readonly snapshot: unknown;
	readonly journal: unknown;
	readonly issuance?: unknown;
	readonly signing?: unknown;
}

/**
 * Slice 14a: one room retirement session over a host's single room database. Every
 * acquisition is the named owner's ORIGINAL retirement read and transitions, run on
 * the session's strict transaction; the session accepts only genuine owners of its own
 * database and commits at a checkpoint or at the end, whole or not at all. It is a
 * mechanical executor, never retirement eligibility or authority.
 */
export interface V3RoomRetirementSession {
	acquireAhe(store: unknown, objectId: StorageObjectId): Promise<StoreResult<AheRetirementControlRead>>;
	acquireSnapshot(store: unknown, input: Readonly<{ objectId: string }>): Promise<SnapshotRetirementControlRead>;
	acquireJournal(
		store: unknown,
		input: Readonly<{ objectId: string }>
	): Promise<LiveJournalRetirementResult<LiveJournalRetirementControlRead>>;
	acquireIssuance(
		input: Readonly<{ objectId: string }>,
		store?: unknown
	): Promise<DurableIssuanceRetirementControlRead>;
	acquireSigning(
		input: Readonly<{ objectId: string }>,
		recovery?: boolean,
		store?: unknown
	): Promise<SigningRetirementObservation>;
	/**
	 * Slice 14b (optional): plans one retention decision on the session's current
	 * transaction. Every owner section reads and charges its own rows; nothing is written.
	 */
	planRetention?(
		owners: V3RoomRetentionOwners,
		selection: RoomRetentionSelection,
		limits?: RoomRetentionTransactionLimits
	): Promise<RoomRetentionPlanned>;
	/**
	 * Slice 14b step B (optional): re-plans the same selection inside the acting strict
	 * transaction, requires the planned decision digest, charges every byte before the
	 * first write and writes every owner's deletes, rewrites and target control.
	 */
	applyRetention?(
		owners: V3RoomRetentionOwners,
		selection: RoomRetentionSelection,
		labels: RoomRetentionLabels,
		options?: Readonly<{
			limits?: RoomRetentionTransactionLimits;
			snapshotAuthority?: Readonly<{ capability: object; custody: object }>;
		}>
	): Promise<RoomRetentionApplied>;
	checkpoint(): Promise<void>;
	commit(): Promise<void>;
	abort(cause?: unknown): Promise<void>;
}

/** The host's session opener for one room database, and whether it opted into retention. */
interface V3RoomRetirementRegistration {
	readonly open: () => Promise<V3RoomRetirementSession>;
	/** Slice 14b: the host opted into verified-fact retention on this room path. */
	readonly retention: boolean;
}

// The host's session opener for the room database of one genuine AHE store. A wrong
// or stale association can only make the session refuse an owner; it grants nothing.
const openers = new WeakMap<object, V3RoomRetirementRegistration>();

/**
 * Associates an AHE store with its host's room retirement session opener.
 * @param store - The AHE store the host opened in its room database.
 * @param open - Opens a session over that same room database.
 * @param options - Whether the host opted into slice 14b retention.
 * @param options.retention - The host's retention opt-in.
 */
export function registerV3RoomRetirementOpener(
	store: object,
	open: () => Promise<V3RoomRetirementSession>,
	options: Readonly<{ retention?: boolean }> = {}
): void {
	openers.set(store, Object.freeze({ open, retention: options.retention === true }));
}

/**
 * Resolves the room retirement session opener of an AHE store, when its host has one.
 * @param store - Candidate AHE store.
 * @returns The opener, or undefined for the current (per-owner transaction) path.
 */
export function v3RoomRetirementOpener(store: unknown): (() => Promise<V3RoomRetirementSession>) | undefined {
	return typeof store === "object" && store !== null ? openers.get(store)?.open : undefined;
}

/**
 * Slice 14b: the room retirement session opener of an AHE store whose host opted into
 * verified-fact retention. Selection only: every decision is still verified and every
 * acting byte is compared inside step B.
 * @param store - Candidate AHE store.
 * @returns The opener, or undefined when the host did not opt in.
 */
export function v3RoomRetentionOpener(store: unknown): (() => Promise<V3RoomRetirementSession>) | undefined {
	const registration = typeof store === "object" && store !== null ? openers.get(store) : undefined;
	return registration?.retention === true ? registration.open : undefined;
}
