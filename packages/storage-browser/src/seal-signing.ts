import {
 consumeSealDetailRetirementIntent, consumeSealRoundChangeIntent, consumeSealVoteIntent,
 mintSealStorePort, resolveSealVoterEnrollment, type SealStorePort,
} from "@ts-drp/seal/internal/storage-port";
import {type CreatorCloseEvidenceStore, mintCreatorCloseEvidenceStore} from "@ts-drp/seal/internal/creator-close-intent";
import {CURRENT_BROWSER_SCHEMA_VERSION} from "./internal/schema-idb.js";
import {openInternalSealVoteStore, createInternalSealVoteStore, type InternalSealVoteStore} from "./internal/seal-vote-store.js";
import {openInternalSealEvidenceStore, createInternalSealEvidenceStore, type InternalSealEvidenceStore, type PeerSealEvidence} from "./internal/seal-evidence-store.js";
import {openSigningBackend} from "./internal/signing-backend.js";
import {registerBrowserRoomSigningStore} from "./internal/signing-retirement.js";

export type {PeerSealEvidence} from "./internal/seal-evidence-store.js";

/**
 * Opens the public observation/store constructor over the primary browser database.
 * @param input - Exact primary database identity.
 * @returns Bounded observation and opaque-intent accepting storage port.
 */
export async function openBrowserSealVoteStore(input: Readonly<{ databaseName: string }>): Promise<
	Readonly<{
		close(): Promise<void>;
		observation: Readonly<{
			incarnation: string;
			pendingCount: number;
			version: typeof CURRENT_BROWSER_SCHEMA_VERSION;
		}>;
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
	return buildBrowserSealVoteStore(await openInternalSealVoteStore({databaseName: input.databaseName}));
}

async function buildBrowserSealVoteStore(internal: InternalSealVoteStore) {
	const pending = await internal.readPending();
	const store = mintSealStorePort({
		acquireSigningDependencyObservation: (input) => internal.acquireSigningDependencyObservation(input),
		acquireSigningAdmission: async (enrollment) => {
			const scoped = resolveSealVoterEnrollment(enrollment);
			if (scoped === undefined) throw new TypeError("UNTRUSTED_VOTER_ENROLLMENT");
			if (scoped.expectedIncarnation !== internal.incarnation) throw new Error("STORAGE_LOSS");
			return internal.acquireSigningAdmission({ objectId: scoped.objectId });
		},
		acquireRetirementObservation: (input) => internal.acquireRetirementObservation(input),
		acquireRecoveryRetirementObservation: (input) => internal.acquireRecoveryRetirementObservation(input),
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
		retireDetails: (request: unknown) => {
			const intent = consumeSealDetailRetirementIntent(request);
			return intent === undefined
				? Promise.resolve(Object.freeze({ ok: false as const, reason: "UNTRUSTED_DETAIL_RETIREMENT_INTENT" }))
				: internal.retireDetails(intent);
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
			version: CURRENT_BROWSER_SCHEMA_VERSION,
		}),
		store,
	});
}

/**
 * Opens observation-only creator-close evidence custody on the primary browser database.
 * @param input - Exact primary database identity.
 * @returns Opaque evidence capability, bounded observation and cooperative close seam.
 */
export async function openBrowserSealEvidenceStore(input: Readonly<{ databaseName: string }>): Promise<
	Readonly<{
		close(): Promise<void>;
		observation: Readonly<{
			evidenceCount: number;
			incarnation: string;
			version: typeof CURRENT_BROWSER_SCHEMA_VERSION;
		}>;
		persistPeerEvidence(
			input: Readonly<{ evidence: PeerSealEvidence }>
		): Promise<Readonly<{ duplicate: boolean; ok: true } | { ok: false; reason: string }>>;
		restorePeerEvidence(
			input: Readonly<{ evidence: PeerSealEvidence }>
		): Promise<Readonly<{ duplicate: boolean; ok: true } | { ok: false; reason: string }>>;
		servePeerEvidence(
			input:
				| Readonly<{ objectId: string; signerId: string }>
				| Readonly<{ epoch: number; objectId: string; signerId: string }>
		): Promise<PeerSealEvidence | null>;
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
	return buildBrowserSealEvidenceStore(await openInternalSealEvidenceStore({databaseName: input.databaseName}));
}

async function buildBrowserSealEvidenceStore(internal: InternalSealEvidenceStore) {
	const rows = await internal.readAll();
	const selectPeerEvidence = async (selector: unknown): Promise<PeerSealEvidence | null> => {
		if (selector === null || typeof selector !== "object" || Array.isArray(selector)) {
			throw new TypeError("peer evidence identity is invalid");
		}
		const prototype = Object.getPrototypeOf(selector) as object | null;
		const keys = Reflect.ownKeys(selector);
		const expected = keys.length === 2 ? ["objectId", "signerId"] : ["epoch", "objectId", "signerId"];
		const descriptors = Object.getOwnPropertyDescriptors(selector);
		if (
			(prototype !== Object.prototype && prototype !== null) ||
			!keys.every((key): key is string => typeof key === "string") ||
			keys.length !== expected.length ||
			![...keys].sort().every((key, index) => key === expected[index]) ||
			keys.some((key) => !("value" in (descriptors[key] as PropertyDescriptor)))
		) {
			throw new TypeError("peer evidence identity is invalid");
		}
		const record = selector as Readonly<Record<string, unknown>>;
		const epoch = keys.length === 2 ? 0 : record.epoch;
		if (
			typeof record.objectId !== "string" ||
			record.objectId.length === 0 ||
			typeof epoch !== "number" ||
			!Number.isSafeInteger(epoch) ||
			epoch < 0 ||
			typeof record.signerId !== "string" ||
			record.signerId.length === 0
		) {
			throw new TypeError("peer evidence identity is invalid");
		}
		return internal.servePeerEvidence(record.objectId, epoch, record.signerId);
	};
	return Object.freeze({
		close: () => Promise.resolve(internal.close()),
		observation: Object.freeze({
			evidenceCount: rows.length,
			incarnation: internal.incarnation,
			version: CURRENT_BROWSER_SCHEMA_VERSION,
		}),
		persistPeerEvidence: ({ evidence }: Readonly<{evidence: PeerSealEvidence}>) => internal.persistPeerEvidence(evidence),
		restorePeerEvidence: ({ evidence }: Readonly<{evidence: PeerSealEvidence}>) => internal.restorePeerEvidence(evidence),
		servePeerEvidence: selectPeerEvidence,
		store: mintCreatorCloseEvidenceStore({
			acquireRetirementObservation: (input) => internal.acquireRetirementObservation(input),
			acquireRecoveryRetirementObservation: (input) => internal.acquireRecoveryRetirementObservation(input),
			acquireSigningDependencyObservation: (input) => internal.acquireSigningDependencyObservation(input),
			put: (record, expectedPhase) => internal.put(record, expectedPhase),
			readAll: () => internal.readAll(),
		}),
	});
}


/** Opens both original signing facets over ONE native connection and lifetime.
 * Facets have no independent close; the returned root revokes and joins both. */
export async function openBrowserSealSigningStore(input: Readonly<{databaseName: string}>) {
 if (input === null || typeof input !== "object" || Reflect.ownKeys(input).length !== 1 ||
  typeof input.databaseName !== "string" || input.databaseName.length === 0)
  throw new TypeError("browser seal-signing input must contain one databaseName");
 return openSigningFacets(await openSigningBackend(input), input);
}

async function openSigningFacets(backend: Awaited<ReturnType<typeof openSigningBackend>>,
 input: Readonly<{databaseName: string}>) {
 try {
  const vote = await buildBrowserSealVoteStore(createInternalSealVoteStore(backend, input, true));
  const evidence = await buildBrowserSealEvidenceStore(createInternalSealEvidenceStore(backend, true));
  const {close: _voteClose, ...voteFacet} = vote, {close: _evidenceClose, ...evidenceFacet} = evidence;
  return Object.freeze({vote: Object.freeze(voteFacet), evidence: Object.freeze(evidenceFacet), close: () => backend.participant.close()});
 } catch (primary) {
  try { await backend.participant.close(); }
  catch (cleanup) { throw new AggregateError([primary, cleanup], "combined signing open and release failed", {cause: primary}); }
  throw primary;
 }
}

function captureRoomSigningInput(input: Readonly<{ databaseName: string }>, label: string): string {
	if (
		input === null ||
		typeof input !== "object" ||
		Reflect.ownKeys(input).length !== 1 ||
		typeof input.databaseName !== "string" ||
		input.databaseName.length === 0
	)
		throw new TypeError(`browser ${label} input must contain one databaseName`);
	return input.databaseName;
}

/**
 * Opens the seal-vote facet over the signing stores of a ready version-7 room database
 * (slice 14a). The stores, rows and refusals are the version-6 signing owner's.
 * @param input - Exact room database identity.
 * @returns Bounded observation and opaque-intent accepting storage port.
 */
export async function openBrowserRoomSealVoteStore(
	input: Readonly<{ databaseName: string }>
): ReturnType<typeof openBrowserSealVoteStore> {
	const databaseName = captureRoomSigningInput(input, "seal-vote");
	const opened = await buildBrowserSealVoteStore(await openInternalSealVoteStore({ databaseName }, true));
	const closed = registerRoomSigningStores(databaseName, opened.observation.incarnation, [opened.store]);
	return Object.freeze({ ...opened, close: () => (closed(), opened.close()) });
}

/**
 * Opens creator-close evidence custody over the signing stores of a ready version-7 room
 * database (slice 14a).
 * @param input - Exact room database identity.
 * @returns Opaque evidence capability, bounded observation and cooperative close seam.
 */
export async function openBrowserRoomSealEvidenceStore(
	input: Readonly<{ databaseName: string }>
): ReturnType<typeof openBrowserSealEvidenceStore> {
	const databaseName = captureRoomSigningInput(input, "seal-evidence");
	const opened = await buildBrowserSealEvidenceStore(await openInternalSealEvidenceStore({ databaseName }, true));
	const closed = registerRoomSigningStores(databaseName, opened.observation.incarnation, [opened.store]);
	return Object.freeze({ ...opened, close: () => (closed(), opened.close()) });
}

/**
 * Opens both signing facets over ONE room connection and lifetime (slice 14a).
 * @param input - Exact room database identity.
 * @returns Both facets and the root close, as the dedicated database's combined store.
 */
export async function openBrowserRoomSealSigningStore(
	input: Readonly<{ databaseName: string }>
): ReturnType<typeof openBrowserSealSigningStore> {
	const databaseName = captureRoomSigningInput(input, "seal-signing");
	const opened = await openSigningFacets(await openSigningBackend({ databaseName }, true), { databaseName });
	const closed = registerRoomSigningStores(databaseName, opened.vote.observation.incarnation, [
		opened.vote.store,
		opened.evidence.store,
	]);
	return Object.freeze({ ...opened, close: () => (closed(), opened.close()) });
}

/**
 * Registers genuine room-mode signing facets for the room retirement session (slice 14a).
 * @param databaseName - The room database.
 * @param incarnation - The signing owner's captured native incarnation.
 * @param stores - The minted facets of one lifetime.
 * @returns Marks the lifetime closed; a closed facet is refused by the session.
 */
function registerRoomSigningStores(databaseName: string, incarnation: string, stores: readonly object[]): () => void {
	let closed = false;
	for (const store of stores)
		registerBrowserRoomSigningStore(store, Object.freeze({ databaseName, incarnation, isClosed: () => closed }));
	return () => {
		closed = true;
	};
}
