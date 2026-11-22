import { browserMutations } from "./browser-mutations.js";
import { browserOwners } from "./browser-owners.js";
import { identityControl, type IdentityMode } from "./read-identity-control.js";
import type { SetupReport } from "./types.js";

Object.assign(globalThis, {
	directIdentityControl: async (setup: SetupReport, mode: IdentityMode) => {
		const owners = await browserOwners(setup.bootstrap.identity);
		try {
			return await identityControl(setup, mode, owners, browserMutations(setup.bootstrap.identity));
		} finally {
			await owners.close();
		}
	},
});
