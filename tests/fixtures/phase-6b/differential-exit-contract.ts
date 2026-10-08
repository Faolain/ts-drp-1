import {
	digestClosure,
	type ExpectedHead,
	type GenerationId,
	type GenerationRecord,
	type GenerationRef,
	type PresentHead,
	type StorageObjectId,
} from "@ts-drp/storage";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const D109F_RED_PATHS = Object.freeze([
	"tests/fixtures/phase-6b/differential-exit-contract.ts",
	"tests/phase-6b-differential-exit-red.test.ts",
	"packages/storage-node/tests/fixtures/phase-6b-differential-exit-child.mjs",
	"packages/storage-node/tests/phase-6b-differential-exit-red.test.ts",
	"packages/storage-browser/tests/assets/phase-6b-differential-exit-entry.ts",
	"packages/storage-browser/tests/phase-6b-differential-exit-global-setup.ts",
	"packages/storage-browser/tests/phase-6b-differential-exit-red.pw.ts",
	"packages/storage-browser/playwright.phase-6b-differential-exit.config.ts",
] as const);

export const D109F_GREEN_PATHS = Object.freeze([
	"packages/storage/src/maintenance.ts",
	"packages/issuance-store/src/maintenance.ts",
	"packages/storage-node/src/internal/node-issuance-store.ts",
] as const);

export const D109F_POLICY_DIGEST = "53775c5c1ee01e346f588966d6e7acb876df2bd8b2abcbe2b2591f216f7d4d9b";
export const D109F_OBJECT_ID = `creator:${"f".repeat(32)}` as StorageObjectId;
export const D109F_SCOPE = Object.freeze({ author: "e".repeat(64), objectId: D109F_OBJECT_ID });
export const D109F_STEP_COUNT = 128;
export const D109F_PROOF_KIND_REGISTRY = Object.freeze([
	Object.freeze({ name: "ahe.blobs", proofKind: "durable-count" }),
	Object.freeze({ name: "ahe.generations", proofKind: "durable-count" }),
	Object.freeze({ name: "ahe.heads", proofKind: "durable-count" }),
	Object.freeze({ name: "ahe.promotions", proofKind: "durable-count" }),
	Object.freeze({ name: "ahe.references", proofKind: "durable-count" }),
	Object.freeze({ name: "browser.facade-keys", proofKind: "stable-key-set" }),
	Object.freeze({
		name: "creator-close.commitment",
		ownerKey: "creatorCloseDerivedCommitment",
		proofKind: "owner-observed-lifecycle",
	}),
	Object.freeze({
		name: "creator-close.durable-replay",
		ownerKey: "creatorCloseDurableReplay",
		proofKind: "owner-observed-lifecycle",
	}),
	Object.freeze({
		name: "creator-close.graph",
		ownerKey: "creatorCloseGraph",
		proofKind: "owner-observed-lifecycle",
	}),
	Object.freeze({
		name: "creator-close.persisted-snapshot",
		ownerKey: "creatorClosePersistedSnapshot",
		proofKind: "owner-observed-lifecycle",
	}),
	Object.freeze({
		name: "creator-close.staged-snapshot",
		ownerKey: "creatorCloseStagedSnapshot",
		proofKind: "owner-observed-lifecycle",
	}),
	Object.freeze({ name: "issuance.issued-records", proofKind: "durable-count" }),
	Object.freeze({ name: "issuance.lineage", proofKind: "durable-count" }),
	Object.freeze({ name: "issuance.outbox", proofKind: "durable-count" }),
	Object.freeze({ name: "issuance.watermark", proofKind: "durable-count" }),
	Object.freeze({ name: "legacy.finality", proofKind: "retained-unchanged" }),
	Object.freeze({ name: "legacy.object", proofKind: "retained-unchanged" }),
	Object.freeze({ name: "live-journal.rows", proofKind: "durable-count" }),
	Object.freeze({ name: "package.export-maps", proofKind: "stable-key-set" }),
	Object.freeze({ name: "package.factory-maps", proofKind: "stable-key-set" }),
	Object.freeze({ name: "package.module-maps", proofKind: "stable-key-set" }),
	Object.freeze({ name: "runtime.anchor", proofKind: "owner-observed-lifecycle" }),
	Object.freeze({
		name: "runtime.application-authors",
		ownerKey: "applicationAuthors",
		proofKind: "owner-observed-lifecycle",
	}),
	Object.freeze({
		name: "runtime.application-charges",
		ownerKey: "applicationCharges",
		proofKind: "owner-observed-lifecycle",
	}),
	Object.freeze({
		name: "runtime.application-vertices",
		ownerKey: "applicationVertices",
		proofKind: "owner-observed-lifecycle",
	}),
	Object.freeze({
		name: "runtime.blueprint-state",
		ownerKey: "blueprintState",
		proofKind: "owner-observed-lifecycle",
	}),
	Object.freeze({
		name: "runtime.causality-index",
		ownerKey: "causalityIndex",
		proofKind: "owner-observed-lifecycle",
	}),
	Object.freeze({
		name: "runtime.displaced-rebase-cursor",
		ownerKey: "displacedRebaseCursor",
		proofKind: "owner-observed-lifecycle",
	}),
	Object.freeze({
		name: "runtime.displaced-source",
		ownerKey: "displacedSource",
		proofKind: "owner-observed-lifecycle",
	}),
	Object.freeze({
		name: "runtime.epoch-bytes",
		ownerKey: "epochBytes",
		proofKind: "owner-observed-lifecycle",
	}),
	Object.freeze({
		name: "runtime.graph-version",
		ownerKey: "graphVersion",
		proofKind: "owner-observed-lifecycle",
	}),
	Object.freeze({
		name: "runtime.hot-predecessor",
		ownerKey: "hotPredecessor",
		proofKind: "owner-observed-lifecycle",
	}),
	Object.freeze({
		name: "runtime.latched-operations",
		ownerKey: "latchedOperations",
		proofKind: "owner-observed-lifecycle",
	}),
	Object.freeze({
		name: "runtime.pending-ingress",
		ownerKey: "pendingIngress",
		proofKind: "owner-observed-lifecycle",
	}),
	Object.freeze({
		name: "runtime.pending-ingress-bytes",
		ownerKey: "pendingIngressBytes",
		proofKind: "owner-observed-lifecycle",
	}),
	Object.freeze({
		name: "runtime.publication",
		ownerKey: "publication",
		proofKind: "owner-observed-lifecycle",
	}),
	Object.freeze({
		name: "runtime.quarantine",
		ownerKey: "quarantine",
		proofKind: "owner-observed-lifecycle",
	}),
	Object.freeze({ name: "runtime.rebase", ownerKey: "rebase", proofKind: "owner-observed-lifecycle" }),
	Object.freeze({
		name: "runtime.retained-payload-metadata",
		ownerKey: "retainedPayloadMetadata",
		proofKind: "owner-observed-lifecycle",
	}),
	Object.freeze({ name: "snapshot-quarantine.chunks", proofKind: "durable-count" }),
] as const);

export type D109fPlannerResult =
	| Readonly<{ readonly ok: false; readonly reason: string }>
	| Readonly<{
			readonly ok: true;
			readonly plan: Readonly<{
				readonly activeGenerationId: GenerationId;
				readonly availabilityPolicyDigest: string;
				readonly closedEpoch: number;
				readonly expectedHead: PresentHead;
				readonly lineageFloor: Readonly<{
					readonly deleteGenerationIds: readonly GenerationId[];
					readonly expectedBaseExpectedHead: ExpectedHead;
					readonly generationId: GenerationId;
					readonly replacementBaseExpectedHead: ExpectedHead;
				}>;
				readonly objectId: StorageObjectId;
				readonly rollbackGenerationIds: readonly [GenerationId, GenerationId];
			}>;
	  }>;

type Planner = (input: unknown) => D109fPlannerResult;

export interface D109fDifferentialStep {
	readonly activeGenerationId: GenerationId;
	readonly archivalDeleteCount: number;
	readonly closedEpoch: number;
	readonly compactedDeleteCount: number;
	readonly floorGenerationId: GenerationId;
	readonly rollbackGenerationIds: readonly [GenerationId, GenerationId];
}

export interface D109fDifferentialResult {
	readonly archivalGenerationCount: number;
	readonly compactedGenerationCount: number;
	readonly steps: readonly D109fDifferentialStep[];
}

/**
 * Creates one deterministic canonical generation identifier.
 * @param index - Positive fixture ordinal.
 * @returns The canonical identifier.
 */
export function d109fGenerationId(index: number): GenerationId {
	return index.toString(16).padStart(64, "0") as GenerationId;
}

function generationRef(index: number): GenerationRef {
	return Object.freeze({ byteLength: index + 3, digest: (index + 4096).toString(16).padStart(64, "0") });
}

function closureDigest(closure: readonly GenerationRef[]): string {
	const result = digestClosure(closure);
	if (!result.ok) throw new TypeError(`D109F_CLOSURE_DIGEST:${result.reason}`);
	return result.value;
}

function presentHead(index: number): PresentHead {
	const closure = Object.freeze([generationRef(index)]);
	return Object.freeze({
		closureDigest: closureDigest(closure),
		generationId: d109fGenerationId(index),
		kind: "present" as const,
		objectId: D109F_OBJECT_ID,
		revision: index,
	});
}

function appendGeneration(records: readonly GenerationRecord[], index: number): readonly GenerationRecord[] {
	const previous = records.map((record, position) =>
		position === records.length - 1 && record.state === "Adopted"
			? Object.freeze({ ...record, state: "Superseded" as const })
			: record
	);
	const closure = Object.freeze([generationRef(index)]);
	return Object.freeze([
		...previous,
		Object.freeze({
			baseExpectedHead:
				index === 1 ? Object.freeze({ kind: "none" as const, objectId: D109F_OBJECT_ID }) : presentHead(index - 1),
			closure,
			closureDigest: closureDigest(closure),
			generationId: d109fGenerationId(index),
			objectId: D109F_OBJECT_ID,
			state: "Adopted" as const,
		}),
	]);
}

function planningInput(records: readonly GenerationRecord[], closedEpoch: number): Readonly<Record<string, unknown>> {
	const active = records.at(-1);
	if (active === undefined) throw new TypeError("D109F_ACTIVE_GENERATION_MISSING");
	const expectedHead = presentHead(Number.parseInt(active.generationId, 16));
	return Object.freeze({
		adoption: Object.freeze({ activeHead: expectedHead, adopted: true }),
		availabilityPolicyDigest: D109F_POLICY_DIGEST,
		close: Object.freeze({
			closedEpoch,
			commitQcRef: generationRef(closedEpoch + 8192),
			objectId: D109F_OBJECT_ID,
			verified: true,
		}),
		expectedHead,
		generations: records,
		issuance: Object.freeze({
			complete: true,
			lineage: Object.freeze({ exhausted: false, next: 1 }),
			prunedThroughAuthorSequence: null,
			rows: Object.freeze([
				Object.freeze({
					authorSequence: 0,
					epoch: closedEpoch,
					issued: true,
					outbox: true,
					publishState: "published" as const,
				}),
			]),
			scope: D109F_SCOPE,
			throughAuthorSequence: 0,
		}),
		snapshot: Object.freeze({ adopted: true, manifestDigest: "d".repeat(64) }),
	});
}

function compact(
	records: readonly GenerationRecord[],
	plan: Extract<D109fPlannerResult, { ok: true }>["plan"]
): readonly GenerationRecord[] {
	const deleted = new Set(plan.lineageFloor.deleteGenerationIds);
	return Object.freeze(
		records
			.filter(({ generationId }) => !deleted.has(generationId))
			.map((record) =>
				record.generationId === plan.lineageFloor.generationId
					? Object.freeze({
							...record,
							baseExpectedHead: Object.freeze({ kind: "none" as const, objectId: D109F_OBJECT_ID }),
						})
					: record
			)
	);
}

function assertNoDanglingParent(records: readonly GenerationRecord[]): void {
	const ids = new Set(records.map(({ generationId }) => generationId));
	if (
		records.some(
			(record) => record.baseExpectedHead.kind === "present" && !ids.has(record.baseExpectedHead.generationId)
		)
	) {
		throw new TypeError("D109F_DANGLING_PARENT");
	}
}

/**
 * Loads the genuine internal D.109a planner.
 * @returns The planner function.
 */
export async function d109fPlanner(): Promise<Planner> {
	const root = resolve(import.meta.dirname, "../../..");
	const module = (await import(
		pathToFileURL(resolve(root, "packages/node/src/internal/closed-epoch-cleanup.ts")).href
	)) as { planClosedEpochCleanup(input: unknown): D109fPlannerResult };
	return module.planClosedEpochCleanup;
}

/**
 * Runs the frozen 128-step archival-versus-compacted planner differential.
 * @returns Complete deterministic step and projection evidence.
 */
export async function runD109fPlannerDifferential(): Promise<D109fDifferentialResult> {
	const planner = await d109fPlanner();
	let archival: readonly GenerationRecord[] = Object.freeze([]);
	let compacted: readonly GenerationRecord[] = Object.freeze([]);
	for (let index = 1; index <= 3; index += 1) {
		archival = appendGeneration(archival, index);
		compacted = appendGeneration(compacted, index);
	}
	const steps: D109fDifferentialStep[] = [];
	for (let step = 0; step < D109F_STEP_COUNT; step += 1) {
		const generationIndex = step + 4;
		archival = appendGeneration(archival, generationIndex);
		compacted = appendGeneration(compacted, generationIndex);
		const archivalResult = planner(planningInput(archival, step));
		const compactedResult = planner(planningInput(compacted, step));
		if (!archivalResult.ok || !compactedResult.ok) {
			throw new TypeError(
				`D109F_PLANNER_REFUSED:${step}:${archivalResult.ok ? "ok" : archivalResult.reason}:${compactedResult.ok ? "ok" : compactedResult.reason}`
			);
		}
		const archivalPlan = archivalResult.plan;
		const compactedPlan = compactedResult.plan;
		if (
			archivalPlan.activeGenerationId !== compactedPlan.activeGenerationId ||
			archivalPlan.lineageFloor.generationId !== compactedPlan.lineageFloor.generationId ||
			JSON.stringify(archivalPlan.rollbackGenerationIds) !== JSON.stringify(compactedPlan.rollbackGenerationIds)
		) {
			throw new TypeError(`D109F_PLANNER_DIVERGED:${step}`);
		}
		steps.push(
			Object.freeze({
				activeGenerationId: archivalPlan.activeGenerationId,
				archivalDeleteCount: archivalPlan.lineageFloor.deleteGenerationIds.length,
				closedEpoch: step,
				compactedDeleteCount: compactedPlan.lineageFloor.deleteGenerationIds.length,
				floorGenerationId: archivalPlan.lineageFloor.generationId,
				rollbackGenerationIds: Object.freeze([...archivalPlan.rollbackGenerationIds]),
			})
		);
		compacted = compact(compacted, compactedPlan);
		assertNoDanglingParent(compacted);
	}
	const active = steps.at(-1);
	if (active === undefined) throw new TypeError("D109F_DIFFERENTIAL_EMPTY");
	return Object.freeze({
		archivalGenerationCount: archival.length,
		compactedGenerationCount: compacted.length,
		steps: Object.freeze(steps),
	});
}

/**
 * Reads a public error code without depending on error identity.
 * @param error - Unknown thrown value.
 * @returns The public code when present.
 */
export function d109fErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && typeof Reflect.get(error, "code") === "string"
		? String(Reflect.get(error, "code"))
		: undefined;
}

/**
 * Checks recursive immutability without revisiting cycles.
 * @param value - Candidate object graph.
 * @param seen - Already visited objects.
 * @returns Whether every reachable object is frozen.
 */
export function d109fDeepFrozen(value: unknown, seen = new Set<object>()): boolean {
	if (value === null || typeof value !== "object" || seen.has(value)) return true;
	seen.add(value);
	return Object.isFrozen(value) && Object.values(value).every((entry) => d109fDeepFrozen(entry, seen));
}
