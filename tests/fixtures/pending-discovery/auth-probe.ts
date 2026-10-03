import { trace } from "./observer.js";
import { executeRecovery, recoveryInput } from "./recovery.js";
import type { NativeMutations, ProbeInput, RecoveryCase, RecoveryOwners, RecoveryReport } from "./types.js";
/**
 * RED instrumentation diagnostic ONLY: current legacy interface, probe oracle graph, never product bootstrap.
 * @param input - Explicit fixture-owned input for this isolated control.
 * @param mode - Explicit fixture-owned input for this isolated control.
 * @param owners - Explicit fixture-owned input for this isolated control.
 * @param mutations - Explicit fixture-owned input for this isolated control.
 * @returns Original production values or isolated fixture evidence.
 */
export async function authProbe(
	input: ProbeInput,
	mode: RecoveryCase,
	owners: RecoveryOwners,
	mutations: NativeMutations
): Promise<RecoveryReport> {
	let allAvailable: RecoveryReport | undefined;
	if (mode === "divergent-mixed-unavailable") {
		allAvailable = await authProbe(input, "fork", owners, mutations);
		if (allAvailable.classification === "OBSOLETE_DIAGNOSTIC_KEY_REFUSAL") {
			allAvailable.mode = mode;
			return allAvailable;
		}
	}
	const declaration = await owners.snapshot.lookupRecoveryDeclaration(input.scope);
	if (declaration.kind !== "present") throw new Error("AUTH_PROBE_DECLARATION_MISSING");
	const prepared = await recoveryInput(input.bootstrap, mode, owners, mutations);
	prepared.input.snapshotDeclaration = declaration.declaration;
	if (mode === "divergent-mixed-unavailable") {
		const nativeObserved = prepared.input.snapshotStore as RecoveryOwners["snapshot"];
		// Diagnostic-only current-interface fault schedule. The actual shared verifier
		// reaches this before-open boundary; no product bootstrap/graph imports this file.
		prepared.input.snapshotStore = new Proxy(nativeObserved, {
			get(target, key): unknown {
				if (key !== "openScope") return Reflect.get(target, key, target);
				return (carrier: Parameters<typeof target.openScope>[0]) => {
					trace({ site: "diagnostic-before-open" });
					return target.lookupRecoveryDeclaration(carrier.scope).then((found) => {
						if (found.kind !== "present" || found.state !== "verified")
							throw new Error("DIAGNOSTIC_NATIVE_SCOPE_UNAVAILABLE");
						return target.openScope(carrier);
					});
				};
			},
		});
	}
	const report = await executeRecovery(input.bootstrap, mode, owners, prepared);
	if (allAvailable !== undefined) report.allAvailable = allAvailable;
	if (report.result.kind === "malformed-input") report.classification = "OBSOLETE_DIAGNOSTIC_KEY_REFUSAL";
	return report;
}
