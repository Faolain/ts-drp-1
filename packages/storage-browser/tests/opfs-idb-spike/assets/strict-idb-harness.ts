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

function transactionAbortCompletion(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.addEventListener(
			"complete",
			() => reject(new TypeError("IDB transaction completed instead of aborting")),
			{ once: true }
		);
		transaction.addEventListener(
			"abort",
			() => {
				const error = transaction.error;
				if (error === null || error.name === "AbortError") {
					resolve();
					return;
				}
				reject(error);
			},
			{ once: true }
		);
		transaction.addEventListener(
			"error",
			() => reject(transaction.error ?? new TypeError("IDB transaction failed while aborting")),
			{ once: true }
		);
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

interface CommittedScenarioResult {
	readonly kind: "committed";
	readonly requestedDurability: "strict";
	readonly liveReportedDurability: "default" | "relaxed" | "strict";
	readonly observedDurability: "strict";
	readonly reportedDurability: "strict";
	readonly error: null;
	readonly reopened: ReopenedState;
	readonly evidenceJson: string;
	readonly evidenceBytes: readonly number[];
}

interface FatalCapabilityScenarioResult {
	readonly kind: "fatal-capability-error";
	readonly requestedDurability: "strict";
	readonly liveReportedDurability: "default" | "relaxed" | "strict";
	readonly observedDurability: "default" | "relaxed";
	readonly reportedDurability: null;
	readonly error: {
		readonly name: "StrictIdbCapabilityError";
		readonly code: "NON_STRICT_DURABILITY";
		readonly requestedDurability: "strict";
		readonly observedDurability: "default" | "relaxed";
	};
	readonly reopened: ReopenedState;
	readonly evidenceJson: null;
	readonly evidenceBytes: null;
}

type ScenarioResult = CommittedScenarioResult | FatalCapabilityScenarioResult;

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
 * Runs the private S1 strict-durability capability probe in a real page-owned IDB database.
 * @param options - The bounded private observation seam used only by the causal RED.
 * @returns Live transaction, reopen, and emitted-evidence observations.
 */
async function runStrictIdbCapabilityScenario(options: ForcedObservationOptions = {}): Promise<ScenarioResult> {
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

		if (observedDurability !== "strict") {
			const abortCompletion = transactionAbortCompletion(transaction);
			transaction.abort();
			await abortCompletion;

			database.close();
			const reopened = await readReopenedState(databaseName);
			return Object.freeze({
				kind: "fatal-capability-error",
				requestedDurability: REQUESTED_DURABILITY,
				liveReportedDurability,
				observedDurability,
				reportedDurability: null,
				error: Object.freeze({
					name: "StrictIdbCapabilityError",
					code: "NON_STRICT_DURABILITY",
					requestedDurability: REQUESTED_DURABILITY,
					observedDurability,
				}),
				reopened,
				evidenceJson: null,
				evidenceBytes: null,
			});
		}

		transaction.objectStore(STORE_NAME).add(SENTINEL_VALUE, SENTINEL_KEY);
		await transactionCompletion(transaction);

		database.close();
		const reopened = await readReopenedState(databaseName);
		const evidenceJson = JSON.stringify({
			schemaVersion: 1,
			artifactKind: "strict-idb-capability",
			requestedDurability: REQUESTED_DURABILITY,
			observedDurability,
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
			reportedDurability: observedDurability,
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
