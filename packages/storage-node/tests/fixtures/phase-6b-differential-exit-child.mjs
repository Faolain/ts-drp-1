/* eslint-disable @typescript-eslint/explicit-function-return-type -- Fresh-process executable fixture. */
const [role, databaseFilename, encodedInput] = process.argv.slice(2);
if (role === undefined || databaseFilename === undefined) {
	throw new TypeError("D109F_CHILD_ARGUMENTS_INVALID");
}

function send(message) {
	process.send?.(message);
}

function successful(result, label) {
	if (!result?.ok) throw new TypeError(`D109F_CHILD_${label}:${String(result?.reason)}`);
	return result.value;
}

try {
	if (role === "hold") {
		const { DatabaseSync } = await import("node:sqlite");
		const database = new DatabaseSync(databaseFilename);
		database.exec("BEGIN IMMEDIATE");
		send({ kind: "held" });
		await new Promise((resolvePromise) => process.once("message", resolvePromise));
		database.exec("COMMIT");
		database.close();
		send({ kind: "released" });
	} else {
		const [storage, nodeStorage, maintenanceModule] = await Promise.all([
			import("../../../storage/dist/src/index.js"),
			import("../../dist/src/index.js"),
			import("../../dist/src/maintenance.js"),
		]);
		const store = nodeStorage.createSqliteAheDurableStore({ filename: databaseFilename });
		if (role === "reopen") {
			const objectId = `creator:${"f".repeat(32)}`;
			const head = successful(await store.readHead(objectId), "REOPEN_HEAD");
			if (head.kind !== "present") throw new TypeError("D109F_CHILD_REOPEN_HEAD_ABSENT");
			const index = head.revision + 1;
			const generationId = index.toString(16).padStart(64, "0");
			const bytes = Uint8Array.of(index & 0xff, (index + 1) & 0xff, (index + 2) & 0xff);
			const digest = successful(storage.digestBlob(bytes), "REOPEN_DIGEST");
			const closure = [{ byteLength: bytes.byteLength, digest }];
			successful(await store.beginGeneration({ baseExpectedHead: head, closure, generationId, objectId }), "BEGIN");
			successful(await store.putCachedBlob({ bytes, digest, generationId, objectId }), "PUT");
			successful(await store.promoteReference({ digest, generationId, objectId }), "PROMOTE");
			successful(await store.completeGeneration({ generationId, objectId }), "COMPLETE");
			const next = successful(await store.swapHead({ expectedHead: head, generationId, objectId }), "SWAP").head;
			send({ kind: "reopened", next });
		} else if (role === "reclaim") {
			if (encodedInput === undefined) throw new TypeError("D109F_CHILD_RECLAIM_INPUT_MISSING");
			const input = JSON.parse(Buffer.from(encodedInput, "base64url").toString("utf8"));
			const owner = maintenanceModule.resolveNodeAheReclamationMaintenance(store);
			if (owner === undefined) throw new TypeError("D109F_CHILD_AHE_OWNER_MISSING");
			send({ kind: "attempting" });
			const fresh = await owner.reclaimClosedEpoch(input);
			const replay = await owner.reclaimClosedEpoch(input);
			send({ fresh, kind: "reclaimed", replay });
		} else {
			throw new TypeError(`D109F_CHILD_ROLE_INVALID:${role}`);
		}
		await store.close();
	}
} catch (error) {
	send({ kind: "child-error", message: error instanceof Error ? (error.stack ?? error.message) : String(error) });
	process.exitCode = 1;
}
