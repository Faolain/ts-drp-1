import { HashGraph } from "../../src/hashgraph/index.js";

type PreDriftHashGraphPrototype = HashGraph & {
	enableHistoryCompaction?(): void;
	hasVertex?(hash: string): boolean;
};

/**
 * Temporarily restore the exact no-compaction lookup behavior that existed
 * before the rejected observer prototype called two nonexistent methods.
 * Existing production implementations always win; this fallback is inert once
 * both methods exist.
 * @returns A descriptor-exact restoration callback
 */
export function installObserverPreDriftControl(): () => void {
	const prototype = HashGraph.prototype as PreDriftHashGraphPrototype;
	const enableDescriptor = Object.getOwnPropertyDescriptor(prototype, "enableHistoryCompaction");
	const hasDescriptor = Object.getOwnPropertyDescriptor(prototype, "hasVertex");
	const installedEnable = typeof prototype.enableHistoryCompaction !== "function";
	const installedHas = typeof prototype.hasVertex !== "function";

	if (installedEnable) {
		Object.defineProperty(prototype, "enableHistoryCompaction", {
			configurable: true,
			value: (): void => undefined,
			writable: true,
		});
	}
	if (installedHas) {
		Object.defineProperty(prototype, "hasVertex", {
			configurable: true,
			value(this: HashGraph, hash: string): boolean {
				return this.vertices.has(hash);
			},
			writable: true,
		});
	}

	return (): void => {
		if (installedEnable) {
			if (enableDescriptor === undefined) delete prototype.enableHistoryCompaction;
			else Object.defineProperty(prototype, "enableHistoryCompaction", enableDescriptor);
		}
		if (installedHas) {
			if (hasDescriptor === undefined) delete prototype.hasVertex;
			else Object.defineProperty(prototype, "hasVertex", hasDescriptor);
		}
	};
}
