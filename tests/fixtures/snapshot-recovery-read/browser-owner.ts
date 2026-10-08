import type { ReadCase } from "./cases.js";
import { type ReadEnvironment, type ReadObservation, run, setup } from "./contract.js";
import type { SnapshotQuarantineDeclaration } from "../../../packages/storage/src/snapshot-transfer.js";
import {
	browserEnvironment,
	observeIDB,
} from "../../../packages/storage-browser/tests/assets/snapshot-declaration-discovery-entry.js";

/** Native requests/results are unchanged; only observe admitted/terminal boundaries. */
function environment(primaryDatabaseName: string): ReadEnvironment {
	const existing = browserEnvironment(primaryDatabaseName);
	const observeReader: ReadEnvironment["observeReader"] = async (action, boundary) => {
		const nativeTransaction = IDBDatabase.prototype.transaction;
		const starts: string[] = [];
		const terminals: string[] = [];
		IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase["transaction"]>): IDBTransaction {
			const transaction = Reflect.apply(nativeTransaction, this, args) as IDBTransaction;
			starts.push(transaction.mode);
			transaction.addEventListener(
				"complete",
				() => {
					terminals.push("complete");
					boundary?.("terminal");
				},
				{ once: true }
			);
			transaction.addEventListener(
				"abort",
				() => {
					terminals.push("abort");
				},
				{ once: true }
			);
			boundary?.("start");
			return transaction;
		};
		try {
			const result = await observeIDB(action);
			return { value: result.value, evidence: { ...result.evidence, starts, terminals } };
		} finally {
			IDBDatabase.prototype.transaction = nativeTransaction;
		}
	};
	return {
		...existing,
		observeReader,
		oversize: async (declaration, byteLength): Promise<void> => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(primaryDatabaseName + "--drp-snapshot-quarantine-v1");
				request.addEventListener("success", () => resolve(request.result), { once: true });
				request.addEventListener("error", () => reject(request.error), { once: true });
			});
			try {
				const transaction = database.transaction(["chunks"], "readwrite");
				const terminal = new Promise<void>((resolve, reject) => {
					transaction.addEventListener("complete", () => resolve(), { once: true });
					transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
				});
				const { objectId, epoch, anchor, manifestDigest } = declaration.scope;
				const store = transaction.objectStore("chunks");
				const request = store.get([objectId, epoch, anchor, manifestDigest, 0]);
				request.addEventListener(
					"success",
					() => {
						if (request.result === undefined) throw new Error("exact owned native chunk absent");
						store.put({ ...(request.result as Record<string, unknown>), exactBytes: new Uint8Array(byteLength) });
					},
					{ once: true }
				);
				await terminal;
			} finally {
				database.close();
			}
		},
		readonlyControl: async (declaration: SnapshotQuarantineDeclaration): Promise<ReadObservation> => {
			const result = await observeReader(async () => {
				const database = await new Promise<IDBDatabase>((resolve, reject) => {
					const request = indexedDB.open(primaryDatabaseName + "--drp-snapshot-quarantine-v1");
					request.addEventListener("success", () => resolve(request.result), { once: true });
					request.addEventListener("error", () => reject(request.error), { once: true });
				});
				try {
					const transaction = database.transaction(["chunks"], "readonly");
					const terminal = new Promise<void>((resolve, reject) => {
						transaction.addEventListener("complete", () => resolve(), { once: true });
						transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
					});
					const { objectId, epoch, anchor, manifestDigest } = declaration.scope;
					const bytes = await new Promise<unknown>((resolve, reject) => {
						const request = transaction.objectStore("chunks").get([objectId, epoch, anchor, manifestDigest, 0]);
						request.addEventListener(
							"success",
							() => resolve((request.result as { exactBytes?: unknown } | undefined)?.exactBytes),
							{ once: true }
						);
						request.addEventListener("error", () => reject(request.error), { once: true });
					});
					await terminal;
					if (!(bytes instanceof Uint8Array)) throw new Error("actual native readonly chunk control absent");
					return bytes;
				} finally {
					database.close();
				}
			});
			return result.evidence;
		},
	};
}

const realm = crypto.randomUUID();
declare global {
	interface Window {
		readerRed: {
			realm: string;
			setup(name: ReadCase, database: string): Promise<unknown>;
			run(name: ReadCase, database: string): ReturnType<typeof run>;
			remove(database: string): Promise<void>;
		};
	}
}
window.readerRed = {
	realm,
	setup: (name, database): Promise<unknown> => setup(name, environment(database)),
	run: (name, database): ReturnType<typeof run> => run(name, environment(database)),
	remove: (database): Promise<void> =>
		new Promise<void>((resolve, reject) => {
			const request = indexedDB.deleteDatabase(database + "--drp-snapshot-quarantine-v1");
			request.addEventListener("success", () => resolve(), { once: true });
			request.addEventListener("error", () => reject(request.error), { once: true });
			request.addEventListener(
				"blocked",
				() => reject(new Error("exact owned reader fixture database remains blocked")),
				{ once: true }
			);
		}),
};
