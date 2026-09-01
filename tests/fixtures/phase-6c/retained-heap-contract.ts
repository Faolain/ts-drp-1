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

export const D110A_RED_TOKENS = Object.freeze([
	"D110A_POST_GC_SLOPE_GATE_MISSING",
	"D110A_PAIRED_WORKLOAD_GATE_MISSING",
	"D110A_HARD_ENTRYPOINT_MISSING",
] as const);

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
	readonly hardEntrypoint: boolean;
	readonly pairedWorkloadGate: boolean;
	readonly postGcSlopeGate: boolean;
}> {
	const read = (relative: string): string => {
		const absolute = resolve(REPOSITORY_ROOT, relative);
		return existsSync(absolute) ? readFileSync(absolute, "utf8") : "";
	};
	const rootPackage = readFileSync(resolve(REPOSITORY_ROOT, "package.json"), "utf8");
	const child = read("tests/fixtures/phase-6c/retained-heap-child.mjs");
	const worker = read("tests/fixtures/phase-6c/retained-heap-worker.ts");
	return Object.freeze({
		hardEntrypoint:
			/"test:phase-6c-memory"\s*:\s*"pnpm build:packages && node --import=tsx tests\/fixtures\/phase-6c\/retained-heap-child\.mjs full"/u.test(
				rootPackage
			) && /45 \* 60 \* 1000/u.test(child),
		pairedWorkloadGate:
			/D110A_TOTAL_OPERATIONS/u.test(worker) &&
			/D110A_TOTAL_BATCH_VERTICES/u.test(worker) &&
			/d110aSemanticDigest/u.test(worker) &&
			/validateD110aProof/u.test(worker),
		postGcSlopeGate:
			/"--expose-gc"/u.test(child) &&
			/globalThis\.gc\(\)/u.test(worker) &&
			/heapUsed/u.test(worker) &&
			/arrayBuffers/u.test(worker) &&
			/ownedBytes/u.test(worker) &&
			/phase: "during-execution"/u.test(worker),
	});
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
