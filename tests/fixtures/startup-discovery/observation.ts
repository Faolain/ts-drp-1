export const trace: Record<string, unknown>[] = [];
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
	trace.push({ site, ...(value === undefined ? {} : { value: structuredClone(value) }) });
}
