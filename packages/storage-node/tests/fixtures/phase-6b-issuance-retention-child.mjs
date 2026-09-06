import { DatabaseSync } from "node:sqlite";

const [primaryFilename, target] = process.argv.slice(2);
if (primaryFilename === undefined || target === undefined) {
	throw new TypeError("D109B_CHILD_ARGUMENTS_INVALID");
}

let armed = false;

function checkpoint(edge) {
	if (!armed || edge !== target) return;
	process.send?.({ edge, kind: "checkpoint" });
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

const originalExec = DatabaseSync.prototype.exec;
const originalPrepare = DatabaseSync.prototype.prepare;

DatabaseSync.prototype.exec = function d109bExec(sql) {
	if (/^\s*COMMIT\s*;?\s*$/iu.test(sql)) checkpoint("before-commit");
	const result = Reflect.apply(originalExec, this, [sql]);
	if (/^\s*COMMIT\s*;?\s*$/iu.test(sql)) checkpoint("after-commit");
	return result;
};

DatabaseSync.prototype.prepare = function d109bPrepare(sql) {
	const prepared = Reflect.apply(originalPrepare, this, [sql]);
	return new Proxy(prepared, {
		get(statement, property) {
			const value = Reflect.get(statement, property, statement);
			if (property !== "run" || typeof value !== "function") {
				return typeof value === "function" ? value.bind(statement) : value;
			}
			return (...parameters) => {
				if (/^\s*DELETE\s+FROM\s+issued_records\b/iu.test(sql)) checkpoint("before-delete");
				const result = Reflect.apply(value, statement, parameters);
				if (/^\s*DELETE\s+FROM\s+issued_records\b/iu.test(sql)) checkpoint("after-issued-delete");
				if (/^\s*DELETE\s+FROM\s+issuance_outbox\b/iu.test(sql)) checkpoint("after-pair-delete");
				if (/^\s*UPDATE\s+lineages\b/iu.test(sql)) checkpoint("after-watermark-write");
				return result;
			};
		},
	});
};

try {
	const [{ encodeCanonical }, issuance, maintenanceModule] = await Promise.all([
		import("../../../canonical/dist/src/index.js"),
		import("../../dist/src/issuance.js"),
		import("../../dist/src/issuance-maintenance.js"),
	]);
	const scope = Object.freeze({ author: "a".repeat(64), objectId: `creator:${"b".repeat(32)}` });
	const store = issuance.createNodeDurableIssuanceStore({ primaryFilename });
	const maintenance = maintenanceModule.resolveNodeDurableIssuancePruningMaintenance(store);
	if (maintenance === undefined) throw new TypeError("D109B_NODE_MAINTENANCE_MISSING");
	for (let index = 0; index < 2; index += 1) {
		const commit = await store.transactIssue(scope, (authorSequence) => {
			const envelope = {
				canonicalPreimageBytes: encodeCanonical({
					author: scope.author,
					authorSequence,
					epoch: 4,
					kind: "drp-vertex",
					objectId: scope.objectId,
					protocolMajor: 3,
				}),
				digest: Uint8Array.of(11 + index, 21 + index),
				signature: Uint8Array.of(31 + index, 41 + index),
			};
			return Promise.resolve({
				authorSequence,
				envelope,
				issuedRecord: { authorSequence, envelope, scope },
				outboxEntry: { authorSequence, envelope, scope },
			});
		});
		await store.compareAndMarkOutboxPublished({
			authorSequence: commit.authorSequence,
			digest: commit.envelope.digest,
			scope,
		});
	}
	const state = await maintenance.inspectPruningState(scope);
	armed = true;
	const receipt = await maintenance.prunePublishedPrefix({
		closedEpoch: 4,
		commitQcRef: { byteLength: 32, digest: "e".repeat(64) },
		expectedLineage: state.lineage,
		expectedPrunedThroughAuthorSequence: state.prunedThroughAuthorSequence,
		scope,
		snapshotManifestDigest: "f".repeat(64),
		throughAuthorSequence: 1,
	});
	process.send?.({ kind: "complete", receipt });
	await store.close();
} catch (error) {
	process.send?.({
		kind: "child-error",
		message: error instanceof Error ? (error.stack ?? error.message) : String(error),
	});
	process.exitCode = 1;
}
