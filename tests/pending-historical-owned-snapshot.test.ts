import "fake-indexeddb/auto";

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
	deleteOwnedPendingSnapshotDatabase,
	openOwnedPendingSnapshot,
	openPendingHistoricalFixture,
	type PendingHistoricalFixture,
	pendingSnapshotFactory,
	withPendingHistoricalFixtures,
} from "./fixtures/pending-historical/owned-snapshot.js";
import { REPOSITORY_ROOT } from "./fixtures/phase-6a-v3/creator-adoption-contract.js";

beforeAll(() => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
	});
});

async function databaseNames(): Promise<readonly string[]> {
	return (await indexedDB.databases()).flatMap(({ name }) => (name === undefined ? [] : [name]));
}

function deferred<Value>(): { promise: Promise<Value>; resolve(value: Value): void } {
	let resolve!: (value: Value) => void;
	const promise = new Promise<Value>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

describe("pending historical owned snapshot controls (fake-IDB, not restart)", () => {
	it("uses default absolute source identity and configured genuine factory verbatim", async () => {
		const url = pathToFileURL(resolve(REPOSITORY_ROOT, "packages/storage-browser/src/snapshot-transfer.ts")).href;
		const source = (await import(url)) as {
			createBrowserSnapshotQuarantineStore: Awaited<ReturnType<typeof pendingSnapshotFactory>>;
		};
		expect(await pendingSnapshotFactory()).toBe(source.createBrowserSnapshotQuarantineStore);
		const [fixture, configured] = await withPendingHistoricalFixtures(async (acquire) => {
			const fixture = await acquire();
			expect(await pendingSnapshotFactory()).toBe(fixture.modules.createBrowserSnapshotQuarantineStore);
			let captured: typeof fixture.pendingSnapshotStore | undefined;
			let databaseName: string | undefined;
			const factory: typeof fixture.modules.createBrowserSnapshotQuarantineStore = async (options) => {
				databaseName = `${options.primaryDatabaseName}--drp-snapshot-quarantine-v1`;
				captured = await fixture.modules.createBrowserSnapshotQuarantineStore(options);
				return captured;
			};
			const modules = { ...fixture.modules, createBrowserSnapshotQuarantineStore: factory };
			expect(await pendingSnapshotFactory(modules)).toBe(factory);
			const configured = await acquire({ modules });
			expect(configured.pendingSnapshotStore).toBe(captured);
			expect(configured.pendingSnapshotStore).not.toBe(configured.evidence.snapshotStore);
			expect(configured.pendingSnapshotDatabaseName).toBe(databaseName);
			// Genuine close succeeded using this owner; verify producer still sees its narrow decorator.
			expect("lookupRecoveryDeclaration" in configured.evidence.snapshotStore).toBe(false);
			expect(
				await configured.modules.verifyCreatorSuccessorAdoption({
					catalog: configured.catalog,
					handle: configured.handle,
				})
			).toMatchObject({ ok: true });
			const observed = await configured.pendingSnapshotStore.lookupRecoveryDeclaration(
				configured.evidence.declaration.scope
			);
			expect(observed).toMatchObject({ kind: "present", state: "verified" });
			const scope = await configured.pendingSnapshotStore.openScope(configured.evidence.declaration);
			const port = scope.verificationQuarantine.open(new AbortController().signal);
			try {
				for (const descriptor of configured.evidence.declaration.chunks) {
					expect(await port.read(descriptor)).toEqual(configured.evidence.chunks[descriptor.index]);
				}
			} finally {
				await port.discard();
				await scope.release();
			}
			return [fixture, configured] as const;
		});
		expect(await databaseNames()).not.toContain(fixture.pendingSnapshotDatabaseName);
		expect(await databaseNames()).not.toContain(configured.pendingSnapshotDatabaseName);
	});

	it("settles a delayed started native factory after a parallel sibling rejects, before deleting", async () => {
		const factory = await pendingSnapshotFactory();
		const factoryStarted = deferred<undefined>();
		const allowFactory = deferred<undefined>();
		const siblingFailure = new Error("PARALLEL_SIBLING_FAILURE");
		let owner: Awaited<ReturnType<typeof factory>> | undefined;
		let databaseName: string | undefined;
		let settled = false;
		const result = openOwnedPendingSnapshot({
			factory: async (options) => {
				databaseName = `${options.primaryDatabaseName}--drp-snapshot-quarantine-v1`;
				factoryStarted.resolve(undefined);
				await allowFactory.promise;
				owner = await factory(options);
				return owner;
			},
			prepare: async (createSnapshotStore) => {
				await Promise.all([
					createSnapshotStore(),
					factoryStarted.promise.then(() => {
						throw siblingFailure;
					}),
				]);
				return { close: (): Promise<void> => Promise.resolve() };
			},
			finish: () => Promise.reject(new Error("FINISH_MUST_NOT_RUN")),
		});
		const rejection = result.catch((error: unknown) => {
			settled = true;
			return error;
		});
		await factoryStarted.promise;
		await Promise.resolve();
		expect(settled).toBe(false);
		allowFactory.resolve(undefined);
		expect(await rejection).toBe(siblingFailure);
		expect(owner).toBeDefined();
		await expect(owner?.recoveryStatus()).rejects.toMatchObject({ code: "closed" });
		expect(await databaseNames()).not.toContain(databaseName);
	});

	it("preserves finish failure, attaches fixture cleanup failure and still closes/deletes native owner", async () => {
		const factory = await pendingSnapshotFactory();
		const primary = new Error("FINISH_FAILURE");
		const cleanupError = new Error("FIXTURE_CLOSE_FAILURE");
		let owner: Awaited<ReturnType<typeof factory>> | undefined;
		let databaseName: string | undefined;
		let closes = 0;
		const rejection = await openOwnedPendingSnapshot({
			factory: async (options) => {
				databaseName = `${options.primaryDatabaseName}--drp-snapshot-quarantine-v1`;
				owner = await factory(options);
				return owner;
			},
			prepare: async (createSnapshotStore) => {
				await createSnapshotStore();
				return {
					close: (): Promise<void> => {
						closes += 1;
						return Promise.reject(cleanupError);
					},
				};
			},
			finish: () => Promise.reject(primary),
		}).catch((error: unknown) => error);
		expect(rejection).toBe(primary);
		expect(rejection).toHaveProperty("pendingSnapshotCleanupErrors", [cleanupError]);
		expect(closes).toBe(1);
		await expect(owner?.recoveryStatus()).rejects.toMatchObject({ code: "closed" });
		expect(await databaseNames()).not.toContain(databaseName);
	});

	it("caches cleanup, invokes fixture once and reenters only native cached close", async () => {
		const factory = await pendingSnapshotFactory();
		let closes = 0;
		const owned = await openOwnedPendingSnapshot({
			factory,
			prepare: async (createSnapshotStore) => {
				const owner = await createSnapshotStore();
				return {
					close: async (): Promise<void> => {
						closes += 1;
						await owner.close();
					},
					owner,
				};
			},
			finish: (prepared) => Promise.resolve(prepared.owner),
		});
		expect(owned.value).toBe(owned.snapshotStore);
		expect(await databaseNames()).toContain(owned.snapshotDatabaseName);
		const first = owned.close();
		expect(owned.close()).toBe(first);
		await first;
		expect(closes).toBe(1);
		expect(await databaseNames()).not.toContain(owned.snapshotDatabaseName);
	});

	it("strict deletion rejects blocked requests and preserves a neighboring database", async () => {
		const databaseName = `pending-historical-blocked-${crypto.randomUUID()}--drp-snapshot-quarantine-v1`;
		const neighborName = `${databaseName}-neighbor`;
		const open = (name: string): Promise<IDBDatabase> =>
			new Promise((accept, reject) => {
				const request = indexedDB.open(name);
				request.addEventListener("success", () => accept(request.result), { once: true });
				request.addEventListener("error", () => reject(request.error), { once: true });
			});
		const held = await open(databaseName);
		const neighbor = await open(neighborName);
		try {
			await expect(deleteOwnedPendingSnapshotDatabase(databaseName)).rejects.toThrow("PENDING_SNAPSHOT_DELETE_BLOCKED");
			expect(await databaseNames()).toContain(neighborName);
		} finally {
			held.close();
			neighbor.close();
			await deleteOwnedPendingSnapshotDatabase(databaseName);
			await deleteOwnedPendingSnapshotDatabase(neighborName);
		}
	});

	it("strict deletion rejects an error event instead of reporting successful deletion", async () => {
		const databaseName = `pending-historical-error-${crypto.randomUUID()}--drp-snapshot-quarantine-v1`;
		const deletionError = new DOMException("CONTROLLED_DELETE_ERROR", "UnknownError");
		const request = new IDBOpenDBRequest();
		Object.defineProperty(request, "error", { value: deletionError });
		// Event-registration control, not evidence of a native engine's deletion error.
		const listeners = new Map<string, EventListenerOrEventListenerObject>();
		vi.spyOn(request, "addEventListener").mockImplementation((type, listener) => {
			if (listener !== null) listeners.set(type, listener);
		});
		const deletion = vi.spyOn(indexedDB, "deleteDatabase").mockReturnValue(request);
		try {
			const result = deleteOwnedPendingSnapshotDatabase(databaseName);
			const onError = listeners.get("error");
			if (typeof onError !== "function") throw new Error("ERROR_LISTENER_NOT_INSTALLED");
			onError.call(request, new Event("error"));
			await expect(result).rejects.toBe(deletionError);
			expect(deletion).toHaveBeenCalledExactlyOnceWith(databaseName);
		} finally {
			deletion.mockRestore();
		}
	});

	it("attempts owner close and strict deletion despite fixture cleanup failure, retaining both errors", async () => {
		const factory = await pendingSnapshotFactory();
		const primary = new Error("FINISH_AND_TWO_CLEANUP_FAILURES");
		const fixtureFailure = new Error("FIXTURE_CLEANUP_ERROR");
		const ownerFailure = new Error("NATIVE_CLOSE_ERROR_AFTER_CLOSE");
		let databaseName: string | undefined;
		let nativeCloses = 0;
		const nativeClose = IDBDatabase.prototype.close;
		const closeFault = vi.spyOn(IDBDatabase.prototype, "close").mockImplementation(function (this: IDBDatabase) {
			nativeClose.call(this);
			if (this.name === databaseName) {
				nativeCloses += 1;
				throw ownerFailure;
			}
		});
		try {
			const rejection = await openOwnedPendingSnapshot({
				factory: async (options) => {
					databaseName = `${options.primaryDatabaseName}--drp-snapshot-quarantine-v1`;
					return factory(options);
				},
				prepare: async (createSnapshotStore) => {
					await createSnapshotStore();
					return {
						close: (): Promise<void> => Promise.reject(fixtureFailure),
					};
				},
				finish: () => Promise.reject(primary),
			}).catch((error: unknown) => error);
			expect(rejection).toBe(primary);
			expect(rejection).toHaveProperty("pendingSnapshotCleanupErrors", [fixtureFailure, ownerFailure]);
			expect(nativeCloses).toBe(1);
			expect(await databaseNames()).not.toContain(databaseName);
		} finally {
			closeFault.mockRestore();
		}
	});

	it("preserves frozen and previously-attached primary errors as aggregate causes when attachment cannot succeed", async () => {
		const factory = await pendingSnapshotFactory();
		const reused = new Error("REUSED_PRIMARY_ERROR");
		Object.defineProperty(reused, "pendingSnapshotCleanupErrors", { value: ["previous-attempt"] });
		const trapped = new Proxy(new Error("TRAPPED_PRIMARY_ERROR"), {
			defineProperty: (): never => {
				throw new Error("HOSTILE_ATTACHMENT_TRAP");
			},
		});
		for (const primary of [Object.freeze(new Error("FROZEN_PRIMARY_ERROR")), reused, trapped]) {
			const cleanupError = new Error("CONTROLLED_CLEANUP_ERROR");
			let databaseName: string | undefined;
			const rejection = await openOwnedPendingSnapshot({
				factory: async (options) => {
					databaseName = `${options.primaryDatabaseName}--drp-snapshot-quarantine-v1`;
					return factory(options);
				},
				prepare: async (createSnapshotStore) => {
					await createSnapshotStore();
					return { close: (): Promise<void> => Promise.reject(cleanupError) };
				},
				finish: () => Promise.reject(primary),
			}).catch((error: unknown) => error);
			expect(rejection).toBeInstanceOf(AggregateError);
			expect(rejection).toHaveProperty("cause", primary);
			expect(rejection).toHaveProperty("errors", [cleanupError]);
			expect(await databaseNames()).not.toContain(databaseName);
		}
		expect(reused).toHaveProperty("pendingSnapshotCleanupErrors", ["previous-attempt"]);
	});

	it("closes the earlier returned genuine owner when the second fixture construction rejects", async () => {
		const primary = new Error("SECOND_CONSTRUCTION_REJECTED");
		const returned: PendingHistoricalFixture[] = [];
		const closeCounts: number[] = [];
		let attempts = 0;
		const open: typeof openPendingHistoricalFixture = async (options) => {
			attempts += 1;
			if (attempts === 2) throw primary;
			const fixture = await openPendingHistoricalFixture(options);
			returned.push(fixture);
			const close = fixture.close;
			closeCounts.push(0);
			vi.spyOn(fixture, "close").mockImplementation(() => {
				closeCounts[0] += 1;
				return close();
			});
			return fixture;
		};
		const rejection = await withPendingHistoricalFixtures(async (acquire) => {
			await acquire();
			expect(await databaseNames()).toContain(returned[0].pendingSnapshotDatabaseName);
			await acquire();
			throw new Error("SECOND_CONSTRUCTION_MUST_NOT_RETURN");
		}, open).catch((error: unknown) => error);
		expect(rejection).toBe(primary);
		expect(attempts).toBe(2);
		expect(returned).toHaveLength(1);
		expect(closeCounts).toEqual([1]);
		await expect(returned[0].pendingSnapshotStore.recoveryStatus()).rejects.toMatchObject({ code: "closed" });
		expect(await databaseNames()).not.toContain(returned[0].pendingSnapshotDatabaseName);
	});

	it("settles both earlier returned genuine cleanups after third construction rejection, retaining every cleanup failure", async () => {
		const primary = new Error("THIRD_CONSTRUCTION_REJECTED");
		const cleanupErrors = [new Error("FIRST_RETURNED_CLEANUP_FAILURE"), new Error("SECOND_RETURNED_CLEANUP_FAILURE")];
		const returned: PendingHistoricalFixture[] = [];
		const closeCounts: number[] = [];
		let attempts = 0;
		const open: typeof openPendingHistoricalFixture = async (options) => {
			attempts += 1;
			if (attempts === 3) throw primary;
			const fixture = await openPendingHistoricalFixture(options);
			const index = returned.length;
			returned.push(fixture);
			closeCounts.push(0);
			const close = fixture.close;
			vi.spyOn(fixture, "close").mockImplementation(async () => {
				closeCounts[index] += 1;
				await close();
				throw cleanupErrors[index];
			});
			return fixture;
		};
		const rejection = await withPendingHistoricalFixtures(async (acquire) => {
			await acquire();
			await acquire();
			for (const fixture of returned) expect(await databaseNames()).toContain(fixture.pendingSnapshotDatabaseName);
			await acquire();
			throw new Error("THIRD_CONSTRUCTION_MUST_NOT_RETURN");
		}, open).catch((error: unknown) => error);
		expect(rejection).toBe(primary);
		expect(rejection).toHaveProperty("pendingSnapshotCleanupErrors", cleanupErrors);
		expect(attempts).toBe(3);
		expect(returned).toHaveLength(2);
		expect(closeCounts).toEqual([1, 1]);
		for (const fixture of returned) {
			await expect(fixture.pendingSnapshotStore.recoveryStatus()).rejects.toMatchObject({ code: "closed" });
			expect(await databaseNames()).not.toContain(fixture.pendingSnapshotDatabaseName);
		}
	});
});
