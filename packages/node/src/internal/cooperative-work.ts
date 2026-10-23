/**
 * Give timers and transport callbacks a host task. Awaiting an already resolved
 * native promise only advances the microtask queue and does not do this.
 * Callers keep their existing ownership and must recheck currency after yielding.
 * @returns Completion of the scheduling boundary.
 */
export function yieldToHost(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A scheduling budget for one sequential read/preparation walk, not an authority
 * or a bound on an individual native operation. No work or custody is detached.
 * @returns A checkpoint that yields once its local scheduling budget expires.
 */
export function createWorkCheckpoint(): () => Promise<void> | undefined {
	let deadline = performance.now() + 8;
	return (): Promise<void> | undefined => {
		if (performance.now() < deadline) return undefined;
		return yieldToHost().then(() => {
			deadline = performance.now() + 8;
		});
	};
}
