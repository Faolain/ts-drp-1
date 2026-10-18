/**
 * Attempt every registered close, preserving a primary failure.
 * @param closers - Explicit fixture-owned input for this isolated control.
 * @param primary - Explicit fixture-owned input for this isolated control.
 * @param primary.error - Explicit fixture-owned input for this isolated control.
 */
export async function closeAll(closers: Array<() => Promise<void>>, primary?: { error: unknown }): Promise<void> {
	const settled = await Promise.allSettled(closers.map((close) => Promise.resolve().then(close)));
	const failures = settled.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
	if (primary !== undefined) {
		if (failures.length !== 0) {
			try {
				if (!(primary.error instanceof Error)) throw new Error("PRIMARY_NOT_ATTACHABLE");
				Object.defineProperty(primary.error, "cleanupFailures", { value: failures });
			} catch {
				throw new AggregateError([primary.error, ...failures], "PENDING_PRIMARY_AND_CLEANUP_FAILED", {
					cause: primary.error,
				});
			}
		}
		throw primary.error;
	}
	if (failures.length !== 0) throw new AggregateError(failures, "PENDING_CLEANUP_FAILED");
}
/**
 * Run one owner lifecycle, settling close before returning and retaining a primary failure.
 * @param owner - Native owner registry acquired by the entry.
 * @param owner.close - Settled native registry close.
 * @param action - Scoped action, with no close ownership of its own.
 * @returns The unchanged action result after owner close settles.
 */
export async function withNativeOwner<T>(owner: { close(): Promise<void> }, action: () => Promise<T>): Promise<T> {
	let primary: { error: unknown } | undefined;
	try {
		return await action();
	} catch (error) {
		primary = { error };
		throw error;
	} finally {
		await closeAll([(): Promise<void> => owner.close()], primary);
	}
}
