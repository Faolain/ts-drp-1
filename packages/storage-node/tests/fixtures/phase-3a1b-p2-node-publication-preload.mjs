/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { DatabaseSync, StatementSync } from "node:sqlite";

const statementSql = new WeakMap();
const originalPrepare = DatabaseSync.prototype.prepare;
const originalExec = DatabaseSync.prototype.exec;
const originalGet = StatementSync.prototype.get;
const originalRun = StatementSync.prototype.run;

let target;
let mutation = false;
let committed = false;
let closureReads = 0;
let armed = false;

/**
 * Arms one exact publication boundary.
 * @param value - Selected death tuple.
 */
export function armPhase3a1bP2NodePublication(value) {
	target = value;
}

/**
 * Emits one non-SQL publication boundary.
 * @param edge - Exact boundary identifier.
 */
export function explicitPhase3a1bP2NodeCheckpoint(edge) {
	checkpoint(edge, null);
}

function send(value) {
	if (typeof process.send === "function") process.send(value);
}

function checkpoint(edge, sql, details = {}) {
	send({ ...details, edge, kind: "trace", sql });
	if (armed || target?.edge !== edge) return;
	armed = true;
	send({ ...details, edge, kind: "checkpoint", sql });
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

function table(sql, name) {
	return new RegExp(`\\b(?:FROM|UPDATE)\\s+(?:${name}|"${name}"|\\[${name}\\])\\b`, "iu").test(sql);
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
		mutation = true;
		committed = false;
		closureReads = 0;
		checkpoint("begin", sql);
	} else if (normalized === "COMMIT" && mutation) {
		mutation = false;
		committed = true;
		checkpoint(target?.scenario === "already-published" ? "already-published-commit" : "commit", sql);
	} else if (normalized === "ROLLBACK") {
		mutation = false;
	}
	return result;
};

StatementSync.prototype.get = function (...parameters) {
	const result = originalGet.apply(this, parameters);
	const sql = statementSql.get(this) ?? "";
	if (
		mutation &&
		/^\s*SELECT\b/iu.test(sql) &&
		(table(sql, "lineages") || table(sql, "issued_records") || table(sql, "issuance_outbox"))
	) {
		closureReads++;
		if (target?.scenario === "already-published" && table(sql, "issuance_outbox")) {
			checkpoint("already-published-read", sql, { parameters });
		} else if (closureReads === 3) {
			checkpoint("closure-read", sql, { parameters });
		}
	} else if (committed && /^\s*SELECT\b/iu.test(sql) && table(sql, "issuance_outbox")) {
		checkpoint("readback", sql, { parameters });
	}
	return result;
};

StatementSync.prototype.run = function (...parameters) {
	const result = originalRun.apply(this, parameters);
	const sql = statementSql.get(this) ?? "";
	if (mutation && /^\s*UPDATE\b/iu.test(sql) && table(sql, "issuance_outbox")) {
		checkpoint("outbox-update", sql, { changes: result.changes, parameters });
	}
	return result;
};
