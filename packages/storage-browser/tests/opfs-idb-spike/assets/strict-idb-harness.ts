const DATABASE_PREFIX = "phase-2-spike-s1-strict-idb";
const STORE_NAME = "sentinels";
const SENTINEL_KEY = "phase-2-spike-s1-sentinel-key-v1";
const SENTINEL_VALUE = "phase-2-spike-s1-exact-sentinel-v1";
const REQUESTED_DURABILITY = "strict";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.addEventListener("success", () => resolve(request.result), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new TypeError("IDB request failed")), {
			once: true,
		});
	});
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.addEventListener("complete", () => resolve(), { once: true });
		transaction.addEventListener("abort", () => reject(transaction.error ?? new TypeError("IDB transaction aborted")), {
			once: true,
		});
		transaction.addEventListener("error", () => reject(transaction.error ?? new TypeError("IDB transaction failed")), {
			once: true,
		});
	});
}

async function openDatabase(name: string): Promise<IDBDatabase> {
	const request = indexedDB.open(name, 1);
	request.addEventListener(
		"upgradeneeded",
		() => {
			request.result.createObjectStore(STORE_NAME);
		},
		{ once: true }
	);
	return requestResult(request);
}

async function deleteDatabase(name: string): Promise<void> {
	await requestResult(indexedDB.deleteDatabase(name));
}

interface ForcedObservationOptions {
	readonly testOnlyForcedObservedDurability?: "default" | "relaxed" | "strict";
}

interface ReopenedState {
	readonly count: number;
	readonly value: string | null;
}

interface PermissiveScenarioResult {
	readonly kind: "committed";
	readonly requestedDurability: "strict";
	readonly liveReportedDurability: "default" | "relaxed" | "strict";
	readonly observedDurability: "default" | "relaxed" | "strict";
	readonly reportedDurability: "strict";
	readonly error: null;
	readonly reopened: ReopenedState;
	readonly evidenceJson: string;
	readonly evidenceBytes: readonly number[];
}

async function readReopenedState(name: string): Promise<ReopenedState> {
	const database = await openDatabase(name);
	try {
		const transaction = database.transaction(STORE_NAME, "readonly");
		const store = transaction.objectStore(STORE_NAME);
		const [count, value] = await Promise.all([
			requestResult(store.count()),
			requestResult(store.get(SENTINEL_KEY) as IDBRequest<unknown>),
		]);
		await transactionCompletion(transaction);
		return Object.freeze({
			count,
			value: typeof value === "string" ? value : null,
		});
	} finally {
		database.close();
	}
}

/**
 * Runs the intentionally permissive S1 test scaffold in a real page-owned IDB database.
 * @param options - The bounded private observation seam used only by the causal RED.
 * @returns Live transaction, reopen, and emitted-evidence observations.
 */
async function runStrictIdbCapabilityScenario(
	options: ForcedObservationOptions = {}
): Promise<PermissiveScenarioResult> {
	const forced = options.testOnlyForcedObservedDurability;
	if (forced !== undefined && forced !== "strict" && forced !== "relaxed" && forced !== "default") {
		throw new TypeError("testOnlyForcedObservedDurability is outside the bounded IDB vocabulary");
	}

	const databaseName = `${DATABASE_PREFIX}-${crypto.randomUUID()}`;
	const database = await openDatabase(databaseName);
	let liveReportedDurability: IDBTransactionDurability;
	let observedDurability: IDBTransactionDurability;
	try {
		const transaction = database.transaction(STORE_NAME, "readwrite", {
			durability: REQUESTED_DURABILITY,
		});
		liveReportedDurability = transaction.durability;
		if (
			liveReportedDurability !== "strict" &&
			liveReportedDurability !== "relaxed" &&
			liveReportedDurability !== "default"
		) {
			throw new TypeError(`unexpected live IDB durability: ${liveReportedDurability}`);
		}
		observedDurability = forced ?? liveReportedDurability;

		// Authorized permissive RED scaffold: it trusts the request instead of the observation.
		// GREEN must replace this request echo with a typed fatal result before any write.
		const reportedDurability = REQUESTED_DURABILITY;
		transaction.objectStore(STORE_NAME).add(SENTINEL_VALUE, SENTINEL_KEY);
		await transactionCompletion(transaction);

		database.close();
		const reopened = await readReopenedState(databaseName);
		const evidenceJson = JSON.stringify({
			schemaVersion: 1,
			artifactKind: "strict-idb-capability",
			requestedDurability: REQUESTED_DURABILITY,
			observedDurability: reportedDurability,
			observedFrom: "live-transaction",
			nonStrictOutcome: "typed-fatal-capability-error",
			nonStrictWritesCommitted: 0,
			durabilityEvidenceScope: "capability-and-no-fallback",
			notProven: ["fsync", "power-loss", "torn-write"],
		});
		return Object.freeze({
			kind: "committed",
			requestedDurability: REQUESTED_DURABILITY,
			liveReportedDurability,
			observedDurability,
			reportedDurability,
			error: null,
			reopened,
			evidenceJson,
			evidenceBytes: Array.from(new TextEncoder().encode(evidenceJson)),
		});
	} finally {
		database.close();
		await deleteDatabase(databaseName);
	}
}

Object.defineProperty(globalThis, "runStrictIdbCapabilityScenario", {
	configurable: false,
	enumerable: false,
	value: runStrictIdbCapabilityScenario,
	writable: false,
});

Object.defineProperty(globalThis, "strictIdbSentinel", {
	configurable: false,
	enumerable: false,
	value: Object.freeze({ key: SENTINEL_KEY, value: SENTINEL_VALUE }),
	writable: false,
});
