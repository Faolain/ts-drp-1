import { type Case, precondition, run, setup } from "./contract.js";
import { environment } from "./node-owner.js";

const [mode, filename, name] = process.argv.slice(2);
if (!filename || !name) throw new Error("child exact identity/case required");
const env = environment(filename);
try {
	if (mode === "setup") {
		await setup(name as Case, env);
		console.log(JSON.stringify({ pid: process.pid, setup: await precondition(name as Case, env) }));
	} else console.log(JSON.stringify({ pid: process.pid, result: await run(name as Case, env) }));
} catch (error) {
	console.log(JSON.stringify({ pid: process.pid, setupFailure: error instanceof Error ? error.stack : String(error) }));
	process.exitCode = 1;
}
