import {
	type CreatorCloseEvidenceStore,
	mintCreatorCloseEvidenceStore,
} from "@ts-drp/seal/internal/creator-close-intent";

import { openInternalSealEvidenceStore, type PeerSealEvidence } from "./internal/seal-evidence-store.js";

export type { PeerSealEvidence } from "./internal/seal-evidence-store.js";

/**
 * Opens observation-only creator-close evidence custody on the primary browser database.
 * @param input - Exact primary database identity.
 * @returns Opaque evidence capability, bounded observation and cooperative close seam.
 */
export async function openBrowserSealEvidenceStore(input: Readonly<{ databaseName: string }>): Promise<
	Readonly<{
		close(): Promise<void>;
		observation: Readonly<{ evidenceCount: number; incarnation: string; version: 3 }>;
		persistPeerEvidence(
			input: Readonly<{ evidence: PeerSealEvidence }>
		): Promise<Readonly<{ duplicate: boolean; ok: true } | { ok: false; reason: string }>>;
		restorePeerEvidence(
			input: Readonly<{ evidence: PeerSealEvidence }>
		): Promise<Readonly<{ duplicate: boolean; ok: true } | { ok: false; reason: string }>>;
		servePeerEvidence(input: Readonly<{ objectId: string; signerId: string }>): Promise<PeerSealEvidence | null>;
		store: CreatorCloseEvidenceStore;
	}>
> {
	if (
		input === null ||
		typeof input !== "object" ||
		Reflect.ownKeys(input).length !== 1 ||
		typeof input.databaseName !== "string" ||
		input.databaseName.length === 0
	) {
		throw new TypeError("browser seal-evidence input must contain one databaseName");
	}
	const internal = await openInternalSealEvidenceStore({ databaseName: input.databaseName });
	const rows = await internal.readAll();
	return Object.freeze({
		close: () => Promise.resolve(internal.close()),
		observation: Object.freeze({
			evidenceCount: rows.length,
			incarnation: internal.incarnation,
			version: 3 as const,
		}),
		persistPeerEvidence: ({ evidence }) => internal.persistPeerEvidence(evidence),
		restorePeerEvidence: ({ evidence }) => internal.restorePeerEvidence(evidence),
		servePeerEvidence: ({ objectId, signerId }) => internal.servePeerEvidence(objectId, signerId),
		store: mintCreatorCloseEvidenceStore({
			put: (record, expectedPhase) => internal.put(record, expectedPhase),
			readAll: () => internal.readAll(),
		}),
	});
}
