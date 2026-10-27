import "fake-indexeddb/auto";

import { encodeCanonical } from "@ts-drp/canonical";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createEphemeralDurableIssuanceStore } from "../packages/issuance-store/src/conformance.js";
import {
	applySettlementPlanEffect,
	copySettlementPlan,
	copySettlementPlanEffect,
	settlementPlanHasExactEffectLink,
} from "../packages/issuance-store/src/contract.js";
import { createBrowserDurableIssuanceStore } from "../packages/storage-browser/src/issuance.js";
import { createNodeDurableIssuanceStore } from "../packages/storage-node/src/issuance.js";

// The durable hand-back record (fix/silent-writer-catchup): a move the settlement window gave back
// to the application is kept in the settlement plan (`handBacks`) until the issuance transaction of
// the row that offers it again consumes it (plan effect `hand-back`, which links the record to that
// row). The same contract path in the memory, Node (SQLite) and browser (IndexedDB) stores: exact
// readback, one consumption per record, records immutable to plan writes (an unconsumed record is
// never dropped or altered by a plan write; a consumed one may be dropped), and Node reopen.

const SCOPE = Object.freeze({ author: "author:handback-store", objectId: "room:handback-store" });
const OPERATION = encodeCanonical({ action: "placeBlock", id: "block-1-1", kind: "stone", x: 1, y: 1 });

const record = (overrides: Readonly<Record<string, unknown>> = {}) =>
	Object.freeze({
		exactCanonicalOperationBytes: new Uint8Array(OPERATION),
		intent: 0,
		reissueSequence: null,
		sourceDigest: new Uint8Array(32).fill(0xd1),
		sourceEpoch: 3,
		sourceSequence: 7,
		...overrides,
	});
const expired = Object.freeze({
	disposition: "expire",
	replacementSequence: null,
	sourceDigest: new Uint8Array(32).fill(0xd1),
	sourceSequence: 7,
});
const plan = (revision: number, handBacks: readonly unknown[] | undefined, fenceSequence: number | null = 4) =>
	Object.freeze({
		entries: Object.freeze([expired]),
		fenceSequence,
		...(handBacks === undefined ? {} : { handBacks: Object.freeze([...handBacks]) }),
		revision,
		scope: SCOPE,
	});
const effect = (intent = 0) => Object.freeze({ intent, kind: "hand-back", sourceSequence: 7 });

function commit(authorSequence: number, planEffect: unknown) {
	const canonicalPreimageBytes = encodeCanonical({
		author: SCOPE.author,
		authorSequence,
		epoch: 5,
		kind: "drp-vertex",
		logicalTime: 21,
		objectId: SCOPE.objectId,
		operation: { action: "placeBlock", id: "block-1-1", kind: "stone", x: 1, y: 1 },
		protocolMajor: 3,
	});
	const envelope = Object.freeze({
		canonicalPreimageBytes,
		digest: new Uint8Array(32).fill(authorSequence + 1),
		signature: new Uint8Array(64).fill(authorSequence + 1),
	});
	return Object.freeze({
		authorSequence,
		envelope,
		issuedRecord: Object.freeze({ authorSequence, envelope, scope: SCOPE }),
		outboxEntry: Object.freeze({ authorSequence, envelope, scope: SCOPE }),
		planEffect,
	});
}

const snapshot = (value: unknown): unknown => {
	if (value === null || typeof value !== "object") return value;
	if (value instanceof Uint8Array) return [...value];
	if (Array.isArray(value)) return value.map(snapshot);
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, snapshot(entry)]));
};
const failure = async (promise: Promise<unknown>) =>
	promise.then(
		() => undefined,
		(error: unknown) => error
	);
const code = (error: unknown) => (error !== null && typeof error === "object" ? Reflect.get(error, "code") : undefined);

interface Store {
	close(): Promise<void>;
	readLineage(scope: unknown): Promise<Readonly<{ next: number }>>;
	readSettlementPlan(scope: unknown): Promise<unknown>;
	transactIssue(scope: unknown, build: (sequence: number) => Promise<unknown>): Promise<unknown>;
	transactWriteSettlementPlan(input: unknown): Promise<unknown>;
}
const directories: string[] = [];
let browserId = 0;
async function openStore(kind: "browser" | "memory" | "node", directory?: string): Promise<Store> {
	if (kind === "memory") return createEphemeralDurableIssuanceStore() as unknown as Store;
	if (kind === "browser")
		return (await createBrowserDurableIssuanceStore({ primaryDatabaseName: `handback-${browserId++}` })) as unknown as Store;
	const selected = directory ?? (await mkdtemp(join(tmpdir(), "handback-store-")));
	if (directory === undefined) directories.push(selected);
	return createNodeDurableIssuanceStore({ primaryFilename: join(selected, "primary.sqlite") }) as unknown as Store;
}
afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

/** Issues sequences up to (not including) `through` without effects, so the lineage reaches it. */
async function advance(store: Store, through: number) {
	for (let next = (await store.readLineage(SCOPE)).next; next < through; next++)
		await store.transactIssue(SCOPE, (sequence) => {
			const built = commit(sequence, undefined) as Record<string, unknown>;
			const { planEffect: _effect, ...plain } = built;
			return Promise.resolve(plain);
		});
}

describe("settlement hand-back record contract", () => {
	it("copies, applies and links a hand-back record exactly", () => {
		const copied = copySettlementPlan(plan(0, [record()]), SCOPE);
		expect(snapshot(copied)).toEqual(snapshot(plan(0, [record()])));
		expect(snapshot(copySettlementPlanEffect(effect()))).toEqual(snapshot(effect()));
		const linked = applySettlementPlanEffect(copied!, copySettlementPlanEffect(effect())!, 9);
		expect(snapshot(linked)).toEqual(snapshot(plan(1, [record({ reissueSequence: 9 })])));
		expect(settlementPlanHasExactEffectLink(linked, copySettlementPlanEffect(effect())!, 9)).toBe(true);
		expect(settlementPlanHasExactEffectLink(copied, copySettlementPlanEffect(effect())!, 9)).toBe(false);
		// One consumption per record.
		expect(() => applySettlementPlanEffect(linked, copySettlementPlanEffect(effect())!, 10)).toThrow();
		// No record for that intent.
		expect(() => applySettlementPlanEffect(copied!, copySettlementPlanEffect(effect(1))!, 9)).toThrow();
	});

	it("refuses malformed records and effects", () => {
		for (const bad of [
			[],
			[record({ intent: -1 })],
			[record({ exactCanonicalOperationBytes: new Uint8Array(0) })],
			[record({ sourceDigest: new Uint8Array(31) })],
			[record({ reissueSequence: 7 })],
			[record(), record()],
			[record({ intent: 1 }), record()],
			[{ ...record(), extra: 1 }],
			Array.from({ length: 65 }, (_, intent) => record({ intent })),
			[record({ exactCanonicalOperationBytes: new Uint8Array(40_000).fill(1) })],
		])
			expect(copySettlementPlan(plan(0, bad), SCOPE), JSON.stringify(snapshot(bad)).slice(0, 80)).toBeUndefined();
		expect(copySettlementPlanEffect({ kind: "hand-back", sourceSequence: 7 })).toBeUndefined();
		expect(copySettlementPlanEffect({ intent: -1, kind: "hand-back", sourceSequence: 7 })).toBeUndefined();
		expect(copySettlementPlanEffect({ extra: 1, intent: 0, kind: "hand-back", sourceSequence: 7 })).toBeUndefined();
	});

	for (const kind of ["memory", "node", "browser"] as const) {
		it(`${kind}: stores, consumes once in the issuance transaction, and protects unconsumed records`, async () => {
			const store = await openStore(kind);
			try {
				await advance(store, 8);
				await store.transactWriteSettlementPlan({ expectedRevision: null, plan: plan(0, [record()]), scope: SCOPE });
				expect(snapshot(await store.readSettlementPlan(SCOPE))).toEqual(snapshot(plan(0, [record()])));
				// A plan write never drops, alters or pre-links an unconsumed record.
				for (const candidate of [
					plan(1, undefined),
					plan(1, [record({ exactCanonicalOperationBytes: new Uint8Array([1]) })]),
					plan(1, [record({ reissueSequence: 8 })]),
					plan(1, [record(), record({ intent: 1, reissueSequence: 8 })]),
				])
					expect(
						code(await failure(store.transactWriteSettlementPlan({ expectedRevision: 0, plan: candidate, scope: SCOPE }))),
						JSON.stringify(snapshot(candidate)).slice(0, 120)
					).toBe("ISSUANCE_RETRY_REQUIRED");
				// The reissued row consumes it in its own issuance transaction.
				await store.transactIssue(SCOPE, (sequence) => Promise.resolve(commit(sequence, effect())));
				expect(snapshot(await store.readSettlementPlan(SCOPE))).toEqual(
					snapshot(plan(1, [record({ reissueSequence: 8 })]))
				);
				// A second row cannot consume it again; nothing is issued.
				expect(
					code(await failure(store.transactIssue(SCOPE, (sequence) => Promise.resolve(commit(sequence, effect())))))
				).toBe("ISSUANCE_RETRY_REQUIRED");
				expect((await store.readLineage(SCOPE)).next).toBe(9);
				// Unlinking a consumed record is refused; dropping it is allowed.
				expect(
					code(
						await failure(
							store.transactWriteSettlementPlan({ expectedRevision: 1, plan: plan(2, [record()]), scope: SCOPE })
						)
					)
				).toBe("ISSUANCE_RETRY_REQUIRED");
				await store.transactWriteSettlementPlan({ expectedRevision: 1, plan: plan(2, undefined), scope: SCOPE });
				expect(snapshot(await store.readSettlementPlan(SCOPE))).toEqual(snapshot(plan(2, undefined)));
			} finally {
				await store.close();
			}
		});
	}

	it("node: an unconsumed record survives reopen and is consumed after it", async () => {
		const directory = await mkdtemp(join(tmpdir(), "handback-store-reopen-"));
		directories.push(directory);
		let store = await openStore("node", directory);
		await advance(store, 8);
		await store.transactWriteSettlementPlan({
			expectedRevision: null,
			plan: plan(0, [record(), record({ intent: 1 })]),
			scope: SCOPE,
		});
		await store.close();
		store = await openStore("node", directory);
		try {
			expect(snapshot(await store.readSettlementPlan(SCOPE))).toEqual(snapshot(plan(0, [record(), record({ intent: 1 })])));
			await store.transactIssue(SCOPE, (sequence) => Promise.resolve(commit(sequence, effect(1))));
			expect(snapshot(await store.readSettlementPlan(SCOPE))).toEqual(
				snapshot(plan(1, [record(), record({ intent: 1, reissueSequence: 8 })]))
			);
		} finally {
			await store.close();
		}
	});
});
