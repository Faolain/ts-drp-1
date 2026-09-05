import { encodeCanonical, hashDomain } from "../../../packages/canonical/src/index.js";

export const SNAPSHOT_QUARANTINE_RETENTION_MS = 86_400_000 as const;
export const SNAPSHOT_QUARANTINE_MAX_MANIFEST_BYTES = 212_387 as const;
export const SNAPSHOT_QUARANTINE_MAX_CHUNKS = 2_048 as const;
export const SNAPSHOT_QUARANTINE_MAX_BYTES = 268_435_456 as const;

export const SNAPSHOT_QUARANTINE_FAILURE_CODES = Object.freeze([
	"aborted",
	"closed",
	"conflict",
	"expired",
	"incomplete",
	"invalid-carrier",
	"malformed-input",
	"poisoned",
	"receipt-invalid",
	"storage-failed",
	"unsupported-schema",
] as const);

export const SNAPSHOT_QUARANTINE_SCOPE_FIELDS = Object.freeze([
	"anchor",
	"epoch",
	"manifestDigest",
	"objectId",
] as const);

export const SNAPSHOT_QUARANTINE_DESCRIPTOR_FIELDS = Object.freeze(["byteLength", "digest", "index"] as const);

export const SNAPSHOT_QUARANTINE_DECLARATION_FIELDS = Object.freeze([
	"chunks",
	"exactCanonicalManifestBytes",
	"scope",
	"totalBytes",
] as const);

export const SNAPSHOT_QUARANTINE_STORE_METHODS = Object.freeze(["close", "openScope", "sweepExpired"] as const);

export const SNAPSHOT_QUARANTINE_SESSION_METHODS = Object.freeze([
	"cancel",
	"complete",
	"missingIndices",
	"release",
	"status",
] as const);

export const SNAPSHOT_QUARANTINE_RECEIPT_EXPORTS = Object.freeze([
	"consumeSnapshotVerificationReceipt",
	"verifySnapshotStreamWithReceipt",
] as const);

export const SNAPSHOT_QUARANTINE_COMMON_EXPORTS = Object.freeze(["SNAPSHOT_QUARANTINE_RETENTION_MS"] as const);
export const SNAPSHOT_QUARANTINE_NODE_EXPORTS = Object.freeze(["createNodeSnapshotQuarantineStore"] as const);
export const SNAPSHOT_QUARANTINE_BROWSER_EXPORTS = Object.freeze(["createBrowserSnapshotQuarantineStore"] as const);
export const SNAPSHOT_QUARANTINE_ROOT_RUNTIME_ROSTERS = Object.freeze({
	browser: Object.freeze(["createBrowserAheDurableStore", "createBrowserStorageCapacityPort"] as const),
	common: Object.freeze([
		"createMemoryAheDurableStore",
		"createStageAdmissionController",
		"decodeGenerationRecordV1",
		"decodeHeadRecordV1",
		"digestBlob",
		"digestClosure",
		"encodeGenerationRecordV1",
		"encodeHeadRecordV1",
		"inspectStorageCapability",
		"parseBlobDigest",
		"parseCapacityProfile",
		"parseClosureDigest",
		"parseGenerationId",
		"parseHeadRevision",
		"parseStorageObjectId",
		"requestPersistentStorage",
	] as const),
	compaction: Object.freeze([
		"CausalityIndex",
		"CompactMerkleAccumulator",
		"EMPTY_MERKLE_ROOT",
		"LinearizationError",
		"buildMerkleTree",
		"consistencyProof",
		"deriveCloseSetHistoryCommitment",
		"inclusionProof",
		"linearizeEpoch",
		"merkleLeafHash",
		"merkleNodeHash",
		"stateDigest",
		"topologicalOrder",
		"verifyConsistency",
		"verifyInclusion",
	] as const),
	node: Object.freeze(["createSqliteAheDurableStore"] as const),
});

export const SNAPSHOT_QUARANTINE_PACKAGE_EXPORT_MAPS = Object.freeze({
	browser: Object.freeze({
		".": Object.freeze({ import: "./dist/src/index.js", types: "./dist/src/index.d.ts" }),
		"./issuance": Object.freeze({ import: "./dist/src/issuance.js", types: "./dist/src/issuance.d.ts" }),
		"./live-journal": Object.freeze({ import: "./dist/src/live-journal.js", types: "./dist/src/live-journal.d.ts" }),
		"./snapshot-transfer": Object.freeze({
			import: "./dist/src/snapshot-transfer.js",
			types: "./dist/src/snapshot-transfer.d.ts",
		}),
	}),
	common: Object.freeze({
		".": Object.freeze({ import: "./dist/src/index.js", types: "./dist/src/index.d.ts" }),
		"./adapter": Object.freeze({ import: "./dist/src/adapter.js", types: "./dist/src/adapter.d.ts" }),
		"./contract": Object.freeze({ import: "./dist/src/contract.js", types: "./dist/src/contract.d.ts" }),
		"./snapshot-transfer": Object.freeze({
			import: "./dist/src/snapshot-transfer.js",
			types: "./dist/src/snapshot-transfer.d.ts",
		}),
	}),
	compaction: Object.freeze({
		".": Object.freeze({ import: "./dist/src/index.js", types: "./dist/src/index.d.ts" }),
		"./blueprint-fold": Object.freeze({
			import: "./dist/src/blueprint-fold.js",
			types: "./dist/src/blueprint-fold.d.ts",
		}),
		"./blueprint-snapshot": Object.freeze({
			import: "./dist/src/blueprint-snapshot.js",
			types: "./dist/src/blueprint-snapshot.d.ts",
		}),
		"./snapshot-quarantine-receipt": Object.freeze({
			import: "./dist/src/snapshot-quarantine-receipt.js",
			types: "./dist/src/snapshot-quarantine-receipt.d.ts",
		}),
		"./snapshot-stream": Object.freeze({
			import: "./dist/src/snapshot-stream.js",
			types: "./dist/src/snapshot-stream.d.ts",
		}),
	}),
	node: Object.freeze({
		".": Object.freeze({ import: "./dist/src/index.js", types: "./dist/src/index.d.ts" }),
		"./issuance": Object.freeze({ import: "./dist/src/issuance.js", types: "./dist/src/issuance.d.ts" }),
		"./live-journal": Object.freeze({ import: "./dist/src/live-journal.js", types: "./dist/src/live-journal.d.ts" }),
		"./snapshot-transfer": Object.freeze({
			import: "./dist/src/snapshot-transfer.js",
			types: "./dist/src/snapshot-transfer.d.ts",
		}),
	}),
});

export const SNAPSHOT_QUARANTINE_SCHEMA = Object.freeze({
	browser: Object.freeze({
		chunkFields: Object.freeze([
			"anchor",
			"byteLength",
			"digest",
			"epoch",
			"exactBytes",
			"index",
			"manifestDigest",
			"objectId",
		] as const),
		chunksKeyPath: Object.freeze(["objectId", "epoch", "anchor", "manifestDigest", "index"] as const),
		databaseSuffix: "--drp-snapshot-quarantine-v1",
		expiryIndex: "expiryAsc",
		scopesKeyPath: Object.freeze(["objectId", "epoch", "anchor", "manifestDigest"] as const),
		scopeFields: Object.freeze([
			"anchor",
			"chunkCount",
			"epoch",
			"exactCanonicalManifestBytes",
			"expiresAt",
			"manifestDigest",
			"objectId",
			"state",
			"totalBytes",
		] as const),
		stores: Object.freeze(["chunks", "scopes"] as const),
		version: 1,
	}),
	node: Object.freeze({
		chunkColumns: Object.freeze([
			"object_id",
			"epoch",
			"anchor",
			"manifest_digest",
			"chunk_index",
			"chunk_digest",
			"byte_length",
			"exact_bytes",
		] as const),
		databaseSuffix: ".drp-snapshot-quarantine-v1.sqlite",
		scopeColumns: Object.freeze([
			"object_id",
			"epoch",
			"anchor",
			"manifest_digest",
			"exact_manifest_bytes",
			"total_bytes",
			"chunk_count",
			"expires_at",
			"state",
		] as const),
		tables: Object.freeze(["snapshot_chunks", "snapshot_scopes"] as const),
		userVersion: 1,
	}),
});

export interface ReferenceChunk {
	readonly byteLength: number;
	readonly digest: string;
	readonly index: number;
}

export interface SnapshotQuarantineFixture {
	readonly chunks: readonly Uint8Array[];
	readonly declaration: ReferenceDeclaration;
}

function hex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function digest(domain: string, ...parts: readonly Uint8Array[]): string {
	return hex(hashDomain(domain, ...parts));
}

/**
 * Builds the one shared valid manifest/chunk fixture for all physical adapters.
 * @param input - Optional fixture identity and chunk bodies.
 * @param input.chunks - Exact chunk bodies.
 * @param input.epoch - Snapshot epoch.
 * @param input.objectId - Snapshot object identity.
 * @returns Detached fixture and closed storage declaration.
 */
export function createSnapshotQuarantineFixture(
	input: Readonly<{
		readonly chunks?: readonly Uint8Array[];
		readonly epoch?: number;
		readonly objectId?: string;
	}> = {}
): SnapshotQuarantineFixture {
	const chunks = Object.freeze(
		(
			input.chunks ?? [new Uint8Array(131_072).fill(1), new Uint8Array(131_072).fill(3), Uint8Array.of(2, 4, 6, 8, 10)]
		).map((bytes) => new Uint8Array(bytes))
	);
	const descriptors = Object.freeze(
		chunks.map((bytes, index) =>
			Object.freeze({
				byteLength: bytes.byteLength,
				digest: digest("ts-drp/snapshot-chunk/v3", encodeCanonical(index), bytes),
				index,
			})
		)
	);
	const payload = new Uint8Array(chunks.reduce((sum, bytes) => sum + bytes.byteLength, 0));
	let offset = 0;
	for (const bytes of chunks) {
		payload.set(bytes, offset);
		offset += bytes.byteLength;
	}
	const manifest = Object.freeze({
		aclDigest: "22".repeat(32),
		anchor: "11".repeat(32),
		chunks: descriptors,
		encodingVersion: "drp-canonical-profile-1",
		epoch: input.epoch ?? 4,
		kind: "drp-snapshot-manifest",
		objectId: input.objectId ?? "phase-4c-b-object",
		payloadDigest: digest("ts-drp/snapshot-payload/v3", payload),
		protocolMajor: 3,
		schemaVersion: 1,
		stateDigest: "33".repeat(32),
		totalBytes: payload.byteLength,
	});
	const exactCanonicalManifestBytes = encodeCanonical(manifest);
	return Object.freeze({
		chunks,
		declaration: Object.freeze({
			chunks: descriptors,
			exactCanonicalManifestBytes,
			scope: Object.freeze({
				anchor: manifest.anchor,
				epoch: manifest.epoch,
				manifestDigest: digest("ts-drp/snapshot-manifest/v3", exactCanonicalManifestBytes),
				objectId: manifest.objectId,
			}),
			totalBytes: payload.byteLength,
		}),
	});
}

export interface ReferenceDeclaration {
	readonly chunks: readonly ReferenceChunk[];
	readonly exactCanonicalManifestBytes: Uint8Array;
	readonly scope: Readonly<{
		readonly anchor: string;
		readonly epoch: number;
		readonly manifestDigest: string;
		readonly objectId: string;
	}>;
	readonly totalBytes: number;
}

export type ReferenceSnapshot = Readonly<{
	expiresAt: number;
	missingIndices: readonly number[];
	poisoned: boolean;
	verified: boolean;
}>;

interface ContractPort {
	read(descriptor: ReferenceChunk): Promise<Uint8Array | undefined>;
	write(descriptor: ReferenceChunk, exactBytes: Uint8Array): Promise<void>;
}

interface ContractScope {
	readonly verificationQuarantine: Readonly<{ open(signal: AbortSignal): ContractPort }>;
	cancel(): Promise<void>;
	missingIndices(): Promise<readonly number[]>;
	status(): Promise<Readonly<{ readonly expiresAt: number; readonly kind: string }>>;
}

export interface SnapshotQuarantineContractStore {
	openScope(declaration: ReferenceDeclaration): Promise<ContractScope>;
}

async function failureCode(action: Promise<unknown>): Promise<string> {
	try {
		await action;
		return "none";
	} catch (error) {
		return String(Reflect.get(error as object, "code"));
	}
}

/**
 * Runs the same causal storage transcript against every physical adapter.
 * @param input - Store and isolated fixture identity.
 * @param input.fixture - Valid signed declaration and exact chunk bodies.
 * @param input.store - Physical adapter under test.
 * @returns Backend-neutral observed transcript.
 */
export async function runSnapshotQuarantineBehaviorContract(
	input: Readonly<{
		readonly fixture: SnapshotQuarantineFixture;
		readonly store: SnapshotQuarantineContractStore;
	}>
): Promise<Readonly<Record<string, unknown>>> {
	const manifest = input.fixture.declaration.exactCanonicalManifestBytes;
	const partialBacking = new Uint8Array(manifest.byteLength + 2);
	partialBacking.set(manifest, 1);
	const hostileDeclarations: ReferenceDeclaration[] = [
		{ ...input.fixture.declaration, unexpected: true } as ReferenceDeclaration,
		Object.assign(Object.create({ inherited: true }) as object, input.fixture.declaration) as ReferenceDeclaration,
		{
			...input.fixture.declaration,
			chunks: Array.from({ length: SNAPSHOT_QUARANTINE_MAX_CHUNKS + 1 }, (_, index) =>
				Object.freeze({ byteLength: 1, digest: "00".repeat(32), index })
			),
		} as ReferenceDeclaration,
		{ ...input.fixture.declaration, totalBytes: SNAPSHOT_QUARANTINE_MAX_BYTES + 1 },
		{
			...input.fixture.declaration,
			exactCanonicalManifestBytes: new Uint8Array(partialBacking.buffer, 1, manifest.byteLength),
		},
	];
	if (typeof SharedArrayBuffer === "function") {
		const shared = new Uint8Array(new SharedArrayBuffer(manifest.byteLength));
		shared.set(manifest);
		hostileDeclarations.push({ ...input.fixture.declaration, exactCanonicalManifestBytes: shared });
	}
	const resizable = Reflect.construct(ArrayBuffer, [
		manifest.byteLength,
		{ maxByteLength: manifest.byteLength + 1 },
	]) as ArrayBuffer;
	if (Reflect.get(resizable, "resizable") === true) {
		const resizableBytes = new Uint8Array(resizable);
		resizableBytes.set(manifest);
		hostileDeclarations.push({ ...input.fixture.declaration, exactCanonicalManifestBytes: resizableBytes });
	}
	const declarationFailures: string[] = [];
	for (const declaration of hostileDeclarations)
		declarationFailures.push(await failureCode(input.store.openScope(declaration)));
	const scope = await input.store.openScope(input.fixture.declaration);
	const port = scope.verificationQuarantine.open(new AbortController().signal);
	const descriptor = input.fixture.declaration.chunks[1];
	const expected = input.fixture.chunks[1];
	if (descriptor === undefined || expected === undefined) throw new Error("contract fixture requires index 1");
	const clean = new Uint8Array(expected);
	const mutable = new Uint8Array(clean);
	const writing = port.write(descriptor, mutable);
	mutable.fill(0);
	await writing;
	const missing = await scope.missingIndices();
	const firstExpiry = (await scope.status()).expiresAt;
	await port.write(descriptor, new Uint8Array(clean));
	const duplicateExpiry = (await scope.status()).expiresAt;
	const firstRead = await port.read(descriptor);
	firstRead?.fill(0);
	const detachedRead = await port.read(descriptor);
	const foreignDescriptor = Object.freeze({ ...descriptor, digest: "ff".repeat(32) });
	const foreign = await failureCode(port.write(foreignDescriptor, clean));
	const conflict = await failureCode(port.write(descriptor, new Uint8Array(descriptor.byteLength).fill(9)));
	const poisoned = (await scope.status()).kind;
	await scope.cancel();
	return Object.freeze({
		conflict,
		declarationFailures: Object.freeze(declarationFailures),
		detachedRead:
			detachedRead?.byteLength === clean.byteLength && detachedRead.every((byte, index) => byte === clean[index]),
		duplicateExpiry,
		firstExpiry,
		foreign,
		missing: Object.freeze([...missing]),
		poisoned,
	});
}

/**
 * Evaluates the independent missing-set and retention reference state.
 * @param input - Reference evaluation input.
 * @param input.declaration - Frozen scope declaration.
 * @param input.now - Captured owner-local time.
 * @param input.occupied - Independently occupied chunk indices.
 * @param input.poisoned - Whether the reference scope is poisoned.
 * @param input.verified - Whether the reference scope is verified.
 * @returns Frozen reference snapshot.
 */
export function referenceSnapshot(input: {
	readonly declaration: ReferenceDeclaration;
	readonly now: number;
	readonly occupied: ReadonlyMap<number, Uint8Array>;
	readonly poisoned?: boolean;
	readonly verified?: boolean;
}): ReferenceSnapshot {
	const missingIndices = input.declaration.chunks
		.filter(({ index }) => !input.occupied.has(index))
		.map(({ index }) => index);
	return Object.freeze({
		expiresAt: input.now + SNAPSHOT_QUARANTINE_RETENTION_MS,
		missingIndices: Object.freeze(missingIndices),
		poisoned: input.poisoned ?? false,
		verified: input.verified ?? false,
	});
}
