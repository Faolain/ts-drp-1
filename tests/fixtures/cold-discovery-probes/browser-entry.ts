import { browserOwners } from "../cold-discovery/browser-owners.js";
import { browserMutations } from "../cold-discovery/browser-mutations.js";
import { hex } from "../cold-discovery/application.js";
import type { SetupReport } from "../cold-discovery/types.js";
import { probe, type Mode } from "./common.js";

function request<T>(value: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		value.onsuccess = () => resolve(value.result);
		value.onerror = () => reject(value.error);
	});
}
async function read(name: string, stores: string[]): Promise<Record<string, Record<string, unknown>[]>> {
	const db = await request(indexedDB.open(name));
	try {
		const tx = db.transaction(stores, "readonly");
		const done = new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onabort = () => reject(tx.error);
		});
		const result = Object.fromEntries(
			await Promise.all(stores.map(async (name) => [name, await request(tx.objectStore(name).getAll())]))
		);
		await done;
		return result;
	} finally {
		db.close();
	}
}
Object.assign(globalThis, {
	directStorageProbe: async (setup: SetupReport, mode: Mode) => {
		const identity = setup.bootstrap.identity;
		const owners = await browserOwners(identity);
		try {
			const report = await probe(setup, mode, owners, browserMutations(identity), {
				snapshot: async () => {
					const rows = await read(`${identity}--drp-snapshot-quarantine-v1`, ["scopes", "chunks", "owner"]);
					const scope = setup.oracle.lookupScope;
					const matches = (row: Record<string, unknown>): boolean =>
						row.objectId === scope.objectId &&
						row.epoch === scope.epoch &&
						row.anchor === scope.anchor &&
						row.manifestDigest === scope.manifestDigest;
					return { scopes: rows.scopes!.filter(matches), chunks: rows.chunks!.filter(matches), owner: rows.owner };
				},
				blobs: async () =>
					(await read(`${identity}--ahe`, ["blobs"])).blobs!.map((row) => ({
						digest: String(row.digest),
						bytes: Uint8Array.from(row.bytes as Uint8Array),
					})),
			});
			return JSON.parse(
				JSON.stringify(report, (_key, value) => (value instanceof Uint8Array ? { bytesHex: hex(value) } : value))
			);
		} finally {
			await owners.close();
		}
	},
});
