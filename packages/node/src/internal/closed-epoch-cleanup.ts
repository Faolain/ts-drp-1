import {
	digestClosure,
	type ExpectedHead,
	type GenerationId,
	type GenerationRecord,
	type GenerationRef,
	parseBlobDigest,
	parseClosureDigest,
	parseGenerationId,
	parseHeadRevision,
	parseStorageObjectId,
	type PresentHead,
	type StorageObjectId,
} from "@ts-drp/storage";

const LOCAL_ONLY_POLICY_DIGEST = "53775c5c1ee01e346f588966d6e7acb876df2bd8b2abcbe2b2591f216f7d4d9b";
const HEX_DIGEST = /^[0-9a-f]{64}$/u;

export const CLOSED_EPOCH_CLEANUP_REFUSALS = Object.freeze([
	"D109A_QC_INVALID",
	"D109A_ADOPTION_INVALID",
	"D109A_HEAD_MISMATCH",
	"D109A_REVISION_STALE",
	"D109A_IDENTITY_INVALID",
	"D109A_LINEAGE_INVALID",
	"D109A_ROLLBACK_INSUFFICIENT",
	"D109A_SNAPSHOT_MISSING",
	"D109A_POLICY_UNSUPPORTED",
	"D109A_OUTBOX_INCOMPLETE",
] as const);

export type ClosedEpochCleanupRefusal = (typeof CLOSED_EPOCH_CLEANUP_REFUSALS)[number];

export type ClosedEpochCleanupPlan = Readonly<{
	readonly activeGenerationId: GenerationId;
	readonly availabilityPolicyDigest: string;
	readonly closedEpoch: number;
	readonly expectedHead: PresentHead;
	readonly issuance: Readonly<{
		readonly scope: Readonly<{ readonly author: string; readonly objectId: StorageObjectId }>;
		readonly throughAuthorSequence: number;
	}>;
	readonly lineageFloor: Readonly<{
		readonly deleteGenerationIds: readonly GenerationId[];
		readonly expectedBaseExpectedHead: ExpectedHead;
		readonly generationId: GenerationId;
		readonly replacementBaseExpectedHead: Readonly<{
			readonly kind: "none";
			readonly objectId: StorageObjectId;
		}>;
	}>;
	readonly objectId: StorageObjectId;
	readonly rollbackGenerationIds: readonly [GenerationId, GenerationId];
}>;

export type ClosedEpochCleanupPlanningResult =
	| Readonly<{ readonly ok: false; readonly reason: ClosedEpochCleanupRefusal }>
	| Readonly<{ readonly ok: true; readonly plan: ClosedEpochCleanupPlan }>;

type CapturedInput = Readonly<{
	readonly adoption: Readonly<Record<string, unknown>>;
	readonly availabilityPolicyDigest: unknown;
	readonly close: Readonly<Record<string, unknown>>;
	readonly expectedHead: unknown;
	readonly generations: readonly unknown[];
	readonly issuance: Readonly<Record<string, unknown>>;
	readonly snapshot: Readonly<Record<string, unknown>>;
}>;

type CopiedGeneration = Readonly<{
	readonly baseExpectedHead: ExpectedHead;
	readonly closure: readonly GenerationRef[];
	readonly closureDigest: GenerationRecord["closureDigest"];
	readonly generationId: GenerationId;
	readonly objectId: StorageObjectId;
	readonly state: GenerationRecord["state"];
}>;

function refused(reason: ClosedEpochCleanupRefusal): ClosedEpochCleanupPlanningResult {
	return Object.freeze({ ok: false as const, reason });
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function captureInput(value: unknown): CapturedInput | undefined {
	if (
		!record(value) ||
		!exactKeys(value, [
			"adoption",
			"availabilityPolicyDigest",
			"close",
			"expectedHead",
			"generations",
			"issuance",
			"snapshot",
		]) ||
		!record(value.adoption) ||
		!record(value.close) ||
		!record(value.issuance) ||
		!record(value.snapshot) ||
		!Array.isArray(value.generations)
	) {
		return undefined;
	}
	return Object.freeze({
		adoption: value.adoption,
		availabilityPolicyDigest: value.availabilityPolicyDigest,
		close: value.close,
		expectedHead: value.expectedHead,
		generations: value.generations,
		issuance: value.issuance,
		snapshot: value.snapshot,
	});
}

function copiedObjectId(value: unknown): StorageObjectId | undefined {
	return typeof value === "string" && parseStorageObjectId(value).ok ? (value as StorageObjectId) : undefined;
}

function copiedGenerationId(value: unknown): GenerationId | undefined {
	return typeof value === "string" && parseGenerationId(value).ok ? (value as GenerationId) : undefined;
}

function copiedRef(value: unknown): GenerationRef | undefined {
	if (
		!record(value) ||
		!exactKeys(value, ["byteLength", "digest"]) ||
		!Number.isSafeInteger(value.byteLength) ||
		Number(value.byteLength) < 1 ||
		typeof value.digest !== "string" ||
		!parseBlobDigest(value.digest).ok
	) {
		return undefined;
	}
	return Object.freeze({ byteLength: Number(value.byteLength), digest: value.digest as GenerationRef["digest"] });
}

function copiedExpectedHead(value: unknown, objectId: StorageObjectId): ExpectedHead | undefined {
	if (!record(value)) return undefined;
	if (exactKeys(value, ["kind", "objectId"]) && value.kind === "none" && copiedObjectId(value.objectId) === objectId) {
		return Object.freeze({ kind: "none" as const, objectId });
	}
	if (
		!exactKeys(value, ["closureDigest", "generationId", "kind", "objectId", "revision"]) ||
		value.kind !== "present" ||
		copiedObjectId(value.objectId) !== objectId ||
		copiedGenerationId(value.generationId) === undefined ||
		!Number.isSafeInteger(value.revision) ||
		typeof value.closureDigest !== "string" ||
		!parseClosureDigest(value.closureDigest).ok
	) {
		return undefined;
	}
	const revision = parseHeadRevision(Number(value.revision));
	if (!revision.ok) return undefined;
	return Object.freeze({
		closureDigest: value.closureDigest as PresentHead["closureDigest"],
		generationId: value.generationId as GenerationId,
		kind: "present" as const,
		objectId,
		revision: revision.value,
	});
}

function copiedGeneration(value: unknown, objectId: StorageObjectId): CopiedGeneration | undefined {
	if (
		!record(value) ||
		!exactKeys(value, ["baseExpectedHead", "closure", "closureDigest", "generationId", "objectId", "state"]) ||
		copiedObjectId(value.objectId) !== objectId ||
		copiedGenerationId(value.generationId) === undefined ||
		typeof value.closureDigest !== "string" ||
		!parseClosureDigest(value.closureDigest).ok ||
		!Array.isArray(value.closure) ||
		!(["Staged", "Complete", "Adopted", "Superseded", "Discarded"] as const).includes(
			value.state as GenerationRecord["state"]
		)
	) {
		return undefined;
	}
	const baseExpectedHead = copiedExpectedHead(value.baseExpectedHead, objectId);
	if (baseExpectedHead === undefined) return undefined;
	const closure: GenerationRef[] = [];
	for (const candidate of value.closure) {
		const ref = copiedRef(candidate);
		if (ref === undefined) return undefined;
		closure.push(ref);
	}
	return Object.freeze({
		baseExpectedHead,
		closure: Object.freeze(closure),
		closureDigest: value.closureDigest as GenerationRecord["closureDigest"],
		generationId: value.generationId as GenerationId,
		objectId,
		state: value.state as GenerationRecord["state"],
	});
}

function sameHeadExceptRevision(left: PresentHead, right: PresentHead): boolean {
	return (
		left.closureDigest === right.closureDigest &&
		left.generationId === right.generationId &&
		left.objectId === right.objectId
	);
}

function validClosure(generation: CopiedGeneration): boolean {
	if (generation.closure.length === 0) return false;
	const digests = generation.closure.map(({ digest }) => digest);
	if (new Set(digests).size !== digests.length) return false;
	const sorted = [...digests].sort();
	if (!digests.every((digest, index) => digest === sorted[index])) return false;
	const digest = digestClosure(generation.closure);
	return digest.ok && digest.value === generation.closureDigest;
}

function parentMatches(child: CopiedGeneration, parent: CopiedGeneration, expectedChildRevision: number): boolean {
	return (
		child.baseExpectedHead.kind === "present" &&
		child.baseExpectedHead.objectId === parent.objectId &&
		child.baseExpectedHead.generationId === parent.generationId &&
		child.baseExpectedHead.closureDigest === parent.closureDigest &&
		child.baseExpectedHead.revision === expectedChildRevision - 1
	);
}

function copiedGenerations(
	values: readonly unknown[],
	objectId: StorageObjectId
):
	| Readonly<{ readonly byId: ReadonlyMap<GenerationId, CopiedGeneration>; readonly rows: readonly CopiedGeneration[] }>
	| undefined {
	const rows: CopiedGeneration[] = [];
	const byId = new Map<GenerationId, CopiedGeneration>();
	for (const value of values) {
		const generation = copiedGeneration(value, objectId);
		if (generation === undefined || byId.has(generation.generationId)) return undefined;
		rows.push(generation);
		byId.set(generation.generationId, generation);
	}
	return Object.freeze({ byId, rows: Object.freeze(rows) });
}

function lineagePlan(
	generations: Readonly<{
		readonly byId: ReadonlyMap<GenerationId, CopiedGeneration>;
		readonly rows: readonly CopiedGeneration[];
	}>,
	activeHead: PresentHead
):
	| Readonly<{ readonly kind: "invalid" }>
	| Readonly<{ readonly kind: "insufficient" }>
	| Readonly<{
			readonly kind: "plan";
			readonly deleteGenerationIds: readonly GenerationId[];
			readonly floor: CopiedGeneration;
			readonly rollbackGenerationIds: readonly [GenerationId, GenerationId];
	  }> {
	const active = generations.byId.get(activeHead.generationId);
	if (
		active === undefined ||
		active.state !== "Adopted" ||
		active.closureDigest !== activeHead.closureDigest ||
		!validClosure(active)
	) {
		return Object.freeze({ kind: "invalid" as const });
	}
	if (active.baseExpectedHead.kind !== "present") return Object.freeze({ kind: "insufficient" as const });
	const first = generations.byId.get(active.baseExpectedHead.generationId);
	if (first === undefined) return Object.freeze({ kind: "insufficient" as const });
	if (first.baseExpectedHead.kind !== "present") return Object.freeze({ kind: "insufficient" as const });
	const second = generations.byId.get(first.baseExpectedHead.generationId);
	if (second === undefined) return Object.freeze({ kind: "insufficient" as const });
	if (
		new Set([active.generationId, first.generationId, second.generationId]).size !== 3 ||
		first.state !== "Superseded" ||
		second.state !== "Superseded" ||
		!validClosure(first) ||
		!validClosure(second) ||
		!parentMatches(active, first, activeHead.revision) ||
		!parentMatches(first, second, active.baseExpectedHead.revision)
	) {
		return Object.freeze({ kind: "invalid" as const });
	}

	const retained = new Set([active.generationId, first.generationId, second.generationId]);
	const prefix: CopiedGeneration[] = [];
	const visited = new Set<GenerationId>();
	let expectedRevision = first.baseExpectedHead.revision;
	let cursor = second.baseExpectedHead;
	while (cursor.kind === "present") {
		if (visited.has(cursor.generationId)) return Object.freeze({ kind: "invalid" as const });
		const generation = generations.byId.get(cursor.generationId);
		if (
			generation === undefined ||
			generation.state !== "Superseded" ||
			!validClosure(generation) ||
			cursor.revision !== expectedRevision - 1 ||
			cursor.closureDigest !== generation.closureDigest
		) {
			return Object.freeze({ kind: "invalid" as const });
		}
		visited.add(generation.generationId);
		prefix.push(generation);
		expectedRevision = cursor.revision;
		cursor = generation.baseExpectedHead;
	}
	if (cursor.objectId !== activeHead.objectId) return Object.freeze({ kind: "invalid" as const });

	const outsideRetained = generations.rows.filter(({ generationId }) => !retained.has(generationId));
	if (
		outsideRetained.length !== prefix.length ||
		outsideRetained.some(({ generationId }) => !visited.has(generationId)) ||
		generations.rows.some(
			(generation) =>
				retained.has(generation.generationId) &&
				generation.generationId !== second.generationId &&
				generation.baseExpectedHead.kind === "present" &&
				visited.has(generation.baseExpectedHead.generationId)
		)
	) {
		return Object.freeze({ kind: "invalid" as const });
	}

	return Object.freeze({
		deleteGenerationIds: Object.freeze(prefix.map(({ generationId }) => generationId).sort()),
		floor: second,
		kind: "plan" as const,
		rollbackGenerationIds: Object.freeze([first.generationId, second.generationId] as const),
	});
}

function validSnapshot(value: Readonly<Record<string, unknown>>): boolean {
	return (
		exactKeys(value, ["adopted", "manifestDigest"]) &&
		value.adopted === true &&
		typeof value.manifestDigest === "string" &&
		HEX_DIGEST.test(value.manifestDigest)
	);
}

function copiedIssuance(
	value: Readonly<Record<string, unknown>>,
	objectId: StorageObjectId,
	closedEpoch: number
): ClosedEpochCleanupPlan["issuance"] | undefined {
	if (
		!exactKeys(value, ["complete", "rows", "scope", "throughAuthorSequence"]) ||
		value.complete !== true ||
		!record(value.scope) ||
		!exactKeys(value.scope, ["author", "objectId"]) ||
		copiedObjectId(value.scope.objectId) !== objectId ||
		typeof value.scope.author !== "string" ||
		!HEX_DIGEST.test(value.scope.author) ||
		!Number.isSafeInteger(value.throughAuthorSequence) ||
		Number(value.throughAuthorSequence) < 0 ||
		!Array.isArray(value.rows)
	) {
		return undefined;
	}
	const throughAuthorSequence = Number(value.throughAuthorSequence);
	if (value.rows.length !== throughAuthorSequence + 1) return undefined;
	const seen = new Set<number>();
	for (const candidate of value.rows) {
		if (
			!record(candidate) ||
			!exactKeys(candidate, ["authorSequence", "epoch", "issued", "outbox", "publishState"]) ||
			!Number.isSafeInteger(candidate.authorSequence) ||
			Number(candidate.authorSequence) < 0 ||
			Number(candidate.authorSequence) > throughAuthorSequence ||
			!Number.isSafeInteger(candidate.epoch) ||
			Number(candidate.epoch) !== closedEpoch ||
			candidate.issued !== true ||
			candidate.outbox !== true ||
			candidate.publishState !== "published" ||
			seen.has(Number(candidate.authorSequence))
		) {
			return undefined;
		}
		seen.add(Number(candidate.authorSequence));
	}
	for (let sequence = 0; sequence <= throughAuthorSequence; sequence += 1) {
		if (!seen.has(sequence)) return undefined;
	}
	return Object.freeze({
		scope: Object.freeze({ author: value.scope.author, objectId }),
		throughAuthorSequence,
	});
}

/**
 * Plans one closed-epoch cleanup without opening a store, mutating state, or scheduling work.
 * @param input - Detached facts already authenticated by the owning Phase-5/6a components.
 * @returns One deep-frozen plan or the first exact refusal in the closed precedence.
 */
export function planClosedEpochCleanup(input: unknown): ClosedEpochCleanupPlanningResult {
	try {
		const captured = captureInput(input);
		if (captured === undefined) return refused("D109A_IDENTITY_INVALID");

		if (
			!exactKeys(captured.close, ["closedEpoch", "commitQcRef", "objectId", "verified"]) ||
			captured.close.verified !== true ||
			!Number.isSafeInteger(captured.close.closedEpoch) ||
			Number(captured.close.closedEpoch) < 0 ||
			copiedRef(captured.close.commitQcRef) === undefined
		) {
			return refused("D109A_QC_INVALID");
		}
		const objectId = copiedObjectId(captured.close.objectId);
		if (objectId === undefined) return refused("D109A_IDENTITY_INVALID");
		const closedEpoch = Number(captured.close.closedEpoch);

		if (!exactKeys(captured.adoption, ["activeHead", "adopted"]) || captured.adoption.adopted !== true) {
			return refused("D109A_ADOPTION_INVALID");
		}
		const activeHead = copiedExpectedHead(captured.adoption.activeHead, objectId);
		if (activeHead?.kind !== "present") return refused("D109A_ADOPTION_INVALID");
		const expectedHead = copiedExpectedHead(captured.expectedHead, objectId);
		if (expectedHead?.kind !== "present") return refused("D109A_HEAD_MISMATCH");
		if (!sameHeadExceptRevision(activeHead, expectedHead)) return refused("D109A_HEAD_MISMATCH");
		if (activeHead.revision !== expectedHead.revision) return refused("D109A_REVISION_STALE");

		const generations = copiedGenerations(captured.generations, objectId);
		if (generations === undefined) return refused("D109A_IDENTITY_INVALID");
		const active = generations.byId.get(activeHead.generationId);
		if (active === undefined || active.state !== "Adopted" || active.closureDigest !== activeHead.closureDigest) {
			return refused("D109A_HEAD_MISMATCH");
		}
		const lineage = lineagePlan(generations, activeHead);
		if (lineage.kind === "insufficient") return refused("D109A_ROLLBACK_INSUFFICIENT");
		if (lineage.kind === "invalid") return refused("D109A_LINEAGE_INVALID");

		if (!validSnapshot(captured.snapshot)) return refused("D109A_SNAPSHOT_MISSING");
		if (captured.availabilityPolicyDigest !== LOCAL_ONLY_POLICY_DIGEST) {
			return refused("D109A_POLICY_UNSUPPORTED");
		}
		const issuance = copiedIssuance(captured.issuance, objectId, closedEpoch);
		if (issuance === undefined) return refused("D109A_OUTBOX_INCOMPLETE");

		return Object.freeze({
			ok: true as const,
			plan: Object.freeze({
				activeGenerationId: active.generationId,
				availabilityPolicyDigest: LOCAL_ONLY_POLICY_DIGEST,
				closedEpoch,
				expectedHead: Object.freeze({ ...expectedHead }),
				issuance,
				lineageFloor: Object.freeze({
					deleteGenerationIds: lineage.deleteGenerationIds,
					expectedBaseExpectedHead: Object.freeze({ ...lineage.floor.baseExpectedHead }),
					generationId: lineage.floor.generationId,
					replacementBaseExpectedHead: Object.freeze({ kind: "none" as const, objectId }),
				}),
				objectId,
				rollbackGenerationIds: lineage.rollbackGenerationIds,
			}),
		});
	} catch {
		return refused("D109A_IDENTITY_INVALID");
	}
}
