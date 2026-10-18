import { type AnchorCase, anchorMaterial } from "./material.js";
import { type NativeAccess, recoverAnchorCase } from "./scenarios.js";
import { encodeCanonical } from "../../../packages/canonical/dist/src/index.js";
import {
	journalRetirementFrameDigest,
	type LiveJournalRetirementControlRead,
	type LiveJournalRetirementImageObservation,
	journalRetirementImage,
	LIVE_JOURNAL_RETIREMENT_LIMITS,
} from "../../../packages/live-journal/dist/src/index.js";
import { createBrowserDurableLiveJournalStore } from "../../../packages/storage-browser/dist/src/live-journal.js";
import archived from "../phase-3a1b-p4/material.json" with { type: "json" };

function openRaw(name: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(`${name}--drp-live-journal-v1`);
		request.onsuccess = (): void => resolve(request.result);
		request.onerror = (): void => reject(request.error);
		request.onupgradeneeded = (): void => {
			request.transaction?.abort();
			reject(new Error("raw observation must not create"));
		};
	});
}

function terminal(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = (): void => resolve();
		transaction.onabort = (): void => reject(transaction.error ?? new Error("native transaction aborted"));
		transaction.onerror = (): void => reject(transaction.error);
	});
}

async function census(name: string): Promise<unknown> {
	const database = await openRaw(name);
	try {
		const transaction = database.transaction(["scopes", "acceptedEntries"], "readonly");
		const done = terminal(transaction);
		const scopes = transaction.objectStore("scopes").getAll();
		const entries = transaction.objectStore("acceptedEntries").getAll();
		await done;
		return { entries: entries.result, scopes: scopes.result };
	} finally {
		database.close();
	}
}

async function mutate(name: string, id: AnchorCase, change: Parameters<NativeAccess["mutate"]>[0]): Promise<void> {
	const material = anchorMaterial(id === "non-genesis" ? 1 : 0);
	const key = [material.scope.objectId, material.scope.epoch, material.scope.anchorDigest];
	const database = await openRaw(name);
	try {
		const transaction = database.transaction("scopes", "readwrite", { durability: "strict" });
		const done = terminal(transaction);
		const store = transaction.objectStore("scopes");
		if (change === "delete") store.delete(key);
		else {
			const request = store.get(key);
			request.onsuccess = (): void => {
				const row = request.result as Record<string, unknown> | undefined;
				const value = row ?? {
					...material.scope,
					nextJournalSequence: 0,
					parametersDigest: material.scope.anchorDigest,
					detachedAnchorSignature: material.install.detachedAnchorSignature,
					exactCanonicalParametersCarrierBytes: material.install.exactCanonicalParametersCarrierBytes,
				};
				if (change === "unrelated-carriers") {
					value.detachedAnchorSignature = new Uint8Array(8193);
					value.exactCanonicalParametersCarrierBytes = "not-parameters";
					value.nextJournalSequence = -1;
				} else if (change === "scope") {
					const epochOne = anchorMaterial(1);
					store.delete(key);
					value.anchorDigest = epochOne.scope.anchorDigest;
					value.exactCanonicalAnchorPreimageBytes = epochOne.bytes;
				} else
					value.exactCanonicalAnchorPreimageBytes =
						change === "oversize"
							? new Uint8Array(8193).fill(7)
							: change === "empty"
								? new Uint8Array()
								: change === "non-byte"
									? "not-bytes"
									: change === "noncanonical"
										? Uint8Array.of(...material.bytes, 0)
										: change === "replacement"
											? Uint8Array.of(0)
											: anchorMaterial(0, { aclDigest: "9".repeat(64) }).bytes;
				store.put(value);
			};
		}
		await done;
	} finally {
		database.close();
	}
}

async function observe(
	call: () => Promise<unknown>,
	mode?: "failure" | "close-executing"
): Promise<{ result: unknown; trace: readonly unknown[] }> {
	const trace: unknown[] = [];
	const transaction = IDBDatabase.prototype.transaction;
	const originals = new Map<string, (...args: unknown[]) => unknown>();
	IDBDatabase.prototype.transaction = function (stores, access, options): IDBTransaction {
		const names = typeof stores === "string" ? stores : Array.from(stores);
		const created = transaction.call(this, names, access, options);
		trace.push({ mode: created.mode, stores: Array.from(created.objectStoreNames), operation: "transaction" });
		created.addEventListener("complete", () => trace.push({ operation: "complete" }));
		created.addEventListener("abort", () => trace.push({ operation: "abort" }));
		return created;
	};
	for (const name of [
		"get",
		"getKey",
		"getAll",
		"getAllKeys",
		"openCursor",
		"openKeyCursor",
		"count",
		"put",
		"add",
		"delete",
		"clear",
	] as const) {
		const original = IDBObjectStore.prototype[name] as (...args: unknown[]) => unknown;
		originals.set(name, original);
		(IDBObjectStore.prototype as unknown as Record<string, unknown>)[name] = function (
			this: IDBObjectStore,
			...args: unknown[]
		): unknown {
			trace.push({ operation: name, store: this.name, key: args[0] });
			const request = original.apply(this, args);
			if (mode === "failure") {
				mode = undefined;
				this.transaction.abort();
			}
			return request;
		};
	}
	try {
		return { result: await call(), trace };
	} finally {
		IDBDatabase.prototype.transaction = transaction;
		for (const [name, original] of originals)
			(IDBObjectStore.prototype as unknown as Record<string, unknown>)[name] = original;
	}
}

declare global {
	interface Window {
		journalAnchorSetup(name: string, id: AnchorCase): Promise<unknown>;
		journalAnchorRecover(name: string, id: AnchorCase): Promise<unknown>;
		journalAnchorControl(name: string, id: AnchorCase): Promise<unknown>;
		journalAnchorGetKeyControl(name: string): Promise<unknown>;
		journalRetirementExactRows(name: string): Promise<unknown>;
		journalRetirementSourceImage(name: string): Promise<unknown>;
		journalAnchorRemove(name: string): Promise<void>;
	}
}

// Mechanical native capture only; archived signatures are not external authentication.
window.journalRetirementSourceImage = async (name): Promise<unknown> => {
	const owner = await createBrowserDurableLiveJournalStore({ primaryDatabaseName: name });
	const readRetirementImage = owner.readRetirementImage,
		acquireRetirementControl = owner.acquireRetirementControl;
	if (readRetirementImage === undefined || acquireRetirementControl === undefined) {
		await owner.close();
		throw new Error("native journal source port missing");
	}
	const material = anchorMaterial(0);
	const database = await openRaw(name);
	let held: Awaited<ReturnType<typeof owner.acquireNativeReadReservation>> | undefined;
	const must = <T>(result: { ok: true; value: T } | { ok: false }): T => {
		if (!result.ok) throw new Error("native journal source capture failed");
		return result.value;
	};
	try {
		const absent = await readRetirementImage.call(owner, { objectId: material.scope.objectId });
		if (!(await owner.installGenesis(material.install)).ok) throw new Error("native journal source install failed");
		const beforeTx = database.transaction(["scopes", "retirementControls"], "readonly");
		const beforeDone = terminal(beforeTx);
		const sr = beforeTx.objectStore("scopes").getAll(),
			sk = beforeTx.objectStore("scopes").getAllKeys(),
			cr = beforeTx.objectStore("retirementControls").count();
		await beforeDone;
		const scopes = sr.result as Record<string, unknown>[];
		const expected = scopes.map((row, i) => encodeCanonical(["scopes", sk.result[i], row]));
		const equal = (rows: readonly Uint8Array[]): boolean =>
			rows.length === expected.length &&
			rows.every(
				(frame, i) => frame.length === expected[i]?.length && frame.every((byte, j) => byte === expected[i]?.[j])
			);
		held = await owner.acquireNativeReadReservation({ objectId: material.scope.objectId });
		const observed = await observe(() => readRetirementImage.call(owner, { objectId: material.scope.objectId }));
		const source = must(observed.result as Awaited<ReturnType<typeof readRetirementImage>>);
		const exact = equal(source.canonicalRows);
		const originalImage = JSON.stringify(source.image) === JSON.stringify(journalRetirementImage(scopes, []));
		const underHeldControl = await acquireRetirementControl.call(owner, { objectId: material.scope.objectId });
		source.canonicalRows[0]?.fill(0);
		const detached = equal(
			must(await readRetirementImage.call(owner, { objectId: material.scope.objectId })).canonicalRows
		);
		await held.check();
		await held.release();
		held = undefined;
		const controlsTx = database.transaction("retirementControls", "readonly");
		const controlsDone = terminal(controlsTx),
			controls = controlsTx.objectStore("retirementControls").count();
		await controlsDone;
		const born = must(await acquireRetirementControl.call(owner, { objectId: material.scope.objectId }));
		const after = must(await readRetirementImage.call(owner, { objectId: material.scope.objectId }));
		const birthPreserved =
			JSON.stringify(born.image) === JSON.stringify(source.image) &&
			JSON.stringify(after.control) === JSON.stringify(born.control) &&
			equal(after.canonicalRows);
		await born.release();
		// Deliberate raw oversized native row: a failed borrowed read must not
		// abort or release the caller's original reservation.
		const change = async (row: Record<string, unknown>): Promise<void> => {
			const tx = database.transaction("scopes", "readwrite", { durability: "strict" });
			const done = terminal(tx);
			tx.objectStore("scopes").put(row);
			await done;
		};
		const original = scopes[0];
		if (original === undefined) throw new Error("native journal source row missing");
		await change({ ...original, exactCanonicalParametersCarrierBytes: new Uint8Array(262_145) });
		held = await owner.acquireNativeReadReservation({ objectId: material.scope.objectId });
		const oversize = await readRetirementImage.call(owner, { objectId: material.scope.objectId });
		await held.check();
		await held.release();
		held = undefined;
		await change(original);
		await change({ ...original, parametersDigest: "\ud800" });
		held = await owner.acquireNativeReadReservation({ objectId: material.scope.objectId });
		const malformed = await readRetirementImage.call(owner, { objectId: material.scope.objectId });
		await held.check();
		await held.release();
		held = undefined;
		await change(original);
		const restored = must(await readRetirementImage.call(owner, { objectId: material.scope.objectId }));
		return {
			absent,
			exact,
			originalImage,
			detached,
			frozen: Object.isFrozen(source) && Object.isFrozen(source.canonicalRows),
			controlAbsent: source.control === null && cr.result === 0 && controls.result === 0,
			readOnlyBorrowed: !observed.trace.some((v) =>
				["transaction", "put", "add", "delete", "clear", "abort", "complete"].includes(
					String((v as { operation: unknown }).operation)
				)
			),
			underHeldControl,
			birthPreserved,
			oversize,
			malformed,
			failedBorrowedReadDidNotRelease: true,
			restored: JSON.stringify(restored.image) === JSON.stringify(source.image) && equal(restored.canonicalRows),
		};
	} finally {
		await held?.release();
		database.close();
		await owner.close();
	}
};

// Mechanical native capture only; archived signatures are not external authentication.
window.journalRetirementExactRows = async (name): Promise<unknown> => {
	const owner = await createBrowserDurableLiveJournalStore({ primaryDatabaseName: name });
	const current = anchorMaterial(0),
		next = anchorMaterial(1);
	const must = <T>(result: { ok: true; value: T } | { ok: false }): T => {
		if (!result.ok) throw new Error("native journal retirement capture failed");
		return result.value;
	};
	const requireSuccess = (result: { ok: boolean }): void => {
		if (!result.ok) throw new Error("native journal retirement fixture mutation failed");
	};
	const refuses = (call: () => unknown, message: string): boolean => {
		try {
			call();
			return false;
		} catch (error) {
			return error instanceof Error && error.message === message;
		}
	};
	try {
		requireSuccess(await owner.installGenesis(current.install));
		requireSuccess(await owner.installEpochAnchor(next.install));
		requireSuccess(
			await owner.appendAccepted({
				scope: current.scope,
				sourceKind: "received",
				vertexDigest: archived.vertexDigest,
				exactCanonicalPreimageBytes: Uint8Array.from(archived.vertexHex.match(/../gu) ?? [], (part) =>
					parseInt(part, 16)
				),
				detachedSignature: current.install.detachedAnchorSignature,
			})
		);
		const capture = must(await owner.acquireRetirementControl({ objectId: current.scope.objectId }));
		const database = await openRaw(name);
		let scopes: Record<string, unknown>[], rows: Record<string, unknown>[], keys: IDBValidKey[][];
		try {
			const transaction = database.transaction(["scopes", "acceptedEntries"], "readonly");
			const done = terminal(transaction);
			const scopeStore = transaction.objectStore("scopes"),
				rowStore = transaction.objectStore("acceptedEntries");
			const sr = scopeStore.getAll(),
				rr = rowStore.getAll(),
				sk = scopeStore.getAllKeys(),
				rk = rowStore.getAllKeys();
			await done;
			scopes = sr.result;
			rows = rr.result;
			keys = [sk.result, rk.result];
		} finally {
			database.close();
		}
		const expected = [
			...scopes.map((row, i) => encodeCanonical(["scopes", keys[0]?.[i], row])),
			...rows.map((row, i) => encodeCanonical(["acceptedEntries", keys[1]?.[i], row])),
		];
		const equal = (a: readonly Uint8Array[], b: readonly Uint8Array[]): boolean =>
			a.length === b.length &&
			a.every((frame, i) => frame.length === b[i]?.length && frame.every((byte, j) => byte === b[i]?.[j]));
		const exact = equal(capture.readExactCanonicalRows(), expected);
		const originalImageUnchanged =
			JSON.stringify(capture.image) === JSON.stringify(journalRetirementImage(scopes, rows));
		const returned = capture.readExactCanonicalRows(),
			frozen = Object.isFrozen(returned);
		returned[0]?.fill(0);
		const detached = equal(capture.readExactCanonicalRows(), expected);
		const receiverRefused = refuses(() => capture.readExactCanonicalRows.call({}), "malformed-input");
		await capture.release();
		const releasedRefused = refuses(() => capture.readExactCanonicalRows(), "retirement-released");
		const stale = must(await owner.acquireRetirementControl({ objectId: current.scope.objectId }));
		requireSuccess(
			await owner.appendAccepted({
				scope: next.scope,
				sourceKind: "local-issued",
				author: "creator",
				authorSequence: 0,
				vertexDigest: "a".repeat(64),
			})
		);
		const staleResult = await stale.prepareFence({
			decisionDigest: "b".repeat(64),
			sourceProofDigest: "c".repeat(64),
			throughEpoch: 1,
			protectedScopes: [current.scope, next.scope],
		});
		const consumedRefused = refuses(() => stale.readExactCanonicalRows(), "retirement-released");
		await stale.release();
		return {
			exact,
			originalImageUnchanged,
			frozen,
			detached,
			receiverRefused,
			releasedRefused,
			consumedRefused,
			staleResult,
			nativeCounts: { scopes: scopes.length, rows: rows.length },
			finalCensus: await census(name),
		};
	} finally {
		await owner.close();
	}
};

window.journalAnchorSetup = async (name, id): Promise<unknown> => {
	const material = anchorMaterial(id === "non-genesis" ? 1 : 0);
	const owner = await createBrowserDurableLiveJournalStore({ primaryDatabaseName: name });
	let installed;
	try {
		installed = await (material.scope.epoch === 0
			? owner.installGenesis(material.install)
			: owner.installEpochAnchor(material.install));
	} finally {
		await owner.close();
	}
	return { census: await census(name), installed, expectedScope: material.scope, realm: performance.timeOrigin };
};
window.journalAnchorRecover = async (name, id): Promise<unknown> => {
	const native: NativeAccess = {
		census: () => census(name),
		mutate: (change) => mutate(name, id, change),
		observe,
		open: () => createBrowserDurableLiveJournalStore({ primaryDatabaseName: name }),
	};
	return { ...(await recoverAnchorCase(native, id)), realm: performance.timeOrigin };
};
window.journalAnchorControl = async (name, id): Promise<unknown> => {
	const material = anchorMaterial(id === "non-genesis" ? 1 : 0);
	const initial = (await census(name)) as { scopes: Record<string, unknown>[]; entries: unknown[] };
	const before = Array.from(initial.scopes[0]?.exactCanonicalAnchorPreimageBytes as Uint8Array);
	await mutate(name, id, "oversize");
	const oversized = (await census(name)) as { scopes: Record<string, unknown>[] };
	const nativeBytes = oversized.scopes[0]?.exactCanonicalAnchorPreimageBytes as Uint8Array;
	return {
		before,
		expectedBytes: Array.from(material.bytes),
		nativeLength: nativeBytes.length,
		entries: initial.entries.length,
		realm: performance.timeOrigin,
		qualification: "actual native IDB whole-row clone; not accessor GREEN",
	};
};
window.journalAnchorGetKeyControl = async (name): Promise<unknown> => {
	const material = anchorMaterial();
	const key = [material.scope.objectId, material.scope.epoch, material.scope.anchorDigest];
	const range = IDBKeyRange.bound(
		[material.scope.objectId, material.scope.epoch],
		[material.scope.objectId, material.scope.epoch, []]
	);
	const database = await openRaw(name);
	const originalGet = IDBObjectStore.prototype.get;
	const originalGetKey = IDBObjectStore.prototype.getKey;
	const originalTransaction = IDBDatabase.prototype.transaction;
	const query = async (): Promise<unknown> => {
		const transaction = database.transaction("scopes", "readonly");
		const done = terminal(transaction);
		const store = transaction.objectStore("scopes");
		const exact = store.get(key);
		const occupancy = store.getKey(range);
		let successes = 0;
		for (const request of [exact, occupancy]) request.addEventListener("success", () => successes++);
		const nativeRequests = [exact, occupancy].every(
			(request) => request instanceof IDBRequest && request.source === store && request.transaction === transaction
		);
		await done;
		return {
			exactBytes: Array.from(
				(exact.result as { exactCanonicalAnchorPreimageBytes: Uint8Array }).exactCanonicalAnchorPreimageBytes
			),
			occupancyKey: occupancy.result,
			nativeRequests,
			readyStates: [exact.readyState, occupancy.readyState],
			successes,
			terminal: "complete",
		};
	};
	try {
		const baseline = await query();
		const observed = await observe(query);
		return {
			baseline,
			observed: observed.result,
			traces: observed.trace,
			key,
			expectedBytes: Array.from(material.bytes),
			rangeArgumentSame: observed.trace.some(
				(entry) =>
					(entry as { operation: string; key: unknown }).operation === "getKey" &&
					(entry as { key: unknown }).key === range
			),
			prototypesRestored:
				IDBObjectStore.prototype.get === originalGet &&
				IDBObjectStore.prototype.getKey === originalGetKey &&
				IDBDatabase.prototype.transaction === originalTransaction,
			realm: performance.timeOrigin,
		};
	} finally {
		database.close();
	}
};
window.journalAnchorRemove = (name): Promise<void> =>
	new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase(`${name}--drp-live-journal-v1`);
		request.onsuccess = (): void => resolve();
		request.onerror = (): void => reject(request.error);
		request.onblocked = (): void => reject(new Error("fixture leaked an owner"));
	});

// Exact native no-op revision law only; original fixture carriers do not grant cryptographic authority.
declare global {
	interface Window {
		journalRetirementNoops(name: string): Promise<unknown>;
	}
}
window.journalRetirementNoops = async (name): Promise<unknown> => {
	const owner = await createBrowserDurableLiveJournalStore({ primaryDatabaseName: name });
	const materials = [0, 1, 2, 3, 4].map((epoch) => anchorMaterial(epoch));
	const material = (epoch: number): ReturnType<typeof anchorMaterial> => {
		const selected = materials[epoch];
		if (selected === undefined) throw new Error("missing original journal material");
		return selected;
	};
	const objectId = material(0).scope.objectId;
	const row = (epoch: number, sequence: number) => ({
		scope: material(epoch).scope,
		sourceKind: "local-issued" as const,
		author: "c".repeat(64),
		authorSequence: sequence,
		vertexDigest: sequence.toString(16).padStart(64, "0"),
	});
	const read = owner.readRetirementImage,
		acquire = owner.acquireRetirementControl;
	if (read === undefined || acquire === undefined) {
		await owner.close();
		throw new Error("original native journal retirement port missing");
	}
	const successful = <T extends { readonly ok: boolean }>(result: T): T => {
		if (!result.ok) throw new Error("original native journal operation failed: " + JSON.stringify(result));
		return result;
	};
	const snapshot = async () => {
		const result = await read.call(owner, { objectId });
		if (!result.ok) throw new Error("original native journal image capture failed: " + result.kind);
		return result.value;
	};
	const capture = async () => {
		const result = await acquire.call(owner, { objectId });
		if (!result.ok) throw new Error("original native journal control capture failed: " + result.kind);
		return result.value;
	};
	const exact = (actual: unknown, expected: unknown, label: string): void => {
		const a = encodeCanonical(actual),
			b = encodeCanonical(expected);
		if (a.length !== b.length || !a.every((byte, i) => byte === b[i]))
			throw new Error("journal no-op oracle: " + label);
	};
	const transitions: unknown[] = [],
		noops: string[] = [],
		refusals: string[] = [];
	const images: Record<string, unknown> = {};
	let primary: { name: string; message: string } | undefined;
	let cleanup: PromiseSettledResult<void>[] = [];
	try {
		successful(await owner.installGenesis(material(0).install));
		successful(await owner.installEpochAnchor(material(1).install));
		successful(await owner.appendAccepted(row(0, 0)));
		const birth = await capture();
		try {
			if (birth.control.revision !== 0 || birth.control.sequence !== 0)
				throw new Error("journal fixture must start with actual present idle control0");
		} finally {
			await birth.release();
		}
		const initial = await snapshot();
		if (initial.control === null) throw new Error("journal fixture must have actual native control");
		images.initial = initial;
		const retries = [
			["genesis", () => owner.installGenesis(material(0).install)],
			["epoch-anchor", () => owner.installEpochAnchor(material(1).install)],
			["historical-import", () => owner.importHistoricalAnchor({ envelope: material(1).install, maxBytes: 8192 })],
			["append", () => owner.appendAccepted(row(0, 0))],
		] as const;
		for (const [label, retry] of retries) {
			const result = await retry();
			if (!result.ok || !result.idempotent) throw new Error("journal retry was not exact idempotent: " + label);
			exact(await snapshot(), initial, label + " preserves complete control, native frames and image");
			noops.push(label);
		}
		const real = async (
			label: string,
			mutate: () => Promise<{ readonly ok: boolean }>,
			scopes: number,
			rows: number
		): Promise<void> => {
			const before = await snapshot();
			successful(await mutate());
			const after = await snapshot();
			if (before.control === null || after.control === null) throw new Error("journal control unexpectedly absent");
			if (after.control.revision !== before.control.revision + 1)
				throw new Error("journal real write must advance exactly once: " + label);
			exact({ ...after.control, revision: before.control.revision }, before.control, label + " changes only revision");
			if (after.image.scopeCount !== scopes || after.image.rowCount !== rows)
				throw new Error("journal real write did not produce exact native row counts: " + label);
			transitions.push({ label, before: before.control.revision, after: after.control.revision, scopes, rows });
		};
		await real("append-new", () => owner.appendAccepted(row(0, 1)), 2, 2);
		await real("install-new", () => owner.installEpochAnchor(material(2).install), 3, 2);
		await real(
			"import-new",
			() => owner.importHistoricalAnchor({ envelope: material(3).install, maxBytes: 8192 }),
			4,
			2
		);
		await real("append-protected", () => owner.appendAccepted(row(2, 2)), 4, 3);
		images.beforeFence = await snapshot();
		const fence = await capture();
		try {
			successful(
				await fence.prepareFence({
					decisionDigest: "a".repeat(64),
					sourceProofDigest: "b".repeat(64),
					throughEpoch: 3,
					protectedScopes: [material(2).scope],
				})
			);
		} finally {
			await fence.release();
		}
		const prepared = await snapshot();
		images.prepared = prepared;
		for (const [label, retry] of retries) {
			exact(await retry(), { ok: false, kind: "retirement-fenced" }, label + " keeps original admission fence");
			exact(await snapshot(), prepared, label + " fenced retry preserves whole native state");
			refusals.push(label);
		}
		await real("future-install", () => owner.installEpochAnchor(material(4).install), 5, 3);
		images.final = await snapshot();
	} catch (error) {
		primary =
			error instanceof Error
				? { name: error.name, message: error.message }
				: { name: "unknown", message: String(error) };
	} finally {
		cleanup = await Promise.allSettled([owner.close()]);
	}

	return {
		passed: primary === undefined && cleanup.every((entry) => entry.status === "fulfilled"),
		primary,
		noops,
		transitions,
		refusals,
		images,
		cleanup,
		cryptoAuthority: false,
		physicalDeletion: false,
	};
};

// Storage-admitted fixture signatures test native mechanics, not protocol eligibility.
declare global {
	interface Window {
		journalPhysicalHeaderBounds(name: string): Promise<unknown>;
	}
}
window.journalPhysicalHeaderBounds = async (name): Promise<unknown> => {
	let owner = await createBrowserDurableLiveJournalStore({ primaryDatabaseName: name });
	const materials = Array.from({ length: 8 }, (_, epoch) => anchorMaterial(epoch));
	const first = anchorMaterial(0);
	const selector = { objectId: first.scope.objectId };
	const database = await openRaw(name);
	const request = <T>(value: IDBRequest<T>): Promise<T> =>
		new Promise((resolve, reject) => {
			value.onsuccess = (): void => resolve(value.result);
			value.onerror = (): void => reject(value.error);
		});
	const native = async (): Promise<{
		scopeKeys: IDBValidKey[];
		scopes: Record<string, unknown>[];
		rowKeys: IDBValidKey[];
		rows: Record<string, unknown>[];
		controls: unknown[];
	}> => {
		const tx = database.transaction(["scopes", "acceptedEntries", "retirementControls"], "readonly");
		const done = terminal(tx);
		const scopes = tx.objectStore("scopes"),
			rows = tx.objectStore("acceptedEntries"),
			controls = tx.objectStore("retirementControls");
		const values = await Promise.all([
			request(scopes.getAllKeys()),
			request(scopes.getAll()),
			request(rows.getAllKeys()),
			request(rows.getAll()),
			request(controls.getAll()),
		]);
		await done;
		return {
			scopeKeys: values[0],
			scopes: values[1] as Record<string, unknown>[],
			rowKeys: values[2],
			rows: values[3] as Record<string, unknown>[],
			controls: values[4],
		};
	};
	const exact = (actual: unknown, expected: unknown, label: string): void => {
		const a = encodeCanonical(actual),
			b = encodeCanonical(expected);
		if (a.length !== b.length || !a.every((byte, index) => byte === b[index]))
			throw new Error("physical header bounds oracle: " + label);
	};
	const successful = (result: { readonly ok: boolean }): void => {
		if (!result.ok) throw new Error("original native journal mutation failed: " + JSON.stringify(result));
	};
	const read = async (): Promise<LiveJournalRetirementImageObservation> => {
		if (owner.readRetirementImage === undefined) throw new Error("original journal image port missing");
		const result = await owner.readRetirementImage(selector);
		if (!result.ok) throw new Error("native journal image refused: " + result.kind);
		return result.value;
	};
	const acquire = async (): Promise<LiveJournalRetirementControlRead> => {
		if (owner.acquireRetirementControl === undefined) throw new Error("original journal control port missing");
		const result = await owner.acquireRetirementControl(selector);
		if (!result.ok) throw new Error("native journal control refused: " + result.kind);
		return result.value;
	};
	const refused = async (label: string): Promise<void> => {
		if (owner.readRetirementImage === undefined) throw new Error("original journal image port missing");
		exact(await owner.readRetirementImage(selector), { ok: false, kind: "retirement-fenced" }, label);
	};
	const count = async (table: string): Promise<number> => {
		const tx = database.transaction(table, "readonly"),
			done = terminal(tx);
		const value = await request(tx.objectStore(table).count());
		await done;
		return value;
	};
	const negative = async (table: string, mutate: (store: IDBObjectStore) => void): Promise<void> => {
		const tx = database.transaction(table, "readwrite", { durability: "strict" }),
			done = terminal(tx);
		mutate(tx.objectStore(table));
		await done;
	};
	let primary: { name: string; message: string } | undefined;
	let cleanup: PromiseSettledResult<void>[] = [];
	const checks: string[] = [];
	let captured: unknown, completedImage: unknown;
	try {
		exact(LIVE_JOURNAL_RETIREMENT_LIMITS, { maxScopes: 7, maxRows: 8192, maxImageBytes: 262_144 }, "original limits");
		for (const [epoch, material] of materials.entries()) {
			successful(
				await (epoch === 0 ? owner.installGenesis(material.install) : owner.installEpochAnchor(material.install))
			);
			successful(
				await owner.appendAccepted({
					scope: material.scope,
					sourceKind: "local-issued",
					author: "creator",
					authorSequence: epoch,
					vertexDigest: (epoch + 1).toString(16).padStart(64, "0"),
				})
			);
		}
		const before = await native();
		const expected = [
			...before.scopes.map((row, index) => encodeCanonical(["scopes", before.scopeKeys[index], row])),
			...before.rows.map((row, index) => encodeCanonical(["acceptedEntries", before.rowKeys[index], row])),
		];
		const frame = (index: number): Uint8Array => {
			const selected = expected[index];
			if (selected === undefined) throw new Error("missing actual native frame");
			return selected;
		};
		const image = await read();
		exact(image.canonicalRows, expected, "all eight actual headers and rows");
		exact(image.image, journalRetirementImage(before.scopes, before.rows), "whole native image");
		exact(image.control, null, "no control birth");
		if (
			image.image.scopeCount !== 8 ||
			image.image.rowCount !== 8 ||
			image.image.byteCharge >= LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes
		)
			throw new Error("unexpected complete native cardinality or byte charge");
		exact(await native(), before, "noncreating capture preserves every native row");
		captured = image;
		checks.push("exact-eight-headers-and-rows", "no-control-birth");
		// These exact raw native negatives are counter/byte premises only, not signed eligibility.
		const header = before.scopes[0];
		if (header === undefined) throw new Error("missing actual native header");
		await negative("scopes", (store) => {
			for (let i = 8; i <= LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows; i++) store.put({ ...header, epoch: 10_000 + i });
		});
		if ((await count("scopes")) !== LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows + 1)
			throw new Error("physical scope overflow not reached");
		await refused("physical scope cardinality overflow");
		await negative("scopes", (store) => {
			for (let i = 8; i <= LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows; i++)
				store.delete([first.scope.objectId, 10_000 + i, first.scope.anchorDigest]);
		});
		exact(await native(), before, "scope overflow exact restoration");
		const row = before.rows[0];
		if (row === undefined) throw new Error("missing actual native row");
		await negative("acceptedEntries", (store) => {
			for (let i = 1; i <= LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows - 7; i++)
				store.put({
					...row,
					journalSequence: i,
					localAuthorSequence: 10_000 + i,
					vertexDigest: (10_000 + i).toString(16).padStart(64, "0"),
				});
		});
		if ((await count("acceptedEntries")) !== LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows + 1)
			throw new Error("physical row overflow not reached");
		await refused("physical row cardinality overflow");
		await negative("acceptedEntries", (store) => {
			for (let i = 1; i <= LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows - 7; i++)
				store.delete([first.scope.objectId, first.scope.epoch, first.scope.anchorDigest, i]);
		});
		exact(await native(), before, "row overflow exact restoration");
		await negative("scopes", (store) =>
			store.put({
				...header,
				exactCanonicalParametersCarrierBytes: new Uint8Array(LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes),
			})
		);
		await refused("physical byte overflow");
		await negative("scopes", (store) => store.put(header));
		exact(await native(), before, "byte overflow exact restoration");
		exact(await read(), image, "capture remains complete after raw negative restoration");
		checks.push("physical-scope-overflow", "physical-row-overflow", "physical-byte-overflow");
		const labels = { decisionDigest: "b".repeat(64), sourceProofDigest: "c".repeat(64), throughEpoch: 7 };
		const tooMany = await acquire();
		const idle = await read();
		exact(tooMany.readExactCanonicalRows(), expected, "held exact native frames");
		exact(tooMany.image, image.image, "held whole native image");
		try {
			exact(
				await tooMany.prepareFence({ ...labels, protectedScopes: materials.map((m) => m.scope) }),
				{ ok: false, kind: "malformed-input" },
				"original seven-scope preparation bound"
			);
		} finally {
			await tooMany.release();
		}
		exact(await read(), idle, "over-bound preparation has no native effects");
		const prepare = await acquire();
		try {
			successful(await prepare.prepareFence({ ...labels, protectedScopes: [] }));
		} finally {
			await prepare.release();
		}
		const commit = await acquire();
		try {
			successful(await commit.commitPrepared());
		} finally {
			await commit.release();
		}
		const completed = await read();
		if (completed.control === null) throw new Error("completed mechanical native control missing");
		const excessive = await acquire();
		try {
			exact(
				await excessive.beginDrain({
					baseControl: completed.control,
					sourceImage: completed.image,
					prefixes: materials.map((material, index) => ({
						scope: material.scope,
						highWatermark: 1,
						rows: [
							{
								journalSequence: 0,
								vertexDigest: (index + 1).toString(16).padStart(64, "0"),
								author: "creator",
								authorSequence: index,
								nativeFrameDigest: journalRetirementFrameDigest(frame(8 + index)),
							},
						],
					})),
				}),
				{ ok: false, kind: "malformed-input" },
				"original seven-prefix plan bound"
			);
		} finally {
			await excessive.release();
		}
		exact(await read(), completed, "over-bound prefix plan has no native effects");
		const after = await native();
		exact(after.scopes, before.scopes, "all signed headers retained");
		exact(after.rows, before.rows, "all detail rows retained");
		for (const material of materials) {
			const result = await owner.readSignedAnchorEnvelope({ scope: material.scope, maxBytes: 8192 });
			if (!result.ok || result.kind !== "present") throw new Error("retained signed header unavailable");
		}
		await owner.close();
		owner = await createBrowserDurableLiveJournalStore({ primaryDatabaseName: name });
		exact(await read(), completed, "same native database reopen exact image");
		completedImage = completed;
		checks.push("seven-protected-scopes-bound", "seven-prefix-bound", "all-headers-retained", "same-database-reopen");
	} catch (error) {
		primary =
			error instanceof Error
				? { name: error.name, message: error.message }
				: { name: "unknown", message: String(error) };
	} finally {
		database.close();
		cleanup = await Promise.allSettled([owner.close()]);
	}
	return {
		passed: primary === undefined && cleanup.every((entry) => entry.status === "fulfilled"),
		primary,
		checks,
		captured,
		completedImage,
		cleanup,
		cryptoAuthority: false,
		physicalDeletion: false,
	};
};
