import { database, done, environment, request } from "./browser-owner.js";
import { check, LIMITS, must, OBJECT, OTHER, payload, ref, stable } from "./contract.js";
import { createBrowserAheDurableStore } from "../../../packages/storage-browser/dist/src/index.js";
import type { AheBoundedRecoveryRoleRead } from "../../../packages/storage/dist/src/index.js";
import { type RoleCase, roleRun, roleSetup } from "./role-contract.js";

type HeldCurrencyCase = "repeat-and-mutation" | "replacement-and-corruption" | "abort" | "close";

type FuturePointCase = "burst-and-completed-boundary" | "release" | "abort" | "close" | "sequential-and-views";

// Only reservation.check traffic runs while counting. A running keepalive
// callback creates another getKey synchronously; a currency point callback
// creates none. Classify completed native requests by that observable behavior,
// never by a stack, source spelling, timeout, or production instrumentation.
async function heldFuturePoint(name: string, selected: FuturePointCase): Promise<unknown> {
	const store = await createBrowserAheDurableStore({databaseName: name}), raw = await database(name);
	const other = selected === "sequential-and-views" ? await createBrowserAheDurableStore({databaseName: name}) : undefined;
	type Reservation = Awaited<ReturnType<typeof store.acquireNativeReadReservation>>;
	type NativeCount = {points: number; requests: number};
	const reservations: Reservation[] = [], counts = new Map<IDBTransaction, NativeCount>(), running = new Set<IDBTransaction>();
	const observations: Record<string, unknown>[] = [], nativeErrors = new Set<unknown>();
	const transactionDescriptor = Object.getOwnPropertyDescriptor(IDBDatabase.prototype, "transaction")!;
	const getKeyDescriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "getKey")!;
	let current: IDBTransaction | undefined, parent: {children: number} | undefined;
	let afterPoint: ((event: Event, request: IDBRequest) => void) | undefined, afterAdmission: (() => void) | undefined;
	let callbackFailure: unknown, emergency = false, admitted = 0, settled = 0;
	let writer: IDBTransaction | undefined, writerJoined: Promise<void> | undefined, writerStarted = false;
	const fuse = setTimeout(() => {
		emergency = true;
		try {writer?.abort();} catch { /* Already terminal. */ }
		for (const transaction of counts.keys()) try {transaction.abort();} catch { /* Already terminal. */ }
		for (const reservation of reservations) void reservation.release().catch(() => undefined);
	}, 8000);
	Object.defineProperty(IDBDatabase.prototype, "transaction", {...transactionDescriptor,
		value: function(this: IDBDatabase, ...args: unknown[]): IDBTransaction {
			const transaction = Reflect.apply(transactionDescriptor.value, this, args) as IDBTransaction;
			if (this.name === name && transaction.mode === "readonly" &&
				transaction.objectStoreNames.length === this.objectStoreNames.length) {
				current = transaction; counts.set(transaction, {points: 0, requests: 0}); running.add(transaction);
			}
			return transaction;
		}});
	Object.defineProperty(IDBObjectStore.prototype, "getKey", {...getKeyDescriptor,
		value: function(this: IDBObjectStore, ...args: unknown[]): IDBRequest {
			const request = Reflect.apply(getKeyDescriptor.value, this, args) as IDBRequest, transaction = this.transaction;
			const count = counts.get(transaction);
			if (count === undefined) return request;
			count.requests++; if (parent !== undefined) parent.children++;
			const add = request.addEventListener;
			Reflect.apply(add, request, ["error", () => {nativeErrors.add(request.error);}, {once: true}]);
			Object.defineProperty(request, "addEventListener", {configurable: true,
				value: function(this: IDBRequest, type: string, listener: EventListenerOrEventListenerObject | null,
					options?: boolean | AddEventListenerOptions): void {
					if (type !== "success" || listener === null) {Reflect.apply(add, this, [type, listener, options]); return;}
					Reflect.apply(add, this, [type, function(this: IDBRequest, event: Event): void {
						const previous = parent, frame = {children: 0}; parent = frame;
						try {
							if (typeof listener === "function") Reflect.apply(listener, this, [event]);
							else Reflect.apply(listener.handleEvent, listener, [event]);
						} finally {parent = previous;}
						if (!running.has(transaction)) return; // A stopped final pump is not a point.
						try {
							if (frame.children === 0) {
								count.points++;
								const hook = afterPoint; afterPoint = undefined; hook?.(event, request);
							} else if (frame.children > 1) {
								const hook = afterAdmission; afterAdmission = undefined; hook?.();
							}
						} catch (cause) {callbackFailure ??= cause;}
					}, options]);
				}});
			return request;
		}});
	const acquire = async (owner = store): Promise<{reservation: Reservation; transaction: IDBTransaction; count: NativeCount}> => {
		const reservation = await owner.acquireNativeReadReservation({objectId: OBJECT}); reservations.push(reservation);
		check(current, "actual original native reservation observed");
		return {reservation, transaction: current, count: counts.get(current)!};
	};
	const observe = (reservation: Reservation): Promise<PromiseSettledResult<void>> => {
		admitted++;
		return reservation.check().then(value => {settled++; return {status: "fulfilled" as const, value};},
			reason => {settled++; return {status: "rejected" as const, reason};});
	};
	const stop = async ({reservation, transaction}: Awaited<ReturnType<typeof acquire>>): Promise<void> => {
		running.delete(transaction); await reservation.release();
	};
	try {
		const first = await acquire();
		if (selected === "burst-and-completed-boundary") {
			const injected: {boundary?: Record<string, unknown>; fresh?: Promise<PromiseSettledResult<void>>} = {};
			afterPoint = (event, request) => {
				injected.boundary = {trusted: event.isTrusted, readyState: request.readyState, admitted, settled};
				// This is after the native success callback returned but still inside
				// its synchronous listener wrapper, before any promise continuation.
				injected.fresh = observe(first.reservation);
			};
			const burst = Array.from({length: 8}, () => observe(first.reservation));
			const results = await Promise.all(burst);
			check(injected.fresh, "native point success boundary injected a fresh logical check");
			results.push(await injected.fresh);
			const boundary = injected.boundary;
			observations.push({points: first.count.points, boundary, results: results.map(result => result.status)});
			check(boundary?.trusted === true && boundary.readyState === "done" && boundary.admitted === 8 && boundary.settled === 0,
				"fresh check was injected after trusted native success, before async logical settlement");
			check(results.every(result => result.status === "fulfilled"), "all nine lawful logical checks complete");
			check(Number(first.count.points) === 2, "eight overlapping checks share one future point; completed point cannot serve ninth check");
			await first.reservation.check();
			check(Number(first.count.points) === 3, "a lawful later check gets a new native point");
		} else if (selected === "sequential-and-views") {
			await first.reservation.check(); check(Number(first.count.points) === 1, "first sequential point");
			await first.reservation.check(); check(Number(first.count.points) === 2, "completed point is not reused sequentially");
			const parallel = await acquire(other!);
			check(parallel.transaction !== first.transaction, "other store has a distinct original native view");
			await Promise.all([first.reservation.check(), parallel.reservation.check()]);
			check(Number(first.count.points) === 3 && Number(parallel.count.points) === 1, "distinct overlapping views each require their own native point");
			await stop(parallel); await stop(first);
			const next = await acquire();
			check(next.transaction !== first.transaction, "new lease has a different original native transaction");
			await next.reservation.check(); check(Number(next.count.points) === 1, "new lease cannot inherit a completed point");
			check(await first.reservation.check().then(() => false, () => true), "old lease remains revoked while replacement is lawful");
			await next.reservation.check(); check(Number(next.count.points) === 2, "replacement remains lawfully usable");
			observations.push({first: first.count.points, differentView: parallel.count.points, replacement: next.count.points});
		} else {
			// Same deterministic bytes already staged by whole-view setup, through
			// an independent real connection: no semantic mutation is involved.
			writer = raw.transaction("blobs", "readwrite"); writerJoined = done(writer); void writerJoined.catch(() => undefined);
			const bytes = payload(1), write = writer.objectStore("blobs").put({digest: ref(bytes).digest, bytes});
			let terminal = false, releaseSettled = -1, requestsAtRevoke = -1, admissionBoundary = -1;
			const revoked: {release?: Promise<PromiseSettledResult<void>>; refused?: Promise<boolean>} = {};
			write.addEventListener("success", () => {writerStarted = true; if (!terminal) callbackFailure ??= new Error("foreign writer crossed physical hold");});
			first.transaction.addEventListener("complete", () => {terminal = true;}, {once: true});
			first.transaction.addEventListener("abort", () => {terminal = true;}, {once: true});
			afterAdmission = () => {
				admissionBoundary = settled;
				check(!writerStarted && !terminal, "foreign writer is excluded while original native points are in flight");
				running.delete(first.transaction); requestsAtRevoke = first.count.requests;
				if (selected === "abort") first.transaction.abort();
				const joined = selected === "close" ? store.close() : first.reservation.release();
				revoked.release = joined.then(value => {releaseSettled = settled; return {status: "fulfilled" as const, value};},
					reason => {releaseSettled = settled; return {status: "rejected" as const, reason};});
				revoked.refused = first.reservation.check().then(() => false, () => true);
			};
			const results = await Promise.all(Array.from({length: 8}, () => observe(first.reservation)));
			check(revoked.release && revoked.refused, "revocation happened after native admission, before native point completion");
			const released = await revoked.release;
			check(await revoked.refused, "new checks are refused after immediate revocation");
			check(admissionBoundary === 0 && releaseSettled === 8, "release joins every admitted logical check");
			check(first.count.requests === requestsAtRevoke, "revocation admits no later native check request");
			check(results.every(result => result.status === "rejected"), "revoked admitted checks never resolve as current");
			if (selected === "release") {
				check(released.status === "fulfilled" && results.every(result => result.status === "rejected" &&
					String(result.reason).includes("NATIVE_READ_RESERVATION_RELEASED")), "release retains each logical post-check refusal");
			} else {
				check(results.every(result => result.status === "rejected" && nativeErrors.has(result.reason)),
					"admitted checks propagate original native request errors, not successful rescue");
				check(selected === "close" ? released.status === "fulfilled" : released.status === "rejected",
					"intentional close and original native abort retain distinct terminal outcomes");
			}
			await writerJoined;
			check(writerStarted && terminal, "foreign same-byte writer runs only after physical native release");
			observations.push({admissionBoundary, admitted, settled, releaseSettled, release: released.status,
				results: results.map(result => result.status === "rejected" ? String(result.reason) : result.status), writerStarted});
			if (selected !== "close") {
				const next = await acquire(); await next.reservation.check();
				check(Number(next.count.points) === 1, "continued storage after joined revocation gets a lawful fresh point");
			}
		}
		check(callbackFailure === undefined, "native callback evidence: " + String(callbackFailure));
		check(!emergency, "emergency rescue is not passing evidence");
		return {selected, passed: true, emergency, observations};
	} catch (cause) {return {selected, passed: false, emergency, observations, primary: String(cause), callbackFailure: String(callbackFailure)};}
	finally {
		afterPoint = undefined; afterAdmission = undefined; running.clear();
		try {
			for (const reservation of reservations) await reservation.release().catch(() => undefined);
			await writerJoined?.catch(() => undefined);
		} finally {
			try {await store.close(); await other?.close();}
			finally {
				raw.close(); clearTimeout(fuse);
				Object.defineProperty(IDBDatabase.prototype, "transaction", transactionDescriptor);
				Object.defineProperty(IDBObjectStore.prototype, "getKey", getKeyDescriptor);
			}
		}
	}
}

type CaptureOverlapCase = "role" | "active" | "borrowed-mutation" | "optional-corruption" | "optional-oversize" |
	"replacement-corruption" | "foreign-object" | "abort";

// Exercise the original native capture then its separate retirement admission.
// Only bounded per-digest scalar counters are retained; keepalive is excluded.
async function heldCaptureOverlap(name: string, selected: CaptureOverlapCase): Promise<unknown> {
	const store = await createBrowserAheDurableStore({databaseName: name}), raw = await database(name);
	const readAdmission = store.readRetirementAdmissionImage?.bind(store);
	check(readAdmission, "original native retirement admission reader available");
	let held: Awaited<ReturnType<typeof store.acquireNativeReadReservation>> | undefined;
	let reader: {readonly blobs: AheBoundedRecoveryRoleRead["blobs"]; release(): Promise<void>} | undefined;
	let nativeTransaction: IDBTransaction | undefined, emergency = false;
	const descriptors = new Map<string, PropertyDescriptor>(), blobGets = new Map<string, number>();
	const observations: Record<string, unknown>[] = [];
	const transactionDescriptor = Object.getOwnPropertyDescriptor(IDBDatabase.prototype, "transaction")!;
	let metadataGets = 0, generationGets = 0, headGets = 0;
	const fuse = setTimeout(() => {emergency = true; try {nativeTransaction?.abort();} catch { /* Already terminal. */ }
		void held?.release().catch(() => undefined);}, 8000);
	try {
		if (selected === "optional-corruption" || selected === "optional-oversize") {
			const original = payload(6), bytes = selected === "optional-oversize" ? payload(6, 65537) : original.slice();
			if (selected === "optional-corruption") bytes[0] = bytes[0]! ^ 255;
			const transaction = raw.transaction("blobs", "readwrite"), terminal = done(transaction);
			transaction.objectStore("blobs").put({digest: ref(original).digest, bytes}); await terminal;
		}
		const positive = selected === "role" || selected === "active" || selected === "borrowed-mutation";
		const originalAdmission = positive ? must(await readAdmission(OBJECT)) : undefined;
		Object.defineProperty(IDBDatabase.prototype, "transaction", {...transactionDescriptor,
			value: function(this: IDBDatabase, ...args: unknown[]): IDBTransaction {
				const transaction = Reflect.apply(transactionDescriptor.value, this, args) as IDBTransaction;
				if (this.name === name && transaction.mode === "readonly" &&
					transaction.objectStoreNames.length === this.objectStoreNames.length) nativeTransaction = transaction;
				return transaction;
			}});
		for (const method of ["get", "openKeyCursor"]) {
			const descriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, method)!;
			descriptors.set(method, descriptor);
			Object.defineProperty(IDBObjectStore.prototype, method, {...descriptor,
				value: function(this: IDBObjectStore, ...args: unknown[]): IDBRequest {
					if (this.transaction.db.name === name) {
						if (this.name === "blobs" && method === "get") {
							const key = String(args[0]); check(blobGets.has(key) || blobGets.size < 64, "bounded native digest counters");
							blobGets.set(key, (blobGets.get(key) ?? 0) + 1);
						} else if (this.name === "objects" || this.name === "generations") {
							metadataGets++;
							if (this.name === "generations") generationGets++; else headGets++;
						}
					}
					return Reflect.apply(descriptor.value, this, args) as IDBRequest;
				}});
		}
		held = await store.acquireNativeReadReservation({objectId: OBJECT});
		if (selected === "active") {
			const acquired = must(await store.acquireBoundedActiveRead({objectId: OBJECT, ancestorCount: 2, limits: LIMITS}));
			check(acquired.kind === "present", "active native reader present"); reader = acquired.reader;
		} else reader = must(await store.acquireBoundedRecoveryRoleRead({objectId: OBJECT, limits: LIMITS}));
		check(reader.blobs.length > 1, "nonempty original native material captured");
		const beforeMetadata = metadataGets, beforeGenerations = generationGets, beforeHeads = headGets, beforeGets = new Map(blobGets);
		const borrowed = reader.blobs[0]!, original = borrowed.bytes.slice();
		if (selected === "borrowed-mutation") borrowed.bytes[0] = borrowed.bytes[0]! ^ 255;
		if (selected === "replacement-corruption") {
			await held.release(); held = undefined;
			const corrupt = original.slice(); corrupt[0] = corrupt[0]! ^ 255;
			const transaction = raw.transaction("blobs", "readwrite"), terminal = done(transaction);
			transaction.objectStore("blobs").put({digest: borrowed.ref.digest, bytes: corrupt}); await terminal;
			held = await store.acquireNativeReadReservation({objectId: OBJECT});
		} else if (selected === "abort") nativeTransaction!.abort();
		const admission = await readAdmission(selected === "foreign-object" ? OTHER : OBJECT);
		const reusedMaterialGets = reader.blobs.map(blob => ({digest: blob.ref.digest,
			before: beforeGets.get(blob.ref.digest) ?? 0, after: blobGets.get(blob.ref.digest) ?? 0}));
		observations.push({admission, additionalMetadataGets: metadataGets - beforeMetadata,
			additionalGenerationGets: generationGets - beforeGenerations, additionalHeadGets: headGets - beforeHeads, reusedMaterialGets,
			allBlobGets: [...blobGets].map(([digest, gets]) => ({digest, gets}))});
		if (positive) {
			check(admission.ok && stable(admission.value) === stable(originalAdmission), "identical complete native admission and logical charges");
			check(generationGets === beforeGenerations && headGets - beforeHeads <= 1,
				"no repeated whole native census; separate fresh head point read remains allowed");
			check(reusedMaterialGets.every(row => row.after === row.before), "no repeated native gets for already verified held material");
			if (selected === "borrowed-mutation") {
				const currency = await (reader as AheBoundedRecoveryRoleRead).checkCurrency();
				check(!currency.ok && currency.reason === "READ_STALE_ROLE_VIEW", "borrowed mutation is still refused by original reader");
				borrowed.bytes.set(original);
				check((await (reader as AheBoundedRecoveryRoleRead).checkCurrency()).ok, "restored borrowed bytes remain usable");
			}
		} else if (selected === "optional-oversize")
			check(!admission.ok && admission.reason === "READ_BUDGET_EXCEEDED", "actual optional bytes still enforce union preflight");
		else if (selected === "foreign-object")
			check(!admission.ok && admission.reason === "INVALID_ARGUMENT", "same native transaction does not transfer another object's facts");
		else if (selected === "abort") check(!admission.ok, "aborted native view cannot deliver successful admission");
		else check(!admission.ok && admission.reason === "BLOB_CORRUPT", "optional or replaced corrupt native material still refuses");
		check(!emergency, "emergency rescue is not passing evidence");
		return {selected, passed: true, observations};
	} catch (cause) {return {selected, passed: false, observations, primary: String(cause), emergency};}
	finally {
		try {await reader?.release();} finally {
			try {await held?.release().catch(() => undefined); await store.close();}
			finally {raw.close(); clearTimeout(fuse); Object.defineProperty(IDBDatabase.prototype, "transaction", transactionDescriptor);
				for (const [method, descriptor] of descriptors) Object.defineProperty(IDBObjectStore.prototype, method, descriptor);}
		}
	}
}

// The original native browser owner is exercised here, not an extracted/mock
// verifier. Count actual native metadata/material requests without retaining
// the potentially large getKey keepalive trace. No timings are acceptance.
async function heldRoleCurrency(name: string, selected: HeldCurrencyCase): Promise<unknown> {
	const store = await createBrowserAheDurableStore({databaseName: name}), raw = await database(name);
	const transactionDescriptor = Object.getOwnPropertyDescriptor(IDBDatabase.prototype, "transaction")!;
	const descriptors = new Map<string, PropertyDescriptor>();
	let nativeReads = 0, blobReads = 0, heldTransaction: IDBTransaction | undefined;
	let reservation: Awaited<ReturnType<typeof store.acquireNativeReadReservation>> | undefined;
	let captured: AheBoundedRecoveryRoleRead | undefined;
	let writer: IDBTransaction | undefined, writerJoined: Promise<void> | undefined, writerStarted = false;
	const observations: Record<string, unknown>[] = [];
	let emergency = false;
	const fuse = setTimeout(() => {
		emergency = true;
		try { writer?.abort(); } catch { /* Already terminal. */ }
		try { heldTransaction?.abort(); } catch { /* Already terminal. */ }
		void reservation?.release().catch(() => undefined);
	}, 8000);
	Object.defineProperty(IDBDatabase.prototype, "transaction", {...transactionDescriptor,
		value: function(this: IDBDatabase, ...args: unknown[]): IDBTransaction {
			const tx = Reflect.apply(transactionDescriptor.value, this, args) as IDBTransaction;
			if (this.name === name && tx.mode === "readonly" && tx.objectStoreNames.length === this.objectStoreNames.length)
				heldTransaction = tx;
			return tx;
		}});
	for (const method of ["get", "getAllKeys", "openCursor", "openKeyCursor"]) {
		const descriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, method)!;
		descriptors.set(method, descriptor);
		Object.defineProperty(IDBObjectStore.prototype, method, {...descriptor,
			value: function(this: IDBObjectStore, ...args: unknown[]): IDBRequest {
				if (this.transaction.db.name === name) {
					nativeReads++;
					if (this.name === "blobs" && method === "get") blobReads++;
				}
				return Reflect.apply(descriptor.value, this, args) as IDBRequest;
			}});
	}
	const currency = async (label: string) => {
		nativeReads = 0; blobReads = 0;
		const result = await captured!.checkCurrency();
		const observation = {label, result, nativeReads, blobReads}; observations.push(observation);
		return observation;
	};
	try {
		reservation = await store.acquireNativeReadReservation({objectId: OBJECT});
		const originalTransaction = heldTransaction;
		check(originalTransaction, "actual held native transaction observed");
		captured = must(await store.acquireBoundedRecoveryRoleRead({objectId: OBJECT, limits: LIMITS}));
		check(captured.blobs.length > 1, "nonempty shared recovery union captured");
		if (selected === "repeat-and-mutation") {
			const blob = captured.blobs[0]!, original = blob.bytes.slice();
			writer = raw.transaction("blobs", "readwrite"); writerJoined = done(writer);
			void writerJoined.catch(() => undefined);
			const write = writer.objectStore("blobs").put({digest: blob.ref.digest, bytes: original});
			write.addEventListener("success", () => {writerStarted = true;});
			for (const label of ["same-hold-first", "same-hold-second"]) {
				const observed = await currency(label);
				check(observed.result.ok, "same original native image remains current");
				check(observed.nativeReads === 0 && observed.blobReads === 0, "no duplicate whole census/material recapture");
				check(!writerStarted, "real foreign writer remains excluded before held release");
			}
			blob.bytes[0] = blob.bytes[0]! ^ 255;
			const altered = await currency("borrowed-mutation");
			check(!altered.result.ok && altered.result.reason === "READ_STALE_ROLE_VIEW", "fresh borrowed integrity sweep retained");
			blob.bytes.set(original);
			check((await currency("borrowed-restored")).result.ok, "caller mutation does not poison native owner");
			await reservation.release(); reservation = undefined;
			await writerJoined; check(writerStarted, "queued foreign writer joins after original hold release");
		} else if (selected === "replacement-and-corruption") {
			await reservation.release(); reservation = await store.acquireNativeReadReservation({objectId: OBJECT});
			check(heldTransaction !== originalTransaction, "replacement is a different actual native transaction");
			const replaced = await currency("new-hold-original-reader");
			check(replaced.result.ok && replaced.nativeReads > 0 && replaced.blobReads > 0, "different hold requires original full recapture");
			await reservation.release(); reservation = undefined;
			const blob = captured.blobs[0]!, corrupt = blob.bytes.slice(); corrupt[0] = corrupt[0]! ^ 255;
			const tx = raw.transaction("blobs", "readwrite"), terminal = done(tx);
			tx.objectStore("blobs").put({digest: blob.ref.digest, bytes: corrupt}); await terminal;
			reservation = await store.acquireNativeReadReservation({objectId: OBJECT});
			const changed = await currency("raw-corruption-after-replacement");
			check(!changed.result.ok && changed.result.reason === "ADOPTED_BLOB_CORRUPT", "raw corruption is detected, not cached as current");
			check(changed.blobReads > 0, "corrupt replacement actually read native material");
		} else if (selected === "abort") {
			originalTransaction.abort();
			let refused = false;
			try { refused = !(await currency("aborted-original-hold")).result.ok; } catch { refused = true; }
			check(refused, "native abort cannot produce current currency");
		} else {
			await store.close();
			const closed = await currency("closed-owner");
			check(!closed.result.ok && closed.result.reason === "STORE_CLOSED", "closed facade does not inherit held authority");
		}
		check(!emergency, "emergency rescue is not passing evidence");
		return {selected, passed: true, observations, writerStarted};
	} finally {
		// Revoke and join admitted reads before releasing the physical hold. On a
		// failed assertion this also rescues the queued writer without hanging.
		try {
			try { await captured?.release(); }
			finally { await reservation?.release().catch(() => undefined); }
			await writerJoined?.catch(() => undefined);
		} finally {
			try { await store.close(); }
			finally {
				raw.close(); clearTimeout(fuse);
				Object.defineProperty(IDBDatabase.prototype, "transaction", transactionDescriptor);
				for (const [method, descriptor] of descriptors) Object.defineProperty(IDBObjectStore.prototype, method, descriptor);
			}
		}
	}
}

Object.assign(globalThis, {
	boundedRoleSetup: (name: string, selected: RoleCase): Promise<unknown> => roleSetup(selected, environment(name)),
	boundedRoleRun: (name: string, selected: RoleCase): Promise<unknown> => roleRun(selected, environment(name)),
	boundedRoleDelete: (name: string): Promise<unknown> => request(indexedDB.deleteDatabase(name)),
	boundedHeldRoleCurrency: heldRoleCurrency,
	boundedHeldCaptureOverlap: heldCaptureOverlap,
	boundedHeldFuturePoint: heldFuturePoint,
});
