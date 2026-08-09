/* eslint-disable import/no-unresolved -- the public root is the intentional type-level RED until production lands */
import {
	type BoundedExecutionOptions,
	type BoundedItem,
	type BoundedProcessor,
	executeBounded,
	type WorkerHostErrorCode,
	type WorkerHostMetricName,
	type WorkerHostMetricsSnapshot,
	type WorkerHostTimingName,
	type WorkerHostTimingSnapshot,
} from "@ts-drp/worker-host";

const processor: BoundedProcessor<number, string> = (item: number, index: number, signal: AbortSignal) => {
	const exact: readonly [number, number, AbortSignal] = [item, index, signal];
	return `${exact[0]}:${exact[1]}`;
};
const options: BoundedExecutionOptions = {
	batchSize: 1,
	maxBufferedResults: 1,
	maxItems: 1,
};
const stream: AsyncGenerator<BoundedItem<string>, void, void> = executeBounded([1], processor, options);
const errorCode: WorkerHostErrorCode = "worker-host-item-failed";
const metricName: WorkerHostMetricName = "items-processed";
const timingName: WorkerHostTimingName = "item-duration";
declare const metricsSnapshot: WorkerHostMetricsSnapshot;
declare const timingSnapshot: WorkerHostTimingSnapshot;
void [errorCode, metricName, metricsSnapshot, stream, timingName, timingSnapshot];
