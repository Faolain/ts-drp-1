import { DatabaseSync } from "node:sqlite";

import { createNodeSnapshotQuarantineStore } from "../../src/snapshot-transfer.js";

const [primaryFilename, target] = process.argv.slice(2);
if (primaryFilename === undefined || (target !== "after-mutation" && target !== "after-commit"))
	throw new Error("invalid child input");
let migrationWrite = false;
const observe = (sql: string): void => {
	const normalized = sql.trim().replace(/\s+/gu, " ").toUpperCase();
	const writes = /ALTER TABLE SNAPSHOT_(?:SCOPES|CHUNKS)|CREATE TABLE SNAPSHOT_OWNER_V2/u.test(normalized);
	migrationWrite ||= writes;
	const committed = /\bCOMMIT\b/u.test(normalized);
	if (
		(target === "after-mutation" && writes && !committed) ||
		(target === "after-commit" && migrationWrite && committed)
	) {
		process.send?.({ kind: "checkpoint", target, sql: normalized });
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
	}
};
const originalExec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function observedExec(sql): void {
	originalExec.call(this, sql);
	observe(sql);
};
const originalPrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function observedPrepare(sql): ReturnType<typeof originalPrepare> {
	const statement = originalPrepare.call(this, sql);
	const originalRun = statement.run;
	statement.run = function observedRun(...parameters): ReturnType<typeof originalRun> {
		const result = Reflect.apply(originalRun, this, parameters) as ReturnType<typeof originalRun>;
		observe(sql);
		return result;
	};
	return statement;
};
const store = createNodeSnapshotQuarantineStore({ primaryFilename });
void store.close().then(() => process.send?.({ kind: "completed-without-target", target }));
