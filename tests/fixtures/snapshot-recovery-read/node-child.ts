import { readFileSync } from "node:fs";

import type { ReadCase } from "./cases.js";
import type { run, setup } from "./contract.js";
import type { environment } from "./node-owner.js";

const input = JSON.parse(readFileSync(0, "utf8")) as {
	phase: "setup" | "read";
	name: ReadCase;
	primaryFilename: string;
	bundle: string;
};
const owner = (await import("data:text/javascript;base64," + Buffer.from(input.bundle).toString("base64"))) as {
	environment: typeof environment;
	setup: typeof setup;
	run: typeof run;
};
const env = owner.environment(input.primaryFilename);
const result = input.phase === "setup" ? await owner.setup(input.name, env) : await owner.run(input.name, env);
console.log(JSON.stringify({ pid: process.pid, phase: input.phase, result }));
