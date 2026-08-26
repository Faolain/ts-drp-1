import {
	type CreatorCloseEvidenceStore,
	mintCreatorCloseEvidenceStore,
} from "@ts-drp/seal/internal/creator-close-intent";

import { openInternalSealEvidenceStore } from "./internal/seal-evidence-store.js";

/**
 * Opens observation-only creator-close evidence custody on the primary browser database.
 * @param input - Exact primary database identity.
 * @returns Opaque evidence capability, bounded observation and cooperative close seam.
 */
export async function openBrowserSealEvidenceStore(input: Readonly<{ databaseName: string }>): Promise<
	Readonly<{
		close(): Promise<void>;
		observation: Readonly<{ evidenceCount: number; incarnation: string; version: 3 }>;
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
		store: mintCreatorCloseEvidenceStore({
			put: (record, expectedPhase) => internal.put(record, expectedPhase),
			readAll: () => internal.readAll(),
		}),
	});
}
