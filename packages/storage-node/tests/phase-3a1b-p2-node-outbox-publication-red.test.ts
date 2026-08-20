import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { derivedFilename, loadPhase2lCNodeModule } from "./fixtures/phase-2l-c-node-issuance-contract.js";
import {
	errorShape,
	phase3a1bP2Commit,
	type Phase3a1bP2Store,
	PHASE_3A1B_P2_METHODS,
	PHASE_3A1B_P2_NODE_TRACE,
	PHASE_3A1B_P2_OTHER_SCOPE,
	PHASE_3A1B_P2_SCOPE,
} from "../../../tests/fixtures/phase-3a1b-p2-outbox-publication-contract.js";

const directories: string[] = [];

function primary(label: string): string {
	const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `phase-3a1b-p2-node-${label}-`));
	directories.push(directory);
	return path.join(directory, "primary.sqlite");
}

afterEach(() => {
	for (const directory of directories.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
});

async function open(primaryFilename: string): Promise<Phase3a1bP2Store> {
	const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
	return createNodeDurableIssuanceStore({ primaryFilename }) as unknown as Phase3a1bP2Store;
}

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
	try {
		await run();
	} catch (error) {
		return error;
	}
	throw new TypeError("expected Node publication transition rejection");
}

function nativeRows(primaryFilename: string): readonly Record<string, unknown>[] {
	const database = new DatabaseSync(derivedFilename(primaryFilename), { readOnly: true });
	try {
		const statement = database.prepare(
			"SELECT object_id,author,author_sequence,digest,publish_state FROM issuance_outbox ORDER BY object_id,author,author_sequence"
		);
		statement.setReadBigInts(false);
		return statement.all();
	} finally {
		database.close();
	}
}

async function tracedNodeMark(
	store: Phase3a1bP2Store,
	input: Parameters<Phase3a1bP2Store["compareAndMarkOutboxPublished"]>[0],
	databaseIdentity: string
): Promise<
	readonly Readonly<{
		changes?: number;
		connection: string;
		database: string;
		event: string;
		parameters?: readonly unknown[];
	}>[]
> {
	const trace: {
		changes?: number;
		connection: string;
		database: string;
		event: string;
		parameters?: readonly unknown[];
	}[] = [];
	const statements = new WeakMap<StatementSync, { database: DatabaseSync; sql: string }>();
	const databases = new WeakMap<DatabaseSync, string>();
	const transactionKinds = new WeakMap<DatabaseSync, "reader" | "writer">();
	const originalExec = DatabaseSync.prototype.exec;
	const originalPrepare = DatabaseSync.prototype.prepare;
	const originalGet = StatementSync.prototype.get;
	const originalRun = StatementSync.prototype.run;
	let databaseOrdinal = 0;
	const connection = (database: DatabaseSync): string => {
		let value = databases.get(database);
		if (value === undefined) {
			value = `connection-${++databaseOrdinal}`;
			databases.set(database, value);
		}
		return value;
	};
	const evidence = (
		database: DatabaseSync,
		event: string
	): { connection: string; database: string; event: string } => ({
		connection: connection(database),
		database: databaseIdentity,
		event,
	});
	DatabaseSync.prototype.prepare = function (sql: string): StatementSync {
		const statement = originalPrepare.call(this, sql);
		statements.set(statement, { database: this, sql });
		return statement;
	};
	DatabaseSync.prototype.exec = function (sql: string): void {
		const normalized = sql.trim().replace(/\s+/gu, " ").toUpperCase();
		if (normalized === "BEGIN IMMEDIATE") {
			transactionKinds.set(this, "writer");
			trace.push(evidence(this, "begin-immediate"));
		} else if (normalized === "BEGIN" || normalized === "BEGIN DEFERRED") {
			transactionKinds.set(this, "reader");
			trace.push(evidence(this, "readonly-begin"));
		} else if (normalized === "COMMIT") {
			trace.push(evidence(this, transactionKinds.get(this) === "writer" ? "mutation-commit" : "readonly-commit"));
			transactionKinds.delete(this);
		}
		return originalExec.call(this, sql);
	};
	StatementSync.prototype.get = function (this: StatementSync, ...parameters: unknown[]) {
		const owner = statements.get(this);
		if (owner !== undefined) {
			const sql = owner.sql;
			const event = /\bFROM\s+lineages\b/iu.test(sql)
				? "lineage-select"
				: /\bFROM\s+issued_records\b/iu.test(sql)
					? "issued-read"
					: /\bFROM\s+issuance_outbox\b/iu.test(sql)
						? "outbox-read"
						: undefined;
			if (event !== undefined) trace.push({ ...evidence(owner.database, event), parameters: [...parameters] });
		}
		return Reflect.apply(originalGet, this, parameters) as ReturnType<StatementSync["get"]>;
	} as StatementSync["get"];
	StatementSync.prototype.run = function (this: StatementSync, ...parameters: unknown[]) {
		const owner = statements.get(this);
		const result = Reflect.apply(originalRun, this, parameters) as ReturnType<StatementSync["run"]>;
		if (owner !== undefined && /\bUPDATE\s+issuance_outbox\b/iu.test(owner.sql)) {
			trace.push({
				...evidence(owner.database, "outbox-update"),
				changes: Number(result.changes),
				parameters: [...parameters],
			});
		}
		return result;
	} as StatementSync["run"];
	try {
		await store.compareAndMarkOutboxPublished(input);
		return trace;
	} finally {
		DatabaseSync.prototype.exec = originalExec;
		DatabaseSync.prototype.prepare = originalPrepare;
		StatementSync.prototype.get = originalGet;
		StatementSync.prototype.run = originalRun;
	}
}

describe("D.93.29 Seam 2 Node durable publication", () => {
	it("freezes the six-member facade and exact synchronous writer/readback source trace", async () => {
		const store = await open(primary("surface"));
		expect(Object.keys(store).sort()).toEqual(PHASE_3A1B_P2_METHODS);
		expect(Reflect.ownKeys(store).sort()).toEqual(PHASE_3A1B_P2_METHODS);
		expect(Object.getPrototypeOf(store)).toBe(Object.prototype);
		expect(Object.isFrozen(store)).toBe(true);
		await store.close();

		const implementation = fs.readFileSync(
			path.resolve(import.meta.dirname, "../src/internal/node-issuance-store.ts"),
			"utf8"
		);
		expect(implementation).toContain("compareAndMarkOutboxPublished");
		expect(implementation).toMatch(/BEGIN IMMEDIATE[\s\S]*UPDATE issuance_outbox[\s\S]*publish_state = 'published'/u);
		expect(implementation).toMatch(/publish_state = 'pending'/u);
		expect(implementation).toMatch(/changes\s*(?:===|!==)\s*1/u);
		expect(implementation).toContain("#readTerminal");
		expect(PHASE_3A1B_P2_NODE_TRACE).toEqual([
			"begin-immediate",
			"lineage-select",
			"issued-read",
			"outbox-read",
			"outbox-update",
			"mutation-commit",
			"readonly-begin",
			"lineage-select",
			"issued-read",
			"outbox-read",
			"readonly-commit",
		]);
	});

	it("marks only the exact pending row, readbacks published, reopens and remains idempotent", async () => {
		const filename = primary("success");
		const store = await open(filename);
		const addressed = await store.transactIssue(PHASE_3A1B_P2_SCOPE, (ordinal) =>
			Promise.resolve(phase3a1bP2Commit(PHASE_3A1B_P2_SCOPE, ordinal, 31))
		);
		await store.transactIssue(PHASE_3A1B_P2_OTHER_SCOPE, (ordinal) =>
			Promise.resolve(phase3a1bP2Commit(PHASE_3A1B_P2_OTHER_SCOPE, ordinal, 47))
		);
		const beforeIssued = await store.readIssued(PHASE_3A1B_P2_SCOPE, 0);
		const beforeLineage = await store.readLineage(PHASE_3A1B_P2_SCOPE);
		const digest = new Uint8Array(addressed.envelope.digest);
		const transition = tracedNodeMark(
			store,
			{
				authorSequence: 0,
				digest,
				scope: { ...PHASE_3A1B_P2_SCOPE },
			},
			derivedFilename(filename)
		);
		digest.fill(0);
		const trace = await transition;
		expect(trace.map(({ event }) => event)).toEqual(PHASE_3A1B_P2_NODE_TRACE);
		expect(new Set(trace.map(({ connection }) => connection))).toEqual(new Set(["connection-1"]));
		expect(new Set(trace.map(({ database }) => database))).toEqual(new Set([derivedFilename(filename)]));
		expect(
			trace
				.filter(({ event }) => ["lineage-select", "issued-read", "outbox-read"].includes(event))
				.map(({ parameters }) => parameters)
		).toEqual([
			[PHASE_3A1B_P2_SCOPE.objectId, PHASE_3A1B_P2_SCOPE.author],
			[PHASE_3A1B_P2_SCOPE.objectId, PHASE_3A1B_P2_SCOPE.author, 0],
			[PHASE_3A1B_P2_SCOPE.objectId, PHASE_3A1B_P2_SCOPE.author, 0],
			[PHASE_3A1B_P2_SCOPE.objectId, PHASE_3A1B_P2_SCOPE.author],
			[PHASE_3A1B_P2_SCOPE.objectId, PHASE_3A1B_P2_SCOPE.author, 0],
			[PHASE_3A1B_P2_SCOPE.objectId, PHASE_3A1B_P2_SCOPE.author, 0],
		]);
		expect(trace.filter(({ event }) => event === "outbox-update")).toEqual([
			expect.objectContaining({
				changes: 1,
				parameters: [
					PHASE_3A1B_P2_SCOPE.objectId,
					PHASE_3A1B_P2_SCOPE.author,
					0,
					new Uint8Array(addressed.envelope.digest),
				],
			}),
		]);
		await expect(
			store.compareAndMarkOutboxPublished({
				authorSequence: 0,
				digest: new Uint8Array(addressed.envelope.digest),
				scope: PHASE_3A1B_P2_SCOPE,
			})
		).resolves.toBeUndefined();
		expect(await store.readIssued(PHASE_3A1B_P2_SCOPE, 0)).toEqual(beforeIssued);
		expect(await store.readLineage(PHASE_3A1B_P2_SCOPE)).toEqual(beforeLineage);
		expect((await store.readOutboxPage()).map(({ publishState }) => publishState).sort()).toEqual([
			"pending",
			"published",
		]);
		await store.close();
		expect(nativeRows(filename)).toMatchObject([{ publish_state: "published" }, { publish_state: "pending" }]);
		const reopened = await open(filename);
		await expect(
			reopened.compareAndMarkOutboxPublished({
				authorSequence: 0,
				digest: new Uint8Array(addressed.envelope.digest),
				scope: PHASE_3A1B_P2_SCOPE,
			})
		).resolves.toBeUndefined();
		await reopened.close();
	});

	it("serializes exact concurrent marks and keeps invalid addressing non-poisoning", async () => {
		const store = await open(primary("concurrency"));
		const commit = await store.transactIssue(PHASE_3A1B_P2_SCOPE, (ordinal) =>
			Promise.resolve(phase3a1bP2Commit(PHASE_3A1B_P2_SCOPE, ordinal, 59))
		);
		const input = {
			authorSequence: 0,
			digest: new Uint8Array(commit.envelope.digest),
			scope: PHASE_3A1B_P2_SCOPE,
		};
		await expect(
			Promise.all(Array.from({ length: 8 }, () => store.compareAndMarkOutboxPublished(input)))
		).resolves.toEqual(Array.from({ length: 8 }, () => undefined));
		const wrongDigest = await captureError(() =>
			store.compareAndMarkOutboxPublished({ ...input, digest: Uint8Array.of(0xfe, 0xed) })
		);
		expect(errorShape(wrongDigest)).toMatchObject({ code: "ISSUANCE_INVALID_ARGUMENT" });
		const neverIssued = await captureError(() => store.compareAndMarkOutboxPublished({ ...input, authorSequence: 1 }));
		expect(errorShape(neverIssued)).toMatchObject({ code: "ISSUANCE_INVALID_ARGUMENT" });
		await expect(store.readLineage(PHASE_3A1B_P2_SCOPE)).resolves.toEqual({ exhausted: false, next: 1 });
		await store.close();
	});

	it("latches one corruption identity for a consumed absent closure across all six methods", async () => {
		const filename = primary("corruption");
		const seed = await open(filename);
		const commit = await seed.transactIssue(PHASE_3A1B_P2_SCOPE, (ordinal) =>
			Promise.resolve(phase3a1bP2Commit(PHASE_3A1B_P2_SCOPE, ordinal, 67))
		);
		await seed.close();
		const database = new DatabaseSync(derivedFilename(filename));
		database
			.prepare("DELETE FROM issuance_outbox WHERE object_id=? AND author=? AND author_sequence=?")
			.run(PHASE_3A1B_P2_SCOPE.objectId, PHASE_3A1B_P2_SCOPE.author, 0);
		database.close();
		const store = await open(filename);
		const first = await captureError(() =>
			store.compareAndMarkOutboxPublished({
				authorSequence: 0,
				digest: new Uint8Array(commit.envelope.digest),
				scope: PHASE_3A1B_P2_SCOPE,
			})
		);
		expect(errorShape(first)).toMatchObject({ code: "ISSUANCE_RECOVERY_CORRUPT" });
		const calls: readonly (() => Promise<unknown>)[] = [
			(): Promise<unknown> =>
				store.compareAndMarkOutboxPublished({
					authorSequence: 0,
					digest: commit.envelope.digest,
					scope: PHASE_3A1B_P2_SCOPE,
				}),
			(): Promise<unknown> => store.readIssued(PHASE_3A1B_P2_SCOPE, 0),
			(): Promise<unknown> => store.readLineage(PHASE_3A1B_P2_SCOPE),
			(): Promise<unknown> => store.readOutboxPage(),
			(): Promise<unknown> =>
				store.transactIssue(PHASE_3A1B_P2_SCOPE, (ordinal) =>
					Promise.resolve(phase3a1bP2Commit(PHASE_3A1B_P2_SCOPE, ordinal))
				),
		];
		for (const call of calls) expect(await captureError(call)).toBe(first);
		await expect(store.close()).resolves.toBeUndefined();
	});

	it("maps bounded writer and readback faults without reusing terminal suppression taxonomy", async () => {
		const filename = primary("faults");
		const store = await open(filename);
		const commit = await store.transactIssue(PHASE_3A1B_P2_SCOPE, (ordinal) =>
			Promise.resolve(phase3a1bP2Commit(PHASE_3A1B_P2_SCOPE, ordinal, 83))
		);
		const input = {
			authorSequence: 0,
			digest: new Uint8Array(commit.envelope.digest),
			scope: PHASE_3A1B_P2_SCOPE,
		};
		const originalExec = DatabaseSync.prototype.exec;
		DatabaseSync.prototype.exec = function (sql: string): void {
			if (sql.trim().replace(/\s+/gu, " ").toUpperCase() === "BEGIN IMMEDIATE") {
				throw Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
			}
			return originalExec.call(this, sql);
		};
		try {
			const busy = await captureError(() => store.compareAndMarkOutboxPublished(input));
			expect(errorShape(busy)).toMatchObject({ code: "ISSUANCE_SUBSTRATE_FAILURE", retryClass: "transient" });
		} finally {
			DatabaseSync.prototype.exec = originalExec;
		}
		await expect(store.readLineage(PHASE_3A1B_P2_SCOPE)).resolves.toEqual({ exhausted: false, next: 1 });

		const originalGet = StatementSync.prototype.get;
		let committed = false;
		DatabaseSync.prototype.exec = function (sql: string): void {
			const result = originalExec.call(this, sql);
			if (sql.trim().replace(/\s+/gu, " ").toUpperCase() === "COMMIT") committed = true;
			return result;
		};
		StatementSync.prototype.get = function (this: StatementSync, ...parameters: unknown[]) {
			if (committed) throw Object.assign(new Error("readback unavailable"), { code: "SQLITE_IOERR" });
			return Reflect.apply(originalGet, this, parameters) as ReturnType<StatementSync["get"]>;
		} as StatementSync["get"];
		try {
			const unknown = await captureError(() =>
				store.compareAndMarkOutboxPublished({ ...input, digest: new Uint8Array(input.digest) })
			);
			expect(errorShape(unknown)).toMatchObject({
				code: "ISSUANCE_OUTCOME_UNKNOWN",
				scope: PHASE_3A1B_P2_SCOPE,
			});
			expect(Object.keys(unknown as object)).not.toEqual(
				expect.arrayContaining(["authorSequence", "digest", "preimage", "publishState", "signature", "token"])
			);
		} finally {
			DatabaseSync.prototype.exec = originalExec;
			StatementSync.prototype.get = originalGet;
		}
		await store.close();
	});
});
