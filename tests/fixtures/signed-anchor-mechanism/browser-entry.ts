import { ed25519 } from "@noble/curves/ed25519.js";

import { browserMechanism } from "./browser-mechanism.js";
import type { FutureJournal } from "./contract.js";
import { type Case, type Controls, exercise } from "./exercise.js";
import { createBrowserDurableLiveJournalStore } from "../../../packages/storage-browser/dist/src/live-journal.js";
import { database, done, request } from "../bounded-active-read/browser-owner.js";
import { author, digest, unhex } from "../cold-discovery/application.js";
import { browserOwners } from "../cold-discovery/browser-owners.js";
import { browserPort } from "../rollback-data-observation/browser-port.js";
import { provisionLegacy } from "../rollback-data-observation/integrity.js";
import { setup } from "../rollback-data-observation/producer.js";
import { provePresentBytes, requireThat } from "../rollback-data-observation/proof.js";
import type { Bootstrap } from "../rollback-data-observation/types.js";
const realm = Math.random();
Object.assign(globalThis, {
	signedSetup: async (identity: string) => {
		const owners = await browserOwners(identity);
		let report;
		try {
			report = await setup(identity, 3, owners, "creator-trusted-v1");
		} finally {
			await owners.close();
		}
		const port = browserPort(identity);
		await port.writeFloor(report.floor);
		const integrity = await provisionLegacy(port, report.bootstrap, report.floor);
		const reopened = await browserOwners(identity);
		try {
			return {
				realm,
				report,
				integrity,
				precondition: await provePresentBytes(report.bootstrap, report.floor, reopened),
			};
		} finally {
			await reopened.close();
		}
	},
	signedExercise: async (b: Bootstrap, mode: Case) => {
		const owners = await browserOwners(b.identity),
			port = browserPort(b.identity);
		const destination =
			mode === "baseline" || mode === "in-place" || mode === "populated-refusal"
				? owners.journal
				: await createBrowserDurableLiveJournalStore({ primaryDatabaseName: b.identity + "--recipient" });
		let answer: unknown, primaryFailure: unknown;
		try {
			const floor = await port.readFloor();
			requireThat(floor, "actual host floor");
			const precondition = await provePresentBytes(b, floor, owners);
			const db = await database(b.identity + "--drp-live-journal-v1");
			let control: Controls;
			try {
				const tx = db.transaction(["scopes", "acceptedEntries"], "readonly"),
					terminal = done(tx);
				const scope = (await request(tx.objectStore("scopes").getAll())).find(
					(row) => row.objectId === b.objectId && row.epoch === 1
				);
				requireThat(scope, "original native signed source row");
				const entries = await request(
					tx
						.objectStore("acceptedEntries")
						.getAll(
							IDBKeyRange.bound(
								[b.objectId, 1, scope.anchorDigest, 0],
								[b.objectId, 1, scope.anchorDigest, Number.MAX_SAFE_INTEGER]
							)
						)
				);
				await terminal;
				const anchorDigest = digest("ts-drp/epoch-anchor/v3", scope.exactCanonicalAnchorPreimageBytes as Uint8Array);
				control = {
					scope: { objectId: b.objectId, epoch: 1, anchorDigest },
					genuinePopulated: scope.nextJournalSequence === entries.length && entries.length > 0,
					originalSignatureValid: ed25519.verify(
						scope.detachedAnchorSignature as Uint8Array,
						unhex(anchorDigest),
						unhex(author),
						{ zip215: false }
					),
					genuineEntryCount: entries.length,
				};
			} finally {
				db.close();
			}
			const observed = await port.observe(() =>
				exercise(
					b,
					mode,
					owners,
					destination as FutureJournal,
					port,
					control,
					browserMechanism(b.identity, control.scope, destination as FutureJournal)
				)
			);
			answer = { realm, precondition, ...observed.value, native: observed.evidence };
		} catch (error) {
			primaryFailure = error;
		} finally {
			const outcomes = await Promise.allSettled([
				owners.close(),
				destination === owners.journal ? Promise.resolve() : destination.close(),
			]);
			if (outcomes.some((outcome) => outcome.status === "rejected"))
				primaryFailure ??= new AggregateError(outcomes, "owned browser closure failed");
		}
		if (primaryFailure) throw primaryFailure;
		return answer;
	},
});
