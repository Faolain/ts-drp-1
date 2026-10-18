import { authProbe } from "./auth-probe.js";
import { browserAuthMutation } from "./browser-auth-mutations.js";
import { browserMutations } from "./browser-mutations.js";
import { browserOwners } from "./browser-owners.js";
import { withNativeOwner } from "./cleanup.js";
import type { ProbeInput, RecoveryCase } from "./types.js";
Object.assign(globalThis, {
	pendingAuthProbe: async (input: ProbeInput, mode: RecoveryCase) => {
		const owners = await browserOwners(input.bootstrap.identity);
		return withNativeOwner(owners, async () => {
			const mutation = await browserAuthMutation(input.bootstrap.identity, input.bootstrap, mode);
			const report = await authProbe(input, mode, owners, browserMutations(input.bootstrap.identity));
			report.effects.mutations += mutation;
			return report;
		});
	},
});
