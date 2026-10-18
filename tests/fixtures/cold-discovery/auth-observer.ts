export type AuthModule = "cold" | "successor";
export type AuthSite = "cold-genesis" | "cold-successor" | "cold-checkpoint" | "successor-qc" | "successor-cut-binding";
export interface AuthEvent {
	site: AuthSite;
	ok?: boolean;
	reason?: string;
	matches?: boolean;
}
type AuthResult = { ok?: boolean; reason?: string; matches?: boolean };

/** Observation faults cannot become production authentication failures. */
export class AuthObservationError extends Error {
	readonly productionResult: unknown;
	/**
	 * Preserve the original fulfilled result for harness diagnostics.
	 * @param message - Observation failure, not a product failure.
	 * @param productionResult - The exact result returned by production.
	 */
	constructor(message: string, productionResult?: unknown) {
		super(message);
		this.name = "AuthObservationError";
		this.productionResult = productionResult;
	}
}

/**
 * Own a bounded realm-local observation session without wrapping trust capabilities.
 * @returns Independent registry for the runtime and noninterference controls.
 */
export function createAuthObserver(): {
	register(module: AuthModule): void;
	event(site: AuthSite, result: AuthResult): void;
	observe<T>(onEvent: (event: AuthEvent) => void, action: () => Promise<T>): Promise<T>;
} {
	const registrations: AuthModule[] = [];
	let active: { onEvent(event: AuthEvent): void; faults: number; count: number } | undefined;
	return {
		register(module): void {
			if (active !== undefined) active.faults++;
			registrations.push(module);
		},
		event(site, result): void {
			try {
				if (active === undefined) return;
				if (++active.count > 16) {
					active.faults++;
					return;
				}
				if (
					!["cold-genesis", "cold-successor", "cold-checkpoint", "successor-qc", "successor-cut-binding"].includes(
						site
					) ||
					(site === "successor-cut-binding" ? typeof result.matches !== "boolean" : typeof result.ok !== "boolean")
				) {
					active.faults++;
					return;
				}
				active.onEvent({
					site,
					...(result.ok === undefined ? {} : { ok: result.ok }),
					...(result.reason === undefined ? {} : { reason: result.reason }),
					...(result.matches === undefined ? {} : { matches: result.matches }),
				});
			} catch {
				if (active !== undefined) active.faults++;
			}
		},
		async observe<T>(onEvent: (event: AuthEvent) => void, action: () => Promise<T>): Promise<T> {
			if (active !== undefined) throw new AuthObservationError("AUTH_OBSERVER_ALREADY_ACTIVE");
			if (
				registrations.length !== 2 ||
				registrations.filter((module) => module === "cold").length !== 1 ||
				registrations.filter((module) => module === "successor").length !== 1
			)
				throw new AuthObservationError("AUTH_OBSERVER_HOOKS");
			const session = { onEvent, faults: 0, count: 0 };
			active = session;
			let outcome: { ok: true; value: T } | { ok: false; error: unknown };
			try {
				outcome = { ok: true, value: await action() };
			} catch (error) {
				outcome = { ok: false, error };
			} finally {
				active = undefined;
			}
			if (!outcome.ok) throw outcome.error;
			if (session.faults !== 0) throw new AuthObservationError(`AUTH_OBSERVER_FAULTS:${session.faults}`, outcome.value);
			return outcome.value;
		},
	};
}
const observer = createAuthObserver();
export const registerAuthModule = observer.register;
export const authEvent = observer.event;
export const observeAuthentication = observer.observe;
