import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const D110A_OBJECT_EPOCHS = 64;
export const D110A_ACTIVE_ROOMS = 20;
export const D110A_OPERATIONS_PER_OBJECT = 15_625;
export const D110A_BATCH_VERTICES_PER_OBJECT = 977;
export const D110A_TOTAL_OPERATIONS = 1_000_000;
export const D110A_TOTAL_BATCH_VERTICES = 62_528;
export const D110A_SLOPE_START_INDEX = 32;
export const D110A_SLOPE_END_INDEX = 63;
export const D110A_SLOPE_LIMIT_BYTES = 165_161;
export const D110A_ABSOLUTE_LIMIT_BYTES = 512_000_000;
export const D110A_PREFLIGHT_TIMEOUT_MS = 900_000;
export const D110A_PREFLIGHT_RELEASE_MAX_MS = 630_000;
export const D110A_FULL_TIMEOUT_MS = 25_200_000;

export const D110A_RED_TOKENS = Object.freeze([
	"D110A_POST_GC_SLOPE_GATE_MISSING",
	"D110A_PAIRED_WORKLOAD_GATE_MISSING",
	"D110A_HARD_ENTRYPOINT_MISSING",
] as const);

export const D110AT_RED_TOKEN = "D110AT_PROFILE_ATTRIBUTION_MISSING";
export const D110AU_RED_TOKEN = "D110AU_PROFILE_CLOCK_CALIBRATION_MISSING";
export const D110AW_RED_TOKEN = "D110AW_TIMEOUT_FEASIBILITY_MISSING";
export const D110AX_RED_TOKEN = "D110AX_PREFLIGHT_VARIANCE_MISSING";
export const D110AX_FORENSICS_RED_TOKEN = "D110AX_FAILURE_FORENSICS_MISSING";

export const D110AU_PROFILE_MUTANTS = Object.freeze([
	"phase-before-start",
	"phase-after-stop",
	"missing-named-frame",
	"zero-matching-samples",
	"single-sample-window",
] as const);

export type D110auProfileMutant = (typeof D110AU_PROFILE_MUTANTS)[number];

export const D110AU_PROFILE_MUTANT_ERROR = Object.freeze({
	"missing-named-frame": "D110AU_PROFILE_WORKLOAD_FRAME_MISSING",
	"phase-after-stop": "D110AU_PROFILE_PHASE_OUTSIDE_CAPTURE",
	"phase-before-start": "D110AU_PROFILE_PHASE_OUTSIDE_CAPTURE",
	"single-sample-window": "D110AU_PROFILE_WORKLOAD_WINDOW_DEGENERATE",
	"zero-matching-samples": "D110AU_PROFILE_WORKLOAD_SAMPLES_MISSING",
} as const satisfies Readonly<Record<D110auProfileMutant, string>>);

export interface D110auCpuProfileNode {
	readonly callFrame: Readonly<{ readonly functionName: string; readonly url: string }>;
	readonly children?: readonly number[];
	readonly id: number;
}

export interface D110auProfileInput {
	readonly calibration: Readonly<{
		readonly hrtimeAfterStart: number;
		readonly hrtimeAfterStop: number;
		readonly hrtimeBeforeStart: number;
		readonly hrtimeBeforeStop: number;
	}>;
	readonly phases: readonly Readonly<{
		readonly monotonicMicroseconds: number;
		readonly phase: string;
	}>[];
	readonly profile: Readonly<{
		readonly endTime: number;
		readonly nodes: readonly D110auCpuProfileNode[];
		readonly samples: readonly number[];
		readonly startTime: number;
		readonly timeDeltas: readonly number[];
	}>;
}

export interface D110auProfileAttribution {
	readonly attributedMicroseconds: number;
	readonly clearlyDominant: boolean;
	readonly owners: readonly Readonly<{
		readonly owner: string;
		readonly selfMicroseconds: number;
		readonly share: number;
	}>[];
	readonly workerAncestrySamples: number;
	readonly workloadEnd: number;
	readonly workloadSamples: number;
	readonly workloadStart: number;
}

export const D110A_MUTANTS = Object.freeze([
	"missing-gc",
	"endpoint-only-slope",
	"sorted-samples",
	"baseline-subtraction",
	"wrong-ols-window",
	"window-not-held",
	"retained-js-graph",
	"retained-array-buffers",
	"absolute-budget-bypass",
	"dropped-operations",
	"double-counted-operations",
	"substituted-digest",
	"after-completion-only",
	"false-repeated-same-object",
] as const);

export type D110aMutant = (typeof D110A_MUTANTS)[number];

export const D110A_MUTANT_ERROR = Object.freeze({
	"absolute-budget-bypass": "D110A_HEAP_ABSOLUTE_EXCEEDED",
	"after-completion-only": "D110A_SAMPLE_PHASE_INVALID",
	"baseline-subtraction": "D110A_BASELINE_SUBTRACTION_FORBIDDEN",
	"double-counted-operations": "D110A_WORKLOAD_COUNT_INVALID",
	"dropped-operations": "D110A_WORKLOAD_COUNT_INVALID",
	"endpoint-only-slope": "D110A_SLOPE_METHOD_INVALID",
	"false-repeated-same-object": "D110A_TOPOLOGY_INVALID",
	"missing-gc": "D110A_GC_TURNS_INVALID",
	"retained-array-buffers": "D110A_ARRAY_BUFFER_SLOPE_EXCEEDED",
	"retained-js-graph": "D110A_HEAP_SLOPE_EXCEEDED",
	"sorted-samples": "D110A_SAMPLE_ORDER_INVALID",
	"substituted-digest": "D110A_SEMANTIC_DIGEST_INVALID",
	"window-not-held": "D110A_ACTIVE_WINDOW_INVALID",
	"wrong-ols-window": "D110A_SLOPE_WINDOW_INVALID",
} as const satisfies Readonly<Record<D110aMutant, string>>);

export interface D110aMemoryReading {
	readonly arrayBuffers: number;
	readonly external: number;
	readonly heapUsed: number;
	readonly ownedBytes: number;
	readonly rss: number;
}

export interface D110aSample {
	readonly activeSuccessors: number;
	readonly appliedWorkloadOperations: number;
	readonly completedObjectEpochs: number;
	readonly eventLoopTurns: number;
	readonly gcTurns: number;
	readonly index: number;
	readonly memory: D110aMemoryReading;
	readonly phase: "during-execution" | "after-completion";
}

export interface D110aObjectResult {
	readonly appliedWorkloadOperations: number;
	readonly objectId: string;
	readonly postSuccessorState: number;
	readonly preCloseState: number;
}

export interface D110aProof {
	readonly accounting: Readonly<{
		readonly admittedWorkloadOperations: number;
		readonly appliedWorkloadOperations: number;
		readonly nextSuccessorOperations: number;
		readonly successfulLifecycles: number;
		readonly workloadBatchVertices: number;
	}>;
	readonly baseline: D110aMemoryReading;
	readonly finalWindowClosedAfterTerminalSample: boolean;
	readonly measurement: Readonly<{
		readonly baselineSubtracted: boolean;
		readonly sampleOrder: "execution" | "sorted";
		readonly slopeEndIndex: number;
		readonly slopeMethod: "ols" | "endpoints";
		readonly slopeStartIndex: number;
	}>;
	readonly objectResults: readonly D110aObjectResult[];
	readonly repeatedSameObjectEpochs: boolean;
	readonly samples: readonly D110aSample[];
	readonly semanticDigest: string;
}

export interface D110aValidation {
	readonly arrayBufferSlope: number;
	readonly heapSlope: number;
	readonly maximumHeapUsed: number;
	readonly maximumOwnedBytes: number;
	readonly ownedBytesSlope: number;
}

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");

function fail(code: string): never {
	throw new TypeError(code);
}

function finiteNonnegative(value: number, code: string): void {
	if (!Number.isFinite(value) || value < 0) fail(code);
}

function memoryReading(value: D110aMemoryReading): void {
	finiteNonnegative(value.heapUsed, "D110A_MEMORY_SAMPLE_INVALID");
	finiteNonnegative(value.arrayBuffers, "D110A_MEMORY_SAMPLE_INVALID");
	finiteNonnegative(value.external, "D110A_MEMORY_SAMPLE_INVALID");
	finiteNonnegative(value.rss, "D110A_MEMORY_SAMPLE_INVALID");
	finiteNonnegative(value.ownedBytes, "D110A_MEMORY_SAMPLE_INVALID");
	if (value.ownedBytes !== value.heapUsed + value.arrayBuffers) fail("D110A_MEMORY_SAMPLE_INVALID");
}

/**
 * Calculates ordinary least squares against the samples' execution indices.
 * @param samples - Exact unsorted execution window.
 * @param select - Selected raw memory field.
 * @returns Bytes per object-epoch.
 */
export function d110aOlsSlope(samples: readonly D110aSample[], select: (sample: D110aSample) => number): number {
	const count = samples.length;
	if (count < 2) fail("D110A_SLOPE_WINDOW_INVALID");
	let sumX = 0;
	let sumY = 0;
	let sumXY = 0;
	let sumXX = 0;
	for (const sample of samples) {
		const x = sample.index;
		const y = select(sample);
		sumX += x;
		sumY += y;
		sumXY += x * y;
		sumXX += x * x;
	}
	const denominator = count * sumXX - sumX * sumX;
	if (denominator === 0) fail("D110A_SLOPE_WINDOW_INVALID");
	return (count * sumXY - sumX * sumY) / denominator;
}

/**
 * Derives the independent semantic digest from ordered detached object facts.
 * @param results - Exact ordered object results.
 * @returns Lowercase SHA-256 digest.
 */
export function d110aSemanticDigest(results: readonly D110aObjectResult[]): string {
	const hash = createHash("sha256");
	for (const result of results) {
		hash.update(
			`${result.objectId}\t${result.appliedWorkloadOperations}\t${result.preCloseState}\t${result.postSuccessorState}\n`,
			"utf8"
		);
	}
	return hash.digest("hex");
}

/**
 * Validates one complete full-worker proof without trusting reported slopes.
 * @param proof - Detached worker result.
 * @returns Independently calculated hard-gate values.
 */
export function validateD110aProof(proof: D110aProof): D110aValidation {
	if (
		proof.accounting.admittedWorkloadOperations !== D110A_TOTAL_OPERATIONS ||
		proof.accounting.appliedWorkloadOperations !== D110A_TOTAL_OPERATIONS ||
		proof.accounting.workloadBatchVertices !== D110A_TOTAL_BATCH_VERTICES ||
		proof.accounting.successfulLifecycles !== D110A_OBJECT_EPOCHS ||
		proof.accounting.nextSuccessorOperations !== D110A_OBJECT_EPOCHS
	) {
		fail("D110A_WORKLOAD_COUNT_INVALID");
	}
	if (
		proof.repeatedSameObjectEpochs ||
		proof.objectResults.length !== D110A_OBJECT_EPOCHS ||
		new Set(proof.objectResults.map(({ objectId }) => objectId)).size !== D110A_OBJECT_EPOCHS
	) {
		fail("D110A_TOPOLOGY_INVALID");
	}
	for (const result of proof.objectResults) {
		if (
			result.appliedWorkloadOperations !== D110A_OPERATIONS_PER_OBJECT ||
			result.preCloseState !== 15_628 ||
			result.postSuccessorState !== 15_629
		) {
			fail("D110A_WORKLOAD_COUNT_INVALID");
		}
	}
	if (proof.semanticDigest !== d110aSemanticDigest(proof.objectResults)) fail("D110A_SEMANTIC_DIGEST_INVALID");
	if (proof.measurement.slopeMethod !== "ols") fail("D110A_SLOPE_METHOD_INVALID");
	if (proof.measurement.sampleOrder !== "execution") fail("D110A_SAMPLE_ORDER_INVALID");
	if (proof.measurement.baselineSubtracted) fail("D110A_BASELINE_SUBTRACTION_FORBIDDEN");
	if (
		proof.measurement.slopeStartIndex !== D110A_SLOPE_START_INDEX ||
		proof.measurement.slopeEndIndex !== D110A_SLOPE_END_INDEX
	) {
		fail("D110A_SLOPE_WINDOW_INVALID");
	}
	if (!proof.finalWindowClosedAfterTerminalSample) fail("D110A_SAMPLE_PHASE_INVALID");
	memoryReading(proof.baseline);
	if (proof.samples.length !== D110A_OBJECT_EPOCHS) fail("D110A_SAMPLE_COUNT_INVALID");
	for (let index = 0; index < proof.samples.length; index += 1) {
		const sample = proof.samples[index] as D110aSample;
		if (
			sample.index !== index ||
			sample.completedObjectEpochs !== index + 1 ||
			sample.appliedWorkloadOperations !== (index + 1) * D110A_OPERATIONS_PER_OBJECT
		) {
			fail("D110A_SAMPLE_PROGRESS_INVALID");
		}
		if (sample.activeSuccessors !== Math.min(index + 1, D110A_ACTIVE_ROOMS)) {
			fail("D110A_ACTIVE_WINDOW_INVALID");
		}
		if (sample.gcTurns !== 3 || sample.eventLoopTurns !== 3) fail("D110A_GC_TURNS_INVALID");
		if (sample.phase !== "during-execution") fail("D110A_SAMPLE_PHASE_INVALID");
		memoryReading(sample.memory);
	}
	const maximumHeapUsed = Math.max(...proof.samples.map(({ memory }) => memory.heapUsed));
	const maximumOwnedBytes = Math.max(...proof.samples.map(({ memory }) => memory.ownedBytes));
	if (maximumHeapUsed >= D110A_ABSOLUTE_LIMIT_BYTES) fail("D110A_HEAP_ABSOLUTE_EXCEEDED");
	if (maximumOwnedBytes >= D110A_ABSOLUTE_LIMIT_BYTES) fail("D110A_OWNED_BYTES_ABSOLUTE_EXCEEDED");
	const window = proof.samples.slice(D110A_SLOPE_START_INDEX, D110A_SLOPE_END_INDEX + 1);
	if (window.length !== 32 || window.some(({ activeSuccessors }) => activeSuccessors !== D110A_ACTIVE_ROOMS)) {
		fail("D110A_SLOPE_WINDOW_INVALID");
	}
	const heapSlope = d110aOlsSlope(window, ({ memory }) => memory.heapUsed);
	const arrayBufferSlope = d110aOlsSlope(window, ({ memory }) => memory.arrayBuffers);
	const ownedBytesSlope = d110aOlsSlope(window, ({ memory }) => memory.ownedBytes);
	if (heapSlope > D110A_SLOPE_LIMIT_BYTES) fail("D110A_HEAP_SLOPE_EXCEEDED");
	if (arrayBufferSlope > D110A_SLOPE_LIMIT_BYTES) fail("D110A_ARRAY_BUFFER_SLOPE_EXCEEDED");
	if (ownedBytesSlope > D110A_SLOPE_LIMIT_BYTES) fail("D110A_OWNED_BYTES_SLOPE_EXCEEDED");
	return Object.freeze({ arrayBufferSlope, heapSlope, maximumHeapUsed, maximumOwnedBytes, ownedBytesSlope });
}

function reading(heapUsed: number, arrayBuffers: number): D110aMemoryReading {
	return Object.freeze({
		arrayBuffers,
		external: arrayBuffers + 1_000_000,
		heapUsed,
		ownedBytes: heapUsed + arrayBuffers,
		rss: heapUsed + arrayBuffers + 10_000_000,
	});
}

/**
 * Builds one valid lightweight proof without running the genuine worker.
 * @returns Synthetic proof used only to calibrate validator mutants.
 */
export function d110aSyntheticProof(): D110aProof {
	const objectResults = Object.freeze(
		Array.from({ length: D110A_OBJECT_EPOCHS }, (_, index) =>
			Object.freeze({
				appliedWorkloadOperations: D110A_OPERATIONS_PER_OBJECT,
				objectId: `creator:${index.toString(16).padStart(32, "0")}`,
				postSuccessorState: 15_629,
				preCloseState: 15_628,
			})
		)
	);
	return Object.freeze({
		accounting: Object.freeze({
			admittedWorkloadOperations: D110A_TOTAL_OPERATIONS,
			appliedWorkloadOperations: D110A_TOTAL_OPERATIONS,
			nextSuccessorOperations: D110A_OBJECT_EPOCHS,
			successfulLifecycles: D110A_OBJECT_EPOCHS,
			workloadBatchVertices: D110A_TOTAL_BATCH_VERTICES,
		}),
		baseline: reading(20_000_000, 1_000_000),
		finalWindowClosedAfterTerminalSample: true,
		measurement: Object.freeze({
			baselineSubtracted: false,
			sampleOrder: "execution" as const,
			slopeEndIndex: D110A_SLOPE_END_INDEX,
			slopeMethod: "ols" as const,
			slopeStartIndex: D110A_SLOPE_START_INDEX,
		}),
		objectResults,
		repeatedSameObjectEpochs: false,
		samples: Object.freeze(
			Array.from({ length: D110A_OBJECT_EPOCHS }, (_, index) =>
				Object.freeze({
					activeSuccessors: Math.min(index + 1, D110A_ACTIVE_ROOMS),
					appliedWorkloadOperations: (index + 1) * D110A_OPERATIONS_PER_OBJECT,
					completedObjectEpochs: index + 1,
					eventLoopTurns: 3,
					gcTurns: 3,
					index,
					memory: reading(20_000_000, 1_000_000),
					phase: "during-execution" as const,
				})
			)
		),
		semanticDigest: d110aSemanticDigest(objectResults),
	});
}

const D110AU_WORKLOAD_FUNCTION = "runD110auApplicationWorkload";
const D110AU_WORKER_URL = "file:///repository/tests/fixtures/phase-6c/retained-heap-worker.ts";

/**
 * Builds the detached disjoint-clock control used to calibrate D.110a-u.
 * @returns Synthetic CPU-profile and phase-clock input without running a workload.
 */
export function d110auSyntheticProfileInput(): D110auProfileInput {
	const phaseNames = Object.freeze([
		"fixture-open",
		"workload-complete",
		"creator-close-complete",
		"reclamation-complete",
		"successor-published",
		"sample-complete",
		"teardown-complete",
	]);
	return Object.freeze({
		calibration: Object.freeze({
			hrtimeAfterStart: 9_000_010,
			hrtimeAfterStop: 9_000_400,
			hrtimeBeforeStart: 9_000_000,
			hrtimeBeforeStop: 9_000_300,
		}),
		phases: Object.freeze(
			phaseNames.map((phase, index) => Object.freeze({ monotonicMicroseconds: 9_000_020 + index * 10, phase }))
		),
		profile: Object.freeze({
			endTime: 1_000_200,
			nodes: Object.freeze([
				Object.freeze({
					callFrame: Object.freeze({ functionName: "(root)", url: "" }),
					children: Object.freeze([2, 4, 5, 6]),
					id: 1,
				}),
				Object.freeze({
					callFrame: Object.freeze({ functionName: D110AU_WORKLOAD_FUNCTION, url: D110AU_WORKER_URL }),
					children: Object.freeze([3]),
					id: 2,
				}),
				Object.freeze({
					callFrame: Object.freeze({ functionName: "issueLocal", url: "file:///repository/packages/node.js" }),
					id: 3,
				}),
				Object.freeze({
					callFrame: Object.freeze({ functionName: D110AU_WORKLOAD_FUNCTION, url: D110AU_WORKER_URL }),
					id: 4,
				}),
				Object.freeze({
					callFrame: Object.freeze({ functionName: "(garbage collector)", url: "" }),
					id: 5,
				}),
				Object.freeze({
					callFrame: Object.freeze({ functionName: "outsideWorkload", url: D110AU_WORKER_URL }),
					id: 6,
				}),
			]),
			samples: Object.freeze([6, 2, 5, 4, 6]),
			startTime: 1_000_000,
			timeDeltas: Object.freeze([10, 20, 30, 40, 50]),
		}),
	});
}

/**
 * Produces one precise D.110a-u attribution false gate.
 * @param mutant - Frozen mutant name.
 * @returns Invalid detached profile input.
 */
export function d110auMutantProfileInput(mutant: D110auProfileMutant): D110auProfileInput {
	const input = structuredClone(d110auSyntheticProfileInput()) as {
		calibration: {
			hrtimeAfterStart: number;
			hrtimeAfterStop: number;
			hrtimeBeforeStart: number;
			hrtimeBeforeStop: number;
		};
		phases: Array<{ monotonicMicroseconds: number; phase: string }>;
		profile: {
			endTime: number;
			nodes: Array<{ callFrame: { functionName: string; url: string }; children?: number[]; id: number }>;
			samples: number[];
			startTime: number;
			timeDeltas: number[];
		};
	};
	switch (mutant) {
		case "phase-before-start":
			if (input.phases[0] !== undefined) {
				input.phases[0].monotonicMicroseconds = input.calibration.hrtimeAfterStart - 1;
			}
			break;
		case "phase-after-stop":
			if (input.phases.at(-1) !== undefined) {
				(input.phases.at(-1) as { monotonicMicroseconds: number }).monotonicMicroseconds =
					input.calibration.hrtimeBeforeStop + 1;
			}
			break;
		case "missing-named-frame":
			for (const node of input.profile.nodes) {
				if (node.callFrame.functionName === D110AU_WORKLOAD_FUNCTION) node.callFrame.functionName = "renamedWorkload";
			}
			break;
		case "zero-matching-samples":
			input.profile.samples = [6, 5, 6];
			input.profile.timeDeltas = [10, 20, 30];
			break;
		case "single-sample-window":
			input.profile.samples = [6, 2, 6];
			input.profile.timeDeltas = [10, 20, 30];
			break;
	}
	return input;
}

/**
 * Validates detached profile-clock custody and named-window attribution.
 * @param input - Detached profile, phase and calibration data.
 * @returns Attribution derived without cross-clock absolute comparison.
 */
export function validateD110auProfileAttribution(input: D110auProfileInput): D110auProfileAttribution {
	const { calibration, phases, profile } = input;
	const calibrationValues = [
		calibration.hrtimeBeforeStart,
		calibration.hrtimeAfterStart,
		calibration.hrtimeBeforeStop,
		calibration.hrtimeAfterStop,
	];
	if (
		calibrationValues.some((value) => !Number.isSafeInteger(value) || value < 0) ||
		calibration.hrtimeBeforeStart > calibration.hrtimeAfterStart ||
		calibration.hrtimeAfterStart >= calibration.hrtimeBeforeStop ||
		calibration.hrtimeBeforeStop > calibration.hrtimeAfterStop
	) {
		fail("D110AU_PROFILE_CLOCK_CALIBRATION_INVALID");
	}
	if (
		!Number.isFinite(profile.startTime) ||
		!Number.isFinite(profile.endTime) ||
		profile.endTime <= profile.startTime ||
		!Array.isArray(profile.nodes) ||
		!Array.isArray(profile.samples) ||
		!Array.isArray(profile.timeDeltas) ||
		profile.samples.length !== profile.timeDeltas.length
	) {
		fail("D110AT_PROFILE_SCHEMA_INVALID");
	}
	const profileDuration = profile.endTime - profile.startTime;
	if (profileDuration > 900_000_000 || profileDuration > calibration.hrtimeAfterStop - calibration.hrtimeBeforeStart) {
		fail("D110AU_PROFILE_DURATION_INVALID");
	}
	if (
		phases.length !== 7 ||
		phases.some(
			({ monotonicMicroseconds }) =>
				!Number.isSafeInteger(monotonicMicroseconds) ||
				monotonicMicroseconds < calibration.hrtimeAfterStart ||
				monotonicMicroseconds > calibration.hrtimeBeforeStop
		)
	) {
		fail("D110AU_PROFILE_PHASE_OUTSIDE_CAPTURE");
	}

	const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
	const parents = new Map<number, number>();
	for (const node of profile.nodes) {
		for (const childId of node.children ?? []) parents.set(childId, node.id);
	}
	const matchingNodeIds = new Set(
		profile.nodes
			.filter(
				({ callFrame }) =>
					callFrame.functionName === D110AU_WORKLOAD_FUNCTION && callFrame.url.endsWith("/retained-heap-worker.ts")
			)
			.map(({ id }) => id)
	);
	if (matchingNodeIds.size === 0) fail("D110AU_PROFILE_WORKLOAD_FRAME_MISSING");
	const hasNamedWorkloadAncestry = (nodeId: number): boolean => {
		const visited = new Set<number>();
		for (let current: number | undefined = nodeId; current !== undefined && !visited.has(current); ) {
			visited.add(current);
			if (matchingNodeIds.has(current)) return true;
			current = parents.get(current);
		}
		return false;
	};

	let timestamp = profile.startTime;
	const sampleTimestamps: number[] = [];
	const matchingSampleIndexes: number[] = [];
	for (const [index, nodeId] of profile.samples.entries()) {
		const delta = profile.timeDeltas[index];
		if (delta === undefined || !Number.isFinite(delta) || delta < 0) fail("D110AT_PROFILE_DELTA_INVALID");
		timestamp += delta;
		sampleTimestamps.push(timestamp);
		if (hasNamedWorkloadAncestry(nodeId)) matchingSampleIndexes.push(index);
	}
	const firstIndex = matchingSampleIndexes[0];
	const lastIndex = matchingSampleIndexes.at(-1);
	if (firstIndex === undefined || lastIndex === undefined) fail("D110AU_PROFILE_WORKLOAD_SAMPLES_MISSING");
	const workloadStart = sampleTimestamps[firstIndex];
	const workloadEnd = sampleTimestamps[lastIndex];
	if (
		firstIndex === lastIndex ||
		workloadStart === undefined ||
		workloadEnd === undefined ||
		workloadStart >= workloadEnd
	) {
		fail("D110AU_PROFILE_WORKLOAD_WINDOW_DEGENERATE");
	}

	const owners = new Map<string, number>();
	let attributedMicroseconds = 0;
	for (let index = firstIndex; index <= lastIndex; index += 1) {
		const delta = profile.timeDeltas[index];
		const nodeId = profile.samples[index];
		if (delta === undefined || nodeId === undefined) fail("D110AT_PROFILE_SCHEMA_INVALID");
		attributedMicroseconds += delta;
		const frame = nodes.get(nodeId)?.callFrame;
		const owner = String(frame?.url || `[runtime] ${frame?.functionName || "anonymous"}`);
		owners.set(owner, (owners.get(owner) ?? 0) + delta);
	}
	if (attributedMicroseconds <= 0) fail("D110AU_PROFILE_WORKLOAD_WINDOW_DEGENERATE");
	const rankedOwners = Object.freeze(
		[...owners.entries()]
			.map(([owner, selfMicroseconds]) =>
				Object.freeze({ owner, selfMicroseconds, share: selfMicroseconds / attributedMicroseconds })
			)
			.sort((left, right) => right.selfMicroseconds - left.selfMicroseconds || left.owner.localeCompare(right.owner))
	);
	const first = rankedOwners[0];
	const second = rankedOwners[1];
	const clearlyDominant =
		first !== undefined && first.share >= 0.5 && first.selfMicroseconds >= 2 * (second?.selfMicroseconds ?? 0);
	return Object.freeze({
		attributedMicroseconds,
		clearlyDominant,
		owners: rankedOwners,
		workerAncestrySamples: matchingSampleIndexes.length,
		workloadEnd,
		workloadSamples: lastIndex - firstIndex + 1,
		workloadStart,
	});
}

type D110aMutableProof = {
	accounting: Record<string, number>;
	baseline: D110aMemoryReading;
	finalWindowClosedAfterTerminalSample: boolean;
	measurement: Record<string, boolean | number | string>;
	objectResults: D110aObjectResult[];
	repeatedSameObjectEpochs: boolean;
	samples: Array<{
		activeSuccessors: number;
		appliedWorkloadOperations: number;
		completedObjectEpochs: number;
		eventLoopTurns: number;
		gcTurns: number;
		index: number;
		memory: D110aMemoryReading;
		phase: "after-completion" | "during-execution";
	}>;
	semanticDigest: string;
};

function mutableProof(): D110aMutableProof {
	return structuredClone(d110aSyntheticProof()) as unknown as D110aMutableProof;
}

function mutableSample(proof: ReturnType<typeof mutableProof>, index: number): (typeof proof.samples)[number] {
	const sample = proof.samples[index];
	if (sample === undefined) fail("D110A_SAMPLE_COUNT_INVALID");
	return sample;
}

/**
 * Produces one precise false-gate proof.
 * @param mutant - Frozen mutant name.
 * @returns Invalid detached proof.
 */
export function d110aMutantProof(mutant: D110aMutant): D110aProof {
	const proof = mutableProof();
	switch (mutant) {
		case "missing-gc":
			mutableSample(proof, 0).gcTurns = 2;
			break;
		case "endpoint-only-slope":
			proof.measurement.slopeMethod = "endpoints";
			break;
		case "sorted-samples":
			proof.measurement.sampleOrder = "sorted";
			break;
		case "baseline-subtraction":
			proof.measurement.baselineSubtracted = true;
			break;
		case "wrong-ols-window":
			proof.measurement.slopeStartIndex = 31;
			break;
		case "window-not-held":
			mutableSample(proof, D110A_SLOPE_START_INDEX).activeSuccessors = 19;
			break;
		case "retained-js-graph":
			for (const sample of proof.samples) {
				const heapUsed = 20_000_000 + sample.index * 1_048_576;
				sample.memory = reading(heapUsed, sample.memory.arrayBuffers);
			}
			break;
		case "retained-array-buffers":
			for (const sample of proof.samples) {
				const arrayBuffers = 1_000_000 + sample.index * 1_048_576;
				sample.memory = reading(sample.memory.heapUsed, arrayBuffers);
			}
			break;
		case "absolute-budget-bypass":
			mutableSample(proof, D110A_SLOPE_START_INDEX).memory = reading(D110A_ABSOLUTE_LIMIT_BYTES, 0);
			break;
		case "dropped-operations":
			proof.accounting.appliedWorkloadOperations -= 1;
			break;
		case "double-counted-operations":
			proof.accounting.appliedWorkloadOperations += 1;
			break;
		case "substituted-digest":
			proof.semanticDigest = "f".repeat(64);
			break;
		case "after-completion-only":
			for (const sample of proof.samples) sample.phase = "after-completion";
			break;
		case "false-repeated-same-object":
			proof.repeatedSameObjectEpochs = true;
			break;
	}
	return proof as unknown as D110aProof;
}

/**
 * Audits the D.110a worker, launcher, validator, and root entry-point owners.
 * @returns Current hard-infrastructure facts.
 */
export function d110aCurrentInfrastructureAudit(): Readonly<{
	readonly childProfileCustody: boolean;
	readonly failureForensics: boolean;
	readonly gracefulProfileMode: boolean;
	readonly hardEntrypoint: boolean;
	readonly pairedWorkloadGate: boolean;
	readonly phaseProgressSchema: boolean;
	readonly profileClockCalibration: boolean;
	readonly postGcSlopeGate: boolean;
	readonly preflightVariance: boolean;
	readonly watchdogFeasibility: boolean;
}> {
	const read = (relative: string): string => {
		const absolute = resolve(REPOSITORY_ROOT, relative);
		return existsSync(absolute) ? readFileSync(absolute, "utf8") : "";
	};
	const rootPackage = readFileSync(resolve(REPOSITORY_ROOT, "package.json"), "utf8");
	const child = read("tests/fixtures/phase-6c/retained-heap-child.mjs");
	const forensics = read("tests/fixtures/phase-6c/retained-heap-forensics.mjs");
	const worker = read("tests/fixtures/phase-6c/retained-heap-worker.ts");
	return Object.freeze({
		childProfileCustody:
			/node:inspector/u.test(child) &&
			/Profiler\.enable/u.test(child) &&
			/Profiler\.start/u.test(child) &&
			/Profiler\.stop/u.test(child) &&
			/flag:\s*"wx"/u.test(child) &&
			/retained-heap-worker\.ts/u.test(child),
		failureForensics:
			/createD110aFullForensicConfiguration/u.test(forensics) &&
			/captureD110aForensicChild/u.test(forensics) &&
			/validateD110aForensicJournal/u.test(forensics) &&
			/terminal\.json/u.test(forensics) &&
			/progress\.jsonl/u.test(forensics),
		gracefulProfileMode:
			/ROLE !== "full" && ROLE !== "preflight" && ROLE !== "profile"/u.test(child) &&
			/mode === "profile" \? 900_000/u.test(child) &&
			/runD110aProfile/u.test(worker),
		hardEntrypoint:
			/"test:phase-6c-memory"\s*:\s*"pnpm build:packages && node --import=tsx tests\/fixtures\/phase-6c\/retained-heap-child\.mjs full"/u.test(
				rootPackage
			),
		pairedWorkloadGate:
			/D110A_TOTAL_OPERATIONS/u.test(worker) &&
			/D110A_TOTAL_BATCH_VERTICES/u.test(worker) &&
			/d110aSemanticDigest/u.test(worker) &&
			/validateD110aProof/u.test(worker),
		phaseProgressSchema:
			/D110aProfilePhase/u.test(worker) &&
			/"fixture-open"/u.test(worker) &&
			/"workload-complete"/u.test(worker) &&
			/"creator-close-complete"/u.test(worker) &&
			/"reclamation-complete"/u.test(worker) &&
			/"successor-published"/u.test(worker) &&
			/"sample-complete"/u.test(worker) &&
			/"teardown-complete"/u.test(worker),
		profileClockCalibration:
			/\.logs\/phase-6c-d110au-green/u.test(child) &&
			/d110au-main\.cpuprofile/u.test(child) &&
			/capture-consumed\.json/u.test(child) &&
			/capture-records\.json/u.test(child) &&
			/hrtimeBeforeStart/u.test(child) &&
			/hrtimeAfterStart/u.test(child) &&
			/hrtimeBeforeStop/u.test(child) &&
			/hrtimeAfterStop/u.test(child) &&
			/process\.hrtime\.bigint\(\) \/ 1_000n/u.test(child) &&
			/validateD110auProfileAttribution/u.test(child) &&
			/runD110auApplicationWorkload/u.test(worker) &&
			/appliedWorkloadOperations,\s*latest/u.test(worker),
		postGcSlopeGate:
			/"--expose-gc"/u.test(child) &&
			/globalThis\.gc\(\)/u.test(worker) &&
			/heapUsed/u.test(worker) &&
			/arrayBuffers/u.test(worker) &&
			/ownedBytes/u.test(worker) &&
			/phase: "during-execution"/u.test(worker),
		preflightVariance:
			Number(D110A_FULL_TIMEOUT_MS) === 25_200_000 &&
			Number(D110A_PREFLIGHT_RELEASE_MAX_MS) === 630_000 &&
			D110A_PREFLIGHT_RELEASE_MAX_MS * 32 === D110A_FULL_TIMEOUT_MS * 0.8,
		watchdogFeasibility:
			/D110A_PREFLIGHT_TIMEOUT_MS/u.test(child) &&
			/D110A_FULL_TIMEOUT_MS/u.test(child) &&
			/mode === "profile" \? 900_000/u.test(child) &&
			!/45 \* 60 \* 1000/u.test(child) &&
			!/5 \* 60 \* 1000/u.test(child),
	});
}

/** Fails with the exact D.110a-t RED token while profile attribution custody is absent. */
export function requireD110atProfileAttribution(): void {
	const audit = d110aCurrentInfrastructureAudit();
	if (!audit.gracefulProfileMode || !audit.phaseProgressSchema || !audit.childProfileCustody) {
		fail(D110AT_RED_TOKEN);
	}
}

/** Fails with the exact D.110a-w RED token while the parent watchdogs remain infeasible. */
export function requireD110awTimeoutFeasibility(): void {
	if (!d110aCurrentInfrastructureAudit().watchdogFeasibility) fail(D110AW_RED_TOKEN);
}

/** Fails with the exact D.110a-x RED token while the variance reserve is infeasible. */
export function requireD110axPreflightVariance(): void {
	if (!d110aCurrentInfrastructureAudit().preflightVariance) fail(D110AX_RED_TOKEN);
}

/** Fails with the exact D.110a-x RED token while full-run failure evidence is incomplete. */
export function requireD110axFailureForensics(): void {
	if (!d110aCurrentInfrastructureAudit().failureForensics) fail(D110AX_FORENSICS_RED_TOKEN);
}

/** Fails with the exact RED token while the post-GC gate is absent. */
export function requireD110aPostGcSlopeGate(): void {
	if (!d110aCurrentInfrastructureAudit().postGcSlopeGate) fail(D110A_RED_TOKENS[0]);
}

/** Fails with the exact RED token while paired workload proof is absent. */
export function requireD110aPairedWorkloadGate(): void {
	if (!d110aCurrentInfrastructureAudit().pairedWorkloadGate) fail(D110A_RED_TOKENS[1]);
}

/** Fails with the exact RED token while the hard entry point is absent. */
export function requireD110aHardEntrypoint(): void {
	if (!d110aCurrentInfrastructureAudit().hardEntrypoint) fail(D110A_RED_TOKENS[2]);
}
