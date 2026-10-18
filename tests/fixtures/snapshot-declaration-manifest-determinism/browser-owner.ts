import { type Case, run as runCase } from "./common.js";
import type { Observer } from "./observe.js";
import { browserEnvironment } from "../snapshot-declaration-native-provenance/browser-owner.js";

/**
 * Execute genuine source-owner IndexedDB discovery using frozen native helpers.
 * @param name - Isolated native database name.
 * @param observer - Native observe-only controller.
 * @param selected - Deterministic category.
 * @returns Direct protocol and native observations.
 */
export function run(name: string, observer: Observer, selected: Case): ReturnType<typeof runCase> {
	return runCase(browserEnvironment(name), observer, selected);
}
