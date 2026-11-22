import { browserSetupOwners } from "./browser-setup-owners.js";
import { withNativeOwner } from "./cleanup.js";
import { setup } from "./setup.js";
import type { RecoveryCase } from "./types.js";
Object.assign(globalThis, {
	pendingSetup: async (identity: string, epochs: 1 | 2, published: boolean, mode: RecoveryCase) => {
		const owners = await browserSetupOwners(identity);
		return withNativeOwner(owners, () => setup(identity, epochs, owners, published, mode));
	},
});
