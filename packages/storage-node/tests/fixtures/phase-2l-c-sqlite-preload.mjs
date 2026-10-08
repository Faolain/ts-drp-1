/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { DatabaseSync, StatementSync } from "node:sqlite";

const statementSql = new WeakMap();
const originalPrepare = DatabaseSync.prototype.prepare;
const originalExec = DatabaseSync.prototype.exec;
const originalGet = StatementSync.prototype.get;
const originalRun = StatementSync.prototype.run;

let target;
let sent = false;
let mutationActive = false;

/**
 * Selects one exact native boundary for this child.
 * @param value - Death tuple containing the target edge.
 */
export function armPhase2lCStatementTrace(value) {
	target = value;
}

function targetsTable(sql, command, table) {
	const identifier = `(?:${table}|"${table}"|\`${table}\`|\\[${table}\\])`;
	if (command === "UPDATE") return new RegExp(`^\\s*UPDATE\\s+${identifier}(?:\\s|$)`, "iu").test(sql);
	return new RegExp(`^\\s*${command}\\b[\\s\\S]*\\b(?:FROM|INTO)\\s+${identifier}(?:\\s|$)`, "iu").test(sql);
}

function observe(edge, sql, details = {}) {
	if (target === undefined) return;
	if (typeof process.send === "function") process.send({ ...details, edge, kind: "trace", sql });
	if (sent || target.edge !== edge) return;
	sent = true;
	if (typeof process.send === "function") {
		process.send({ ...details, edge, kind: "checkpoint", sql });
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
	}
}

DatabaseSync.prototype.prepare = function (sql) {
	const statement = originalPrepare.call(this, sql);
	statementSql.set(statement, sql);
	return statement;
};

DatabaseSync.prototype.exec = function (sql) {
	const normalized = sql.trim().replace(/\s+/gu, " ").toUpperCase();
	if (normalized === "BEGIN IMMEDIATE" && target?.edge === "postbuild") observe("postbuild", sql);
	const result = originalExec.call(this, sql);
	if (normalized === "BEGIN IMMEDIATE") {
		mutationActive = true;
		observe("begin", sql);
	} else if (normalized === "ROLLBACK") {
		mutationActive = false;
		observe("rollback", sql);
	} else if (normalized === "COMMIT") {
		const wasMutation = mutationActive;
		mutationActive = false;
		if (wasMutation) observe("commit", sql);
	} else if (normalized.startsWith("CREATE TABLE ")) observe("admission-ddl", sql);
	return result;
};

StatementSync.prototype.get = function (...parameters) {
	const result = originalGet.apply(this, parameters);
	const sql = statementSql.get(this) ?? "";
	if (
		mutationActive &&
		targetsTable(sql, "SELECT", "lineages") &&
		/\bnext\b/iu.test(sql) &&
		/\bexhausted\b/iu.test(sql)
	) {
		observe("state-select", sql, { parameters });
		if (target?.edge === "rollback") {
			const row = result && typeof result === "object" ? result : { exhausted: 0, next: 0 };
			return { ...row, next: Number(row.next) + 1 };
		}
	}
	return result;
};

StatementSync.prototype.run = function (...parameters) {
	const result = originalRun.apply(this, parameters);
	const sql = statementSql.get(this) ?? "";
	if (
		mutationActive &&
		(targetsTable(sql, "INSERT", "lineages") ||
			(targetsTable(sql, "UPDATE", "lineages") &&
				/\bWHERE\b/iu.test(sql) &&
				/\bobject_id\b/iu.test(sql) &&
				/\bauthor\b/iu.test(sql) &&
				/\bnext\b/iu.test(sql) &&
				/\bexhausted\b/iu.test(sql)))
	) {
		observe("lineage-write", sql, { changes: result.changes, parameters });
	} else if (mutationActive && targetsTable(sql, "INSERT", "issued_records")) {
		observe("issued-insert", sql, { changes: result.changes, parameters });
	} else if (mutationActive && targetsTable(sql, "INSERT", "issuance_outbox")) {
		observe("outbox-insert", sql, { changes: result.changes, parameters });
	}
	return result;
};
