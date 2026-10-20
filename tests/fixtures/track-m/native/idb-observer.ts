// Track M, slice 14f (native evidence): a test-only observer of IndexedDB write requests in
// the browser worker. It is installed before any product module evaluates and is inert
// until a test arms it. It never changes a request: every write is issued exactly as the
// product issued it, and only THEN does the observer record it or run the armed hook
// (which may block the worker with Atomics.wait to freeze the transaction at that edge).
// It cannot mint authority or change a product transition.

export interface ObservedWrite {
	readonly op: "put" | "add" | "delete" | "clear" | "cursor-update" | "cursor-delete";
	readonly database: string;
	readonly store: string;
	readonly keyPath: string | string[] | null;
	readonly transaction: IDBTransaction;
	/** The value argument (put, add, cursor-update). */
	readonly value?: unknown;
	/** The explicit key argument (put/add out-of-line key, delete key or range), or the cursor's primary key. */
	readonly key?: unknown;
}

type Listener = (write: ObservedWrite) => void;

let listener: Listener | undefined;

/**
 * Installs (or removes) the one write listener. It runs synchronously after the
 * original request was issued.
 * @param selected - The listener, or undefined to disarm.
 */
export function setWriteListener(selected: Listener | undefined): void {
	listener = selected;
}

function notify(write: ObservedWrite): void {
	const selected = listener;
	if (selected !== undefined) selected(write);
}

const original = Object.freeze({
	put: IDBObjectStore.prototype.put,
	add: IDBObjectStore.prototype.add,
	delete: IDBObjectStore.prototype.delete,
	clear: IDBObjectStore.prototype.clear,
	cursorUpdate: IDBCursor.prototype.update,
	cursorDelete: IDBCursor.prototype.delete,
});

function storeOf(cursor: IDBCursor): IDBObjectStore {
	const source = cursor.source;
	return source instanceof IDBIndex ? source.objectStore : source;
}

IDBObjectStore.prototype.put = function put(this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest {
	const request = key === undefined ? original.put.call(this, value) : original.put.call(this, value, key);
	notify({
		op: "put",
		database: this.transaction.db.name,
		store: this.name,
		keyPath: this.keyPath,
		transaction: this.transaction,
		value,
		...(key === undefined ? {} : { key }),
	});
	return request;
};
IDBObjectStore.prototype.add = function add(this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest {
	const request = key === undefined ? original.add.call(this, value) : original.add.call(this, value, key);
	notify({
		op: "add",
		database: this.transaction.db.name,
		store: this.name,
		keyPath: this.keyPath,
		transaction: this.transaction,
		value,
		...(key === undefined ? {} : { key }),
	});
	return request;
};
IDBObjectStore.prototype.delete = function del(this: IDBObjectStore, query: IDBValidKey | IDBKeyRange): IDBRequest {
	const request = original.delete.call(this, query);
	notify({
		op: "delete",
		database: this.transaction.db.name,
		store: this.name,
		keyPath: this.keyPath,
		transaction: this.transaction,
		key: query,
	});
	return request;
};
IDBObjectStore.prototype.clear = function clear(this: IDBObjectStore): IDBRequest {
	const request = original.clear.call(this);
	notify({
		op: "clear",
		database: this.transaction.db.name,
		store: this.name,
		keyPath: this.keyPath,
		transaction: this.transaction,
	});
	return request;
};
IDBCursor.prototype.update = function update(this: IDBCursor, value: unknown): IDBRequest {
	const request = original.cursorUpdate.call(this, value);
	const store = storeOf(this);
	notify({
		op: "cursor-update",
		database: store.transaction.db.name,
		store: store.name,
		keyPath: store.keyPath,
		transaction: store.transaction,
		value,
		key: this.primaryKey,
	});
	return request;
};
IDBCursor.prototype.delete = function del(this: IDBCursor): IDBRequest {
	const request = original.cursorDelete.call(this);
	const store = storeOf(this);
	notify({
		op: "cursor-delete",
		database: store.transaction.db.name,
		store: store.name,
		keyPath: store.keyPath,
		transaction: store.transaction,
		key: this.primaryKey,
	});
	return request;
};
