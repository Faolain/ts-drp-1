import { type NativeEnvironment, runNativeData, runNativeFault } from "./common.js";
import type { NativeHooks } from "./hooks.js";
import { createBrowserSnapshotQuarantineStore } from "../../../packages/storage-browser/src/snapshot-transfer.js";

/**
 * Await one genuine IndexedDB request.
 * @param value - Native request.
 * @returns Native result.
 */
function request<T>(value: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		value.addEventListener("success", () => resolve(value.result), { once: true });
		value.addEventListener("error", () => reject(value.error), { once: true });
	});
}

/**
 * Actual IndexedDB owner and direct durable metadata access.
 * @param primaryDatabaseName - Isolated native database identity.
 * @returns Genuine native environment.
 */
export function browserEnvironment(primaryDatabaseName: string): NativeEnvironment {
	const use = async <T>(
		stores: string[],
		mode: IDBTransactionMode,
		action: (tx: IDBTransaction) => Promise<T>
	): Promise<T> => {
		const db = await request(indexedDB.open(primaryDatabaseName + "--drp-snapshot-quarantine-v1"));
		try {
			const tx = db.transaction(stores, mode);
			const terminal = new Promise<void>((resolve, reject) => {
				tx.addEventListener("complete", () => resolve(), { once: true });
				tx.addEventListener("abort", () => reject(tx.error ?? new Error("native transaction abort")), { once: true });
			});
			const value = await action(tx);
			await terminal;
			return value;
		} finally {
			db.close();
		}
	};
	return {
		backend: "indexeddb",
		identity: primaryDatabaseName,
		open: () => createBrowserSnapshotQuarantineStore({ primaryDatabaseName }),
		image: () =>
			use(["owner", "scopes", "chunks"], "readonly", async (tx) => ({
				version: tx.db.version,
				stores: [...tx.db.objectStoreNames],
				owner: await request(tx.objectStore("owner").getAll()),
				scopes: await request(tx.objectStore("scopes").getAll()),
				chunks: await request(tx.objectStore("chunks").getAll()),
			})),
		row: (key) =>
			use(["scopes"], "readonly", async (tx) => {
				const value = (await request(
					tx.objectStore("scopes").get([key.objectId, key.epoch, key.anchor, key.manifestDigest])
				)) as Record<string, unknown> | undefined;
				if (value === undefined) throw new Error("native exact row absent");
				return value;
			}),
		put: (row) =>
			use(["scopes"], "readwrite", async (tx) => {
				await request(tx.objectStore("scopes").put(row));
			}),
	};
}

/**
 * Execute one actual IndexedDB discovery processing case.
 * @param name - Isolated database identity.
 * @param hooks - Pre-import processing controller.
 * @param mode - Fault, historical retention or deterministic data case.
 * @returns Native outcome evidence.
 */
export function run(name: string, hooks: NativeHooks, mode = "fault"): Promise<unknown> {
	const env = browserEnvironment(name);
	return mode.startsWith("data:")
		? runNativeData(env, hooks, mode.slice(5))
		: runNativeFault(env, hooks, mode === "historical");
}
