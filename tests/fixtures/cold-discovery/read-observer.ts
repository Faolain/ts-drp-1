export type NativeReadBackend = "node" | "browser";

/** An observation fault is a harness failure, never a cold-recovery result. */
export class NativeReadObservationError extends Error {
	readonly productionResult: unknown;
	/**
	 * Preserve a completed production result separately from the harness failure.
	 * @param message - Observation failure classification.
	 * @param productionResult - Original result, if production fulfilled.
	 */
	constructor(message: string, productionResult?: unknown) {
		super(message);
		this.name = "NativeReadObservationError";
		this.productionResult = productionResult;
	}
}

/**
 * Own one realm-local observation lifetime without changing native objects.
 * @returns Independent registry used by the runtime and observer controls.
 */
export function createNativeReadObserver(): {
	register(backend: NativeReadBackend): void;
	read(backend: NativeReadBackend): void;
	observe<T>(onRead: () => void, action: () => Promise<T>): Promise<T>;
} {
	const registrations: NativeReadBackend[] = [];
	let active: { backend: NativeReadBackend; onRead(): void; faults: number } | undefined;
	return {
		register(backend): void {
			if (active !== undefined) active.faults += 1;
			registrations.push(backend);
		},
		read(backend): void {
			// The injected call cannot throw into native read/receipt behavior.
			try {
				if (active === undefined) return;
				if (backend !== active.backend) {
					active.faults += 1;
					return;
				}
				try {
					active.onRead();
				} catch {
					active.faults += 1;
				}
			} catch {
				// No observer exception may escape the native method.
			}
		},
		async observe<T>(onRead: () => void, action: () => Promise<T>): Promise<T> {
			if (active !== undefined) throw new NativeReadObservationError("NATIVE_READ_OBSERVER_ALREADY_ACTIVE");
			if (registrations.length !== 1)
				throw new NativeReadObservationError(`NATIVE_READ_HOOK_COUNT:${registrations.length}`);
			const session = { backend: registrations[0] as NativeReadBackend, onRead, faults: 0 };
			active = session;
			let outcome: { ok: true; value: T } | { ok: false; error: unknown };
			try {
				outcome = { ok: true, value: await action() };
			} catch (error) {
				outcome = { ok: false, error };
			} finally {
				active = undefined;
			}
			if (!outcome.ok) {
				if (session.faults !== 0) {
					// Preserve even a non-Error or nonextensible original thrown value.
					try {
						console.error(`NATIVE_READ_OBSERVER_FAULTS_WITH_PRIMARY_FAILURE:${session.faults}`);
					} catch {
						// Diagnostic reporting must not replace the primary thrown value.
					}
				}
				throw outcome.error;
			}
			if (session.faults !== 0)
				throw new NativeReadObservationError(`NATIVE_READ_OBSERVER_FAULTS:${session.faults}`, outcome.value);
			return outcome.value;
		},
	};
}

const observer = createNativeReadObserver();
export const registerNativeReadSite = observer.register;
export const nativePortRead = observer.read;
export const observeNativeReads = observer.observe;
