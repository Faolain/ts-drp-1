import { expect, test } from "@playwright/test";

test("native host floor participant: reopen is noncreating; scope/pin/adjacency and migration are exact", async ({
	page,
}, testInfo) => {
	await page.goto("/");
	const result = await page.evaluate(async () => {
		const modulePath = "/src/room-head.js";
		const { createBrowserRoomHeadAuthority: open } = await import(modulePath);
		const name = "host-floor-contract-" + crypto.randomUUID(),
			missing = name + "-missing";
		const scope = { objectId: "native-host-floor-object", pinnedGenesisAnchorDigest: "0".repeat(64) };
		const head = { objectId: scope.objectId, epoch: 0, currentAnchorDigest: scope.pinnedGenesisAnchorDigest };
		const before = await indexedDB.databases();
		let refusedMissing = false;
		try {
			await open({ databaseName: missing, initialization: { kind: "reopen" } });
		} catch {
			refusedMissing = true;
		}
		const missingWasCreated = (await indexedDB.databases()).some((d) => d.name === missing);
		const owner = await open({ databaseName: name, initialization: { kind: "create" } });
		const empty = await owner.read({ scope });
		const created = await owner.create({ scope, stable: head });
		const original = created.state;
		const wrongPin = await owner.read({ scope: { ...scope, pinnedGenesisAnchorDigest: "f".repeat(64) } });
		let badAdjacency = false;
		try {
			await owner.begin({
				scope,
				expected: original,
				next: { ...head, epoch: 2, currentAnchorDigest: "2".repeat(64) },
			});
		} catch {
			badAdjacency = true;
		}
		const unchanged = await owner.read({ scope });
		const begun = await owner.begin({
			scope,
			expected: original,
			next: { ...head, epoch: 1, currentAnchorDigest: "1".repeat(64) },
		});
		const staleCommit = await owner.commit({ scope, expected: original });
		const committed = await owner.commit({ scope, expected: begun.state });
		await owner.close();
		const reopen = await open({ databaseName: name, initialization: { kind: "reopen" } });
		const resumed = await reopen.read({ scope });
		const noReinitialize = await reopen.create({ scope, stable: head });
		await reopen.close();
		await new Promise<void>((resolve, reject) => {
			const r = indexedDB.deleteDatabase(name);
			r.onsuccess = (): void => resolve();
			r.onerror = (): void => reject(r.error);
		});
		return {
			beforeAbsent: !before.some((d) => d.name === missing),
			refusedMissing,
			missingWasCreated,
			empty,
			created,
			wrongPin,
			badAdjacency,
			unchanged,
			staleCommit,
			committed,
			resumed,
			noReinitialize,
		};
	});
	await testInfo.attach("native-host-floor-contract", {
		body: JSON.stringify(result),
		contentType: "application/json",
	});
	expect(result.beforeAbsent).toBe(true);
	expect(result.refusedMissing).toBe(true);
	expect(result.missingWasCreated).toBe(false);
	expect(result.empty).toEqual({ ok: true, state: null });
	expect(result.created.ok).toBe(true);
	expect(result.wrongPin).toEqual({ ok: false, reason: "conflict" });
	expect(result.badAdjacency).toBe(true);
	expect(result.unchanged).toEqual(result.created);
	expect(result.staleCommit).toEqual({ ok: false, reason: "conflict" });
	expect(result.committed.state.stable.epoch).toBe(1);
	expect(result.resumed).toEqual(result.committed);
	expect(result.noReinitialize).toEqual({ ok: false, reason: "conflict" });
});

test("native host floor participant: genuine held image excludes a foreign writer and exact CAS rejects its queued commit", async ({
	page,
}, testInfo) => {
	await page.goto("/");
	const result = await page.evaluate(async () => {
		const modulePath = "/src/room-head.js";
		const { createBrowserRoomHeadAuthority: open } = await import(modulePath);
		const name = "host-floor-held-" + crypto.randomUUID();
		const scope = { objectId: "native-host-floor-object", pinnedGenesisAnchorDigest: "0".repeat(64) };
		const head = { objectId: scope.objectId, epoch: 2, currentAnchorDigest: "2".repeat(64) };
		const request = <T>(r: IDBRequest<T>): Promise<T> =>
			new Promise((resolve, reject) => {
				r.onsuccess = (): void => resolve(r.result);
				r.onerror = (): void => reject(r.error);
			});
		const owner = await open({ databaseName: name, initialization: { kind: "migrate", head } });
		const initialized = await owner.migrate({ scope, stable: head });
		const observer = await owner.acquireRetirementControl({ scope });
		const foreign = await request(indexedDB.open(name, 1));
		let foreignFinished = false;
		const tx = foreign.transaction("floor", "readwrite", { durability: "strict" });
		const foreignDone = new Promise<void>((resolve, reject) => {
			tx.oncomplete = (): void => {
				foreignFinished = true;
				resolve();
			};
			tx.onabort = (): void => reject(tx.error);
		});
		// Real queued foreign RW increments the whole-floor state by a lawful begin/commit after the held view joins.
		const get = tx.objectStore("floor").get("record");
		get.onsuccess = (): void => {
			tx.objectStore("floor").put(get.result, "record");
		};
		const readBefore = await owner.read({ scope });
		const excludedWhileHeld = !foreignFinished;
		// Queue a second native connection's actual public floor CAS. It must run ahead of prepare's newly-created RW.
		const second = await open({ databaseName: name, initialization: { kind: "reopen" } });
		const write = second.begin({
			scope,
			expected: initialized.state,
			next: { ...head, epoch: 3, currentAnchorDigest: "3".repeat(64) },
		});
		// This read is queued, not yet admitted to a native request turn. Immediate revocation may reject it.
		const queuedRead = owner.read({ scope }).then(
			(value: unknown) => ({ ok: true, value }),
			(error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) })
		);
		let refusal = "";
		try {
			await observer.prepareFence({
				decisionDigest: "a".repeat(64),
				sourceProofDigest: "b".repeat(64),
				throughEpoch: 0,
			});
		} catch (error) {
			refusal = (error as Error).message;
		}
		const joinedQueuedRead = await queuedRead;
		await foreignDone;
		const foreignPublic = await write;
		const fresh = await second.acquireRetirementControl({ scope });
		const freshState = fresh.state,
			freshControl = fresh.control;
		await fresh.release();
		let releasedRefused = false;
		try {
			await fresh.prepareFence({ decisionDigest: "a".repeat(64), sourceProofDigest: "b".repeat(64), throughEpoch: 0 });
		} catch {
			releasedRefused = true;
		}
		foreign.close();
		await second.close();
		await owner.close();
		await request(indexedDB.deleteDatabase(name));
		return {
			excludedWhileHeld,
			readBefore,
			joinedQueuedRead,
			initialized,
			refusal,
			foreignPublic,
			freshState,
			freshControl,
			capturedControl: observer.control,
			releasedRefused,
		};
	});
	await testInfo.attach("native-host-floor-held-cas", {
		body: JSON.stringify(result),
		contentType: "application/json",
	});
	expect(result.excludedWhileHeld).toBe(true);
	expect(result.readBefore).toEqual(result.initialized);
	expect(result.joinedQueuedRead).toEqual({ ok: false, error: "NATIVE_READ_RESERVATION_RELEASED" });
	expect(result.refusal).toBe("ROOM_HEAD_CONTROL_STALE");
	expect(result.foreignPublic.ok).toBe(true);
	expect(result.freshState.pending.next.epoch).toBe(3);
	expect(result.freshControl.active).toBeNull();
	expect(result.freshControl.revision).toBe(result.capturedControl.revision + 1);
	expect(result.releasedRefused).toBe(true);
});

test("native host floor participant: lost-ACK readback resumes fences, rejects foreign commitments, preserves floor and permits future rollover", async ({
	page,
}, testInfo) => {
	await page.goto("/");
	const result = await page.evaluate(async () => {
		const modulePath = "/src/room-head.js";
		const { createBrowserRoomHeadAuthority: open } = await import(modulePath);
		const name = "host-floor-resume-" + crypto.randomUUID();
		const scope = { objectId: "native-host-floor-object", pinnedGenesisAnchorDigest: "0".repeat(64) };
		const head = { objectId: scope.objectId, epoch: 3, currentAnchorDigest: "3".repeat(64) };
		const commitment = { decisionDigest: "a".repeat(64), sourceProofDigest: "b".repeat(64), throughEpoch: 0 };
		const owner = await open({ databaseName: name, initialization: { kind: "migrate", head } });
		const initialized = await owner.migrate({ scope, stable: head });
		const original = await owner.acquireRetirementControl({ scope });
		let lostResponse = false;
		try {
			await original.prepareFence(commitment);
			throw new Error("TEST_ONLY_RESPONSE_LOST_AFTER_NATIVE_COMMIT");
		} catch (error) {
			lostResponse = (error as Error).message === "TEST_ONLY_RESPONSE_LOST_AFTER_NATIVE_COMMIT";
		}
		const fencedBegin = await owner.begin({
			scope,
			expected: initialized.state,
			next: { ...head, epoch: 4, currentAnchorDigest: "4".repeat(64) },
		});
		await owner.close();
		const restarted = await open({ databaseName: name, initialization: { kind: "reopen" } });
		const wrong = await restarted.acquireRetirementControl({ scope });
		const prepared = wrong.control;
		let wrongRefused = false;
		try {
			await wrong.commitPrepared({ ...commitment, sourceProofDigest: "c".repeat(64) });
		} catch (error) {
			wrongRefused = (error as Error).message === "ROOM_HEAD_FENCE_CONFLICT";
		}
		const resumed = await restarted.acquireRetirementControl({ scope });
		let committed = resumed.control;
		let commitLostResponse = false;
		try {
			committed = await resumed.commitPrepared(commitment);
			throw new Error("TEST_ONLY_COMMIT_RESPONSE_LOST_AFTER_NATIVE_COMMIT");
		} catch (error) {
			commitLostResponse = (error as Error).message === "TEST_ONLY_COMMIT_RESPONSE_LOST_AFTER_NATIVE_COMMIT";
		}
		await restarted.close();
		const committedRestart = await open({ databaseName: name, initialization: { kind: "reopen" } });
		const readback = await committedRestart.acquireRetirementControl({ scope });
		const committedReadback = readback.control;
		await readback.release();
		const floorAfter = await committedRestart.read({ scope });
		const begun = await committedRestart.begin({
			scope,
			expected: floorAfter.state,
			next: { ...head, epoch: 4, currentAnchorDigest: "4".repeat(64) },
		});
		const future = await committedRestart.commit({ scope, expected: begun.state });
		const fresh = await committedRestart.acquireRetirementControl({ scope });
		const finalControl = fresh.control;
		await fresh.release();
		const abortSource = await committedRestart.acquireRetirementControl({ scope });
		const later = { ...commitment, decisionDigest: "d".repeat(64), throughEpoch: 1 };
		await abortSource.prepareFence(later);
		const abortObservation = await committedRestart.acquireRetirementControl({ scope });
		const aborted = await abortObservation.abortPrepared(later);
		await committedRestart.close();
		await new Promise<void>((resolve, reject) => {
			const r = indexedDB.deleteDatabase(name);
			r.onsuccess = (): void => resolve();
			r.onerror = (): void => reject(r.error);
		});
		return {
			lostResponse,
			fencedBegin,
			wrongRefused,
			originalControl: original.control,
			prepared,
			committed,
			commitLostResponse,
			committedReadback,
			floorAfter,
			initialized,
			future,
			finalControl,
			aborted,
		};
	});
	await testInfo.attach("native-host-floor-resume", { body: JSON.stringify(result), contentType: "application/json" });
	expect(result.lostResponse).toBe(true);
	expect(result.fencedBegin).toEqual({ ok: false, reason: "conflict" });
	expect(result.wrongRefused).toBe(true);
	expect(result.prepared.incarnation).toBe(result.originalControl.incarnation);
	expect(result.prepared.active.sourceProofDigest).toBe("b".repeat(64));
	expect(result.committed.active).toBeNull();
	expect(result.committed.completed.throughEpoch).toBe(0);
	expect(result.commitLostResponse).toBe(true);
	expect(result.committedReadback).toEqual(result.committed);
	expect(result.floorAfter).toEqual(result.initialized);
	expect(result.future.state.stable.epoch).toBe(4);
	expect(result.finalControl.completed).toEqual(result.committed.completed);
	expect(result.aborted.active).toBeNull();
	expect(result.aborted.completed).toEqual(result.committed.completed);
});
