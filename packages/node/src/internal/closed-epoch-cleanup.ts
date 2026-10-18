import { compareBytes, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import {
	type AheGenerationPartition,
	type AheRetirementControl,
	type AheRetirementControlRead,
	type AheRetirementDomain,
	type AheRetirementPreparation,
	captureAheRetirementControl,
	captureAheRetirementPreparation,
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
		readonly lineage: Readonly<{ readonly exhausted: boolean; readonly next: number }>;
		readonly prunedThroughAuthorSequence: number | null;
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
	readonly sourceGenerationIds?: readonly GenerationId[];
	readonly independentSourceGenerations?: readonly GenerationRecord[];
	readonly classifiedSourceGenerations?: readonly GenerationRecord[];
}>;

export type ClosedEpochCleanupPlanningResult =
	| Readonly<{ readonly ok: false; readonly reason: ClosedEpochCleanupRefusal }>
	| Readonly<{ readonly ok: true; readonly plan: ClosedEpochCleanupPlan }>;

type SettlementCleanupFrontier = Readonly<{ admissionEpoch: number; terminalThrough: number | null }>;
type SettlementCleanupPlanningResult =
	| Readonly<{ readonly ok: false; readonly reason: ClosedEpochCleanupRefusal }>
	| Readonly<{
			readonly ok: true;
			readonly plan: Omit<ClosedEpochCleanupPlan, "issuance"> & {
				readonly issuance: ClosedEpochCleanupPlan["issuance"] | null;
			};
	  }>;

type CapturedInput = Readonly<{
	readonly adoption: Readonly<Record<string, unknown>>;
	readonly availabilityPolicyDigest: unknown;
	readonly close: Readonly<Record<string, unknown>>;
	readonly expectedHead: unknown;
	readonly generations: readonly unknown[];
	readonly issuance: Readonly<Record<string, unknown>>;
	readonly snapshot: Readonly<Record<string, unknown>>;
	readonly settlement?: SettlementCleanupFrontier;
	readonly retainedSourceRefs?: readonly GenerationRef[];
	readonly retainedIndependentSourceGenerations?: readonly GenerationRecord[];
	readonly classifiedSourceGenerations?: readonly GenerationRecord[];
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
			...(value.settlement === undefined ? [] : ["settlement"]),
			...(value.retainedSourceRefs === undefined ? [] : ["retainedSourceRefs"]),
			...(value.retainedIndependentSourceGenerations === undefined ? [] : ["retainedIndependentSourceGenerations"]),
			...(value.classifiedSourceGenerations === undefined ? [] : ["classifiedSourceGenerations"]),
		]) ||
		!record(value.adoption) ||
		!record(value.close) ||
		!record(value.issuance) ||
		!record(value.snapshot) ||
		!Array.isArray(value.generations)
	) {
		return undefined;
	}
	if (
		value.settlement !== undefined &&
		(!record(value.settlement) ||
			!exactKeys(value.settlement, ["admissionEpoch", "terminalThrough"]) ||
			!Number.isSafeInteger(value.settlement.admissionEpoch) ||
			Number(value.settlement.admissionEpoch) < 0 ||
			(value.settlement.terminalThrough !== null &&
				(!Number.isSafeInteger(value.settlement.terminalThrough) || Number(value.settlement.terminalThrough) < 0)))
	)
		return undefined;
	const retainedSourceRefs: GenerationRef[] = [];
	let independent: readonly GenerationRecord[] | undefined;
	let classified: readonly GenerationRecord[] | undefined;
	if (value.retainedIndependentSourceGenerations !== undefined) {
		if (
			!Array.isArray(value.retainedIndependentSourceGenerations) ||
			value.retainedIndependentSourceGenerations.length > 4
		)
			return undefined;
		const objectId = copiedObjectId(value.close.objectId);
		if (objectId === undefined) return undefined;
		const rows = copiedGenerations(value.retainedIndependentSourceGenerations, objectId);
		if (
			rows === undefined ||
			rows.rows.some((row) => row.state !== "Superseded" || row.closure.length > 7 || !validClosure(row))
		)
			return undefined;
		independent = rows.rows;
		if (!Array.isArray(value.classifiedSourceGenerations) || value.classifiedSourceGenerations.length > 4)
			return undefined;
		const classifiedRows = copiedGenerations(value.classifiedSourceGenerations, objectId);
		if (
			classifiedRows === undefined ||
			classifiedRows.rows.some((row) => row.state !== "Superseded" || row.closure.length > 7 || !validClosure(row))
		)
			return undefined;
		classified = classifiedRows.rows;
	} else if (value.classifiedSourceGenerations !== undefined) return undefined;
	if (value.retainedSourceRefs !== undefined) {
		if (
			!Array.isArray(value.retainedSourceRefs) ||
			value.retainedSourceRefs.length === 0 ||
			value.retainedSourceRefs.length > 8
		)
			return undefined;
		for (const raw of value.retainedSourceRefs) {
			const ref = copiedRef(raw);
			if (ref === undefined) return undefined;
			retainedSourceRefs.push(ref);
		}
		if (new Set(retainedSourceRefs.map((ref) => ref.digest)).size !== retainedSourceRefs.length) return undefined;
	}
	return Object.freeze({
		adoption: value.adoption,
		availabilityPolicyDigest: value.availabilityPolicyDigest,
		close: value.close,
		expectedHead: value.expectedHead,
		generations: value.generations,
		issuance: value.issuance,
		snapshot: value.snapshot,
		...(value.settlement === undefined ? {} : { settlement: value.settlement as SettlementCleanupFrontier }),
		...(retainedSourceRefs.length === 0 ? {} : { retainedSourceRefs: Object.freeze(retainedSourceRefs) }),
		...(independent === undefined ? {} : { retainedIndependentSourceGenerations: independent }),
		...(classified === undefined ? {} : { classifiedSourceGenerations: classified }),
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
	activeHead: PresentHead,
	retainedSourceRefs: readonly GenerationRef[] = [],
	independentSources?: readonly GenerationRecord[],
	classifiedSources?: readonly GenerationRecord[]
):
	| Readonly<{ readonly kind: "invalid" }>
	| Readonly<{ readonly kind: "insufficient" }>
	| Readonly<{
			readonly kind: "plan";
			readonly deleteGenerationIds: readonly GenerationId[];
			readonly floor: CopiedGeneration;
			readonly rollbackGenerationIds: readonly [GenerationId, GenerationId];
			readonly sourceGenerationIds: readonly GenerationId[];
			readonly independentSourceGenerations?: readonly GenerationRecord[];
	  }> {
	// One shared digest denotes one native blob across every role's closure.
	const sharedLengths = new Map<string, number>();
	for (const row of generations.rows)
		for (const ref of row.closure) {
			const existing = sharedLengths.get(ref.digest);
			if (existing !== undefined && existing !== ref.byteLength) return Object.freeze({ kind: "invalid" as const });
			sharedLengths.set(ref.digest, ref.byteLength);
		}
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
	if (independentSources !== undefined) {
		if (retainedSourceRefs.length !== 0) return Object.freeze({ kind: "invalid" as const });
		const ownedSources = new Map(independentSources.map((source) => [source.generationId, source]));
		if (ownedSources.size !== independentSources.length || independentSources.length > 4)
			return Object.freeze({ kind: "invalid" as const });
		for (const source of independentSources) {
			const actual = generations.byId.get(source.generationId);
			if (
				actual === undefined ||
				retained.has(source.generationId) ||
				JSON.stringify(actual) !== JSON.stringify(source)
			)
				return Object.freeze({ kind: "invalid" as const });
		}
		// Preserve genuinely authenticated source companions in their original
		// adjacent native lineage. Only a detached remainder uses independent edge
		// normalization; keeping its payload must not erase required source edges.
		let sourceFloor = second;
		let sourceFloorRevision = first.baseExpectedHead.revision;
		const sourceGenerationIds: GenerationId[] = [];
		while (
			sourceFloor.baseExpectedHead.kind === "present" &&
			ownedSources.has(sourceFloor.baseExpectedHead.generationId)
		) {
			const next = generations.byId.get(sourceFloor.baseExpectedHead.generationId);
			if (
				next === undefined ||
				next.state !== "Superseded" ||
				!validClosure(next) ||
				!parentMatches(sourceFloor, next, sourceFloorRevision) ||
				retained.has(next.generationId) ||
				sourceGenerationIds.length === 4
			)
				return Object.freeze({ kind: "invalid" as const });
			sourceFloorRevision = sourceFloor.baseExpectedHead.revision;
			sourceFloor = next;
			retained.add(next.generationId);
			sourceGenerationIds.push(next.generationId);
		}
		const detached = independentSources.filter((source) => !retained.has(source.generationId));
		for (const source of detached) retained.add(source.generationId);
		// The authenticated caller categorizes detached source debt. Superseded
		// alone is not that premise. Match the backend's connected-or-classified
		// admission here, before eligibility; its exact native recheck stays intact.
		if (classifiedSources === undefined) return Object.freeze({ kind: "invalid" as const });
		const categorized = new Set(retained);
		for (const expected of classifiedSources) {
			const actual = generations.byId.get(expected.generationId);
			if (
				actual === undefined ||
				retained.has(expected.generationId) ||
				JSON.stringify(actual) !== JSON.stringify(expected)
			)
				return Object.freeze({ kind: "invalid" as const });
			categorized.add(expected.generationId);
		}
		let cursor = sourceFloor.baseExpectedHead;
		let revision = sourceFloorRevision;
		const visited = new Set<GenerationId>();
		while (cursor.kind === "present") {
			const row = generations.byId.get(cursor.generationId);
			if (
				row === undefined ||
				visited.has(row.generationId) ||
				row.state !== "Superseded" ||
				!validClosure(row) ||
				cursor.objectId !== activeHead.objectId ||
				cursor.closureDigest !== row.closureDigest ||
				cursor.revision !== revision - 1
			)
				return Object.freeze({ kind: "invalid" as const });
			visited.add(row.generationId);
			categorized.add(row.generationId);
			revision = cursor.revision;
			cursor = row.baseExpectedHead;
		}
		if (cursor.objectId !== activeHead.objectId || generations.rows.some((row) => !categorized.has(row.generationId)))
			return Object.freeze({ kind: "invalid" as const });
		const obsolete = generations.rows.filter(({ generationId }) => !retained.has(generationId));
		if (obsolete.some((row) => row.state !== "Superseded" || !validClosure(row)))
			return Object.freeze({ kind: "invalid" as const });
		return Object.freeze({
			kind: "plan" as const,
			deleteGenerationIds: Object.freeze(obsolete.map(({ generationId }) => generationId).sort()),
			floor: sourceFloor,
			rollbackGenerationIds: Object.freeze([first.generationId, second.generationId] as const),
			sourceGenerationIds: Object.freeze(sourceGenerationIds),
			independentSourceGenerations: Object.freeze(detached),
		});
	}
	let floor = second;
	let floorRevision = first.baseExpectedHead.revision;
	const sourceGenerationIds: GenerationId[] = [];
	const sourcesRetained = (): boolean =>
		retainedSourceRefs.every((ref) =>
			[...retained].some((id) =>
				generations.byId
					.get(id)
					?.closure.some((candidate) => candidate.digest === ref.digest && candidate.byteLength === ref.byteLength)
			)
		);
	while (!sourcesRetained()) {
		if (sourceGenerationIds.length === 4 || floor.baseExpectedHead.kind !== "present")
			return Object.freeze({ kind: "invalid" as const });
		const next = generations.byId.get(floor.baseExpectedHead.generationId);
		if (
			next === undefined ||
			next.state !== "Superseded" ||
			!validClosure(next) ||
			!parentMatches(floor, next, floorRevision) ||
			retained.has(next.generationId)
		)
			return Object.freeze({ kind: "invalid" as const });
		floorRevision = floor.baseExpectedHead.revision;
		floor = next;
		retained.add(next.generationId);
		sourceGenerationIds.push(next.generationId);
	}
	const prefix: CopiedGeneration[] = [];
	const visited = new Set<GenerationId>();
	let expectedRevision = floorRevision;
	let cursor = floor.baseExpectedHead;
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
				generation.generationId !== floor.generationId &&
				generation.baseExpectedHead.kind === "present" &&
				visited.has(generation.baseExpectedHead.generationId)
		)
	) {
		return Object.freeze({ kind: "invalid" as const });
	}

	return Object.freeze({
		deleteGenerationIds: Object.freeze(prefix.map(({ generationId }) => generationId).sort()),
		floor,
		kind: "plan" as const,
		rollbackGenerationIds: Object.freeze([first.generationId, second.generationId] as const),
		sourceGenerationIds: Object.freeze(sourceGenerationIds),
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
	closedEpoch: number,
	settlement?: SettlementCleanupFrontier
): ClosedEpochCleanupPlan["issuance"] | null | undefined {
	if (
		!exactKeys(value, [
			"complete",
			"lineage",
			"prunedThroughAuthorSequence",
			"rows",
			"scope",
			"throughAuthorSequence",
		]) ||
		value.complete !== true ||
		!record(value.lineage) ||
		!exactKeys(value.lineage, ["exhausted", "next"]) ||
		typeof value.lineage.exhausted !== "boolean" ||
		!Number.isSafeInteger(value.lineage.next) ||
		Number(value.lineage.next) < 0 ||
		(value.lineage.exhausted === true && Number(value.lineage.next) !== Number.MAX_SAFE_INTEGER) ||
		(value.prunedThroughAuthorSequence !== null &&
			(!Number.isSafeInteger(value.prunedThroughAuthorSequence) || Number(value.prunedThroughAuthorSequence) < 0)) ||
		!record(value.scope) ||
		!exactKeys(value.scope, ["author", "objectId"]) ||
		copiedObjectId(value.scope.objectId) !== objectId ||
		typeof value.scope.author !== "string" ||
		!HEX_DIGEST.test(value.scope.author) ||
		(!(settlement !== undefined && value.throughAuthorSequence === null) &&
			(!Number.isSafeInteger(value.throughAuthorSequence) || Number(value.throughAuthorSequence) < 0)) ||
		!Array.isArray(value.rows)
	) {
		return undefined;
	}
	const throughAuthorSequence = Number(value.throughAuthorSequence);
	const lineage = Object.freeze({ exhausted: value.lineage.exhausted, next: Number(value.lineage.next) });
	const prunedThroughAuthorSequence =
		value.prunedThroughAuthorSequence === null ? null : Number(value.prunedThroughAuthorSequence);
	if (settlement !== undefined && value.throughAuthorSequence === null) {
		return value.rows.length === 0 &&
			(prunedThroughAuthorSequence === null ||
				lineage.next > prunedThroughAuthorSequence ||
				(lineage.exhausted && lineage.next === prunedThroughAuthorSequence))
			? null
			: undefined;
	}
	const consumed =
		lineage.next > throughAuthorSequence || (lineage.exhausted && lineage.next === throughAuthorSequence);
	if (
		!consumed ||
		(prunedThroughAuthorSequence !== null &&
			(prunedThroughAuthorSequence > throughAuthorSequence ||
				!(
					lineage.next > prunedThroughAuthorSequence ||
					(lineage.exhausted && lineage.next === prunedThroughAuthorSequence)
				)))
	) {
		return undefined;
	}
	const first = prunedThroughAuthorSequence === null ? 0 : prunedThroughAuthorSequence + 1;
	const expectedRows = throughAuthorSequence - first + 1;
	if (value.rows.length !== Math.max(0, expectedRows)) return undefined;
	const seen = new Set<number>();
	for (const candidate of value.rows) {
		if (
			!record(candidate) ||
			!exactKeys(candidate, ["authorSequence", "epoch", "issued", "outbox", "publishState"]) ||
			!Number.isSafeInteger(candidate.authorSequence) ||
			Number(candidate.authorSequence) < first ||
			Number(candidate.authorSequence) > throughAuthorSequence ||
			!Number.isSafeInteger(candidate.epoch) ||
			(settlement === undefined
				? Number(candidate.epoch) !== closedEpoch
				: Number(candidate.epoch) < 0 ||
					Number(candidate.epoch) > closedEpoch - 2 ||
					!(
						Number(candidate.epoch) < settlement.admissionEpoch ||
						(settlement.terminalThrough !== null && Number(candidate.authorSequence) <= settlement.terminalThrough)
					)) ||
			candidate.issued !== true ||
			candidate.outbox !== true ||
			(settlement === undefined
				? candidate.publishState !== "published"
				: candidate.publishState !== "published" && candidate.publishState !== "pending") ||
			seen.has(Number(candidate.authorSequence))
		) {
			return undefined;
		}
		seen.add(Number(candidate.authorSequence));
	}
	for (let sequence = first; sequence <= throughAuthorSequence; sequence += 1) {
		if (!seen.has(sequence)) return undefined;
	}
	return Object.freeze({
		lineage,
		prunedThroughAuthorSequence,
		scope: Object.freeze({ author: value.scope.author, objectId }),
		throughAuthorSequence,
	});
}

/**
 * Plans one closed-epoch cleanup without opening a store, mutating state, or scheduling work.
 * @param input - Detached facts already authenticated by the owning Phase-5/6a components.
 * @param input.settlement - Successor-authenticated incarnation and terminal boundary, for settlement only.
 * @returns One deep-frozen plan or the first exact refusal in the closed precedence.
 */
export function planClosedEpochCleanup(input: {
	readonly settlement: SettlementCleanupFrontier;
}): SettlementCleanupPlanningResult;
export function planClosedEpochCleanup(input: unknown): ClosedEpochCleanupPlanningResult;
export function planClosedEpochCleanup(input: unknown): SettlementCleanupPlanningResult {
	return planCleanup(input, false);
}

/**
 * Retains authenticated AHE roles without claiming or pruning any issuance prefix.
 * @param input - Detached authenticated role, head and retention facts.
 * @returns A bounded AHE-only plan that leaves every issuance watermark intact.
 */
export function planClosedEpochRoleCleanup(input: unknown): SettlementCleanupPlanningResult {
	return planCleanup(input, true);
}

function planCleanup(input: unknown, aheOnly: boolean): SettlementCleanupPlanningResult {
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
		const lineage = lineagePlan(
			generations,
			activeHead,
			captured.retainedSourceRefs,
			captured.retainedIndependentSourceGenerations,
			captured.classifiedSourceGenerations
		);
		if (lineage.kind === "insufficient") return refused("D109A_ROLLBACK_INSUFFICIENT");
		if (lineage.kind === "invalid") return refused("D109A_LINEAGE_INVALID");

		if (!validSnapshot(captured.snapshot)) return refused("D109A_SNAPSHOT_MISSING");
		if (captured.availabilityPolicyDigest !== LOCAL_ONLY_POLICY_DIGEST) {
			return refused("D109A_POLICY_UNSUPPORTED");
		}
		if (captured.settlement !== undefined && captured.settlement.admissionEpoch > closedEpoch + 1)
			return refused("D109A_OUTBOX_INCOMPLETE");
		const issuance = aheOnly ? null : copiedIssuance(captured.issuance, objectId, closedEpoch, captured.settlement);
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
				...(lineage.sourceGenerationIds.length === 0 ? {} : { sourceGenerationIds: lineage.sourceGenerationIds }),
				...(lineage.independentSourceGenerations === undefined
					? {}
					: { independentSourceGenerations: lineage.independentSourceGenerations }),
				...(captured.classifiedSourceGenerations === undefined
					? {}
					: { classifiedSourceGenerations: captured.classifiedSourceGenerations }),
			}),
		});
	} catch {
		return refused("D109A_IDENTITY_INVALID");
	}
}

/**
 * Internal native participant composition. The original authenticated cleanup
 * owner supplies these closures after capturing its complete proof. A view's
 * phase must be derived from exact native control bytes, including the bound
 * decision/source proof and revision/incarnation, not a caller eligibility flag.
 *
 * The eight original roles are AHE records, AHE referenced bytes, snapshot,
 * journal, issuance, host floor, primary votes and evidence. Two signing roles
 * may share one participant only when the original native owner proves the
 * same physical image/control. No role may be invented to complete mask 255.
 */
export interface ClosedEpochRetirementParticipant {
	readonly commitment: AheRetirementDomain;
	acquire(coordinator: AheRetirementControl): Promise<ClosedEpochRetirementParticipantRead>;
}

export interface ClosedEpochRetirementParticipantRead {
	/** Exact original bound domain tuple, derived from current native readback. */
	readonly commitment: AheRetirementDomain;
	/** Validated exact old/prepared/completed control, not a delivered ACK. */
	readonly phase: "old" | "prepared" | "completed";
	prepareFence(): Promise<void>;
	commitPrepared(): Promise<void>;
	release(): Promise<void>;
}

/** The common native metadata shape of the original snapshot, journal and
 * issuance participants, and the signing participant's defined metadata
 * projection. Signing's native sourceImageDigest has a separate exact-frame
 * validation obligation in its original consumer. Never eligibility. */
export interface ClosedEpochRetirementMetadataControl {
	readonly kind: string;
	readonly objectId: string;
	readonly incarnation: string;
	readonly revision: number;
	readonly sequence: number;
	readonly active: null | Readonly<{ sequence: number; preparation: unknown }>;
	readonly completed: unknown;
}

function metadataImage(control: ClosedEpochRetirementMetadataControl, imageDigest: string): Uint8Array {
	if (!HEX_DIGEST.test(imageDigest)) retirementRefusal("malformed native data image");
	return hashDomain("ts-drp/closed-epoch-native-metadata/v1", retirementBytes({ control, imageDigest }));
}

/** Captures the exact old and planned completed images before coordinator
 * preparation. The source owner supplies the already authenticated fixed P;
 * neither this tuple nor a native control grants protocol eligibility. */
export function captureClosedEpochRetirementMetadataDomain(
	roles: 4 | 8 | 16 | 192,
	control: ClosedEpochRetirementMetadataControl,
	imageDigest: string,
	preparation: unknown,
	projectCompleted: (control: ClosedEpochRetirementMetadataControl) => ClosedEpochRetirementMetadataControl = control => control
): AheRetirementDomain {
	if (control.active !== null || control.revision > Number.MAX_SAFE_INTEGER - 2 ||
		control.sequence === Number.MAX_SAFE_INTEGER) retirementRefusal("native metadata is not preparable");
	const completed = projectCompleted({ ...control, revision: control.revision + 2, sequence: control.sequence + 1,
		active: null, completed: preparation });
	return Object.freeze([
		roles,
		hashDomain("ts-drp/closed-epoch-native-domain/v1", retirementBytes({ kind: control.kind, objectId: control.objectId })),
		hashDomain("ts-drp/closed-epoch-native-incarnation/v1", retirementBytes({ kind: control.kind,
			objectId: control.objectId, incarnation: control.incarnation })),
		control.revision, metadataImage(control, imageDigest), metadataImage(completed, imageDigest), control.sequence,
	]);
}

/** Fresh readback distinguishes exact old/prepared/completed, including the
 * entire original data image and prior completed metadata. The prepared phase
 * reconstructs only the native owner's defined metadata delta; completed is
 * checked against the durable planned hash, never against invented prior data. */
export function validateClosedEpochRetirementMetadataDomain(
	control: ClosedEpochRetirementMetadataControl,
	imageDigest: string,
	preparation: unknown,
	commitment: AheRetirementDomain,
	projectCompleted: (control: ClosedEpochRetirementMetadataControl) => ClosedEpochRetirementMetadataControl = control => control
): ClosedEpochRetirementParticipantRead["phase"] {
	const domain = hashDomain("ts-drp/closed-epoch-native-domain/v1",
		retirementBytes({ kind: control.kind, objectId: control.objectId }));
	const incarnation = hashDomain("ts-drp/closed-epoch-native-incarnation/v1",
		retirementBytes({ kind: control.kind, objectId: control.objectId, incarnation: control.incarnation }));
	if (compareBytes(domain, commitment[1]) !== 0 || compareBytes(incarnation, commitment[2]) !== 0)
		retirementRefusal("native metadata ownership changed");
	if (control.active === null && control.revision === commitment[3] && control.sequence === commitment[6] &&
		compareBytes(metadataImage(control, imageDigest), commitment[4]) === 0) return "old";
	if (control.revision === commitment[3] + 1 && control.sequence === commitment[6] + 1 &&
		control.active !== null && control.active.sequence === control.sequence &&
		retirementEqual(control.active.preparation, preparation)) {
		const old = { ...control, revision: commitment[3], sequence: commitment[6], active: null };
		const completed = projectCompleted({ ...control, revision: commitment[3] + 2, active: null, completed: preparation });
		if (compareBytes(metadataImage(old, imageDigest), commitment[4]) === 0 &&
			compareBytes(metadataImage(completed, imageDigest), commitment[5]) === 0) return "prepared";
	}
	if (control.active === null && control.revision === commitment[3] + 2 &&
		control.sequence === commitment[6] + 1 && retirementEqual(control.completed, preparation) &&
		compareBytes(metadataImage(control, imageDigest), commitment[5]) === 0) return "completed";
	return retirementRefusal("native metadata source or phase changed");
}

/** A fresh original native view, adapted only by its authenticated source
 * owner's captured receiver and fixed preparation. It is not a public port. */
export interface ClosedEpochRetirementMetadataRead {
	readonly control: ClosedEpochRetirementMetadataControl;
	readonly imageDigest: string;
	prepareFence(): Promise<void>;
	commitPrepared(): Promise<void>;
	release(): Promise<void>;
}

/** Adapts the three original same-shape participants to the existing intent
 * sequencer. It never discovers a source or constructs retirement eligibility.
 * The caller must compare the initial image with its authenticated prejoin
 * capture before invoking this function. On resume it supplies ONLY the exact
 * addressed durable domain, not a freshly authorized replacement tuple. */
export async function createClosedEpochRetirementMetadataParticipant(input: Readonly<{
	roles: 4 | 8 | 16 | 192;
	preparation: unknown;
	initial: ClosedEpochRetirementMetadataRead;
	durableCommitment?: AheRetirementDomain;
	/** Original native owner defines only its exact completed metadata delta. */
	projectCompleted?(control: ClosedEpochRetirementMetadataControl): ClosedEpochRetirementMetadataControl;
	acquire(coordinator: AheRetirementControl): Promise<ClosedEpochRetirementMetadataRead>;
}>): Promise<ClosedEpochRetirementParticipant> {
	const preparation = input.preparation;
	const acquire = input.acquire.bind(input);
	const projectCompleted = input.projectCompleted?.bind(input);
	const commitment = await releaseRetirementRead(input.initial, async () => {
		const captured = input.durableCommitment ?? captureClosedEpochRetirementMetadataDomain(
			input.roles, input.initial.control, input.initial.imageDigest, preparation, projectCompleted);
		if (captured[0] !== input.roles) retirementRefusal("native metadata role changed");
		validateClosedEpochRetirementMetadataDomain(input.initial.control, input.initial.imageDigest, preparation, captured, projectCompleted);
		return captured;
	});
	return Object.freeze({
		commitment,
		acquire: async (coordinator: AheRetirementControl): Promise<ClosedEpochRetirementParticipantRead> => {
			const read = await acquire(coordinator);
			try {
				const phase = validateClosedEpochRetirementMetadataDomain(read.control, read.imageDigest, preparation, commitment, projectCompleted);
				return Object.freeze({ commitment, phase, prepareFence: read.prepareFence.bind(read),
					commitPrepared: read.commitPrepared.bind(read), release: read.release.bind(read) });
			} catch (primary) {
				try { await read.release(); }
				catch (cleanup) {
					throw new AggregateError([primary, cleanup], "retirement metadata acquisition release failed", { cause: primary });
				}
				throw primary;
			}
		},
	});
}

export interface ClosedEpochRetirementIntentInput {
	readonly preparation: AheRetirementPreparation;
	readonly generations: AheGenerationPartition;
	/** Acquires a fresh original one-use native control; outer RO has joined. */
	acquireCoordinator(): Promise<AheRetirementControlRead>;
	readonly participants: readonly ClosedEpochRetirementParticipant[];
	/** Original owner acquires fresh joint native custody and revalidates all
	 * captured source/control bytes after global completion, before delivery. */
	verifyCompleted(control: AheRetirementControl): Promise<void>;
}

const RETIREMENT_ENCODING_LIMITS = Object.freeze({ maxBytes: 262_144, maxItems: 65_536, maxDepth: 128 });
function retirementBytes(value: unknown): Uint8Array {
	return encodeCanonical(value, RETIREMENT_ENCODING_LIMITS);
}
function retirementEqual(left: unknown, right: unknown): boolean {
	if (left === undefined || right === undefined) return left === right;
	return compareBytes(retirementBytes(left), retirementBytes(right)) === 0;
}
function retirementRefusal(message: string): never {
	throw new TypeError(`closed epoch retirement refused: ${message}`);
}
async function releaseRetirementRead<T>(read: { release(): Promise<void> }, action: () => Promise<T>): Promise<T> {
	let primary: unknown;
	let failed = false;
	let result: T | undefined;
	try {
		result = await action();
	} catch (error) {
		primary = error;
		failed = true;
	}
	try {
		await read.release();
	} catch (cleanup) {
		if (failed) throw new AggregateError([primary, cleanup], "retirement native read release failed", { cause: primary });
		throw cleanup;
	}
	if (failed) throw primary;
	return result as T;
}
async function retirementReadback<T>(failed: boolean, primary: unknown, read: () => Promise<T>): Promise<T> {
	try {
		return await read();
	} catch (error) {
		if (failed) throw new AggregateError([primary, error], "retirement mutation and readback failed", { cause: primary });
		throw error;
	}
}

/**
 * Installs only metadata frontiers, never drains physical records. This is the
 * original cleanup owner's mechanical sequencing primitive, NOT a protocol
 * eligibility constructor. Its production caller must authenticate the exact
 * plan and native participants before joining outer proof reservations.
 *
 * Every attempted mutation consumes its original view. A fresh independent
 * readback must establish whole-old or whole-new before any later participant.
 * Even confirmed new state preserves a failed delivery as primary; the caller
 * may subsequently resume using the same durable intent. AHE completion is
 * last, so its active record remains the bounded durable association throughout
 * every local prepare/commit prefix. Completed domains retain that association.
 * @param input - Privately authenticated original owner composition.
 * @returns Exact native completed coordinator readback.
 */
export async function applyClosedEpochRetirementIntent(
	input: ClosedEpochRetirementIntentInput
): Promise<AheRetirementControl> {
	const preparation = captureAheRetirementPreparation(input.preparation, input.preparation.head.objectId);
	const generations: AheGenerationPartition = Object.freeze({
		recordDigests: Object.freeze([...input.generations.recordDigests]),
		identities: Object.freeze(input.generations.identities.map((identity) => Object.freeze({ ...identity }))),
		protectedIndices: Object.freeze([...input.generations.protectedIndices]),
		retireIndices: Object.freeze([...input.generations.retireIndices]),
	});
	retirementBytes({ preparation, generations });
	const acquireCoordinator = input.acquireCoordinator.bind(input);
	const verifyCompleted = input.verifyCompleted.bind(input);
	const originals = [...input.participants];
	const nativeDomains = preparation.domains.filter(([roles]) => (roles & 3) === 0);
	const ahe = preparation.domains.filter(([roles]) => (roles & 3) !== 0);
	if (
		ahe.length !== 1 ||
		ahe[0]?.[0] !== 3 ||
		originals.length !== nativeDomains.length ||
		nativeDomains.some(([roles]) => ![4, 8, 16, 32, 64, 128, 192].includes(roles))
	)
		retirementRefusal("native role partition");
	const coordinatorCommitment = ahe[0]!;
	const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	for (let index = 0; index < originals.length; index++) {
		const participant = originals[index];
		if (participant === undefined || !retirementEqual(participant.commitment, nativeDomains[index]))
			retirementRefusal("native participant association");
	}
	const participants: readonly ClosedEpochRetirementParticipant[] = Object.freeze(
		originals.map((participant, index) =>
			Object.freeze({ commitment: nativeDomains[index]!, acquire: participant.acquire.bind(participant) })
		)
	);
	const completedMatches = (control: AheRetirementControl): boolean => {
		const completed = control.completed;
		const source = preparation.generationSource,
			terminal = source !== undefined && completed?.generationDrain?.phase === "complete";
		return (
			control.active === null &&
			control.nominee == null &&
			completed !== null &&
			completed.throughEpoch === preparation.floorEpoch &&
			completed.decisionDigest === preparation.decisionDigest &&
			completed.sourceProofDigest === preparation.sourceProofDigest &&
			retirementEqual(completed.domains, preparation.domains) &&
			retirementEqual(
				completed.snapshotHoles,
				preparation.snapshotScopes.filter((_, index) => preparation.protectedIndices.includes(index))
			) &&
			retirementEqual(
				completed.generationHoles,
				terminal
					? source.postGenerations.recordDigests
					: generations.recordDigests.filter((_, index) => generations.protectedIndices.includes(index))
			) &&
			retirementEqual(
				completed.generationIdentities,
				terminal
					? source.postGenerations.identities
					: generations.identities.filter((_, index) => generations.protectedIndices.includes(index))
			) &&
			(source === undefined
				? completed.generationDrain === undefined
				: completed.generationDrain !== undefined && retirementEqual(completed.generationDrain.source, source))
		);
	};
	const preparedMatches = (control: AheRetirementControl): boolean =>
		control.active !== null &&
		retirementEqual(control.active.preparation, preparation) &&
		retirementEqual(control.binding, generations) &&
		control.nominee == null;
	const readCoordinator = async (): Promise<AheRetirementControl> => {
		const read = await acquireCoordinator();
		return releaseRetirementRead(read, async () => {
			const control = captureAheRetirementControl(read.control);
			if (
				control.objectId !== preparation.head.objectId ||
				control.incarnation !== hex(coordinatorCommitment[2]) ||
				read.imageDigest !==
					hex(
						coordinatorCommitment[
							control.completed?.generationDrain?.phase === "complete" && completedMatches(control) ? 5 : 4
						]
					) ||
				!retirementEqual(read.head, preparation.head)
			)
				retirementRefusal("coordinator source image changed");
			const offset = preparedMatches(control)
				? 1
				: completedMatches(control)
					? control.completed?.generationDrain?.phase === "complete"
						? 3
						: 2
					: 0;
			if (
				control.revision !== coordinatorCommitment[3] + offset ||
				control.sequence !== coordinatorCommitment[6] + (offset === 0 ? 0 : 1)
			)
				retirementRefusal("coordinator revision or sequence changed");
			return control;
		});
	};
	let coordinator = await readCoordinator();
	// Use the original native codec to validate the whole bound generation
	// partition before any participant can be invoked.
	captureAheRetirementControl({
		...coordinator,
		kind: "ahe-retirement-control-3",
		nominee: null,
		sequence: coordinator.sequence || 1,
		active: { sequence: coordinator.sequence || 1, phase: "prepared", preparation },
		binding: generations,
	});
	if (!preparedMatches(coordinator) && !completedMatches(coordinator)) {
		if (coordinator.active !== null || coordinator.nominee != null) retirementRefusal("foreign active intent");
		const read = await acquireCoordinator();
		let primary: unknown;
		let failed = false;
		try {
			await releaseRetirementRead(read, async () => {
				if (!retirementEqual(read.control, coordinator)) retirementRefusal("coordinator changed before prepare");
				const result = await read.prepareBound({ preparation, generations });
				if (!result.ok) throw new TypeError(`retirement coordinator prepare: ${result.reason}`, { cause: result });
			});
		} catch (error) {
			primary = error;
			failed = true;
		}
		const after = await retirementReadback(failed, primary, readCoordinator);
		if (!preparedMatches(after)) {
			if (failed) throw primary;
			retirementRefusal("coordinator prepare outcome is not exact new state");
		}
		coordinator = after;
		if (failed) throw primary;
	}
	const phaseOf = (participant: ClosedEpochRetirementParticipant,
		read: ClosedEpochRetirementParticipantRead): ClosedEpochRetirementParticipantRead["phase"] => {
		if (!retirementEqual(read.commitment, participant.commitment)) retirementRefusal("native source image changed");
		if (!["old", "prepared", "completed"].includes(read.phase)) retirementRefusal("native control malformed");
		return read.phase;
	};
	const inspect = async (
		participant: ClosedEpochRetirementParticipant
	): Promise<ClosedEpochRetirementParticipantRead["phase"]> => {
		const read = await participant.acquire(coordinator);
		return releaseRetirementRead(read, async () => phaseOf(participant, read));
	};
	const transition = async (
		participant: ClosedEpochRetirementParticipant,
		read: ClosedEpochRetirementParticipantRead,
		kind: "prepare" | "commit"
	): Promise<ClosedEpochRetirementParticipantRead> => {
		const next = kind === "prepare" ? "prepared" : "completed";
		// The phase decision and attempted CAS use ONE fresh original native
		// view, either the initial acquisition or the independent prepared
		// readback immediately preceding this SAME participant's commit. The
		// original writer still checks exact source/control currency afresh.
		let primary: unknown;
		let failed = false;
		try {
			await releaseRetirementRead(read, async () => {
				await (kind === "prepare" ? read.prepareFence() : read.commitPrepared());
			});
		} catch (error) {
			primary = error;
			failed = true;
		}
		// No ACK, cached phase, or original view can establish this outcome.
		// Retain only this fresh native readback, not a synthesized successor
		// view or portable proof. Its next one-use CAS owns its own native check.
		const after = await retirementReadback(failed, primary, async () => {
			const observed = await participant.acquire(coordinator);
			try { return { read: observed, phase: phaseOf(participant, observed) }; }
			catch (error) { return releaseRetirementRead(observed, async () => { throw error; }); }
		});
		if (after.phase !== next || failed)
			return releaseRetirementRead(after.read, async () => {
				if (failed) throw primary;
				return retirementRefusal("native outcome is not exact new state");
			});
		return after.read;
	};
	if (completedMatches(coordinator)) {
		for (const participant of participants)
			if ((await inspect(participant)) !== "completed") retirementRefusal("incomplete domain behind global completion");
		await verifyCompleted(coordinator);
		return coordinator;
	}
	for (const participant of participants) {
		let read = await participant.acquire(coordinator);
		let phase: ClosedEpochRetirementParticipantRead["phase"];
		try { phase = phaseOf(participant, read); }
		catch (primary) { return releaseRetirementRead(read, async () => { throw primary; }); }
		if (phase === "completed") {
			await releaseRetirementRead(read, async () => undefined);
			continue;
		}
		// These transitions install metadata fences only, never delete payloads.
		// The durable AHE intent already binds every participant throughout an
		// old/prepared/completed prefix. There is no all-prepared safety barrier:
		// complete this domain using its independent prepared readback before
		// entering another domain. Physical draining still follows global
		// completion, after the full all-domain recheck and joint source proof.
		if (phase === "old") read = await transition(participant, read, "prepare");
		const completed = await transition(participant, read, "commit");
		await releaseRetirementRead(completed, async () => undefined);
	}
	// Recheck every exact completed source/control after the last local commit.
	for (const participant of participants)
		if ((await inspect(participant)) !== "completed") retirementRefusal("native completion changed");
	const read = await acquireCoordinator();
	let primary: unknown;
	let failed = false;
	try {
		await releaseRetirementRead(read, async () => {
			if (!retirementEqual(read.control, coordinator) || !preparedMatches(read.control))
				retirementRefusal("coordinator changed before completion");
			const result = await read.commitPrepared({
				decisionDigest: preparation.decisionDigest,
				sourceProofDigest: preparation.sourceProofDigest,
			});
			if (!result.ok) throw new TypeError(`retirement coordinator commit: ${result.reason}`, { cause: result });
		});
	} catch (error) {
		primary = error;
		failed = true;
	}
	const after = await retirementReadback(failed, primary, readCoordinator);
	if (!completedMatches(after)) {
		if (failed) throw primary;
		retirementRefusal("coordinator completion outcome is not exact new state");
	}
	if (failed) throw primary;
	await verifyCompleted(after);
	return after;
}
