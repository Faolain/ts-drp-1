import {
	type AheDurableStore,
	digestBlob,
	type ExpectedHead,
	type GenerationId,
	parseGenerationId,
	parseStorageObjectId,
	type StorageObjectId,
} from "@ts-drp/storage";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";

import { phase2lCCommit, PHASE_2L_C_SCOPE } from "./fixtures/phase-2l-c-node-issuance-contract.js";
import { fixture, receiptFor } from "../../../tests/fixtures/snapshot-recovery-owner/contract.js";
import { createSqliteAheDurableStore } from "../src/index.js";
import { LocalSessionLifetime } from "../src/internal/local-session-lifetime.js";
import { cachedStatement } from "../src/internal/sqlite-statement-cache.js";
import { createNodeDurableIssuanceStore } from "../src/issuance.js";
import { createNodeSnapshotQuarantineStore } from "../src/snapshot-transfer.js";

// Every StatementSync is the product of exactly one native DatabaseSync#prepare
// (the class cannot be constructed directly). Counting the distinct statement
// objects that execute therefore counts native prepares, without interposing on
// DatabaseSync.prototype.prepare: an interposed prepare deliberately routes every
// acquisition through the interposer uncached, so it cannot be the counter here.
type Method = "all" | "get" | "iterate" | "run";
const METHODS: readonly Method[] = ["all", "get", "iterate", "run"];

interface Census {
	/** Distinct statements that executed through all/get/run (never iterate). */
	readonly settled: Set<StatementSync>;
	/** Distinct statements that executed through iterate. */
	readonly streamed: Set<StatementSync>;
	stop(): void;
}

function census(): Census {
	const prototype = StatementSync.prototype as unknown as Record<Method, (...args: unknown[]) => unknown>;
	const originals = new Map<Method, (...args: unknown[]) => unknown>(METHODS.map((name) => [name, prototype[name]]));
	const settled = new Set<StatementSync>();
	const streamed = new Set<StatementSync>();
	for (const [name, original] of originals) {
		prototype[name] = function (this: StatementSync, ...args: unknown[]): unknown {
			(name === "iterate" ? streamed : settled).add(this);
			return Reflect.apply(original, this, args);
		};
	}
	return {
		settled,
		streamed,
		stop(): void {
			for (const [name, original] of originals) prototype[name] = original;
		},
	};
}

interface Growth {
	/** Statements first seen per operation after warm-up, by execution kind. */
	readonly settledPerOperation: number;
	readonly streamedPerOperation: number;
	readonly microsecondsPerOperation: number;
}

async function growth(operation: (index: number) => Promise<unknown>, warm = 3, measured = 12): Promise<Growth> {
	const warmCensus = census();
	try {
		for (let index = 0; index < warm; index++) await operation(index);
	} finally {
		warmCensus.stop();
	}
	const window = census();
	const started = process.hrtime.bigint();
	try {
		for (let index = warm; index < warm + measured; index++) await operation(index);
	} finally {
		window.stop();
	}
	const elapsed = Number(process.hrtime.bigint() - started) / 1000;
	const fresh = (set: Set<StatementSync>, seen: Set<StatementSync>): number =>
		[...set].filter((statement) => !seen.has(statement)).length;
	return {
		settledPerOperation: fresh(window.settled, warmCensus.settled) / measured,
		streamedPerOperation: fresh(window.streamed, warmCensus.streamed) / measured,
		microsecondsPerOperation: Math.round(elapsed / measured),
	};
}

const directories: string[] = [];
function directory(label: string): string {
	const selected = mkdtempSync(join(tmpdir(), `ts-drp-statement-cache-${label}-`));
	directories.push(selected);
	return selected;
}
afterEach(() => {
	for (const selected of directories.splice(0)) rmSync(selected, { force: true, recursive: true });
});

function must<T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason?: unknown }>): T {
	if (!result.ok) throw new TypeError(`statement-cache fixture failed: ${String(result.reason)}`);
	return result.value;
}

const OBJECT = must(parseStorageObjectId(`statement-cache:${"a".repeat(32)}`));
const GENERATION_A = must(parseGenerationId("a".repeat(64)));
const GENERATION_B = must(parseGenerationId("b".repeat(64)));

async function adopt(
	store: AheDurableStore,
	generationId: GenerationId,
	payload: Uint8Array,
	head: ExpectedHead
): Promise<ExpectedHead> {
	const digest = must(digestBlob(payload));
	must(
		await store.beginGeneration({
			baseExpectedHead: head,
			closure: [{ byteLength: payload.byteLength, digest }],
			generationId,
			objectId: OBJECT,
		})
	);
	must(await store.putCachedBlob({ bytes: payload, digest, generationId, objectId: OBJECT }));
	must(await store.promoteReference({ digest, generationId, objectId: OBJECT }));
	must(await store.completeGeneration({ generationId, objectId: OBJECT }));
	return must(await store.swapHead({ expectedHead: head, generationId, objectId: OBJECT })).head;
}

interface RetirementImageReader {
	readRetirementAdmissionImage(
		objectId: StorageObjectId
	): Promise<Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false; reason: string }>>;
}
type RecoveryLookup = {
	lookupRecoveryDeclaration(input: unknown): Promise<unknown>;
	readRetirementAdmissionImage(input: Readonly<{ objectId: string }>): Promise<unknown>;
};

async function seededAheStore(filename: string): Promise<AheDurableStore & RetirementImageReader> {
	const store = createSqliteAheDurableStore({ filename }) as AheDurableStore & RetirementImageReader;
	await adopt(store, GENERATION_A, Uint8Array.of(1, 2, 3), { kind: "none", objectId: OBJECT });
	return store;
}

async function seededSnapshotStore(
	primaryFilename: string,
	session?: LocalSessionLifetime
): Promise<Readonly<{ store: ReturnType<typeof createNodeSnapshotQuarantineStore> & RecoveryLookup; scope: unknown }>> {
	const store = createNodeSnapshotQuarantineStore({ primaryFilename }, session) as ReturnType<
		typeof createNodeSnapshotQuarantineStore
	> &
		RecoveryLookup;
	const selected = fixture("statement-cache-snapshot");
	const scope = await store.openScope(selected.declaration);
	await scope.complete(await receiptFor(scope as never, selected));
	await (scope as unknown as { retainForRecovery(): Promise<unknown> }).retainForRecovery();
	return { store, scope: selected.declaration.scope };
}

describe("native SQLite statement preparation is amortized per connection", () => {
	it("issues without re-preparing settled statements after warm-up", async () => {
		const store = createNodeDurableIssuanceStore({ primaryFilename: join(directory("issue"), "primary.sqlite") });
		try {
			const result = await growth(async () => {
				const issued = await store.transactIssue(PHASE_2L_C_SCOPE, (sequence) =>
					Promise.resolve(phase2lCCommit(sequence))
				);
				await store.readLineage(PHASE_2L_C_SCOPE);
				await store.readIssued(PHASE_2L_C_SCOPE, issued.authorSequence);
				await store.readSettlementPlan(PHASE_2L_C_SCOPE);
			});
			console.info("issuance issue+reads", result);
			expect(result.settledPerOperation).toBe(0);
		} finally {
			await store.close();
		}
	});

	it("reads bounded AHE retirement images without re-preparing settled statements after warm-up", async () => {
		const store = await seededAheStore(join(directory("bounded"), "store.sqlite"));
		try {
			const result = await growth(async () => {
				must(await store.readRetirementAdmissionImage(OBJECT));
				must(await store.readHead(OBJECT));
			});
			console.info("ahe bounded retirement image read", result);
			expect(result.settledPerOperation).toBe(0);
		} finally {
			await store.close();
		}
	});

	it("reads snapshot recovery metadata without re-preparing settled statements after warm-up", async () => {
		const { store, scope } = await seededSnapshotStore(join(directory("recovery"), "primary.sqlite"));
		try {
			const objectId = (scope as { objectId: string }).objectId;
			const result = await growth(async () => {
				expect(await store.lookupRecoveryDeclaration(scope)).toMatchObject({ kind: "present" });
				await store.readRetirementAdmissionImage({ objectId });
			});
			console.info("snapshot recovery metadata lookup", result);
			expect(result.settledPerOperation).toBe(0);
		} finally {
			await store.close();
		}
	});
});

describe("native SQLite statements never outlive their connection incarnation", () => {
	it("shares no statement between a closed store and its reopened successor", async () => {
		const filename = join(directory("reopen"), "store.sqlite");
		const first = await seededAheStore(filename);
		const before = census();
		try {
			for (let index = 0; index < 3; index++) {
				must(await first.readRetirementAdmissionImage(OBJECT));
				must(await first.readHead(OBJECT));
			}
		} finally {
			before.stop();
		}
		await first.close();
		expect(await first.readHead(OBJECT)).toEqual({ ok: false, reason: "STORE_CLOSED" });
		const second = createSqliteAheDurableStore({ filename }) as AheDurableStore & RetirementImageReader;
		const after = census();
		try {
			for (let index = 0; index < 3; index++) {
				must(await second.readRetirementAdmissionImage(OBJECT));
				must(await second.readHead(OBJECT));
			}
		} finally {
			after.stop();
			await second.close();
		}
		expect(before.settled.size).toBeGreaterThan(0);
		expect(after.settled.size).toBeGreaterThan(0);
		expect([...after.settled].filter((statement) => before.settled.has(statement))).toEqual([]);
	});

	it("executes no statement after the store latches poison", async () => {
		const filename = join(directory("poison"), "store.sqlite");
		const store = await seededAheStore(filename);
		const recoverActive = (): Promise<unknown> =>
			Reflect.apply(Reflect.get(store, "recoverActiveGeneration") as (id: unknown) => Promise<unknown>, store, [
				OBJECT,
			]);
		try {
			const head = must(await store.readHead(OBJECT));
			const digest = must(digestBlob(Uint8Array.of(4, 5, 6)));
			must(
				await store.beginGeneration({
					baseExpectedHead: head,
					closure: [{ byteLength: 3, digest }],
					generationId: GENERATION_B,
					objectId: OBJECT,
				})
			);
			for (let index = 0; index < 3; index++) {
				expect(await recoverActive()).toMatchObject({ ok: true });
				must(await store.readRetirementAdmissionImage(OBJECT));
			}
			const foreign = new DatabaseSync(filename);
			try {
				foreign.exec(`UPDATE generations SET record = X'00' WHERE generation_id = '${GENERATION_B}'`);
			} finally {
				foreign.close();
			}
			expect(await recoverActive()).toMatchObject({ ok: false, reason: "NON_CANONICAL_RECORD" });
			const after = census();
			try {
				expect(await store.readHead(OBJECT)).toEqual({ ok: false, reason: "STORE_POISONED" });
				expect(await recoverActive()).toEqual({ ok: false, reason: "STORE_POISONED" });
				expect(await store.readRetirementAdmissionImage(OBJECT)).toEqual({ ok: false, reason: "STORE_POISONED" });
			} finally {
				after.stop();
			}
			expect(after.settled.size + after.streamed.size).toBe(0);
		} finally {
			await store.close();
		}
	});

	it("executes no statement after its local session is revoked", async () => {
		const session = new LocalSessionLifetime(
			() => undefined,
			() => ({ release: (): void => undefined })
		);
		const { store, scope } = await seededSnapshotStore(join(directory("revoked"), "primary.sqlite"), session);
		try {
			for (let index = 0; index < 3; index++) await store.lookupRecoveryDeclaration(scope);
			session.revoke();
			const after = census();
			let refused: unknown;
			try {
				refused = await store.lookupRecoveryDeclaration(scope).catch((error: unknown) => error);
			} finally {
				after.stop();
			}
			expect(refused).toBeInstanceOf(Error);
			expect(after.settled.size + after.streamed.size).toBe(0);
		} finally {
			await store.close().catch(() => undefined);
		}
	});
});

describe("per-connection statement cache lifetime", () => {
	const SQL = "SELECT ?1 AS value";

	it("reuses one statement per connection and exact text, never across connections", () => {
		const first = new DatabaseSync(":memory:");
		const second = new DatabaseSync(":memory:");
		try {
			const statement = cachedStatement(first, SQL);
			expect(cachedStatement(first, SQL)).toBe(statement);
			expect(cachedStatement(first, `${SQL} `)).not.toBe(statement);
			expect(cachedStatement(second, SQL)).not.toBe(statement);
			// Reuse is equivalent to a fresh statement: bindings never leak between calls.
			expect(cachedStatement(first, "SELECT ?1 AS a, ?2 AS b").get(1, 2)).toEqual({ a: 1, b: 2 });
			expect(cachedStatement(first, "SELECT ?1 AS a, ?2 AS b").get(3)).toEqual({ a: 3, b: null });
			expect(typeof cachedStatement(first, "SELECT 1 AS one").get()?.one).toBe("number");
		} finally {
			first.close();
			second.close();
		}
	});

	it("never returns a statement after its connection closes", () => {
		const database = new DatabaseSync(":memory:");
		const statement = cachedStatement(database, SQL);
		database.close();
		let returned: unknown;
		let refused: unknown;
		try {
			returned = cachedStatement(database, SQL);
		} catch (error) {
			refused = error;
		}
		// Identity comparisons stay boolean: a finalized statement throws on inspection.
		expect(returned === statement).toBe(false);
		expect(returned).toBeUndefined();
		expect(refused).toMatchObject({ code: "ERR_INVALID_STATE", message: "database is not open" });
	});

	it("never reuses a statement across close and reopen of the same connection object", () => {
		const database = new DatabaseSync(":memory:");
		try {
			const statement = cachedStatement(database, SQL);
			expect(statement.get(1)).toEqual({ value: 1 });
			database.close();
			database.open();
			const reopened = cachedStatement(database, SQL);
			expect(reopened === statement).toBe(false);
			expect(reopened.get(2)).toEqual({ value: 2 });
			expect(cachedStatement(database, SQL) === reopened).toBe(true);
		} finally {
			database.close();
		}
	});

	it("never reuses a statement in a replacement connection to the same file", () => {
		const filename = join(directory("replacement"), "replacement.sqlite");
		const first = new DatabaseSync(filename);
		const statement = cachedStatement(first, SQL);
		first.close();
		const replacement = new DatabaseSync(filename);
		try {
			expect(cachedStatement(replacement, SQL) === statement).toBe(false);
		} finally {
			replacement.close();
		}
	});

	it("retains no closed connection: connection history never accumulates in the heap", async () => {
		// A cached StatementSync holds its DatabaseSync through a native strong
		// reference, so a cache entry that outlives close() pins the connection
		// (and every cached statement) for the life of the process regardless of
		// JavaScript reachability. Closed connections must become collectable.
		setFlagsFromString("--expose-gc");
		const gc = runInNewContext("gc") as () => void;
		const collect = async (): Promise<void> => {
			for (let round = 0; round < 4; round++) {
				await new Promise((resolve) => setImmediate(resolve));
				gc();
			}
		};
		const filename = join(directory("history"), "history.sqlite");
		const seed = new DatabaseSync(filename);
		seed.exec("CREATE TABLE t(x)");
		seed.close();
		const alive = async (connections: number): Promise<number> => {
			const references: WeakRef<DatabaseSync>[] = [];
			for (let index = 0; index < connections; index++) {
				const database = new DatabaseSync(filename);
				references.push(new WeakRef(database));
				cachedStatement(database, "SELECT count(*) AS rows FROM t").get();
				cachedStatement(database, SQL).get(index);
				database.close();
			}
			await collect();
			return references.filter((reference) => reference.deref() !== undefined).length;
		};
		// Retained closed connections are bounded by a constant (the cache's sweep
		// slack), never by how many connections were ever opened.
		const retained = { after32: await alive(32), after256: await alive(256) };
		expect(Math.max(retained.after32, retained.after256), JSON.stringify(retained)).toBeLessThanOrEqual(16);
	});

	it("routes every acquisition through an interposed prepare, uncached", () => {
		const database = new DatabaseSync(":memory:");
		const native = DatabaseSync.prototype.prepare;
		try {
			const cached = cachedStatement(database, SQL);
			let interposed = 0;
			DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string): StatementSync {
				interposed++;
				return Reflect.apply(native, this, [sql]) as StatementSync;
			};
			const during = [cachedStatement(database, SQL), cachedStatement(database, SQL)];
			expect(interposed).toBe(2);
			expect(during[0]).not.toBe(cached);
			expect(during[1]).not.toBe(during[0]);
			DatabaseSync.prototype.prepare = native;
			expect(cachedStatement(database, SQL)).toBe(cached);
		} finally {
			DatabaseSync.prototype.prepare = native;
			database.close();
		}
	});

	it("reports the native prepare cost it removes (informational)", () => {
		const database = new DatabaseSync(":memory:");
		try {
			database.exec("CREATE TABLE t(object_id TEXT, record BLOB)");
			const sql =
				"SELECT length(record) AS size,CASE WHEN typeof(record)='blob' AND length(record) BETWEEN 1 AND 65536 THEN record ELSE NULL END AS record FROM t WHERE object_id=?";
			const rounds = 20_000;
			const time = (run: () => void): number => {
				const started = process.hrtime.bigint();
				for (let index = 0; index < rounds; index++) run();
				return Number(process.hrtime.bigint() - started) / rounds;
			};
			time(() => database.prepare(sql).get("x"));
			const fresh = time(() => database.prepare(sql).get("x"));
			const cached = time(() => cachedStatement(database, sql).get("x"));
			console.info("prepare+get vs cached+get (ns per call)", { fresh: Math.round(fresh), cached: Math.round(cached) });
			expect(cached).toBeLessThan(fresh);
		} finally {
			database.close();
		}
	});
});
