/* eslint-disable jsdoc/require-jsdoc -- Insertion-only test instrumentation, source archives own exact changes. */
export const events: { name: string; epoch?: number; index?: number }[] = [];
export let effect: ((name: string, epoch?: number) => void) | undefined;
export function event(name: string, epoch?: number, index?: number): void {
	events.push({ name, epoch, index });
	effect?.(name, epoch);
}
export function reset(): void {
	events.length = 0;
	effect = undefined;
}
export function arm(callback: typeof effect): void {
	effect = callback;
}
