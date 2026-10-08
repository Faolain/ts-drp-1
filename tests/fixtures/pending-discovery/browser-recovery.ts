import { validateBootstrap } from "./bootstrap.js";
import { browserAuthMutation } from "./browser-auth-mutations.js";
import { browserMutations } from "./browser-mutations.js";
import { browserOwners } from "./browser-owners.js";
import { withNativeOwner } from "./cleanup.js";
import { recover } from "./recovery.js";
import type { RecoveryCase } from "./types.js";
Object.assign(globalThis, {
	pendingRecover: async (value: unknown, mode: RecoveryCase) => {
		const bootstrap = validateBootstrap(value),
			owners = await browserOwners(bootstrap.identity);
		return withNativeOwner(owners, async () => {
			const mutation = await browserAuthMutation(bootstrap.identity, bootstrap, mode);
			const report = await recover(bootstrap, mode, owners, browserMutations(bootstrap.identity));
			report.effects.mutations += mutation;
			return report;
		});
	},
});
