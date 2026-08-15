/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { DatabaseSync, StatementSync } from "node:sqlite";
import { parentPort } from "node:worker_threads";

const statementSql = new WeakMap();
const originalExec = DatabaseSync.prototype.exec;
const originalGet = StatementSync.prototype.get;
const originalPrepare = DatabaseSync.prototype.prepare;
const originalRun = StatementSync.prototype.run;
let target;
let mutationActive = false;
let committed = false;
let sent = false;

/**
 * Installs the one test-owned trace tuple before a journal mutation.
 * @param value - Closed tuple selected by the parent test.
 */
export function armPhase3a1bP4NodeTrace(value) {
	target = value;
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

function table(sql, name) {
	return new RegExp(`\\b(?:FROM|INTO|UPDATE)\\s+(?:${name}|"${name}"|\\\`${name}\\\`)\\b`, "iu").test(sql);
}

DatabaseSync.prototype.prepare = function (sql) {
	const statement = originalPrepare.call(this, sql);
	statementSql.set(statement, sql);
	return statement;
};

DatabaseSync.prototype.exec = function (sql) {
	const normalized = sql.trim().replace(/\s+/gu, " ").toUpperCase();
	const result = originalExec.call(this, sql);
	if (normalized === "BEGIN IMMEDIATE") {
		mutationActive = true;
		committed = false;
		observe("after-begin", sql);
	} else if (normalized === "COMMIT" && mutationActive) {
		mutationActive = false;
		committed = true;
		observe("after-commit", sql);
	} else if (normalized === "ROLLBACK") {
		mutationActive = false;
	}
	return result;
};

StatementSync.prototype.get = function (...parameters) {
	const result = originalGet.apply(this, parameters);
	const sql = statementSql.get(this) ?? "";
	if (mutationActive && table(sql, "scopes")) observe("after-scope-read", sql, { parameters });
	else if (committed && (table(sql, "scopes") || table(sql, "accepted_entries"))) {
		observe("during-readback", sql, { parameters });
	}
	return result;
};

StatementSync.prototype.run = function (...parameters) {
	const result = originalRun.apply(this, parameters);
	const sql = statementSql.get(this) ?? "";
	if (mutationActive && (table(sql, "scopes") || table(sql, "accepted_entries"))) {
		observe("after-row-write", sql, { changes: result.changes, parameters });
	}
	return result;
};
