import { browserOwners } from "./browser-owners.js";
import { setup } from "./setup.js";

/** Setup capability is exported only in the page that will be destroyed. */
Object.assign(globalThis, {
	coldSetup: async (identity: string, epochs: 1 | 2) => {
		const owners = await browserOwners(identity);
		try {
			return await setup(identity, epochs, owners);
		} finally {
			await owners.close();
		}
	},
});
