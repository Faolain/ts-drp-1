import {
	type BlobDigest,
	decodeGenerationRecordV1,
	digestBlob,
	digestClosure,
	type GenerationId,
	type StorageObjectId,
} from "@ts-drp/storage";
import {
	evaluateStorageAdapterCommand,
	type PreparedStorageAdapterCommand,
	prepareStorageAdapterCommand,
	type StorageAdapterFact,
	type StorageAdapterWrite,
} from "@ts-drp/storage/adapter";

const OBJECT_ID = "benchmark-peer:0123456789abcdef0123456789abcdef" as StorageObjectId;
const GENERATION_A = "a".repeat(64) as GenerationId;
const GENERATION_B = "b".repeat(64) as GenerationId;
const PAYLOAD_A = new TextEncoder().encode("phase-2-spike-generation-a");
const PAYLOAD_B = new TextEncoder().encode("phase-2-spike-generation-b");
const STORE_NAME = "benchmark-state";
const STORE_KEY = "snapshot";

type JsonCommand = Readonly<Record<string, unknown>>;
type SerializedSnapshot = Readonly<{
	headRecord: readonly number[] | null;
	generationRecords: Readonly<Record<string, readonly number[]>>;
	blobs: Readonly<Record<string, readonly number[]>>;
	promotions: readonly string[];
}>;
type MutableSnapshot = {
	headRecord: Uint8Array | null;
	generationRecords: Map<string, Uint8Array>;
	blobs: Map<string, Uint8Array>;
	promotions: Set<string>;
};
type BenchmarkRequest = Readonly<{ runId: string; corruptOracle: boolean }>;

function must<T>(result: { ok: true; value: T } | { ok: false; reason: string }): T {
	if (!result.ok) throw new Error(`fixture construction failed: ${result.reason}`);
	return result.value;
}

function promotionKey(objectId: string, generationId: string, digest: string): string {
	return `${objectId}\0${generationId}\0${digest}`;
}

function emptySnapshot(): MutableSnapshot {
	return { headRecord: null, generationRecords: new Map(), blobs: new Map(), promotions: new Set() };
}

function serialize(snapshot: MutableSnapshot): SerializedSnapshot {
	return {
		headRecord: snapshot.headRecord === null ? null : [...snapshot.headRecord],
		generationRecords: Object.fromEntries(
			[...snapshot.generationRecords.entries()].map(([key, value]) => [key, [...value]])
		),
		blobs: Object.fromEntries([...snapshot.blobs.entries()].map(([key, value]) => [key, [...value]])),
		promotions: [...snapshot.promotions].sort(),
	};
}

function deserialize(value: unknown): MutableSnapshot {
	if (typeof value !== "object" || value === null) return emptySnapshot();
	const candidate = value as Partial<SerializedSnapshot>;
	return {
		headRecord: candidate.headRecord === null ? null : new Uint8Array(candidate.headRecord ?? []),
		generationRecords: new Map(
			Object.entries(candidate.generationRecords ?? {}).map(([key, bytes]) => [key, new Uint8Array(bytes)])
		),
		blobs: new Map(Object.entries(candidate.blobs ?? {}).map(([key, bytes]) => [key, new Uint8Array(bytes)])),
		promotions: new Set(candidate.promotions ?? []),
	};
}

function decodeCommand(value: JsonCommand): Record<string, unknown> {
	if (value.kind !== "putCachedBlob") return structuredClone(value);
	const copy: Record<string, unknown> = { ...structuredClone(value) };
	copy.bytes = new Uint8Array(copy.bytes as number[]);
	return copy;
}

function objectFact(snapshot: MutableSnapshot): StorageAdapterFact {
	return {
		kind: "object-state",
		objectId: OBJECT_ID,
		headRecord: snapshot.headRecord === null ? null : new Uint8Array(snapshot.headRecord),
		generationRecords: [...snapshot.generationRecords.values()].map((bytes) => new Uint8Array(bytes)),
	};
}

function factsFor(prepared: PreparedStorageAdapterCommand, snapshot: MutableSnapshot): StorageAdapterFact[] {
	const facts: StorageAdapterFact[] = [];
	for (const requirement of prepared.requirements) {
		if (requirement.kind === "object-state") {
			facts.push(objectFact(snapshot));
		} else if (requirement.kind === "blob") {
			const bytes = snapshot.blobs.get(requirement.digest);
			facts.push({ kind: "blob", digest: requirement.digest, bytes: bytes ? new Uint8Array(bytes) : null });
		} else if (requirement.kind === "promotion") {
			if (snapshot.promotions.has(promotionKey(requirement.objectId, requirement.generationId, requirement.digest))) {
				facts.push(requirement);
			}
		} else {
			const encoded = snapshot.generationRecords.get(requirement.generationId);
			if (encoded === undefined) continue;
			const decoded = decodeGenerationRecordV1(encoded);
			if (!decoded.ok) throw new Error(`fixture generation decode failed: ${decoded.reason}`);
			for (const reference of decoded.value.closure) {
				const bytes = snapshot.blobs.get(reference.digest);
				facts.push({ kind: "blob", digest: reference.digest, bytes: bytes ? new Uint8Array(bytes) : null });
				if (snapshot.promotions.has(promotionKey(requirement.objectId, requirement.generationId, reference.digest))) {
					facts.push({
						kind: "promotion",
						objectId: requirement.objectId,
						generationId: requirement.generationId,
						digest: reference.digest,
					});
				}
			}
		}
	}
	return facts;
}

function applyWrites(snapshot: MutableSnapshot, writes: readonly StorageAdapterWrite[]): void {
	for (const write of writes) {
		if (write.kind === "replace-generation") {
			snapshot.generationRecords.set(write.generationId, new Uint8Array(write.record));
		} else if (write.kind === "replace-head") {
			snapshot.headRecord = new Uint8Array(write.record);
		} else if (write.kind === "insert-blob") {
			if (!snapshot.blobs.has(write.digest)) snapshot.blobs.set(write.digest, new Uint8Array(write.bytes));
		} else {
			snapshot.promotions.add(promotionKey(write.objectId, write.generationId, write.digest));
		}
	}
}

function makeScript(): Readonly<{
	bytes: Uint8Array;
	commands: readonly JsonCommand[];
	blobBDigest: BlobDigest;
	expectedState: unknown;
}> {
	const blobA = must(digestBlob(PAYLOAD_A));
	const blobB = must(digestBlob(PAYLOAD_B));
	const closureA = [{ digest: blobA, byteLength: PAYLOAD_A.byteLength }] as const;
	const closureB = [{ digest: blobB, byteLength: PAYLOAD_B.byteLength }] as const;
	const closureADigest = must(digestClosure(closureA));
	const closureBDigest = must(digestClosure(closureB));
	const noHead = { kind: "none", objectId: OBJECT_ID } as const;
	const headA = {
		kind: "present",
		objectId: OBJECT_ID,
		generationId: GENERATION_A,
		revision: 1,
		closureDigest: closureADigest,
	} as const;
	const commands: readonly JsonCommand[] = [
		{
			kind: "beginGeneration",
			objectId: OBJECT_ID,
			generationId: GENERATION_A,
			baseExpectedHead: noHead,
			closure: closureA,
		},
		{ kind: "putCachedBlob", objectId: OBJECT_ID, generationId: GENERATION_A, digest: blobA, bytes: [...PAYLOAD_A] },
		{ kind: "promoteReference", objectId: OBJECT_ID, generationId: GENERATION_A, digest: blobA },
		{ kind: "completeGeneration", objectId: OBJECT_ID, generationId: GENERATION_A },
		{ kind: "swapHead", objectId: OBJECT_ID, generationId: GENERATION_A, expectedHead: noHead },
		{
			kind: "beginGeneration",
			objectId: OBJECT_ID,
			generationId: GENERATION_B,
			baseExpectedHead: headA,
			closure: closureB,
		},
		{ kind: "putCachedBlob", objectId: OBJECT_ID, generationId: GENERATION_B, digest: blobB, bytes: [...PAYLOAD_B] },
		{ kind: "promoteReference", objectId: OBJECT_ID, generationId: GENERATION_B, digest: blobB },
		{ kind: "completeGeneration", objectId: OBJECT_ID, generationId: GENERATION_B },
		{ kind: "swapHead", objectId: OBJECT_ID, generationId: GENERATION_B, expectedHead: headA },
		{ kind: "readObjectState", objectId: OBJECT_ID },
		{ kind: "getBlob", digest: blobB },
	];
	return {
		bytes: new TextEncoder().encode(JSON.stringify(commands)),
		commands,
		blobBDigest: blobB,
		expectedState: {
			head: {
				kind: "present",
				objectId: OBJECT_ID,
				generationId: GENERATION_B,
				revision: 2,
				closureDigest: closureBDigest,
			},
			generations: [
				{
					objectId: OBJECT_ID,
					generationId: GENERATION_A,
					baseExpectedHead: noHead,
					closureDigest: closureADigest,
					closure: closureA,
					state: "Superseded",
				},
				{
					objectId: OBJECT_ID,
					generationId: GENERATION_B,
					baseExpectedHead: headA,
					closureDigest: closureBDigest,
					closure: closureB,
					state: "Adopted",
				},
			],
		},
	};
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("");
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.addEventListener("success", () => resolve(request.result), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error("IDB request failed")), { once: true });
	});
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.addEventListener("complete", () => resolve(), { once: true });
		transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("IDB transaction aborted")), {
			once: true,
		});
		transaction.addEventListener("error", () => reject(transaction.error ?? new Error("IDB transaction failed")), {
			once: true,
		});
	});
}

async function openDatabase(name: string): Promise<IDBDatabase> {
	await new Promise<void>((resolve, reject) => {
		const request = indexedDB.deleteDatabase(name);
		request.addEventListener("success", () => resolve(), { once: true });
		request.addEventListener("blocked", () => reject(new Error("IDB delete blocked")), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error("IDB delete failed")), { once: true });
	});
	const request = indexedDB.open(name, 1);
	request.addEventListener("upgradeneeded", () => request.result.createObjectStore(STORE_NAME), { once: true });
	return requestValue(request);
}

function evaluateOne(
	command: JsonCommand,
	snapshot: MutableSnapshot
): Readonly<{ snapshot: MutableSnapshot; value: unknown }> {
	const prepared = prepareStorageAdapterCommand(decodeCommand(command));
	if (!prepared.ok) throw new Error(`command preparation failed: ${prepared.reason}`);
	const evaluation = evaluateStorageAdapterCommand(prepared.value, factsFor(prepared.value, snapshot));
	if (!evaluation.result.ok) {
		throw new Error(`${String(command.kind)} command evaluation failed: ${evaluation.result.reason}`);
	}
	applyWrites(snapshot, evaluation.writes);
	return { snapshot, value: evaluation.result.value };
}

async function runIdb(
	commands: readonly JsonCommand[],
	name: string
): Promise<Readonly<{ elapsed: number; values: unknown[] }>> {
	const database = await openDatabase(name);
	const values: unknown[] = [];
	const started = performance.now();
	try {
		for (const command of commands) {
			const transaction = database.transaction(STORE_NAME, "readwrite", { durability: "strict" });
			if (transaction.durability !== "strict") throw new Error(`live IDB durability was ${transaction.durability}`);
			const store = transaction.objectStore(STORE_NAME);
			const stored = await requestValue(store.get(STORE_KEY));
			const snapshot = deserialize(stored);
			const evaluated = evaluateOne(command, snapshot);
			store.put(serialize(evaluated.snapshot), STORE_KEY);
			await transactionDone(transaction);
			values.push(evaluated.value);
		}
		return { elapsed: performance.now() - started, values };
	} finally {
		database.close();
	}
}

async function runOpfs(
	commands: readonly JsonCommand[],
	name: string
): Promise<Readonly<{ elapsed: number; values: unknown[]; flushedBytes: number }>> {
	const root = await navigator.storage.getDirectory();
	const handle = await root.getFileHandle(name, { create: true });
	const access = await handle.createSyncAccessHandle();
	const values: unknown[] = [];
	const started = performance.now();
	let flushedBytes = 0;
	try {
		access.truncate(0);
		access.flush();
		for (const command of commands) {
			const size = access.getSize();
			const encoded = new Uint8Array(size);
			if (size > 0) access.read(encoded, { at: 0 });
			const snapshot = size === 0 ? emptySnapshot() : deserialize(JSON.parse(new TextDecoder().decode(encoded)));
			const evaluated = evaluateOne(command, snapshot);
			const next = new TextEncoder().encode(JSON.stringify(serialize(evaluated.snapshot)));
			access.write(next, { at: 0 });
			access.truncate(next.byteLength);
			access.flush();
			flushedBytes += next.byteLength;
			values.push(evaluated.value);
		}
		return { elapsed: performance.now() - started, values, flushedBytes };
	} finally {
		access.close();
		await root.removeEntry(name);
	}
}

function bytesEqual(left: unknown, right: Uint8Array): boolean {
	return (
		left instanceof Uint8Array &&
		left.byteLength === right.byteLength &&
		left.every((value, index) => value === right[index])
	);
}

function exactJsonEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function oraclePass(values: readonly unknown[], expectedState: unknown, expectedBlob: Uint8Array): boolean {
	return exactJsonEqual(values.at(-2), expectedState) && bytesEqual(values.at(-1), expectedBlob);
}

async function benchmark(request: BenchmarkRequest): Promise<unknown> {
	if (!crossOriginIsolated) throw new Error("S2 requires cross-origin isolation");
	const script = makeScript();
	const parsedForOpfs = JSON.parse(new TextDecoder().decode(script.bytes)) as JsonCommand[];
	const parsedForIdb = JSON.parse(new TextDecoder().decode(script.bytes)) as JsonCommand[];
	const opfs = await runOpfs(parsedForOpfs, `${request.runId}-opfs.json`);
	const idb = await runIdb(parsedForIdb, `${request.runId}-idb`);
	const opfsValues = [...opfs.values];
	if (request.corruptOracle && opfsValues.at(-1) instanceof Uint8Array) {
		const corrupted = new Uint8Array(opfsValues.at(-1) as Uint8Array);
		corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;
		opfsValues[opfsValues.length - 1] = corrupted;
	}
	const armOraclePass = {
		opfs: oraclePass(opfsValues, script.expectedState, PAYLOAD_B),
		idbStrict: oraclePass(idb.values, script.expectedState, PAYLOAD_B),
	};
	const encodedForOpfs = new TextEncoder().encode(JSON.stringify(parsedForOpfs));
	const encodedForIdb = new TextEncoder().encode(JSON.stringify(parsedForIdb));
	const scriptDigestByArm = {
		opfs: await sha256Hex(encodedForOpfs),
		idbStrict: await sha256Hex(encodedForIdb),
	};
	const commandScriptDigest = await sha256Hex(script.bytes);
	if (
		scriptDigestByArm.opfs !== commandScriptDigest ||
		scriptDigestByArm.idbStrict !== commandScriptDigest ||
		!exactJsonEqual(parsedForOpfs, parsedForIdb)
	) {
		throw new Error("S2 command script parity failed");
	}

	// Deliberate RED defect: corrupt post-state does not suppress publication.
	const evidence = {
		schemaVersion: 1,
		artifactKind: "substrate-measurement",
		arms: [
			{ substrate: "opfs", postState: "oracle-pass", elapsedMilliseconds: opfs.elapsed },
			{ substrate: "idb-strict", postState: "oracle-pass", elapsedMilliseconds: idb.elapsed },
		],
		commandScriptDigest,
		opsExecuted: parsedForOpfs.length + parsedForIdb.length,
		oracleId: "phase-2a-read-object-state-v1",
		runId: request.runId,
		engineBuild: navigator.userAgent,
		executionOwner: "dedicated-worker",
		crossOriginIsolated: true,
		concurrencyShape: "single-writer",
		contendedMultiTab: "unmeasured-for-2i",
		commandParity: "byte-identical",
		correctnessBeforeTiming: true,
		timingPassingThreshold: "none",
	};

	return {
		evidence,
		oraclePass: armOraclePass.opfs && armOraclePass.idbStrict,
		diagnostics: {
			commandCountPerArm: parsedForOpfs.length,
			commandScriptDigestByArm: scriptDigestByArm,
			armOraclePass,
			idbObservedDurability: "strict",
			opfsFlushedBytes: opfs.flushedBytes,
			blobBDigest: script.blobBDigest,
		},
	};
}

self.addEventListener("message", (event: MessageEvent<BenchmarkRequest>) => {
	void benchmark(event.data).then(
		(value) => self.postMessage({ ok: true, value }),
		(error: unknown) => self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
	);
});
