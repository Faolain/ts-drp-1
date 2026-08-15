/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { DatabaseSync, StatementSync } from "node:sqlite";
import { parentPort, Worker } from "node:worker_threads";

import {
	isPhase3a1bP4NodeMutationScopeRead,
	referencesPhase3a1bP4NodeTable as table,
} from "./phase-3a1b-p4-node-sql-classifier.mjs";

const statementOwner = new WeakMap();
const databaseState = new WeakMap();
const databaseIdentity = new WeakMap();
const originalExec = DatabaseSync.prototype.exec;
const originalAll = StatementSync.prototype.all;
const originalGet = StatementSync.prototype.get;
const originalPrepare = DatabaseSync.prototype.prepare;
const originalRun = StatementSync.prototype.run;
let target;
let sent = false;
let operationLabel;
let externalFaultCallback;
let externalInterleaveSpec;
let externalReadbackFate;
let externalPending = Promise.resolve();
let injectedDepth = 0;
let externalLedger = [];
let nextDatabaseIdentity = 1;

/**
 * Installs the one test-owned trace tuple before a journal mutation.
 * @param value - Closed tuple selected by the parent test.
 */
export function armPhase3a1bP4NodeTrace(value) {
	target = value;
}

/** Arms one test-owned distinct-facade commit between the target commit and readback. */
export function armPhase3a1bP4NodeReadbackInterleave(callback) {
	externalInterleaveSpec = callback;
}

/** Arms one externally caused postcommit durable observation. */
export function armPhase3a1bP4NodeReadbackFault(fate, callback = () => undefined) {
	externalReadbackFate = fate;
	externalFaultCallback = callback;
}

/** Executes one public operation while the external SQLite observer owns its label. */
export async function observePhase3a1bP4NodeOperation(label, callback) {
	if (operationLabel !== undefined) throw new TypeError("nested p4 Node observations are forbidden");
	operationLabel = label;
	try {
		const result = await callback();
		externalLedger.push(`${label}:target:return`);
		return result;
	} finally {
		await externalPending;
		operationLabel = undefined;
	}
}

/** Drains the test-owned SQLite transaction/readback ledger. */
export function takePhase3a1bP4NodeObservationLedger() {
	const value = Object.freeze([...externalLedger]);
	externalLedger = [];
	return value;
}

function observe(edge, sql, details = {}) {
	if (target === undefined) return;
	const emit = (message) => {
		if (parentPort !== null) parentPort.postMessage(message);
		else if (typeof process.send === "function") process.send(message);
	};
	emit({ ...details, edge, kind: "trace", sql });
	if (sent || target.edge !== edge) return;
	sent = true;
	emit({ ...details, edge, kind: "checkpoint", sql });
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

function identity(database) {
	let value = databaseIdentity.get(database);
	if (value === undefined) {
		value = nextDatabaseIdentity++;
		databaseIdentity.set(database, value);
	}
	return `db${value}`;
}

function applyExternalReadbackFate(state) {
	if (state.role !== "target" || externalReadbackFate === undefined) return;
	const fate = externalReadbackFate;
	externalReadbackFate = undefined;
	if (fate === "unreadable") throw new Error("test-owned unreadable readback");
}

function recordClosureQuery(owner, state) {
	if (
		operationLabel === undefined ||
		owner.database === undefined ||
		state?.mutationActive ||
		(!table(owner.sql, "scopes") && !table(owner.sql, "accepted_entries"))
	)
		return;
	const phase = state?.readonlyActive ? "readonly" : state?.committed ? "postcommit" : "outside";
	const tableName = table(owner.sql, "scopes") ? "scopes" : "accepted_entries";
	externalLedger.push(
		`${operationLabel}:${state?.role ?? "target"}:closure-query:${phase}:${tableName}:${identity(owner.database)}`
	);
}

DatabaseSync.prototype.prepare = function (sql) {
	const statement = originalPrepare.call(this, sql);
	statementOwner.set(statement, { database: this, sql });
	return statement;
};

DatabaseSync.prototype.exec = function (sql) {
	const normalized = sql.trim().replace(/\s+/gu, " ").toUpperCase();
	const result = originalExec.call(this, sql);
	const state = databaseState.get(this) ?? {
		committed: false,
		mutationActive: false,
		readonlyActive: false,
		role: "ordinary",
	};
	if (normalized === "BEGIN IMMEDIATE") {
		state.mutationActive = true;
		state.committed = false;
		state.role = injectedDepth > 0 ? "distinct" : "target";
		databaseState.set(this, state);
		if (operationLabel !== undefined) externalLedger.push(`${operationLabel}:${state.role}:begin-immediate`);
		observe("after-begin", sql);
	} else if (/^BEGIN(?: DEFERRED)?(?: TRANSACTION)?$/u.test(normalized)) {
		state.readonlyActive = true;
		state.role = injectedDepth > 0 ? "distinct" : "target";
		databaseState.set(this, state);
		if (operationLabel !== undefined) {
			externalLedger.push(`${operationLabel}:${state.role}:readonly-begin:${identity(this)}`);
		}
	} else if (normalized === "COMMIT" && state.mutationActive) {
		state.mutationActive = false;
		state.committed = true;
		if (operationLabel !== undefined) externalLedger.push(`${operationLabel}:${state.role}:commit`);
		observe("after-commit", sql);
		if (state.role === "target" && externalFaultCallback !== undefined) {
			const callback = externalFaultCallback;
			externalFaultCallback = undefined;
			callback();
		}
		if (state.role === "target" && externalInterleaveSpec !== undefined) {
			const workerData = externalInterleaveSpec;
			externalInterleaveSpec = undefined;
			const signal = new Int32Array(new SharedArrayBuffer(4));
			const worker = new Worker(new URL("./phase-3a1b-p4-node-interleave-worker.mjs", import.meta.url), {
				workerData: { ...workerData, signal: signal.buffer },
			});
			const wait = Atomics.wait(signal, 0, 0, 10_000);
			const status = Atomics.load(signal, 0);
			if (wait === "timed-out" || status !== 1) {
				void worker.terminate();
				throw new Error(`p4 distinct worker failed before target readback (${wait}/${status})`);
			}
			externalLedger.push(`${operationLabel}:distinct:commit`);
			externalLedger.push(`${operationLabel}:distinct:readonly-readback`);
			externalLedger.push(`${operationLabel}:distinct:return`);
			externalPending = worker.terminate().then(() => undefined);
		}
	} else if (normalized === "COMMIT" && state.readonlyActive) {
		state.readonlyActive = false;
		state.committed = false;
		if (operationLabel !== undefined) {
			externalLedger.push(`${operationLabel}:${state.role}:readonly-commit:${identity(this)}`);
		}
	} else if (normalized === "ROLLBACK") {
		state.mutationActive = false;
		state.readonlyActive = false;
		state.committed = true;
		if (operationLabel !== undefined) externalLedger.push(`${operationLabel}:${state.role}:rollback`);
	}
	return result;
};

StatementSync.prototype.get = function (...parameters) {
	const result = originalGet.apply(this, parameters);
	const owner = statementOwner.get(this) ?? { database: undefined, sql: "" };
	const state = owner.database === undefined ? undefined : databaseState.get(owner.database);
	recordClosureQuery(owner, state);
	if (state?.readonlyActive && (table(owner.sql, "scopes") || table(owner.sql, "accepted_entries"))) {
		observe("during-readback", owner.sql, { parameters });
		applyExternalReadbackFate(state);
	} else if (state?.mutationActive && isPhase3a1bP4NodeMutationScopeRead(owner.sql))
		observe("after-scope-read", owner.sql, { parameters });
	else if (state?.committed && (table(owner.sql, "scopes") || table(owner.sql, "accepted_entries"))) {
		if (operationLabel !== undefined) {
			externalLedger.push(`${operationLabel}:${state.role}:readonly-readback:get`);
			state.committed = false;
		}
		observe("during-readback", owner.sql, { parameters });
		applyExternalReadbackFate(state);
	}
	return result;
};

StatementSync.prototype.all = function (...parameters) {
	const result = originalAll.apply(this, parameters);
	const owner = statementOwner.get(this) ?? { database: undefined, sql: "" };
	const state = owner.database === undefined ? undefined : databaseState.get(owner.database);
	recordClosureQuery(owner, state);
	if (state?.readonlyActive && (table(owner.sql, "scopes") || table(owner.sql, "accepted_entries"))) {
		observe("during-readback", owner.sql, { parameters });
		applyExternalReadbackFate(state);
	} else if (state?.committed && (table(owner.sql, "scopes") || table(owner.sql, "accepted_entries"))) {
		if (operationLabel !== undefined) {
			externalLedger.push(`${operationLabel}:${state.role}:readonly-readback:all`);
			state.committed = false;
		}
		observe("during-readback", owner.sql, { parameters });
		applyExternalReadbackFate(state);
	}
	return result;
};

StatementSync.prototype.run = function (...parameters) {
	const result = originalRun.apply(this, parameters);
	const owner = statementOwner.get(this) ?? { database: undefined, sql: "" };
	const state = owner.database === undefined ? undefined : databaseState.get(owner.database);
	if (state?.mutationActive && (table(owner.sql, "scopes") || table(owner.sql, "accepted_entries"))) {
		if (operationLabel !== undefined) externalLedger.push(`${operationLabel}:${state.role}:write`);
		observe("after-row-write", owner.sql, { changes: result.changes, parameters });
	}
	return result;
};
