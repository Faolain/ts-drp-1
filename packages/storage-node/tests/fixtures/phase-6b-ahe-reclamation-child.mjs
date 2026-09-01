/* eslint-disable import/no-unresolved, @typescript-eslint/explicit-function-return-type -- Future built maintenance owner is the RED seam. */
const [databaseFilename, target] = process.argv.slice(2);
if (databaseFilename === undefined || target === undefined) {
	throw new TypeError("D109C_CHILD_ARGUMENTS_INVALID");
}

let armed = false;

function checkpoint(edge) {
	if (!armed || edge !== target) return;
	process.send?.({ edge, kind: "checkpoint" });
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

function successful(result, label) {
	if (!result?.ok) throw new TypeError(`D109C_CHILD_${label}:${String(result?.reason)}`);
	return result.value;
}

try {
	const [storage, maintenanceModule, instrumentation] = await Promise.all([
		import("../../../storage/dist/src/index.js"),
		import("../../dist/src/maintenance.js"),
		import("../../dist/src/test-instrumentation.js"),
	]);
	const instrumented = instrumentation.createInstrumentedSqliteAheDurableStore({ filename: databaseFilename });
	instrumentation.installAheReclamationCrashObserver?.(instrumented.store, checkpoint);
	const store = instrumented.store;
	const maintenance = maintenanceModule.resolveNodeAheReclamationMaintenance(store);
	if (maintenance === undefined) throw new TypeError("D109C_NODE_MAINTENANCE_MISSING");
	const objectId = `creator:${"a".repeat(32)}`;
	const records = [];
	let head = successful(await store.readHead(objectId), "HEAD");
	for (let index = 1; index <= 5; index += 1) {
		const generationId = index.toString(16).padStart(64, "0");
		const bytes = Uint8Array.of(index, index + 1, index + 2);
		const digest = successful(storage.digestBlob(bytes), "BLOB_DIGEST");
		const closure = [{ byteLength: bytes.byteLength, digest }];
		successful(await store.beginGeneration({ baseExpectedHead: head, closure, generationId, objectId }), "BEGIN");
		successful(await store.putCachedBlob({ bytes, digest, generationId, objectId }), "PUT");
		successful(await store.promoteReference({ digest, generationId, objectId }), "PROMOTE");
		successful(await store.completeGeneration({ generationId, objectId }), "COMPLETE");
		head = successful(await store.swapHead({ expectedHead: head, generationId, objectId }), "SWAP").head;
		records.push(successful(await store.readGenerationPage({ limit: 16, objectId }), "PAGE").generations.at(-1));
	}
	const floor = records[2];
	if (floor === undefined) throw new TypeError("D109C_CHILD_FLOOR_MISSING");
	armed = true;
	const receipt = await maintenance.reclaimClosedEpoch({
		activeGenerationId: records[4].generationId,
		availabilityPolicyDigest: "53775c5c1ee01e346f588966d6e7acb876df2bd8b2abcbe2b2591f216f7d4d9b",
		closedEpoch: 4,
		expectedHead: head,
		lineageFloor: {
			deleteGenerationIds: [records[0].generationId, records[1].generationId].sort(),
			expectedBaseExpectedHead: floor.baseExpectedHead,
			generationId: floor.generationId,
			replacementBaseExpectedHead: { kind: "none", objectId },
		},
		objectId,
		rollbackGenerationIds: [records[3].generationId, floor.generationId],
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
