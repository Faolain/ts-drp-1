/* eslint-disable jsdoc/require-jsdoc -- test-owned external instrumentation has no public API. */
type ReadbackFate = "exact-new" | "exact-old" | "mixed" | "unreadable";

type Listener = EventListenerOrEventListenerObject | null;

const originalTransaction = IDBDatabase.prototype.transaction;
const originalAddEventListener = IDBTransaction.prototype.addEventListener;
const originalRequestAddEventListener = IDBRequest.prototype.addEventListener;
const originalGet = IDBObjectStore.prototype.get;
const originalGetAll = IDBObjectStore.prototype.getAll;
const originalAdd = IDBObjectStore.prototype.add;
const originalPut = IDBObjectStore.prototype.put;
const transactionState = new WeakMap<
	IDBTransaction,
	{ readonly label: string; readonly role: "distinct" | "ordinary" | "target"; hookRan: boolean }
>();
const requestEdges = new WeakMap<IDBRequest, string>();
let interleave: (() => Promise<void> | void) | undefined;
let readbackFate: ReadbackFate | undefined;
let durabilityDowngrade = false;
let trace: Readonly<{ checkpoint(edge: string): void; edge: string }> | undefined;
let injectedDepth = 0;
let operationLabel: string | undefined;
let awaitingTargetReadback: string | undefined;
let ledger: string[] = [];

function callListener(listener: Listener, event: Event, target: EventTarget | null = event.currentTarget): void {
	if (typeof listener === "function") listener.call(target, event);
	else listener?.handleEvent(event);
}

function checkpoint(edge: string): void {
	if (trace?.edge !== edge) return;
	const selected = trace;
	trace = undefined;
	selected.checkpoint(edge);
}

IDBDatabase.prototype.transaction = function (...parameters): IDBTransaction {
	const storeNames =
		typeof parameters[0] === "string" || Array.isArray(parameters[0]) ? parameters[0] : Array.from(parameters[0]);
	const transaction = originalTransaction.call(this, storeNames, parameters[1], parameters[2]);
	const mode = parameters[1] ?? "readonly";
	const target = injectedDepth === 0 && operationLabel !== undefined;
	const role = injectedDepth > 0 ? "distinct" : target ? "target" : "ordinary";
	const label = operationLabel ?? "unscoped";
	transactionState.set(transaction, { hookRan: false, label, role });
	ledger.push(`${label}:${role}:transaction:${mode}`);
	originalAddEventListener.call(transaction, "complete", () => ledger.push(`${label}:${role}:commit:${mode}`), {
		once: true,
	});
	originalAddEventListener.call(transaction, "abort", () => ledger.push(`${label}:${role}:abort:${mode}`), {
		once: true,
	});
	if (durabilityDowngrade && mode === "readwrite") {
		durabilityDowngrade = false;
		Object.defineProperty(transaction, "durability", { configurable: true, value: "default" });
	}
	if (target && mode === "readwrite") checkpoint("after-transaction");
	if (awaitingTargetReadback !== undefined && mode === "readonly" && injectedDepth === 0) {
		const readbackLabel = awaitingTargetReadback;
		awaitingTargetReadback = undefined;
		ledger.push(`${readbackLabel}:target:readonly-readback`);
		checkpoint("during-readback");
		if (readbackFate === "unreadable") {
			readbackFate = undefined;
			throw new DOMException("test-owned unreadable readback", "UnknownError");
		}
	} else if (mode === "readonly" && role !== "ordinary") {
		ledger.push(`${label}:${role}:readonly-readback`);
	}
	return transaction;
};

IDBTransaction.prototype.addEventListener = function (
	type: string,
	listener: Listener,
	options?: boolean | AddEventListenerOptions
): void {
	const state = transactionState.get(this);
	if (type !== "complete" || listener === null || state?.role !== "target" || this.mode !== "readwrite") {
		originalAddEventListener.call(this, type, listener as EventListenerOrEventListenerObject, options);
		return;
	}
	originalAddEventListener.call(
		this,
		type,
		(event: Event) => {
			if (!state.hookRan) {
				state.hookRan = true;
				checkpoint("transaction-complete");
				const callback = interleave;
				interleave = undefined;
				const fate = readbackFate;
				if (fate === "exact-new") readbackFate = undefined;
				const pending =
					callback === undefined
						? Promise.resolve()
						: Promise.resolve().then(async () => {
								injectedDepth += 1;
								try {
									await callback();
									ledger.push(`${state.label}:distinct:return`);
								} finally {
									injectedDepth -= 1;
								}
							});
				void pending.then(() => {
					awaitingTargetReadback = state.label;
					callListener(listener, event, this);
				});
				return;
			}
			callListener(listener, event, this);
		},
		options
	);
};

function instrumentRequest(request: IDBRequest, edge: string): IDBRequest {
	requestEdges.set(request, edge);
	return request;
}

function recordRequest(store: IDBObjectStore, operation: "get" | "getAll"): void {
	const state = transactionState.get(store.transaction);
	if (state === undefined || state.role === "ordinary") return;
	ledger.push(`${state.label}:${state.role}:request:${store.name}:${operation}`);
}

IDBObjectStore.prototype.get = function (...parameters): IDBRequest {
	recordRequest(this, "get");
	return instrumentRequest(originalGet.apply(this, parameters), "after-scope-read");
};
IDBObjectStore.prototype.getAll = function (...parameters): IDBRequest {
	recordRequest(this, "getAll");
	return originalGetAll.apply(this, parameters);
};
IDBObjectStore.prototype.add = function (...parameters): IDBRequest {
	return instrumentRequest(originalAdd.apply(this, parameters), "after-row-add");
};
IDBObjectStore.prototype.put = function (...parameters): IDBRequest {
	return instrumentRequest(originalPut.apply(this, parameters), "after-row-add");
};
IDBRequest.prototype.addEventListener = function (
	type: string,
	listener: Listener,
	options?: boolean | AddEventListenerOptions
): void {
	const edge = requestEdges.get(this);
	if (type !== "success" || listener === null || edge === undefined) {
		originalRequestAddEventListener.call(this, type, listener as EventListenerOrEventListenerObject, options);
		return;
	}
	originalRequestAddEventListener.call(
		this,
		type,
		(event: Event) => {
			checkpoint(edge);
			callListener(listener, event);
		},
		options
	);
};

export function armPhase3a1bP4BrowserTrace(
	tuple: Readonly<{ readonly edge: string }>,
	checkpointOwner: (edge: string) => void
): void {
	trace = Object.freeze({ checkpoint: checkpointOwner, edge: tuple.edge });
}

export function armPhase3a1bP4BrowserDurabilityDowngrade(): void {
	durabilityDowngrade = true;
}

export function armPhase3a1bP4BrowserReadbackFault(fate: ReadbackFate, callback?: () => Promise<void> | void): void {
	readbackFate = fate;
	interleave = callback;
}

export function armPhase3a1bP4BrowserReadbackInterleave(callback: () => Promise<void> | void): void {
	interleave = callback;
}

export async function observePhase3a1bP4BrowserOperation<T>(label: string, callback: () => Promise<T>): Promise<T> {
	if (operationLabel !== undefined) throw new TypeError("nested p4 Browser observations are forbidden");
	operationLabel = label;
	try {
		const result = await callback();
		ledger.push(`${label}:target:return`);
		return result;
	} finally {
		operationLabel = undefined;
	}
}

export function takePhase3a1bP4BrowserObservationLedger(): readonly string[] {
	const value = Object.freeze([...ledger]);
	ledger = [];
	return value;
}

// Compatibility-only names for contradicting pre-correction candidates. The source audit requires
// corrected production not to import them; the bundle redirect keeps the causal RED executable.
export function observePhase3a1bP4BrowserCheckpoint(): void {}
export function takePhase3a1bP4BrowserDurabilityDowngrade(): boolean {
	return false;
}
export function takePhase3a1bP4BrowserReadbackFault(): undefined {
	return undefined;
}
