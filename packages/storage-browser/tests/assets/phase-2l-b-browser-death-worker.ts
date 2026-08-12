import { encodeCanonical } from "@ts-drp/canonical";

// eslint-disable-next-line import/no-unresolved -- resolved by the private RED bundler.
import { createBrowserDurableIssuanceStore } from "#phase-2l-b-candidate";
import type {
	Phase2lBCommit,
	Phase2lBDeathTuple,
	Phase2lBScope,
} from "../fixtures/phase-2l-b-browser-issuance-contract.js";

interface RunMessage {
	readonly edge: Phase2lBDeathTuple;
	readonly kind: "run";
	readonly primaryDatabaseName: string;
	readonly signal: SharedArrayBuffer;
}

const SCOPE = Object.freeze({ author: "death-author", objectId: "death-object" });

function commit(scope: Phase2lBScope, authorSequence: number, seed: number): Phase2lBCommit {
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
	if (typeof value !== "object" || value === null) throw new TypeError("invalid Phase 2l-b death message");
	const input = value as Record<string, unknown>;
	if (
		input.kind !== "run" ||
		typeof input.primaryDatabaseName !== "string" ||
		!(input.signal instanceof SharedArrayBuffer) ||
		typeof input.edge !== "object" ||
		input.edge === null
	)
		throw new TypeError("invalid Phase 2l-b death message");
	return input as unknown as RunMessage;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function run(input: RunMessage): Promise<never> {
	const cell = new Int32Array(input.signal);
	const trace: Array<Readonly<{ kind: string; method?: string; store?: string }>> = [];
	let targetTransaction: IDBTransaction | undefined;
	let armed = false;
	const arm = (kind: string): never => {
		if (armed) throw new TypeError("duplicate Phase 2l-b death arm");
		armed = true;
		trace.push({ kind });
		Atomics.store(cell, 0, 1);
		postMessage({
			edgeId: input.edge.id,
			kind: "armed",
			selectedOrdinal: input.edge.scenario === "fresh" ? 0 : 1,
			trace,
		});
		Atomics.notify(cell, 0);
		Atomics.wait(cell, 0, 1);
		throw new Error("Phase 2l-b death arm was unexpectedly released");
	};

	const originalTransaction = IDBDatabase.prototype.transaction;
	const originalGet = IDBObjectStore.prototype.get;
	const originalAdd = IDBObjectStore.prototype.add;
	const originalPut = IDBObjectStore.prototype.put;
	try {
		const opened = await createBrowserDurableIssuanceStore({ primaryDatabaseName: input.primaryDatabaseName });
		if (input.edge.scenario === "existing-lineage") {
			await opened.transactIssue(SCOPE, (selected: number) => Promise.resolve(commit(SCOPE, selected, 31)));
		}
		if (input.edge.edge === "suspended-build") {
			void opened.transactIssue(SCOPE, (selected: number) => {
				void selected;
				return arm("suspended-build");
			});
			return await new Promise<never>(() => undefined);
		}

		IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase["transaction"]>): IDBTransaction {
			const transaction = Reflect.apply(originalTransaction, this, args) as IDBTransaction;
			if (args[1] === "readwrite" && [...transaction.objectStoreNames].includes("lineages")) {
				targetTransaction = transaction;
				trace.push({ kind: "transaction-created" });
				transaction.addEventListener("abort", () => {
					trace.push({ kind: "abort" });
					if (input.edge.edge === "abort") arm("abort");
				});
				transaction.addEventListener("complete", () => {
					trace.push({ kind: "complete" });
					if (input.edge.edge === "complete") arm("complete");
				});
			}
			return transaction;
		};

		const instrument = <T extends (this: IDBObjectStore, ...args: never[]) => IDBRequest>(
			method: "add" | "get" | "put",
			original: T
		): T =>
			function (this: IDBObjectStore, ...args: never[]) {
				const request = Reflect.apply(original, this, args) as IDBRequest;
				const storeName = this.name;
				trace.push({ kind: "request-created", method, store: storeName });
				request.addEventListener("success", () => {
					trace.push({ kind: "request-success", method, store: storeName });
					const native = input.edge.nativeRequest;
					if (native !== null && native.method === method && native.store === storeName) arm(input.edge.edge);
					if (input.edge.edge === "abort" && method === "add" && storeName === "issuanceOutbox") {
						targetTransaction?.abort();
					}
				});
				return request;
			} as T;
		IDBObjectStore.prototype.get = instrument("get", originalGet as never) as typeof originalGet;
		IDBObjectStore.prototype.add = instrument("add", originalAdd as never) as typeof originalAdd;
		IDBObjectStore.prototype.put = instrument("put", originalPut as never) as typeof originalPut;

		void opened.transactIssue(SCOPE, (selected: number) => {
			const candidate = commit(SCOPE, selected, 73);
			if (input.edge.edge === "postbuild") return arm("postbuild");
			return Promise.resolve(candidate);
		});
		return await new Promise<never>(() => undefined);
	} catch (error) {
		postMessage({ detail: errorMessage(error), kind: "worker-error", trace });
		return new Promise<never>(() => undefined);
	}
}

postMessage({ kind: "ready" });
addEventListener("message", (event: MessageEvent<unknown>) => void run(exactMessage(event.data)));
