import {
	consumeSealRoundChangeIntent,
	consumeSealVoteIntent,
	mintSealStorePort,
	resolveSealVoterEnrollment,
	type SealStorePort,
} from "@ts-drp/seal/internal/storage-port";

import { openInternalSealVoteStore } from "./internal/seal-vote-store.js";

/**
 * Opens the public observation/store constructor over the primary browser database.
 * @param input - Exact primary database identity.
 * @returns Bounded observation and opaque-intent accepting storage port.
 */
export async function openBrowserSealVoteStore(input: Readonly<{ databaseName: string }>): Promise<
	Readonly<{
		close(): Promise<void>;
		observation: Readonly<{ incarnation: string; pendingCount: number; version: 2 }>;
		store: SealStorePort;
	}>
> {
	if (
		input === null ||
		typeof input !== "object" ||
		Reflect.ownKeys(input).length !== 1 ||
		typeof input.databaseName !== "string" ||
		input.databaseName.length === 0
	) {
		throw new TypeError("browser seal-vote input must contain one databaseName");
	}
	const internal = await openInternalSealVoteStore({ databaseName: input.databaseName });
	const pending = await internal.readPending();
	const store = mintSealStorePort({
		commitQc: (enrollment: unknown, qc: unknown) => {
			const scoped = resolveSealVoterEnrollment(enrollment);
			return scoped === undefined
				? Promise.resolve(Object.freeze({ ok: false as const, reason: "UNTRUSTED_VOTER_ENROLLMENT" }))
				: internal.commitQc({ ...(qc as object), ...scoped });
		},
		commitRoundChange: (roundChange: unknown) => {
			const intent = consumeSealRoundChangeIntent(roundChange);
			return intent === undefined
				? Promise.resolve(Object.freeze({ ok: false as const, reason: "UNTRUSTED_ROUND_CHANGE_INTENT" }))
				: internal.commitRoundChange(intent);
		},
		commitVote: (vote: unknown) => {
			const intent = consumeSealVoteIntent(vote);
			return intent === undefined
				? Promise.resolve(Object.freeze({ ok: false as const, reason: "UNTRUSTED_VOTE_INTENT" }))
				: internal.commitVote(intent);
		},
		openSnapshot: (enrollment: unknown) => {
			const scoped = resolveSealVoterEnrollment(enrollment);
			return scoped === undefined
				? Promise.reject(new TypeError("untrusted voter enrollment"))
				: internal.openSnapshot(scoped);
		},
	});
	return Object.freeze({
		close: () => Promise.resolve(internal.close()),
		observation: Object.freeze({
			incarnation: internal.incarnation,
			pendingCount: pending.length,
			version: 2 as const,
		}),
		store,
	});
}
