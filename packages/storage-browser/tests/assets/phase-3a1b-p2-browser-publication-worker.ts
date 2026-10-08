import { encodeCanonical } from "@ts-drp/canonical";

import type {
	Phase3a1bP2BrowserDeathTuple,
	Phase3a1bP2Commit,
	Phase3a1bP2Scope,
	Phase3a1bP2Store,
} from "../../../../tests/fixtures/phase-3a1b-p2-outbox-publication-contract.js";
import { createBrowserDurableIssuanceStore } from "../../src/issuance.js";

interface RunMessage {
	readonly kind: "run";
	readonly primaryDatabaseName: string;
	readonly signal: SharedArrayBuffer;
	readonly tuple: Phase3a1bP2BrowserDeathTuple;
}

interface TransactionEvidence {
	readonly databaseName: string;
	readonly durability: IDBTransactionDurability | undefined;
	readonly mode: IDBTransactionMode;
	readonly stores: readonly string[];
	readonly transactionId: string;
}

const SCOPE = Object.freeze({ author: "alice", objectId: "room:publication" });
const OTHER_SCOPE = Object.freeze({ author: "bob", objectId: "room:unaddressed" });

function commit(scope: Phase3a1bP2Scope, authorSequence: number, seed: number): Phase3a1bP2Commit {
	const envelope = {
		canonicalPreimageBytes: encodeCanonical({ ...scope, authorSequence }),
		digest: Uint8Array.of(seed, 0xd1),
		signature: Uint8Array.of(seed, 0x51),
	};
	return {
		authorSequence,
		envelope,
		issuedRecord: { authorSequence, envelope, scope },
		outboxEntry: { authorSequence, envelope, scope },
	};
}

function exactMessage(value: unknown): RunMessage {
	if (typeof value !== "object" || value === null) throw new TypeError("invalid Seam 2 worker message");
	const input = value as Record<string, unknown>;
	if (
		input.kind !== "run" ||
		typeof input.primaryDatabaseName !== "string" ||
		!(input.signal instanceof SharedArrayBuffer) ||
		typeof input.tuple !== "object" ||
		input.tuple === null
	) {
		throw new TypeError("invalid Seam 2 worker message");
	}
	return input as unknown as RunMessage;
}

function request<T>(value: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		value.addEventListener("success", () => resolve(value.result), { once: true });
		value.addEventListener("error", () => reject(value.error), { once: true });
	});
}

function transaction(value: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		value.addEventListener("complete", () => resolve(), { once: true });
		value.addEventListener("abort", () => reject(value.error), { once: true });
		value.addEventListener("error", () => reject(value.error), { once: true });
	});
}

async function seedPublished(primaryDatabaseName: string): Promise<void> {
	const requestOpen = indexedDB.open(`${primaryDatabaseName}--drp-issuance-v1`);
	const database = await request(requestOpen);
	try {
		const tx = database.transaction(["issuanceOutbox"], "readwrite", { durability: "strict" });
		const completion = transaction(tx);
		const store = tx.objectStore("issuanceOutbox");
		const key = [SCOPE.objectId, SCOPE.author, 0];
		const row = (await request(store.get(key))) as Record<string, unknown>;
		await request(store.put({ ...row, publishState: "published" }));
		await completion;
	} finally {
		database.close();
	}
}

async function run(input: RunMessage): Promise<never> {
	const cell = new Int32Array(input.signal);
	const trace: Record<string, unknown>[] = [];
	let armed = false;
	let transactionCount = 0;
	let closureReads = 0;
	let targetTransaction: IDBTransaction | undefined;
	const transactions = new WeakMap<IDBTransaction, TransactionEvidence>();
	const arm = (trigger: Record<string, unknown>): never => {
		if (armed) throw new TypeError("duplicate Seam 2 browser death arm");
		armed = true;
		trace.push({ ...trigger, kind: "arm" });
		Atomics.store(cell, 0, 1);
		postMessage({ edgeId: input.tuple.id, kind: "armed", trace, trigger });
		Atomics.notify(cell, 0);
		Atomics.wait(cell, 0, 1);
		throw new TypeError("Seam 2 browser death arm unexpectedly released");
	};

	const opened = (await createBrowserDurableIssuanceStore({
		primaryDatabaseName: input.primaryDatabaseName,
	})) as unknown as Phase3a1bP2Store;
	const selected = await opened.transactIssue(SCOPE, (ordinal) => Promise.resolve(commit(SCOPE, ordinal, 41)));
	if (input.tuple.scenario !== "single-row") {
		await opened.transactIssue(OTHER_SCOPE, (ordinal) => Promise.resolve(commit(OTHER_SCOPE, ordinal, 73)));
	}
	if (input.tuple.scenario === "already-published") {
		await opened.close();
		await seedPublished(input.primaryDatabaseName);
	}
	const store =
		input.tuple.scenario === "already-published"
			? ((await createBrowserDurableIssuanceStore({
					primaryDatabaseName: input.primaryDatabaseName,
				})) as unknown as Phase3a1bP2Store)
			: opened;

	const originalTransaction = IDBDatabase.prototype.transaction;
	const originalGet = IDBObjectStore.prototype.get;
	const originalPut = IDBObjectStore.prototype.put;
	IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase["transaction"]>): IDBTransaction {
		const tx = Reflect.apply(originalTransaction, this, args) as IDBTransaction;
		const evidence = Object.freeze({
			databaseName: this.name,
			durability: args[2]?.durability,
			mode: tx.mode,
			stores: Object.freeze([...tx.objectStoreNames].sort()),
			transactionId: `transaction-${++transactionCount}`,
		});
		transactions.set(tx, evidence);
		trace.push({ kind: "transaction-created", ...evidence });
		if (tx.mode === "readwrite" && evidence.stores.includes("issuanceOutbox")) {
			targetTransaction = tx;
			if (input.tuple.edge === "transaction-created") arm({ kind: "transaction-created", ...evidence });
			tx.addEventListener("complete", () => {
				if (input.tuple.edge === "complete" || input.tuple.edge === "already-published-complete") {
					arm({ kind: "complete", transactionId: evidence.transactionId });
				}
			});
		}
		return tx;
	};
	IDBObjectStore.prototype.get = function (...args: Parameters<IDBObjectStore["get"]>): IDBRequest {
		const result = Reflect.apply(originalGet, this, args) as IDBRequest;
		result.addEventListener("success", () => {
			const evidence = transactions.get(this.transaction);
			if (evidence === undefined) return;
			trace.push({ kind: "get", store: this.name, transactionId: evidence.transactionId });
			if (this.transaction === targetTransaction) {
				closureReads++;
				if (input.tuple.scenario === "already-published" && this.name === "issuanceOutbox") {
					if (input.tuple.edge === "already-published-read") arm({ kind: "already-published-read" });
				} else if (closureReads === 3 && input.tuple.edge === "closure-read") {
					arm({ kind: "closure-read" });
				}
			} else if (evidence.mode === "readonly" && this.name === "issuanceOutbox" && input.tuple.edge === "readback") {
				arm({ kind: "readback", transactionId: evidence.transactionId });
			}
		});
		return result;
	};
	IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>): IDBRequest {
		const result = Reflect.apply(originalPut, this, args) as IDBRequest;
		result.addEventListener("success", () => {
			if (
				this.transaction === targetTransaction &&
				this.name === "issuanceOutbox" &&
				input.tuple.edge === "outbox-put"
			) {
				arm({ kind: "outbox-put" });
			}
		});
		return result;
	};

	if (input.tuple.edge === "pre-transaction") arm({ kind: "pre-transaction" });
	const method = store.compareAndMarkOutboxPublished;
	if (typeof method !== "function") throw new TypeError("missing compareAndMarkOutboxPublished");
	await method.call(store, {
		authorSequence: selected.authorSequence,
		digest: new Uint8Array(selected.envelope.digest),
		scope: SCOPE,
	});
	postMessage({ kind: "unexpected-result", trace });
	return new Promise<never>(() => undefined);
}

postMessage({ kind: "ready" });
addEventListener("message", (event: MessageEvent<unknown>) => {
	void run(exactMessage(event.data)).catch((error: unknown) => {
		postMessage({ detail: error instanceof Error ? error.message : String(error), kind: "worker-error" });
	});
});
