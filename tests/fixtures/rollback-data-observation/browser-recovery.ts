import { browserPort } from "./browser-port.js";
import { recover } from "./recovery.js";
import type { Bootstrap, Fault } from "./types.js";
import { browserOwners } from "../cold-discovery/browser-owners.js";
const realm = Math.random();
Object.assign(globalThis, {
	rollbackRecover: async (b: Bootstrap, fault: Fault) => {
		const owners = await browserOwners(b.identity);
		try {
			return { realm, ...(await recover(b, fault, owners, browserPort(b.identity))) };
		} finally {
			await owners.close();
		}
	},
});
