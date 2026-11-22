import { observeNativeReads } from "./read-observer.js";
import type { NativeMutations, NativeOwners, SetupReport } from "./types.js";
import { completionControl } from "../cold-discovery-probes/completion-control.js";

export const identityModes = ["open-observed", "open-unobserved", "legacy-observed", "legacy-unobserved"] as const;
export type IdentityMode = (typeof identityModes)[number];

/**
 * Direct receipt diagnostic with unchanged native quarantine and port identities.
 * @param setup - Persisted fixture identity and oracle.
 * @param mode - Native completion case and observation setting.
 * @param owners - Reopened native storage owners.
 * @param mutations - Existing diagnostic mutation owner.
 * @returns Original completion report and distinct native invocation count.
 */
export async function identityControl(
	setup: SetupReport,
	mode: IdentityMode,
	owners: NativeOwners,
	mutations: NativeMutations
): Promise<Record<string, unknown>> {
	let nativeReadInvocations = 0;
	const observed = mode.endsWith("-observed");
	const action = (): Promise<Record<string, unknown>> =>
		completionControl(setup, mode.startsWith("legacy") ? "legacy-native" : "open-native", owners, mutations);
	const report = observed
		? await observeNativeReads(() => {
				nativeReadInvocations += 1;
			}, action)
		: await action();
	if (observed && nativeReadInvocations === 0) throw Error("NATIVE_IDENTITY_READS_NOT_OBSERVED");
	if (report.quarantineIdentityPreserved !== true) throw Error("NATIVE_IDENTITY_CHANGED");
	return { ...report, mode, nativeReadInvocations, observed };
}
