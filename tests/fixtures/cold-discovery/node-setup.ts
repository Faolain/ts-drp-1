import "fake-indexeddb/auto";
import { nodeOwners } from "./node-owners.js";
import { setup } from "./setup.js";

const identity = process.argv[2];
const epochs = Number(process.argv[3]);
if (identity === undefined || (epochs !== 1 && epochs !== 2)) throw new Error("SETUP_ARGUMENTS");
const owners = nodeOwners(identity);
try {
	const report = await setup(identity, epochs, owners);
	await owners.close();
	console.log(JSON.stringify({ kind: "SETUP_COMPLETE", pid: process.pid, report }));
} catch (error) {
	await owners.close();
	throw error;
}
