#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createCliProgram } from "./cli/index.js";
import { startConfiguredV3CanvasDaemon } from "./cli/v3-canvas.js";
import type { V3NodeDaemon } from "./rpc/v3-daemon.js";

/**
 * Start only the explicit local configured v3 application. No bare-ID/v1 fallback,
 * environment-selected application, wire-selected path or import-time execution.
 * @param configPath - Local operator's configuration file.
 * @returns Actual configured daemon with its joined close owner.
 */
export async function run(configPath: string): Promise<V3NodeDaemon> {
	if (typeof configPath !== "string" || configPath.length === 0) throw new TypeError("V3_CLI_CONFIG_REQUIRED");
	const config: unknown = JSON.parse(readFileSync(resolve(configPath), "utf8"));
	return startConfiguredV3CanvasDaemon(config);
}

/**
 * Executable entry with one shutdown owner; let joined close finish naturally
 * instead of exiting while admitted native work still owns storage or signing.
 * @param argv - Original process arguments or a local caller's exact arguments.
 * @returns Running daemon; explicit close also removes this entry's signal listeners.
 */
export async function main(argv: readonly string[] = process.argv): Promise<V3NodeDaemon> {
	const parser = createCliProgram();
	parser.parse([...argv]);
	const options = parser.opts<{ config: string }>();
	const daemon = await run(options.config);
	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => {
		process.removeListener("SIGINT", signal);
		process.removeListener("SIGTERM", signal);
		return (closing ??= daemon.close());
	};
	const signal = (): void => {
		void close().catch((error: unknown) => {
			console.error("Failed to close v3 daemon:", error);
			process.exitCode = 1;
		});
	};
	process.once("SIGINT", signal);
	process.once("SIGTERM", signal);
	console.log(`V3 Canvas receive-only RPC listening on 127.0.0.1:${daemon.port}`);
	return Object.freeze({ node: daemon.node, port: daemon.port, close });
}

const entry = process.argv[1];
if (entry !== undefined && existsSync(entry) && realpathSync(entry) === fileURLToPath(import.meta.url)) {
	void main().catch((error: unknown) => {
		console.error("Failed to start v3 daemon:", error);
		process.exitCode = 1;
	});
}
