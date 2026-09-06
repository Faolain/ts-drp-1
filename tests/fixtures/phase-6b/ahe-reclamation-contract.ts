import type {
	AheDurableStore,
	BlobDigest,
	ExpectedHead,
	GenerationId,
	GenerationRecord,
	PresentHead,
	StorageObjectId,
} from "@ts-drp/storage";

export const D109C_POLICY_DIGEST = "53775c5c1ee01e346f588966d6e7acb876df2bd8b2abcbe2b2591f216f7d4d9b";
export const D109C_OBJECT = `creator:${"a".repeat(32)}` as StorageObjectId;
export const D109C_OTHER_OBJECT = `creator:${"b".repeat(32)}` as StorageObjectId;

export const D109C_RED_PATHS = Object.freeze([
	"tests/fixtures/phase-6b/ahe-reclamation-contract.ts",
	"tests/phase-6b-ahe-reclamation-red.test.ts",
	"packages/storage-node/tests/fixtures/phase-6b-ahe-reclamation-child.mjs",
	"packages/storage-node/tests/phase-6b-ahe-reclamation-red.test.ts",
	"packages/storage-browser/playwright.phase-6b-ahe-reclamation.config.ts",
	"packages/storage-browser/tests/phase-6b-ahe-reclamation-global-setup.ts",
	"packages/storage-browser/tests/assets/phase-6b-ahe-reclamation-entry.ts",
	"packages/storage-browser/tests/assets/phase-6b-ahe-reclamation-worker.ts",
	"packages/storage-browser/tests/phase-6b-ahe-reclamation-red.pw.ts",
] as const);

export const D109C_EXPORT_CENSUS_PATHS = Object.freeze([
	"tests/phase-2l-d-parity-governance-red.test.ts",
	"tests/phase-3a1b-p2-outbox-publication-contract.test.ts",
	"packages/storage-node/tests/phase-2l-c-node-issuance-registry-red.test.ts",
	"packages/storage-node/tests/phase-3a1b-p4-node-live-journal-red.test.ts",
] as const);

export const D109C_GREEN_PATHS = Object.freeze([
	"packages/storage/src/maintenance.ts",
	"packages/storage/package.json",
	"packages/storage-node/src/maintenance.ts",
	"packages/storage-node/src/internal/ahe-reclamation.ts",
	"packages/storage-node/src/internal/create-scaffold.ts",
	"packages/storage-node/src/test-instrumentation.ts",
	"packages/storage-node/package.json",
	"packages/storage-browser/src/maintenance.ts",
	"packages/storage-browser/src/internal/ahe-reclamation.ts",
	"packages/storage-browser/src/internal/idb-adapter.ts",
	"packages/storage-browser/package.json",
] as const);

export const D109C_ERROR_CODES = Object.freeze([
	"AHE_RECLAMATION_INVALID_ARGUMENT",
	"AHE_RECLAMATION_RETRY_REQUIRED",
	"AHE_RECLAMATION_CORRUPT",
	"AHE_RECLAMATION_STORE_CLOSED",
	"AHE_RECLAMATION_STORE_POISONED",
	"AHE_RECLAMATION_SUBSTRATE_FAILURE",
] as const);

export const D109C_CRASH_EDGES = Object.freeze([
	"after-floor-rewrite",
	"after-promotion-delete",
	"after-generation-delete",
	"after-blob-delete",
	"before-commit",
	"after-commit",
] as const);

export const D109C_LINEAGE_MUTANTS = Object.freeze([
	"head-different",
	"revision-stale",
	"active-mismatch",
	"rollback-insufficient",
	"rollback-wrong-countable-pair",
	"identity-duplicate",
	"closure-changed",
	"state-changed",
	"floor-wrong",
	"former-parent-wrong",
	"lineage-gap",
	"lineage-cycle",
	"surviving-branch",
	"extra-target-row",
	"post-state-dangling-parent",
] as const);

export const D109C_CORRUPTION_MUTANTS = Object.freeze([
	"retained-blob-missing",
	"retained-blob-corrupt",
	"promotion-missing",
	"promotion-extra",
	"promotion-wrong-digest",
	"target-generation-malformed",
	"unrelated-generation-malformed",
	"generation-key-record-mismatch",
	"partial-replay",
] as const);

export const D109C_REFERENCE_CASES = Object.freeze([
	"retained-shared-blob",
	"cross-object-shared-blob",
	"candidate-only-blob",
	"unrelated-orphan-retained",
	"staged-partial-promotions",
	"discarded-partial-promotions",
] as const);

export const D109C_COUNT_MUTANTS = Object.freeze([
	"floor-update-count",
	"promotion-delete-count",
	"generation-delete-count",
	"blob-delete-count",
] as const);

export type D109cErrorCode = (typeof D109C_ERROR_CODES)[number];
export type D109cCrashEdge = (typeof D109C_CRASH_EDGES)[number];

export type D109cReclamationInput = Readonly<{
	activeGenerationId: GenerationId;
	availabilityPolicyDigest: string;
	closedEpoch: number;
	expectedHead: PresentHead;
	lineageFloor: Readonly<{
		deleteGenerationIds: readonly GenerationId[];
		expectedBaseExpectedHead: ExpectedHead;
		generationId: GenerationId;
		replacementBaseExpectedHead: Readonly<{ kind: "none"; objectId: StorageObjectId }>;
	}>;
	objectId: StorageObjectId;
	rollbackGenerationIds: readonly [GenerationId, GenerationId];
}>;

export type D109cReceipt = Readonly<{
	activeGenerationId: GenerationId;
	availabilityPolicyDigest: string;
	closedEpoch: number;
	deletedBlobDigests: readonly BlobDigest[];
	deletedGenerationIds: readonly GenerationId[];
	deletedPromotionCount: number;
	expectedHead: PresentHead;
	floor: Readonly<{
		expectedFormerBaseExpectedHead: ExpectedHead;
		generationId: GenerationId;
		normalizedThisCall: boolean;
		replacementBaseExpectedHead: Readonly<{ kind: "none"; objectId: StorageObjectId }>;
	}>;
	objectId: StorageObjectId;
	reclaimedGenerationIds: readonly GenerationId[];
	rollbackGenerationIds: readonly [GenerationId, GenerationId];
}>;

export interface D109cMaintenance {
	reclaimClosedEpoch(input: unknown): Promise<D109cReceipt>;
}

export interface D109cSharedMaintenanceModule {
	readonly AHE_RECLAMATION_ERROR_CODES: readonly string[];
	captureAheReclamationInput(input: unknown): D109cReclamationInput;
	classifyAheReclamation(
		input: unknown,
		snapshot: Readonly<{
			blobs: readonly Readonly<{ bytes: Uint8Array; digest: BlobDigest }>[];
			generations: readonly GenerationRecord[];
			head: ExpectedHead;
			promotions: readonly Readonly<{
				digest: BlobDigest;
				generationId: GenerationId;
				objectId: StorageObjectId;
			}>[];
		}>
	): Readonly<{
		deleteBlobDigests: readonly BlobDigest[];
		deleteGenerationIds: readonly GenerationId[];
		deletePromotions: readonly unknown[];
		floor: Readonly<{
			generation: GenerationRecord;
			normalizedThisCall: boolean;
			rewrittenGeneration: GenerationRecord;
		}>;
	}>;
	createAheReclamationReceipt(
		decision: ReturnType<D109cSharedMaintenanceModule["classifyAheReclamation"]>
	): D109cReceipt;
}

export interface D109cNodeMaintenanceModule {
	resolveNodeAheReclamationMaintenance(store: AheDurableStore): D109cMaintenance | undefined;
}

export interface D109cBrowserMaintenanceModule {
	resolveBrowserAheReclamationMaintenance(store: AheDurableStore): D109cMaintenance | undefined;
}

/**
 * Creates one canonical deterministic generation ID.
 * @param index - Positive fixture ordinal.
 * @returns Canonical generation identity.
 */
export function d109cGenerationId(index: number): GenerationId {
	return index.toString(16).padStart(64, "0") as GenerationId;
}

/**
 * Creates one canonical deterministic blob digest.
 * @param index - Positive fixture ordinal.
 * @returns Canonical blob digest.
 */
export function d109cBlobDigest(index: number): BlobDigest {
	return (index + 32).toString(16).padStart(64, "0") as BlobDigest;
}

/**
 * Creates the existing no-head representation.
 * @param objectId - Canonical object identity.
 * @returns Frozen no-head value.
 */
export function d109cNoHead(objectId = D109C_OBJECT): ExpectedHead {
	return Object.freeze({ kind: "none" as const, objectId });
}

/**
 * Creates the frozen five-generation reclamation request shape.
 * @returns Detached input fixture.
 */
export function d109cInput(): D109cReclamationInput {
	const activeGenerationId = d109cGenerationId(5);
	const first = d109cGenerationId(4);
	const floor = d109cGenerationId(3);
	const formerParent = d109cGenerationId(2);
	const expectedHead = Object.freeze({
		closureDigest: d109cBlobDigest(5),
		generationId: activeGenerationId,
		kind: "present" as const,
		objectId: D109C_OBJECT,
		revision: 5 as PresentHead["revision"],
	});
	return Object.freeze({
		activeGenerationId,
		availabilityPolicyDigest: D109C_POLICY_DIGEST,
		closedEpoch: 4,
		expectedHead,
		lineageFloor: Object.freeze({
			deleteGenerationIds: Object.freeze([d109cGenerationId(1), formerParent]),
			expectedBaseExpectedHead: Object.freeze({
				closureDigest: d109cBlobDigest(2),
				generationId: formerParent,
				kind: "present" as const,
				objectId: D109C_OBJECT,
				revision: 2 as PresentHead["revision"],
			}),
			generationId: floor,
			replacementBaseExpectedHead: d109cNoHead(),
		}),
		objectId: D109C_OBJECT,
		rollbackGenerationIds: Object.freeze([first, floor] as const),
	});
}

/**
 * Reads a stable reclamation code without depending on an error class.
 * @param error - Captured failure.
 * @returns Stable code when present.
 */
export function d109cErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && typeof Reflect.get(error, "code") === "string"
		? String(Reflect.get(error, "code"))
		: undefined;
}

/**
 * Recursively checks frozen evidence.
 * @param value - Candidate value.
 * @param seen - Already visited object identities.
 * @returns Whether every reachable object is frozen.
 */
export function d109cDeepFrozen(value: unknown, seen = new Set<object>()): boolean {
	if (value === null || typeof value !== "object") return true;
	if (seen.has(value)) return true;
	seen.add(value);
	if (!Object.isFrozen(value)) return false;
	for (const key of Reflect.ownKeys(value)) {
		if (!d109cDeepFrozen(Reflect.get(value, key), seen)) return false;
	}
	return true;
}
