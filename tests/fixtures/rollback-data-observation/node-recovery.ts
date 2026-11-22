import { nodePort } from "./node-port.js";
import { recover } from "./recovery.js";
import type { Bootstrap, Fault } from "./types.js";
import { nodeOwners } from "../cold-discovery/node-owners.js";
const [bootstrapText, faultText] = process.argv.slice(2);
if (!bootstrapText || !faultText) throw new Error("RECOVERY_ARGUMENTS");
const bootstrap = JSON.parse(bootstrapText) as Bootstrap,
	owners = nodeOwners(bootstrap.identity);
try {
	const value = await recover(bootstrap, faultText as Fault, owners, nodePort(bootstrap.identity));
	console.log(JSON.stringify({ pid: process.pid, ...value }));
} finally {
	await owners.close();
}
