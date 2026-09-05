import { encodeCanonical } from "@ts-drp/canonical";

export type SettlementDisposition = "expire" | "manual-review" | "rebase" | "transform";

export interface TestScope {
	readonly author: string;
	readonly objectId: string;
}

export interface TestSettlementPlanEntry {
	readonly disposition: SettlementDisposition;
	readonly replacementSequence: number | null;
	readonly sourceDigest: Uint8Array;
	readonly sourceSequence: number;
}

export interface TestSettlementPlan {
	readonly entries: readonly TestSettlementPlanEntry[];
	readonly fenceSequence: number | null;
	readonly revision: number;
	readonly scope: TestScope;
}

export type TestPlanEffect =
	| Readonly<{ readonly kind: "fence" }>
	| Readonly<{ readonly kind: "replacement"; readonly sourceSequence: number }>;

export interface TestCommit {
	readonly authorSequence: number;
	readonly envelope: TestEnvelope;
	readonly issuedRecord: Readonly<{
		readonly authorSequence: number;
		readonly envelope: TestEnvelope;
		readonly scope: TestScope;
	}>;
	readonly outboxEntry: Readonly<{
		readonly authorSequence: number;
		readonly envelope: TestEnvelope;
		readonly scope: TestScope;
	}>;
	readonly planEffect?: TestPlanEffect;
}

interface TestEnvelope {
	readonly canonicalPreimageBytes: Uint8Array;
	readonly digest: Uint8Array;
	readonly signature: Uint8Array;
}

export interface TestPlanStore {
	close(): Promise<void>;
	compareAndMarkOutboxPublished(input: {
		readonly authorSequence: number;
		readonly digest: Uint8Array;
		readonly scope: TestScope;
	}): Promise<void>;
	readIssued(scope: TestScope, authorSequence: number): Promise<TestCommit | null>;
	readLineage(scope: TestScope): Promise<Readonly<{ readonly exhausted: boolean; readonly next: number }>>;
	readSettlementPlan(scope: TestScope): Promise<TestSettlementPlan | null>;
	transactIssue(scope: TestScope, buildAndSign: (authorSequence: number) => Promise<TestCommit>): Promise<TestCommit>;
	transactWriteSettlementPlan(
		input: Readonly<{
			readonly expectedRevision: number | null;
			readonly plan: TestSettlementPlan;
			readonly scope: TestScope;
		}>
	): Promise<TestSettlementPlan>;
}

export interface TestPruningMaintenance {
	inspectPruningState(scope: TestScope): Promise<
		Readonly<{
			readonly lineage: Readonly<{ readonly exhausted: boolean; readonly next: number }>;
			readonly prunedThroughAuthorSequence: number | null;
			readonly scope: TestScope;
		}>
	>;
	pruneAuthenticatedSettledPrefix(input: unknown): Promise<unknown>;
	prunePublishedPrefix(input: unknown): Promise<unknown>;
}

export const F5B0S_SCOPE = Object.freeze({ author: "author:settlement-red", objectId: "room:settlement-red" });

export const F5B0S_REQUIRED_TYPE_TOKENS = Object.freeze([
	"export type SettlementDisposition",
	"export interface SettlementPlanEntry",
	"export interface SettlementPlan",
	"readonly planEffect?",
	"readSettlementPlan(scope",
	"transactWriteSettlementPlan(input",
] as const);

export const F5B0S_STORE_CASES = Object.freeze([
	"cas-revision",
	"fence-atomic-link",
	"replacement-atomic-link",
	"fence-plan-missing",
	"fence-already-set",
	"fence-manual-review",
	"replacement-entry-absent",
	"replacement-already-linked",
	"replacement-manual-review",
	"ambiguous-fence-readback",
	"ambiguous-replacement-readback",
	"corrupt-plan-refusal",
	"unlinked-entry-prune-gate",
] as const);

/**
 *
 * @param sourceSequence
 * @param disposition
 * @param replacementSequence
 * @param seed
 */
export function settlementEntry(
	sourceSequence: number,
	disposition: SettlementDisposition = "rebase",
	replacementSequence: number | null = null,
	seed = sourceSequence + 17
): TestSettlementPlanEntry {
	return {
		disposition,
		replacementSequence,
		sourceDigest: Uint8Array.of(seed & 0xff, 0xd1),
		sourceSequence,
	};
}

/**
 *
 * @param input
 */
export function settlementPlan(
	input: Readonly<{
		readonly entries?: readonly TestSettlementPlanEntry[];
		readonly fenceSequence?: number | null;
		readonly revision?: number;
		readonly scope?: TestScope;
	}> = {}
): TestSettlementPlan {
	return {
		entries: input.entries ?? [settlementEntry(10)],
		fenceSequence: input.fenceSequence ?? null,
		revision: input.revision ?? 0,
		scope: input.scope ?? F5B0S_SCOPE,
	};
}

/**
 *
 * @param scope
 * @param authorSequence
 * @param effect
 * @param epoch
 */
export function settlementCommit(
	scope: TestScope,
	authorSequence: number,
	effect?: TestPlanEffect,
	epoch = 7
): TestCommit {
	const envelope = {
		canonicalPreimageBytes: encodeCanonical({
			author: scope.author,
			authorSequence,
			epoch,
			kind: "drp-vertex",
			objectId: scope.objectId,
			protocolMajor: 3,
		}),
		digest: Uint8Array.of(authorSequence + 31, 0xd1),
		signature: Uint8Array.of(authorSequence + 31, 0x51),
	};
	return {
		authorSequence,
		envelope,
		issuedRecord: { authorSequence, envelope, scope },
		outboxEntry: { authorSequence, envelope, scope },
		...(effect === undefined ? {} : { planEffect: effect }),
	};
}

/**
 *
 * @param lineage
 * @param throughAuthorSequence
 */
export function pruningInput(
	lineage: Readonly<{ readonly exhausted: boolean; readonly next: number }>,
	throughAuthorSequence: number
): Readonly<Record<string, unknown>> {
	return {
		closedEpoch: 7,
		commitQcRef: { byteLength: 1, digest: "e".repeat(64) },
		expectedLineage: lineage,
		expectedPrunedThroughAuthorSequence: null,
		scope: F5B0S_SCOPE,
		snapshotManifestDigest: "f".repeat(64),
		throughAuthorSequence,
	};
}

/**
 *
 * @param promise
 */
export async function captureFailure(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
		return undefined;
	} catch (error) {
		return error;
	}
}

/**
 *
 * @param error
 */
export function errorCode(error: unknown): unknown {
	return typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
}

/**
 *
 * @param plan
 */
export function planSnapshot(plan: TestSettlementPlan | null): unknown {
	if (plan === null) return null;
	return {
		entries: plan.entries.map((entry) => ({
			disposition: entry.disposition,
			replacementSequence: entry.replacementSequence,
			sourceDigest: [...entry.sourceDigest],
			sourceSequence: entry.sourceSequence,
		})),
		fenceSequence: plan.fenceSequence,
		revision: plan.revision,
		scope: { ...plan.scope },
	};
}
