/* eslint-disable jsdoc/require-jsdoc -- Actual IDB prefix corruption and genuine transaction terminals; whole-row/key clone remains qualified. */
import type { InstallLiveJournalGenesisInput, LiveJournalScope } from "@ts-drp/live-journal";

import { type FutureJournal, MAX_ENVELOPE } from "./contract.js";
import type { NativeMechanism } from "./exercise.js";
import { createBrowserDurableLiveJournalStore } from "../../../packages/storage-browser/dist/src/live-journal.js";
import { database, done, request } from "../bounded-active-read/browser-owner.js";
import { requireThat } from "../rollback-data-observation/proof.js";
export function browserMechanism(
	identity: string,
	scope: LiveJournalScope,
	destination: FutureJournal
): NativeMechanism {
	const donorName = identity + "--drp-live-journal-v1",
		destinationName = identity + "--recipient--drp-live-journal-v1",
		prefix = [scope.objectId, scope.epoch, scope.anchorDigest];
	const originalEntry = async (): Promise<Record<string, unknown>> => {
		const db = await database(donorName);
		try {
			const tx = db.transaction("acceptedEntries", "readonly"),
				terminal = done(tx),
				row = await request(tx.objectStore("acceptedEntries").openCursor(IDBKeyRange.lowerBound(prefix)));
			await terminal;
			requireThat(
				row && Array.isArray(row.key) && row.key.slice(0, 3).every((key, i) => key === prefix[i]),
				"genuine donor entry"
			);
			return row.value as Record<string, unknown>;
		} finally {
			db.close();
		}
	};
	return {
		mutate: async (mode): Promise<void> => {
			const original = await originalEntry(),
				db = await database(destinationName);
			try {
				const tx = db.transaction(["scopes", "acceptedEntries"], "readwrite"),
					terminal = done(tx);
				if (mode === "nonzero-empty") {
					const row = await request(tx.objectStore("scopes").get(prefix));
					requireThat(row, "real empty installed row");
					tx.objectStore("scopes").put({ ...row, nextJournalSequence: 1 });
				} else tx.objectStore("acceptedEntries").put({ ...original, journalSequence: "nonnumeric-prefix" });
				await terminal;
			} finally {
				db.close();
			}
		},
		faultImport: async (mode, envelope: InstallLiveJournalGenesisInput): Promise<unknown> => {
			const transaction = Object.getOwnPropertyDescriptor(IDBDatabase.prototype, "transaction");
			requireThat(transaction, "genuine transaction method");
			const originals = new Map(
				["put", "add"].map((name) => [name, Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, name)])
			);
			const terminals: string[] = [];
			let wrote = false,
				committed = false,
				injected = false,
				concurrent: Promise<unknown> | undefined;
			const concurrentOwner =
					mode === "terminal-concurrent"
						? await createBrowserDurableLiveJournalStore({ primaryDatabaseName: identity + "--recipient" })
						: undefined,
				original = concurrentOwner ? await originalEntry() : undefined;
			Object.defineProperty(IDBDatabase.prototype, "transaction", {
				...transaction,
				value: function (this: IDBDatabase, ...args: unknown[]) {
					if (
						this.name === destinationName &&
						committed &&
						mode === "terminal-postcommit" &&
						args[1] === "readonly" &&
						!injected
					) {
						injected = true;
						throw new Error("explicit loss of genuine postcommit readonly dispatch");
					}
					const tx = Reflect.apply(transaction.value, this, args) as IDBTransaction;
					if (this.name === destinationName) {
						tx.addEventListener("abort", () => terminals.push("abort"));
						tx.addEventListener("complete", () => {
							terminals.push("complete:" + tx.mode);
							if (wrote && !committed && tx.mode === "readwrite") {
								committed = true;
								if (concurrentOwner && original) {
									injected = true;
									concurrent = concurrentOwner.appendAccepted({
										scope,
										sourceKind: "local-issued",
										vertexDigest: String(original.vertexDigest),
										author: String(original.localAuthor),
										authorSequence: Number(original.localAuthorSequence),
									});
								}
							}
						});
					}
					return tx;
				},
			});
			for (const [name, originalMethod] of originals) {
				requireThat(originalMethod, "genuine write method");
				Object.defineProperty(IDBObjectStore.prototype, name, {
					...originalMethod,
					value: function (this: IDBObjectStore, ...args: unknown[]) {
						const result = Reflect.apply(originalMethod.value, this, args) as IDBRequest;
						if (this.transaction.db.name === destinationName && this.name === "scopes") {
							wrote = true;
							if (mode === "terminal-precommit" && !injected) {
								injected = true;
								this.transaction.abort();
							}
						}
						return result;
					},
				});
			}
			let result;
			try {
				result = await destination.importHistoricalAnchor({ envelope, maxBytes: MAX_ENVELOPE });
				await concurrent;
			} finally {
				Object.defineProperty(IDBDatabase.prototype, "transaction", transaction);
				for (const [name, descriptor] of originals)
					if (descriptor) Object.defineProperty(IDBObjectStore.prototype, name, descriptor);
				await concurrentOwner?.close();
			}
			requireThat(
				!result.ok && result.kind === (mode === "terminal-precommit" ? "substrate-failure" : "outcome-unknown"),
				"genuine native terminal classification"
			);
			const db = await database(destinationName);
			let physical;
			try {
				const tx = db.transaction(["scopes", "acceptedEntries"], "readonly"),
					terminal = done(tx),
					row = await request(tx.objectStore("scopes").get(prefix)),
					entries = await request(
						tx
							.objectStore("acceptedEntries")
							.getAll(IDBKeyRange.bound([...prefix, 0], [...prefix, Number.MAX_SAFE_INTEGER]))
					);
				await terminal;
				physical = { nextSequence: row?.nextJournalSequence ?? null, entries: entries.length };
			} finally {
				db.close();
			}
			requireThat(
				mode === "terminal-precommit"
					? physical.nextSequence === null && physical.entries === 0
					: mode === "terminal-concurrent"
						? physical.nextSequence === 1 && physical.entries === 1
						: physical.nextSequence === 0 && physical.entries === 0,
				"actual closure state, never synthetic rows[]"
			);
			const reread = await destination.readSignedAnchorEnvelope({ scope, maxBytes: MAX_ENVELOPE });
			if (mode !== "terminal-precommit")
				requireThat(
					reread.ok && reread.kind === "present" && !result.ok && result.kind === "outcome-unknown",
					"envelope fact never clears original unknown debt"
				);
			return {
				result,
				physical,
				terminals,
				injected,
				concurrent: await concurrent,
				reread,
				originalUnknownDebtNotResolvedByEnvelopeReread: mode !== "terminal-precommit",
				idbNativeWholeRowAndKeyCloneQualified: true,
			};
		},
	};
}
