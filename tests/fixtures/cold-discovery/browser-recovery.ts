import { browserMutations } from "./browser-mutations.js";
import { browserOwners } from "./browser-owners.js";
import { recover, validateBootstrap } from "./recovery.js";
import type { RecoveryCase } from "./types.js";

/** This page imports no producer setup fixture and receives only trusted carriers. */
Object.assign(globalThis, {
	coldRecover: async (value: unknown, mode: RecoveryCase) => {
		const bootstrap = validateBootstrap(value);
		const owners = await browserOwners(bootstrap.identity);
		try {
			return await recover(bootstrap, mode, owners, browserMutations(bootstrap.identity));
		} finally {
			await owners.close();
		}
	},
});
