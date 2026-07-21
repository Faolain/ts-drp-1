import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { PeerCacheStore, StoredPeerRecord } from "./peer-cache.js";

export interface FsPeerCacheStoreOptions {
	readonly path: string;
}

/** Node-only JSON persistence adapter with same-directory atomic replacement. */
export class FsPeerCacheStore implements PeerCacheStore {
	readonly #path: string;

	constructor(options: FsPeerCacheStoreOptions) {
		if (typeof options.path !== "string" || options.path.length === 0) {
			throw new Error("peer cache fs path must be non-empty");
		}
		this.#path = options.path;
	}

	async load(): Promise<readonly StoredPeerRecord[]> {
		let serialized: string;
		try {
			serialized = await readFile(this.#path, "utf8");
		} catch (error) {
			if (isMissingFile(error)) return [];
			throw error;
		}
		try {
			const parsed: unknown = JSON.parse(serialized);
			return Array.isArray(parsed) ? (parsed as readonly StoredPeerRecord[]) : [];
		} catch {
			return [];
		}
	}

	async save(records: readonly StoredPeerRecord[]): Promise<void> {
		const directory = dirname(this.#path);
		await mkdir(directory, { recursive: true });
		const temporaryPath = `${this.#path}.${globalThis.crypto.randomUUID()}.tmp`;
		try {
			await writeFile(temporaryPath, JSON.stringify(records), { encoding: "utf8", mode: 0o600 });
			await rename(temporaryPath, this.#path);
		} catch (error) {
			await rm(temporaryPath, { force: true }).catch(() => undefined);
			throw error;
		}
	}
}

function isMissingFile(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
