import { freshEffects, observe } from "./observer.js";
import { observedSnapshot } from "./snapshot-observation.js";
import type { Effects, NativeMutations, ProbeInput, RecoveryOwners } from "./types.js";
/**
 * Dynamic precondition for the conditional first-lookup rejection, isolated from product authentication.
 * @param input - Probe-only oracle carrier in this separate graph.
 * @param owners - Actual reopened native owners.
 * @param mutations - Bound fixture-owned fault operations.
 * @returns Actual calls and intentional-rejection evidence.
 */
export async function availabilityProbe(
	input: ProbeInput,
	owners: RecoveryOwners,
	mutations: NativeMutations
): Promise<{ effects: Effects; firstRejected: boolean; secondAvailable: boolean }> {
	const effects = freshEffects();
	const snapshot = observedSnapshot(owners.snapshot, effects, "mixed-unavailable", mutations);
	return observe(effects, async () => {
		let firstRejected = false;
		try {
			await snapshot.lookupRecoveryDeclaration(input.scope);
		} catch (error) {
			firstRejected = error instanceof Error && error.message === "INTENTIONAL_CANDIDATE_LOOKUP_REJECTION";
		}
		const second = await snapshot.lookupRecoveryDeclaration(input.scope);
		return { effects, firstRejected, secondAvailable: second.kind === "present" && second.state === "verified" };
	});
}
