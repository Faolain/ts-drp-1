/* eslint-disable jsdoc/require-jsdoc */
import { encodeCanonical } from "@ts-drp/canonical";
import { CompactMerkleAccumulator, type EpochVertex, topologicalOrder } from "@ts-drp/compaction";

export const OPERATION_VERTICES = 4_096;
export const TOTAL_VERTICES = OPERATION_VERTICES + 1;
const ANCHOR_HASH = "0".repeat(64);
const PROTOCOL = "ts-drp/worker-host";
const VERSION = 1;

export interface WorkloadOracle {
	readonly count: number;
	readonly order: readonly number[];
	readonly root: string;
}

export interface RepeatedWorkloadOracle {
	readonly count: number;
	readonly orderLength: number;
	readonly root: string;
}

export interface WorkloadSummary extends WorkloadOracle {
	readonly items: number;
	readonly pageCounter: number;
	readonly pageScope: string;
	readonly workerCounter: number;
	readonly workerScope: string;
}

export interface MeasuredWorkload {
	readonly longTaskControlMs: number;
	readonly maxLongTaskMs: number;
	readonly oracle: WorkloadOracle;
	readonly summary: WorkloadSummary;
}

function hashForSequence(sequence: number): string {
	return sequence.toString(16).padStart(64, "0");
}

function graph(): ReadonlyMap<string, EpochVertex> {
	const vertices = new Map<string, EpochVertex>();
	vertices.set(ANCHOR_HASH, {
		dependencies: [],
		epoch: 1,
		hash: ANCHOR_HASH,
		kind: "drp-epoch-anchor",
		objectId: "phase-2f-c-real-workload",
	});
	for (let sequence = OPERATION_VERTICES; sequence >= 1; sequence--) {
		const hash = hashForSequence(sequence);
		vertices.set(hash, {
			anchor: ANCHOR_HASH,
			dependencies: [ANCHOR_HASH],
			epoch: 1,
			hash,
			kind: "drp-vertex",
			objectId: "phase-2f-c-real-workload",
			operation: { conflictKey: `key-${sequence % 64}`, value: sequence },
		});
	}
	return vertices;
}

function hex(bytes: Uint8Array): string {
	return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function computeMainThreadOracle(): WorkloadOracle {
	const vertices = graph();
	const orderedHashes = topologicalOrder(vertices, ANCHOR_HASH);
	const accumulator = new CompactMerkleAccumulator();
	for (const hash of orderedHashes) accumulator.append(encodeCanonical(vertices.get(hash)));
	return {
		count: orderedHashes.length,
		order: orderedHashes.map((hash) => Number.parseInt(hash.slice(-8), 16)),
		root: hex(accumulator.root()),
	};
}

/**
 * Independently derives the Merkle root and exact totals for back-to-back
 * executions of the authoritative Phase 2f-c workload.
 * @param repetitionCount - Number of accepted identical worker executions.
 * @returns Root and totals for the concatenated authoritative vertex sequence.
 */
export function computeRepeatedMainThreadOracle(repetitionCount: number): RepeatedWorkloadOracle {
	if (!Number.isSafeInteger(repetitionCount) || repetitionCount < 1 || repetitionCount > 256)
		throw new TypeError("workload repetition count is outside the Phase 2h bound");
	const vertices = graph();
	const orderedHashes = topologicalOrder(vertices, ANCHOR_HASH);
	const accumulator = new CompactMerkleAccumulator();
	for (let repetition = 0; repetition < repetitionCount; repetition++)
		for (const hash of orderedHashes) accumulator.append(encodeCanonical(vertices.get(hash)));
	return {
		count: orderedHashes.length * repetitionCount,
		orderLength: orderedHashes.length * repetitionCount,
		root: hex(accumulator.root()),
	};
}

async function waitForObserverDelivery(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 100));
}

export async function proveLongTaskObserver(): Promise<number> {
	if (!PerformanceObserver.supportedEntryTypes.includes("longtask")) throw new Error("longtask observer unsupported");
	const durations: number[] = [];
	const observer = new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) durations.push(entry.duration);
	});
	observer.observe({ type: "longtask" });
	try {
		await new Promise<void>((resolve) => setTimeout(resolve));
		const deadline = performance.now() + 200;
		while (performance.now() < deadline) {
			// Deliberate causal positive control.
		}
		await waitForObserverDelivery();
	} finally {
		observer.disconnect();
	}
	const maximum = Math.max(0, ...durations);
	if (maximum < 150) throw new Error(`longtask positive control was ${maximum}ms`);
	return maximum;
}

function workerUrl(source: string): string {
	return URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
}

function workloadTask(accepts: readonly string[]): string {
	const semantic = accepts.find((task) => /compact|operation|workload/u.test(task));
	const selected = semantic ?? accepts[0];
	if (selected === undefined) throw new Error("worker advertised no workload task");
	return selected;
}

async function exchange(
	source: string,
	measure: boolean,
	pageExecutionMutant = false
): Promise<{ maxLongTaskMs: number; summary: WorkloadSummary }> {
	const url = workerUrl(source);
	const worker = new Worker(url, { type: "module" });
	const longTasks: number[] = [];
	const observer = new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) longTasks.push(entry.duration);
	});
	let pageCounter = pageExecutionMutant ? TOTAL_VERTICES : 0;
	try {
		const summary = await new Promise<WorkloadSummary>((resolve, reject) => {
			let chunks = 0;
			let bytes = 0;
			let payload: Uint8Array | undefined;
			worker.onerror = (event): void => reject(new Error(`module worker failed: ${event.message}`));
			worker.onmessage = (event: MessageEvent<unknown>): void => {
				const message = event.data as Record<string, unknown>;
				if (message.protocol !== PROTOCOL || message.version !== VERSION) {
					reject(new Error("worker protocol/version mismatch"));
					return;
				}
				if (message.kind === "ready") {
					if (!Array.isArray(message.accepts) || message.accepts.some((task) => typeof task !== "string")) {
						reject(new Error("worker ready accepts malformed"));
						return;
					}
					if (measure) observer.observe({ type: "longtask" });
					worker.postMessage({
						protocol: PROTOCOL,
						version: VERSION,
						kind: "request",
						id: "0000000000000001",
						task: workloadTask(message.accepts as string[]),
						payload: new Uint8Array(),
					});
				} else if (message.kind === "chunk") {
					chunks++;
					payload = message.payload as Uint8Array;
					bytes += payload.byteLength;
				} else if (message.kind === "done") {
					if (chunks !== 1 || message.chunks !== 1 || message.bytes !== bytes || payload === undefined) {
						reject(new Error("workload must emit exactly one bounded summary"));
						return;
					}
					const decoded = JSON.parse(new TextDecoder().decode(payload)) as WorkloadSummary;
					resolve({
						...decoded,
						pageCounter,
						pageScope: globalThis instanceof Window ? "Window" : "not-Window",
					});
				} else if (message.kind === "failed" || message.kind === "cancelled") {
					reject(new Error(`worker terminal ${String(message.kind)}:${String(message.code)}`));
				}
			};
		});
		if (measure) await waitForObserverDelivery();
		return { maxLongTaskMs: Math.max(0, ...longTasks), summary };
	} finally {
		observer.disconnect();
		worker.terminate();
		URL.revokeObjectURL(url);
		pageCounter = 0;
	}
}

export async function runCausalWorker(source: string, pageExecutionMutant = false): Promise<WorkloadSummary> {
	return (await exchange(source, false, pageExecutionMutant)).summary;
}

export async function runMeasuredWorkload(source: string): Promise<MeasuredWorkload> {
	const longTaskControlMs = await proveLongTaskObserver();
	const oracle = computeMainThreadOracle();
	const { maxLongTaskMs, summary } = await exchange(source, true);
	return { longTaskControlMs, maxLongTaskMs, oracle, summary };
}
