import { parseStorageObjectId } from "@ts-drp/storage";

import type { KillHit, KillPoint, KillPointId } from "../killpoints.js";

export type WorkerFailureCode =
	| "UNSUPPORTED_CAPABILITY"
	| "INVALID_RUN_MESSAGE"
	| "INVALID_OBJECT_ID"
	| "UNEXPECTED_UPGRADE"
	| "DURABILITY_NOT_STRICT"
	| "PREFLIGHT_MISMATCH"
	| "REQUEST_ERROR"
	| "TRANSACTION_ABORT"
	| "ARM_STATE_ERROR"
	| "MANIFEST_MISMATCH"
	| "DRIVER_NOT_IMPLEMENTED";

export interface InstrumentedTransitionInput {
	readonly armed: KillPoint | null;
	readonly databaseName: string;
	readonly objectId: string;
	readonly signal: SharedArrayBuffer;
	onHit(hit: KillHit): void;
}

export type InstrumentedTransitionResult =
	| {
			readonly kind: "complete";
			readonly observed: readonly KillHit[];
			readonly transactionDurability: "strict";
	  }
	| {
			readonly kind: "failure";
			readonly code: WorkerFailureCode;
			readonly detail: string;
	  };

const FIXTURE_OBJECT_ID = "phase-2b-driver:0123456789abcdef0123456789abcdef";
const OLD_LEFT = Object.freeze([0x6f, 0x6c, 0x64, 0x2d, 0x6c]);
const OLD_RIGHT = Object.freeze([0x6f, 0x6c, 0x64, 0x2d, 0x72]);
const NEW_LEFT = Object.freeze([0x6e, 0x65, 0x77, 0x2d, 0x6c]);
const NEW_RIGHT = Object.freeze([0x6e, 0x65, 0x77, 0x2d, 0x72]);

export interface SeedTransitionResult {
	readonly transactionDurability: "strict";
}

/**
 * Creates the schema-v1 store and commits the exact old image in a strict transaction.
 * This mutation remains inside the sole instrumented raw-IDB owner.
 * @param databaseName - Fresh isolated Phase 2b database name.
 * @param objectId - Frozen creator-bound object ID.
 * @returns Strict seed transaction evidence.
 */
export function seedInstrumentedDatabase(databaseName: string, objectId: string): Promise<SeedTransitionResult> {
	const parsed = parseStorageObjectId(objectId);
	if (!parsed.ok || objectId !== FIXTURE_OBJECT_ID) return Promise.reject(new TypeError("invalid seed object ID"));
	return new Promise((resolve, reject) => {
		const open = indexedDB.open(databaseName, 1);
		open.onerror = (): void => reject(new TypeError("seed database open failed"));
		open.onupgradeneeded = (): void => {
			const database = open.result;
			if (database.objectStoreNames.length !== 0) {
				reject(new TypeError("fresh seed database unexpectedly contained stores"));
				return;
			}
			database.createObjectStore("records", { keyPath: "key" });
		};
		open.onsuccess = (): void => {
			const database = open.result;
			database.onerror = (): void => reject(new TypeError("seed database request failed"));
			database.onversionchange = (): void => database.close();
			const transaction = database.transaction(["records"], "readwrite", { durability: "strict" });
			if (transaction.durability !== "strict" || typeof transaction.commit !== "function") {
				database.close();
				reject(new TypeError("seed transaction did not prove strict durability"));
				return;
			}
			const store = transaction.objectStore("records");
			const leftAdd = store.add({
				key: "left",
				objectId: FIXTURE_OBJECT_ID,
				generation: 0,
				bytes: Uint8Array.from(OLD_LEFT),
			});
			leftAdd.onerror = (): void => reject(new TypeError("seed left add failed"));
			leftAdd.onsuccess = (): void => {
				if (leftAdd.result !== "left") {
					reject(new TypeError("seed left add returned an unexpected key"));
					return;
				}
				const rightAdd = store.add({
					key: "right",
					objectId: FIXTURE_OBJECT_ID,
					generation: 0,
					bytes: Uint8Array.from(OLD_RIGHT),
				});
				rightAdd.onerror = (): void => reject(new TypeError("seed right add failed"));
				rightAdd.onsuccess = (): void => {
					if (rightAdd.result !== "right") {
						reject(new TypeError("seed right add returned an unexpected key"));
						return;
					}
					transaction.commit();
				};
			};
			transaction.onabort = (): void => reject(new TypeError("seed transaction aborted"));
			transaction.onerror = (): void => reject(new TypeError("seed transaction request failed"));
			transaction.oncomplete = (): void => {
				database.close();
				resolve(Object.freeze({ transactionDurability: "strict" }));
			};
		};
	});
}

function exactRecord(value: unknown, key: "left" | "right", bytes: readonly number[]): boolean {
	if (typeof value !== "object" || value === null || Object.getOwnPropertySymbols(value).length !== 0) return false;
	const names = Object.getOwnPropertyNames(value).sort();
	if (names.join("\u0000") !== "bytes\u0000generation\u0000key\u0000objectId") return false;
	if (
		!names.every((name) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, name);
			return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
		})
	) {
		return false;
	}
	const record = value as Record<string, unknown>;
	if (record.key !== key || record.objectId !== FIXTURE_OBJECT_ID || record.generation !== 0) return false;
	const recordBytes = record.bytes;
	if (!(recordBytes instanceof Uint8Array)) return false;
	if (typeof SharedArrayBuffer !== "undefined" && recordBytes.buffer instanceof SharedArrayBuffer) return false;
	return recordBytes.length === bytes.length && bytes.every((byte, index) => recordBytes[index] === byte);
}

/**
 * Performs the Phase 2b two-record transition with literal, synchronous kill edges.
 * @param input - Closed transition input owned by the dedicated Worker.
 * @returns The closed completion or failure result.
 */
export function runInstrumentedTransition(input: InstrumentedTransitionInput): Promise<InstrumentedTransitionResult> {
	const parsed = parseStorageObjectId(input.objectId);
	if (!parsed.ok || input.objectId !== FIXTURE_OBJECT_ID) {
		return Promise.resolve({ kind: "failure", code: "INVALID_OBJECT_ID", detail: "objectId is outside Phase 2b" });
	}
	if (
		typeof indexedDB === "undefined" ||
		typeof SharedArrayBuffer === "undefined" ||
		!(input.signal instanceof SharedArrayBuffer) ||
		input.signal.byteLength !== 4 ||
		typeof Atomics.wait !== "function"
	) {
		return Promise.resolve({
			kind: "failure",
			code: "UNSUPPORTED_CAPABILITY",
			detail: "IndexedDB and the four-byte Worker wait protocol are required",
		});
	}

	return new Promise((resolve) => {
		const observed: KillHit[] = [];
		const cell = new Int32Array(input.signal);
		let durability: "not-reached" | "strict" = "not-reached";
		let database: IDBDatabase | undefined;
		let transaction: IDBTransaction | undefined;
		let settled = false;

		const finishFailure = (code: WorkerFailureCode, detail: string): void => {
			if (settled) return;
			settled = true;
			database?.close();
			resolve({ kind: "failure", code, detail: detail.slice(0, 256) || code });
		};

		const hit = (id: KillPointId, edge: "before" | "after"): boolean => {
			const evidence = Object.freeze({ id, edge, transactionDurability: durability });
			const armed = input.armed?.id === id && input.armed.edge === edge;
			if (armed && Atomics.compareExchange(cell, 0, 0, 1) !== 0) {
				finishFailure("ARM_STATE_ERROR", `armed cell was not idle at ${id}/${edge}`);
				return false;
			}
			observed.push(evidence);
			input.onHit(evidence);
			if (armed) {
				if (Atomics.wait(cell, 0, 1) !== "ok" || Atomics.compareExchange(cell, 0, 1, 2) !== 1) {
					finishFailure("ARM_STATE_ERROR", `armed waiter did not resume exactly once at ${id}/${edge}`);
					return false;
				}
			}
			return !settled;
		};

		if (!hit("database-open", "before")) return;
		const open = indexedDB.open(input.databaseName);
		open.onerror = (): void => finishFailure("REQUEST_ERROR", "database open request failed");
		open.onupgradeneeded = (): void => finishFailure("UNEXPECTED_UPGRADE", "transition database unexpectedly upgraded");
		open.onsuccess = (): void => {
			database = open.result;
			database.onerror = (): void => finishFailure("REQUEST_ERROR", "database request failed");
			database.onversionchange = (): void => database?.close();
			if (!hit("database-open", "after")) return;
			if (!hit("transition-begin", "before")) return;
			try {
				transaction = database.transaction(["records"], "readwrite", { durability: "strict" });
			} catch (error) {
				finishFailure("REQUEST_ERROR", error instanceof Error ? error.message : "transaction creation failed");
				return;
			}
			const activeTransaction = transaction;
			let store: IDBObjectStore;
			try {
				store = activeTransaction.objectStore("records");
			} catch (error) {
				finishFailure("REQUEST_ERROR", error instanceof Error ? error.message : "records store is unavailable");
				return;
			}
			if (activeTransaction.durability !== "strict" || typeof activeTransaction.commit !== "function") {
				finishFailure("DURABILITY_NOT_STRICT", "readwrite transaction did not prove explicit strict durability");
				return;
			}
			durability = "strict";
			if (!hit("transition-begin", "after")) return;

			activeTransaction.onerror = (): void => finishFailure("REQUEST_ERROR", "transition request failed");
			activeTransaction.onabort = (): void => finishFailure("TRANSACTION_ABORT", "transition aborted");
			activeTransaction.oncomplete = (): void => {
				if (!hit("transaction-complete", "after")) return;
				settled = true;
				database?.close();
				resolve({
					kind: "complete",
					observed: Object.freeze([...observed]),
					transactionDurability: "strict",
				});
			};

			if (!hit("preflight-cursor-open", "before")) return;
			const cursorRequest = store.openCursor();
			cursorRequest.onerror = (): void => finishFailure("REQUEST_ERROR", "preflight cursor request failed");
			cursorRequest.onsuccess = (): void => {
				const leftCursor = cursorRequest.result;
				if (leftCursor === null || !exactRecord(leftCursor.value, "left", OLD_LEFT)) {
					finishFailure("PREFLIGHT_MISMATCH", "preflight left record did not match the exact seeded value");
					return;
				}
				if (!hit("preflight-cursor-open", "after")) return;
				if (!hit("preflight-cursor-continue", "before")) return;
				leftCursor.continue();
				cursorRequest.onsuccess = (): void => {
					const rightCursor = cursorRequest.result;
					if (rightCursor === null || !exactRecord(rightCursor.value, "right", OLD_RIGHT)) {
						finishFailure("PREFLIGHT_MISMATCH", "preflight right record did not match the exact seeded value");
						return;
					}
					if (!hit("preflight-cursor-continue", "after")) return;
					if (!hit("left-write", "before")) return;
					const leftWrite = store.put({
						key: "left",
						objectId: FIXTURE_OBJECT_ID,
						generation: 1,
						bytes: Uint8Array.from(NEW_LEFT),
					});
					leftWrite.onerror = (): void => finishFailure("REQUEST_ERROR", "left write request failed");
					leftWrite.onsuccess = (): void => {
						if (leftWrite.result !== "left") {
							finishFailure("REQUEST_ERROR", "left write returned an unexpected key");
							return;
						}
						if (!hit("left-write", "after")) return;
						if (!hit("right-write", "before")) return;
						const rightWrite = store.put({
							key: "right",
							objectId: FIXTURE_OBJECT_ID,
							generation: 1,
							bytes: Uint8Array.from(NEW_RIGHT),
						});
						rightWrite.onerror = (): void => finishFailure("REQUEST_ERROR", "right write request failed");
						rightWrite.onsuccess = (): void => {
							if (rightWrite.result !== "right") {
								finishFailure("REQUEST_ERROR", "right write returned an unexpected key");
								return;
							}
							if (!hit("right-write", "after")) return;
							if (!hit("transaction-complete", "before")) return;
							activeTransaction.commit();
						};
					};
				};
			};
		};
	});
}
