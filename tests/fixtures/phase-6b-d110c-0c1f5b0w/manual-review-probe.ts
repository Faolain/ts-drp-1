/** A bounded scheduling probe, never a wall-clock timeout or a product resolver. */
export async function microtaskTurns(): Promise<void> {
	for (let turn = 0; turn < 256; turn += 1) await Promise.resolve();
}

/**
 * Observe rejection without leaving a rejected promise unowned during shutdown.
 * @param promise - The genuine public operation being observed.
 * @returns A read-only snapshot of settlement and its exact rejection.
 */
export function observeResult(promise: Promise<unknown>): {
	result(): { readonly error?: unknown; readonly settled: boolean };
} {
	let settled = false;
	let error: unknown;
	void promise.then(
		() => {
			settled = true;
		},
		(reason: unknown) => {
			error = reason;
			settled = true;
		}
	);
	return { result: () => ({ error, settled }) };
}
