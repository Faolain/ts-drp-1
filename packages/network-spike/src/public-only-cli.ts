#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import {
	createBlockedPublicOnlyReport,
	preflightPublicOnly,
	sanitizePublicOnlyPreflight,
} from "./public-only/index.js";

void main();

async function main(): Promise<void> {
	const arguments_ = process.argv.slice(2);
	const configPath = optionValue(arguments_, "--config");
	const acknowledgement = optionValue(arguments_, "--acknowledge");
	if (arguments_.includes("--execute")) {
		process.stderr.write("public-only execution is not implemented; no public request was made\n");
		process.exitCode = 2;
		return;
	}
	if (configPath === undefined) {
		process.stdout.write(`${JSON.stringify(createBlockedPublicOnlyReport(), null, 2)}\n`);
		process.exitCode = 2;
		return;
	}
	const input = JSON.parse(await readFile(configPath, "utf8")) as unknown;
	const preflight = preflightPublicOnly(input, acknowledgement);
	process.stdout.write(`${JSON.stringify(sanitizePublicOnlyPreflight(preflight), null, 2)}\n`);
	process.exitCode = preflight.authorized ? 0 : 2;
}

function optionValue(arguments_: string[], option: string): string | undefined {
	const index = arguments_.indexOf(option);
	return index === -1 ? undefined : arguments_[index + 1];
}
