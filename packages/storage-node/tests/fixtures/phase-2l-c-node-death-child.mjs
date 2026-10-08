/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { armPhase2lCStatementTrace } from "./phase-2l-c-sqlite-preload.mjs";
import { encodeCanonical } from "../../../canonical/dist/src/index.js";

const [, , primaryFilename, encodedTuple] = process.argv;
const tuple = JSON.parse(encodedTuple);

function send(value) {
	if (typeof process.send === "function") process.send(value);
}

function holdAtCheckpoint(edge) {
	send({ edge, kind: "trace", sql: null });
	send({ edge, kind: "checkpoint", sql: null });
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

function commit(authorSequence, seed = 7) {
	const scope = { author: "alice", objectId: "room:alpha" };
	const envelope = {
		canonicalPreimageBytes: encodeCanonical({ ...scope, authorSequence }),
		digest: Uint8Array.of(seed, 0xd1),
		signature: Uint8Array.of(seed, 0x51),
	};
	return {
		authorSequence,
		envelope,
		issuedRecord: { authorSequence, envelope, scope },
		outboxEntry: { authorSequence, envelope, scope },
	};
}

async function run() {
	const candidate = await import(new URL("../../dist/src/issuance.js", import.meta.url).href);
	if (typeof candidate.createNodeDurableIssuanceStore !== "function") throw new Error("missing Node issuance factory");
	const store = candidate.createNodeDurableIssuanceStore({ primaryFilename });
	if (tuple.scenario === "existing-lineage") {
		await store.transactIssue({ author: "alice", objectId: "room:alpha" }, (selected) =>
			Promise.resolve(commit(selected, 3))
		);
	}
	armPhase2lCStatementTrace(tuple);
	const operation = store.transactIssue({ author: "alice", objectId: "room:alpha" }, (selected) => {
		if (tuple.edge === "suspended-build") {
			holdAtCheckpoint(tuple.edge);
		}
		if (tuple.edge === "postbuild") {
			return Promise.resolve(commit(selected));
		}
		return Promise.resolve(commit(selected));
	});
	await operation;
	send({ kind: "unexpected-result" });
	await new Promise(() => undefined);
}

run().catch((error) => {
	send({ kind: "child-error", message: error instanceof Error ? error.message : String(error) });
	process.exitCode = 1;
});
