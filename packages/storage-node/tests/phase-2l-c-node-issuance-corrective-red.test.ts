import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
	derivedFilename,
	loadPhase2lCNodeModule,
	phase2lCCommit,
	PHASE_2L_C_DDL,
	PHASE_2L_C_SCOPE,
} from "./fixtures/phase-2l-c-node-issuance-contract.js";
import type { DurableIssuanceStore } from "../../issuance-store/dist/src/index.js";

const temporaryDirectories: string[] = [];

/**
 * Allocates one isolated primary filename.
 * @param label - Human-readable fixture label.
 * @returns An absent primary filename beside the derived issuance database.
 */
function primary(label: string): string {
	const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `phase-2l-c-corrective-${label}-`));
	temporaryDirectories.push(directory);
	return path.join(directory, "primary.sqlite");
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
});

/**
 * Copies native null-prototype SQLite rows into ordinary assertion records.
 * @param rows - Native rows returned by a result-bearing statement.
 * @returns Ordinary records with the same own fields.
 */
function plainRows(rows: readonly Record<string, unknown>[]): readonly Record<string, unknown>[] {
	return rows.map((row) => ({ ...row }));
}

/**
 * Creates the admitted exact schema, then seeds one durable issued/outbox pair.
 * @param primaryFilename - Opaque primary filename used by the public factory.
 * @param authorSequence - Ordinal stored by both durable child rows.
 * @param publishState - Seeded durable publication state.
 * @param lineage - Optional raw lineage authority.
 */
async function seedPair(
	primaryFilename: string,
	authorSequence: number,
	publishState: "pending" | "published",
	lineage: { readonly exhausted: 0 | 1; readonly next: number } | null
): Promise<void> {
	const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
	const admitted = createNodeDurableIssuanceStore({ primaryFilename });
	await admitted.close();
	const database = new DatabaseSync(derivedFilename(primaryFilename));
	try {
		const candidate = phase2lCCommit(authorSequence);
		database.exec("BEGIN IMMEDIATE");
		database
			.prepare(
				"INSERT INTO issued_records(object_id,author,author_sequence,canonical_preimage,digest,signature) VALUES(?,?,?,?,?,?)"
			)
			.run(
				PHASE_2L_C_SCOPE.objectId,
				PHASE_2L_C_SCOPE.author,
				authorSequence,
				candidate.envelope.canonicalPreimageBytes,
				candidate.envelope.digest,
				candidate.envelope.signature
			);
		database
			.prepare("INSERT INTO issuance_outbox(object_id,author,author_sequence,digest,publish_state) VALUES(?,?,?,?,?)")
			.run(PHASE_2L_C_SCOPE.objectId, PHASE_2L_C_SCOPE.author, authorSequence, candidate.envelope.digest, publishState);
		if (lineage !== null) {
			database
				.prepare("INSERT INTO lineages(object_id,author,next,exhausted) VALUES(?,?,?,?)")
				.run(PHASE_2L_C_SCOPE.objectId, PHASE_2L_C_SCOPE.author, lineage.next, lineage.exhausted);
		}
		database.exec("COMMIT");
	} finally {
		database.close();
	}
}

/**
 * Opens one seeded issuance capability.
 * @param primaryFilename - Opaque primary filename used by the public factory.
 * @returns The admitted five-method issuance capability.
 */
async function openStore(primaryFilename: string): Promise<DurableIssuanceStore> {
	const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
	return createNodeDurableIssuanceStore({ primaryFilename });
}

/**
 * Captures one required promise rejection.
 * @param operation - Operation required to reject.
 * @returns The exact rejection identity.
 */
async function rejected(operation: () => Promise<unknown>): Promise<unknown> {
	try {
		await operation();
		throw new Error("expected operation to reject");
	} catch (error) {
		return error;
	}
}

describe("Phase 2l-c corrective lineage closure RED", () => {
	it.each([
		["absent", 0, null],
		["present at the child ordinal", 0, { exhausted: 0 as const, next: 0 }],
		["lagging behind the child ordinal", 1, { exhausted: 0 as const, next: 0 }],
	] as const)("latches paging corruption when lineage is %s", async (_label, authorSequence, lineage) => {
		const primaryFilename = primary(`unconsumed-${lineage === null ? "absent" : "unadvanced"}`);
		await seedPair(primaryFilename, authorSequence, "pending", lineage);
		const store = await openStore(primaryFilename);
		try {
			const firstFailure = await rejected(() => store.readOutboxPage());
			expect(firstFailure).toMatchObject({ code: "ISSUANCE_RECOVERY_CORRUPT" });
			await expect(store.readIssued(PHASE_2L_C_SCOPE, authorSequence)).rejects.toBe(firstFailure);
			await expect(store.readLineage(PHASE_2L_C_SCOPE)).rejects.toBe(firstFailure);
		} finally {
			await store.close();
		}
	});

	it.each([
		["pending after ordinary advance", 0, "pending", { exhausted: 0 as const, next: 1 }],
		[
			"published at exhausted maximum",
			Number.MAX_SAFE_INTEGER,
			"published",
			{ exhausted: 1 as const, next: Number.MAX_SAFE_INTEGER },
		],
	] as const)("returns a complete %s closure", async (_label, authorSequence, publishState, lineage) => {
		const primaryFilename = primary(`consumed-${publishState}`);
		await seedPair(primaryFilename, authorSequence, publishState, lineage);
		const store = await openStore(primaryFilename);
		try {
			await expect(store.readOutboxPage()).resolves.toEqual([
				expect.objectContaining({
					commit: expect.objectContaining({ authorSequence }),
					publishState,
				}),
			]);
			await expect(store.readIssued(PHASE_2L_C_SCOPE, authorSequence)).resolves.toMatchObject({ authorSequence });
		} finally {
			await store.close();
		}
	});
});

describe("Phase 2l-c independent SQLite structure oracles", () => {
	it("proves exact columns, no foreign keys, and only inherent primary-key indexes", () => {
		const database = new DatabaseSync(":memory:", {
			allowExtension: false,
			enableDoubleQuotedStringLiterals: false,
			enableForeignKeyConstraints: false,
			readOnly: false,
		});
		try {
			for (const sql of Object.values(PHASE_2L_C_DDL)) database.exec(sql);
			const expectedColumns = {
				issuance_outbox: [
					["object_id", "TEXT", 1],
					["author", "TEXT", 2],
					["author_sequence", "INTEGER", 3],
					["digest", "BLOB", 0],
					["publish_state", "TEXT", 0],
				],
				issued_records: [
					["object_id", "TEXT", 1],
					["author", "TEXT", 2],
					["author_sequence", "INTEGER", 3],
					["canonical_preimage", "BLOB", 0],
					["digest", "BLOB", 0],
					["signature", "BLOB", 0],
				],
				lineages: [
					["object_id", "TEXT", 1],
					["author", "TEXT", 2],
					["next", "INTEGER", 0],
					["exhausted", "INTEGER", 0],
				],
			} as const;

			for (const [tableName, columns] of Object.entries(expectedColumns)) {
				const tableInfo = database.prepare(`PRAGMA table_xinfo(${tableName})`);
				tableInfo.setReadBigInts(false);
				expect(plainRows(tableInfo.all() as Record<string, unknown>[])).toEqual(
					columns.map(([name, type, pk], cid) => ({
						cid,
						dflt_value: null,
						hidden: 0,
						name,
						notnull: 1,
						pk,
						type,
					}))
				);

				const foreignKeys = database.prepare(`PRAGMA foreign_key_list(${tableName})`);
				foreignKeys.setReadBigInts(false);
				expect(foreignKeys.all()).toEqual([]);

				const indexes = database.prepare(`PRAGMA index_list(${tableName})`);
				indexes.setReadBigInts(false);
				expect(plainRows(indexes.all() as Record<string, unknown>[])).toEqual([
					{
						name: `sqlite_autoindex_${tableName}_1`,
						origin: "pk",
						partial: 0,
						seq: 0,
						unique: 1,
					},
				]);

				const indexInfo = database.prepare(`PRAGMA index_info(sqlite_autoindex_${tableName}_1)`);
				indexInfo.setReadBigInts(false);
				expect(plainRows(indexInfo.all() as Record<string, unknown>[])).toEqual(
					columns.filter(([, , pk]) => pk !== 0).map(([name], seqno) => ({ cid: seqno, name, seqno }))
				);
			}

			const catalog = database.prepare("SELECT type,name,tbl_name FROM sqlite_schema ORDER BY type,name");
			catalog.setReadBigInts(false);
			expect(plainRows(catalog.all() as Record<string, unknown>[])).toEqual([
				{ name: "issuance_outbox", tbl_name: "issuance_outbox", type: "table" },
				{ name: "issued_records", tbl_name: "issued_records", type: "table" },
				{ name: "lineages", tbl_name: "lineages", type: "table" },
			]);
		} finally {
			database.close();
		}
	});
});
