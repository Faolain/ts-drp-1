import { nodePort } from "./node-port.js";
import type { RoleBootstrap, RoleFault } from "./role-assertions.js";
import { recoverRoles } from "./role-recovery.js";
import { nodeOwners } from "../cold-discovery/node-owners.js";
const [text, fault] = process.argv.slice(2);
if (!text || !fault) throw Error("ROLE_RECOVERY_ARGUMENTS");
const b = JSON.parse(text) as RoleBootstrap,
	owners = nodeOwners(b.identity);
try {
	console.log(
		JSON.stringify({
			pid: process.pid,
			...(await recoverRoles(b, fault as RoleFault, owners, nodePort(b.identity))),
			ownersJoined: true,
		})
	);
} finally {
	await owners.close();
}
