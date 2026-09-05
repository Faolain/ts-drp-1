import {
	type AheDurableStore,
	digestBlob,
	parseGenerationId,
	type ParseResult,
	parseStorageObjectId,
	type StoreResult,
} from "@ts-drp/storage";
import { createBrowserAheDurableStore, createBrowserStorageCapacityPort } from "@ts-drp/storage-browser";

import { rawPhase2hDatabaseSchema } from "../fixtures/idb-adapter-browser-oracle.js";

const EXPECTED_DIGEST = "d4c3e8a11256ab82a4fc72560eb4a2b0e87bad820c290dd9b03616de240aa6db";
const PROTOCOL = "ts-drp/worker-host";
const VERSION = 1;
const TARGET_INTERVAL_MS = 5;
const READY_TIMEOUT_MS = 10_000;
const RESULT_TIMEOUT_MS = 30_000;
const TOTAL_VERTICES = 4_097;
const MAX_REPETITIONS = 256;
const STORE_NAMES = Object.freeze(["blobs", "generations", "objects", "promotions"]);
const OPERATION_SEQUENCE = Object.freeze([
	"beginGeneration",
	"putCachedBlob",
	"promoteReference",
	"completeGeneration",
	"swapHead",
	"close",
	"reopen",
	"recoverActiveGeneration",
]);

type PersistenceMode =
	| "granted"
	| "not-granted"
	| "unsupported"
	| "unavailable-exception"
	| "unavailable-invalid-response";

interface WorkerSummary {
	readonly count: number;
	readonly items: number;
	readonly order: readonly number[];
	readonly root: string;
	readonly workerCounter: number;
	readonly workerScope: string;
}

interface WorkloadOracle {
	readonly count: number;
	readonly order: readonly number[];
	readonly root: string;
}

interface RepeatedWorkloadOracle {
	readonly count: number;
	readonly orderLength: number;
	readonly root: string;
}

interface MainThreadOracle {
	computeMainThreadOracle(): WorkloadOracle;
	computeRepeatedMainThreadOracle(repetitionCount: number): RepeatedWorkloadOracle;
}

interface AcceptedOutput {
	readonly count: number;
	readonly items: number;
	readonly orderLength: number;
	readonly root: string;
	readonly workerCounter: number;
}

interface DigestCallEvent {
	readonly algorithm: "SHA-256";
	readonly inputBytes: readonly number[];
	readonly realmScope: "Window";
}

function must<T>(result: ParseResult<T>): T {
	if (!result.ok) throw new TypeError(`invalid Phase 2h-b fixture value: ${result.reason}`);
	return result.value;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function maximumGap(offsets: readonly number[]): number {
	let maximum = 0;
	for (let index = 1; index < offsets.length; index++)
		maximum = Math.max(maximum, (offsets[index] ?? 0) - (offsets[index - 1] ?? 0));
	return maximum;
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function mainThreadOracle(): MainThreadOracle {
	const oracle = Reflect.get(globalThis, "phase2hBMainThreadOracle") as MainThreadOracle | undefined;
	if (oracle === undefined) throw new TypeError("authoritative Phase 2f-c Window oracle is absent");
	return oracle;
}

function hex(bytes: ArrayBuffer): string {
	return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

function stableEvidenceValue(value: unknown): unknown {
	if (value instanceof Uint8Array) return { bytes: [...value] };
	if (Array.isArray(value)) return value.map((entry) => stableEvidenceValue(entry));
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(record)
				.sort()
				.map((key) => [key, stableEvidenceValue(record[key])])
		);
	}
	return value;
}

async function evidenceDigest(value: unknown): Promise<string> {
	const preimage = JSON.stringify(stableEvidenceValue(value));
	if (preimage === undefined) throw new TypeError("browser-store evidence is not stable-JSON representable");
	return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(preimage)));
}

async function observedNativeDigest(
	algorithm: "SHA-256",
	input: Uint8Array,
	events: DigestCallEvent[]
): Promise<ArrayBuffer> {
	if (!(globalThis instanceof Window)) throw new TypeError("native digest boundary is outside Window");
	const pending = crypto.subtle.digest(algorithm, input);
	events.push(
		Object.freeze({
			algorithm,
			inputBytes: Object.freeze([...input]),
			realmScope: "Window",
		})
	);
	return pending;
}

async function cryptoDigest(): Promise<unknown> {
	const input = new TextEncoder().encode("browser");
	const digestEvents: DigestCallEvent[] = [];
	const observedDigestHex = hex(await observedNativeDigest("SHA-256", input, digestEvents));
	return Object.freeze({
		crypto: Object.freeze({ digestEvents: Object.freeze(digestEvents) }),
		evidence: Object.freeze({
			expectedDigestHex: EXPECTED_DIGEST,
			observedDigestHex,
			sameRealm: globalThis instanceof Window,
			tag: "crypto-digest",
			vectorId: "sha-256/browser-utf8/v1",
		}),
	});
}

async function positiveControl(): Promise<Readonly<{ blockMs: number; gapMs: number }>> {
	const started = performance.now();
	const offsets = [0];
	const timer = setInterval(() => offsets.push(performance.now() - started), TARGET_INTERVAL_MS);
	try {
		await delay(15);
		const beforeBlockSamples = offsets.length;
		const blockStarted = performance.now();
		while (performance.now() - blockStarted < 200) {
			// Deliberate main-thread responsiveness positive control.
		}
		const blockMs = performance.now() - blockStarted;
		const deadline = performance.now() + 1_000;
		while (offsets.length === beforeBlockSamples && performance.now() < deadline) await delay(1);
		if (offsets.length === beforeBlockSamples) throw new Error("positive-control sampler did not resume");
		return Object.freeze({ blockMs, gapMs: maximumGap(offsets) });
	} finally {
		clearInterval(timer);
	}
}

function exactSummary(summary: WorkerSummary, oracle: WorkloadOracle): AcceptedOutput {
	if (
		summary.count !== TOTAL_VERTICES ||
		summary.items !== TOTAL_VERTICES ||
		summary.workerCounter !== TOTAL_VERTICES ||
		summary.workerScope !== "DedicatedWorkerGlobalScope" ||
		summary.root !== oracle.root ||
		!sameNumbers(summary.order, oracle.order)
	)
		throw new Error("real Phase 2f-c Worker output did not match the independent Window oracle");
	return Object.freeze({
		count: summary.count,
		items: summary.items,
		orderLength: summary.order.length,
		root: summary.root,
		workerCounter: summary.workerCounter,
	});
}

async function workerResponsiveness(
	input: Readonly<{ minimumRepetitionCount: number }> = Object.freeze({ minimumRepetitionCount: 1 })
): Promise<unknown> {
	if (
		!Number.isSafeInteger(input.minimumRepetitionCount) ||
		input.minimumRepetitionCount < 1 ||
		input.minimumRepetitionCount > MAX_REPETITIONS
	)
		throw new RangeError("Phase 2h-b minimum repetition count is outside the closed bound");
	const control = await positiveControl();
	const oracleOwner = mainThreadOracle();
	const oracle = oracleOwner.computeMainThreadOracle();
	const sampleOffsetsMs = [0];
	const started = performance.now();
	let realTimerTickCount = 0;
	const sampler = setInterval(() => {
		realTimerTickCount += 1;
		sampleOffsetsMs.push(performance.now() - started);
	}, TARGET_INTERVAL_MS);
	let worker: Worker | undefined;
	let workerConstructedAtMs = Number.NaN;
	let workerResultAcceptedAtMs = Number.NaN;
	let readyAccepted = false;
	const messageBoundaryEvents: Array<
		| Readonly<{ executionScope: string; kind: "done-message"; pageScope: string }>
		| Readonly<{ kind: "ready-message" }>
		| Readonly<{ kind: "request-post"; readyAtPost: boolean }>
	> = [];
	let pending:
		| Readonly<{
				id: string;
				resolve(value: WorkerSummary): void;
				reject(reason: unknown): void;
				chunks: { bytes: number; count: number; payload?: Uint8Array };
		  }>
		| undefined;
	try {
		const ready = new Promise<readonly string[]>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("Phase 2h-b Worker ready timeout")), READY_TIMEOUT_MS);
			workerConstructedAtMs = performance.now();
			worker = new Worker(new URL("./phase-2h-b-operation-workload.js", import.meta.url), { type: "module" });
			worker.onerror = (event): void => reject(new Error(`Phase 2h-b module Worker failed: ${event.message}`));
			worker.onmessage = (event: MessageEvent<unknown>): void => {
				const message = event.data as Record<string, unknown>;
				if (message.protocol !== PROTOCOL || message.version !== VERSION) {
					pending?.reject(new Error("Phase 2h-b Worker protocol/version mismatch"));
					return;
				}
				if (message.kind === "ready") {
					messageBoundaryEvents.push(Object.freeze({ kind: "ready-message" }));
					const readyCount = messageBoundaryEvents.filter(({ kind }) => kind === "ready-message").length;
					if (
						readyCount !== 1 ||
						!Array.isArray(message.accepts) ||
						message.accepts.some((task) => typeof task !== "string")
					) {
						clearTimeout(timeout);
						reject(new Error("Phase 2h-b Worker ready message is malformed or repeated"));
						return;
					}
					readyAccepted = true;
					clearTimeout(timeout);
					resolve(message.accepts as string[]);
					return;
				}
				if (pending === undefined || message.id !== pending.id) return;
				if (message.kind === "chunk") {
					const payload = message.payload;
					if (!(payload instanceof Uint8Array) || message.sequence !== 0 || pending.chunks.count !== 0) {
						pending.reject(new Error("Phase 2h-b Worker chunk contract is malformed"));
						return;
					}
					pending.chunks.count = 1;
					pending.chunks.bytes = payload.byteLength;
					pending.chunks.payload = payload;
					return;
				}
				if (message.kind === "done") {
					const chunks = pending.chunks;
					if (
						message.chunks !== 1 ||
						message.bytes !== chunks.bytes ||
						chunks.count !== 1 ||
						chunks.payload === undefined
					) {
						pending.reject(new Error("Phase 2h-b Worker terminal accounting is malformed"));
						return;
					}
					try {
						const summary = JSON.parse(new TextDecoder().decode(chunks.payload)) as WorkerSummary;
						messageBoundaryEvents.push(
							Object.freeze({
								executionScope: summary.workerScope,
								kind: "done-message",
								pageScope: globalThis.constructor.name,
							})
						);
						pending.resolve(summary);
					} catch (error) {
						pending.reject(error);
					}
					return;
				}
				if (message.kind === "failed" || message.kind === "cancelled")
					pending.reject(new Error(`Phase 2h-b Worker terminal ${String(message.kind)}:${String(message.code)}`));
			};
		});
		const accepts = await ready;
		if (!accepts.includes("operation-workload"))
			throw new Error("real Phase 2f-c Worker did not advertise its workload");
		const acceptedOutputs: AcceptedOutput[] = [];
		while (true) {
			if (acceptedOutputs.length >= MAX_REPETITIONS) throw new Error("Phase 2h-b Worker exceeded its repetition bound");
			const id = String(acceptedOutputs.length + 1).padStart(16, "0");
			const summary = await new Promise<WorkerSummary>((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error("Phase 2h-b Worker result timeout")), RESULT_TIMEOUT_MS);
				pending = Object.freeze({
					chunks: { bytes: 0, count: 0 },
					id,
					reject: (reason: unknown): void => {
						clearTimeout(timeout);
						reject(reason);
					},
					resolve: (value: WorkerSummary): void => {
						clearTimeout(timeout);
						resolve(value);
					},
				});
				messageBoundaryEvents.push(Object.freeze({ kind: "request-post", readyAtPost: readyAccepted }));
				if (!readyAccepted) throw new Error("attempted to request the Worker before ready");
				worker?.postMessage({
					id,
					kind: "request",
					payload: new Uint8Array(),
					protocol: PROTOCOL,
					task: "operation-workload",
					version: VERSION,
				});
			});
			pending = undefined;
			acceptedOutputs.push(exactSummary(summary, oracle));
			workerResultAcceptedAtMs = performance.now();
			if (workerResultAcceptedAtMs - started >= 100 && acceptedOutputs.length >= input.minimumRepetitionCount) break;
		}
		const windowMs = workerResultAcceptedAtMs - started;
		sampleOffsetsMs.push(windowMs);
		clearInterval(sampler);
		const samplerClosedAtMs = performance.now();
		const repeated = oracleOwner.computeRepeatedMainThreadOracle(acceptedOutputs.length);
		const total = TOTAL_VERTICES * acceptedOutputs.length;
		if (repeated.count !== total || repeated.orderLength !== total)
			throw new Error("repeated Window oracle totals drifted from accepted Worker executions");
		const doneEvents = messageBoundaryEvents.filter(
			(event): event is Extract<(typeof messageBoundaryEvents)[number], { kind: "done-message" }> =>
				event.kind === "done-message"
		);
		if (doneEvents.length !== acceptedOutputs.length || doneEvents.some(({ pageScope }) => pageScope !== "Window"))
			throw new Error("Worker results were not accepted at exact Window message boundaries");
		return Object.freeze({
			evidence: Object.freeze({
				controlBlockMs: control.blockMs,
				controlGapMs: control.gapMs,
				maxGapMs: maximumGap(sampleOffsetsMs),
				readyProtocolVersion: 1,
				repetitionCount: acceptedOutputs.length,
				sampleCount: sampleOffsetsMs.length,
				tag: "worker-responsiveness",
				targetIntervalMs: TARGET_INTERVAL_MS,
				windowMs,
				workloadOutputs: Object.freeze({
					count: total,
					items: total,
					orderLength: total,
					pageCounter: 0,
					pageScope: "Window",
					root: repeated.root,
					workerCounter: total,
					workerScope: "DedicatedWorkerGlobalScope",
				}),
			}),
			worker: Object.freeze({
				acceptedOutputs: Object.freeze(acceptedOutputs),
				messageBoundaryCensus: Object.freeze({
					pageScopeAtDone: doneEvents.at(-1)?.pageScope,
					pageWorkloadCalls: doneEvents.filter(({ executionScope }) => executionScope === "Window").length,
					readyMessages: messageBoundaryEvents.filter(({ kind }) => kind === "ready-message").length,
					requestPosts: messageBoundaryEvents.filter(({ kind }) => kind === "request-post").length,
					requestsBeforeReady: messageBoundaryEvents.filter(
						(event) => event.kind === "request-post" && !event.readyAtPost
					).length,
				}),
				realTimerTickCount,
				repeatedSequenceOracleRoot: repeated.root,
				samplerClosedAtMs,
				samplerOpenedAtMs: started,
				sampleOffsetsMs: Object.freeze(sampleOffsetsMs),
				singleWorkloadOracleRoot: oracle.root,
				workerConstructedAtMs,
				workerResultAcceptedAtMs,
			}),
		});
	} finally {
		clearInterval(sampler);
		worker?.terminate();
	}
}

async function browserStore(): Promise<unknown> {
	const databaseName = `phase-2h-b-${crypto.randomUUID()}`;
	const objectId = must(parseStorageObjectId(`phase-2h-b:${"a".repeat(32)}`));
	const generationId = must(parseGenerationId("b".repeat(64)));
	const bytes = Uint8Array.of(2, 8, 1, 8, 2, 8);
	const digest = must(digestBlob(bytes));
	const operations: string[] = [];
	const factoryCallEvents: Array<Readonly<{ databaseName: string }>> = [];
	const openStore = async (): Promise<AheDurableStore> => {
		factoryCallEvents.push(Object.freeze({ databaseName }));
		return createBrowserAheDurableStore({ databaseName });
	};
	let store: AheDurableStore = await openStore();
	const requireOK = <T>(operation: string, result: StoreResult<T>): T => {
		if (!result.ok) throw new Error(`${operation} failed: ${String(result.reason)}`);
		operations.push("OK");
		return result.value;
	};
	try {
		requireOK(
			"beginGeneration",
			await store.beginGeneration({
				baseExpectedHead: { kind: "none", objectId },
				closure: [{ byteLength: bytes.byteLength, digest }],
				generationId,
				objectId,
			})
		);
		requireOK("putCachedBlob", await store.putCachedBlob({ bytes, digest, generationId, objectId }));
		requireOK("promoteReference", await store.promoteReference({ digest, generationId, objectId }));
		requireOK("completeGeneration", await store.completeGeneration({ generationId, objectId }));
		const swapped = requireOK(
			"swapHead",
			await store.swapHead({ expectedHead: { kind: "none", objectId }, generationId, objectId })
		);
		await store.close();
		operations.push("OK");
		store = await openStore();
		operations.push("OK");
		const recovery = requireOK("recoverActiveGeneration", await store.recoverActiveGeneration(objectId));
		if (recovery.kind !== "active") throw new Error("production browser store did not recover the active generation");
		if (
			recovery.head.objectId !== swapped.head.objectId ||
			recovery.head.generationId !== swapped.head.generationId ||
			recovery.head.revision !== swapped.head.revision ||
			recovery.head.closureDigest !== swapped.head.closureDigest
		)
			throw new Error("production browser store recovered a different head from the committed swap");
		const schema = await rawPhase2hDatabaseSchema(databaseName);
		if (schema.version !== 1 || schema.storeNames.join("\0") !== STORE_NAMES.join("\0"))
			throw new Error("production browser store schema drifted during Phase 2h-b");
		const recoveredHead = recovery.head;
		return Object.freeze({
			evidence: Object.freeze({
				allResults: "OK",
				expectedState: "new",
				operationSequence: OPERATION_SEQUENCE,
				recoveredImageDigest: await evidenceDigest(recovery),
				recoveryKind: "active",
				reopened: true,
				tag: "browser-store",
			}),
			fullClosureDigest: recoveredHead.closureDigest,
			recoveredHead,
			store: Object.freeze({
				databaseVersion: schema.version,
				factoryCallEvents: Object.freeze(factoryCallEvents),
				operationResults: Object.freeze(operations),
				recoveredImage: recovery,
				storeNames: schema.storeNames,
			}),
		});
	} finally {
		await store.close();
	}
}

async function persistenceMode(): Promise<PersistenceMode> {
	const port = createBrowserStorageCapacityPort();
	if (typeof port.persisted !== "function") return "unsupported";
	try {
		const value = await port.persisted();
		return typeof value === "boolean" ? (value ? "granted" : "not-granted") : "unavailable-invalid-response";
	} catch {
		return "unavailable-exception";
	}
}

async function runBrowserSurfaces(): Promise<unknown> {
	const cryptoDigestObservation = await cryptoDigest();
	const workerResponsivenessObservation = await workerResponsiveness();
	const browserStoreObservation = await browserStore();
	const persistence = await persistenceMode();
	const locks = Reflect.get(navigator, "locks") as unknown as Record<string, unknown> | undefined;
	return Object.freeze({
		browserStore: browserStoreObservation,
		cryptoDigest: cryptoDigestObservation,
		persistenceMode: persistence,
		userAgent: navigator.userAgent,
		webLocksMode:
			locks !== undefined && typeof Reflect.get(locks, "request") === "function" ? "available-not-used" : "unavailable",
		workerResponsiveness: workerResponsivenessObservation,
	});
}

Reflect.set(
	globalThis,
	"phase2hBBrowserSurfaces",
	Object.freeze({ run: runBrowserSurfaces, runWorkerResponsiveness: workerResponsiveness })
);

export {};
