/* eslint-disable jsdoc/require-jsdoc -- Native corruption/interruption fixture, never synthesized journal rows or future behavior. */
import type { InstallLiveJournalGenesisInput, LiveJournalScope } from "@ts-drp/live-journal";
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue, StatementSync } from "node:sqlite";

import type { FutureJournal } from "./contract.js";
import { MAX_ENVELOPE } from "./contract.js";
import type { Case, NativeMechanism } from "./exercise.js";
import { createNodeDurableLiveJournalStore } from "../../../packages/storage-node/dist/src/live-journal.js";

export function nodeMechanism(identity: string, scope: LiveJournalScope, destination: FutureJournal): NativeMechanism {
	const donorFilename = join(identity, "journal.sqlite.drp-live-journal-v1.sqlite"),
		destinationFilename = join(identity, "recipient.sqlite.drp-live-journal-v1.sqlite");
	const use = <T>(filename: string, call: (db: DatabaseSync) => T): T => {
		const db = new DatabaseSync(filename);
		try {
			return call(db);
		} finally {
			db.close();
		}
	};
	const key = [scope.objectId, scope.epoch, scope.anchorDigest] as const;
	return {
		mutate: (mode: Case): Promise<void> => {
			if (mode.startsWith("physical-")) {
				use(donorFilename, (db) => {
					const changes: Record<string, readonly [string, unknown]> = {
						"physical-signature": ["detached_anchor_signature", new Uint8Array(65)],
						"physical-parameters": ["exact_parameters_carrier", new Uint8Array(65537)],
						"physical-digest": ["parameters_digest", "e".repeat(65537)],
						"physical-next": ["next_journal_sequence", 1.5],
					};
					const change = changes[mode];
					assert.ok(change);
					db.prepare(`UPDATE scopes SET ${change[0]}=? WHERE object_id=? AND epoch=? AND anchor_digest=?`).run(
						change[1] as SQLInputValue,
						...key
					);
				});
			} else
				use(destinationFilename, (db) => {
					if (mode === "nonzero-empty") {
						db.prepare(
							"UPDATE scopes SET next_journal_sequence=1 WHERE object_id=? AND epoch=? AND anchor_digest=?"
						).run(...key);
						return;
					}
					const actual = use(donorFilename, (source) =>
						source
							.prepare("SELECT * FROM accepted_entries WHERE object_id=? AND epoch=? AND anchor_digest=? LIMIT 1")
							.get(...key)
					);
					assert.ok(actual);
					// Genuine producer-issued reference row, corrupted physical sequence key only. No fabricated positive.
					db.prepare(
						"INSERT INTO accepted_entries(object_id,epoch,anchor_digest,journal_sequence,source_kind,vertex_digest,received_preimage,received_signature,local_author,local_author_sequence) VALUES(?,?,?,?,?,?,?,?,?,?)"
					).run(
						...key,
						"nonnumeric-prefix",
						actual.source_kind,
						actual.vertex_digest,
						actual.received_preimage,
						actual.received_signature,
						actual.local_author,
						actual.local_author_sequence
					);
				});
			return Promise.resolve();
		},
		faultImport: async (mode, envelope: InstallLiveJournalGenesisInput): Promise<unknown> => {
			const interrupt = (stage: string): never => {
				writeSync(1, JSON.stringify({ stage, originalClosureDebt: "held-not-resolved-by-later-envelope-fact" }) + "\n");
				process.kill(process.pid, "SIGKILL");
				throw new Error("SIGKILL_DID_NOT_TERMINATE");
			};
			if (mode === "crash-after-acquire") interrupt("genuine-source-acquired-and-authenticated-before-import");
			const exec = DatabaseSync.prototype.exec,
				prepare = DatabaseSync.prototype.prepare,
				run = Object.getOwnPropertyDescriptor(StatementSync.prototype, "run");
			assert.ok(run);
			const sqls = new WeakMap<StatementSync, string>(),
				terminals: string[] = [];
			let wrote = false,
				committed = false,
				injected = false,
				concurrent: Promise<unknown> | undefined;
			const concurrentOwner =
				mode === "terminal-concurrent"
					? createNodeDurableLiveJournalStore({ primaryFilename: join(identity, "recipient.sqlite") })
					: undefined;
			const actual =
				mode === "terminal-concurrent"
					? use(donorFilename, (db) =>
							db
								.prepare("SELECT * FROM accepted_entries WHERE object_id=? AND epoch=? AND anchor_digest=? LIMIT 1")
								.get(...key)
						)
					: undefined;
			const before = (sql: string): void => {
				if (/INSERT\s+INTO\s+(?:main\.)?scopes/iu.test(sql)) {
					wrote = true;
					if (mode === "crash-during-write") interrupt("actual-write-transaction-admitted-before-insertion");
					if (mode === "terminal-precommit" && !injected) {
						injected = true;
						throw new Error("explicit precommit dispatch failure");
					}
				}
				if (committed && mode === "terminal-postcommit" && /^BEGIN/iu.test(sql) && !injected) {
					injected = true;
					throw new Error("explicit loss of actual postcommit observation dispatch");
				}
			};
			DatabaseSync.prototype.prepare = function (sql): StatementSync {
				const statement = Reflect.apply(prepare, this, [sql]);
				sqls.set(statement, sql);
				return statement;
			};
			DatabaseSync.prototype.exec = function (sql): void {
				before(sql);
				const result = Reflect.apply(exec, this, [sql]);
				if (/^(BEGIN|COMMIT|ROLLBACK)/u.test(sql)) terminals.push(sql);
				if (wrote && !committed && sql === "COMMIT") {
					committed = true;
					if (mode === "crash-after-commit") interrupt("actual-native-COMMIT-returned-before-confirmation");
					if (concurrentOwner && actual) {
						injected = true;
						concurrent = concurrentOwner.appendAccepted({
							scope,
							sourceKind: "local-issued",
							vertexDigest: String(actual.vertex_digest),
							author: String(actual.local_author),
							authorSequence: Number(actual.local_author_sequence),
						});
					}
				}
				return result;
			};
			Object.defineProperty(StatementSync.prototype, "run", {
				...run,
				value: function (this: StatementSync, ...args: unknown[]) {
					before(sqls.get(this) ?? "");
					return Reflect.apply(run.value, this, args);
				},
			});
			let result;
			try {
				result = await destination.importHistoricalAnchor({ envelope, maxBytes: MAX_ENVELOPE });
				if (mode === "crash-after-confirmation") {
					assert.ok(result.ok);
					interrupt("actual-import-complete-zero-confirmed-before-later-protection");
				}
				await concurrent;
			} finally {
				DatabaseSync.prototype.exec = exec;
				DatabaseSync.prototype.prepare = prepare;
				Object.defineProperty(StatementSync.prototype, "run", run);
				await concurrentOwner?.close();
			}
			const physical = use(destinationFilename, (db) => ({
				scopes: db
					.prepare("SELECT next_journal_sequence AS next FROM scopes WHERE object_id=? AND epoch=? AND anchor_digest=?")
					.all(...key),
				entries: db
					.prepare(
						"SELECT journal_sequence AS sequence,vertex_digest AS digest FROM accepted_entries WHERE object_id=? AND epoch=? AND anchor_digest=?"
					)
					.all(...key),
			}));
			if (mode === "terminal-precommit") {
				assert.equal(result.ok, false);
				if (!result.ok) assert.equal(result.kind, "substrate-failure");
				assert.equal(physical.scopes.length, 0);
				assert.equal(physical.entries.length, 0);
			} else {
				assert.equal(result.ok, false);
				if (!result.ok) assert.equal(result.kind, "outcome-unknown");
				assert.equal(physical.scopes.length, 1);
			}
			if (mode === "terminal-concurrent") {
				assert.equal(physical.scopes[0]?.next, 1);
				assert.equal(physical.entries.length, 1);
				assert.ok(injected);
			}
			const reread = await destination.readSignedAnchorEnvelope({ scope, maxBytes: MAX_ENVELOPE });
			if (mode !== "terminal-precommit") {
				assert.ok(reread.ok);
				assert.equal(reread.kind, "present");
				assert.equal(result.ok, false);
				if (!result.ok) assert.equal(result.kind, "outcome-unknown");
			}
			return {
				result,
				physical,
				terminals,
				injected,
				concurrent: await concurrent,
				reread,
				originalUnknownDebtNotResolvedByEnvelopeReread: mode !== "terminal-precommit",
			};
		},
	};
}
