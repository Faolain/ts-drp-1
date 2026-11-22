export const SNAPSHOT_CHUNK_PROTOCOL = "/ts-drp/v3/snapshot-chunk/1.0.0" as const;
export const SNAPSHOT_PULL_INACTIVITY_MS = 10_000 as const;
export const SNAPSHOT_PULL_TOTAL_MS = 120_000 as const;
export const SNAPSHOT_PULL_MAX_ATTEMPTS = 3 as const;
export const SNAPSHOT_PULL_MAX_OUTSTANDING = 4 as const;
export const SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS = 4 as const;
export const SNAPSHOT_PULL_MAX_BODY_BYTES = 131_072 as const;
export const SNAPSHOT_PULL_MAX_MANIFEST_BYTES = 212_387 as const;

export const SNAPSHOT_PULL_FAILURE_CODES = Object.freeze([
	"aborted",
	"authorization-rejected",
	"body-budget-exceeded",
	"chunk-invalid",
	"connection-unavailable",
	"inactivity-timeout",
	"manifest-invalid",
	"protocol-violation",
	"quarantine-failed",
	"session-capacity",
	"total-timeout",
	"transfer-exhausted",
] as const);

export const SNAPSHOT_PULL_REQUEST_FIELDS = Object.freeze({
	chunks: Object.freeze(["descriptors", "kind", "manifestDigest", "version"] as const),
	manifest: Object.freeze(["kind", "manifestDigest", "version"] as const),
});

export const SNAPSHOT_PULL_REQUEST_DESCRIPTOR_FIELDS = Object.freeze(["digest", "index"] as const);

export const SNAPSHOT_PULL_RESPONSE_FIELDS = Object.freeze({
	chunk: Object.freeze(["byteLength", "digest", "index", "kind", "manifestDigest", "version"] as const),
	manifest: Object.freeze(["exactCanonicalManifestBytes", "kind", "manifestDigest", "version"] as const),
});

export const SNAPSHOT_PULL_NETWORK_EXPORTS = Object.freeze([
	"SNAPSHOT_CHUNK_PROTOCOL",
	"createSnapshotChunkProtocolPort",
] as const);

export const SNAPSHOT_PULL_NODE_EXPORTS = Object.freeze([
	"SNAPSHOT_PULL_INACTIVITY_MS",
	"SNAPSHOT_PULL_MAX_ATTEMPTS",
	"SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS",
	"SNAPSHOT_PULL_MAX_OUTSTANDING",
	"SNAPSHOT_PULL_TOTAL_MS",
	"createV3SnapshotTransferOwner",
] as const);

/**
 * Selects one canonical bounded request from an arbitrary durable missing set.
 * @param descriptors - Authenticated manifest descriptors.
 * @param missingIndices - Durable missing indices in any order.
 * @returns The ascending unique first four manifest descriptors.
 */
export function orderedMissingBatch(
	descriptors: readonly Readonly<{ readonly digest: string; readonly index: number }>[],
	missingIndices: readonly number[]
): readonly Readonly<{ readonly digest: string; readonly index: number }>[] {
	const missing = new Set(missingIndices);
	return Object.freeze(
		descriptors
			.filter(({ index }) => missing.has(index))
			.sort((left, right) => left.index - right.index)
			.slice(0, SNAPSHOT_PULL_MAX_OUTSTANDING)
			.map(({ digest, index }) => Object.freeze({ digest, index }))
	);
}
