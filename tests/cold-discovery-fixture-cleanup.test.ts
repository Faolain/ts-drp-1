import "fake-indexeddb/auto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { GenuineCreatorAdoptionFixtureModules } from "./fixtures/phase-6a-v3/creator-adoption-contract.js";
import type { D109dHotFixture, D109dOpenOptions } from "./fixtures/phase-6b/runtime-reclamation-contract.js";
import { openD110cARepeatCloseFixture } from "./fixtures/phase-6b-d110c-a/repeat-close-contract.js";
import { createBrowserSnapshotQuarantineStore } from "../packages/storage-browser/src/snapshot-transfer.js";

const control = vi.hoisted(() => ({ error: new Error("INTENTIONAL_HOT_CONSTRUCTION_FAILURE"), calls: 0 }));
vi.mock("./fixtures/phase-6b/runtime-reclamation-contract.js", async (original) => {
	const actual = await original<Record<string, unknown>>();
	return {
		...actual,
		openD109dHotFixture: async (options: D109dOpenOptions): Promise<D109dHotFixture> => {
			control.calls += 1;
			await options.creator?.createSnapshotStore?.();
			throw control.error;
		},
	};
});

afterEach(() => {
	vi.restoreAllMocks();
	control.calls = 0;
	control.error = new Error("INTENTIONAL_HOT_CONSTRUCTION_FAILURE");
});

describe("cold discovery repeat-close fixture resource custody", () => {
	it("rejects the caller snapshot hook before constructing hot resources", async () => {
		const caller = vi.fn(() => Promise.reject(new Error("CALLER_MUST_NOT_RUN")));
		await expect(
			openD110cARepeatCloseFixture({ creator: { createSnapshotStore: caller }, retainedControls: false })
		).rejects.toThrow("D110C_A_CALLER_SNAPSHOT_FACTORY_UNSUPPORTED");
		expect(caller).not.toHaveBeenCalled();
		expect(control.calls).toBe(0);
	});
	for (const fault of ["none", "sync-close", "nonconfigurable-primary", "blocked-delete", "error-delete"] as const) {
		it(`preserves construction failure and discharges captured owner: ${fault}`, async () => {
			let closeCalls = 0;
			let databaseName = "";
			const cleanupFailure = new Error("INTENTIONAL_CLOSE_FAILURE");
			if (fault === "nonconfigurable-primary")
				Object.defineProperty(control.error, "cleanupErrors", { value: "already-owned", configurable: false });
			const reporting = vi.spyOn(console, "error").mockImplementation(() => undefined);
			const nativeDelete = indexedDB.deleteDatabase.bind(indexedDB);
			const deleted: string[] = [];
			vi.spyOn(indexedDB, "deleteDatabase").mockImplementation((name) => {
				deleted.push(name);
				if (fault === "blocked-delete" || fault === "error-delete") {
					const target = new EventTarget();
					Object.defineProperty(target, "error", { value: new Error("INTENTIONAL_DELETE_FAILURE") });
					queueMicrotask(() => target.dispatchEvent(new Event(fault === "blocked-delete" ? "blocked" : "error")));
					return target as IDBOpenDBRequest;
				}
				return nativeDelete(name);
			});
			const factory: GenuineCreatorAdoptionFixtureModules["createBrowserSnapshotQuarantineStore"] = async (options) => {
				databaseName = `${options.primaryDatabaseName}--drp-snapshot-quarantine-v1`;
				const owner = await createBrowserSnapshotQuarantineStore(options);
				// The synchronous fault is in the returned closer, after releasing the actual native client.
				if (fault === "sync-close" || fault === "nonconfigurable-primary") await owner.close();
				return new Proxy({} as typeof owner, {
					get(_target, key): unknown {
						if (key === "close")
							return (): Promise<void> => {
								closeCalls += 1;
								if (fault === "sync-close" || fault === "nonconfigurable-primary") throw cleanupFailure;
								return owner.close();
							};
						return Reflect.get(owner, key, owner);
					},
				});
			};
			try {
				await expect(
					openD110cARepeatCloseFixture({
						retainedControls: false,
						creator: {
							modules: { createBrowserSnapshotQuarantineStore: factory } as GenuineCreatorAdoptionFixtureModules,
						},
					})
				).rejects.toBe(control.error);
				expect(control.calls).toBe(1);
				expect(closeCalls).toBe(1);
				expect(deleted).toEqual([databaseName]);
				if (fault === "none")
					expect((await indexedDB.databases()).some((row) => row.name === databaseName)).toBe(false);
				else if (fault === "nonconfigurable-primary") {
					expect(Reflect.get(control.error, "cleanupErrors")).toBe("already-owned");
					expect(reporting).toHaveBeenCalledOnce();
				} else expect(Reflect.get(control.error, "cleanupErrors")).toHaveLength(1);
			} finally {
				vi.restoreAllMocks();
				if (databaseName !== "")
					await new Promise<void>((resolve, reject) => {
						const request = nativeDelete(databaseName);
						request.onsuccess = (): void => resolve();
						request.onerror = (): void => reject(request.error);
						request.onblocked = (): void => reject(new Error("CONTROL_FINAL_CLEANUP_BLOCKED"));
					});
			}
		});
	}
});
