import {
	type AheDurableStore,
	digestBlob,
	digestClosure,
	type GenerationRef,
	parseGenerationId,
	parseHeadRevision,
	parseStorageObjectId,
} from "@ts-drp/storage";

import { createBrowserAheDurableStore } from "../../src/index.js";

interface RunInput {
	readonly databaseName: string;
	readonly mode: "death" | "ordinary" | "recover";
	readonly target?: string;
}

let activeInput: RunInput | undefined;
let activeOperation: string | undefined;
const emittedNativeCheckpoints = new Set<string>();

function must<T>(result: Readonly<{ readonly ok: true; readonly value: T }> | Readonly<{ readonly ok: false }>): T {
	if (!result.ok) throw new TypeError("invalid D.108c browser fixture value");
	return result.value;
}

const objectId = must(parseStorageObjectId(`creator:${"a".repeat(32)}`));
const pendingGenerationId = must(parseGenerationId("b".repeat(64)));
const candidateGenerationId = must(parseGenerationId("c".repeat(64)));
const pendingBytes = [1, 2, 3, 4, 5].map((value) => Uint8Array.of(value, value + 10));
const projectionBytes = Uint8Array.of(91, 92, 93, 94);
const pendingRefs = pendingBytes.map((bytes) => ({ byteLength: bytes.byteLength, digest: must(digestBlob(bytes)) }));
const projectionRef = { byteLength: projectionBytes.byteLength, digest: must(digestBlob(projectionBytes)) };
const candidateRefs = Object.freeze(
	[...pendingRefs.slice(1), projectionRef].sort((left, right) => (left.digest < right.digest ? -1 : 1))
);
const pendingClosure = Object.freeze([...pendingRefs].sort((left, right) => (left.digest < right.digest ? -1 : 1)));
const pendingClosureDigest = must(digestClosure(pendingClosure));
const candidateClosureDigest = must(digestClosure(candidateRefs));
const pendingHead = Object.freeze({
	closureDigest: pendingClosureDigest,
	generationId: pendingGenerationId,
	kind: "present" as const,
	objectId,
	revision: must(parseHeadRevision(1)),
});

function report(value: unknown): void {
	console.log(`D108C:${JSON.stringify(value)}`);
}

function nativeCheckpoint(operation: string, edge: "after-native-request" | "after-transaction-terminal"): void {
	if (activeInput?.mode !== "death" || activeInput.target !== `${operation}:${edge}`) return;
	const key = `${operation}:${edge}`;
	if (emittedNativeCheckpoints.has(key)) return;
	emittedNativeCheckpoints.add(key);
	report({ edge, kind: "checkpoint", operation });
	let released = false;
	while (!released) released = globalThis.sessionStorage.getItem("d108c-release") === "true";
}

function instrumentWriteRequest(
	request: IDBRequest<IDBValidKey>,
	operation: string | undefined
): IDBRequest<IDBValidKey> {
	if (operation !== undefined) {
		request.addEventListener("success", () => nativeCheckpoint(operation, "after-native-request"), { once: true });
	}
	return request;
}

const nativeAdd = IDBObjectStore.prototype.add;
const nativePut = IDBObjectStore.prototype.put;
const nativeTransaction = IDBDatabase.prototype.transaction;
Object.defineProperties(IDBObjectStore.prototype, {
	add: {
		configurable: true,
		value(this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
			return instrumentWriteRequest(
				Reflect.apply(nativeAdd, this, key === undefined ? [value] : [value, key]) as IDBRequest<IDBValidKey>,
				activeOperation
			);
		},
	},
	put: {
		configurable: true,
		value(this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
			return instrumentWriteRequest(
				Reflect.apply(nativePut, this, key === undefined ? [value] : [value, key]) as IDBRequest<IDBValidKey>,
				activeOperation
			);
		},
	},
});
Object.defineProperty(IDBDatabase.prototype, "transaction", {
	configurable: true,
	value(
		this: IDBDatabase,
		storeNames: string | Iterable<string>,
		mode?: IDBTransactionMode,
		options?: IDBTransactionOptions
	): IDBTransaction {
		const transaction = Reflect.apply(nativeTransaction, this, [storeNames, mode, options]) as IDBTransaction;
		const operation = activeOperation;
		if (operation !== undefined) {
			transaction.addEventListener("complete", () => nativeCheckpoint(operation, "after-transaction-terminal"), {
				once: true,
			});
		}
		return transaction;
	},
});

async function nativeOperation<T>(operation: string, request: () => Promise<T>): Promise<T> {
	activeOperation = operation;
	try {
		return await request();
	} finally {
		activeOperation = undefined;
	}
}

async function successful<T>(
	promise: Promise<Readonly<{ readonly ok: boolean; readonly value?: T; readonly reason?: string }>>,
	label: string
): Promise<T> {
	const result = await promise;
	if (!result.ok) throw new Error(`${label}: ${String(result.reason)}`);
	return result.value as T;
}

async function seedPending(store: AheDurableStore): Promise<void> {
	const head = await successful(store.readHead(objectId), "readHead");
	if (head.kind === "present") return;
	await successful(
		store.beginGeneration({
			baseExpectedHead: { kind: "none", objectId },
			closure: pendingClosure,
			generationId: pendingGenerationId,
			objectId,
		}),
		"begin pending"
	);
	for (let index = 0; index < pendingRefs.length; index += 1) {
		const ref = pendingRefs[index] as GenerationRef;
		await successful(
			store.putCachedBlob({
				bytes: pendingBytes[index] as Uint8Array,
				digest: ref.digest,
				generationId: pendingGenerationId,
				objectId,
			}),
			"cache pending"
		);
	}
	for (const ref of pendingClosure) {
		await successful(
			store.promoteReference({ digest: ref.digest, generationId: pendingGenerationId, objectId }),
			"promote pending"
		);
	}
	await successful(store.completeGeneration({ generationId: pendingGenerationId, objectId }), "complete pending");
	await successful(
		store.swapHead({ expectedHead: { kind: "none", objectId }, generationId: pendingGenerationId, objectId }),
		"swap pending"
	);
}

async function terminal(store: AheDurableStore): Promise<Readonly<Record<string, unknown>>> {
	const result = await store.recoverActiveGeneration(objectId);
	if (!result.ok || result.value.kind !== "active") return Object.freeze({ classification: "stale-head", result });
	const { adoptedGeneration, head, references } = result.value;
	const pending =
		head.objectId === pendingHead.objectId &&
		head.generationId === pendingHead.generationId &&
		head.revision === pendingHead.revision &&
		head.closureDigest === pendingHead.closureDigest;
	const active =
		adoptedGeneration.state === "Adopted" &&
		head.objectId === pendingHead.objectId &&
		head.revision === pendingHead.revision + 1 &&
		head.closureDigest === candidateClosureDigest &&
		references.length === candidateRefs.length &&
		candidateRefs.every(
			(ref, index) => ref.digest === references[index]?.digest && ref.byteLength === references[index]?.byteLength
		);
	return Object.freeze({
		classification: pending ? "pending-old" : active ? "active-new" : "stale-head",
		head,
		references,
	});
}

async function run(input: RunInput): Promise<Readonly<Record<string, unknown>>> {
	const store = await createBrowserAheDurableStore({ databaseName: input.databaseName });
	try {
		await seedPending(store);
		activeInput = input;
		emittedNativeCheckpoints.clear();
		if (input.mode === "recover") return await terminal(store);
		const checkpoint = async (operation: string, edge: string): Promise<boolean> => {
			if (input.target !== `${operation}:${edge}`) return false;
			report({ edge, kind: "checkpoint", operation });
			if (input.mode === "death") await new Promise(() => undefined);
			return true;
		};
		if (await checkpoint("beginGeneration", "before-request")) return await terminal(store);
		await nativeOperation("beginGeneration", () =>
			successful(
				store.beginGeneration({
					baseExpectedHead: pendingHead,
					closure: candidateRefs,
					generationId: candidateGenerationId,
					objectId,
				}),
				"begin candidate"
			)
		);
		if (await checkpoint("beginGeneration", "after-request")) return await terminal(store);
		if (await checkpoint("beginGeneration", "after-transaction-terminal")) return await terminal(store);
		if (await checkpoint("putCachedBlob", "before-request")) return await terminal(store);
		await nativeOperation("putCachedBlob", () =>
			successful(
				store.putCachedBlob({
					bytes: projectionBytes,
					digest: projectionRef.digest,
					generationId: candidateGenerationId,
					objectId,
				}),
				"cache candidate"
			)
		);
		if (await checkpoint("putCachedBlob", "after-request")) return await terminal(store);
		if (await checkpoint("putCachedBlob", "after-transaction-terminal")) return await terminal(store);
		for (let index = 0; index < candidateRefs.length; index += 1) {
			const operation = `promoteReference:${index}`;
			if (await checkpoint(operation, "before-request")) return await terminal(store);
			await nativeOperation(operation, () =>
				successful(
					store.promoteReference({
						digest: (candidateRefs[index] as GenerationRef).digest,
						generationId: candidateGenerationId,
						objectId,
					}),
					operation
				)
			);
			if (await checkpoint(operation, "after-request")) return await terminal(store);
			if (await checkpoint(operation, "after-transaction-terminal")) return await terminal(store);
		}
		if (await checkpoint("completeGeneration", "before-request")) return await terminal(store);
		await nativeOperation("completeGeneration", () =>
			successful(store.completeGeneration({ generationId: candidateGenerationId, objectId }), "complete candidate")
		);
		if (await checkpoint("completeGeneration", "after-request")) return await terminal(store);
		if (await checkpoint("completeGeneration", "after-transaction-terminal")) return await terminal(store);
		if (await checkpoint("swapHead", "before-request")) return await terminal(store);
		await nativeOperation("swapHead", () =>
			successful(
				store.swapHead({ expectedHead: pendingHead, generationId: candidateGenerationId, objectId }),
				"swap candidate"
			)
		);
		if (await checkpoint("swapHead", "after-request")) return await terminal(store);
		if (await checkpoint("swapHead", "after-transaction-terminal")) return await terminal(store);
		return await terminal(store);
	} finally {
		activeInput = undefined;
		activeOperation = undefined;
		await store.close();
	}
}

Object.defineProperty(globalThis, "phase6aCreatorAdoptionCommit", {
	value: Object.freeze({ candidateRefCount: candidateRefs.length, run }),
});

const query = new URL(globalThis.location.href).searchParams.get("input");
if (query !== null) {
	const input = JSON.parse(atob(query)) as RunInput;
	void run(input)
		.then((result) => report({ kind: "recovery", result }))
		.catch((error: unknown) =>
			report({ kind: "child-error", message: error instanceof Error ? error.message : String(error) })
		);
}

declare global {
	// eslint-disable-next-line no-var
	var phase6aCreatorAdoptionCommit: Readonly<{
		readonly candidateRefCount: number;
		run(input: RunInput): Promise<Readonly<Record<string, unknown>>>;
	}>;
}
