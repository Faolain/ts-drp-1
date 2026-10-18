import { expect, test } from "@playwright/test";

test("native host floor retirement binding preserves exact old prepared completed images through reopen", async ({
	page,
}, info) => {
	await page.goto("/");
	const result = await page.evaluate(async () => {
		const nativePath = "/src/room-head.js",
			contractPath = "/src/room-head-contract.js",
			canonicalPath = "/src/canonical.js";
		const { createBrowserRoomHeadAuthority: open } = await import(nativePath);
		const { captureRoomHeadRetirementPlan: plan, validateRoomHeadRetirementObservation: phase } = await import(
			contractPath
		);
		const { encodeCanonical, decodeCanonical } = await import(canonicalPath);
		const name = "host-floor-binding-" + crypto.randomUUID();
		const scope = { objectId: "native-floor-binding", pinnedGenesisAnchorDigest: "0".repeat(64) };
		const head = { objectId: scope.objectId, epoch: 4, currentAnchorDigest: "4".repeat(64) };
		// Mechanical labels only, not a cryptographic retirement eligibility proof.
		const prior = { decisionDigest: "a".repeat(64), sourceProofDigest: "b".repeat(64), throughEpoch: 1 };
		const selected = { decisionDigest: "c".repeat(64), sourceProofDigest: "d".repeat(64), throughEpoch: 2 };
		const request = <T>(r: IDBRequest<T>): Promise<T> =>
			new Promise((resolve, reject) => {
				r.onsuccess = (): void => resolve(r.result);
				r.onerror = (): void => reject(r.error);
			});
		const terminal = (tx: IDBTransaction): Promise<void> =>
			new Promise((resolve, reject) => {
				tx.oncomplete = (): void => resolve();
				tx.onabort = (): void => reject(tx.error);
			});
		const rawRead = async (): Promise<Uint8Array> => {
			const db = await request(indexedDB.open(name, 1));
			try {
				const tx = db.transaction("floor", "readonly"),
					done = terminal(tx);
				const value = await request(tx.objectStore("floor").get("record"));
				await done;
				return value;
			} finally {
				db.close();
			}
		};
		const rawWrite = async (bytes: Uint8Array): Promise<void> => {
			const db = await request(indexedDB.open(name, 1));
			try {
				const tx = db.transaction("floor", "readwrite", { durability: "strict" }),
					done = terminal(tx);
				tx.objectStore("floor").put(bytes, "record");
				await done;
			} finally {
				db.close();
			}
		};
		const refused = (call: () => unknown): boolean => {
			try {
				call();
				return false;
			} catch (error) {
				return error instanceof Error && error.message === "ROOM_HEAD_CONTROL_STALE";
			}
		};
		let owner = await open({ databaseName: name, initialization: { kind: "migrate", head } });
		try {
			const initialized = await owner.migrate({ scope, stable: head });
			const begun = await owner.begin({
				scope,
				expected: initialized.state,
				next: { ...head, epoch: 5, currentAnchorDigest: "5".repeat(64) },
			});
			const stateBytes = Array.from(encodeCanonical(begun.state));
			const priorPrepare = await owner.acquireRetirementControl({ scope });
			await priorPrepare.prepareFence(prior);
			const priorCommit = await owner.acquireRetirementControl({ scope });
			await priorCommit.commitPrepared(prior);
			const original = await owner.acquireRetirementControl({ scope });
			const planned = plan(original, selected);
			const oldPhase = phase(original, planned.binding),
				baseRevision = original.control.revision;
			const priorWasReal = original.control.completed.sourceProofDigest === prior.sourceProofDigest;
			await original.prepareFence(selected);
			const prepared = await owner.acquireRetirementControl({ scope });
			const preparedPhase = phase(prepared, planned.binding);
			const exactPrepared =
				prepared.imageDigest === planned.preparedImageDigest &&
				prepared.metadataBytes === planned.preparedMetadataBytes;
			const activeBindsWholeOld = prepared.control.active.imageDigest === planned.binding.oldImageDigest;
			const preparedBytes = await rawRead();
			await prepared.release();
			// Raw, canonically valid currency negative: alter only the discarded prior fence.
			const changedPrior = decodeCanonical(preparedBytes);
			changedPrior.control.completed.sourceProofDigest = "f".repeat(64);
			await rawWrite(encodeCanonical(changedPrior));
			const changed = await owner.acquireRetirementControl({ scope });
			const changedPriorRefused = refused(() => phase(changed, planned.binding));
			await changed.release();
			await rawWrite(preparedBytes);
			await owner.close();
			owner = await open({ databaseName: name, initialization: { kind: "reopen" } });
			const resumed = await owner.acquireRetirementControl({ scope });
			const reopenedPrepared = phase(resumed, planned.binding);
			await resumed.commitPrepared(selected);
			const completed = await owner.acquireRetirementControl({ scope });
			const completedPhase = phase(completed, planned.binding);
			const exactCompleted =
				completed.imageDigest === planned.binding.completedImageDigest &&
				completed.metadataBytes === planned.completedMetadataBytes;
			const revisionsExact = completed.control.revision === baseRevision + 2;
			const priorDiscarded =
				completed.control.completed.sourceProofDigest === selected.sourceProofDigest &&
				completed.control.active === null;
			const completedBytes = await rawRead();
			await completed.release();
			// Raw currency negative: unchanged retirement metadata does not forgive pending-floor drift.
			const changedFloor = decodeCanonical(completedBytes);
			changedFloor.state.pending.next.currentAnchorDigest = "7".repeat(64);
			await rawWrite(encodeCanonical(changedFloor));
			const changedState = await owner.acquireRetirementControl({ scope });
			const pendingDriftRefused = refused(() => phase(changedState, planned.binding));
			await changedState.release();
			await rawWrite(completedBytes);
			await owner.close();
			owner = await open({ databaseName: name, initialization: { kind: "reopen" } });
			const restored = await owner.acquireRetirementControl({ scope });
			const reopenedCompleted = phase(restored, planned.binding);
			const floorUnchanged = JSON.stringify(Array.from(encodeCanonical(restored.state))) === JSON.stringify(stateBytes);
			await restored.release();
			const future = await owner.commit({ scope, expected: begun.state });
			const futureView = await owner.acquireRetirementControl({ scope });
			const legitimateFutureInvalidatesOldBinding = refused(() => phase(futureView, planned.binding));
			await futureView.release();
			return {
				oldPhase,
				preparedPhase,
				completedPhase,
				reopenedPrepared,
				reopenedCompleted,
				priorWasReal,
				exactPrepared,
				exactCompleted,
				activeBindsWholeOld,
				changedPriorRefused,
				pendingDriftRefused,
				revisionsExact,
				priorDiscarded,
				floorUnchanged,
				future,
				legitimateFutureInvalidatesOldBinding,
				rawCurrencyNegatives: true,
				authenticatedEligibilityClaimed: false,
			};
		} finally {
			await owner.close();
			await new Promise<void>((resolve, reject) => {
				const r = indexedDB.deleteDatabase(name);
				r.onsuccess = (): void => resolve();
				r.onerror = (): void => reject(r.error);
				r.onblocked = (): void => reject(new Error("native floor owner not joined"));
			});
		}
	});
	await info.attach("native-host-floor-exact-binding", {
		body: JSON.stringify(result),
		contentType: "application/json",
	});
	expect(result).toMatchObject({
		oldPhase: "old",
		preparedPhase: "prepared",
		completedPhase: "completed",
		reopenedPrepared: "prepared",
		reopenedCompleted: "completed",
		priorWasReal: true,
		exactPrepared: true,
		exactCompleted: true,
		activeBindsWholeOld: true,
		changedPriorRefused: true,
		pendingDriftRefused: true,
		revisionsExact: true,
		priorDiscarded: true,
		floorUnchanged: true,
		future: { ok: true, state: { stable: { epoch: 5 }, pending: null } },
		legitimateFutureInvalidatesOldBinding: true,
		rawCurrencyNegatives: true,
		authenticatedEligibilityClaimed: false,
	});
});

test("native host floor participant: foreign incarnation CAS and explicit legacy migration are fail-closed", async ({
	page,
}, testInfo) => {
	await page.goto("/");
	const result = await page.evaluate(async () => {
		const modulePath = "/src/room-head.js",
			canonicalPath = "/src/canonical.js";
		const { createBrowserRoomHeadAuthority: open } = await import(modulePath);
		const { encodeCanonical, decodeCanonical } = await import(canonicalPath);
		const name = "host-floor-incarnation-" + crypto.randomUUID(),
			legacyName = name + "-legacy";
		const request = <T>(r: IDBRequest<T>): Promise<T> =>
			new Promise((resolve, reject) => {
				r.onsuccess = (): void => resolve(r.result);
				r.onerror = (): void => reject(r.error);
			});
		const scope = { objectId: "native-host-floor-object", pinnedGenesisAnchorDigest: "0".repeat(64) };
		const head = { objectId: scope.objectId, epoch: 3, currentAnchorDigest: "3".repeat(64) },
			state = { stable: head, pending: null };
		const owner = await open({ databaseName: name, initialization: { kind: "migrate", head } });
		await owner.migrate({ scope, stable: head });
		const observation = await owner.acquireRetirementControl({ scope });
		const foreign = await request(indexedDB.open(name, 1));
		const tx = foreign.transaction("floor", "readwrite", { durability: "strict" });
		const done = new Promise<void>((resolve, reject) => {
			tx.oncomplete = (): void => resolve();
			tx.onabort = (): void => reject(tx.error);
		});
		const get = tx.objectStore("floor").get("record");
		get.onsuccess = (): void => {
			const image = decodeCanonical(get.result);
			image.control.incarnation = "f".repeat(64);
			tx.objectStore("floor").put(encodeCanonical(image), "record");
		};
		let stale = "";
		try {
			await observation.prepareFence({
				decisionDigest: "a".repeat(64),
				sourceProofDigest: "b".repeat(64),
				throughEpoch: 0,
			});
		} catch (error) {
			stale = (error as Error).message;
		}
		await done;
		const fresh = await owner.acquireRetirementControl({ scope });
		const actual = fresh.control;
		await fresh.release();
		foreign.close();
		await owner.close();
		const legacyRequest = indexedDB.open(legacyName, 1);
		legacyRequest.onupgradeneeded = (): void => {
			legacyRequest.result.createObjectStore("floor");
		};
		const legacy = await request(legacyRequest);
		const legacyTx = legacy.transaction("floor", "readwrite", { durability: "strict" });
		const legacyDone = new Promise<void>((resolve, reject) => {
			legacyTx.oncomplete = (): void => resolve();
			legacyTx.onabort = (): void => reject(legacyTx.error);
		});
		legacyTx.objectStore("floor").put(scope, "scope");
		legacyTx.objectStore("floor").put(state, "state");
		await legacyDone;
		legacy.close();
		const reader = await open({ databaseName: legacyName, initialization: { kind: "reopen" } });
		const noImplicitMigrate = await reader.migrate({ scope, stable: head });
		await reader.close();
		const wrongMigration = await open({
			databaseName: legacyName,
			initialization: { kind: "migrate", head: { ...head, epoch: 4, currentAnchorDigest: "4".repeat(64) } },
		});
		const wrongResult = await wrongMigration.migrate({
			scope,
			stable: { ...head, epoch: 4, currentAnchorDigest: "4".repeat(64) },
		});
		await wrongMigration.close();
		const explicit = await open({ databaseName: legacyName, initialization: { kind: "migrate", head } });
		const migrated = await explicit.migrate({ scope, stable: head });
		const control = await explicit.acquireRetirementControl({ scope });
		const migratedControl = control.control;
		await control.release();
		await explicit.close();
		const inventory = await request(indexedDB.open(legacyName, 1));
		const keys = await request(inventory.transaction("floor", "readonly").objectStore("floor").getAllKeys());
		inventory.close();
		await request(indexedDB.deleteDatabase(name));
		await request(indexedDB.deleteDatabase(legacyName));
		return {
			stale,
			captured: observation.control,
			actual,
			noImplicitMigrate,
			wrongResult,
			migrated,
			state,
			migratedControl,
			keys,
		};
	});
	await testInfo.attach("native-host-floor-incarnation-migration", {
		body: JSON.stringify(result),
		contentType: "application/json",
	});
	expect(result.stale).toBe("ROOM_HEAD_CONTROL_STALE");
	expect(result.actual.incarnation).toBe("f".repeat(64));
	expect(result.actual.revision).toBe(result.captured.revision);
	expect(result.actual.active).toBeNull();
	expect(result.noImplicitMigrate).toEqual({ ok: false, reason: "conflict" });
	expect(result.wrongResult).toEqual({ ok: false, reason: "conflict" });
	expect(result.migrated).toEqual({ ok: true, state: result.state });
	expect(result.migratedControl.active).toBeNull();
	expect(result.keys).toEqual(["record"]);
});

test("native host floor participant: versionchange revokes held reads and owner close joins the same terminal work", async ({
	page,
}, testInfo) => {
	await page.goto("/");
	const result = await page.evaluate(async () => {
		const modulePath = "/src/room-head.js",
			{ createBrowserRoomHeadAuthority: open } = await import(modulePath);
		const name = "host-floor-close-" + crypto.randomUUID();
		const scope = { objectId: "native-host-floor-object", pinnedGenesisAnchorDigest: "0".repeat(64) };
		const head = { objectId: scope.objectId, epoch: 3, currentAnchorDigest: "3".repeat(64) };
		const owner = await open({ databaseName: name, initialization: { kind: "migrate", head } });
		await owner.migrate({ scope, stable: head });
		const held = await owner.acquireNativeReadReservation({ scope });
		const original = await owner.read({ scope });
		const upgrade = indexedDB.open(name, 2);
		const foreign = await new Promise<IDBDatabase>((resolve, reject) => {
			upgrade.onsuccess = (): void => resolve(upgrade.result);
			upgrade.onerror = (): void => reject(upgrade.error);
		});
		const a = owner.close(),
			b = owner.close();
		const sameClosePromise = a === b;
		await a;
		await b;
		let staleHeld = "",
			staleRead = "";
		try {
			await held.check();
		} catch (error) {
			staleHeld = (error as Error).message;
		}
		try {
			await owner.read({ scope });
		} catch (error) {
			staleRead = (error as Error).message;
		}
		await held.release();
		foreign.close();
		await new Promise<void>((resolve, reject) => {
			const r = indexedDB.deleteDatabase(name);
			r.onsuccess = (): void => resolve();
			r.onerror = (): void => reject(r.error);
		});
		return { original, sameClosePromise, staleHeld, staleRead };
	});
	await testInfo.attach("native-host-floor-versionchange-close", {
		body: JSON.stringify(result),
		contentType: "application/json",
	});
	expect(result.original.state.stable.epoch).toBe(3);
	expect(result.sameClosePromise).toBe(true);
	expect(result.staleHeld).toBe("NATIVE_READ_RESERVATION_RELEASED");
	expect(result.staleRead).toBe("ROOM_HEAD_CLOSED");
});

test("native host floor participant: existing 1024-unit Unicode scope remains admitted within bounded metadata", async ({
	page,
}, testInfo) => {
	await page.goto("/");
	const result = await page.evaluate(async () => {
		const modulePath = "/src/room-head.js",
			{ createBrowserRoomHeadAuthority: open } = await import(modulePath);
		const name = "host-floor-max-scope-" + crypto.randomUUID();
		const scope = { objectId: "\u0800".repeat(1024), pinnedGenesisAnchorDigest: "0".repeat(64) };
		const head = { objectId: scope.objectId, epoch: 3, currentAnchorDigest: "3".repeat(64) };
		const owner = await open({ databaseName: name, initialization: { kind: "migrate", head } });
		const initialized = await owner.migrate({ scope, stable: head });
		const begin = await owner.begin({
			scope,
			expected: initialized.state,
			next: { ...head, epoch: 4, currentAnchorDigest: "4".repeat(64) },
		});
		const observation = await owner.acquireRetirementControl({ scope });
		const beforeBytes = observation.metadataBytes;
		await observation.prepareFence({
			decisionDigest: "a".repeat(64),
			sourceProofDigest: "b".repeat(64),
			throughEpoch: 0,
		});
		const prepared = await owner.acquireRetirementControl({ scope });
		const afterBytes = prepared.metadataBytes;
		const committed = await prepared.commitPrepared({
			decisionDigest: "a".repeat(64),
			sourceProofDigest: "b".repeat(64),
			throughEpoch: 0,
		});
		const final = await owner.read({ scope });
		await owner.close();
		await new Promise<void>((resolve, reject) => {
			const r = indexedDB.deleteDatabase(name);
			r.onsuccess = (): void => resolve();
			r.onerror = (): void => reject(r.error);
		});
		return {
			beforeBytes,
			afterBytes,
			equalState: JSON.stringify(final) === JSON.stringify(begin),
			units: final.state.stable.objectId.length,
			completed: committed.completed,
		};
	});
	await testInfo.attach("native-host-floor-max-scope", {
		body: JSON.stringify(result),
		contentType: "application/json",
	});
	expect(result.units).toBe(1024);
	expect(result.equalState).toBe(true);
	expect(result.beforeBytes).toBeLessThanOrEqual(16384);
	expect(result.afterBytes).toBeLessThanOrEqual(16384);
	expect(result.completed.throughEpoch).toBe(0);
});

test("native host floor participant: aborted native capture preserves its primary and joined cleanup errors", async ({
	page,
}, testInfo) => {
	await page.goto("/");
	const result = await page.evaluate(async () => {
		const modulePath = "/src/room-head.js",
			{ createBrowserRoomHeadAuthority: open } = await import(modulePath);
		const name = "host-floor-abort-" + crypto.randomUUID();
		const scope = { objectId: "native-host-floor-object", pinnedGenesisAnchorDigest: "0".repeat(64) };
		const head = { objectId: scope.objectId, epoch: 3, currentAnchorDigest: "3".repeat(64) };
		const owner = await open({ databaseName: name, initialization: { kind: "migrate", head } });
		await owner.migrate({ scope, stable: head });
		const originalGet = IDBObjectStore.prototype.get;
		let abortNext = true,
			observed: unknown;
		IDBObjectStore.prototype.get = function (this: IDBObjectStore, query: IDBValidKey | IDBKeyRange): IDBRequest {
			const r = originalGet.call(this, query);
			if (query === "record" && abortNext) {
				abortNext = false;
				this.transaction.abort();
			}
			return r;
		};
		try {
			await owner.acquireRetirementControl({ scope });
		} catch (error) {
			observed = error;
		} finally {
			IDBObjectStore.prototype.get = originalGet;
		}
		const aggregate = observed instanceof AggregateError ? observed : undefined;
		const preserved = aggregate !== undefined && aggregate.cause === aggregate.errors[0];
		const errors = aggregate
			? aggregate.errors.map((error: Error) => ({ name: error.name, message: error.message }))
			: [];
		await owner.close().catch(() => undefined);
		await new Promise<void>((resolve, reject) => {
			const r = indexedDB.deleteDatabase(name);
			r.onsuccess = (): void => resolve();
			r.onerror = (): void => reject(r.error);
		});
		return { abortReached: !abortNext, aggregate: aggregate !== undefined, preserved, errors };
	});
	await testInfo.attach("native-host-floor-capture-abort", {
		body: JSON.stringify(result),
		contentType: "application/json",
	});
	expect(result.abortReached).toBe(true);
	expect(result.aggregate).toBe(true);
	expect(result.preserved).toBe(true);
	expect(result.errors).toHaveLength(2);
	expect(result.errors[0].name).toBe("AbortError");
});
