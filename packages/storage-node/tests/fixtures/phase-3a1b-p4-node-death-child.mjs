/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { DatabaseSync } from "node:sqlite";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

import { armPhase3a1bP4NodeTrace } from "./phase-3a1b-p4-node-preload.mjs";
import { encodeCanonical, hashDomain } from "../../../canonical/dist/src/index.js";

let primaryFilename;
let tuple;
let mode;
if (isMainThread) {
	const [, , mainPrimaryFilename, encodedTuple, mainMode = "mutate"] = process.argv;
	primaryFilename = mainPrimaryFilename;
	tuple = JSON.parse(encodedTuple);
	mode = mainMode;
}

function lowerHex(value) {
	return Buffer.from(value).toString("hex");
}

function material(seed) {
	const zero = "0".repeat(64);
	const objectId = `creator:${seed.repeat(32)}`;
	const parameters = encodeCanonical({
		maxEpochVertices: 64,
		maxEpochBytes: 1048576,
		maxDependencies: 8,
		snapshotChunkBytes: 65536,
		maxSnapshotBytes: 1048576,
		maxPendingEntries: 64,
		maxPendingBytes: 1048576,
	});
	const parametersDigest = lowerHex(hashDomain("ts-drp/parameters/v3", parameters));
	const anchor = encodeCanonical({
		kind: "drp-epoch-anchor",
		protocolMajor: 3,
		objectId,
		epoch: 0,
		previousAnchor: zero,
		cutDigest: zero,
		stateDigest: zero,
		aclDigest: zero,
		historyRoot: zero,
		historySize: 0,
		archiveIndexRoot: zero,
		blueprintDigest: "2".repeat(64),
		signerSetDigest: "3".repeat(64),
		parametersDigest,
		profileDigest: "4".repeat(64),
		cryptoSuiteId: "ed25519-sha256-v3",
	});
	const anchorDigest = lowerHex(hashDomain("ts-drp/epoch-anchor/v3", anchor));
	const vertex = encodeCanonical({
		kind: "drp-vertex",
		protocolMajor: 3,
		objectId,
		epoch: 0,
		anchor: anchorDigest,
		author: `creator-${seed}`,
		authorSequence: 0,
		logicalTime: 1,
		dependencies: ["5".repeat(64)],
		operation: { arguments: { value: 1 }, type: "append" },
	});
	const signature = new Uint8Array(64).fill(7);
	const scope = { anchorDigest, epoch: 0, objectId };
	return {
		install: {
			detachedAnchorSignature: signature,
			exactCanonicalAnchorPreimageBytes: anchor,
			exactCanonicalParametersCarrierBytes: parameters,
			objectId,
		},
		local: {
			author: `creator-${seed}`,
			authorSequence: 0,
			scope,
			sourceKind: "local-issued",
			vertexDigest: lowerHex(hashDomain("ts-drp/vertex/v3", vertex)),
		},
		received: {
			detachedSignature: signature,
			exactCanonicalPreimageBytes: vertex,
			scope,
			sourceKind: "received",
			vertexDigest: lowerHex(hashDomain("ts-drp/vertex/v3", vertex)),
		},
	};
}

function checkpoint(edge) {
	if (typeof process.send === "function") process.send({ edge, kind: "checkpoint", sql: null });
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

function rawClosure() {
	const database = new DatabaseSync(`${primaryFilename}.drp-live-journal-v1.sqlite`, {
		allowExtension: false,
		enableDoubleQuotedStringLiterals: false,
		enableForeignKeyConstraints: false,
		readOnly: true,
	});
	try {
		return {
			rows: database
				.prepare(
					"SELECT object_id,epoch,anchor_digest,journal_sequence,source_kind,vertex_digest,received_preimage,received_signature,local_author,local_author_sequence FROM accepted_entries ORDER BY journal_sequence"
				)
				.all()
				.map((row) => ({
					...row,
					received_preimage: row.received_preimage === null ? null : lowerHex(row.received_preimage),
					received_signature: row.received_signature === null ? null : lowerHex(row.received_signature),
				})),
			scopes: database
				.prepare(
					"SELECT object_id,epoch,anchor_digest,next_journal_sequence,exact_anchor_preimage,detached_anchor_signature,parameters_digest,exact_parameters_carrier FROM scopes ORDER BY object_id,epoch,anchor_digest"
				)
				.all()
				.map((scope) => ({
					...scope,
					detached_anchor_signature: lowerHex(scope.detached_anchor_signature),
					exact_anchor_preimage: lowerHex(scope.exact_anchor_preimage),
					exact_parameters_carrier: lowerHex(scope.exact_parameters_carrier),
				})),
		};
	} finally {
		database.close();
	}
}

function expectedScope(values, nextJournalSequence) {
	return {
		anchor_digest: values.received.scope.anchorDigest,
		detached_anchor_signature: lowerHex(values.install.detachedAnchorSignature),
		epoch: values.received.scope.epoch,
		exact_anchor_preimage: lowerHex(values.install.exactCanonicalAnchorPreimageBytes),
		exact_parameters_carrier: lowerHex(values.install.exactCanonicalParametersCarrierBytes),
		next_journal_sequence: nextJournalSequence,
		object_id: values.received.scope.objectId,
		parameters_digest: lowerHex(
			hashDomain("ts-drp/parameters/v3", values.install.exactCanonicalParametersCarrierBytes)
		),
	};
}

function expectedRow(values, sourceKind) {
	const input = sourceKind === "received" ? values.received : values.local;
	return {
		anchor_digest: input.scope.anchorDigest,
		epoch: input.scope.epoch,
		journal_sequence: 0,
		local_author: sourceKind === "received" ? null : input.author,
		local_author_sequence: sourceKind === "received" ? null : input.authorSequence,
		object_id: input.scope.objectId,
		received_preimage: sourceKind === "received" ? lowerHex(input.exactCanonicalPreimageBytes) : null,
		received_signature: sourceKind === "received" ? lowerHex(input.detachedSignature) : null,
		source_kind: sourceKind,
		vertex_digest: input.vertexDigest,
	};
}

function expectedClosure(values, unaddressed) {
	const noWriteSource =
		tuple.scenario === "received-repeat" || tuple.scenario === "cross-kind-race"
			? "received"
			: tuple.scenario === "local-repeat" || tuple.scenario === "local-ref-race"
				? "local-issued"
				: null;
	const committedNew = tuple.edge === "after-commit" || tuple.edge === "during-readback";
	const sourceKind =
		noWriteSource ??
		(tuple.scenario === "append-received" && committedNew
			? "received"
			: tuple.scenario === "append-local" && committedNew
				? "local-issued"
				: null);
	const primaryInstalled = tuple.scenario !== "install-genesis" || committedNew;
	const rows = sourceKind === null ? [] : [expectedRow(values, sourceKind)];
	const scopes = [
		...(primaryInstalled ? [expectedScope(values, rows.length)] : []),
		...(tuple.scopeScenario === "two-scopes" ? [expectedScope(unaddressed, 0)] : []),
	].sort((left, right) => left.object_id.localeCompare(right.object_id));
	return { rows, scopes };
}

async function run() {
	const candidate = await import(new URL("../../dist/src/live-journal.js", import.meta.url).href);
	if (typeof candidate.createNodeDurableLiveJournalStore !== "function")
		throw new Error("missing Node live-journal factory");
	const store = candidate.createNodeDurableLiveJournalStore({ primaryFilename });
	const values = material("1");
	const unaddressed = material("2");
	if (mode === "recover") {
		const primary = await store.readiness({ scope: values.received.scope });
		const other =
			tuple.scopeScenario === "two-scopes" ? await store.readiness({ scope: unaddressed.received.scope }) : null;
		await store.close();
		if (typeof process.send === "function")
			process.send({
				expectedRaw: expectedClosure(values, unaddressed),
				kind: "recovery",
				primary,
				raw: rawClosure(),
				unaddressed: other,
			});
		return;
	}
	if (tuple.scenario === "idempotent-genesis") await store.installGenesis(values.install);
	else if (tuple.scenario === "received-repeat" || tuple.scenario === "cross-kind-race") {
		await store.installGenesis(values.install);
		await store.appendAccepted(values.received);
	} else if (tuple.scenario === "local-repeat" || tuple.scenario === "local-ref-race") {
		await store.installGenesis(values.install);
		await store.appendAccepted(values.local);
	}
	if (tuple.scopeScenario === "two-scopes") await store.installGenesis(unaddressed.install);
	if (
		tuple.scenario !== "install-genesis" &&
		!["idempotent-genesis", "received-repeat", "local-repeat", "cross-kind-race", "local-ref-race"].includes(
			tuple.scenario
		)
	)
		await store.installGenesis(values.install);
	if (tuple.scenario === "cross-kind-race" || tuple.scenario === "local-ref-race") {
		if (tuple.edge !== "after-scope-read") throw new Error("race tuple must stop at the scope-read fault window");
		await store.close();
		await coordinateRace(tuple);
		return;
	}
	if (tuple.edge === "before-begin") checkpoint(tuple.edge);
	armPhase3a1bP4NodeTrace(tuple);
	if (tuple.scenario === "install-genesis" || tuple.scenario === "idempotent-genesis")
		await store.installGenesis(values.install);
	else if (tuple.scenario === "append-received") await store.appendAccepted(values.received);
	else if (tuple.scenario === "received-repeat") await store.appendAccepted(values.received);
	else await store.appendAccepted(values.local);
	if (typeof process.send === "function") process.send({ kind: "unexpected-result" });
	await new Promise(() => undefined);
}

async function runRaceWriter() {
	const data = workerData;
	const candidate = await import(new URL("../../dist/src/live-journal.js", import.meta.url).href);
	if (typeof candidate.createNodeDurableLiveJournalStore !== "function") {
		throw new Error("missing Node live-journal factory");
	}
	const store = candidate.createNodeDurableLiveJournalStore({ primaryFilename: data.primaryFilename });
	const values = material("1");
	const input =
		data.role === "traced"
			? data.scenario === "cross-kind-race"
				? values.local
				: { ...values.local, vertexDigest: "6".repeat(64) }
			: data.scenario === "cross-kind-race"
				? values.received
				: values.local;
	if (data.role === "traced") {
		armPhase3a1bP4NodeTrace({ edge: "after-scope-read" });
		await store.appendAccepted(input);
	} else {
		const pending = store.appendAccepted(input);
		parentPort?.postMessage({ kind: "race-writer-attempting" });
		await pending;
	}
	parentPort?.postMessage({ kind: "unexpected-race-result", role: data.role });
}

function coordinateRace(raceTuple) {
	return new Promise((_resolve, reject) => {
		let competitor;
		let checkpoint;
		let reported = false;
		const fail = (error) => reject(error instanceof Error ? error : new Error(String(error)));
		const traced = new Worker(new URL(import.meta.url), {
			workerData: { primaryFilename, role: "traced", scenario: raceTuple.scenario },
		});
		traced.on("error", fail);
		traced.on("message", (message) => {
			if (message.kind === "worker-error") {
				fail(new Error(message.message));
				return;
			}
			if (message.kind === "trace" && typeof process.send === "function") process.send(message);
			if (message.kind !== "checkpoint" || competitor !== undefined) return;
			checkpoint = message;
			competitor = new Worker(new URL(import.meta.url), {
				workerData: { primaryFilename, role: "competitor", scenario: raceTuple.scenario },
			});
			competitor.on("error", fail);
			competitor.on("message", (competitorMessage) => {
				if (competitorMessage.kind === "worker-error") {
					fail(new Error(competitorMessage.message));
					return;
				}
				if (competitorMessage.kind !== "race-writer-attempting" || reported) return;
				reported = true;
				if (typeof process.send === "function") {
					process.send({ kind: "race-writers-invoked" });
					process.send(checkpoint);
				}
			});
		});
	});
}

const execution = isMainThread ? run() : runRaceWriter();
execution.catch((error) => {
	if (typeof process.send === "function") {
		process.send({ kind: "child-error", message: error instanceof Error ? error.message : String(error) });
	} else
		parentPort?.postMessage({ kind: "worker-error", message: error instanceof Error ? error.message : String(error) });
	process.exitCode = 1;
});
