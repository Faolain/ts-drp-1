/** One receiver-observed sample: when its sender sent it and when this receiver received it. */
export interface AgeOfInformationSample {
	readonly receivedAtMs: number;
	readonly sentAtMs: number;
}

/**
 * Age of information at a receiver, sampled every `intervalMs` from `startedAtMs` to `deadlineMs`:
 * at each sample time, how old the freshest sample received so far was when it was sent. The Grid
 * page's fabric workbench reports it for its raw and reliable WebRTC lanes; the browser FPS gate
 * (tests/browser-app-fps.pw.ts) applies the same function to live movement.
 * @param observations - Receiver-observed samples (any order).
 * @param startedAtMs - The first sample time (also the age origin before any delivery).
 * @param deadlineMs - The last sample time (inclusive).
 * @param intervalMs - The sampling interval.
 * @returns One age per sample time, in order.
 */
export function fabricAgeOfInformation(
	observations: readonly AgeOfInformationSample[],
	startedAtMs: number,
	deadlineMs: number,
	intervalMs: number
): readonly number[] {
	const delivered = [...observations].sort((left, right) => left.receivedAtMs - right.receivedAtMs);
	const ages: number[] = [];
	let cursor = 0;
	let freshestSentAt = startedAtMs;
	for (let sampledAt = startedAtMs; sampledAt <= deadlineMs; sampledAt += intervalMs) {
		while (cursor < delivered.length && (delivered[cursor]?.receivedAtMs ?? Number.POSITIVE_INFINITY) <= sampledAt) {
			freshestSentAt = Math.max(freshestSentAt, delivered[cursor]?.sentAtMs ?? freshestSentAt);
			cursor += 1;
		}
		ages.push(sampledAt - freshestSentAt);
	}
	return ages;
}

/**
 * Nearest-rank percentile (0 for no values).
 * @param values - The values.
 * @param quantile - In (0, 1].
 * @returns The value at that rank.
 */
export function fabricPercentile(values: readonly number[], quantile: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.ceil(sorted.length * quantile) - 1] ?? 0;
}
