import { type Case, run as runCase } from "./common.js";
import type { Observer } from "./observe.js";
import { nodeEnvironment } from "../snapshot-declaration-native-provenance/node-owner.js";

/**
 * Execute genuine source-owner SQLite discovery using frozen native helpers.
 * @param filename - Isolated native database path.
 * @param observer - Native observe-only controller.
 * @param name - Deterministic category.
 * @returns Direct protocol and native observations.
 */
export function run(filename: string, observer: Observer, name: Case): ReturnType<typeof runCase> {
	return runCase(nodeEnvironment(filename), observer, name);
}
