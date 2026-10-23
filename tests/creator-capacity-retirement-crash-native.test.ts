/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native probe inference. */
import { decodeCanonical } from "@ts-drp/canonical";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { expect, it } from "vitest";

import { creatorDeliveryRoom, type Profile } from "./fixtures/track-aa/creator-delivery-room.js";
import { closeFixtures, directories, required } from "./fixtures/track-m/room-retention-fixture.js";

// Run mutate in a disposable Vitest fork: this process dies by SIGKILL immediately
// AFTER the real SQLite COMMIT returns. Run recover against that same directory in
// another process. No native write, classifier, source proof or transaction is mocked.
function nativeRetirement(directory: string) {
	const issuanceFile = required(readdirSync(directory).find((name) => name.endsWith(".drp-issuance-v1.sqlite")));
	const journalFile = required(readdirSync(directory).find((name) => name.endsWith(".drp-live-journal-v1.sqlite")));
	const issuance = new DatabaseSync(join(directory, issuanceFile), { readOnly: true });
	const journal = new DatabaseSync(join(directory, journalFile), { readOnly: true });
	try {
		const control = required(issuance.prepare("SELECT record FROM retirement_controls").get());
		return {
			control: decodeCanonical(control.record as Uint8Array) as Record<string, any>,
			issued: issuance
				.prepare("SELECT author_sequence, canonical_preimage FROM issued_records ORDER BY author_sequence")
				.all()
				.map((row) => ({
					sequence: row.author_sequence,
					epoch: (decodeCanonical(row.canonical_preimage as Uint8Array) as any).epoch,
				})),
			journal: journal
				.prepare("SELECT epoch, COUNT(*) AS count FROM accepted_entries GROUP BY epoch ORDER BY epoch")
				.all(),
		};
	} finally {
		issuance.close();
		journal.close();
	}
}

it.runIf(process.env.RUN_CREATOR_CAPACITY_CRASH === "1")(
	"native retirement survives process death at its real committed boundary",
	async () => {
		const directory = required(process.env.CREATOR_CAPACITY_CRASH_DIRECTORY);
		const edge = required(process.env.CREATOR_CAPACITY_CRASH_EDGE);
		const mode = required(process.env.CREATOR_CAPACITY_CRASH_MODE);
		const profile = (process.env.CREATOR_CAPACITY_CRASH_PROFILE ?? "settlement") as Profile;
		const reportFile = join(directory, "death.json"),
			projectionFile = join(directory, "projection.json");
		const prepare = DatabaseSync.prototype.prepare,
			run = StatementSync.prototype.run,
			exec = DatabaseSync.prototype.exec;
		const statements = new WeakMap<StatementSync, { database: DatabaseSync; sql: string }>();
		const deleted = new WeakSet<DatabaseSync>();
		const prepared = new WeakMap<DatabaseSync, Record<string, any>>();
		const recovered = new WeakMap<DatabaseSync, Record<string, any>>(),
			recoveryControls: Record<string, any>[] = [];
		let journalCommitted = false,
			armed = false;
		if (mode === "mutate" || mode === "recover") {
			DatabaseSync.prototype.prepare = function (sql: string) {
				const statement = prepare.call(this, sql);
				statements.set(statement, { database: this, sql });
				return statement;
			};
			StatementSync.prototype.run = function (...args: any[]) {
				const result = run.apply(this, args),
					source = statements.get(this);
				if (
					mode === "recover" &&
					source?.sql === "UPDATE retirement_controls SET record=? WHERE object_id=?" &&
					args[0] instanceof Uint8Array
				) {
					const control = decodeCanonical(args[0]) as Record<string, any>;
					if (control.kind === "v3-issuance-retirement-control-1") recovered.set(source.database, control);
				}
				if (armed && source !== undefined) {
					if (source.sql.startsWith("DELETE FROM accepted_entries ") && Number(result.changes) > 0)
						deleted.add(source.database);
					if (
						journalCommitted &&
						source.sql === "UPDATE retirement_controls SET record=? WHERE object_id=?" &&
						args[0] instanceof Uint8Array
					) {
						const control = decodeCanonical(args[0]) as Record<string, any>;
						if (control.kind === "v3-issuance-retirement-control-1" && control.active !== null)
							prepared.set(source.database, control);
					}
				}
				return result;
			};
			DatabaseSync.prototype.exec = function (sql: string) {
				const result = exec.call(this, sql);
				if (sql === "ROLLBACK") {
					deleted.delete(this);
					prepared.delete(this);
					recovered.delete(this);
				}
				if (sql === "COMMIT" && mode === "recover") {
					const control = recovered.get(this);
					recovered.delete(this);
					if (control !== undefined) recoveryControls.push(control);
				}
				if (sql === "COMMIT" && armed) {
					const journalEdge = deleted.has(this),
						issuance = prepared.get(this);
					if (journalEdge) journalCommitted = true;
					deleted.delete(this);
					prepared.delete(this);
					if ((edge === "journal" && journalEdge) || (edge === "issuance" && issuance !== undefined)) {
						writeFileSync(
							reportFile,
							JSON.stringify({
								edge,
								pid: process.pid,
								signal: "SIGKILL",
								journalCommitted,
								...(issuance === undefined ? {} : { prepared: issuance }),
								native: nativeRetirement(directory),
							})
						);
						process.kill(process.pid, "SIGKILL");
						throw Error("SIGKILL_DID_NOT_TERMINATE");
					}
				}
				return result;
			};
		}
		try {
			const fixture = await creatorDeliveryRoom({ profile, directory });
			const before = mode === "recover" ? JSON.parse(readFileSync(reportFile, "utf8")) : undefined;
			const creator = await fixture.open(0, mode === "recover" ? { reopen: true } : {});
			const state = () =>
				Buffer.from(required(fixture.application.migration).canonicalStateBytes(creator.room.projection())).toString(
					"hex"
				);
			if (mode === "mutate") {
				for (let epoch = 0; epoch < 4; epoch++) {
					for (let index = 0; index < 16; index++)
						await creator.room.issue({ action: "placeBlock", id: `slot-${index}`, kind: "stone", x: index, y: epoch });
					writeFileSync(projectionFile, JSON.stringify({ epoch: epoch + 1, state: state() }));
					armed = epoch === 3;
					expect((await creator.room.sealEpoch()).ok).toBe(true);
					await creator.room.adoptCreatorSuccessor();
					await creator.room.maintainRecoveryPool();
				}
				throw Error(`NATIVE_COMMITTED_EDGE_NOT_REACHED:${edge}`);
			}
			expect(before.journalCommitted).toBe(true);
			expect(state()).toBe(JSON.parse(readFileSync(projectionFile, "utf8")).state);
			if (edge === "issuance") expect(before.native.control.active).toEqual(before.prepared.active);
			for (let index = 0; index < 3; index++) await creator.room.maintainRecoveryPool();
			const after = nativeRetirement(directory),
				completed = after.control.completed;
			expect(after.control.active).toBeNull();
			const oldPreparation = before.native.control.active?.preparation ?? before.native.control.completed;
			if (edge === "issuance") {
				const completedOriginal = recoveryControls.findIndex(
					(control) => control.active === null && JSON.stringify(control.completed) === JSON.stringify(oldPreparation)
				);
				expect(
					completedOriginal,
					"the exact frozen old P commits before any fresh same-cut intent"
				).toBeGreaterThanOrEqual(0);
				expect(
					recoveryControls
						.slice(0, completedOriginal)
						.every(
							(control) =>
								control.active === null || JSON.stringify(control.active.preparation) === JSON.stringify(oldPreparation)
						)
				).toBe(true);
			}
			expect(
				recoveryControls.some(
					(control) =>
						control.completed?.throughEpoch === oldPreparation.throughEpoch &&
						control.completed.sourceProofDigest !== oldPreparation.sourceProofDigest
				)
			).toBe(true);
			expect(completed.throughEpoch).toBe(before.native.control.completed.throughEpoch);
			const journalEpochs = new Set(after.journal.map((row) => row.epoch));
			const eligible = after.issued.filter(
				(row) => row.epoch <= completed.throughEpoch - 2 && !journalEpochs.has(row.epoch)
			);
			if (profile === "shipped") expect(eligible.length).toBeGreaterThan(0);
			for (const row of eligible)
				expect(completed.protectedRecords.some((hole: any) => hole.authorSequence === row.sequence)).toBe(false);
			expect(state()).toBe(JSON.parse(readFileSync(projectionFile, "utf8")).state);
			await creator.room.issue({ action: "placeBlock", id: "continued", kind: "stone", x: 0, y: 99 });
			writeFileSync(
				join(directory, "recovered.json"),
				JSON.stringify({ edge, before, after, recoveryControls, continued: true })
			);
			const labels = (p: any) => ({
				throughEpoch: p.throughEpoch,
				decisionDigest: p.decisionDigest,
				sourceProofDigest: p.sourceProofDigest,
				protected: p.protectedRecords.length,
			});
			console.info(
				`CREATOR_CAPACITY_CRASH ${JSON.stringify({
					edge,
					profile,
					priorIntent: labels(oldPreparation),
					completed: labels(completed),
					committedIntents: recoveryControls
						.filter((control) => control.active === null)
						.map((control) => labels(control.completed)),
					journal: after.journal,
					eligible: eligible.length,
					continued: true,
				})}`
			);
		} finally {
			DatabaseSync.prototype.prepare = prepare;
			StatementSync.prototype.run = run;
			DatabaseSync.prototype.exec = exec;
			// External evidence directory survives the probe; all ordinary handles join.
			directories.delete(directory);
			expect(await closeFixtures()).toEqual([]);
		}
	},
	180_000
);
