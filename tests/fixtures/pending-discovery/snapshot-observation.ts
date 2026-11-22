import { trace } from "./observer.js";
import type { Effects, NativeMutations, OwnerCase, RecoveryCase, RecoveryOwners } from "./types.js";
import type { SnapshotQuarantineDeclaration } from "../../../packages/storage/dist/src/snapshot-transfer.js";
/**
 * The native quarantine and ports are returned unchanged. Only owner-bound fault seams are decorated.
 * @param owner - Explicit fixture-owned input for this isolated control.
 * @param effects - Explicit fixture-owned input for this isolated control.
 * @param mode - Explicit fixture-owned input for this isolated control.
 * @param mutations - Explicit fixture-owned input for this isolated control.
 * @returns Original production values or isolated fixture evidence.
 */
export function observedSnapshot(
	owner: RecoveryOwners["snapshot"],
	effects: Effects,
	mode: RecoveryCase,
	mutations: NativeMutations
): RecoveryOwners["snapshot"] {
	return new Proxy({} as typeof owner, {
		get(_target, key): unknown {
			const target = owner;
			if (key === "lookupRecoveryDeclaration") {
				effects.accesses++;
				trace({ site: "lookup-property-access" });
				if (mode === "narrow-store") return undefined;
				return (...args: Parameters<typeof owner.lookupRecoveryDeclaration>) => {
					effects.lookups++;
					trace({ site: "lookup", scope: { ...args[0] } });
					if (mode === "lookup-rejected") {
						trace({ site: "intentional-lookup-rejection" });
						return Promise.reject(new Error("INTENTIONAL_LOOKUP_REJECTION"));
					}
					const pending = target.lookupRecoveryDeclaration(...args);
					// Only explicit fault/race schedules may delay or reject the native observation.
					if (
						[
							"mixed-unavailable",
							"divergent-mixed-unavailable",
							"delete-after-lookup",
							"replace-after-lookup",
							"identical-replacement",
						].includes(mode)
					) {
						const first = effects.lookups === 1;
						return pending.then(async (found) => {
							if (["mixed-unavailable", "divergent-mixed-unavailable"].includes(mode) && first) {
								trace({
									site: "intentional-first-lookup-rejection",
									ok: found.kind === "present" && found.state === "verified",
								});
								throw new Error("INTENTIONAL_CANDIDATE_LOOKUP_REJECTION");
							}
							const applied = await mutations.after(mode as OwnerCase, args[0]);
							effects.mutations += applied;
							if (applied !== 0) trace({ site: "lookup-race-applied", ok: applied === 1, scope: { ...args[0] } });
							return found;
						});
					}
					return pending;
				};
			}
			if (key === "openScope")
				return (declaration: SnapshotQuarantineDeclaration) => {
					effects.acquisitions++;
					trace({ site: "acquire", scope: { ...declaration.scope } });
					const pending = target.openScope(declaration);
					if (mode === "expiry-after-acquisition")
						return pending.then(async (opened) => {
							const applied = await mutations.after(mode, declaration.scope);
							effects.mutations += applied;
							trace({ site: "acquisition-race-applied", ok: applied === 1, scope: { ...declaration.scope } });
							return opened;
						});
					return pending;
				};
			return Reflect.get(target, key, target);
		},
	});
}
