import { DatabaseSync } from "node:sqlite";
import { createNodeDurableIssuanceStore } from "../../src/issuance.js";
import { durableIssuancePruningMaintenanceForStore } from "../../../issuance-store/src/maintenance.js";

const [primaryFilename, objectId, edge] = process.argv.slice(2);
let armed = false;
function checkpoint(actual) {
	if (!armed || actual !== edge) return;
	process.send({kind: "checkpoint", edge});
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
const originalExec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
	if (/^\s*COMMIT\s*;?\s*$/iu.test(sql)) checkpoint("before-commit");
	const result = Reflect.apply(originalExec, this, [sql]);
	if (/^\s*COMMIT\s*;?\s*$/iu.test(sql)) checkpoint("after-commit");
	return result;
};
const originalPrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql) {
	const statement = Reflect.apply(originalPrepare, this, [sql]);
	return new Proxy(statement, {get(target, property) {
		const value = Reflect.get(target, property, target);
		if (property !== "run" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
		return (...args) => {
			if (/^UPDATE settlement_plans\b/u.test(sql)) checkpoint("before-plan-write");
			const result = Reflect.apply(value, target, args);
			if (/^UPDATE settlement_plans\b/u.test(sql)) checkpoint("after-plan-write");
			if (/^UPDATE retirement_controls\b/u.test(sql)) checkpoint("after-control-write");
			return result;
		};
	}});
};
try {
	const store = createNodeDurableIssuanceStore({primaryFilename});
	const read = await durableIssuancePruningMaintenanceForStore(store).acquireRetirementControl({objectId});
	armed = true;
	await read.commitPrepared();
	throw new Error("requested crash edge was not reached");
} catch (error) {
	process.send({kind: "child-error", message: error?.stack ?? String(error)});
	process.exitCode = 1;
}
