import "fake-indexeddb/auto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { AHE_BOUNDED_READ_LIMITS, parseStorageObjectId } from "@ts-drp/storage";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { FutureJournal } from "./contract.js";
import { type Case, type Controls, exercise } from "./exercise.js";
import { addGenericToOldestClosure } from "./generic.js";
import { nodeMechanism } from "./node-mechanism.js";
import { createNodeDurableLiveJournalStore } from "../../../packages/storage-node/dist/src/live-journal.js";
import { author, digest, unhex } from "../cold-discovery/application.js";
import { nodeOwners } from "../cold-discovery/node-owners.js";
import { provisionLegacy } from "../rollback-data-observation/integrity.js";
import { nodePort } from "../rollback-data-observation/node-port.js";
import { setup } from "../rollback-data-observation/producer.js";
import { provePresentBytes, requireThat } from "../rollback-data-observation/proof.js";
import type { Bootstrap } from "../rollback-data-observation/types.js";

const [mode, identity, value] = process.argv.slice(2);
if (!mode || !identity || !value) throw new Error("EXACT_ENTRY_ARGUMENTS_REQUIRED");
const port = nodePort(identity);
if (mode === "setup") {
	mkdirSync(identity, { recursive: true });
	const owners = nodeOwners(identity);
	let report;
	try {
		report = await setup(identity, 3, owners, "creator-trusted-v1");
	} finally {
		await owners.close();
	}
	await port.writeFloor(report.floor);
	const integrity = await provisionLegacy(port, report.bootstrap, report.floor);
	const reopened = nodeOwners(identity);
	try {
		console.log(
			JSON.stringify({
				pid: process.pid,
				report,
				integrity,
				precondition: await provePresentBytes(report.bootstrap, report.floor, reopened),
			})
		);
	} finally {
		await reopened.close();
	}
} else {
	const b = JSON.parse(value) as Bootstrap,
		owners = nodeOwners(identity);
	const destination =
		mode.startsWith("baseline") || mode === "in-place" || mode === "populated-refusal"
			? owners.journal
			: createNodeDurableLiveJournalStore({ primaryFilename: join(identity, "recipient.sqlite") });
	let emptySource: ReturnType<typeof createNodeDurableLiveJournalStore> | undefined;
	let primaryFailure: unknown;
	try {
		const floor = await port.readFloor();
		requireThat(floor, "real host floor");
		const precondition = await provePresentBytes(b, floor, owners);
		const db = new DatabaseSync(join(identity, "journal.sqlite.drp-live-journal-v1.sqlite"));
		let control: Controls;
		try {
			const row = db.prepare("SELECT * FROM scopes WHERE object_id=? AND epoch=1").get(b.objectId);
			requireThat(row, "actual original signed scope");
			const entries = db
				.prepare(
					"SELECT vertex_digest,local_author,local_author_sequence FROM accepted_entries WHERE object_id=? AND epoch=1"
				)
				.all(b.objectId);
			const anchor = row.exact_anchor_preimage as Uint8Array,
				signature = row.detached_anchor_signature as Uint8Array;
			const anchorDigest = digest("ts-drp/epoch-anchor/v3", anchor);
			control = {
				scope: { objectId: b.objectId, epoch: 1, anchorDigest },
				genuinePopulated: Number(row.next_journal_sequence) === entries.length && entries.length > 0,
				originalSignatureValid: ed25519.verify(signature, unhex(anchorDigest), unhex(author), { zip215: false }),
				genuineEntryCount: entries.length,
			};
		} finally {
			db.close();
		}
		if (mode === "source-absent")
			emptySource = createNodeDurableLiveJournalStore({ primaryFilename: join(identity, "empty-source.sqlite") });
		const borrowed = emptySource ? { ...owners, journal: emptySource } : owners;
		if (mode === "generic-native") {
			const generic = await addGenericToOldestClosure(port),
				object = parseStorageObjectId(b.objectId);
			requireThat(object.ok, "actual native generic object");
			const result = await owners.ahe.acquireBoundedActiveRead({
				objectId: object.value,
				ancestorCount: 2,
				limits: AHE_BOUNDED_READ_LIMITS,
			});
			requireThat(result.ok && result.value.kind === "present", "actual generic full native union within fixed U");
			try {
				console.log(
					JSON.stringify({
						pid: process.pid,
						classification: "GENERIC_NATIVE_CONTROL",
						precondition,
						control,
						generic,
						fullUnionBytes: result.value.reader.blobs.reduce((sum, blob) => sum + blob.bytes.length, 0),
						publishedWholeObserverPressure: "HELD",
						nativeUnionOnly: true,
					})
				);
			} finally {
				await result.value.reader.release();
			}
		} else {
			const observed = await port.observe(() =>
				exercise(
					b,
					mode as Case,
					borrowed,
					destination as FutureJournal,
					port,
					control,
					nodeMechanism(identity, control.scope, destination as FutureJournal)
				)
			);
			console.log(JSON.stringify({ pid: process.pid, precondition, ...observed.value, native: observed.evidence }));
		}
	} catch (error) {
		primaryFailure = error;
	} finally {
		const outcomes = await Promise.allSettled([
			owners.close(),
			destination === owners.journal ? Promise.resolve() : destination.close(),
			emptySource?.close() ?? Promise.resolve(),
		]);
		if (outcomes.some((outcome) => outcome.status === "rejected"))
			primaryFailure ??= new AggregateError(outcomes, "owned native closure failed");
	}
	if (primaryFailure) throw primaryFailure;
}
