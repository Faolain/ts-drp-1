/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/explicit-function-return-type -- Exact fixture-selected positions follow actual native prerequisites; browser observation union inference is retained. */
import { ed25519 } from "@noble/curves/ed25519.js";

import { browserMechanism } from "./browser-mechanism.js";
import type { FutureJournal } from "./contract.js";
import { type Case, type Controls, exercise } from "./exercise.js";
import { decodeCanonical, encodeCanonical } from "../../../packages/canonical/dist/src/index.js";
import {
	captureJournalRetirementDrainPlan,
	journalRetirementFrameDigest,
} from "../../../packages/live-journal/src/index.js";
import { createBrowserDurableLiveJournalStore } from "../../../packages/storage-browser/dist/src/live-journal.js";
import { openBrowserSealVoteStore } from "../../../packages/storage-browser/dist/src/seal-vote.js";
import { database, done, request } from "../bounded-active-read/browser-owner.js";
import { author, digest, hex, unhex } from "../cold-discovery/application.js";
import { browserOwners } from "../cold-discovery/browser-owners.js";
import { anchorMaterial } from "../journal-anchor-read/material.js";
import { browserPort } from "../rollback-data-observation/browser-port.js";
import { provisionLegacy } from "../rollback-data-observation/integrity.js";
import { setup } from "../rollback-data-observation/producer.js";
import { provePresentBytes, requireThat } from "../rollback-data-observation/proof.js";
import type { Bootstrap } from "../rollback-data-observation/types.js";
const realm = Math.random();

// Mechanical native CAS coverage: these existing anchorMaterial signatures are
// storage fixtures, not protocol authorization. signedExercise covers the latter.
async function mixedHeaderJournal(identity: string, expected?: { source: string; partial: string }) {
	const store = await createBrowserDurableLiveJournalStore({ primaryDatabaseName: identity });
	const materials = Array.from({ length: 20 }, (_, epoch) => anchorMaterial(epoch));
	const selector = { objectId: materials[0]!.scope.objectId };
	const must = <T>(result: { ok: true; value: T } | { ok: false }): T => {
		requireThat(result.ok, "actual journal lifecycle result");
		return (result as { ok: true; value: T }).value;
	};
	const exact = (value: unknown) => hex(encodeCanonical(value));
	try {
		if (expected) {
			const reopened = must(await store.readRetirementImage(selector));
			requireThat(exact(reopened) === expected.partial, "fresh realm exact partial image/control");
			requireThat(exact(reopened.drainSource) === expected.source, "fresh realm exact original full PRE source");
			const last = must(await store.acquireRetirementControl(selector));
			try {
				must(await last.drainBatch());
			} finally {
				await last.release();
			}
			const complete = must(await store.readRetirementImage(selector));
			requireThat(
				complete.control?.drain?.cursor === 17 && complete.control.drain.batches === 2,
				"bounded row plus sixteen-header drain completed"
			);
			requireThat(complete.image.scopeCount === 4 && complete.image.rowCount === 0, "exact residual header inventory");
			requireThat(exact(complete.drainSource) === expected.source, "full original source remains after completion");
			const missing = await store.readSignedAnchorEnvelope({ scope: materials[2]!.scope, maxBytes: 262144 });
			requireThat(missing.ok && missing.kind === "missing", "removed header missing");
			for (const epoch of [0, 1, 18, 19]) {
				const kept = await store.readSignedAnchorEnvelope({ scope: materials[epoch]!.scope, maxBytes: 262144 });
				requireThat(kept.ok && kept.kind === "present", "protected or prefix header retained");
			}
			const restore = await store.installEpochAnchor(materials[2]!.install);
			requireThat(!restore.ok && restore.kind === "retirement-fenced", "permanent floor prevents header recreation");
			const appended = await store.appendAccepted({
				scope: materials[19]!.scope,
				sourceKind: "local-issued",
				author: "creator",
				authorSequence: 1,
				vertexDigest: "b".repeat(64),
			});
			requireThat(appended.ok, "continued actual native append");
			const advanced = must(await store.readRetirementImage(selector));
			requireThat(
				advanced.control?.drain === null && advanced.drainSource === undefined,
				"genuine mutation clears only completed plan"
			);
			requireThat(
				exact(advanced.control?.completed) === exact(reopened.control?.completed),
				"permanent floor unchanged"
			);
			return {
				realm,
				phase: "complete",
				cursor: complete.control.drain.cursor,
				image: complete.image,
				advancedImage: advanced.image,
				sourceBytes: unhex(expected.source).length,
			};
		}
		requireThat((await store.installGenesis(materials[0]!.install)).ok, "native genesis");
		for (const material of materials.slice(1))
			requireThat((await store.installEpochAnchor(material.install)).ok, "native scope");
		requireThat(
			(
				await store.appendAccepted({
					scope: materials[1]!.scope,
					sourceKind: "local-issued",
					author: "creator",
					authorSequence: 0,
					vertexDigest: "a".repeat(64),
				})
			).ok,
			"native nonempty prefix"
		);
		const prepare = must(await store.acquireRetirementControl(selector));
		try {
			must(
				await prepare.prepareFence({
					throughEpoch: 18,
					protectedScopes: [materials[18]!.scope],
					decisionDigest: "e".repeat(64),
					sourceProofDigest: "f".repeat(64),
				})
			);
		} finally {
			await prepare.release();
		}
		const commit = must(await store.acquireRetirementControl(selector));
		try {
			must(await commit.commitPrepared());
		} finally {
			await commit.release();
		}
		const source = must(await store.readRetirementImage(selector));
		requireThat(source.control !== null, "native permanent floor");
		const rows = source.canonicalRows.flatMap((bytes) => {
			const [table, , row] = decodeCanonical(bytes) as [string, unknown, Record<string, unknown>];
			return table === "acceptedEntries"
				? [
						{
							journalSequence: row.journalSequence as number,
							vertexDigest: row.vertexDigest as string,
							author: row.localAuthor as string,
							authorSequence: row.localAuthorSequence as number,
							nativeFrameDigest: journalRetirementFrameDigest(bytes),
						},
					]
				: [];
		});
		const headers = source.canonicalRows.flatMap((bytes) => {
			const [table, key] = decodeCanonical(bytes) as [string, unknown[]];
			return table === "scopes" && typeof key[1] === "number" && key[1] >= 2 && key[1] <= 17
				? [{ scope: materials[key[1]]!.scope, exactCanonicalNativeFrameBytes: bytes }]
				: [];
		});
		const protectedHeaderScopes = [
			materials[0]!.scope,
			materials[18]!.scope,
			materials[19]!.scope,
			...Array.from({ length: 8 }, (_, index) => ({ ...materials[18]!.scope, objectId: `foreign-source-${index}` })),
		];
		const plan = {
			baseControl: source.control!,
			sourceImage: source.image,
			prefixes: [{ scope: materials[1]!.scope, highWatermark: 1, rows }],
			retiredEmptyHeaders: headers,
			protectedHeaderScopes,
		};
		requireThat(
			captureJournalRetirementDrainPlan(plan).protectedHeaderScopes?.length === 11,
			"full foreign and larger-than-seven union"
		);
		let alteredRefused = false;
		try {
			captureJournalRetirementDrainPlan({
				...plan,
				retiredEmptyHeaders: [
					{ ...headers[0]!, exactCanonicalNativeFrameBytes: headers[1]!.exactCanonicalNativeFrameBytes },
				],
			});
		} catch {
			alteredRefused = true;
		}
		requireThat(alteredRefused, "altered addressed header refuses before effects");
		const stale = must(await store.acquireRetirementControl(selector));
		try {
			const refusal = await stale.beginDrain({
				...plan,
				sourceImage: { ...source.image, imageDigest: "0".repeat(64) },
			});
			requireThat(
				!refusal.ok && refusal.kind === "retirement-transition",
				"whole source currency refuses before effects"
			);
		} finally {
			await stale.release();
		}
		requireThat(
			exact(must(await store.readRetirementImage(selector))) === exact(source),
			"source refusal leaves exact OLD"
		);
		const begin = must(await store.acquireRetirementControl(selector));
		try {
			must(await begin.beginDrain(plan));
		} finally {
			await begin.release();
		}
		const entered = must(await store.readRetirementImage(selector));
		const deletion = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "delete")!;
		let injected = false,
			joinedAbort = false;
		Object.defineProperty(IDBObjectStore.prototype, "delete", {
			...deletion,
			value: function (this: IDBObjectStore, key: IDBValidKey) {
				const result = Reflect.apply(deletion.value, this, [key]);
				if (
					!injected &&
					this.transaction.db.name === identity + "--drp-live-journal-v1" &&
					this.name === "scopes" &&
					Array.isArray(key) &&
					key[1] === 3
				) {
					injected = true;
					this.transaction.addEventListener(
						"abort",
						() => {
							joinedAbort = true;
						},
						{ once: true }
					);
					this.transaction.abort();
				}
				return result;
			},
		});
		try {
			const aborted = must(await store.acquireRetirementControl(selector));
			try {
				const refusal = await aborted.drainBatch();
				requireThat(!refusal.ok && refusal.kind === "substrate-failure", "native aborted drain classified OLD");
			} finally {
				await aborted.release();
			}
		} finally {
			Object.defineProperty(IDBObjectStore.prototype, "delete", deletion);
		}
		requireThat(
			injected && joinedAbort && exact(must(await store.readRetirementImage(selector))) === exact(entered),
			"genuine abort joined and exact whole OLD retained"
		);
		const first = must(await store.acquireRetirementControl(selector));
		try {
			must(await first.drainBatch());
		} finally {
			await first.release();
		}
		const partial = must(await store.readRetirementImage(selector));
		requireThat(partial.control?.drain?.cursor === 16 && partial.control.drain.batches === 1, "bounded first batch");
		requireThat(partial.image.scopeCount === 5 && partial.image.rowCount === 0, "exact partial native inventory");
		const original = { control: source.control, image: source.image, canonicalRows: source.canonicalRows };
		requireThat(exact(partial.drainSource) === exact(original), "deleted native bytes reconstructed exactly");
		const blocked = await store.appendAccepted({
			scope: materials[19]!.scope,
			sourceKind: "local-issued",
			author: "creator",
			authorSequence: 1,
			vertexDigest: "b".repeat(64),
		});
		requireThat(!blocked.ok && blocked.kind === "retirement-fenced", "partial drain blocks incompatible append");
		requireThat(
			exact(must(await store.readRetirementImage(selector))) === exact(partial),
			"blocked append leaves exact partial OLD"
		);
		return {
			realm,
			phase: "partial",
			source: exact(original),
			partial: exact(partial),
			joinedAbort,
			protectedScopes: protectedHeaderScopes.length,
			alteredRefused,
			currencyRefused: true,
		};
	} finally {
		await store.close();
	}
}
Object.assign(globalThis, {
	signedMixedHeaderJournal: mixedHeaderJournal,
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
		const signing = await openBrowserSealVoteStore({ databaseName: identity + "--seal-2" });
		let integrity;
		try {
			integrity = await provisionLegacy(port, report.bootstrap, report.floor, {
				store: signing.store,
				incarnation: signing.observation.incarnation,
			});
		} finally {
			await signing.close();
		}
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
