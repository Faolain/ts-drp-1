import { browserPort } from "./browser-port.js";
import type { RoleBootstrap, RoleFault } from "./role-assertions.js";
import { recoverRoles } from "./role-recovery.js";
import { browserOwners } from "../cold-discovery/browser-owners.js";
const realm = Math.random();
Object.assign(globalThis, {
	roleRecover: async (b: RoleBootstrap, fault: RoleFault) => {
		const owners = await browserOwners(b.identity);
		try {
			return { realm, ...(await recoverRoles(b, fault, owners, browserPort(b.identity))), ownersJoined: true };
		} finally {
			await owners.close();
		}
	},
});
