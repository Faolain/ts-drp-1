import {
	assertDurableIssueScope,
	copyDurableIssueScope,
	DurableIssuanceInvalidArgumentError,
	isClosedDurableIssuanceRecord,
	isValidDurableAuthorSequence,
} from "./contract.js";
import {
	captureIssuanceRetirementObject,
	type DurableIssuanceRetirementControl,
	type DurableIssuanceRetirementControlRead,
	type DurableIssuanceRetirementImage,
	ISSUANCE_RETIREMENT_LIMITS,
	type IssuanceRetirementRows,
} from "./retirement.js";
import type { DurableIssuanceError, DurableIssuanceStore, DurableIssueScope, DurableLineage } from "./types.js";

export * from "./retirement.js";

const HEX_DIGEST = /^[0-9a-f]{64}$/u;

export interface DurableIssuancePruningState {
	readonly lineage: DurableLineage;
	readonly prunedThroughAuthorSequence: number | null;
	readonly scope: DurableIssueScope;
}

export interface DurableIssuancePruningInput {
	readonly closedEpoch: number;
	readonly commitQcRef: Readonly<{ readonly byteLength: number; readonly digest: string }>;
	readonly expectedLineage: DurableLineage;
	readonly expectedPrunedThroughAuthorSequence: number | null;
	readonly scope: DurableIssueScope;
	readonly snapshotManifestDigest: string;
	readonly throughAuthorSequence: number;
}

export interface DurableIssuancePruningReceipt {
	readonly closedEpoch: number;
	readonly commitQcRef: Readonly<{ readonly byteLength: number; readonly digest: string }>;
	readonly deletedAuthorSequenceRange: Readonly<{ readonly from: number; readonly through: number }> | null;
	readonly observedLineage: DurableLineage;
	readonly prunedThroughAuthorSequence: number;
	readonly scope: DurableIssueScope;
	readonly snapshotManifestDigest: string;
}

export interface DurableIssuancePruningMaintenance {
	/** Noncreating mechanical native census; no signing or retirement authority. */
	readonly readBoundedRecoveryCensus?: DurableIssuanceRecoveryCensusReader;
	/** Pure resource bound for this original backend's ordinary sign strategy.
	 * Does not capture native state or replace its full entry currency check. */
	readonly readOrdinarySignMaterialByteLength?: typeof import("./retirement.js").issuanceUnsignedOwnMaterialByteLength;
	withNativeSignAdmission?(
		input: Readonly<{ scope: DurableIssueScope; exactCanonicalUnsignedVertexBytes: Uint8Array }>,
		sign: () => Promise<Uint8Array>
	): Promise<Uint8Array>;
	acquireRetirementControl?(input: { readonly objectId: string }): Promise<DurableIssuanceRetirementControlRead>;
	/**
	 * Rule A: the store's one plan-before side row for this object (the BEFORE plan images of its
	 * completed control-2 preparation), or null. Read only to reconstruct the committed source; it
	 * carries no authority and is opened against the completed preparation by
	 * openIssuanceRetirementPlanBefore.
	 */
	readRetirementPlanBefore?(input: { readonly objectId: string }): Promise<Uint8Array | null>;
	inspectPruningState(scope: DurableIssueScope): Promise<DurableIssuancePruningState>;
	pruneAuthenticatedSettledPrefix(input: unknown): Promise<DurableIssuancePruningReceipt>;
	prunePublishedPrefix(input: unknown): Promise<DurableIssuancePruningReceipt>;
}

export interface DurableIssuanceRecoveryCensusInput {
	readonly objectId: string;
	readonly limits: Readonly<{ maxRows: number; maxBytes: number }>;
}
export interface DurableIssuanceRecoveryCensus {
	readonly rows: IssuanceRetirementRows;
	readonly image: DurableIssuanceRetirementImage;
	/** Actual metadata from the same noncreating native capture; no authority. */
	readonly control?: DurableIssuanceRetirementControl | null;
}

/** Exact held native correspondence only; carries no census, authorization or paid allowance. */
export interface DurableIssuanceRecoveryCensusCurrentProbe {
	checkCurrent(this: DurableIssuanceRecoveryCensusCurrentProbe): Promise<boolean>;
}
/** Only the original producer can enroll its exact returned observation. */
export interface DurableIssuanceRecoveryCensusReader {
	(input: DurableIssuanceRecoveryCensusInput): Promise<DurableIssuanceRecoveryCensus>;
	captureCurrentProbe?(this: DurableIssuanceRecoveryCensusReader, input: DurableIssuanceRecoveryCensusInput,
		observation: DurableIssuanceRecoveryCensus): DurableIssuanceRecoveryCensusCurrentProbe | undefined;
}

/**
 * Captures smaller caller entitlements within the original native owner's bounds.
 * @param input - Exact object address and smaller native read entitlement.
 * @returns Detached, bounded mechanical read input.
 */
export function captureDurableIssuanceRecoveryCensusInput(input: unknown): DurableIssuanceRecoveryCensusInput {
	if (
		!isClosedDurableIssuanceRecord(input, ["objectId", "limits"]) ||
		!isClosedDurableIssuanceRecord(input.limits, ["maxRows", "maxBytes"])
	)
		throw new DurableIssuanceInvalidArgumentError("issuance recovery census input is malformed");
	const objectId = captureIssuanceRetirementObject({ objectId: input.objectId });
	const { maxRows, maxBytes } = input.limits;
	if (
		!Number.isSafeInteger(maxRows) ||
		(maxRows as number) <= 0 ||
		(maxRows as number) > ISSUANCE_RETIREMENT_LIMITS.maxRows ||
		!Number.isSafeInteger(maxBytes) ||
		(maxBytes as number) <= 0 ||
		(maxBytes as number) > ISSUANCE_RETIREMENT_LIMITS.maxBytes
	)
		throw new DurableIssuanceInvalidArgumentError("issuance recovery census limits are invalid");
	return Object.freeze({
		objectId,
		limits: Object.freeze({ maxRows: maxRows as number, maxBytes: maxBytes as number }),
	});
}

const MAINTENANCE_REGISTRY = Symbol.for("@ts-drp/issuance-store/pruning-maintenance-v1");
interface MaintenanceRegistry {
	bind(store: DurableIssuanceStore, maintenance: DurableIssuancePruningMaintenance): boolean;
	resolve(store: DurableIssuanceStore): DurableIssuancePruningMaintenance | undefined;
}
type MaintenanceGlobal = typeof globalThis & {
	[MAINTENANCE_REGISTRY]?: MaintenanceRegistry;
};
const maintenanceGlobal = globalThis as MaintenanceGlobal;
const maintenanceRegistry =
	maintenanceGlobal[MAINTENANCE_REGISTRY] ??
	((): MaintenanceRegistry => {
		const maintenanceByStore = new WeakMap<DurableIssuanceStore, DurableIssuancePruningMaintenance>();
		return Object.freeze({
			bind(store: DurableIssuanceStore, maintenance: DurableIssuancePruningMaintenance): boolean {
				if (maintenanceByStore.has(store)) return false;
				maintenanceByStore.set(store, maintenance);
				return true;
			},
			resolve(store: DurableIssuanceStore): DurableIssuancePruningMaintenance | undefined {
				return maintenanceByStore.get(store);
			},
		});
	})();
if (maintenanceGlobal[MAINTENANCE_REGISTRY] === undefined) {
	Object.defineProperty(maintenanceGlobal, MAINTENANCE_REGISTRY, {
		configurable: false,
		enumerable: false,
		value: maintenanceRegistry,
		writable: false,
	});
}

/**
 * Binds a backend-owned maintenance capability to its exact ordinary facade.
 * This is a package-internal owner hook and is not re-exported by the ordinary store facade.
 * @param store - Exact frozen store facade.
 * @param maintenance - Backend-owned maintenance capability.
 * @returns Whether this was the first binding for the facade.
 */
export function bindDurableIssuancePruningMaintenance(
	store: DurableIssuanceStore,
	maintenance: DurableIssuancePruningMaintenance
): boolean {
	return maintenanceRegistry.bind(store, maintenance);
}

/**
 * Resolves maintenance for the exact facade without exposing mutation on it.
 * This is a package-internal owner hook and is not re-exported by the ordinary store facade.
 * @param store - Candidate ordinary store facade.
 * @returns Its identity-bound backend maintenance capability.
 */
export function durableIssuancePruningMaintenanceForStore(
	store: DurableIssuanceStore
): DurableIssuancePruningMaintenance | undefined {
	return maintenanceRegistry.resolve(store);
}

/** Binds native mechanical sign exclusion to this exact ordinary facade. No authorization is minted. */
export function nativeIssuanceSignAdmissionForStore(
	store: DurableIssuanceStore,
	scope: DurableIssueScope
): ((bytes: Uint8Array, sign: () => Promise<Uint8Array>) => Promise<Uint8Array>) | undefined {
	const owner = durableIssuancePruningMaintenanceForStore(store);
	const admit = owner?.withNativeSignAdmission;
	if (admit === undefined) return undefined;
	const detached = copyDurableIssueScope(scope);
	return (bytes, sign) => admit.call(owner, { scope: detached, exactCanonicalUnsignedVertexBytes: bytes }, sign);
}

/** Exact non-poisoning evidence that a caller-known ordinal was already pruned. */
export class DurableIssuanceRecordPrunedError extends Error implements DurableIssuanceError {
	readonly authorSequence: number;
	readonly code = "ISSUANCE_RECORD_PRUNED" as const;
	readonly scope: DurableIssueScope;

	/**
	 * Creates caller-known evidence for an ordinal already removed by pruning.
	 * @param scope - Caller-known issuance scope.
	 * @param authorSequence - Caller-known pruned ordinal.
	 */
	constructor(scope: DurableIssueScope, authorSequence: number) {
		super("durable issuance record was pruned");
		Object.defineProperty(this, "name", { configurable: true, value: "DurableIssuanceError" });
		this.authorSequence = authorSequence;
		this.scope = Object.freeze(copyDurableIssueScope(scope));
	}
}

function invalid(message: string): DurableIssuanceInvalidArgumentError {
	return new DurableIssuanceInvalidArgumentError(message);
}

function copyLineage(value: unknown): DurableLineage {
	if (
		!isClosedDurableIssuanceRecord(value, ["exhausted", "next"]) ||
		typeof value.exhausted !== "boolean" ||
		!isValidDurableAuthorSequence(value.next) ||
		(value.exhausted && value.next !== Number.MAX_SAFE_INTEGER)
	) {
		throw invalid("expectedLineage must be an exact safe lineage record");
	}
	return { exhausted: value.exhausted, next: value.next };
}

function copyWatermark(value: unknown): number | null {
	if (value === null) return null;
	if (!isValidDurableAuthorSequence(value)) throw invalid("pruning watermark must be null or a safe ordinal");
	return value;
}

/**
 * Validates and detaches one closed pruning request.
 * @param value - Untrusted request value.
 * @returns A detached validated pruning request.
 */
export function captureDurableIssuancePruningInput(value: unknown): DurableIssuancePruningInput {
	try {
		if (
			!isClosedDurableIssuanceRecord(value, [
				"closedEpoch",
				"commitQcRef",
				"expectedLineage",
				"expectedPrunedThroughAuthorSequence",
				"scope",
				"snapshotManifestDigest",
				"throughAuthorSequence",
			]) ||
			!isValidDurableAuthorSequence(value.closedEpoch) ||
			!isValidDurableAuthorSequence(value.throughAuthorSequence) ||
			!isClosedDurableIssuanceRecord(value.commitQcRef, ["byteLength", "digest"]) ||
			!Number.isSafeInteger(value.commitQcRef.byteLength) ||
			Number(value.commitQcRef.byteLength) < 1 ||
			typeof value.commitQcRef.digest !== "string" ||
			!HEX_DIGEST.test(value.commitQcRef.digest) ||
			typeof value.snapshotManifestDigest !== "string" ||
			!HEX_DIGEST.test(value.snapshotManifestDigest)
		) {
			throw invalid("pruning input must be one exact validated record");
		}
		assertDurableIssueScope(value.scope);
		return {
			closedEpoch: value.closedEpoch,
			commitQcRef: { byteLength: Number(value.commitQcRef.byteLength), digest: value.commitQcRef.digest },
			expectedLineage: copyLineage(value.expectedLineage),
			expectedPrunedThroughAuthorSequence: copyWatermark(value.expectedPrunedThroughAuthorSequence),
			scope: copyDurableIssueScope(value.scope),
			snapshotManifestDigest: value.snapshotManifestDigest,
			throughAuthorSequence: value.throughAuthorSequence,
		};
	} catch (error) {
		if (error instanceof DurableIssuanceInvalidArgumentError) throw error;
		throw invalid("pruning input could not be inspected as a closed record");
	}
}

/**
 * Creates a deeply detached immutable pruning-state observation.
 * @param scope - Observed issuance scope.
 * @param lineage - Observed lineage CAS value.
 * @param prunedThroughAuthorSequence - Observed inclusive watermark.
 * @returns A frozen detached observation.
 */
export function createDurableIssuancePruningState(
	scope: DurableIssueScope,
	lineage: DurableLineage,
	prunedThroughAuthorSequence: number | null
): DurableIssuancePruningState {
	return Object.freeze({
		lineage: Object.freeze({ ...lineage }),
		prunedThroughAuthorSequence,
		scope: Object.freeze(copyDurableIssueScope(scope)),
	});
}

/**
 * Creates a deeply detached immutable pruning receipt.
 * @param input - Captured pruning request.
 * @param observedLineage - Transactionally observed lineage.
 * @param deletedFrom - First removed ordinal or `null` for replay.
 * @returns A frozen detached receipt.
 */
export function createDurableIssuancePruningReceipt(
	input: DurableIssuancePruningInput,
	observedLineage: DurableLineage,
	deletedFrom: number | null
): DurableIssuancePruningReceipt {
	return Object.freeze({
		closedEpoch: input.closedEpoch,
		commitQcRef: Object.freeze({ ...input.commitQcRef }),
		deletedAuthorSequenceRange:
			deletedFrom === null ? null : Object.freeze({ from: deletedFrom, through: input.throughAuthorSequence }),
		observedLineage: Object.freeze({ ...observedLineage }),
		prunedThroughAuthorSequence: input.throughAuthorSequence,
		scope: Object.freeze(copyDurableIssueScope(input.scope)),
		snapshotManifestDigest: input.snapshotManifestDigest,
	});
}

/**
 * Creates frozen non-poisoning evidence for a caller-known pruned address.
 * @param scope - Caller-known issuance scope.
 * @param authorSequence - Caller-known pruned ordinal.
 * @returns A closed frozen pruned-address error.
 */
export function createDurableIssuanceRecordPrunedError(
	scope: DurableIssueScope,
	authorSequence: number
): DurableIssuanceRecordPrunedError {
	return Object.freeze(new DurableIssuanceRecordPrunedError(scope, authorSequence));
}
