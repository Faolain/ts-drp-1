/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { DatabaseSync } from "node:sqlite";

import {
	armPhase3a1bP2NodePublication,
	explicitPhase3a1bP2NodeCheckpoint,
} from "./phase-3a1b-p2-node-publication-preload.mjs";
import { encodeCanonical } from "../../../canonical/dist/src/index.js";

const [, , primaryFilename, encodedTuple] = process.argv;
const tuple = JSON.parse(encodedTuple);
const scope = { author: "alice", objectId: "room:publication" };
const otherScope = { author: "bob", objectId: "room:unaddressed" };

function send(value) {
	if (typeof process.send === "function") process.send(value);
}

function commit(selected, selectedScope, seed) {
	const envelope = {
		canonicalPreimageBytes: encodeCanonical({ ...selectedScope, authorSequence: selected }),
		digest: Uint8Array.of(seed, 0xd1),
		signature: Uint8Array.of(seed, 0x51),
	};
	return {
		authorSequence: selected,
		envelope,
		issuedRecord: { authorSequence: selected, envelope, scope: selectedScope },
		outboxEntry: { authorSequence: selected, envelope, scope: selectedScope },
	};
}

async function run() {
	const candidate = await import(new URL("../../dist/src/issuance.js", import.meta.url).href);
	const createStore = candidate.createNodeDurableIssuanceStore;
	if (typeof createStore !== "function") throw new TypeError("missing Node issuance factory");
	let store = createStore({ primaryFilename });
	const selected = await store.transactIssue(scope, (ordinal) => Promise.resolve(commit(ordinal, scope, 41)));
	if (tuple.scenario !== "single-row") {
		await store.transactIssue(otherScope, (ordinal) => Promise.resolve(commit(ordinal, otherScope, 73)));
	}
	if (tuple.scenario === "already-published") {
		await store.close();
		const database = new DatabaseSync(`${primaryFilename}.drp-issuance-v1.sqlite`);
		database
			.prepare(
				"UPDATE issuance_outbox SET publish_state='published' WHERE object_id=? AND author=? AND author_sequence=?"
			)
			.run(scope.objectId, scope.author, selected.authorSequence);
		database.close();
		store = createStore({ primaryFilename });
	}
	armPhase3a1bP2NodePublication(tuple);
	if (tuple.edge === "pre-begin") explicitPhase3a1bP2NodeCheckpoint("pre-begin");
	const method = store.compareAndMarkOutboxPublished;
	if (typeof method !== "function") throw new TypeError("missing compareAndMarkOutboxPublished");
	await method.call(store, {
		authorSequence: selected.authorSequence,
		digest: new Uint8Array(selected.envelope.digest),
		scope,
	});
	send({ kind: "unexpected-result" });
	await new Promise(() => undefined);
}

run().catch((error) => {
	send({ kind: "child-error", message: error instanceof Error ? error.message : String(error) });
	process.exitCode = 1;
});
