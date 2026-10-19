import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import {
	type AheBoundedRecoveryRoleStore,
	type AheDurableStore,
	type AheGenerationPartition,
	aheRetirementGenerationIdentity,
	type AheRetirementGenerationSource,
	type AheRetirementPreparation,
	type BlobDigest,
	type ClosureDigest,
	captureAheRetirementGenerationSource,
	digestBlob,
	encodeGenerationRecordV1,
	encodeHeadRecordV1,
	type ExpectedHead,
	type GenerationId,
	type GenerationRecord,
	type GenerationRef,
	type PresentHead,
	type StorageObjectId,
	type StoreResult,
} from "@ts-drp/storage";
import {
	type AheReclamationDecision,
	captureAheReclamationInput,
	classifyAheReclamation,
} from "@ts-drp/storage/maintenance";

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
 * Creates the head closure digest spelled like {@link d109cBlobDigest}.
 * @param index - Positive fixture ordinal.
 * @returns Canonical closure digest.
 */
export function d109cClosureDigest(index: number): ClosureDigest {
	return (index + 32).toString(16).padStart(64, "0") as ClosureDigest;
}

/**
 * Creates the existing no-head representation.
 * @param objectId - Canonical object identity.
 * @returns Frozen no-head value.
 */
export function d109cNoHead(objectId = D109C_OBJECT): Extract<ExpectedHead, { kind: "none" }> {
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
		closureDigest: d109cClosureDigest(5),
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
				closureDigest: d109cClosureDigest(2),
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

interface D109cBoundedCheckpoint {
	readonly objectId: StorageObjectId;
	readonly head: PresentHead;
	readonly source: AheRetirementGenerationSource;
	readonly preparation: AheRetirementPreparation;
	readonly rows: readonly GenerationRecord[];
	readonly postRows: readonly GenerationRecord[];
	readonly shared: GenerationRef;
	readonly foreign: GenerationRecord | undefined;
	readonly decision: AheReclamationDecision;
}
/**
 * Native mechanical checkpoint inputs only; no Cut/QC or protocol eligibility claim.
 * @param store - Original native mechanical owner.
 * @param sharedForeign - Whether a genuine foreign generation shares the selected blob.
 * @returns Original prepared/completed checkpoint and exact mechanical source.
 */
export async function d109cBoundedCheckpoint(
	store: AheBoundedRecoveryRoleStore,
	sharedForeign = false
): Promise<D109cBoundedCheckpoint> {
	const objectId = D109C_OBJECT;
	let head = d109cMust(await store.readHead(objectId));
	const payloads = new Map<BlobDigest, Uint8Array>();
	for (let ordinal = 1; ordinal <= 4; ordinal++) {
		const blobs = Array.from({ length: ordinal === 1 ? 7 : 1 }, (_, index) => {
			const bytes = Uint8Array.of(ordinal, index, 101);
			const digest = d109cMust(digestBlob(bytes));
			payloads.set(digest, bytes);
			return { ref: { digest, byteLength: bytes.length }, bytes };
		});
		const generationId = d109cGenerationId(ordinal);
		d109cMust(
			await store.beginGeneration({ objectId, generationId, baseExpectedHead: head, closure: blobs.map((b) => b.ref) })
		);
		for (const blob of blobs) {
			d109cMust(await store.putCachedBlob({ objectId, generationId, digest: blob.ref.digest, bytes: blob.bytes }));
			d109cMust(await store.promoteReference({ objectId, generationId, digest: blob.ref.digest }));
		}
		d109cMust(await store.completeGeneration({ objectId, generationId }));
		head = d109cMust(await store.swapHead({ objectId, generationId, expectedHead: head })).head;
	}
	const rows = d109cMust(await store.readGenerationPage({ objectId, limit: 16 })).generations;
	const selected = rows.find((row) => row.generationId === d109cGenerationId(1));
	const floor = rows.find((row) => row.generationId === d109cGenerationId(2));
	if (head.kind !== "present" || !selected || !floor) throw new TypeError("D109C_BOUND_SOURCE_MISSING");
	const shared = selected.closure[0];
	if (!shared) throw new TypeError("D109C_BOUND_SHARED_MISSING");
	let foreign: GenerationRecord | undefined;
	if (sharedForeign) {
		const foreignId = d109cGenerationId(9);
		const foreignHead = d109cMust(await store.readHead(D109C_OTHER_OBJECT));
		d109cMust(
			await store.beginGeneration({
				objectId: D109C_OTHER_OBJECT,
				generationId: foreignId,
				baseExpectedHead: foreignHead,
				closure: [shared],
			})
		);
		d109cMust(
			await store.promoteReference({ objectId: D109C_OTHER_OBJECT, generationId: foreignId, digest: shared.digest })
		);
		foreign = d109cMust(await store.completeGeneration({ objectId: D109C_OTHER_OBJECT, generationId: foreignId }));
	}
	const reclamation = captureAheReclamationInput({
		objectId,
		activeGenerationId: head.generationId,
		expectedHead: head,
		closedEpoch: 3,
		availabilityPolicyDigest: D109C_POLICY_DIGEST,
		rollbackGenerationIds: [d109cGenerationId(3), d109cGenerationId(2)],
		lineageFloor: {
			generationId: floor.generationId,
			expectedBaseExpectedHead: floor.baseExpectedHead,
			replacementBaseExpectedHead: d109cNoHead(),
			deleteGenerationIds: [selected.generationId],
		},
		classifiedSourceGenerations: [selected],
		independentSourceGenerations: [],
	});
	const snapshot = {
		head,
		generations: foreign ? [...rows, foreign] : rows,
		promotions: (foreign ? [...rows, foreign] : rows).flatMap((row) =>
			row.closure.map((ref) => ({ objectId: row.objectId, generationId: row.generationId, digest: ref.digest }))
		),
		blobs: [...payloads].map(([digest, bytes]) => ({ digest, bytes })),
	};
	const decision = classifyAheReclamation(reclamation, snapshot);
	const postRows = rows
		.filter((row) => row.generationId !== selected.generationId)
		.map((row) => (row.generationId === floor.generationId ? decision.floor.rewrittenGeneration : row));
	const partition = (records: readonly GenerationRecord[], retired = false): AheGenerationPartition => ({
		recordDigests: records.map((row) => d109cMust(digestBlob(encodeGenerationRecordV1(row)))),
		identities: records.map((row) => ({
			generationId: row.generationId,
			identityDigest: aheRetirementGenerationIdentity(row),
		})),
		protectedIndices: records.flatMap((row, index) =>
			retired && row.generationId === selected.generationId ? [] : [index]
		),
		retireIndices: records.flatMap((row, index) =>
			retired && row.generationId === selected.generationId ? [index] : []
		),
	});
	const source = captureAheRetirementGenerationSource({
		reclamation,
		sourceImageDigest: d109cBoundedDataImage(head, rows),
		postImageDigest: d109cBoundedDataImage(head, postRows),
		resumeBasisDigest: "b".repeat(64),
		generations: partition(rows, true),
		postGenerations: partition(postRows),
	});
	const preparation: AheRetirementPreparation = {
		head,
		floorEpoch: 3,
		floorAnchor: "c".repeat(64),
		decisionDigest: "d".repeat(64),
		sourceProofDigest: "e".repeat(64),
		generationRecordDigests: source.generations.recordDigests,
		snapshotScopes: [],
		protectedIndices: [],
		retireIndices: [],
		domains: Array.from(
			{ length: 8 },
			(_, index) =>
				[
					2 ** index,
					new Uint8Array(32).fill(index + 1),
					new Uint8Array(32).fill(index + 2),
					index,
					new Uint8Array(32).fill(index + 3),
					new Uint8Array(32).fill(index + 4),
					index + 1,
				] as const
		),
		generationSource: source,
	};
	if (!store.acquireRetirementControl) throw new TypeError("D109C_BOUND_PORT_MISSING");
	const original = d109cMust(await store.acquireRetirementControl(objectId));
	try {
		if (original.imageDigest !== source.sourceImageDigest) throw new TypeError("D109C_BOUND_ORIGINAL_IMAGE");
		d109cMust(await original.prepareBound({ preparation, generations: source.generations }));
	} finally {
		await original.release();
	}
	const prepared = d109cMust(await store.acquireRetirementControl(objectId));
	try {
		d109cMust(
			await prepared.commitPrepared({
				decisionDigest: preparation.decisionDigest,
				sourceProofDigest: preparation.sourceProofDigest,
			})
		);
	} finally {
		await prepared.release();
	}
	return { objectId, head, source, preparation, rows, postRows, shared, foreign, decision };
}

/**
 * Exact existing native-data codec projection, not a second eligibility classifier.
 * @param head - Original native head.
 * @param rows - Exact admitted generation records.
 * @returns Original canonical native data digest.
 */
function d109cBoundedDataImage(head: PresentHead, rows: readonly GenerationRecord[]): string {
	const promotions = rows.flatMap((row) => row.closure.map((ref) => `${row.generationId}:${ref.digest}`)).sort();
	const presentBlobs = [...new Set(rows.flatMap((row) => row.closure.map((ref) => ref.digest)))].sort();
	return [
		...hashDomain(
			"ts-drp-storage/retirement-image/v1",
			encodeCanonical({
				head: encodeHeadRecordV1(head),
				generations: rows.map(encodeGenerationRecordV1),
				promotions,
				presentBlobs,
			})
		),
	]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Mechanical result assertion shared by the existing native fixture hosts.
 * @param result - Actual native return.
 * @returns Successful actual value.
 */
export function d109cMust<T>(result: StoreResult<T>): T {
	if (!result.ok) throw new TypeError(`D109C_BOUND_RESULT:${result.reason}`);
	return result.value;
}
