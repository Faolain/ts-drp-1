export const trace: Record<string, unknown>[] = [];
// Measurement only (endurance heap): with the harness's per-epoch records counted, events are counted here and
// not retained. Unset (the default), every event is retained as before.
const traceCounted = Reflect.get(globalThis, "__r8HarnessRecordsCounted") === true;
export const traceCount = { counted: 0 };
export const control: { publicationFault: boolean; issueAfterSignFault: boolean } = {
	publicationFault: false,
	issueAfterSignFault: false,
};
/**
 * Capture primitives only, without wrapping a product owner, result or promise.
 * @param site
 * @param value
 */
export function event(site: string, value?: unknown): void {
	if (traceCounted) {
		traceCount.counted++;
		return;
	}
	trace.push({ site, ...(value === undefined ? {} : { value: structuredClone(value) }) });
}
