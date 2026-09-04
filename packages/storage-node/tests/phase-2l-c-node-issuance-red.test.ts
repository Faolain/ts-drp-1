import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
	derivedFilename,
	errorShape,
	loadPhase2lCNodeModule,
	phase2lCCommit,
	PHASE_2L_C_AMBIGUITY_CASES,
	PHASE_2L_C_DDL,
	PHASE_2L_C_SCOPE,
	PHASE_2L_C_V3_DDL,
} from "./fixtures/phase-2l-c-node-issuance-contract.js";
import { encodeCanonical } from "../../canonical/dist/src/index.js";
import type {
	DurableIssuanceStore,
	DurableIssueCommit,
	DurableIssueScope,
} from "../../issuance-store/dist/src/index.js";

const temporaryDirectories: string[] = [];
const lockFixture = new URL("./fixtures/phase-2l-c-node-lock-child.mjs", import.meta.url);
const raceFixture = new URL("./fixtures/phase-2l-c-node-race-child.mjs", import.meta.url);
const admissionObserverFixture = new URL("./fixtures/phase-2l-c-node-admission-observer-child.mjs", import.meta.url);

function primary(label: string): string {
	const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `phase-2l-c-${label}-`));
	temporaryDirectories.push(directory);
	return path.join(directory, "primary.sqlite");
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
});

function pragma(database: DatabaseSync, name: string): unknown {
	const statement = database.prepare(`PRAGMA ${name}`);
	statement.setReadBigInts(false);
	const row = statement.get();
	return row === undefined ? undefined : Object.values(row)[0];
}

function schema(filename: string): unknown {
	const database = new DatabaseSync(filename, { readOnly: true });
	try {
		const statement = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name");
		statement.setReadBigInts(false);
		return {
			busyTimeout: pragma(database, "busy_timeout"),
			journalMode: pragma(database, "journal_mode"),
			pageSize: pragma(database, "page_size"),
			rows: statement.all(),
			synchronous: pragma(database, "synchronous"),
			userVersion: pragma(database, "user_version"),
		};
	} finally {
		database.close();
	}
}

function createCatalogFixture(
	filename: string,
	statements: readonly string[],
	options: { readonly journalMode?: "DELETE" | "WAL"; readonly pageSize?: number; readonly userVersion?: number } = {}
): void {
	const database = new DatabaseSync(filename);
	try {
		database.exec(`PRAGMA page_size=${options.pageSize ?? 4096}`);
		database.prepare(`PRAGMA journal_mode=${options.journalMode ?? "WAL"}`).get();
		database.exec("BEGIN IMMEDIATE");
		for (const statement of statements) database.exec(statement);
		database.exec(`PRAGMA user_version=${options.userVersion ?? 1}`);
		database.exec("COMMIT");
	} finally {
		database.close();
	}
}

function commit(scope: DurableIssueScope, authorSequence: number, seed = 7): DurableIssueCommit {
	const envelope = {
		canonicalPreimageBytes: encodeCanonical({ ...scope, authorSequence }),
		digest: Uint8Array.of(seed, 0xd1),
		signature: Uint8Array.of(seed, 0x51),
	};
	return {
		authorSequence,
		envelope,
		issuedRecord: { authorSequence, envelope, scope },
		outboxEntry: { authorSequence, envelope, scope },
	};
}

type Settled<T> = { readonly ok: true; readonly value: T } | { readonly error: unknown; readonly ok: false };

async function settled<T>(run: () => T | Promise<T>): Promise<Settled<T>> {
	try {
		return { ok: true, value: await run() };
	} catch (error) {
		return { error, ok: false };
	}
}

async function withStore<T>(primaryFilename: string, run: (store: DurableIssuanceStore) => Promise<T>): Promise<T> {
	const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
	const store = createNodeDurableIssuanceStore({ primaryFilename });
	try {
		return await run(store);
	} finally {
		await store.close();
	}
}

describe("Phase 2l-c synchronous factory and exact SQLite admission", () => {
	it("exports one runtime factory and returns the frozen eight-member capability synchronously", async () => {
		const namespace = await loadPhase2lCNodeModule();
		expect(Object.keys(namespace)).toEqual(["createNodeDurableIssuanceStore"]);
		const result = namespace.createNodeDurableIssuanceStore({ primaryFilename: primary("surface") });
		expect(result).not.toBeInstanceOf(Promise);
		expect(Object.keys(result).sort()).toEqual([
			"close",
			"compareAndMarkOutboxPublished",
			"readIssued",
			"readLineage",
			"readOutboxPage",
			"readSettlementPlan",
			"transactIssue",
			"transactWriteSettlementPlan",
		]);
		expect(Reflect.ownKeys(result).sort()).toEqual([
			"close",
			"compareAndMarkOutboxPublished",
			"readIssued",
			"readLineage",
			"readOutboxPage",
			"readSettlementPlan",
			"transactIssue",
			"transactWriteSettlementPlan",
		]);
		expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
		expect(Object.isFrozen(result)).toBe(true);
		const closeA = result.close();
		const closeB = result.close();
		expect(closeA).toBe(closeB);
		await expect(closeA).resolves.toBeUndefined();
	});

	it("uses one-pass captured descriptors and rejects the complete closed-record misuse table before open", async () => {
		const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
		const invalidPath = primary("invalid-options");
		const invalid: Array<{ label: string; value: unknown }> = [
			{ label: "undefined", value: undefined },
			{ label: "null", value: null },
			{ label: "plain", value: "legacy" },
			{ label: "array", value: [] },
			{ label: "boxed", value: new String("boxed") },
			{ label: "empty", value: { primaryFilename: "" } },
			{ label: "value-null", value: { primaryFilename: null } },
			{ label: "value-number", value: { primaryFilename: 1 } },
			{ label: "value-boolean", value: { primaryFilename: false } },
			{ label: "value-object", value: { primaryFilename: {} } },
			{ label: "alias", value: { filename: invalidPath } },
			{ label: "extra", value: { primaryFilename: invalidPath, extra: true } },
			{
				label: "symbol",
				value: { primaryFilename: invalidPath, [Symbol("hidden")]: true },
			},
			{
				label: "inherited",
				value: Object.create({ primaryFilename: invalidPath }) as unknown,
			},
			{
				label: "custom-prototype",
				value: Object.assign(Object.create({ marker: true }) as object, { primaryFilename: invalidPath }),
			},
			{
				label: "accessor",
				value: Object.defineProperty({}, "primaryFilename", { enumerable: true, get: () => invalidPath }),
			},
			{
				label: "non-enumerable",
				value: Object.defineProperty({}, "primaryFilename", { enumerable: false, value: invalidPath }),
			},
			{
				label: "hidden-extra",
				value: Object.defineProperty({ primaryFilename: invalidPath }, "hidden", { value: true }),
			},
			{ label: "nul-only", value: { primaryFilename: "\0" } },
			{ label: "nul-prefix", value: { primaryFilename: `\0${invalidPath}` } },
			{ label: "nul-suffix", value: { primaryFilename: `${invalidPath}\0` } },
			{ label: "nul-middle", value: { primaryFilename: `${invalidPath}\0tail` } },
		];
		for (const row of invalid) {
			let synchronous: unknown;
			try {
				Reflect.apply(createNodeDurableIssuanceStore, undefined, [row.value]);
			} catch (error) {
				synchronous = error;
			}
			expect.soft(errorShape(synchronous), row.label).toMatchObject({
				code: "ISSUANCE_INVALID_ARGUMENT",
				name: "DurableIssuanceTypeError",
			});
		}
		expect(fs.existsSync(derivedFilename(invalidPath))).toBe(false);

		let getCalls = 0;
		let ownKeysCalls = 0;
		let descriptorCalls = 0;
		let prototypeCalls = 0;
		const captured = primary("captured");
		const optionsTarget = { primaryFilename: captured };
		const options = new Proxy(optionsTarget, {
			get(target, key, receiver): unknown {
				getCalls++;
				return Reflect.get(target, key, receiver);
			},
			getOwnPropertyDescriptor(target, key): PropertyDescriptor | undefined {
				descriptorCalls++;
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
			getPrototypeOf(target): object | null {
				prototypeCalls++;
				return Reflect.getPrototypeOf(target);
			},
			ownKeys(target): ArrayLike<string | symbol> {
				ownKeysCalls++;
				return Reflect.ownKeys(target);
			},
		});
		const store = createNodeDurableIssuanceStore(options);
		expect(getCalls).toBe(0);
		expect(ownKeysCalls).toBe(1);
		expect(descriptorCalls).toBe(1);
		expect(prototypeCalls).toBe(1);
		optionsTarget.primaryFilename = `${captured}-mutated`;
		expect(fs.existsSync(derivedFilename(captured))).toBe(true);
		expect(fs.existsSync(derivedFilename(optionsTarget.primaryFilename))).toBe(false);
		await store.close();
		const nullPrototypePath = primary("null-prototype");
		const nullPrototypeOptions = Object.assign(Object.create(null) as object, {
			primaryFilename: nullPrototypePath,
		});
		const nullPrototypeStore = createNodeDurableIssuanceStore(nullPrototypeOptions as { primaryFilename: string });
		await nullPrototypeStore.close();
		expect(fs.existsSync(derivedFilename(nullPrototypePath))).toBe(true);

		for (const trap of ["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"] as const) {
			const hostile = new Proxy(
				{ primaryFilename: invalidPath },
				{
					[trap](): never {
						throw new Error(`hostile ${trap}`);
					},
				}
			);
			expect(() => createNodeDurableIssuanceStore(hostile)).toThrow(
				expect.objectContaining({ code: "ISSUANCE_INVALID_ARGUMENT", name: "DurableIssuanceTypeError" })
			);
		}
	});

	it("derives verbatim while never touching primary identity or creating parents", async () => {
		const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
		const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "phase-2l-c-opacity-"));
		temporaryDirectories.push(directory);
		for (const [name, setup] of [
			["absent", (): void => undefined],
			["sentinel", (filename: string): void => fs.writeFileSync(filename, "sentinel")],
			["directory", (filename: string): void => fs.mkdirSync(filename)],
		] as const) {
			const primaryFilename = path.join(directory, name);
			setup(primaryFilename);
			const before = fs.existsSync(primaryFilename)
				? fs.statSync(primaryFilename).isFile()
					? fs.readFileSync(primaryFilename)
					: "directory"
				: "absent";
			const store = createNodeDurableIssuanceStore({ primaryFilename });
			await store.close();
			expect(fs.existsSync(derivedFilename(primaryFilename))).toBe(true);
			const after = fs.existsSync(primaryFilename)
				? fs.statSync(primaryFilename).isFile()
					? fs.readFileSync(primaryFilename)
					: "directory"
				: "absent";
			expect(after).toEqual(before);
		}
		const missingParent = path.join(directory, "missing", "primary");
		expect(() => createNodeDurableIssuanceStore({ primaryFilename: missingParent })).toThrow(
			expect.objectContaining({ code: "ISSUANCE_SUBSTRATE_FAILURE", retryClass: "permanent" })
		);
		expect(fs.existsSync(path.dirname(missingParent))).toBe(false);
		const whitespace = path.join(directory, " opaque name ");
		const whitespaceStore = createNodeDurableIssuanceStore({ primaryFilename: whitespace });
		await whitespaceStore.close();
		expect(fs.existsSync(derivedFilename(whitespace))).toBe(true);
		expect(fs.existsSync(derivedFilename(whitespace.trim()))).toBe(false);
	});

	it("creates, byte-verifies and reopens exactly one authority at schema v3 in the stable v1-derived file", async () => {
		const primaryFilename = primary("schema");
		const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
		const first = createNodeDurableIssuanceStore({ primaryFilename });
		await first.close();
		const filename = derivedFilename(primaryFilename);
		const observed = schema(filename) as {
			journalMode: string;
			pageSize: number;
			rows: Record<string, unknown>[];
			userVersion: number;
		};
		expect(observed).toMatchObject({ journalMode: "wal", pageSize: 4096, userVersion: 3 });
		expect(observed.rows).toEqual([
			expect.objectContaining({ name: "issuance_outbox", sql: PHASE_2L_C_DDL.issuance_outbox, type: "table" }),
			expect.objectContaining({ name: "issued_records", sql: PHASE_2L_C_DDL.issued_records, type: "table" }),
			expect.objectContaining({ name: "lineages", sql: PHASE_2L_C_DDL.lineages, type: "table" }),
			expect.objectContaining({ name: "settlement_plans", sql: PHASE_2L_C_V3_DDL.settlement_plans, type: "table" }),
		]);
		const reopened = createNodeDurableIssuanceStore({ primaryFilename });
		await reopened.close();
		expect(schema(filename)).toEqual(observed);
	});

	it("pins native constructor booleans, FULL/busy pragmas and explicit numeric statement reads", async () => {
		const primaryFilename = primary("native-options");
		const child = spawn(process.execPath, [admissionObserverFixture.pathname, primaryFilename], {
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		const observation = await new Promise<Record<string, unknown>>((resolve, reject) => {
			const timeout = setTimeout(() => {
				child.kill("SIGKILL");
				reject(new Error("native admission observer timed out"));
			}, 10_000);
			child.once("error", reject);
			child.on("message", (message: Record<string, unknown>) => {
				if (message.kind === "observation") resolve(message);
				if (message.kind === "child-error") reject(new Error(String(message.message)));
			});
			child.once("exit", (code) => {
				clearTimeout(timeout);
				if (code !== 0) reject(new Error(`native admission observer exited ${String(code)}`));
			});
		});
		expect(observation.constructorCalls).toEqual([
			{
				location: derivedFilename(primaryFilename),
				options: {
					allowExtension: false,
					enableDoubleQuotedStringLiterals: false,
					enableForeignKeyConstraints: false,
					readOnly: false,
				},
			},
		]);
		expect(observation.allResultBearingConfigured).toBe(true);
		const events = observation.events as Array<{ kind: string; result?: Record<string, unknown>; sql: string }>;
		expect(
			events.filter(({ kind, sql }) => kind === "exec" && /^CREATE TABLE\b/u.test(sql)).map(({ sql }) => sql)
		).toEqual(Object.values(PHASE_2L_C_V3_DDL));
		const busyWrite = events.findIndex(({ sql }) => /^\s*PRAGMA\s+busy_timeout\s*=\s*1000\s*$/iu.test(sql));
		const busyRead = events.findIndex(
			({ result, sql }, index) =>
				index > busyWrite && /^\s*PRAGMA\s+busy_timeout\s*$/iu.test(sql) && result?.timeout === 1000
		);
		const synchronousWrite = events.findIndex(({ sql }) => /^\s*PRAGMA\s+synchronous\s*=\s*FULL\s*$/iu.test(sql));
		const synchronousRead = events.findIndex(
			({ result, sql }, index) =>
				index > synchronousWrite && /^\s*PRAGMA\s+synchronous\s*$/iu.test(sql) && result?.synchronous === 2
		);
		expect([busyWrite, busyRead, synchronousWrite, synchronousRead].every((index) => index >= 0)).toBe(true);
		expect(busyWrite).toBeLessThan(busyRead);
		expect(synchronousWrite).toBeLessThan(synchronousRead);
	});

	it("retries an interrupted empty catalog but rejects partial, AHE-shaped and extra-schema files without repair", async () => {
		const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
		const retryPrimary = primary("empty-retry");
		const retryFilename = derivedFilename(retryPrimary);
		const empty = new DatabaseSync(retryFilename);
		empty.exec("PRAGMA page_size=4096");
		empty.prepare("PRAGMA journal_mode=WAL").get();
		empty.close();
		const recovered = createNodeDurableIssuanceStore({ primaryFilename: retryPrimary });
		await recovered.close();
		expect(schema(retryFilename)).toMatchObject({ journalMode: "wal", pageSize: 4096, userVersion: 3 });

		for (const [label, statements] of [
			["partial", [PHASE_2L_C_DDL.lineages]],
			["ahe", ["CREATE TABLE objects (object_id TEXT PRIMARY KEY)"]],
			["extra", [...Object.values(PHASE_2L_C_V3_DDL), "CREATE TABLE foreign_table (id TEXT PRIMARY KEY)"]],
		] as const) {
			const primaryFilename = primary(label);
			const filename = derivedFilename(primaryFilename);
			createCatalogFixture(filename, statements);
			const before = schema(filename);
			expect(() => createNodeDurableIssuanceStore({ primaryFilename })).toThrow(
				expect.objectContaining({ code: "ISSUANCE_UNSUPPORTED_SCHEMA" })
			);
			expect(schema(filename)).toEqual(before);
		}
		for (const [label, statements, options] of [
			[
				"ddl-bytes",
				[
					PHASE_2L_C_DDL.lineages.replace("next INTEGER", "next  INTEGER"),
					PHASE_2L_C_DDL.issued_records,
					PHASE_2L_C_DDL.issuance_outbox,
					PHASE_2L_C_V3_DDL.settlement_plans,
				],
				{ userVersion: 3 },
			],
			["wrong-version", Object.values(PHASE_2L_C_V3_DDL), { userVersion: 4 }],
			["wrong-page", Object.values(PHASE_2L_C_V3_DDL), { pageSize: 8192, userVersion: 3 }],
			["wrong-journal", Object.values(PHASE_2L_C_V3_DDL), { journalMode: "DELETE", userVersion: 3 }],
		] as const) {
			const primaryFilename = primary(label);
			const filename = derivedFilename(primaryFilename);
			createCatalogFixture(filename, statements, options);
			const before = schema(filename);
			expect(() => createNodeDurableIssuanceStore({ primaryFilename })).toThrow(
				expect.objectContaining({ code: "ISSUANCE_UNSUPPORTED_SCHEMA" })
			);
			expect(schema(filename)).toEqual(before);
		}
	});
});

describe("Phase 2l-c real transaction, lifecycle and paging contract", () => {
	it("commits one detached closure, returns fresh reads and preserves pending outbox", async () => {
		await withStore(primary("issue"), async (store) => {
			let builds = 0;
			const result = await store.transactIssue(PHASE_2L_C_SCOPE, (selected) => {
				builds++;
				return Promise.resolve(phase2lCCommit(selected));
			});
			expect(builds).toBe(1);
			expect(result.authorSequence).toBe(0);
			result.envelope.digest[0] = 255;
			const issuedA = await store.readIssued(PHASE_2L_C_SCOPE, 0);
			const issuedB = await store.readIssued(PHASE_2L_C_SCOPE, 0);
			expect(issuedA?.envelope.digest).toEqual(Uint8Array.of(7, 0xd1));
			expect(issuedA).not.toBe(issuedB);
			expect(issuedA?.envelope).not.toBe(issuedB?.envelope);
			expect(await store.readLineage(PHASE_2L_C_SCOPE)).toEqual({ exhausted: false, next: 1 });
			expect(await store.readOutboxPage()).toEqual([
				expect.objectContaining({ commit: expect.objectContaining({ authorSequence: 0 }), publishState: "pending" }),
			]);
		});
	});

	it("copies pooled Buffer input into plain private bytes and rejects SharedArrayBuffer without mutation", async () => {
		await withStore(primary("byte-ownership"), async (store) => {
			const pooled = Buffer.from([7, 0xd1]);
			const result = await store.transactIssue(PHASE_2L_C_SCOPE, (authorSequence) => {
				const canonicalPreimageBytes = Buffer.from(encodeCanonical({ ...PHASE_2L_C_SCOPE, authorSequence }));
				const signature = Buffer.from([7, 0x51]);
				const envelope = { canonicalPreimageBytes, digest: pooled, signature };
				return Promise.resolve({
					authorSequence,
					envelope,
					issuedRecord: { authorSequence, envelope, scope: PHASE_2L_C_SCOPE },
					outboxEntry: { authorSequence, envelope, scope: PHASE_2L_C_SCOPE },
				});
			});
			pooled[0] = 255;
			for (const bytes of [result.envelope.canonicalPreimageBytes, result.envelope.digest, result.envelope.signature]) {
				expect(Object.getPrototypeOf(bytes)).toBe(Uint8Array.prototype);
				expect(bytes.buffer).toBeInstanceOf(ArrayBuffer);
				expect(bytes.byteOffset).toBe(0);
				expect(bytes.buffer.byteLength).toBe(bytes.byteLength);
			}
			expect(result.envelope.digest).toEqual(Uint8Array.of(7, 0xd1));

			const sharedPreimage = new Uint8Array(new SharedArrayBuffer(result.envelope.canonicalPreimageBytes.byteLength));
			sharedPreimage.set(result.envelope.canonicalPreimageBytes);
			const invalidEnvelope = {
				canonicalPreimageBytes: sharedPreimage,
				digest: Uint8Array.of(8),
				signature: Uint8Array.of(8),
			};
			await expect(
				store.transactIssue(PHASE_2L_C_SCOPE, (authorSequence) =>
					Promise.resolve({
						authorSequence,
						envelope: invalidEnvelope,
						issuedRecord: { authorSequence, envelope: invalidEnvelope, scope: PHASE_2L_C_SCOPE },
						outboxEntry: { authorSequence, envelope: invalidEnvelope, scope: PHASE_2L_C_SCOPE },
					})
				)
			).rejects.toMatchObject({ code: "ISSUANCE_COMMIT_INVALID" });
			expect(await store.readLineage(PHASE_2L_C_SCOPE)).toEqual({ exhausted: false, next: 1 });
			expect(await store.readIssued(PHASE_2L_C_SCOPE, 1)).toBeNull();
		});
	});

	it("uses shared UTF-16 order rather than SQLite BINARY order, including the inversion pair", async () => {
		await withStore(primary("order"), async (store) => {
			const scopes = [
				{ author: "a", objectId: "a" },
				{ author: "a", objectId: "\u{10000}" },
				{ author: "a", objectId: "\ue000" },
			] as const;
			for (const scope of scopes)
				await store.transactIssue(scope, (selected) => Promise.resolve(commit(scope, selected)));
			const page = await store.readOutboxPage();
			expect(page.map(({ commit: value }) => value.issuedRecord.scope.objectId)).toEqual(["a", "\u{10000}", "\ue000"]);
			expect(
				(await store.readOutboxPage({ afterKey: ["\u{10000}", "a", 0], limit: 1 }))[0]?.commit.issuedRecord.scope
					.objectId
			).toBe("\ue000");
		});
	});

	it("applies the shared default page bound, afterKey, scope filter and closed input grammar", async () => {
		const primaryFilename = primary("paging");
		const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
		const admitted = createNodeDurableIssuanceStore({ primaryFilename });
		await admitted.close();
		const raw = new DatabaseSync(derivedFilename(primaryFilename));
		const issued = raw.prepare(
			"INSERT INTO issued_records(object_id,author,author_sequence,canonical_preimage,digest,signature) VALUES(?,?,?,?,?,?)"
		);
		const outbox = raw.prepare(
			"INSERT INTO issuance_outbox(object_id,author,author_sequence,digest,publish_state) VALUES(?,?,?,?,?)"
		);
		const lineage = raw.prepare("INSERT INTO lineages(object_id,author,next,exhausted) VALUES(?,?,?,?)");
		raw.exec("BEGIN IMMEDIATE");
		for (let authorSequence = 0; authorSequence < 65; authorSequence++) {
			const value = commit(PHASE_2L_C_SCOPE, authorSequence);
			issued.run(
				PHASE_2L_C_SCOPE.objectId,
				PHASE_2L_C_SCOPE.author,
				authorSequence,
				value.envelope.canonicalPreimageBytes,
				value.envelope.digest,
				value.envelope.signature
			);
			outbox.run(PHASE_2L_C_SCOPE.objectId, PHASE_2L_C_SCOPE.author, authorSequence, value.envelope.digest, "pending");
		}
		lineage.run(PHASE_2L_C_SCOPE.objectId, PHASE_2L_C_SCOPE.author, 65, 0);
		for (const [scope, seed] of [
			[{ author: "alice", objectId: "y-foreign" }, 11],
			[{ author: "alice", objectId: "z-target" }, 12],
		] as const) {
			const value = commit(scope, 0, seed);
			issued.run(
				scope.objectId,
				scope.author,
				0,
				value.envelope.canonicalPreimageBytes,
				value.envelope.digest,
				value.envelope.signature
			);
			outbox.run(scope.objectId, scope.author, 0, value.envelope.digest, "pending");
			lineage.run(scope.objectId, scope.author, 1, 0);
		}
		raw.exec("COMMIT");
		raw.close();

		await withStore(primaryFilename, async (store) => {
			const first = await store.readOutboxPage();
			expect(first).toHaveLength(64);
			expect(first[0]?.commit.authorSequence).toBe(0);
			expect(first[63]?.commit.authorSequence).toBe(63);
			const last = await store.readOutboxPage({
				afterKey: [PHASE_2L_C_SCOPE.objectId, PHASE_2L_C_SCOPE.author, 63],
				limit: 1,
				scope: PHASE_2L_C_SCOPE,
			});
			expect(last.map(({ commit: value }) => value.authorSequence)).toEqual([64]);
			expect(last[0]?.commit.issuedRecord.scope).toEqual(PHASE_2L_C_SCOPE);
			const filtered = await store.readOutboxPage({
				afterKey: ["x-cursor", "alice", 0],
				limit: 1,
				scope: { author: "alice", objectId: "z-target" },
			});
			expect(filtered[0]?.commit.issuedRecord.scope.objectId).toBe("z-target");
			for (const input of [
				{ limit: 0 },
				{ limit: 129 },
				{ afterKey: [PHASE_2L_C_SCOPE.objectId, PHASE_2L_C_SCOPE.author, -1] },
				{ extra: true },
			]) {
				await expect(store.readOutboxPage(input as never)).rejects.toMatchObject({
					code: "ISSUANCE_INVALID_ARGUMENT",
				});
			}
		});
	});

	it("makes one of eight same-scope candidates win and permits progress plus reentrancy during builders", async () => {
		const primaryFilename = primary("race");
		const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
		const stores = Array.from({ length: 8 }, () => createNodeDurableIssuanceStore({ primaryFilename }));
		const first = stores[0] as DurableIssuanceStore;
		const second = stores[1] as DurableIssuanceStore;
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => (release = resolve));
		let ready = 0;
		let builds = 0;
		const build = async (selected: number): Promise<DurableIssueCommit> => {
			const seed = ++builds;
			ready++;
			if (ready === stores.length) release();
			await barrier;
			return phase2lCCommit(selected, seed);
		};
		const race = await Promise.allSettled(stores.map((store) => store.transactIssue(PHASE_2L_C_SCOPE, build)));
		expect(builds).toBe(8);
		expect(race.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
		const rejected = race.filter((value): value is PromiseRejectedResult => value.status === "rejected");
		expect(rejected).toHaveLength(7);
		expect(rejected.map(({ reason }) => errorShape(reason))).toEqual(
			Array.from({ length: 7 }, () => expect.objectContaining({ code: "ISSUANCE_RETRY_REQUIRED" }))
		);
		expect(await first.readLineage(PHASE_2L_C_SCOPE)).toEqual({ exhausted: false, next: 1 });
		expect(await first.readOutboxPage({ scope: PHASE_2L_C_SCOPE })).toHaveLength(1);
		const fulfilled = race.find(
			(value): value is PromiseFulfilledResult<DurableIssueCommit> => value.status === "fulfilled"
		);
		const durableWinner = await first.readIssued(PHASE_2L_C_SCOPE, 0);
		expect(durableWinner).toEqual(fulfilled?.value);
		expect([1, 2, 3, 4, 5, 6, 7, 8]).toContain(fulfilled?.value.envelope.digest[0]);

		let releaseA!: () => void;
		const held = new Promise<void>((resolve) => (releaseA = resolve));
		let enteredA!: () => void;
		const entered = new Promise<void>((resolve) => (enteredA = resolve));
		const scopeA = { author: "alice", objectId: "scope-a" };
		const scopeB = { author: "alice", objectId: "scope-b" };
		const pendingA = first.transactIssue(scopeA, async (selected) => {
			enteredA();
			await held;
			return commit(scopeA, selected);
		});
		await entered;
		await expect(
			second.transactIssue(scopeB, (selected) => Promise.resolve(commit(scopeB, selected)))
		).resolves.toMatchObject({
			authorSequence: 0,
		});
		releaseA();
		await pendingA;

		const outer = { author: "alice", objectId: "scope-outer" };
		const inner = { author: "alice", objectId: "scope-inner" };
		await expect(
			first.transactIssue(outer, async (selected) => {
				await first.transactIssue(inner, (innerSelected) => Promise.resolve(commit(inner, innerSelected)));
				return commit(outer, selected);
			})
		).resolves.toMatchObject({ authorSequence: 0 });

		const children = [1, 2].map((seed) =>
			spawn(process.execPath, [raceFixture.pathname, primaryFilename, String(seed)], {
				stdio: ["ignore", "ignore", "pipe", "ipc"],
			})
		);
		const processOutcomes: Array<Record<string, unknown>> = [];
		await Promise.all(
			children.map(
				(child) =>
					new Promise<void>((resolve, reject) => {
						let ready = false;
						const timeout = setTimeout(() => {
							child.kill("SIGKILL");
							reject(new Error("two-process issuance race timed out"));
						}, 10_000);
						child.once("error", reject);
						child.on("message", (message: Record<string, unknown>) => {
							if (message.kind === "ready") {
								ready = true;
								Reflect.set(child, "phase2lCReady", true);
								if (children.every((candidate) => Reflect.get(candidate, "phase2lCReady") === true)) {
									for (const candidate of children) candidate.send("go");
								}
							} else if (message.kind === "child-error") reject(new Error(String(message.message)));
							else processOutcomes.push(message);
						});
						child.once("exit", (code) => {
							clearTimeout(timeout);
							if (!ready || code !== 0) reject(new Error(`two-process child exited ${String(code)}`));
							else resolve();
						});
					})
			)
		);
		expect(processOutcomes.filter(({ kind }) => kind === "fulfilled")).toHaveLength(1);
		expect(processOutcomes.filter(({ kind }) => kind === "rejected")).toEqual([
			expect.objectContaining({ code: "ISSUANCE_RETRY_REQUIRED" }),
		]);
		const processWinner = processOutcomes.find(({ kind }) => kind === "fulfilled");
		const processScope = { author: "alice", objectId: "room:process-race" };
		expect((await first.readIssued(processScope, 0))?.envelope.digest[0]).toBe(processWinner?.digest0);
		await Promise.all(stores.map((store) => store.close()));
	});

	it("uses one synchronous writer then one bounded readonly snapshot with no microtask in the writer", async () => {
		const originalExec = DatabaseSync.prototype.exec;
		const originalAll = StatementSync.prototype.all;
		const originalGet = StatementSync.prototype.get;
		const originalPrepare = DatabaseSync.prototype.prepare;
		const originalRun = StatementSync.prototype.run;
		const sqlByStatement = new WeakMap<StatementSync, string>();
		const databaseByStatement = new WeakMap<StatementSync, DatabaseSync>();
		const trace: string[] = [];
		const pointReads: Array<{
			database: DatabaseSync | undefined;
			expandedSql: string;
			parameters: unknown[];
			sql: string;
		}> = [];
		const mutationDatabases = new WeakSet<DatabaseSync>();
		let sawMutationDatabase = false;
		let readonlyUsedMutationDatabase = false;
		function recordPointRead(statement: StatementSync, parameters: unknown[]): void {
			if (!armed) return;
			const sql = sqlByStatement.get(statement) ?? "";
			if (/^\s*SELECT\b[\s\S]*\bFROM\s+(?:lineages|issued_records|issuance_outbox)\b/iu.test(sql)) {
				pointReads.push({
					database: databaseByStatement.get(statement),
					expandedSql: statement.expandedSQL,
					parameters,
					sql,
				});
			}
		}
		let armed = false;
		let microtaskRan = false;
		DatabaseSync.prototype.prepare = function (sql: string): StatementSync {
			const statement = originalPrepare.call(this, sql);
			sqlByStatement.set(statement, sql);
			databaseByStatement.set(statement, this);
			return statement;
		};
		DatabaseSync.prototype.exec = function (sql: string): void {
			originalExec.call(this, sql);
			if (!armed) return;
			const normalized = sql.trim().replace(/\s+/gu, " ").toUpperCase();
			if (normalized === "BEGIN IMMEDIATE") {
				mutationDatabases.add(this);
				sawMutationDatabase = true;
				trace.push("begin-immediate");
				queueMicrotask(() => (microtaskRan = true));
			} else if (normalized === "BEGIN") {
				readonlyUsedMutationDatabase = mutationDatabases.has(this);
				trace.push("readonly-begin");
			} else if (normalized === "COMMIT") {
				const readonly = trace.includes("readonly-begin");
				trace.push(readonly ? "readonly-commit" : "mutation-commit");
				if (!readonly) expect(microtaskRan).toBe(false);
			}
		};
		StatementSync.prototype.get = function (
			this: StatementSync,
			...parameters: unknown[]
		): ReturnType<StatementSync["get"]> {
			const result = Reflect.apply(originalGet, this, parameters) as ReturnType<StatementSync["get"]>;
			if (armed) {
				const sql = sqlByStatement.get(this) ?? "";
				if (/^\s*SELECT\b[\s\S]*\bFROM\s+lineages\b/iu.test(sql)) trace.push("lineage-select");
				else if (/^\s*SELECT\b[\s\S]*\bFROM\s+issued_records\b/iu.test(sql)) trace.push("issued-read");
				else if (/^\s*SELECT\b[\s\S]*\bFROM\s+issuance_outbox\b/iu.test(sql)) trace.push("outbox-read");
			}
			recordPointRead(this, parameters);
			return result;
		} as typeof StatementSync.prototype.get;
		StatementSync.prototype.all = function (
			this: StatementSync,
			...parameters: unknown[]
		): ReturnType<StatementSync["all"]> {
			const result = Reflect.apply(originalAll, this, parameters) as ReturnType<StatementSync["all"]>;
			recordPointRead(this, parameters);
			return result;
		} as typeof StatementSync.prototype.all;
		StatementSync.prototype.run = function (
			this: StatementSync,
			...parameters: unknown[]
		): ReturnType<StatementSync["run"]> {
			const result = Reflect.apply(originalRun, this, parameters) as ReturnType<StatementSync["run"]>;
			if (!armed) return result;
			const sql = sqlByStatement.get(this) ?? "";
			if (/^\s*(?:INSERT\s+INTO|UPDATE)\s+lineages\b/iu.test(sql)) trace.push("lineage-write");
			else if (/^\s*INSERT\s+INTO\s+issued_records\b/iu.test(sql)) trace.push("issued-insert");
			else if (/^\s*INSERT\s+INTO\s+issuance_outbox\b/iu.test(sql)) trace.push("outbox-insert");
			return result;
		} as typeof StatementSync.prototype.run;
		const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
		const store = createNodeDurableIssuanceStore({ primaryFilename: primary("writer-trace") });
		armed = true;
		try {
			await store.transactIssue(PHASE_2L_C_SCOPE, (selected) => Promise.resolve(phase2lCCommit(selected)));
			expect(trace).toEqual([
				"begin-immediate",
				"lineage-select",
				"lineage-write",
				"issued-insert",
				"outbox-insert",
				"mutation-commit",
				"readonly-begin",
				"lineage-select",
				"issued-read",
				"outbox-read",
				"readonly-commit",
			]);
			expect(sawMutationDatabase).toBe(true);
			expect(readonlyUsedMutationDatabase).toBe(true);
			expect(pointReads.every(({ database }) => database !== undefined && mutationDatabases.has(database))).toBe(true);
			const readback = pointReads.slice(-3);
			expect(readback).toHaveLength(3);
			for (const { expandedSql, sql } of readback) {
				expect(sql).toMatch(/\bWHERE\b/iu);
				expect(expandedSql).toMatch(/\bobject_id\s*=\s*'room:alpha'/iu);
				expect(expandedSql).toMatch(/\bauthor\s*=\s*'alice'/iu);
			}
			expect(readback[1]?.expandedSql).toMatch(/\bauthor_sequence\s*=\s*0\b/iu);
			expect(readback[2]?.expandedSql).toMatch(/\bauthor_sequence\s*=\s*0\b/iu);
			expect(readback[0]?.parameters).toEqual(
				expect.arrayContaining([PHASE_2L_C_SCOPE.objectId, PHASE_2L_C_SCOPE.author])
			);
			expect(readback[1]?.parameters).toEqual(
				expect.arrayContaining([PHASE_2L_C_SCOPE.objectId, PHASE_2L_C_SCOPE.author, 0])
			);
			expect(readback[2]?.parameters).toEqual(
				expect.arrayContaining([PHASE_2L_C_SCOPE.objectId, PHASE_2L_C_SCOPE.author, 0])
			);
		} finally {
			armed = false;
			DatabaseSync.prototype.exec = originalExec;
			DatabaseSync.prototype.prepare = originalPrepare;
			StatementSync.prototype.all = originalAll;
			StatementSync.prototype.get = originalGet;
			StatementSync.prototype.run = originalRun;
			await store.close();
		}
	});

	it("maps cross-process writer expiry as transient and latches child-key collision corruption", async () => {
		const primaryFilename = primary("busy");
		const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
		const store = createNodeDurableIssuanceStore({ primaryFilename });
		const child = spawn(process.execPath, [lockFixture.pathname, derivedFilename(primaryFilename)], {
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		const childExit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		await new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.on("message", (message: { kind?: string; message?: string }) => {
				if (message.kind === "held") resolve();
				if (message.kind === "child-error") reject(new Error(message.message));
			});
		});
		const originalExec = DatabaseSync.prototype.exec;
		let writerAttempts = 0;
		DatabaseSync.prototype.exec = function (sql: string): void {
			if (sql.trim().replace(/\s+/gu, " ").toUpperCase() === "BEGIN IMMEDIATE") writerAttempts++;
			originalExec.call(this, sql);
		};
		try {
			let builds = 0;
			const started = performance.now();
			const outcome = await settled(() =>
				store.transactIssue(PHASE_2L_C_SCOPE, (selected) => {
					builds++;
					return Promise.resolve(phase2lCCommit(selected));
				})
			);
			const elapsed = performance.now() - started;
			expect(outcome.ok).toBe(false);
			expect(errorShape(outcome.ok ? undefined : outcome.error)).toMatchObject({
				code: "ISSUANCE_SUBSTRATE_FAILURE",
				retryClass: "transient",
			});
			expect(builds).toBe(1);
			expect(writerAttempts).toBe(1);
			expect(elapsed).toBeGreaterThanOrEqual(700);
			expect(elapsed).toBeLessThan(4_000);
		} finally {
			DatabaseSync.prototype.exec = originalExec;
			if (child.connected) child.send("release");
			await childExit;
			await store.close();
		}

		const poisonPrimary = primary("poison");
		const seed = createNodeDurableIssuanceStore({ primaryFilename: poisonPrimary });
		await seed.close();
		const raw = new DatabaseSync(derivedFilename(poisonPrimary));
		const candidate = phase2lCCommit(0);
		raw
			.prepare(
				"INSERT INTO issued_records(object_id,author,author_sequence,canonical_preimage,digest,signature) VALUES(?,?,?,?,?,?)"
			)
			.run(
				PHASE_2L_C_SCOPE.objectId,
				PHASE_2L_C_SCOPE.author,
				0,
				candidate.envelope.canonicalPreimageBytes,
				candidate.envelope.digest,
				candidate.envelope.signature
			);
		raw.close();
		const poisoned = createNodeDurableIssuanceStore({ primaryFilename: poisonPrimary });
		let firstFailure: unknown;
		try {
			await poisoned.transactIssue(PHASE_2L_C_SCOPE, (selected) => Promise.resolve(phase2lCCommit(selected)));
		} catch (error) {
			firstFailure = error;
		}
		expect(errorShape(firstFailure)).toMatchObject({ code: "ISSUANCE_RECOVERY_CORRUPT" });
		await expect(poisoned.readLineage(PHASE_2L_C_SCOPE)).rejects.toBe(firstFailure);
		await expect(poisoned.readOutboxPage()).rejects.toBe(firstFailure);
		await poisoned.close();
		await expect(poisoned.readLineage(PHASE_2L_C_SCOPE)).rejects.toBe(firstFailure);
	});

	it("close never awaits a suspended builder, validates malformed before closed, and MAX commits exactly once", async () => {
		const primaryFilename = primary("lifecycle");
		const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
		const store = createNodeDurableIssuanceStore({ primaryFilename });
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		let entered!: () => void;
		const ready = new Promise<void>((resolve) => (entered = resolve));
		const pending = store.transactIssue(PHASE_2L_C_SCOPE, async (selected) => {
			entered();
			await held;
			return phase2lCCommit(selected);
		});
		await ready;
		const closeA = store.close();
		expect(closeA).toBe(store.close());
		await expect(closeA).resolves.toBeUndefined();
		release();
		await expect(pending).rejects.toMatchObject({ code: "ISSUANCE_STORE_CLOSED" });

		const malformedStore = createNodeDurableIssuanceStore({ primaryFilename: primary("malformed-close") });
		let releaseMalformed!: () => void;
		const malformedHeld = new Promise<void>((resolve) => (releaseMalformed = resolve));
		const malformed = malformedStore.transactIssue(PHASE_2L_C_SCOPE, async () => {
			await malformedHeld;
			return {} as DurableIssueCommit;
		});
		await malformedStore.close();
		releaseMalformed();
		await expect(malformed).rejects.toMatchObject({ code: "ISSUANCE_COMMIT_INVALID" });

		const maxPrimary = primary("max");
		const seeded = createNodeDurableIssuanceStore({ primaryFilename: maxPrimary });
		await seeded.close();
		const raw = new DatabaseSync(derivedFilename(maxPrimary));
		raw
			.prepare("INSERT INTO lineages(object_id,author,next,exhausted) VALUES(?,?,?,?)")
			.run(PHASE_2L_C_SCOPE.objectId, PHASE_2L_C_SCOPE.author, Number.MAX_SAFE_INTEGER, 0);
		raw.close();
		const maximum = createNodeDurableIssuanceStore({ primaryFilename: maxPrimary });
		let builds = 0;
		await expect(
			maximum.transactIssue(PHASE_2L_C_SCOPE, (selected) => {
				builds++;
				return Promise.resolve(phase2lCCommit(selected));
			})
		).resolves.toMatchObject({ authorSequence: Number.MAX_SAFE_INTEGER });
		expect(await maximum.readLineage(PHASE_2L_C_SCOPE)).toEqual({
			exhausted: true,
			next: Number.MAX_SAFE_INTEGER,
		});
		await expect(
			maximum.transactIssue(PHASE_2L_C_SCOPE, (selected) => Promise.resolve(phase2lCCommit(selected)))
		).rejects.toMatchObject({
			code: "ISSUANCE_EXHAUSTED",
		});
		expect(builds).toBe(1);
		await maximum.close();
	});
});

describe("Phase 2l-c terminal suppression through the real adapter", () => {
	it("classifies all five bounded ambiguity outcomes without exposing candidate bytes", async () => {
		const originalExec = DatabaseSync.prototype.exec;
		const observations: Array<{
			candidate: DurableIssueCommit;
			caseId: string;
			outcome: Settled<DurableIssueCommit>;
		}> = [];
		for (const caseId of PHASE_2L_C_AMBIGUITY_CASES) {
			const primaryFilename = primary(`ambiguity-${caseId}`);
			const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
			const store = createNodeDurableIssuanceStore({ primaryFilename });
			let armed = true;
			let blockReadback = false;
			let builderCandidate: DurableIssueCommit | undefined;
			DatabaseSync.prototype.exec = function (sql: string): void {
				const normalized = sql.trim().toUpperCase();
				if (armed && normalized === "COMMIT") {
					armed = false;
					if (caseId === "absent-old") originalExec.call(this, "ROLLBACK");
					else {
						originalExec.call(this, sql);
						if (caseId === "foreign-pair") {
							this.exec(
								"UPDATE issued_records SET digest=X'F001',signature=X'F002';UPDATE issuance_outbox SET digest=X'F001'"
							);
						} else if (caseId === "torn-or-inconsistent") this.exec("DELETE FROM issuance_outbox");
						else if (caseId === "unreadable") blockReadback = true;
					}
					throw new Error(`suppressed terminal ${caseId}`);
				}
				if (blockReadback && normalized === "BEGIN") throw new Error("bounded readback unavailable");
				originalExec.call(this, sql);
			};
			try {
				const outcome = await settled(() =>
					store.transactIssue(PHASE_2L_C_SCOPE, (selected) => {
						builderCandidate = phase2lCCommit(selected);
						return Promise.resolve(builderCandidate);
					})
				);
				expect(builderCandidate).toBeDefined();
				observations.push({ candidate: builderCandidate as DurableIssueCommit, caseId, outcome });
				if (caseId === "torn-or-inconsistent" && !outcome.ok) {
					await expect(store.readLineage(PHASE_2L_C_SCOPE)).rejects.toBe(outcome.error);
				}
				if (caseId === "unreadable") {
					blockReadback = false;
					await expect(
						store.transactIssue(PHASE_2L_C_SCOPE, (selected) => Promise.resolve(phase2lCCommit(selected, 9)))
					).resolves.toMatchObject({ authorSequence: 1 });
				}
			} finally {
				DatabaseSync.prototype.exec = originalExec;
				await store.close();
			}
		}
		expect(observations.map(({ caseId }) => caseId)).toEqual(PHASE_2L_C_AMBIGUITY_CASES);
		expect(
			observations.map(({ outcome }) => (outcome.ok ? "RESOLVED" : Reflect.get(errorShape(outcome.error), "code")))
		).toEqual([
			"RESOLVED",
			"ISSUANCE_SUBSTRATE_FAILURE",
			"ISSUANCE_RETRY_REQUIRED",
			"ISSUANCE_RECOVERY_CORRUPT",
			"ISSUANCE_OUTCOME_UNKNOWN",
		]);
		const exact = observations[0]?.outcome;
		expect(exact?.ok).toBe(true);
		if (exact?.ok) {
			const candidate = observations[0]?.candidate as DurableIssueCommit;
			expect(exact.value).toEqual(phase2lCCommit(0));
			expect(exact.value).not.toBe(candidate);
			expect(exact.value.envelope).not.toBe(candidate.envelope);
			expect(exact.value.envelope.canonicalPreimageBytes.buffer).not.toBe(
				candidate.envelope.canonicalPreimageBytes.buffer
			);
			expect(exact.value.envelope.digest.buffer).not.toBe(candidate.envelope.digest.buffer);
			expect(exact.value.envelope.signature.buffer).not.toBe(candidate.envelope.signature.buffer);
		}
		for (const { outcome } of observations.slice(1)) {
			expect(outcome.ok).toBe(false);
			if (outcome.ok) continue;
			expect(
				Object.keys(outcome.error as object).every((key) => ["code", "name", "retryClass", "scope"].includes(key))
			).toBe(true);
			for (const key of [
				"authorSequence",
				"candidate",
				"canonicalPreimageBytes",
				"commit",
				"digest",
				"envelope",
				"signature",
				"token",
			]) {
				expect(outcome.error).not.toHaveProperty(key);
			}
		}
		const unknown = observations.find(({ caseId }) => caseId === "unreadable")?.outcome;
		expect(unknown?.ok).toBe(false);
		if (unknown !== undefined && !unknown.ok) {
			expect(Reflect.get(unknown.error as object, "scope")).toEqual(PHASE_2L_C_SCOPE);
			expect(Reflect.get(unknown.error as object, "scope")).not.toBe(PHASE_2L_C_SCOPE);
		}
	});
});
