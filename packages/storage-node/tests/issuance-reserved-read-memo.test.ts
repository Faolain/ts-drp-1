// The creator's recovery dependency check (readCreatorRecoveryDependencyCensus, run by every
// checkWhile around a charged dependency turn: about 150 ms each, four per turn) re-reads the issuance
// store's outbox pages (each page validates every issued row), issued closures, settlement plans and
// lineages. While the turn holds the store's native read reservation (the WAL writer lock), those reads
// are remembered for the connection's exact revision (sqlite-revision.ts), as the recovery census is;
// every in-memory input of the check (registration, index, pending ingress, retained sources, live())
// is still evaluated afresh. Shown here: under one reservation a repeated read does no row read; every
// answer is a private deep copy; reads outside a reservation are always full and each reservation starts
// empty; no write lands while the memo lives, and writes between reservations are read by the next.
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import type { DurableIssuanceStore, DurableIssueCommit } from "@ts-drp/issuance-store";
import { createNodeDurableIssuanceStore } from "../src/issuance.js";
import { nodeIssuanceReadCounts } from "../src/internal/node-issuance-store.js";
import { d109bIssue } from "../../../tests/fixtures/phase-6b/issuance-retention-contract.js";

const directories: string[] = [];
const stores: DurableIssuanceStore[] = [];
const closers: (() => void)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0)) close();
	await Promise.all(stores.splice(0).map((store) => store.close()));
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const scope = { objectId: "reserved-read-memo-room", author: "writer" };
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
	const directory = await mkdtemp(join(tmpdir(), "issuance-reserved-read-memo-"));
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

/** Every read kind the dependency check makes, once each (two outbox pages). */
async function readAll(store: DurableIssuanceStore) {
	const first = await store.readOutboxPage({ afterKey: null, limit: 2 });
	const last = first.at(-1)!;
	const second = await store.readOutboxPage({
		afterKey: [scope.objectId, scope.author, last.commit.authorSequence],
		limit: 2,
	});
	return {
		pages: [first, second],
		issued: await store.readIssued(scope, 1),
		plan: await store.readSettlementPlan(scope),
		lineage: await store.readLineage(scope),
	};
}

/** Full reads (rows read) of every kind while `run` runs. */
async function fullReads(run: () => Promise<unknown>): Promise<number> {
	const total = () => Object.values(nodeIssuanceReadCounts()).reduce((sum, row) => sum + row.fullReads, 0);
	const before = total();
	await run();
	return total() - before;
}

function rawConnection(primaryFilename: string): DatabaseSync {
	const database = new DatabaseSync(`${primaryFilename}.drp-issuance-v1.sqlite`);
	database.exec("PRAGMA busy_timeout=0");
	database.function("issuance_retirement_connection", (_objectId) => 1);
	database.function("issuance_retirement_record", (_o, _a, _s, _p, _d) => 1);
	closers.push(() => database.close());
	return database;
}

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

it("under one reservation, repeated issuance reads of an unchanged database read the rows once per distinct read", async () => {
	const { store } = await populatedStore();
	await held(store, async () => {
		let first: Awaited<ReturnType<typeof readAll>> | undefined;
		expect(
			await fullReads(async () => (first = await readAll(store))),
			"first pass: one full read per distinct read"
		).toBe(5);
		const passes = 10;
		expect(
			await fullReads(async () => {
				for (let k = 0; k < passes; k++) expect(await readAll(store)).toEqual(first);
			}),
			`full reads over ${passes} more passes`
		).toBe(0);
		expect(first!.pages[0]).toHaveLength(2);
		expect(first!.pages[1]).toHaveLength(2);
	});
}, 60_000);

it("outside a reservation every issuance read is full, and each reservation starts empty", async () => {
	const { store } = await populatedStore();
	expect(await fullReads(() => readAll(store).then(() => readAll(store)))).toBe(10);
	await held(store, async () => {
		expect(await fullReads(() => readAll(store))).toBe(5);
		expect(await fullReads(() => readAll(store))).toBe(0);
	});
	await held(store, async () => {
		expect(await fullReads(() => readAll(store)), "the next reservation's first pass").toBe(5);
	});
}, 60_000);

it("every issuance answer is a private deep copy: mutating one never reaches a later read", async () => {
	const { store } = await populatedStore();
	await held(store, async () => {
		const missed = await readAll(store);
		const reference = structuredClone(missed);
		vandalize(missed);
		let hit: unknown;
		expect(await fullReads(async () => (hit = await readAll(store))), "a hit").toBe(0);
		expect(hit).toEqual(reference);
		vandalize(hit);
		let next: unknown;
		expect(await fullReads(async () => (next = await readAll(store))), "still a hit").toBe(0);
		expect(next).toEqual(reference);
	});
}, 60_000);

it("no write lands while the memo lives; any write between reservations is read by the next one", async () => {
	const { store, primaryFilename } = await populatedStore();
	const raw = rawConnection(primaryFilename);
	const { next } = raw.prepare("SELECT next FROM lineages WHERE object_id=?").get(scope.objectId) as { next: number };
	await held(store, async () => {
		const before = await readAll(store);
		expect(() => raw.prepare("UPDATE lineages SET next=? WHERE object_id=?").run(next + 1, scope.objectId)).toThrow(
			/locked|busy/iu
		);
		expect(() => raw.exec("CREATE TABLE reserved_read_probe(a INTEGER)")).toThrow(/locked|busy/iu);
		expect(await readAll(store)).toEqual(before);
	});
	// The store's own connection (total_changes): a settlement plan write.
	const plan = (await store.readSettlementPlan(scope))!;
	await store.transactWriteSettlementPlan({
		scope,
		expectedRevision: plan.revision,
		plan: { ...plan, revision: plan.revision + 1 },
	});
	await held(store, async () => {
		const after = await readAll(store);
		expect(after.plan!.revision).toBe(plan.revision + 1);
		expect(await fullReads(() => readAll(store))).toBe(0);
	});
	// The store's writer connection (data_version): a new issue.
	await d109bIssue(store, scope, 9);
	await held(store, async () => {
		const after = await readAll(store);
		expect(after.lineage.next).toBe(next + 1);
		expect(await store.readIssued(scope, next)).not.toBeNull();
	});
	// Another connection's DDL (schema_version; the catalog ends as it began).
	raw.exec("CREATE TABLE reserved_read_probe(a INTEGER)");
	raw.exec("DROP TABLE reserved_read_probe");
	await held(store, async () => {
		expect(await fullReads(() => readAll(store)), "after another connection's DDL").toBe(5);
	});
}, 60_000);
