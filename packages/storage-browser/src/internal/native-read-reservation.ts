import type { NativeReadReservation } from "@ts-drp/storage";

import { closeBrowserRoomConnection, openBrowserRoomOwnerConnection, roomOwnerStoreNames } from "./schema-idb.js";

export interface NativeReadReservationPort {
	acquireNativeReadReservation: (input: { readonly objectId: string }) => Promise<NativeReadReservation>;
}

export function captureNativeReadReservationInput(input: unknown): string {
	if (typeof input !== "object" || input === null || Array.isArray(input)) throw new TypeError("INVALID_ARGUMENT");
	const prototype = Object.getPrototypeOf(input);
	const keys = Reflect.ownKeys(input);
	const field = Object.getOwnPropertyDescriptor(input, "objectId");
	if ((prototype !== Object.prototype && prototype !== null) || keys.length !== 1 || keys[0] !== "objectId" ||
		field === undefined || !("value" in field) || !field.enumerable || typeof field.value !== "string" ||
		field.value.length === 0 || field.value.includes("\0")) {
		throw new TypeError("INVALID_ARGUMENT");
	}
	return field.value;
}

const owners = new WeakMap<IDBDatabase, NativeReadReservationOwner>();
const views = new WeakMap<IDBTransaction, HeldReadView>();

export function nativeReadonlyTransaction(database: IDBDatabase, stores: string | string[]): IDBTransaction {
	const view = nativeReadReservationTransaction(database);
	return view ?? database.transaction(stores, "readonly");
}

export function nativeReadReservationTransaction(database: IDBDatabase): IDBTransaction | undefined {
	return owners.get(database)?.view();
}

export function nativeReadReservationCheck(transaction: IDBTransaction): Promise<void> | undefined {
	return views.get(transaction)?.check();
}

export function isNativeReadReservationTransaction(transaction: IDBTransaction): boolean {
	return views.has(transaction);
}

export function needsNativeReadReservationTurn(database: IDBDatabase): boolean {
	return owners.get(database)?.needsReadTurn() ?? false;
}

export function runNativeReservedRead<T>(database: IDBDatabase, operation: () => Promise<T>): Promise<T> {
	const owner = owners.get(database);
	return owner === undefined ? operation() : owner.runRead(operation);
}

/** Rows materialized ahead of the per-row charge of a counted-range visit. */
const COUNTED_RANGE_PAGE = 32;

function countedRangeRequest<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.addEventListener("success", () => resolve(request.result), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")), { once: true });
	});
}

/**
 * Visits an object-store key range in the caller's transaction in primary-key
 * (cursor) order, in pages: `visit` charges and checks each row of one page
 * before the next page is requested, so at most one page of uncharged rows is
 * ever materialized. Reads stop after `limit` rows, as a bounded cursor would.
 * @param store - Object store (primary keys are unique, so paging is exact).
 * @param range - Exact key range the cursor walked.
 * @param limit - Maximum rows read (e.g. a census count + 1 so overflow still refuses).
 * @param visit - Per-row admission; a throw stops the visit before more rows are read.
 * @returns The number of rows visited.
 */
export async function visitCountedRange(
	store: IDBObjectStore,
	range: IDBKeyRange,
	limit: number,
	visit: (value: unknown, primaryKey: IDBValidKey) => void
): Promise<number> {
	let next = range, visited = 0;
	for (;;) {
		const want = Math.min(COUNTED_RANGE_PAGE, limit - visited);
		if (want <= 0) return visited;
		const [values, keys] = await Promise.all([
			countedRangeRequest(store.getAll(next, want)),
			countedRangeRequest(store.getAllKeys(next, want)),
		]);
		if (values.length !== keys.length) throw new Error("IndexedDB counted range read disagrees");
		for (let index = 0; index < values.length; index++) visit(values[index], keys[index]!);
		visited += values.length;
		if (values.length < want) return visited;
		const last = keys[keys.length - 1]!;
		try {
			next = range.upper === undefined
				? IDBKeyRange.lowerBound(last, true)
				: IDBKeyRange.bound(last, range.upper, true, range.upperOpen);
		} catch {
			// The last row sits at the closed upper bound: nothing lies beyond it.
			return visited;
		}
	}
}

class HeldReadView {
	readonly transaction: IDBTransaction;
	readonly ready: Promise<void>;
	readonly #terminal: Promise<void>;
	readonly #store: IDBObjectStore;
	#running = true;
	#released = false;
	#ended = false;
	#intentionalAbort = false;
	#failure: unknown;
	#failed = false;
	#release?: Promise<void>;
	#inTurn = false;
	#futureCheck?: Promise<void>;
	readonly #queued: Array<{start: () => void; reject: (cause: unknown) => void}> = [];
	readonly #operations = new Set<Promise<unknown>>();

	constructor(database: IDBDatabase) {
		// All of this owner's stores: native foreign READWRITE transactions on them
		// cannot overlap this view. No schema/control/row is changed, and no
		// JavaScript lock grants it. On a room connection the owner's stores are
		// its own namespace only, so the view never blocks another owner (14a).
		const stores = roomOwnerStoreNames(database);
		if (stores.length === 0) throw new Error("NATIVE_READ_RESERVATION_EMPTY_SCHEMA");
		this.transaction = database.transaction(stores, "readonly");
		this.#store = this.transaction.objectStore(this.transaction.objectStoreNames[0]!);
		views.set(this.transaction, this);
		this.#terminal = new Promise<void>((resolve, reject) => {
			this.transaction.addEventListener("complete", () => {
				this.#ended = true;
				this.#rejectQueued(this.#failed ? this.#failure : new Error("NATIVE_READ_RESERVATION_RELEASED"));
				if (this.#failed) reject(this.#failure); else resolve();
			}, { once: true });
			this.transaction.addEventListener("abort", () => {
				this.#ended = true;
				this.#rejectQueued(this.#failed ? this.#failure : this.transaction.error ?? new Error("NATIVE_READ_RESERVATION_ABORTED"));
				if (this.#intentionalAbort && !this.#failed) resolve();
				else reject(this.#failed ? this.#failure : this.transaction.error ?? new Error("NATIVE_READ_RESERVATION_ABORTED"));
			}, { once: true });
			this.transaction.addEventListener("error", (event) => {
				// Native abort reports AbortError on each pending request. An
				// intentional owner close owns that cancellation, not a substrate
				// failure; other request errors remain the original failure.
				if (this.#intentionalAbort && event.target instanceof IDBRequest && event.target.error?.name === "AbortError") return;
				this.#failed = true;
				this.#failure = this.transaction.error ?? new Error("NATIVE_READ_RESERVATION_FAILED");
				this.#rejectQueued(this.#failure);
			});
		});
		// Acquisition/operation callers and release still own the original error.
		void this.#terminal.catch(() => undefined);
		this.ready = new Promise<void>((resolve, reject) => this.#pump(resolve, reject));
	}

	#pump(resolve?: () => void, reject?: (cause: unknown) => void): void {
		try {
			const request = this.#store.getKey("");
			request.addEventListener("success", () => {
				this.#inTurn = true;
				try { for (const job of this.#queued.splice(0)) job.start(); }
				finally { this.#inTurn = false; }
				// Real work admitted on this native turn queues its requests first.
				// Put the next sentinel behind those requests, not in front of them:
				// otherwise each real read also services a needless sentinel before
				// its result can arrive. This is still synchronous in the original
				// active native handler; no timer or Promise stands in for exclusion.
				if (this.#running) this.#pump();
				resolve?.();
			}, { once: true });
			request.addEventListener("error", () => {
				if (this.#intentionalAbort && request.error?.name === "AbortError") {
					reject?.(new Error("NATIVE_READ_RESERVATION_RELEASED"));
					return;
				}
				this.#failed = true;
				this.#failure = request.error ?? new Error("NATIVE_READ_RESERVATION_FAILED");
				reject?.(this.#failure);
			}, { once: true });
		} catch (cause) {
			this.#failed = true;
			this.#failure = cause;
			reject?.(cause);
			this.#running = false;
			this.#rejectQueued(cause);
		}
	}

	#rejectQueued(cause: unknown): void {
		for (const job of this.#queued.splice(0)) job.reject(cause);
	}

	assertOpen(): void {
		if (this.#released || this.#ended || this.#failed) {
			throw this.#failed ? this.#failure : new Error("NATIVE_READ_RESERVATION_RELEASED");
		}
	}

	needsTurn(): boolean { return !this.#inTurn; }

	#admit<T>(operation: () => Promise<T>): Promise<T> {
		const pending = operation();
		this.#operations.add(pending);
		// Preserve the original promise and error for its caller; observing both
		// outcomes records settlement without substituting a successful result.
		void pending.then(() => { this.#operations.delete(pending); },
			() => { this.#operations.delete(pending); });
		return pending;
	}

	run<T>(operation: () => Promise<T>): Promise<T> {
		try { this.assertOpen(); } catch (cause) { return Promise.reject(cause); }
		if (this.#inTurn) return this.#admit(operation);
		return new Promise<T>((resolve, reject) => {
			this.#queued.push({reject, start: () => {
				try {
					const pending = this.#admit(operation);
					void pending.then(resolve, reject);
				} catch (cause) { reject(cause); }
			}});
		});
	}

	async check(): Promise<void> {
		this.assertOpen();
		let pending = this.#futureCheck;
		if (pending === undefined) {
			// Only callers admitted before this ORIGINAL native request finishes
			// may share its future point. Clear synchronously inside the native
			// handler, not in a Promise continuation: later admissions need a new
			// point even while earlier callers are still awaiting their results.
			const clear = (): void => { if (this.#futureCheck === pending) this.#futureCheck = undefined; };
			pending = this.run(() => new Promise<void>((resolve, reject) => {
				try {
					const request = this.#store.getKey("");
					request.addEventListener("success", () => { clear(); resolve(); }, { once: true });
					request.addEventListener("error", () => { clear(); reject(request.error); }, { once: true });
				} catch (cause) { clear(); reject(cause); }
			}));
			this.#futureCheck = pending;
			// Queued work can reject before request creation (e.g. release).
			void pending.then(clear, clear);
		}
		// Join each logical admission through its own fresh post-point guard,
		// not just the shared request. No completed point or authority survives.
		await this.#admit(async () => { await pending; this.assertOpen(); });
	}

	release(abort = false): Promise<void> {
		this.#released = true;
		this.#running = false;
		this.#futureCheck = undefined;
		this.#rejectQueued(new Error("NATIVE_READ_RESERVATION_RELEASED"));
		if (abort && !this.#ended) {
			this.#intentionalAbort = true;
			try { this.transaction.abort(); } catch { /* original terminal owns outcome */ }
		}
		return this.#release ??= (async () => {
			const [terminal] = await Promise.allSettled([this.#terminal, ...this.#operations]);
			if (terminal?.status === "rejected") throw terminal.reason;
		})();
	}
}

export class NativeReadReservationOwner {
	readonly #database: IDBDatabase;
	#held?: HeldReadView;
	#closed = false;

	constructor(database: IDBDatabase) {
		if (owners.has(database)) throw new Error("NATIVE_READ_RESERVATION_OWNER_EXISTS");
		this.#database = database;
		owners.set(database, this);
	}

	async acquire(input: unknown): Promise<NativeReadReservation> {
		captureNativeReadReservationInput(input);
		if (this.#closed) throw new Error("STORE_CLOSED");
		if (this.#held !== undefined) throw new Error("NATIVE_READ_RESERVATION_BUSY");
		const held = new HeldReadView(this.#database);
		this.#held = held;
		try {
			await held.ready;
			held.assertOpen();
			if (this.#closed) throw new Error("STORE_CLOSED");
			return Object.freeze({check: () => held.check(), release: () => this.#release(held)});
		} catch (primary) {
			try { await this.#release(held, true); }
			catch (cleanup) { throw new AggregateError([primary, cleanup], "native read reservation acquisition failed", {cause: primary}); }
			throw primary;
		}
	}

	view(): IDBTransaction | undefined {
		if (this.#held === undefined) return undefined;
		this.#held.assertOpen();
		return this.#held.transaction;
	}

	readTransaction(stores: string | string[]): IDBTransaction {
		if (this.#closed) throw new Error("STORE_CLOSED");
		return this.view() ?? this.#database.transaction(stores, "readonly");
	}

	needsReadTurn(): boolean { return this.#held?.needsTurn() ?? false; }

	runRead<T>(operation: () => Promise<T>): Promise<T> {
		if (this.#closed) return Promise.reject(new Error("STORE_CLOSED"));
		return this.#held === undefined ? operation() : this.#held.run(operation);
	}

	async #release(held: HeldReadView, abort = false): Promise<void> {
		try { await held.release(abort); }
		finally { if (this.#held === held) this.#held = undefined; }
	}

	close(): Promise<void> {
		this.#closed = true;
		return this.#held === undefined ? Promise.resolve() : this.#release(this.#held, true);
	}
}

/**
 * Slice 14a executor: one strict read-write transaction at a time over every store
 * of a ready room database. The transaction is kept open across non-IndexedDB work
 * by the same native sentinel turn as a held read view, so owner code can run its
 * existing checks and writes in several turns. It commits whole or not at all: any
 * failed operation, abort or version change discards every write since the last
 * checkpoint, and a commit after a failure is refused.
 */
export interface RoomRetirementSession {
	/** Runs an owner operation on a native turn of the current transaction, opening one if none is open. */
	run<T>(operation: (transaction: IDBTransaction) => Promise<T>): Promise<T>;
	/** Ends the current transaction and waits for its strict commit; a later run opens a new one. */
	checkpoint(): Promise<void>;
	/** Commits the current transaction and ends the session. */
	commit(): Promise<void>;
	/** Discards every write since the last checkpoint and ends the session. */
	abort(cause?: unknown): Promise<void>;
}

class HeldWriteTransaction {
	readonly transaction: IDBTransaction;
	readonly ready: Promise<void>;
	readonly #terminal: Promise<void>;
	readonly #store: IDBObjectStore;
	#running = true;
	#inTurn = false;
	#ended = false;
	#intentionalAbort = false;
	#failed = false;
	#failure: unknown;
	readonly #queued: Array<{ start: () => void; reject: (cause: unknown) => void }> = [];
	readonly #operations = new Set<Promise<unknown>>();

	constructor(database: IDBDatabase) {
		this.transaction = database.transaction([...database.objectStoreNames], "readwrite", { durability: "strict" });
		this.#terminal = new Promise<void>((resolve, reject) => {
			this.transaction.addEventListener(
				"complete",
				() => {
					this.#ended = true;
					this.#rejectQueued(new Error("RETENTION_SESSION_ENDED"));
					if (this.#failed) reject(this.#failure);
					else resolve();
				},
				{ once: true }
			);
			this.transaction.addEventListener(
				"abort",
				() => {
					this.#ended = true;
					const cause = this.#failed
						? this.#failure
						: (this.transaction.error ?? new Error("RETENTION_SESSION_ABORTED"));
					this.#rejectQueued(cause);
					if (this.#intentionalAbort && !this.#failed) resolve();
					else reject(cause);
				},
				{ once: true }
			);
		});
		void this.#terminal.catch(() => undefined);
		if (this.transaction.durability !== "strict") {
			this.#fail(new Error("RETENTION_DURABILITY"));
			this.#intentionalAbort = true;
			this.transaction.abort();
			this.#store = undefined as unknown as IDBObjectStore;
			this.ready = Promise.reject(this.#failure);
			void this.ready.catch(() => undefined);
			return;
		}
		this.#store = this.transaction.objectStore("room:layout");
		this.ready = new Promise<void>((resolve, reject) => this.#pump(resolve, reject));
		void this.ready.catch(() => undefined);
	}

	#fail(cause: unknown): void {
		if (this.#failed) return;
		this.#failed = true;
		this.#failure = cause;
		this.#running = false;
		this.#rejectQueued(cause);
	}

	#rejectQueued(cause: unknown): void {
		for (const job of this.#queued.splice(0)) job.reject(cause);
	}

	#pump(resolve?: () => void, reject?: (cause: unknown) => void): void {
		try {
			const request = this.#store.getKey("");
			request.addEventListener(
				"success",
				() => {
					this.#inTurn = true;
					try {
						for (const job of this.#queued.splice(0)) job.start();
					} finally {
						this.#inTurn = false;
					}
					// Queue the next sentinel behind the real work admitted on this turn.
					if (this.#running) this.#pump();
					resolve?.();
				},
				{ once: true }
			);
			request.addEventListener(
				"error",
				() => {
					const cause = request.error ?? new Error("RETENTION_SESSION_FAILED");
					if (!this.#intentionalAbort) this.#fail(cause);
					reject?.(cause);
				},
				{ once: true }
			);
		} catch (cause) {
			this.#fail(cause);
			reject?.(cause);
		}
	}

	#assertOpen(): void {
		if (this.#failed) throw this.#failure;
		if (this.#ended || !this.#running) throw new Error("RETENTION_SESSION_ENDED");
	}

	#admit<T>(operation: (transaction: IDBTransaction) => Promise<T>): Promise<T> {
		let pending: Promise<T>;
		try {
			pending = operation(this.transaction);
		} catch (cause) {
			pending = Promise.reject(cause);
		}
		this.#operations.add(pending);
		void pending.then(
			() => this.#operations.delete(pending),
			(cause: unknown) => {
				this.#operations.delete(pending);
				// An owner refusal or substrate failure inside the session fails all of it.
				this.#fail(cause);
				if (!this.#ended) {
					this.#intentionalAbort = false;
					try {
						this.transaction.abort();
					} catch {
						/* Already terminal; the terminal event owns the outcome. */
					}
				}
			}
		);
		return pending;
	}

	run<T>(operation: (transaction: IDBTransaction) => Promise<T>): Promise<T> {
		try {
			this.#assertOpen();
		} catch (cause) {
			return Promise.reject(cause);
		}
		if (this.#inTurn) return this.#admit(operation);
		return new Promise<T>((resolve, reject) => {
			this.#queued.push({
				reject,
				start: () => {
					void this.#admit(operation).then(resolve, reject);
				},
			});
		});
	}

	/** Stops the sentinel and waits for the strict commit of every admitted write. */
	async commit(): Promise<void> {
		this.#running = false;
		await Promise.allSettled([...this.#operations]);
		if (this.#failed) {
			this.abort();
			await this.#terminal.catch(() => undefined);
			throw this.#failure;
		}
		await this.#terminal;
	}

	abort(): Promise<void> {
		this.#running = false;
		this.#rejectQueued(new Error("RETENTION_SESSION_ABORTED"));
		if (!this.#ended) {
			this.#intentionalAbort = true;
			try {
				this.transaction.abort();
			} catch {
				/* Already terminal. */
			}
		}
		return this.#terminal.catch(() => undefined);
	}
}

/**
 * Opens one retirement session on its own connection to a ready room database.
 * @param input - Exact room database identity.
 * @returns The session; it never creates or upgrades the database.
 */
export async function openRoomRetirementSession(
	input: Readonly<{ databaseName: string }>
): Promise<RoomRetirementSession> {
	let current: HeldWriteTransaction | undefined;
	let ended = false,
		failure: unknown;
	const database = await openBrowserRoomOwnerConnection(input.databaseName, "all", () => {
		// A version change ends the session; uncommitted writes are discarded natively.
		failure ??= new Error("RETENTION_SESSION_VERSION_CHANGE");
		void current?.abort();
		closeBrowserRoomConnection(database);
	});
	const finish = (): void => {
		ended = true;
		current = undefined;
		closeBrowserRoomConnection(database);
	};
	const held = (): HeldWriteTransaction => {
		if (ended) throw failure ?? new Error("RETENTION_SESSION_ENDED");
		return (current ??= new HeldWriteTransaction(database));
	};
	const session: RoomRetirementSession = Object.freeze({
		run: async <T>(operation: (transaction: IDBTransaction) => Promise<T>): Promise<T> => {
			const transaction = held();
			await transaction.ready;
			return transaction.run(operation);
		},
		checkpoint: async (): Promise<void> => {
			if (ended) throw failure ?? new Error("RETENTION_SESSION_ENDED");
			const transaction = current;
			current = undefined;
			if (transaction === undefined) return;
			try {
				await transaction.commit();
			} catch (cause) {
				failure ??= cause;
				finish();
				throw cause;
			}
		},
		commit: async (): Promise<void> => {
			if (ended) throw failure ?? new Error("RETENTION_SESSION_ENDED");
			const transaction = current;
			try {
				await transaction?.commit();
			} catch (cause) {
				failure ??= cause;
				throw cause;
			} finally {
				finish();
			}
		},
		abort: async (cause?: unknown): Promise<void> => {
			if (ended) return;
			failure ??= cause ?? new Error("RETENTION_SESSION_ABORTED");
			const transaction = current;
			try {
				await transaction?.abort();
			} finally {
				finish();
			}
		},
	});
	return session;
}
