#!/usr/bin/env node

import { runBlueprintCli } from "../src/index.js";

try {
	await runBlueprintCli(process.argv.slice(2));
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`drp-blueprint: ${message}\n`);
	process.exitCode = 1;
}
