import { type BlueprintFoldWorkloadSummary, runBlueprintFoldWorkload } from "./blueprint-fold-workload.js";
import { createWorkerHost } from "../../../../worker-host/src/host.js";

export interface MeasuredBlueprintFold {
	readonly longTaskControlMs: number;
	readonly maxLongTaskMs: number;
	readonly oracle: BlueprintFoldWorkloadSummary;
	readonly worker: BlueprintFoldWorkloadSummary & Readonly<{ readonly workerScope: string }>;
}

function workerUrl(source: string): string {
	return URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
}

async function observerDelivery(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 100));
}

/**
 *
 */
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
		await observerDelivery();
	} finally {
		observer.disconnect();
	}
	const maximum = Math.max(0, ...durations);
	if (maximum < 150) throw new Error(`longtask positive control was ${maximum}ms`);
	return maximum;
}

async function runWorker(
	source: string,
	measure: boolean
): Promise<Readonly<{ maxLongTaskMs: number; summary: MeasuredBlueprintFold["worker"] }>> {
	const url = workerUrl(source);
	const endpoint = new Worker(url, { type: "module" });
	const host = createWorkerHost({ endpoint, maxResultBytesPerRequest: 65_536, readyTimeoutMs: 5_000 });
	const durations: number[] = [];
	const observer = new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) durations.push(entry.duration);
	});
	try {
		if (measure) observer.observe({ type: "longtask" });
		const chunks: Uint8Array[] = [];
		for await (const chunk of host.submit("blueprint-fold-4096", new Uint8Array())) chunks.push(chunk);
		if (chunks.length !== 1) throw new Error("blueprint fold worker emitted an invalid summary");
		if (measure) await observerDelivery();
		return Object.freeze({
			maxLongTaskMs: Math.max(0, ...durations),
			summary: JSON.parse(new TextDecoder().decode(chunks[0])) as MeasuredBlueprintFold["worker"],
		});
	} finally {
		observer.disconnect();
		host.close();
		URL.revokeObjectURL(url);
	}
}

/**
 *
 * @param source
 */
export async function runBlueprintFoldWorker(source: string): Promise<MeasuredBlueprintFold> {
	const oracle = await runBlueprintFoldWorkload();
	const longTaskControlMs = await proveLongTaskObserver();
	const measured = await runWorker(source, true);
	return Object.freeze({ longTaskControlMs, maxLongTaskMs: measured.maxLongTaskMs, oracle, worker: measured.summary });
}

/**
 *
 * @param source
 */
export async function runBlueprintFoldWorkerUnmeasured(source: string): Promise<MeasuredBlueprintFold["worker"]> {
	return (await runWorker(source, false)).summary;
}
