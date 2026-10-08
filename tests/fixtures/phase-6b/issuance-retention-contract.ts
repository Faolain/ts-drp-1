import { encodeCanonical } from "@ts-drp/canonical";
import type {
	DurableIssuanceStore,
	DurableIssueCommit,
	DurableIssueScope,
	DurableLineage,
} from "@ts-drp/issuance-store";

export const D109B_RED_PATHS = Object.freeze([
	"tests/fixtures/phase-6b/issuance-retention-contract.ts",
	"tests/phase-6b-issuance-retention-red.test.ts",
	"packages/storage-node/tests/fixtures/phase-6b-issuance-retention-child.mjs",
	"packages/storage-node/tests/phase-6b-issuance-retention-red.test.ts",
	"packages/storage-browser/tests/assets/phase-6b-issuance-retention-entry.ts",
	"packages/storage-browser/tests/phase-6b-issuance-retention-global-setup.ts",
	"packages/storage-browser/tests/phase-6b-issuance-retention-red.pw.ts",
	"packages/storage-browser/playwright.phase-6b-issuance-retention.config.ts",
] as const);

export const D109B_GREEN_PATHS = Object.freeze([
	"packages/issuance-store/src/maintenance.ts",
	"packages/issuance-store/src/conformance.ts",
	"packages/issuance-store/src/terminal.ts",
	"packages/issuance-store/src/types.ts",
	"packages/storage-node/src/internal/node-issuance-store.ts",
	"packages/storage-node/src/issuance-maintenance.ts",
	"packages/storage-browser/src/internal/browser-issuance-store.ts",
	"packages/storage-browser/src/issuance-maintenance.ts",
	"packages/node/src/internal/closed-epoch-cleanup.ts",
] as const);

export const D109B_PAGE_BOUNDARIES = Object.freeze([64, 65, 128, 129] as const);

export const D109B_SEMANTIC_CASES = Object.freeze([
	"identity-genuine",
	"identity-copy-denied",
	"identity-proxy-denied",
	"identity-cross-backend-denied",
	"input-accessor-denied-before-transaction",
	"input-copy-detached",
	"receipt-deep-frozen",
	"published-prefix-delete",
	"same-input-lost-receipt-noop",
	"stale-lineage-retry",
	"stale-watermark-retry",
	"pending-prefix-retry-nonpoisoning",
	"wrong-epoch-invalid-nonpoisoning",
	"newer-pending-suffix-retained",
	"unrelated-scope-retained",
	"late-exact-ack-pruned",
	"late-wrong-digest-ack-pruned",
	"null-watermark-consumed-absence-corrupt",
	"at-watermark-present-corrupt",
	"above-watermark-consumed-absence-corrupt",
	"terminal-watermark-missing-corrupt",
	"terminal-watermark-invalid-corrupt",
	"read-lineage-after-prune",
	"read-outbox-after-prune",
	"later-issue-preserves-watermark",
	"cold-restart-replan",
	"later-closed-epoch-replan",
] as const);

export const D109B_NATIVE_MUTANTS = Object.freeze([
	"canonical-malformed",
	"vertex-kind-wrong",
	"protocol-major-wrong",
	"scope-wrong",
	"ordinal-wrong",
	"epoch-wrong",
	"issued-only",
	"outbox-only",
	"digest-mismatch",
	"sequence-gap",
	"epoch-regression",
	"delete-count-mismatch",
	"watermark-update-count-mismatch",
	"transaction-abort-before-delete",
	"transaction-abort-after-delete",
	"transaction-abort-after-watermark",
	"concurrent-stale-handle",
] as const);

export const D109B_NODE_MIGRATION_CASES = Object.freeze([
	"fresh-v2",
	"exact-v1-in-place",
	"v1-row-preservation",
	"v1-failed-migration-rollback",
	"two-handle-v1-single-migration",
	"exact-v2-noop",
	"unknown-version-rejected",
	"unknown-catalog-rejected",
	"same-derived-filename",
	"reopen-numeric-watermark",
] as const);

export const D109B_CRASH_EDGES = Object.freeze([
	"before-delete",
	"after-issued-delete",
	"after-pair-delete",
	"after-watermark-write",
	"before-commit",
	"after-commit",
] as const);

export interface D109bPruningState {
	readonly lineage: DurableLineage;
	readonly prunedThroughAuthorSequence: number | null;
	readonly scope: DurableIssueScope;
}

export interface D109bPruningReceipt {
	readonly closedEpoch: number;
	readonly commitQcRef: Readonly<{ readonly byteLength: number; readonly digest: string }>;
	readonly deletedAuthorSequenceRange: Readonly<{ readonly from: number; readonly through: number }> | null;
	readonly observedLineage: DurableLineage;
	readonly prunedThroughAuthorSequence: number;
	readonly scope: DurableIssueScope;
	readonly snapshotManifestDigest: string;
}

export interface D109bPruningMaintenance {
	inspectPruningState(scope: DurableIssueScope): Promise<D109bPruningState>;
	prunePublishedPrefix(input: unknown): Promise<D109bPruningReceipt>;
}

export interface D109bConformanceModule {
	createEphemeralDurableIssuanceStore(options?: {
		readonly initialLineages?: readonly {
			readonly exhausted: boolean;
			readonly next: number;
			readonly scope: DurableIssueScope;
		}[];
	}): DurableIssuanceStore;
	resolveEphemeralDurableIssuancePruningMaintenance(store: DurableIssuanceStore): D109bPruningMaintenance | undefined;
}

export interface D109bNodeModule {
	createNodeDurableIssuanceStore(options: unknown): DurableIssuanceStore;
}

export interface D109bNodeMaintenanceModule {
	resolveNodeDurableIssuancePruningMaintenance(store: DurableIssuanceStore): D109bPruningMaintenance | undefined;
}

export const D109B_SCOPE = Object.freeze({
	author: "a".repeat(64),
	objectId: `creator:${"b".repeat(32)}`,
});

export const D109B_OTHER_SCOPE = Object.freeze({
	author: "c".repeat(64),
	objectId: `creator:${"d".repeat(32)}`,
});

function bytes(seed: number, length: number): Uint8Array {
	return Uint8Array.from({ length }, (_, index) => (seed + index) & 0xff);
}

/**
 * Creates one structurally valid v3 issuance closure.
 * @param scope - Issuance scope to bind.
 * @param authorSequence - Selected author ordinal.
 * @param epoch - Vertex epoch encoded in the canonical preimage.
 * @param seed - Deterministic byte seed.
 * @returns A complete detached commit.
 */
export function d109bCommit(
	scope: DurableIssueScope,
	authorSequence: number,
	epoch: number,
	seed = authorSequence + epoch + 1
): DurableIssueCommit {
	const envelope = {
		canonicalPreimageBytes: encodeCanonical({
			author: scope.author,
			authorSequence,
			epoch,
			kind: "drp-vertex",
			objectId: scope.objectId,
			protocolMajor: 3,
		}),
		digest: bytes(seed, 32),
		signature: bytes(seed + 64, 64),
	};
	return {
		authorSequence,
		envelope,
		issuedRecord: { authorSequence, envelope, scope },
		outboxEntry: { authorSequence, envelope, scope },
	};
}

/**
 * Issues one fixture commit and optionally marks its outbox row published.
 * @param store - Issuance store under test.
 * @param scope - Scope to issue against.
 * @param epoch - Vertex epoch to encode.
 * @param published - Whether to acknowledge publication.
 * @returns The committed closure.
 */
export async function d109bIssue(
	store: DurableIssuanceStore,
	scope: DurableIssueScope,
	epoch: number,
	published = true
): Promise<DurableIssueCommit> {
	const commit = await store.transactIssue(scope, (authorSequence) =>
		Promise.resolve(d109bCommit(scope, authorSequence, epoch))
	);
	if (published) {
		await store.compareAndMarkOutboxPublished({
			authorSequence: commit.authorSequence,
			digest: commit.envelope.digest,
			scope,
		});
	}
	return commit;
}

/**
 * Builds one exact pruning request from an observed state.
 * @param state - Detached pruning-state observation.
 * @param closedEpoch - Closed epoch being removed.
 * @param throughAuthorSequence - Inclusive deletion boundary.
 * @returns A frozen exact pruning request.
 */
export function d109bPruningInput(
	state: D109bPruningState,
	closedEpoch: number,
	throughAuthorSequence: number
): Readonly<Record<string, unknown>> {
	return Object.freeze({
		closedEpoch,
		commitQcRef: Object.freeze({ byteLength: 32, digest: "e".repeat(64) }),
		expectedLineage: Object.freeze({ ...state.lineage }),
		expectedPrunedThroughAuthorSequence: state.prunedThroughAuthorSequence,
		scope: Object.freeze({ ...state.scope }),
		snapshotManifestDigest: "f".repeat(64),
		throughAuthorSequence,
	});
}

/**
 * Reads only the public code from an unknown failure.
 * @param error - Unknown thrown value.
 * @returns Its string code, when present.
 */
export function d109bErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && typeof Reflect.get(error, "code") === "string"
		? String(Reflect.get(error, "code"))
		: undefined;
}

/**
 * Tests recursive immutability without revisiting cycles.
 * @param value - Candidate object graph.
 * @param seen - Already visited objects.
 * @returns Whether every reachable object is frozen.
 */
export function d109bDeepFrozen(value: unknown, seen = new Set<object>()): boolean {
	if (value === null || typeof value !== "object" || seen.has(value)) return true;
	seen.add(value);
	if (!Object.isFrozen(value)) return false;
	return Object.values(value).every((entry) => d109bDeepFrozen(entry, seen));
}
