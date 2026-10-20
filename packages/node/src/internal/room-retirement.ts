import type { DurableIssuanceRetirementControlRead } from "@ts-drp/issuance-store/maintenance";
import type { LiveJournalRetirementControlRead, LiveJournalRetirementResult } from "@ts-drp/live-journal";
import type { SigningRetirementObservation } from "@ts-drp/seal/internal/storage-port";
import type { AheRetirementControlRead, StorageObjectId, StoreResult } from "@ts-drp/storage";
import type { SnapshotRetirementControlRead } from "@ts-drp/storage/snapshot-transfer";

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
	checkpoint(): Promise<void>;
	commit(): Promise<void>;
	abort(cause?: unknown): Promise<void>;
}

// The host's session opener for the room database of one genuine AHE store. A wrong
// or stale association can only make the session refuse an owner; it grants nothing.
const openers = new WeakMap<object, () => Promise<V3RoomRetirementSession>>();

/**
 * Associates an AHE store with its host's room retirement session opener.
 * @param store - The AHE store the host opened in its room database.
 * @param open - Opens a session over that same room database.
 */
export function registerV3RoomRetirementOpener(store: object, open: () => Promise<V3RoomRetirementSession>): void {
	openers.set(store, open);
}

/**
 * Resolves the room retirement session opener of an AHE store, when its host has one.
 * @param store - Candidate AHE store.
 * @returns The opener, or undefined for the current (per-owner transaction) path.
 */
export function v3RoomRetirementOpener(store: unknown): (() => Promise<V3RoomRetirementSession>) | undefined {
	return typeof store === "object" && store !== null ? openers.get(store) : undefined;
}
