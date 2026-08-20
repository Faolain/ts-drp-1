/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { registerHooks } from "node:module";
import { DatabaseSync as NativeDatabaseSync, StatementSync } from "node:sqlite";

const [, , primaryFilename] = process.argv;
const constructorCalls = [];
const sqlByStatement = new WeakMap();
const configured = new WeakSet();
const resultBearing = [];
const events = [];
const originalPrepare = NativeDatabaseSync.prototype.prepare;
const originalExec = NativeDatabaseSync.prototype.exec;
const originalSetReadBigInts = StatementSync.prototype.setReadBigInts;
const originalGet = StatementSync.prototype.get;
const originalAll = StatementSync.prototype.all;

NativeDatabaseSync.prototype.prepare = function (sql) {
	const statement = originalPrepare.call(this, sql);
	sqlByStatement.set(statement, sql);
	return statement;
};
NativeDatabaseSync.prototype.exec = function (sql) {
	const result = originalExec.call(this, sql);
	events.push({ kind: "exec", sql });
	return result;
};
StatementSync.prototype.setReadBigInts = function (enabled) {
	if (enabled === false) configured.add(this);
	return originalSetReadBigInts.call(this, enabled);
};
StatementSync.prototype.get = function (...parameters) {
	resultBearing.push(this);
	const result = originalGet.apply(this, parameters);
	events.push({ kind: "get", parameters, result, sql: sqlByStatement.get(this) ?? "" });
	return result;
};
StatementSync.prototype.all = function (...parameters) {
	resultBearing.push(this);
	const result = originalAll.apply(this, parameters);
	events.push({ kind: "all", parameters, result, sql: sqlByStatement.get(this) ?? "" });
	return result;
};

const nativeSymbol = Symbol.for("ts-drp.phase-2l-c.native-sqlite");
const callsSymbol = Symbol.for("ts-drp.phase-2l-c.constructor-calls");
globalThis[nativeSymbol] = { DatabaseSync: NativeDatabaseSync, StatementSync };
globalThis[callsSymbol] = constructorCalls;
const wrapperSource = [
	`const native = globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(nativeSymbol))})];`,
	`const calls = globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(callsSymbol))})];`,
	"export const StatementSync = native.StatementSync;",
	"export class DatabaseSync extends native.DatabaseSync {",
	"  constructor(location, options) {",
	"    calls.push({ location, options });",
	"    super(location, options);",
	"  }",
	"}",
].join("\n");
const wrapperUrl = `data:text/javascript,${encodeURIComponent(wrapperSource)}`;
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "node:sqlite") return { shortCircuit: true, url: wrapperUrl };
		return nextResolve(specifier, context);
	},
});

async function run() {
	const originalSend = process.send?.bind(process);
	const candidate = await import(
		process.env.PHASE_2L_C_CANDIDATE_MODULE ?? new URL("../../dist/src/issuance.js", import.meta.url).href
	);
	const store = candidate.createNodeDurableIssuanceStore({ primaryFilename });
	await store.close();
	if (originalSend !== undefined) {
		originalSend({
			allResultBearingConfigured:
				resultBearing.length > 0 && resultBearing.every((statement) => configured.has(statement)),
			constructorCalls,
			events,
			kind: "observation",
			observedSql: [...new Set(resultBearing.map((statement) => sqlByStatement.get(statement) ?? ""))].join("\n"),
		});
	}
	process.disconnect?.();
}

run().catch((error) => {
	process.send?.({ kind: "child-error", message: error instanceof Error ? error.message : String(error) });
	process.exitCode = 1;
});
