import { createHash } from "node:crypto";
import {
	closeSync,
	createReadStream,
	createWriteStream,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { getHeapSnapshot, getHeapStatistics } from "node:v8";
import { isMainThread, threadId } from "node:worker_threads";

import { censusGridStorage } from "./grid-memory-storage-census.js";

export interface GridMemoryCheckpoint {
	readonly epoch: number;
	readonly transitions: number;
	readonly terminalAccounting: boolean;
	readonly objectId: string;
	readonly databaseNames: readonly string[];
	readonly owners: Readonly<Record<string, number>>;
}

function ownData(value: unknown): Readonly<Record<string, PropertyDescriptor>> {
	if (
		value === null ||
		typeof value !== "object" ||
		(Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
		Reflect.ownKeys(value).some((key) => typeof key !== "string")
	) {
		throw new TypeError("GRID_MEMORY_SCALAR_RECORD_REQUIRED");
	}
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) {
		throw new TypeError("GRID_MEMORY_SCALAR_DATA_REQUIRED");
	}
	return descriptors;
}

/** Copy synchronously so caller-owned containers never enter the async capture frame. */
function detachCheckpoint(value: GridMemoryCheckpoint): GridMemoryCheckpoint {
	const fields = ownData(value);
	const keys = ["epoch", "transitions", "terminalAccounting", "objectId", "databaseNames", "owners"];
	if (Object.keys(fields).length !== keys.length || keys.some((key) => fields[key] === undefined)) {
		throw new TypeError("GRID_MEMORY_CHECKPOINT_CLOSED_SHAPE");
	}
	const epoch: unknown = fields.epoch?.value;
	const transitions: unknown = fields.transitions?.value;
	const terminalAccounting: unknown = fields.terminalAccounting?.value;
	const objectId: unknown = fields.objectId?.value;
	const databaseNames: unknown = fields.databaseNames?.value;
	if (
		typeof epoch !== "number" ||
		!Number.isSafeInteger(epoch) ||
		typeof transitions !== "number" ||
		!Number.isSafeInteger(transitions) ||
		typeof terminalAccounting !== "boolean" ||
		typeof objectId !== "string" ||
		objectId.length === 0 ||
		!Array.isArray(databaseNames) ||
		Object.getPrototypeOf(databaseNames) !== Array.prototype
	) {
		throw new TypeError("GRID_MEMORY_CHECKPOINT_SCALARS_REQUIRED");
	}
	const names: string[] = [];
	const nameFields = Object.getOwnPropertyDescriptors(databaseNames);
	if (Reflect.ownKeys(databaseNames).length !== databaseNames.length + 1) {
		throw new TypeError("GRID_MEMORY_DATABASE_LIST_REQUIRED");
	}
	for (let index = 0; index < databaseNames.length; index++) {
		const descriptor = nameFields[String(index)];
		if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string") {
			throw new TypeError("GRID_MEMORY_DATABASE_NAMES_REQUIRED");
		}
		names.push(descriptor.value);
	}
	const owners: Record<string, number> = Object.create(null) as Record<string, number>;
	for (const [key, descriptor] of Object.entries(ownData(fields.owners?.value))) {
		if (typeof descriptor.value !== "number" || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) {
			throw new TypeError("GRID_MEMORY_OWNER_SCALARS_REQUIRED");
		}
		owners[key] = descriptor.value;
	}
	return { epoch, transitions, terminalAccounting, objectId, databaseNames: names, owners };
}

async function writeSnapshot(path: string): Promise<void> {
	const fd = openSync(path, "wx");
	let destination: ReturnType<typeof createWriteStream> | undefined;
	try {
		const source = getHeapSnapshot();
		const writer = createWriteStream(path, { fd, autoClose: false });
		destination = writer;
		// Node 22's HeapSnapshotStream emits end but not close; pipeline waits forever.
		// File finish acknowledges all streamed bytes before fsync and descriptor closure.
		await new Promise<void>((resolve, reject) => {
			let failing = false;
			const failed = (error: Error): void => {
				if (failing) return;
				failing = true;
				source.unpipe(writer);
				source.destroy();
				// Destruction waits for outstanding writes, then closes its descriptor.
				writer.once("close", () => reject(error));
				writer.destroy();
			};
			source.once("error", failed);
			writer.once("error", failed);
			writer.once("finish", () => {
				source.removeListener("error", failed);
				writer.removeListener("error", failed);
				resolve();
			});
			source.pipe(writer);
		});
		fsyncSync(fd);
	} finally {
		// destroy closes even autoClose:false streams, after outstanding I/O completes.
		if (!destination?.closed) closeSync(fd);
	}
}

export function shouldCaptureGridHeap(
	input: Pick<GridMemoryCheckpoint, "transitions" | "terminalAccounting">,
	captured: ReadonlySet<number>
): boolean {
	return !input.terminalAccounting && [10, 20, 30].includes(input.transitions) && !captured.has(input.transitions);
}

async function settledGc(): Promise<void> {
	const gc = globalThis.gc;
	if (gc === undefined) throw new Error("GRID_MEMORY_GC_REQUIRED");
	for (let turn = 0; turn < 3; turn += 1) {
		await new Promise<void>((resolve) => setImmediate(resolve));
		gc();
	}
	await new Promise<void>((resolve) => setImmediate(resolve));
}

function memory(): Record<string, number> {
	const { heapUsed, heapTotal, external, arrayBuffers, rss } = process.memoryUsage();
	return { heapUsed, heapTotal, external, arrayBuffers, rss, ownedBytes: heapUsed + arrayBuffers };
}

async function fileHash(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

/** Worker-local diagnostics. Owns scalar summaries and files, never workload objects. */
export function createGridMemoryProfiler(input: { readonly directory: string }): {
	checkpoint(checkpoint: GridMemoryCheckpoint): Promise<void>;
	finish(): void;
	close(): void;
} {
	if (globalThis.gc === undefined) throw new Error("GRID_MEMORY_GC_REQUIRED");
	if (!process.env.VITEST_WORKER_ID || !process.env.VITEST_POOL_ID)
		throw new Error("GRID_MEMORY_WORKLOAD_WORKER_REQUIRED");
	const directory = input.directory;
	// Exclusive directory and files preserve previous and partially failed evidence.
	mkdirSync(directory);
	const fd = openSync(join(directory, "telemetry.jsonl"), "wx");
	let closed = false;
	let busy = false;
	let previousTransition = 0;
	let terminalAccountingSeen = false;
	let finished = false;
	const captured = new Set<number>();
	const emit = (value: Readonly<Record<string, unknown>>): void => {
		const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
		let written = 0;
		while (written < bytes.byteLength) written += writeSync(fd, bytes, written);
		fsyncSync(fd);
	};
	try {
		emit({
			kind: "worker-identity",
			pid: process.pid,
			ppid: process.ppid,
			threadId,
			isMainThread,
			vitestWorkerId: process.env.VITEST_WORKER_ID ?? null,
			vitestPoolId: process.env.VITEST_POOL_ID ?? null,
			node: process.version,
			v8: process.versions.v8,
			execArgv: process.execArgv,
			heapLimit: getHeapStatistics().heap_size_limit,
			gcAvailable: true,
			patchSha256: createHash("sha256").update(readFileSync("patches/fake-indexeddb@6.2.5.patch")).digest("hex"),
			sourceHashes: Object.fromEntries(
				[
					"tests/fixtures/grid-memory-profiler.ts",
					"tests/fixtures/grid-memory-storage-census.ts",
					"tests/fixtures/grid-transition-workload.ts",
					"tests/fixtures/grid-room-workload.ts",
					"tests/phase-6b-grid-30-transition-attribution.test.ts",
					"packages/node/src/v3-live.ts",
					"node_modules/fake-indexeddb/build/esm/FDBTransaction.js",
					"node_modules/fake-indexeddb/build/esm/lib/Database.js",
					"node_modules/fake-indexeddb/build/cjs/FDBTransaction.js",
					"node_modules/fake-indexeddb/build/cjs/lib/Database.js",
				].map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")])
			),
			acceptance: false,
			memoryDefinition:
				"heapUsed/external/arrayBuffers/rss separate; arrayBuffers is included in external; ownedBytes=heapUsed+arrayBuffers",
			logicalPayloadDefinition: "stored binary byte lengths plus UTF-8 strings; not retained heap or a heap correction",
		});
	} catch (error) {
		closeSync(fd);
		throw error;
	}
	const recordCensus = async (checkpoint: GridMemoryCheckpoint): Promise<void> => {
		const censusStarted = performance.now();
		const totalDatabaseCount = (await indexedDB.databases()).length;
		const stores = await censusGridStorage({
			factory: indexedDB,
			databaseNames: checkpoint.databaseNames,
			currentEpoch: checkpoint.terminalAccounting ? checkpoint.epoch : checkpoint.epoch + 1,
			now: Date.now(),
		});
		emit({
			kind: "storage-census",
			...checkpoint,
			totalDatabaseCount,
			stores,
			censusDurationMs: performance.now() - censusStarted,
		});
	};
	const captureCheckpoint = async (checkpoint: GridMemoryCheckpoint): Promise<void> => {
		if (closed || busy || finished || terminalAccountingSeen) throw new Error("GRID_MEMORY_CHECKPOINT_NOT_SERIAL");
		if (
			!Number.isSafeInteger(checkpoint.transitions) ||
			checkpoint.transitions < 1 ||
			checkpoint.transitions > 30 ||
			(checkpoint.terminalAccounting && checkpoint.transitions !== 30) ||
			checkpoint.transitions !== previousTransition + (checkpoint.terminalAccounting ? 0 : 1) ||
			checkpoint.epoch !== checkpoint.transitions - (checkpoint.terminalAccounting ? 0 : 1)
		)
			throw new Error("GRID_MEMORY_CHECKPOINT_ORDER");
		busy = true;
		try {
			// Both cursor rows and the scalar summary array leave their async frame.
			await recordCensus(checkpoint);
			await settledGc();
			const before = memory();
			emit({
				kind: "transition-memory",
				epoch: checkpoint.epoch,
				transitions: checkpoint.transitions,
				terminalAccounting: checkpoint.terminalAccounting,
				memory: before,
				postGc: true,
			});
			if (shouldCaptureGridHeap(checkpoint, captured)) {
				const path = join(directory, `transition-${checkpoint.transitions}.heapsnapshot`);
				const started = performance.now();
				emit({ kind: "snapshot-start", transitions: checkpoint.transitions, path, pid: process.pid, threadId });
				await writeSnapshot(path);
				const afterCapture = memory();
				const durationMs = performance.now() - started;
				const sha256 = await fileHash(path);
				captured.add(checkpoint.transitions);
				emit({
					kind: "snapshot-complete",
					transitions: checkpoint.transitions,
					path,
					sha256,
					durationMs,
					before,
					afterCapture,
					pid: process.pid,
					threadId,
					acceptance: false,
				});
			}
			previousTransition = checkpoint.transitions;
			terminalAccountingSeen = checkpoint.terminalAccounting;
		} catch (error) {
			try {
				emit({
					kind: "checkpoint-failed",
					transitions: checkpoint.transitions,
					error: String(error),
					partialEvidencePreserved: true,
				});
			} catch {
				/* Preserve the primary failure if the evidence volume is unavailable. */
			}
			throw error;
		} finally {
			busy = false;
		}
	};
	return {
		checkpoint(checkpoint): Promise<void> {
			try {
				return captureCheckpoint(detachCheckpoint(checkpoint));
			} catch (error) {
				return Promise.reject(error);
			}
		},
		finish(): void {
			if (
				closed ||
				busy ||
				finished ||
				!terminalAccountingSeen ||
				previousTransition !== 30 ||
				![10, 20, 30].every((transition) => captured.has(transition))
			) {
				throw new Error("GRID_MEMORY_CAPTURE_INCOMPLETE");
			}
			emit({
				kind: "capture-complete",
				captured: [...captured],
				lastTransition: previousTransition,
				acceptance: false,
			});
			finished = true;
		},
		close(): void {
			if (busy) throw new Error("GRID_MEMORY_CLOSE_DURING_CHECKPOINT");
			if (closed) return;
			try {
				emit({
					kind: "profiler-closed",
					finished,
					captured: [...captured],
					lastTransition: previousTransition,
					allSnapshotsCaptured: [10, 20, 30].every((transition) => captured.has(transition)),
				});
			} finally {
				closed = true;
				closeSync(fd);
			}
		},
	};
}
