/**
 * Opt-in, UNWIRED single-database epoch retirement store (Track R2, Step 4
 * mechanism). It is a prototype kept under tests/: it is typechecked and
 * tested, but never built, shipped, exported or imported by a production
 * path, and it is not a governed raw-IDB owner (the IDB ownership checker
 * governs src/ only). Promoting it into src/ means registering it as a
 * reviewed owner with that checker, after the spec slices decide its format.
 * It exists so the single-database design can be tested at every crash point
 * and measured first.
 *
 * Trust model (never "trusted after ingress"):
 * - bytes are verified on arrival (a blob key must equal digest(bytes); rows
 *   are immutable exact bytes per key) and again on every open
 *   (`verifyOnOpen`), against the caller's verified facts;
 * - in session, only the caller's in-memory verified facts are authority.
 *   Durable bytes are compared byte-exactly against them inside the same
 *   read-write transaction that acts on them;
 * - a retirement mark is a store-local write fence, a range index and a
 *   resume point. It is never deletion authority: rows are deleted only by a
 *   verified decision, and anything a mark contradicts refuses (fail closed).
 *
 * Ordering with the separate host floor: the floor fence (step A, its own
 * strict transaction in its own database) always precedes the retention
 * transaction (step B). A crash between them retains too much; the reverse
 * order is never used.
 */

export const EPOCH_RETIREMENT_DATABASE_VERSION = 1;

const ROWS = "retainedRows";
const BLOBS = "retainedBlobs";
const BLOBS_BY_LAST_REF = "byLastRef";
const HEADS = "retainedHeads";
const MARKS = "retirementMarks";
const RECEIPTS = "migrationReceipts";
const ALL_STORES = [ROWS, BLOBS, HEADS, MARKS, RECEIPTS] as const;
const FENCE_STORE = "migrationFence";
const NONE = -1;

export type RetirementStep = "before-floor" | "after-floor" | "after-reads" | "after-deletes" | "after-commit";
export type MigrationStep = "after-fence" | "after-copy" | "after-delete";

/** Per-owner retired-through fences of one scope; an absent owner means -1 (nothing retired). */
export type FloorFences = Readonly<Record<string, number>>;

export interface EpochRetirementFloorPort {
	/** Monotone and idempotent per owner: max(current, through) for every named owner in ONE strict transaction; returns all fences after it. */
	fence(scope: string, through: FloorFences): Promise<FloorFences>;
	/** The current fences of a scope. */
	read(scope: string): Promise<FloorFences>;
}

/** Pseudo-owner whose mark fences shared-blob references; never a decision owner. */
export const BLOB_MARK_OWNER = "#blobs";

export interface RetainedRowInput {
	readonly owner: string;
	readonly scope: string;
	readonly epoch: number;
	readonly kind: string;
	readonly id: string;
	readonly bytes: Uint8Array;
}

export interface RetainedBlobInput {
	readonly scope: string;
	/** Hex digest; must equal digest(bytes). */
	readonly digest: string;
	readonly epoch: number;
	readonly bytes: Uint8Array;
}

export type RowClass = "retire" | "block" | "malformed";

export interface RetirementOwnerDecision {
	readonly owner: string;
	/** Retire this owner's rows with epoch <= through (subject to classification). */
	readonly through: number;
	/** Reviewed bound on rows read for this owner in one retirement. */
	readonly cap: number;
	/** Owner policy over exact bytes (for example issuance: only paired, published rows retire). */
	readonly classify: (bytes: Uint8Array, key: RetainedRowKey) => RowClass;
}

export interface RetirementRewrite {
	readonly key: RetainedRowKey;
	readonly expected: Uint8Array;
	readonly next: Uint8Array;
}

export interface RetirementDecision {
	readonly scope: string;
	/** Exact verified head bytes (an in-memory verified fact). */
	readonly head: Uint8Array;
	/** Lowest epoch of the verified protected set (head, two rollbacks, bounded pending work). */
	readonly protectedFrom: number;
	/** Keys (see `rowKeyText`) of protected rows; none may lie inside a retired range. */
	readonly protectedRows: ReadonlySet<string>;
	/** Hex digests of protected shared blobs. */
	readonly protectedBlobs: ReadonlySet<string>;
	readonly owners: readonly RetirementOwnerDecision[];
	/** Blob candidates are selected (selector only) by lastRef <= blobThrough. */
	readonly blobThrough: number;
	readonly blobCap: number;
	/** In-transaction owner rewrites (for example the AHE lineage-floor rewrite), exact-compare then put. */
	readonly rewrites?: readonly RetirementRewrite[];
	/** Proof budget for every byte read inside the transaction; charged before any delete. */
	readonly proofBytes: number;
	/** Digest of the decision record, stored with each advanced mark. */
	readonly decisionDigest: Uint8Array;
}

export type RetainedRowKey = readonly [owner: string, scope: string, epoch: number, kind: string, id: string];

export type OwnerOutcome =
	| { readonly kind: "advanced"; readonly from: number; readonly to: number; readonly deleted: number }
	| { readonly kind: "current"; readonly drained: number }
	| { readonly kind: "blocked"; readonly reason: "pending" | "malformed" | "capacity" };

export type RetirementRefusal =
	| "HEAD_CHANGED"
	| "CORRUPT"
	| "STALE"
	| "FLOOR_BEHIND"
	| "BUDGET"
	| "DURABILITY"
	| "INVALID_DECISION";

export type RetirementOutcome =
	| {
			readonly kind: "retired";
			readonly floor: FloorFences;
			readonly owners: Readonly<Record<string, OwnerOutcome>>;
			readonly blobsDeleted: number;
			readonly chargedBytes: number;
	  }
	| { readonly kind: "refused"; readonly reason: RetirementRefusal; readonly detail: string };

export interface OpenVerification {
	/** Exact verified head bytes the caller expects (host floor + verified chain). */
	readonly head: Uint8Array;
	readonly protectedFrom: number;
	readonly owners: readonly string[];
	/** Re-verify one retained row against verified facts; false fails the open closed. */
	readonly verifyRow: (bytes: Uint8Array, key: RetainedRowKey) => boolean;
	/** Bound on rows read per owner while verifying. */
	readonly cap: number;
	readonly blobCap: number;
}

export type OpenOutcome =
	| {
			readonly kind: "verified";
			readonly floor: FloorFences;
			readonly rows: number;
			readonly blobs: number;
			/** Rows at or below a fence awaiting a verified decision (hidden, never deleted on the mark's word). */
			readonly retiredPending: number;
			readonly fencesRaised: readonly string[];
	  }
	| {
			readonly kind: "refused";
			readonly reason: "HEAD_MISMATCH" | "CORRUPT" | "POISONED" | "CAPACITY";
			readonly detail: string;
	  };

export class EpochRetirementError extends Error {
	constructor(
		readonly code: string,
		detail: string
	) {
		super(`${code}: ${detail}`);
		this.name = "EpochRetirementError";
	}
}

interface MarkRecord {
	readonly fence: number;
	readonly drained: number;
	readonly revision: number;
	readonly decision: Uint8Array | null;
}
interface HeadRecord {
	readonly bytes: Uint8Array;
	readonly revision: number;
}
interface BlobRecord {
	readonly scope: string;
	readonly lastRef: number;
	readonly bytes: Uint8Array;
}
interface ReceiptRecord {
	readonly legacyName: string;
	readonly legacyVersion: number;
	readonly rows: number;
	readonly digest: Uint8Array;
}

export interface EpochRetirementStoreOptions {
	readonly databaseName: string;
	readonly floor: EpochRetirementFloorPort;
	/** Synchronous digest used for verify-on-arrival of blobs and for migration receipts. */
	readonly digest: (bytes: Uint8Array) => Uint8Array;
	/** Step observer. A throw aborts at that step; tests use it to model process death there. */
	readonly observe?: (step: RetirementStep | MigrationStep) => void;
}

export function rowKeyText(key: RetainedRowKey): string {
	return JSON.stringify(key);
}

export function hex(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
	return out;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false;
	return true;
}

function isEpoch(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isMark(value: unknown): value is MarkRecord {
	if (typeof value !== "object" || value === null) return false;
	const mark = value as Record<string, unknown>;
	return (
		(mark.fence === NONE || isEpoch(mark.fence)) &&
		(mark.drained === NONE || isEpoch(mark.drained)) &&
		isEpoch(mark.revision) &&
		(mark.decision === null || mark.decision instanceof Uint8Array) &&
		(mark.drained as number) <= (mark.fence as number)
	);
}

function isHead(value: unknown): value is HeadRecord {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as HeadRecord).bytes instanceof Uint8Array &&
		isEpoch((value as HeadRecord).revision)
	);
}

function isBlob(value: unknown): value is BlobRecord {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as BlobRecord).bytes instanceof Uint8Array &&
		typeof (value as BlobRecord).scope === "string" &&
		isEpoch((value as BlobRecord).lastRef)
	);
}

function isBlobKey(value: unknown, scope: string): value is readonly [string, string] {
	return Array.isArray(value) && value.length === 2 && value[0] === scope && typeof value[1] === "string";
}

function isRowKey(value: unknown): value is RetainedRowKey {
	return (
		Array.isArray(value) &&
		value.length === 5 &&
		typeof value[0] === "string" &&
		typeof value[1] === "string" &&
		isEpoch(value[2]) &&
		typeof value[3] === "string" &&
		typeof value[4] === "string"
	);
}

const NO_MARK: MarkRecord = Object.freeze({ fence: NONE, drained: NONE, revision: 0, decision: null });

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
	});
}

function settled(transaction: IDBTransaction): Promise<"complete" | "abort"> {
	return new Promise((resolve) => {
		transaction.addEventListener("complete", () => resolve("complete"), { once: true });
		transaction.addEventListener("abort", () => resolve("abort"), { once: true });
	});
}

function ownerRange(owner: string, scope: string, through: number): IDBKeyRange {
	// Array keys sort after every string, so [.., through, []] bounds every kind/id of `through`.
	return IDBKeyRange.bound([owner, scope, -Infinity], [owner, scope, through, []]);
}

function ownerAll(owner: string, scope: string): IDBKeyRange {
	return IDBKeyRange.bound([owner, scope, -Infinity], [owner, scope, []]);
}

function strictWrite(database: IDBDatabase, stores: readonly string[]): IDBTransaction {
	const transaction = database.transaction(stores as string[], "readwrite", { durability: "strict" });
	if (transaction.durability !== "strict") {
		try {
			transaction.abort();
		} catch {
			/* already finished */
		}
		throw new EpochRetirementError("DURABILITY", "strict durability unavailable");
	}
	return transaction;
}

class Refusal {
	constructor(
		readonly reason: RetirementRefusal,
		readonly detail: string
	) {}
}

function openDatabase(
	name: string,
	version: number,
	upgrade?: (database: IDBDatabase, transaction: IDBTransaction) => void
): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const open = indexedDB.open(name, version);
		open.onupgradeneeded = () => {
			try {
				upgrade?.(open.result, open.transaction!);
			} catch (cause) {
				open.transaction?.abort();
				reject(cause);
			}
		};
		open.onsuccess = () => resolve(open.result);
		open.onerror = () => reject(open.error ?? new Error("IndexedDB open failed"));
	});
}

/**
 * A minimal stand-in for a monotone per-owner `retiredThrough` record in the
 * host floor (spec slice S3). It lives in its own database, as the room-head
 * floor does. Keys are [scope, owner]; values are epochs.
 */
export async function openEpochRetirementFloor(
	databaseName: string
): Promise<EpochRetirementFloorPort & { close(): void }> {
	const database = await openDatabase(databaseName, 1, (db) => {
		db.createObjectStore("retiredThrough");
	});
	database.onversionchange = () => database.close();
	const scopeRange = (scope: string): IDBKeyRange => IDBKeyRange.bound([scope, ""], [scope, []]);
	const collect = async (store: IDBObjectStore, scope: string): Promise<Record<string, number>> => {
		const [keys, values] = await Promise.all([
			request(store.getAllKeys(scopeRange(scope))),
			request(store.getAll(scopeRange(scope))),
		]);
		const out: Record<string, number> = {};
		keys.forEach((key, index) => {
			const value: unknown = values[index];
			if (!Array.isArray(key) || typeof key[1] !== "string" || !isEpoch(value))
				throw new EpochRetirementError("CORRUPT", "floor fence is malformed");
			out[key[1]] = value;
		});
		return out;
	};
	return {
		close: () => database.close(),
		async read(scope) {
			return collect(database.transaction("retiredThrough", "readonly").objectStore("retiredThrough"), scope);
		},
		async fence(scope, through) {
			for (const value of Object.values(through))
				if (value !== NONE && !isEpoch(value)) throw new EpochRetirementError("INVALID_DECISION", "floor fence epoch");
			const transaction = strictWrite(database, ["retiredThrough"]);
			const done = settled(transaction);
			const store = transaction.objectStore("retiredThrough");
			let current: Record<string, number>;
			try {
				current = await collect(store, scope);
			} catch (cause) {
				transaction.abort();
				await done;
				throw cause;
			}
			for (const [owner, value] of Object.entries(through)) {
				if (value > (current[owner] ?? NONE)) {
					store.put(value, [scope, owner]);
					current[owner] = value;
				}
			}
			if ((await done) !== "complete") throw new EpochRetirementError("ABORTED", "floor fence transaction aborted");
			return current;
		},
	};
}

function floorOf(floor: FloorFences, owner: string): number {
	const value = floor[owner];
	return value === undefined ? NONE : value;
}

export class EpochRetirementStore {
	readonly #database: IDBDatabase;
	readonly #options: EpochRetirementStoreOptions;
	/** Highest host floor fence observed per JSON [scope, owner]; reads and writes refuse at or below it. */
	readonly #floorSeen = new Map<string, number>();
	readonly #verified = new Set<string>();
	#closed = false;

	private constructor(database: IDBDatabase, options: EpochRetirementStoreOptions) {
		this.#database = database;
		this.#options = options;
		// A newer schema (or a migration fence) closes this connection: a stale
		// writer can never keep writing under an older format.
		database.onversionchange = () => {
			this.#closed = true;
			database.close();
		};
	}

	static async open(options: EpochRetirementStoreOptions): Promise<EpochRetirementStore> {
		const database = await openDatabase(options.databaseName, EPOCH_RETIREMENT_DATABASE_VERSION, (db) => {
			db.createObjectStore(ROWS);
			db.createObjectStore(BLOBS).createIndex(BLOBS_BY_LAST_REF, ["scope", "lastRef"]);
			db.createObjectStore(HEADS);
			db.createObjectStore(MARKS);
			db.createObjectStore(RECEIPTS);
		});
		for (const name of ALL_STORES) {
			if (!database.objectStoreNames.contains(name)) {
				database.close();
				throw new EpochRetirementError("CORRUPT", `schema lacks ${name}`);
			}
		}
		return new EpochRetirementStore(database, options);
	}

	get closed(): boolean {
		return this.#closed;
	}

	close(): void {
		this.#closed = true;
		this.#database.close();
	}

	#assertOpen(): void {
		if (this.#closed) throw new EpochRetirementError("STORE_CLOSED", "connection closed");
	}

	/** G5: nothing is read, written or retired for a scope until this connection re-verified it. */
	#assertVerified(scope: string): void {
		this.#assertOpen();
		if (!this.#verified.has(scope))
			throw new EpochRetirementError("UNVERIFIED", `scope ${scope} not verified on this open`);
	}

	#observe(step: RetirementStep | MigrationStep): void {
		this.#options.observe?.(step);
	}

	#fenceFor(scope: string, owner: string, mark: MarkRecord): number {
		return Math.max(mark.fence, this.#floorSeen.get(JSON.stringify([scope, owner])) ?? NONE);
	}

	/** Compare-and-set of the exact head bytes (null expected means absent). */
	async putHead(scope: string, expected: Uint8Array | null, next: Uint8Array): Promise<void> {
		if (expected === null) this.#assertOpen();
		else this.#assertVerified(scope);
		const transaction = strictWrite(this.#database, [HEADS]);
		const done = settled(transaction);
		const store = transaction.objectStore(HEADS);
		const current: unknown = await request(store.get(scope));
		const matches = expected === null ? current === undefined : isHead(current) && bytesEqual(current.bytes, expected);
		if (!matches) {
			transaction.abort();
			await done;
			throw new EpochRetirementError("HEAD_CHANGED", "head compare-and-set refused");
		}
		const revision = isHead(current) ? current.revision + 1 : 0;
		store.put({ bytes: next.slice(), revision } satisfies HeadRecord, scope);
		if ((await done) !== "complete") throw new EpochRetirementError("ABORTED", "head transaction aborted");
	}

	/**
	 * Writer path: rows and blobs are appended in one strict transaction. Every
	 * row is checked against its owner's mark IN THIS transaction (the
	 * store-local write fence): an epoch at or below the fence is RETIRED and the
	 * whole append has zero writes. Rows are immutable exact bytes per key.
	 */
	async append(rows: readonly RetainedRowInput[], blobs: readonly RetainedBlobInput[] = []): Promise<void> {
		for (const scope of new Set([...rows.map((row) => row.scope), ...blobs.map((blob) => blob.scope)]))
			this.#assertVerified(scope);
		for (const row of rows) {
			if (!isRowKey([row.owner, row.scope, row.epoch, row.kind, row.id]) || !(row.bytes instanceof Uint8Array))
				throw new EpochRetirementError("INVALID_ARGUMENT", "row");
		}
		for (const blob of blobs) {
			// Verify on arrival: the content address is recomputed, never trusted.
			if (
				!isEpoch(blob.epoch) ||
				!(blob.bytes instanceof Uint8Array) ||
				hex(this.#options.digest(blob.bytes)) !== blob.digest
			)
				throw new EpochRetirementError("POISONED", `blob ${blob.digest} does not match its digest`);
		}
		const transaction = strictWrite(this.#database, [ROWS, BLOBS, MARKS]);
		const done = settled(transaction);
		const rowStore = transaction.objectStore(ROWS);
		const blobStore = transaction.objectStore(BLOBS);
		const marks = transaction.objectStore(MARKS);
		let refusal: EpochRetirementError | undefined;
		try {
			const fences = new Map<string, number>();
			const batch = new Map<string, Uint8Array>();
			for (const row of rows) {
				const text = rowKeyText([row.owner, row.scope, row.epoch, row.kind, row.id]);
				const twin = batch.get(text);
				if (twin !== undefined && !bytesEqual(twin, row.bytes))
					throw new EpochRetirementError("CONFLICT", `row ${text} appears twice with different bytes`);
				batch.set(text, row.bytes);
				const markKey = JSON.stringify([row.scope, row.owner]);
				let fence = fences.get(markKey);
				if (fence === undefined) {
					const mark: unknown = await request(marks.get([row.scope, row.owner]));
					if (mark !== undefined && !isMark(mark)) throw new EpochRetirementError("CORRUPT", "malformed mark");
					fence = this.#fenceFor(row.scope, row.owner, mark ?? NO_MARK);
					fences.set(markKey, fence);
				}
				if (row.epoch <= fence)
					throw new EpochRetirementError("RETIRED", `${row.owner} epoch ${row.epoch} <= fence ${fence}`);
				const key = [row.owner, row.scope, row.epoch, row.kind, row.id];
				const existing: unknown = await request(rowStore.get(key));
				if (existing !== undefined && !(existing instanceof Uint8Array && bytesEqual(existing, row.bytes)))
					throw new EpochRetirementError("CONFLICT", `row ${rowKeyText(key as unknown as RetainedRowKey)} differs`);
			}
			const lastRefs = new Map<string, BlobRecord & { readonly digest: string }>();
			const blobFences = new Map<string, number>();
			for (const blob of blobs) {
				let fence = blobFences.get(blob.scope);
				if (fence === undefined) {
					const mark: unknown = await request(marks.get([blob.scope, BLOB_MARK_OWNER]));
					if (mark !== undefined && !isMark(mark)) throw new EpochRetirementError("CORRUPT", "malformed blob mark");
					fence = (mark ?? NO_MARK).fence;
					blobFences.set(blob.scope, fence);
				}
				if (blob.epoch <= fence)
					throw new EpochRetirementError("RETIRED", `blob reference epoch ${blob.epoch} <= fence ${fence}`);
				const id = JSON.stringify([blob.scope, blob.digest]);
				const existing: unknown = lastRefs.get(id) ?? (await request(blobStore.get([blob.scope, blob.digest])));
				const lastRef = isBlob(existing) ? Math.max(existing.lastRef, blob.epoch) : blob.epoch;
				// Verified bytes replace whatever bytes sat under this content address.
				lastRefs.set(id, { scope: blob.scope, digest: blob.digest, lastRef, bytes: blob.bytes });
			}
			for (const row of rows) rowStore.put(row.bytes.slice(), [row.owner, row.scope, row.epoch, row.kind, row.id]);
			for (const { scope, digest, lastRef, bytes } of lastRefs.values())
				blobStore.put({ scope, lastRef, bytes: bytes.slice() } satisfies BlobRecord, [scope, digest]);
		} catch (cause) {
			refusal = cause instanceof EpochRetirementError ? cause : new EpochRetirementError("FAILED", String(cause));
			try {
				transaction.abort();
			} catch {
				/* already finished */
			}
		}
		const outcome = await done;
		if (refusal !== undefined) throw refusal;
		if (outcome !== "complete") throw new EpochRetirementError("ABORTED", "append transaction aborted");
	}

	/** Late update of one existing row (for example an issuance acknowledgement); the same fence applies. */
	async replace(key: RetainedRowKey, expected: Uint8Array, next: Uint8Array): Promise<void> {
		if (!isRowKey(key)) throw new EpochRetirementError("INVALID_ARGUMENT", "row key");
		this.#assertVerified(key[1]);
		const transaction = strictWrite(this.#database, [ROWS, MARKS]);
		const done = settled(transaction);
		let refusal: EpochRetirementError | undefined;
		try {
			const mark: unknown = await request(transaction.objectStore(MARKS).get([key[1], key[0]]));
			if (mark !== undefined && !isMark(mark)) throw new EpochRetirementError("CORRUPT", "malformed mark");
			const fence = this.#fenceFor(key[1], key[0], mark ?? NO_MARK);
			if (key[2] <= fence)
				throw new EpochRetirementError("RECORD_PRUNED", `${key[0]} epoch ${key[2]} <= fence ${fence}`);
			const rows = transaction.objectStore(ROWS);
			const current: unknown = await request(rows.get(key as unknown as IDBValidKey));
			if (!(current instanceof Uint8Array) || !bytesEqual(current, expected))
				throw new EpochRetirementError("CONFLICT", "row changed");
			rows.put(next.slice(), key as unknown as IDBValidKey);
		} catch (cause) {
			refusal = cause instanceof EpochRetirementError ? cause : new EpochRetirementError("FAILED", String(cause));
			try {
				transaction.abort();
			} catch {
				/* already finished */
			}
		}
		const outcome = await done;
		if (refusal !== undefined) throw refusal;
		if (outcome !== "complete") throw new EpochRetirementError("ABORTED", "replace transaction aborted");
	}

	/** Reads hide every row at or below the owner's fence (mark or observed host floor). */
	async read(key: RetainedRowKey): Promise<Uint8Array | undefined> {
		this.#assertVerified(key[1]);
		const transaction = this.#database.transaction([ROWS, MARKS], "readonly");
		const [mark, value] = await Promise.all([
			request(transaction.objectStore(MARKS).get([key[1], key[0]])) as Promise<unknown>,
			request(transaction.objectStore(ROWS).get(key as unknown as IDBValidKey)) as Promise<unknown>,
		]);
		if (mark !== undefined && !isMark(mark)) throw new EpochRetirementError("CORRUPT", "malformed mark");
		if (key[2] <= this.#fenceFor(key[1], key[0], mark ?? NO_MARK)) return undefined;
		return value instanceof Uint8Array ? value : undefined;
	}

	async readBlob(scope: string, digest: string): Promise<Uint8Array | undefined> {
		this.#assertVerified(scope);
		const value: unknown = await request(
			this.#database.transaction(BLOBS, "readonly").objectStore(BLOBS).get([scope, digest])
		);
		if (value === undefined) return undefined;
		if (!isBlob(value) || hex(this.#options.digest(value.bytes)) !== digest)
			throw new EpochRetirementError("POISONED", `blob ${digest}`);
		return value.bytes;
	}

	async mark(scope: string, owner: string): Promise<{ fence: number; drained: number; revision: number }> {
		const value: unknown = await request(
			this.#database.transaction(MARKS, "readonly").objectStore(MARKS).get([scope, owner])
		);
		if (value !== undefined && !isMark(value)) throw new EpochRetirementError("CORRUPT", "malformed mark");
		const mark = value ?? NO_MARK;
		return { fence: mark.fence, drained: mark.drained, revision: mark.revision };
	}

	/** Raw counts for tests and measurement (no trust implied). */
	async counts(): Promise<{ rows: number; blobs: number }> {
		const transaction = this.#database.transaction([ROWS, BLOBS], "readonly");
		const [rows, blobs] = await Promise.all([
			request(transaction.objectStore(ROWS).count()),
			request(transaction.objectStore(BLOBS).count()),
		]);
		return { rows, blobs };
	}

	/**
	 * One retirement: step A (host floor fence, monotone) then step B (one strict
	 * read-write transaction in this database). Every refusal leaves zero writes
	 * in this database. Replays are idempotent.
	 */
	async retire(decision: RetirementDecision): Promise<RetirementOutcome> {
		this.#assertOpen();
		const invalid = validateDecision(decision);
		if (invalid !== undefined) return { kind: "refused", reason: "INVALID_DECISION", detail: invalid };
		this.#assertVerified(decision.scope);
		const wanted: Record<string, number> = {};
		for (const owner of decision.owners) wanted[owner.owner] = owner.through;
		// Step A: the floor learns first, per owner. Crash after this point retains too much.
		this.#observe("before-floor");
		const floor = await this.#options.floor.fence(decision.scope, wanted);
		for (const owner of decision.owners) {
			if (floorOf(floor, owner.owner) < owner.through)
				return {
					kind: "refused",
					reason: "FLOOR_BEHIND",
					detail: `${owner.owner} floor ${floorOf(floor, owner.owner)} < ${owner.through}`,
				};
		}
		this.#noteFloor(decision.scope, floor);
		this.#observe("after-floor");
		// Step B.
		let transaction: IDBTransaction;
		try {
			transaction = strictWrite(this.#database, [ROWS, BLOBS, HEADS, MARKS]);
		} catch (cause) {
			if (cause instanceof EpochRetirementError && cause.code === "DURABILITY")
				return { kind: "refused", reason: "DURABILITY", detail: cause.message };
			throw cause;
		}
		const done = settled(transaction);
		let result: RetirementOutcome | undefined;
		let crash: unknown;
		let crashed = false;
		try {
			result = await this.#retireInside(transaction, decision, floor);
		} catch (cause) {
			if (cause instanceof Refusal) result = { kind: "refused", reason: cause.reason, detail: cause.detail };
			else {
				crash = cause;
				crashed = true;
			}
		}
		if (crashed || result?.kind === "refused") {
			try {
				transaction.abort();
			} catch {
				/* already finished */
			}
		}
		const outcome = await done;
		if (crashed) throw crash;
		if (result?.kind === "retired") {
			if (outcome !== "complete") throw new EpochRetirementError("ABORTED", "retirement transaction aborted");
			this.#observe("after-commit");
		}
		return result!;
	}

	#noteFloor(scope: string, floor: FloorFences): void {
		for (const [owner, value] of Object.entries(floor)) {
			const key = JSON.stringify([scope, owner]);
			this.#floorSeen.set(key, Math.max(this.#floorSeen.get(key) ?? NONE, value));
		}
	}

	async #retireInside(
		transaction: IDBTransaction,
		decision: RetirementDecision,
		floor: FloorFences
	): Promise<RetirementOutcome> {
		const rows = transaction.objectStore(ROWS);
		const blobs = transaction.objectStore(BLOBS);
		const marks = transaction.objectStore(MARKS);
		let charged = 0;
		const charge = (bytes: number): void => {
			charged += bytes;
			if (charged > decision.proofBytes) throw new Refusal("BUDGET", `charged ${charged} > ${decision.proofBytes}`);
		};
		// 1. Exact head: any adoption, rollback, restore or foreign write since the
		// caller verified its facts refuses with zero writes.
		const head: unknown = await request(transaction.objectStore(HEADS).get(decision.scope));
		if (!isHead(head) || !bytesEqual(head.bytes, decision.head))
			throw new Refusal("HEAD_CHANGED", "head bytes differ from the verified head");
		charge(head.bytes.byteLength);
		// 2. Marks: currency read in this transaction; anything contradicting the
		// verified facts or the floor fails closed.
		const plans: Array<{ owner: RetirementOwnerDecision; mark: MarkRecord }> = [];
		const outcomes: Record<string, OwnerOutcome> = {};
		for (const owner of decision.owners) {
			const value: unknown = await request(marks.get([decision.scope, owner.owner]));
			if (value !== undefined && !isMark(value)) throw new Refusal("CORRUPT", `malformed mark for ${owner.owner}`);
			const mark = value ?? NO_MARK;
			charge(64);
			if (mark.fence >= decision.protectedFrom)
				throw new Refusal("CORRUPT", `${owner.owner} fence ${mark.fence} reaches protected ${decision.protectedFrom}`);
			if (mark.fence > floorOf(floor, owner.owner))
				throw new Refusal(
					"STALE",
					`${owner.owner} fence ${mark.fence} above observed floor ${floorOf(floor, owner.owner)}`
				);
			if (mark.drained >= owner.through) {
				outcomes[owner.owner] = { kind: "current", drained: mark.drained };
				continue;
			}
			plans.push({ owner, mark });
		}
		// 3. Bounded candidate census and classification per owner.
		const advancing: Array<{ owner: RetirementOwnerDecision; mark: MarkRecord; count: number }> = [];
		for (const { owner, mark } of plans) {
			const range = ownerRange(owner.owner, decision.scope, owner.through);
			const [values, keys] = await Promise.all([
				request(rows.getAll(range, owner.cap + 1)),
				request(rows.getAllKeys(range, owner.cap + 1)),
			]);
			if (values.length !== keys.length) throw new Refusal("CORRUPT", "candidate census disagrees");
			if (values.length > owner.cap) {
				outcomes[owner.owner] = { kind: "blocked", reason: "capacity" };
				continue;
			}
			let blocked: "pending" | "malformed" | undefined;
			for (let index = 0; index < values.length; index++) {
				const key: unknown = keys[index];
				const value: unknown = values[index];
				if (!isRowKey(key)) {
					blocked ??= "malformed";
					continue;
				}
				if (decision.protectedRows.has(rowKeyText(key)))
					throw new Refusal("CORRUPT", `protected row ${rowKeyText(key)} inside retired range`);
				if (!(value instanceof Uint8Array)) {
					blocked ??= "malformed";
					continue;
				}
				charge(value.byteLength + rowKeyText(key).length);
				let verdict: RowClass;
				try {
					verdict = owner.classify(value, key);
				} catch {
					verdict = "malformed";
				}
				if (verdict === "block") blocked ??= "pending";
				else if (verdict === "malformed") blocked = "malformed";
			}
			if (blocked !== undefined) {
				outcomes[owner.owner] = { kind: "blocked", reason: blocked };
				continue;
			}
			advancing.push({ owner, mark, count: values.length });
		}
		// 4. Rewrites are exact-compared before any write.
		for (const rewrite of decision.rewrites ?? []) {
			if (rewrite.key[1] !== decision.scope || rewrite.key[2] < decision.protectedFrom)
				throw new Refusal("INVALID_DECISION", "rewrite outside the protected set");
			const current: unknown = await request(rows.get(rewrite.key as unknown as IDBValidKey));
			if (!(current instanceof Uint8Array) || !bytesEqual(current, rewrite.expected))
				throw new Refusal("CORRUPT", `rewrite source ${rowKeyText(rewrite.key)} changed`);
			charge(current.byteLength);
		}
		// 5. Shared blobs: lastRef only SELECTS; the verified protected set decides.
		const blobRange = IDBKeyRange.bound([decision.scope, -Infinity], [decision.scope, decision.blobThrough]);
		const blobIndex = blobs.index(BLOBS_BY_LAST_REF);
		const blobKeys = await request(blobIndex.getAllKeys(blobRange, decision.blobCap + 1));
		const doomedBlobs: IDBValidKey[] = [];
		const blobMarkValue: unknown = await request(marks.get([decision.scope, BLOB_MARK_OWNER]));
		if (blobMarkValue !== undefined && !isMark(blobMarkValue)) throw new Refusal("CORRUPT", "malformed blob mark");
		const blobMark = blobMarkValue ?? NO_MARK;
		if (blobMark.fence >= decision.protectedFrom) throw new Refusal("CORRUPT", "blob fence reaches the protected set");
		const blobsDrained = blobKeys.length <= decision.blobCap && decision.blobThrough > blobMark.drained;
		if (blobKeys.length <= decision.blobCap) {
			for (const key of blobKeys) {
				charge(64);
				// A mis-shaped key is never deleted on a selector's word.
				if (isBlobKey(key, decision.scope) && !decision.protectedBlobs.has(key[1])) doomedBlobs.push(key);
			}
		}
		this.#observe("after-reads");
		// 6. Effects: deletes, rewrites, then the marks, all in this transaction.
		for (const { owner } of advancing) rows.delete(ownerRange(owner.owner, decision.scope, owner.through));
		for (const rewrite of decision.rewrites ?? [])
			rows.put(rewrite.next.slice(), rewrite.key as unknown as IDBValidKey);
		for (const key of doomedBlobs) blobs.delete(key);
		this.#observe("after-deletes");
		for (const { owner, mark, count } of advancing) {
			marks.put(
				{
					fence: Math.max(mark.fence, owner.through),
					drained: owner.through,
					revision: mark.revision + 1,
					decision: decision.decisionDigest.slice(),
				} satisfies MarkRecord,
				[decision.scope, owner.owner]
			);
			outcomes[owner.owner] = { kind: "advanced", from: mark.drained, to: owner.through, deleted: count };
		}
		if (blobsDrained) {
			marks.put(
				{
					fence: Math.max(blobMark.fence, decision.blobThrough),
					drained: decision.blobThrough,
					revision: blobMark.revision + 1,
					decision: decision.decisionDigest.slice(),
				} satisfies MarkRecord,
				[decision.scope, BLOB_MARK_OWNER]
			);
		}
		return { kind: "retired", floor, owners: outcomes, blobsDeleted: doomedBlobs.length, chargedBytes: charged };
	}

	/**
	 * Verify on open: re-read and re-verify the bounded retained window against
	 * the caller's verified facts and the host floor. Marks are read before the
	 * floor, so a legitimate mark can never exceed the floor read after it.
	 * Rows at or below a fence are hidden and counted, never deleted here. A
	 * floor above a mark only RAISES that mark's write fence (no deletion).
	 */
	async verifyOnOpen(scope: string, verification: OpenVerification): Promise<OpenOutcome> {
		this.#assertOpen();
		const transaction = this.#database.transaction([ROWS, BLOBS, HEADS, MARKS], "readonly");
		const head: unknown = await request(transaction.objectStore(HEADS).get(scope));
		const marks = new Map<string, MarkRecord>();
		for (const owner of verification.owners) {
			const value: unknown = await request(transaction.objectStore(MARKS).get([scope, owner]));
			if (value !== undefined && !isMark(value))
				return { kind: "refused", reason: "CORRUPT", detail: `malformed mark for ${owner}` };
			marks.set(owner, value ?? NO_MARK);
		}
		const rowsByOwner = new Map<string, { values: unknown[]; keys: IDBValidKey[] }>();
		for (const owner of verification.owners) {
			const range = ownerAll(owner, scope);
			const [values, keys] = await Promise.all([
				request(transaction.objectStore(ROWS).getAll(range, verification.cap + 1)),
				request(transaction.objectStore(ROWS).getAllKeys(range, verification.cap + 1)),
			]);
			if (values.length > verification.cap)
				return { kind: "refused", reason: "CAPACITY", detail: `${owner} exceeds ${verification.cap}` };
			rowsByOwner.set(owner, { values, keys });
		}
		const blobIndex = transaction.objectStore(BLOBS).index(BLOBS_BY_LAST_REF);
		const blobRange = IDBKeyRange.bound([scope, -Infinity], [scope, []]);
		const [blobValues, blobKeys] = await Promise.all([
			request(blobIndex.getAll(blobRange, verification.blobCap + 1)),
			request(blobIndex.getAllKeys(blobRange, verification.blobCap + 1)),
		]);
		if (blobValues.length > verification.blobCap) return { kind: "refused", reason: "CAPACITY", detail: "blobs" };
		const floor = await this.#options.floor.read(scope);
		if (!isHead(head) || !bytesEqual(head.bytes, verification.head))
			return { kind: "refused", reason: "HEAD_MISMATCH", detail: "head differs from the verified head" };
		let retiredPending = 0,
			verified = 0;
		const raise: string[] = [];
		for (const owner of verification.owners) {
			const mark = marks.get(owner)!;
			const ownerFloor = floorOf(floor, owner);
			if (mark.fence > ownerFloor)
				return {
					kind: "refused",
					reason: "CORRUPT",
					detail: `${owner} fence ${mark.fence} above host floor ${ownerFloor}`,
				};
			if (mark.fence >= verification.protectedFrom)
				return { kind: "refused", reason: "CORRUPT", detail: `${owner} fence reaches the protected set` };
			const fence = Math.max(mark.fence, ownerFloor);
			if (ownerFloor > mark.fence) raise.push(owner);
			const { values, keys } = rowsByOwner.get(owner)!;
			for (let index = 0; index < values.length; index++) {
				const key: unknown = keys[index];
				const value: unknown = values[index];
				if (!isRowKey(key)) return { kind: "refused", reason: "POISONED", detail: "mis-shaped row key" };
				if (key[2] <= fence) {
					retiredPending++;
					continue;
				}
				if (!(value instanceof Uint8Array) || !verification.verifyRow(value, key))
					return { kind: "refused", reason: "POISONED", detail: `row ${rowKeyText(key)} failed re-verification` };
				verified++;
			}
		}
		for (let index = 0; index < blobValues.length; index++) {
			const value: unknown = blobValues[index];
			const key: unknown = blobKeys[index];
			if (!isBlob(value) || !isBlobKey(key, scope) || hex(this.#options.digest(value.bytes)) !== key[1])
				return { kind: "refused", reason: "POISONED", detail: `blob ${JSON.stringify(key)} failed re-verification` };
		}
		if (raise.length > 0) {
			// Install the floor's fence store-locally before any deletion can be decided.
			const write = strictWrite(this.#database, [MARKS]);
			const done = settled(write);
			const store = write.objectStore(MARKS);
			let lost = false;
			for (const owner of raise) {
				const current: unknown = await request(store.get([scope, owner]));
				if (current !== undefined && !isMark(current)) {
					lost = true;
					break;
				}
				const mark = current ?? NO_MARK;
				const ownerFloor = floorOf(floor, owner);
				if (mark.fence < ownerFloor)
					store.put({ ...mark, fence: ownerFloor, revision: mark.revision + 1 } satisfies MarkRecord, [scope, owner]);
			}
			if (lost) {
				write.abort();
				await done;
				return { kind: "refused", reason: "CORRUPT", detail: "mark changed while raising fences" };
			}
			if ((await done) !== "complete") throw new EpochRetirementError("ABORTED", "fence transaction aborted");
		}
		this.#noteFloor(scope, floor);
		this.#verified.add(scope);
		return { kind: "verified", floor, rows: verified, blobs: blobValues.length, retiredPending, fencesRaised: raise };
	}

	/**
	 * Authenticated migration from legacy databases (G25):
	 * 1. fence: reopen the legacy database at version+1 adding only a fence
	 *    store, so old code (fixed older version) gets VersionError and open old
	 *    connections receive versionchange;
	 * 2. authenticate: read it under one readonly transaction; `carry` verifies
	 *    and maps each row (a throw fails the migration closed);
	 * 3. copy: one strict transaction writes rows, marks and a receipt;
	 * 4. delete the legacy database. A receipt means the legacy database is
	 *    never read as authority again; it is only deleted (idempotent).
	 */
	async migrateLegacy(sources: readonly LegacyRetentionSource[]): Promise<readonly MigrationReport[]> {
		this.#assertOpen();
		const reports: MigrationReport[] = [];
		for (const source of sources) {
			const receipt: unknown = await request(
				this.#database.transaction(RECEIPTS, "readonly").objectStore(RECEIPTS).get(source.databaseName)
			);
			const exists = (await indexedDB.databases()).find((info) => info.name === source.databaseName);
			if (receipt !== undefined) {
				if (exists !== undefined) await deleteDatabase(source.databaseName);
				reports.push({
					databaseName: source.databaseName,
					kind: exists === undefined ? "already-migrated" : "deleted-after-receipt",
				});
				continue;
			}
			if (exists === undefined) {
				reports.push({ databaseName: source.databaseName, kind: "absent" });
				continue;
			}
			const legacy = await fenceLegacy(source.databaseName, exists.version ?? 1);
			let carried: { rows: RetainedRowInput[]; marks: Record<string, number>; digest: Uint8Array };
			try {
				this.#observe("after-fence");
				carried = await this.#authenticate(legacy.database, source);
			} finally {
				legacy.database.close();
			}
			// Floor first (step A), as for a retirement: a crash before the copy
			// leaves the floor ahead, which only raises fences at the next open.
			const floorThrough = new Map<string, Record<string, number>>();
			for (const [markKey, value] of Object.entries(carried.marks)) {
				const [scope, owner] = JSON.parse(markKey) as [string, string];
				const fences = floorThrough.get(scope) ?? {};
				fences[owner] = value;
				floorThrough.set(scope, fences);
			}
			for (const [scope, fences] of floorThrough) {
				const after = await this.#options.floor.fence(scope, fences);
				for (const [owner, value] of Object.entries(fences))
					if (floorOf(after, owner) < value)
						throw new EpochRetirementError("FLOOR_BEHIND", `floor for ${scope}/${owner}`);
			}
			const transaction = strictWrite(this.#database, [ROWS, MARKS, RECEIPTS]);
			const done = settled(transaction);
			let refusal: EpochRetirementError | undefined;
			try {
				const prior: unknown = await request(transaction.objectStore(RECEIPTS).get(source.databaseName));
				if (prior === undefined) {
					for (const row of carried.rows) {
						const key = [row.owner, row.scope, row.epoch, row.kind, row.id];
						const existing: unknown = await request(transaction.objectStore(ROWS).get(key));
						if (existing !== undefined && !(existing instanceof Uint8Array && bytesEqual(existing, row.bytes)))
							throw new EpochRetirementError(
								"CONFLICT",
								`migrated row ${rowKeyText(key as unknown as RetainedRowKey)} differs`
							);
						transaction.objectStore(ROWS).put(row.bytes.slice(), key);
					}
					for (const [markKey, value] of Object.entries(carried.marks)) {
						const [scope, owner] = JSON.parse(markKey) as [string, string];
						const current: unknown = await request(transaction.objectStore(MARKS).get([scope, owner]));
						if (current !== undefined && !isMark(current)) throw new EpochRetirementError("CORRUPT", "malformed mark");
						const mark = current ?? NO_MARK;
						// A legacy completion installs a write FENCE only. Carried rows at or
						// below it stay hidden until a verified decision deletes them.
						if (value > mark.fence)
							transaction
								.objectStore(MARKS)
								.put({ ...mark, fence: value, revision: mark.revision + 1 } satisfies MarkRecord, [scope, owner]);
					}
					transaction.objectStore(RECEIPTS).put(
						{
							legacyName: source.databaseName,
							legacyVersion: legacy.version,
							rows: carried.rows.length,
							digest: carried.digest,
						} satisfies ReceiptRecord,
						source.databaseName
					);
				}
			} catch (cause) {
				refusal = cause instanceof EpochRetirementError ? cause : new EpochRetirementError("FAILED", String(cause));
				try {
					transaction.abort();
				} catch {
					/* already finished */
				}
			}
			const outcome = await done;
			if (refusal !== undefined) throw refusal;
			if (outcome !== "complete") throw new EpochRetirementError("ABORTED", "migration copy aborted");
			this.#observe("after-copy");
			await deleteDatabase(source.databaseName);
			this.#observe("after-delete");
			reports.push({ databaseName: source.databaseName, kind: "migrated", rows: carried.rows.length });
		}
		return reports;
	}

	async receipt(legacyName: string): Promise<{ rows: number; digest: Uint8Array; legacyVersion: number } | undefined> {
		const value = (await request(
			this.#database.transaction(RECEIPTS, "readonly").objectStore(RECEIPTS).get(legacyName)
		)) as ReceiptRecord | undefined;
		return value === undefined
			? undefined
			: { rows: value.rows, digest: value.digest, legacyVersion: value.legacyVersion };
	}

	async #authenticate(
		database: IDBDatabase,
		source: LegacyRetentionSource
	): Promise<{ rows: RetainedRowInput[]; marks: Record<string, number>; digest: Uint8Array }> {
		const transaction = database.transaction(source.stores as string[], "readonly");
		const image = new Map<string, Array<readonly [IDBValidKey, unknown]>>();
		for (const store of source.stores) {
			const objectStore = transaction.objectStore(store);
			const [values, keys] = await Promise.all([
				request(objectStore.getAll(null, source.cap + 1)),
				request(objectStore.getAllKeys(null, source.cap + 1)),
			]);
			if (keys.length > source.cap)
				throw new EpochRetirementError("CAPACITY", `${source.databaseName}/${store} exceeds ${source.cap}`);
			image.set(
				store,
				keys.map((key, index) => [key, values[index]] as const)
			);
		}
		const rows: RetainedRowInput[] = [];
		for (const store of source.stores) {
			for (const [key, value] of image.get(store)!) {
				const carried = source.carry(store, key, value);
				if (carried === undefined) continue;
				if (
					!isRowKey([carried.owner, carried.scope, carried.epoch, carried.kind, carried.id]) ||
					!(carried.bytes instanceof Uint8Array)
				)
					throw new EpochRetirementError("POISONED", `legacy row ${String(key)} maps to an invalid row`);
				rows.push(carried);
			}
		}
		rows.sort((left, right) => compareRowKeys(left, right));
		const marks: Record<string, number> = {};
		for (const [scopeOwner, through] of Object.entries(source.marks(image))) {
			if (!isEpoch(through)) throw new EpochRetirementError("POISONED", "legacy mark");
			marks[scopeOwner] = through;
		}
		// The receipt binds what was copied: every carried key and exact bytes, in key order.
		const encoder = new TextEncoder();
		const parts: Uint8Array[] = [];
		for (const row of rows) {
			const key = encoder.encode(JSON.stringify([row.owner, row.scope, row.epoch, row.kind, row.id]));
			parts.push(lengthPrefix(key.byteLength), key, lengthPrefix(row.bytes.byteLength), row.bytes);
		}
		return { rows, marks, digest: this.#options.digest(concat(parts)) };
	}
}

export interface LegacyRetentionSource {
	readonly databaseName: string;
	readonly stores: readonly string[];
	/** Reviewed bound on rows read per legacy store. */
	readonly cap: number;
	/**
	 * Authenticate one legacy row against verified facts and map it to exact
	 * retained bytes. undefined drops an unprotected row (retains less, deletes
	 * nothing protected); a throw fails the whole migration closed.
	 */
	readonly carry: (store: string, key: IDBValidKey, value: unknown) => RetainedRowInput | undefined;
	/** Completed legacy retirement per JSON [scope, owner]; absent means -1 (retain everything). */
	readonly marks: (
		image: ReadonlyMap<string, ReadonlyArray<readonly [IDBValidKey, unknown]>>
	) => Readonly<Record<string, number>>;
}

export type MigrationReport =
	| { readonly databaseName: string; readonly kind: "migrated"; readonly rows: number }
	| { readonly databaseName: string; readonly kind: "already-migrated" | "deleted-after-receipt" | "absent" };

function compareRowKeys(left: RetainedRowInput, right: RetainedRowInput): number {
	const a = [left.owner, left.scope, left.epoch, left.kind, left.id];
	const b = [right.owner, right.scope, right.epoch, right.kind, right.id];
	return indexedDB.cmp(a, b);
}

function lengthPrefix(length: number): Uint8Array {
	const out = new Uint8Array(8);
	new DataView(out.buffer).setBigUint64(0, BigInt(length));
	return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

async function fenceLegacy(name: string, version: number): Promise<{ database: IDBDatabase; version: number }> {
	// Already fenced (a crash after step 1): reopen at its current version.
	const probe = await openDatabase(name, version);
	if (probe.objectStoreNames.contains(FENCE_STORE)) {
		probe.onversionchange = () => probe.close();
		return { database: probe, version };
	}
	probe.close();
	const database = await openDatabase(name, version + 1, (db, transaction) => {
		db.createObjectStore(FENCE_STORE);
		transaction.objectStore(FENCE_STORE).put({ fencedFrom: version }, "fence");
	});
	database.onversionchange = () => database.close();
	return { database, version: version + 1 };
}

function deleteDatabase(name: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const deletion = indexedDB.deleteDatabase(name);
		deletion.onsuccess = () => resolve();
		deletion.onerror = () => reject(deletion.error ?? new Error("IndexedDB delete failed"));
	});
}

function validateDecision(decision: RetirementDecision): string | undefined {
	if (typeof decision.scope !== "string" || decision.scope.length === 0) return "scope";
	if (!(decision.head instanceof Uint8Array)) return "head";
	if (!isEpoch(decision.protectedFrom)) return "protectedFrom";
	if (decision.owners.length === 0) return "owners";
	const seen = new Set<string>();
	for (const owner of decision.owners) {
		if (
			typeof owner.owner !== "string" ||
			owner.owner.length === 0 ||
			owner.owner.startsWith("#") ||
			seen.has(owner.owner)
		)
			return "owner";
		seen.add(owner.owner);
		if ((owner.through !== NONE && !isEpoch(owner.through)) || owner.through >= decision.protectedFrom)
			return `through for ${owner.owner}`;
		if (!Number.isSafeInteger(owner.cap) || owner.cap < 0) return "cap";
	}
	if (
		!(decision.blobThrough === NONE || isEpoch(decision.blobThrough)) ||
		decision.blobThrough >= decision.protectedFrom
	)
		return "blobThrough";
	if (!Number.isSafeInteger(decision.blobCap) || decision.blobCap < 0) return "blobCap";
	if (!Number.isSafeInteger(decision.proofBytes) || decision.proofBytes <= 0) return "proofBytes";
	if (!(decision.decisionDigest instanceof Uint8Array)) return "decisionDigest";
	return undefined;
}
