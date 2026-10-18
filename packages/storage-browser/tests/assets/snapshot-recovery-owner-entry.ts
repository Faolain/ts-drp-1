import { createBrowserSnapshotQuarantineStore } from "@ts-drp/storage-browser/snapshot-transfer";

import {
	type CommonCase,
	fixture,
	type LegacyStore,
	outcome,
	type OwnerImage,
	type RecoveryEnvironment,
	type RecoveryStore,
	runCommonCase,
	seedLegacy,
	stable,
} from "../../../../tests/fixtures/snapshot-recovery-owner/contract.js";
import { createBrowserSnapshotQuarantineStore as createLegacy } from "../fixtures/legacy-snapshot-transfer.mjs";

type BrowserCase =
	| CommonCase
	| "versionchange"
	| "blocked-open"
	| "cooperative-upgrade"
	| "malformed-schema"
	| "low-space"
	| "overflow"
	| "allocation-failure"
	| "async-upgrade-abort"
	| "async-upgrade-abort-control"
	| "durable-image-control"
	| "owner-metadata-sweep";
const SUFFIX = "--drp-snapshot-quarantine-v1";

async function request<Result>(value: IDBRequest<Result>): Promise<Result> {
	return new Promise((resolve, reject) => {
		value.addEventListener("success", () => resolve(value.result), { once: true });
		value.addEventListener("error", () => reject(value.error), { once: true });
	});
}

async function existing(name: string): Promise<IDBDatabase> {
	if (!(await indexedDB.databases()).some((entry) => entry.name === name))
		throw new Error("expected owner database absent");
	return request(indexedDB.open(name));
}

function hex(value: unknown): string {
	if (!(value instanceof Uint8Array)) throw new TypeError("fixture byte carrier is absent");
	return [...value]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")
		.toUpperCase();
}

async function image(name: string): Promise<OwnerImage> {
	const db = await existing(name);
	try {
		const tx = db.transaction([...db.objectStoreNames], "readonly");
		const schema = [...db.objectStoreNames].map((name) => {
			const store = tx.objectStore(name);
			return {
				name,
				keyPath: store.keyPath,
				autoIncrement: store.autoIncrement,
				indexes: [...store.indexNames].map((indexName) => {
					const index = store.index(indexName);
					return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
				}),
			};
		});
		const [scopes, chunks, ownerRows] = await Promise.all([
			request(tx.objectStore("scopes").getAll()) as Promise<readonly Record<string, unknown>[]>,
			request(tx.objectStore("chunks").getAll()) as Promise<readonly Record<string, unknown>[]>,
			Promise.all(
				[...db.objectStoreNames]
					.filter((storeName) => storeName !== "scopes" && storeName !== "chunks")
					.map(async (storeName) => ({ storeName, rows: await request(tx.objectStore(storeName).getAll()) }))
			),
		]);
		return {
			version: db.version,
			names: [...db.objectStoreNames],
			schema,
			ownerRows,
			durableScopes: scopes,
			durableChunks: chunks,
			scopes: scopes.map((row) => ({
				object_id: row.objectId,
				epoch: row.epoch,
				anchor: row.anchor,
				manifest_digest: row.manifestDigest,
				manifest: hex(row.exactCanonicalManifestBytes),
				total_bytes: row.totalBytes,
				chunk_count: row.chunkCount,
				expires_at: row.expiresAt,
				state: row.state,
			})),
			chunks: chunks.map((row) => ({
				object_id: row.objectId,
				epoch: row.epoch,
				anchor: row.anchor,
				manifest_digest: row.manifestDigest,
				chunk_index: row.index,
				chunk_digest: row.digest,
				byte_length: row.byteLength,
				bytes: hex(row.exactBytes),
			})),
		};
	} finally {
		db.close();
	}
}

async function deletion(name: string): Promise<boolean> {
	return new Promise((resolve) => {
		const deleting = indexedDB.deleteDatabase(name);
		const timer = setTimeout(() => resolve(false), 2_000);
		deleting.addEventListener(
			"success",
			() => {
				clearTimeout(timer);
				resolve(true);
			},
			{ once: true }
		);
		deleting.addEventListener(
			"error",
			() => {
				clearTimeout(timer);
				resolve(false);
			},
			{ once: true }
		);
	});
}

async function requireDeletion(name: string): Promise<void> {
	if (!(await deletion(name))) throw new Error("recovery-owner test cleanup blocked by a leaked connection");
}

async function run(name: BrowserCase): Promise<unknown> {
	const primaryDatabaseName = `snapshot-recovery-owner-${crypto.randomUUID()}`;
	const databaseName = `${primaryDatabaseName}${SUFFIX}`;
	const stores: LegacyStore[] = [];
	const env: RecoveryEnvironment = {
		open: async (recoveryLimits, explicit) => {
			const store = await createBrowserSnapshotQuarantineStore({
				primaryDatabaseName,
				...(recoveryLimits === undefined && explicit !== true ? {} : { recoveryLimits }),
			} as Parameters<typeof createBrowserSnapshotQuarantineStore>[0]);
			stores.push(store);
			return store as unknown as RecoveryStore;
		},
		legacy: async () => {
			const store = await createLegacy({ primaryDatabaseName });
			stores.push(store);
			return store;
		},
		image: async () => image(databaseName),
		exists: async () => (await indexedDB.databases()).some((entry) => entry.name === databaseName),
	};
	let blocker: IDBDatabase | undefined;
	try {
		if (name === "owner-metadata-sweep") {
			const seeded = await seedLegacy(env);
			await seeded.old.close();
			const store = await env.open();
			const db = await existing(databaseName);
			try {
				const tx = db.transaction("owner", "readwrite");
				const done = new Promise<void>((resolve, reject) => {
					tx.addEventListener("complete", () => resolve(), { once: true });
					tx.addEventListener("abort", () => reject(tx.error), { once: true });
				});
				tx.objectStore("owner").delete("owner");
				await done;
			} finally {
				db.close();
			}
			const before = await env.image();
			const result = await outcome(() => store.sweepExpired());
			return { code: result.code, unchanged: stable(before) === stable(await env.image()) };
		}
		if (name === "durable-image-control") {
			const seeded = await seedLegacy(env);
			await seeded.old.close();
			const opening = indexedDB.open(databaseName, 2);
			opening.addEventListener(
				"upgradeneeded",
				() => {
					opening.result.createObjectStore("oracle_owner", { keyPath: "id" }).add({ id: 1, debt: seeded.debt });
				},
				{ once: true }
			);
			const db = await request(opening);
			const detected: boolean[] = [];
			try {
				for (const [storeName, field, value] of [
					["scopes", "retention", "oracle-only"],
					["scopes", "incarnation", "changed"],
					["scopes", "descriptors", []],
					["oracle_owner", "debt", 0],
				] as const) {
					const before = await env.image();
					const tx = db.transaction(storeName, "readwrite");
					const done = new Promise<void>((resolve, reject) => {
						tx.addEventListener("complete", () => resolve(), { once: true });
						tx.addEventListener("abort", () => reject(tx.error), { once: true });
					});
					const store = tx.objectStore(storeName);
					const cursor = store.openCursor();
					cursor.addEventListener(
						"success",
						() => {
							if (cursor.result === null) throw new Error("control row absent");
							cursor.result.update({ ...cursor.result.value, [field]: value });
						},
						{ once: true }
					);
					await done;
					const after = await env.image();
					detected.push(
						stable(before.scopes) === stable(after.scopes) &&
							stable(before.chunks) === stable(after.chunks) &&
							stable(before) !== stable(after)
					);
				}
			} finally {
				db.close();
			}
			return { detected };
		}
		if (name === "low-space") {
			const seeded = await seedLegacy(env);
			await seeded.old.close();
			const before = await env.image();
			const original = Object.getOwnPropertyDescriptor(navigator.storage, "estimate");
			let estimateCalls = 0;
			Object.defineProperty(navigator.storage, "estimate", {
				configurable: true,
				value: (): Promise<StorageEstimate> => {
					estimateCalls += 1;
					return Promise.resolve({ quota: 0, usage: 0 });
				},
			});
			try {
				const store = await env.open();
				const scope = await store.openScope(seeded.verified.declaration);
				const descriptor = seeded.verified.declaration.chunks[0];
				if (descriptor === undefined) throw new Error("fixture descriptor absent");
				const read = await scope.verificationQuarantine.open(new AbortController().signal).read(descriptor);
				const after = await env.image();
				return {
					estimateCalls,
					exactBytes: stable(read) === stable(seeded.verified.chunks[0]),
					migration: (await store.recoveryStatus()).migration,
					unchanged: stable(before.scopes) === stable(after.scopes) && stable(before.chunks) === stable(after.chunks),
				};
			} finally {
				if (original === undefined) Reflect.deleteProperty(navigator.storage, "estimate");
				else Object.defineProperty(navigator.storage, "estimate", original);
			}
		}
		if (name === "overflow") {
			const seeded = await seedLegacy(env);
			await seeded.old.close();
			const db = await existing(databaseName);
			try {
				const tx = db.transaction("scopes", "readwrite");
				const done = new Promise<void>((resolve, reject) => {
					tx.addEventListener("complete", () => resolve());
					tx.addEventListener("abort", () => reject(tx.error));
				});
				const cursor = tx.objectStore("scopes").openCursor();
				cursor.addEventListener(
					"success",
					() => {
						const row = cursor.result;
						if (row !== null) row.update({ ...row.value, totalBytes: Number.MAX_SAFE_INTEGER });
					},
					{ once: true }
				);
				await done;
			} finally {
				db.close();
			}
			const before = await env.image();
			const result = await outcome(() => env.open());
			const after = await env.image();
			return { code: result.code, version: after.version, unchanged: stable(before) === stable(after) };
		}
		if (name === "async-upgrade-abort" || name === "async-upgrade-abort-control") {
			const seeded = await seedLegacy(env);
			await seeded.old.close();
			const before = await env.image();
			const open = IDBFactory.prototype.open;
			let requestSucceeded = false;
			let abortObserved = false;
			let nativeOpenError = "none";
			IDBFactory.prototype.open = function observeOpen(...args: Parameters<typeof open>): IDBOpenDBRequest {
				const opening = open.apply(this, args);
				if (args[0] === databaseName && args[1] === 2) {
					opening.addEventListener(
						"error",
						() => {
							nativeOpenError = opening.error?.name ?? "missing";
						},
						{ once: true }
					);
					opening.addEventListener(
						"upgradeneeded",
						() => {
							const tx = opening.transaction;
							if (tx === null) throw new Error("native upgrade transaction absent");
							tx.addEventListener(
								"abort",
								() => {
									abortObserved = true;
								},
								{ once: true }
							);
							const read = tx.objectStore("scopes").get(["abort-control", 0, "", ""]);
							read.addEventListener(
								"success",
								() => {
									requestSucceeded = true;
									tx.abort();
								},
								{ once: true }
							);
						},
						{ once: true }
					);
				}
				return opening;
			};
			let result: Awaited<ReturnType<typeof outcome>>;
			try {
				result = await outcome(() =>
					name === "async-upgrade-abort-control"
						? request(indexedDB.open(databaseName, 2)).then((db) => {
								db.close();
							})
						: env.open()
				);
			} finally {
				IDBFactory.prototype.open = open;
			}
			const after = await env.image();
			return {
				code: name === "async-upgrade-abort-control" ? nativeOpenError : result.code,
				requestSucceeded,
				abortObserved,
				nativeOpenError,
				version: after.version,
				unchanged: stable(before) === stable(after),
			};
		}
		if (name === "allocation-failure") {
			const seeded = await seedLegacy(env);
			await seeded.old.close();
			const before = await env.image();
			const put = IDBObjectStore.prototype.put;
			const add = IDBObjectStore.prototype.add;
			let injected = 0;
			const failMetadata = (store: IDBObjectStore): void => {
				if (store.transaction.mode === "versionchange" && store.transaction.db.name === databaseName) {
					injected += 1;
					throw new DOMException("fixture metadata quota failure", "QuotaExceededError");
				}
			};
			IDBObjectStore.prototype.put = function observedPut(...args: Parameters<typeof put>): ReturnType<typeof put> {
				failMetadata(this);
				return put.apply(this, args);
			};
			IDBObjectStore.prototype.add = function observedAdd(...args: Parameters<typeof add>): ReturnType<typeof add> {
				failMetadata(this);
				return add.apply(this, args);
			};
			let result: Awaited<ReturnType<typeof outcome>>;
			try {
				result = await outcome(() => env.open());
			} finally {
				IDBObjectStore.prototype.put = put;
				IDBObjectStore.prototype.add = add;
			}
			const after = await env.image();
			return {
				code: result.code,
				injected: injected > 0,
				version: after.version,
				unchanged: stable(before) === stable(after),
			};
		}
		if (name === "versionchange") {
			const open = IDBFactory.prototype.open;
			const changes: { oldVersion: number; newVersion: number | null }[] = [];
			IDBFactory.prototype.open = function observeOpen(...args: Parameters<typeof open>): IDBOpenDBRequest {
				const opening = open.apply(this, args);
				opening.addEventListener(
					"success",
					() =>
						opening.result.addEventListener("versionchange", (event) => {
							changes.push({ oldVersion: event.oldVersion, newVersion: event.newVersion });
						}),
					{ once: true }
				);
				return opening;
			};
			let seeded: Awaited<ReturnType<typeof seedLegacy>>;
			try {
				seeded = await seedLegacy(env);
			} finally {
				IDBFactory.prototype.open = open;
			}
			const oldScope = await seeded.old.openScope(seeded.unfinished.declaration);
			await env.open();
			const before = await env.image();
			const oldCancel = await outcome(() => oldScope.cancel());
			const oldOpen = await outcome(() => seeded.old.openScope(fixture("stale-browser-create").declaration));
			const oldFactory = await outcome(() => env.legacy());
			const rawOldVersion = await outcome(() => request(indexedDB.open(databaseName, 1)));
			if (rawOldVersion.code === "none") (rawOldVersion.value as IDBDatabase).close();
			return {
				version: before.version,
				changes,
				oldRefused: [oldCancel, oldOpen, oldFactory, rawOldVersion].every(({ code }) => code !== "none"),
				unchanged: stable(before) === stable(await env.image()),
			};
		}
		if (name === "blocked-open") {
			const seeded = await seedLegacy(env);
			await seeded.old.close();
			blocker = await request(indexedDB.open(databaseName, 1));
			const before = await env.image();
			let blockedAt: number | undefined;
			let stayedPending = false;
			let settled = false;
			let pendingProbe: ReturnType<typeof setTimeout> | undefined;
			const open = IDBFactory.prototype.open;
			IDBFactory.prototype.open = function observeOpen(...args: Parameters<typeof open>): IDBOpenDBRequest {
				const opening = open.apply(this, args);
				if (args[0] === databaseName && args[1] === 2)
					opening.addEventListener(
						"blocked",
						() => {
							blockedAt = performance.now();
							pendingProbe = setTimeout(() => {
								stayedPending = !settled;
							}, 500);
						},
						{ once: true }
					);
				return opening;
			};
			const started = performance.now();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const rejected = await Promise.race([
				outcome(() => env.open()).then((result) => {
					settled = true;
					return result;
				}),
				new Promise<{ code: string; detail: string }>((resolve) => {
					timer = setTimeout(
						() => resolve({ code: "test-deadline", detail: "constructor did not settle while blocker stayed open" }),
						2_000
					);
				}),
			]);
			clearTimeout(timer);
			clearTimeout(pendingProbe);
			IDBFactory.prototype.open = open;
			const elapsed = performance.now() - (blockedAt ?? started);
			blocker.close();
			blocker = undefined;
			// An unversioned read queued behind a canceled request must still observe the original v1 image.
			const after = await env.image();
			for (const store of stores) await store.close();
			const noLeak = await deletion(databaseName);
			return {
				code: rejected.code,
				diagnostic: rejected.detail?.includes("migration-blocked") === true,
				blockedObserved: blockedAt !== undefined,
				stayedPending,
				bounded: elapsed >= 800 && elapsed <= 2_000,
				version: after.version,
				unchanged: stable(before) === stable(after),
				noLeak,
			};
		}
		if (name === "cooperative-upgrade") {
			const seeded = await seedLegacy(env);
			await seeded.old.close();
			blocker = await request(indexedDB.open(databaseName, 1));
			const before = await env.image();
			const open = IDBFactory.prototype.open;
			let blocked = false;
			let upgradeStarted: number | undefined;
			let released = false;
			IDBFactory.prototype.open = function observeOpen(...args: Parameters<typeof open>): IDBOpenDBRequest {
				const opening = open.apply(this, args);
				if (args[0] === databaseName && args[1] === 2) {
					opening.addEventListener(
						"blocked",
						() => {
							blocked = true;
							setTimeout(() => {
								blocker?.close();
								blocker = undefined;
								released = true;
							}, 600);
						},
						{ once: true }
					);
					opening.addEventListener(
						"upgradeneeded",
						() => {
							upgradeStarted = performance.now();
							const scope = opening.transaction?.objectStore("scopes");
							if (scope === undefined) throw new Error("upgrade transaction scope store absent");
							// Keep the actual native upgrade transaction active beyond the blocked-wait deadline.
							const keepAlive = (): void => {
								const read = scope.get(["keepalive", 0, "", ""]);
								read.addEventListener(
									"success",
									() => {
										if (performance.now() - (upgradeStarted ?? 0) < 1_200) keepAlive();
									},
									{ once: true }
								);
							};
							keepAlive();
						},
						{ once: true }
					);
				}
				return opening;
			};
			let opened: Awaited<ReturnType<typeof outcome>>;
			try {
				opened = await outcome(() => env.open());
			} finally {
				IDBFactory.prototype.open = open;
				blocker?.close();
				blocker = undefined;
			}
			const upgradeExceededDeadline = upgradeStarted !== undefined && performance.now() - upgradeStarted >= 1_200;
			const after = await env.image();
			return {
				code: opened.code,
				blocked,
				released,
				upgradeExceededDeadline,
				version: after.version,
				unchanged: stable(before.scopes) === stable(after.scopes) && stable(before.chunks) === stable(after.chunks),
			};
		}
		if (name === "malformed-schema") {
			const opening = indexedDB.open(databaseName, 1);
			opening.addEventListener(
				"upgradeneeded",
				() => {
					const scope = opening.result.createObjectStore("scopes", {
						keyPath: ["objectId", "epoch", "anchor", "manifestDigest"],
					});
					scope.createIndex("expiryAsc", "wrongExpiry");
					opening.result.createObjectStore("chunks", {
						keyPath: ["objectId", "epoch", "anchor", "manifestDigest", "index"],
					});
				},
				{ once: true }
			);
			(await request(opening)).close();
			const before = await env.image();
			const refused = await outcome(() => env.open());
			const after = await env.image();
			return { code: refused.code, unchanged: stable(before) === stable(after), version: after.version };
		}
		return await runCommonCase(name, env);
	} finally {
		blocker?.close();
		for (const store of stores) await store.close().catch(() => undefined);
		await requireDeletion(databaseName);
	}
}

declare global {
	interface Window {
		runSnapshotRecoveryOwner(name: BrowserCase): Promise<unknown>;
	}
}
window.runSnapshotRecoveryOwner = run;
