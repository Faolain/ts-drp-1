import { Command } from "commander";

import { VERSION } from "./version.js";

/**
 * Build a fresh parser; importing the CLI never starts a host or parses process arguments.
 * @returns Explicit configured v3-only CLI.
 */
export function createCliProgram(): Command {
	return new Command()
		.name("ts-drp-node")
		.version(VERSION)
		.requiredOption("-c, --config <file>", "trusted local v3 Canvas daemon configuration");
}
