import { environment } from "./node-owner.js";
import { type RoleCase, roleRun, roleSetup } from "./role-contract.js";

const [mode, filename, name] = process.argv.slice(2);
if (!filename || !name) throw new Error("exact child location/case required");
try {
	const env = environment(filename);
	console.log(
		JSON.stringify(
			mode === "setup"
				? { pid: process.pid, setup: await roleSetup(name as RoleCase, env) }
				: { pid: process.pid, result: await roleRun(name as RoleCase, env) }
		)
	);
} catch (error) {
	console.log(JSON.stringify({ pid: process.pid, setupFailure: error instanceof Error ? error.stack : String(error) }));
	process.exitCode = 1;
}
