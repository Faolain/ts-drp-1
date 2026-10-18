import type { SigningDependencyObservation, SigningRetirementObservation } from "./seal-vote-intent.js";

export type CreatorCloseEvidencePhase =
	| "commit-vote-pending"
	| "commit-qc-committed"
	| "commit-voted"
	| "evidence-committed"
	| "finalized"
	| "prepare-voted"
	| "prepared";

export interface CreatorCloseEvidenceRecord {
	readonly anchor: string;
	readonly epoch: number;
	readonly exactCanonicalCommitQcBytes: Uint8Array | null;
	readonly exactCanonicalCutValueBytes: Uint8Array;
	readonly exactCanonicalPrepareQcBytes: Uint8Array | null;
	readonly exactCanonicalTrustStateRecordBytes: Uint8Array | null;
	readonly objectId: string;
	readonly phase: CreatorCloseEvidencePhase;
	readonly revision: number;
	readonly signerId: string;
	readonly signerPublicKey: Uint8Array;
	readonly storageIncarnation: string;
	readonly valueDigest: string;
}

declare const creatorCloseEvidenceStoreBrand: unique symbol;

export interface CreatorCloseEvidenceStore {
	readonly [creatorCloseEvidenceStoreBrand]: true;
}

export interface CreatorCloseEvidenceAdapter {
	acquireSigningDependencyObservation?(input: Readonly<{ objectId: string }>): Promise<SigningDependencyObservation>;
	acquireRetirementObservation?(input: Readonly<{ objectId: string }>): Promise<SigningRetirementObservation>;
	acquireRecoveryRetirementObservation?(input: Readonly<{ objectId: string }>): Promise<SigningRetirementObservation>;
	put(
		record: CreatorCloseEvidenceRecord,
		expectedPhase: CreatorCloseEvidencePhase | null
	): Promise<Readonly<{ duplicate: boolean; ok: true } | { ok: false; reason: string }>>;
	readAll(): Promise<readonly CreatorCloseEvidenceRecord[]>;
}

const adapters = new WeakMap<CreatorCloseEvidenceStore, CreatorCloseEvidenceAdapter>();

function copyNullableBytes(value: Uint8Array | null): Uint8Array | null {
	return value === null ? null : Uint8Array.from(value);
}

/**
 * Copies one durable creator-close evidence record across the package boundary.
 * @param record - Validated mechanical evidence row.
 * @returns Detached immutable record.
 */
export function copyCreatorCloseEvidenceRecord(record: CreatorCloseEvidenceRecord): CreatorCloseEvidenceRecord {
	return Object.freeze({
		...record,
		exactCanonicalCommitQcBytes: copyNullableBytes(record.exactCanonicalCommitQcBytes),
		exactCanonicalCutValueBytes: Uint8Array.from(record.exactCanonicalCutValueBytes),
		exactCanonicalPrepareQcBytes: copyNullableBytes(record.exactCanonicalPrepareQcBytes),
		exactCanonicalTrustStateRecordBytes: copyNullableBytes(record.exactCanonicalTrustStateRecordBytes),
		signerPublicKey: Uint8Array.from(record.signerPublicKey),
	});
}

/**
 * Mints one fieldless evidence-store capability over a mechanical adapter.
 * @param adapter - Package-internal persistence adapter.
 * @returns Opaque creator-close evidence-store capability.
 */
export function mintCreatorCloseEvidenceStore(adapter: CreatorCloseEvidenceAdapter): CreatorCloseEvidenceStore {
	const store = Object.freeze({}) as CreatorCloseEvidenceStore;
	adapters.set(
		store,
		Object.freeze({
			...(adapter.acquireSigningDependencyObservation === undefined
				? {}
				: { acquireSigningDependencyObservation: adapter.acquireSigningDependencyObservation.bind(adapter) }),
			...(adapter.acquireRetirementObservation === undefined
				? {}
				: { acquireRetirementObservation: adapter.acquireRetirementObservation.bind(adapter) }),
			...(adapter.acquireRecoveryRetirementObservation === undefined
				? {}
				: { acquireRecoveryRetirementObservation: adapter.acquireRecoveryRetirementObservation.bind(adapter) }),
			put: adapter.put.bind(adapter),
			readAll: adapter.readAll.bind(adapter),
		})
	);
	return store;
}

/**
 * Resolves a genuine evidence-store capability inside the seal package.
 * @param value - Candidate fieldless capability.
 * @returns Captured mechanical adapter, or undefined for foreign input.
 */
export function resolveCreatorCloseEvidenceStore(value: unknown): CreatorCloseEvidenceAdapter | undefined {
	if (value === null || typeof value !== "object") return undefined;
	return adapters.get(value as CreatorCloseEvidenceStore);
}
