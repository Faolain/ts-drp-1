// The recovery census is a pure read of the store's own connection. A creator's skip install calls it
// for every currency check around every source-expiry signature (resolveCreatorRetainedSourcesFromFrontier's
// valid(): before the batch, then twice per receipt), and each call re-read, re-classified and
// re-encoded every issued, outbox and plan row: O(receipts x retained rows) per install. Profiled
// (100x16 catch-up steady state, 60 hand-back records): about 108 of the install's 168 MB of canonical
// encoding were these census reads.
// The census now remembers its observation for the connection's exact revision (sqlite-revision.ts:
// total_changes, data_version, schema_version), read inside the census's own read transaction: equal
// revisions prove no row and no schema changed. Shown here: a hit does no row read and no encoding;
// every hit is a private deep copy; any write between two reads misses (this connection's write, another
// connection's commit, another connection's DDL), and the next read returns the changed rows. The memo
// lives only while one native read reservation is held (the reservation the creator's settlement turn
// holds around those currency checks): reads outside one are always full, and an ended reservation
// retains no observation (phase-2l-c's ended-probe retention bound).
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { observeCanonicalCalls } from "@ts-drp/canonical/instrumentation";
import type { DurableIssuanceStore, DurableIssueCommit } from "@ts-drp/issuance-store";
import {
	durableIssuancePruningMaintenanceForStore,
	ISSUANCE_RETIREMENT_LIMITS,
} from "@ts-drp/issuance-store/maintenance";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";

import { d109bIssue } from "../../../tests/fixtures/phase-6b/issuance-retention-contract.js";
import { nodeRecoveryCensusCounts } from "../src/internal/node-issuance-store.js";
import { createNodeDurableIssuanceStore } from "../src/issuance.js";

const directories: string[] = [];
const stores: DurableIssuanceStore[] = [];
const closers: (() => void)[] = [];
afterEach(async () => {
	observeCanonicalCalls(undefined);
	for (const close of closers.splice(0)) close();
	await Promise.all(stores.splice(0).map((store) => store.close()));
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const scope = { objectId: "census-memo-room", author: "writer" };
const contextBytes = encodeCanonical({ historicalSource: new Uint8Array(4_000).map((_, index) => index % 251) });
const context = {
	digest: hashDomain("ts-drp/settlement-source-context/v1", contextBytes),
	exactCanonicalContextBytes: contextBytes,
};

async function populatedStore(): Promise<{
	store: DurableIssuanceStore;
	primaryFilename: string;
	commits: DurableIssueCommit[];
}> {
	const directory = await mkdtemp(join(tmpdir(), "issuance-census-memo-"));
	directories.push(directory);
	const primaryFilename = join(directory, "primary.sqlite");
	const store = createNodeDurableIssuanceStore({ primaryFilename });
	stores.push(store);
	const commits: DurableIssueCommit[] = [];
	for (let epoch = 0; epoch < 4; epoch++) commits.push(await d109bIssue(store, scope, epoch));
	await store.transactWriteSettlementPlan({
		scope,
		expectedRevision: null,
		plan: {
			scope,
			revision: 0,
			fenceSequence: 3,
			sourceContexts: [context],
			entries: [0, 1].map((sequence) => ({
				sourceContextDigest: context.digest,
				sourceSequence: sequence,
				sourceDigest: commits[sequence]!.envelope.digest,
				disposition: "rebase" as const,
				replacementSequence: sequence + 2,
			})),
		},
	});
	return { store, primaryFilename, commits };
}

function census(store: DurableIssuanceStore) {
	return durableIssuancePruningMaintenanceForStore(store)!.readBoundedRecoveryCensus!({
		objectId: scope.objectId,
		limits: ISSUANCE_RETIREMENT_LIMITS,
	});
}

/**
 * Runs `run` while one native read reservation is held, as the creator's settlement turn does.
 * @param store
 * @param run
 */
async function held<T>(store: DurableIssuanceStore, run: () => Promise<T>): Promise<T> {
	const reservation = await (
		store as unknown as {
			acquireNativeReadReservation(input: { objectId: string }): Promise<{ release(): Promise<void> }>;
		}
	).acquireNativeReadReservation({ objectId: scope.objectId });
	try {
		return await run();
	} finally {
		await reservation.release();
	}
}

/**
 * Full census reads (rows read and classified) while `run` runs.
 * @param run
 */
async function fullReads(run: () => Promise<unknown>): Promise<number> {
	const before = nodeRecoveryCensusCounts().fullReads;
	await run();
	return nodeRecoveryCensusCounts().fullReads - before;
}

function rawConnection(primaryFilename: string): DatabaseSync {
	const database = new DatabaseSync(`${primaryFilename}.drp-issuance-v1.sqlite`);
	database.exec("PRAGMA busy_timeout=5000");
	// An out-of-band writer: the store's own trigger guards are not under test here.
	database.function("issuance_retirement_connection", (_objectId) => 1);
	database.function("issuance_retirement_record", (_o, _a, _s, _p, _d) => 1);
	closers.push(() => database.close());
	return database;
}

/**
 * Overwrites every byte array and empties every unfrozen array or record reachable from `value`.
 * @param value
 */
function vandalize(value: unknown): void {
	if (value instanceof Uint8Array) value.fill(0xee);
	else if (Array.isArray(value)) {
		for (const item of value) vandalize(item);
		if (!Object.isFrozen(value)) value.length = 0;
	} else if (value !== null && typeof value === "object") {
		for (const item of Object.values(value)) vandalize(item);
		if (!Object.isFrozen(value)) for (const key of Object.keys(value)) delete (value as Record<string, unknown>)[key];
	}
}

it("repeated census reads of an unchanged database read and encode the rows once", async () => {
	const { store } = await populatedStore();
	await held(store, async () => {
		const first = await census(store);
		let encodes = 0;
		observeCanonicalCalls((kind) => {
			if (kind === "encode") encodes++;
		});
		const reads = 20;
		const later: unknown[] = [];
		const full = await fullReads(async () => {
			for (let k = 0; k < reads; k++) later.push(await census(store));
		});
		observeCanonicalCalls(undefined);
		expect(full, `full census reads among ${reads} reads of an unchanged database`).toBe(0);
		expect(encodes, `canonical encodes over ${reads} reads of an unchanged database`).toBe(0);
		for (const value of later) expect(value).toEqual(first);
		expect(first.rows.issued).toHaveLength(4);
	});
}, 60_000);

it("the memo lives only while one native read reservation is held", async () => {
	const { store } = await populatedStore();
	// Outside a reservation every read is full.
	expect(
		await fullReads(async () => {
			for (let k = 0; k < 3; k++) await census(store);
		})
	).toBe(3);
	await held(store, async () => {
		expect(await fullReads(() => census(store)), "first read under a reservation").toBe(1);
		expect(await fullReads(() => census(store)), "second read under it").toBe(0);
	});
	// A new reservation starts empty: its first read is full.
	await held(store, async () => {
		expect(await fullReads(() => census(store)), "first read under the next reservation").toBe(1);
	});
}, 60_000);

it("every census answer is a private deep copy: mutating one never reaches a later read", async () => {
	const { store } = await populatedStore();
	await held(store, async () => {
		// A miss returns the read's own value and remembers a copy.
		const missed = await census(store);
		const reference = structuredClone(missed);
		vandalize(missed);
		let hit: unknown;
		expect(await fullReads(async () => (hit = await census(store))), "a hit").toBe(0);
		expect(hit).toEqual(reference);
		// A hit returns a copy: mutating it leaves the remembered value as it was.
		vandalize(hit);
		let next: unknown;
		expect(await fullReads(async () => (next = await census(store))), "still a hit").toBe(0);
		expect(next).toEqual(reference);
		expect(next).not.toBe(hit);
	});
}, 60_000);

const settled = (store: DurableIssuanceStore) => async () => {
	await census(store);
	expect(await fullReads(() => census(store)), "positive control: unchanged database hits").toBe(0);
};

// The reservation holds the database's single WAL writer lock (BEGIN IMMEDIATE on its own connection),
// so while the memo lives no other connection, and not the store's own, can commit: that exclusion is
// what the memo rests on, and the revision check stands behind it. A write is reachable only between
// reservations, and each reservation starts with an empty memo.
it("no write lands while the memo lives; any write between reservations is read by the next one", async () => {
	const { store, primaryFilename } = await populatedStore();
	const settle = settled(store);
	const raw = rawConnection(primaryFilename);
	raw.exec("PRAGMA busy_timeout=0");
	const lineage = raw.prepare("SELECT next FROM lineages WHERE object_id=?").get(scope.objectId) as { next: number };
	let after: Awaited<ReturnType<typeof census>> | undefined;
	await held(store, async () => {
		await settle();
		const before = await census(store);
		expect(() =>
			raw.prepare("UPDATE lineages SET next=? WHERE object_id=?").run(lineage.next + 1, scope.objectId)
		).toThrow(/locked|busy/iu);
		expect(() => raw.exec("CREATE TABLE census_memo_probe(a INTEGER)")).toThrow(/locked|busy/iu);
		expect(await census(store)).toEqual(before);
	});

	// The store's own connection (total_changes): it writes its settlement plan there.
	const plan = (await store.readSettlementPlan(scope))!;
	await store.transactWriteSettlementPlan({
		scope,
		expectedRevision: plan.revision,
		plan: { ...plan, revision: plan.revision + 1 },
	});
	await held(store, async () => {
		expect(await fullReads(async () => (after = await census(store))), "after the own connection's write").toBe(1);
		expect(after!.rows.plans[0]!.revision).toBe(plan.revision + 1);
		await settle();
	});
	// The store's writer connection (data_version).
	await d109bIssue(store, scope, 9);
	await held(store, async () => {
		expect(await fullReads(async () => (after = await census(store))), "after the writer connection's commit").toBe(1);
		expect(after!.rows.issued).toHaveLength(5);
		await settle();
	});
	// Another connection writes a row the census reads, then restores it: the rows end as they began.
	const unchanged = await held(store, () => census(store));
	const { next } = raw.prepare("SELECT next FROM lineages WHERE object_id=?").get(scope.objectId) as { next: number };
	raw.prepare("UPDATE lineages SET next=? WHERE object_id=?").run(next + 1, scope.objectId);
	raw.prepare("UPDATE lineages SET next=? WHERE object_id=?").run(next, scope.objectId);
	await held(store, async () => {
		expect(await fullReads(async () => (after = await census(store))), "after another connection's commits").toBe(1);
		expect(after).toEqual(unchanged);
		await settle();
	});
	// Another connection's DDL (schema_version; the catalog ends as it began).
	raw.exec("CREATE TABLE census_memo_probe(a INTEGER)");
	raw.exec("DROP TABLE census_memo_probe");
	await held(store, async () => {
		expect(await fullReads(() => census(store)), "after another connection's DDL").toBe(1);
		await settle();
	});
}, 60_000);

// The revision the memo is keyed on, on one connection inside its read transactions: every reachable
// write moves it (this connection's write, rolled back too: total_changes; another connection's commit:
// data_version; DDL: schema_version), and nothing else does.
it("the connection revision moves with every write the memo must not survive", async () => {
	const { primaryFilename } = await populatedStore();
	const { RevisionReadMemo } = await import("../src/internal/sqlite-revision.js");
	const own = rawConnection(primaryFilename);
	const other = rawConnection(primaryFilename);
	const memo = new RevisionReadMemo(4, 1 << 20);
	let loads = 0;
	const read = () => {
		own.exec("BEGIN");
		try {
			memo.begin(own);
			try {
				return memo.load("lineage", () => {
					loads++;
					return own.prepare("SELECT next FROM lineages WHERE object_id=?").get(scope.objectId) as { next: number };
				});
			} finally {
				memo.end();
			}
		} finally {
			own.exec("COMMIT");
		}
	};
	const misses = (write: () => void) => {
		read();
		const before = loads;
		read();
		expect(loads, "positive control: unchanged revision hits").toBe(before);
		write();
		read();
		return loads - before;
	};
	const { next } = read();
	expect(
		misses(() => own.prepare("UPDATE lineages SET next=? WHERE object_id=?").run(next, scope.objectId)),
		"own write (total_changes)"
	).toBe(1);
	expect(
		misses(() => {
			own.exec("BEGIN IMMEDIATE");
			own.prepare("UPDATE lineages SET next=? WHERE object_id=?").run(next + 1, scope.objectId);
			own.exec("ROLLBACK");
		}),
		"own rolled-back write (total_changes)"
	).toBe(1);
	expect(
		misses(() => other.prepare("UPDATE lineages SET next=? WHERE object_id=?").run(next + 1, scope.objectId)),
		"another connection's commit (data_version)"
	).toBe(1);
	expect(read().next, "the changed row").toBe(next + 1);
	expect(
		misses(() => own.exec("CREATE TABLE census_memo_probe(a INTEGER)")),
		"own DDL (schema_version)"
	).toBe(1);
	expect(
		misses(() => other.exec("DROP TABLE census_memo_probe")),
		"another connection's DDL"
	).toBe(1);
}, 60_000);

// The census currency probe (captureCurrentProbe) lets a creator's later checks under one held reservation
// skip the complete census when nothing changed. It was current only while its own enrollment was the
// latest, so any later census read of the same reservation (the turn reads the census several times)
// made it stale and every later check re-read everything. It is now also current while the connection's
// exact revision is the one it was captured at, under the same held reservation: equal revisions prove no
// row changed (the memo above rests on the same fact). It never outlives its reservation.
it("a census probe stays current across later census reads of its reservation, and never outlives it", async () => {
	const { store } = await populatedStore();
	const read = durableIssuancePruningMaintenanceForStore(store)!.readBoundedRecoveryCensus! as unknown as {
		(input: unknown): Promise<object>;
		captureCurrentProbe(input: unknown, observation: object): { checkCurrent(): Promise<boolean> } | undefined;
	};
	const input = { objectId: scope.objectId, limits: ISSUANCE_RETIREMENT_LIMITS };
	let probe: { checkCurrent(): Promise<boolean> } | undefined;
	await held(store, async () => {
		const observation = await read(input);
		probe = read.captureCurrentProbe.call(read, input, observation);
		expect(probe, "a probe for the latest enrolled observation").toBeDefined();
		expect(await probe!.checkCurrent(), "right after capture").toBe(true);
		for (let k = 0; k < 3; k++) await read(input);
		expect(await probe!.checkCurrent(), "after later census reads of the same reservation").toBe(true);
	});
	expect(await probe!.checkCurrent(), "after its reservation ended").toBe(false);
	await held(store, async () => {
		await read(input);
		expect(await probe!.checkCurrent(), "under a later reservation").toBe(false);
	});
}, 60_000);
