/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-non-null-assertion -- Fixture builders keep their inferred record types; each asserted effect was copied a line earlier by the test. */
import "fake-indexeddb/auto";

import { encodeCanonical } from "@ts-drp/canonical";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createEphemeralDurableIssuanceStore } from "../packages/issuance-store/src/conformance.js";
import {
	applySettlementPlanEffect,
	assertSettlementPlanProgressTransition,
	copySettlementPlan,
	copySettlementPlanEffect,
	isClosedDurableIssuanceRecord,
	settlementBacklogMoves,
	settlementHandBacksAtOrigin,
	settlementHandBacksWith,
	settlementMoveOrigin,
	settlementPlanHasExactEffectLink,
	settlementReissueLastCarrier,
	settlementReissueOriginsUnsettled,
	settlementWindowHandBacks,
} from "../packages/issuance-store/src/contract.js";
import { SETTLEMENT_HAND_BACK_LIMITS, type SettlementPlan } from "../packages/issuance-store/src/types.js";
import { createBrowserDurableIssuanceStore } from "../packages/storage-browser/src/issuance.js";
import { createNodeDurableIssuanceStore } from "../packages/storage-node/src/issuance.js";

// Track 46 (given-back author order): a hand-back record carries its move's origin
// (SettlementHandBack.originSequence, written only when it differs from the record's row), records are
// ordered by origin, and the reissued row's own issuance transaction maps that row back to the origin
// (SettlementPlan.reissueOrigins), atomically with the record's consumption. The same contract path in
// the memory, Node (SQLite) and browser (IndexedDB) stores. An entry is dropped only when the move
// settles (its chain's last carrier admitted on the signed frontier, or expired with the new record
// taking the origin), never by a replacement. Records and entries have separate bounds: the record
// bound counts unconsumed records only.

const SCOPE = Object.freeze({ author: "author:reissue-origins", objectId: "room:reissue-origins" });
const MOVE = { action: "placeBlock", id: "block-1-1", kind: "stone", x: 1, y: 1 };
const OPERATION = encodeCanonical(MOVE);

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
const expired = (sourceSequence = 7) =>
	Object.freeze({
		disposition: "expire",
		replacementSequence: null,
		sourceDigest: new Uint8Array(32).fill(0xd1),
		sourceSequence,
	});
const plan = (
	revision: number,
	fields: Readonly<{
		handBacks?: readonly unknown[];
		reissueOrigins?: readonly unknown[];
		entries?: readonly unknown[];
	}> = {}
) =>
	Object.freeze({
		entries: Object.freeze([...(fields.entries ?? [expired()])]),
		fenceSequence: 4,
		...(fields.handBacks === undefined ? {} : { handBacks: Object.freeze([...fields.handBacks]) }),
		...(fields.reissueOrigins === undefined ? {} : { reissueOrigins: Object.freeze([...fields.reissueOrigins]) }),
		revision,
		scope: SCOPE,
	});
const origin = (reissueSequence: number, originSequence: number) => Object.freeze({ originSequence, reissueSequence });
const effect = (fields: Readonly<Record<string, unknown>> = {}) =>
	Object.freeze({ intent: 0, kind: "hand-back", sourceSequence: 7, ...fields });

function commit(authorSequence: number, planEffect: unknown) {
	const canonicalPreimageBytes = encodeCanonical({
		author: SCOPE.author,
		authorSequence,
		epoch: 5,
		kind: "drp-vertex",
		logicalTime: 21,
		objectId: SCOPE.objectId,
		operation: MOVE,
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
		...(planEffect === undefined ? {} : { planEffect }),
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
const thrown = (run: () => unknown): unknown => {
	try {
		run();
	} catch (error) {
		return error;
	}
	return undefined;
};
const copied = (value: unknown): SettlementPlan => {
	const result = copySettlementPlan(value, SCOPE);
	if (result === undefined) throw new Error("fixture plan invalid");
	return result;
};

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
		return (await createBrowserDurableIssuanceStore({
			primaryDatabaseName: `reissue-origins-${browserId++}`,
		})) as unknown as Store;
	const selected = directory ?? (await mkdtemp(join(tmpdir(), "reissue-origins-store-")));
	if (directory === undefined) directories.push(selected);
	return createNodeDurableIssuanceStore({ primaryFilename: join(selected, "primary.sqlite") }) as unknown as Store;
}
afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

/**
 * Issues sequences up to (not including) `through` without effects, so the lineage reaches it.
 * @param store - The store under test.
 * @param through - The first sequence not issued.
 */
async function advance(store: Store, through: number): Promise<void> {
	for (let next = (await store.readLineage(SCOPE)).next; next < through; next++)
		await store.transactIssue(SCOPE, (sequence) => Promise.resolve(commit(sequence, undefined)));
}

describe("settlement reissue origins: codec", () => {
	it("orders records by origin, then carrier row, then intent", () => {
		// The record of row 9 whose move began at 2 sorts before the record of row 7 (origin 7).
		const older = record({ sourceSequence: 9, originSequence: 2 });
		const merged = settlementHandBacksWith([record()], [older]);
		expect(merged?.map((value) => value.sourceSequence)).toEqual([9, 7]);
		expect(copySettlementPlan(plan(0, { handBacks: [older, record()] }), SCOPE)).toBeDefined();
		expect(copySettlementPlan(plan(0, { handBacks: [record(), older] }), SCOPE)).toBeUndefined();
		// Two chunks of one move (same origin) keep their rows' order.
		const chunks = settlementHandBacksWith(undefined, [
			record({ sourceSequence: 12, originSequence: 3 }),
			record({ sourceSequence: 11, originSequence: 3 }),
		]);
		expect(chunks?.map((value) => value.sourceSequence)).toEqual([11, 12]);
	});

	it("reads a plan written before the fields exactly as before (origin = source)", () => {
		const old = copied(plan(0, { handBacks: [record(), record({ intent: 1 })] }));
		expect(Object.hasOwn(old, "reissueOrigins")).toBe(false);
		expect(old.handBacks?.every((value) => !Object.hasOwn(value, "originSequence"))).toBe(true);
		expect(settlementMoveOrigin(old, 7)).toEqual({ originSequence: 7 });
		// Byte-identical: nothing new is written for a store that never reissues.
		expect(encodeCanonical(old)).toEqual(encodeCanonical(plan(0, { handBacks: [record(), record({ intent: 1 })] })));
	});

	it("refuses malformed origins and entries", () => {
		for (const bad of [
			[record({ originSequence: 7 })], // equal to the source: written only when it differs
			[record({ originSequence: 8 })], // newer than the source
			[record({ originSequence: -1 })],
			[record({ originSequence: null })],
		])
			expect(copySettlementPlan(plan(0, { handBacks: bad }), SCOPE)).toBeUndefined();
		for (const bad of [
			[],
			[origin(9, 9)],
			[origin(9, 10)],
			[origin(9, 2), origin(9, 3)],
			[origin(10, 2), origin(9, 3)],
			[{ ...origin(9, 2), extra: 1 }],
			Array.from({ length: SETTLEMENT_HAND_BACK_LIMITS.maxRecords + 1 }, (_, index) => origin(100 + index, 1)),
		])
			expect(
				copySettlementPlan(plan(0, { reissueOrigins: bad }), SCOPE),
				JSON.stringify(bad).slice(0, 60)
			).toBeUndefined();
		expect(copySettlementPlanEffect(effect({ originSequence: 8 }))).toBeUndefined();
		expect(copySettlementPlanEffect(effect({ originSequence: -1 }))).toBeUndefined();
		expect(snapshot(copySettlementPlanEffect(effect({ originSequence: 2 })))).toEqual(
			snapshot(effect({ originSequence: 2 }))
		);
		expect(snapshot(copySettlementPlanEffect(effect()))).toEqual(snapshot(effect()));
	});

	it("older readers refuse a plan carrying either field at open (closed record)", () => {
		// The closed key sets of the plan and record readers before track 46.
		const olderPlanKeys = ["entries", "fenceSequence", "handBacks", "revision", "scope"];
		const olderRecordKeys = [
			"exactCanonicalOperationBytes",
			"intent",
			"reissueSequence",
			"sourceDigest",
			"sourceEpoch",
			"sourceSequence",
		];
		const withEntry = copied(plan(0, { handBacks: [record({ reissueSequence: 9 })], reissueOrigins: [origin(9, 7)] }));
		expect(isClosedDurableIssuanceRecord(withEntry, olderPlanKeys)).toBe(false);
		const withOrigin = copied(plan(0, { handBacks: [record({ sourceSequence: 9, originSequence: 2 })] }));
		expect(isClosedDurableIssuanceRecord(withOrigin, olderPlanKeys)).toBe(true);
		expect(isClosedDurableIssuanceRecord(withOrigin.handBacks?.[0], olderRecordKeys)).toBe(false);
		// Without either field the old readers accept the plan.
		const old = copied(plan(0, { handBacks: [record()] }));
		expect(isClosedDurableIssuanceRecord(old, olderPlanKeys)).toBe(true);
		expect(isClosedDurableIssuanceRecord(old.handBacks?.[0], olderRecordKeys)).toBe(true);
	});

	it("the hand-back effect adds the entry with the record's origin, atomically with consumption", () => {
		const base = copied(
			plan(0, { handBacks: [record({ sourceSequence: 9, originSequence: 2 })], entries: [expired(9)] })
		);
		const linked = applySettlementPlanEffect(
			base,
			copySettlementPlanEffect(effect({ sourceSequence: 9, originSequence: 2 }))!,
			12
		);
		expect(snapshot(linked.reissueOrigins)).toEqual(snapshot([origin(12, 2)]));
		expect(linked.handBacks?.[0]?.reissueSequence).toBe(12);
		expect(
			settlementPlanHasExactEffectLink(linked, effect({ sourceSequence: 9, originSequence: 2 }) as never, 12)
		).toBe(true);
		// An effect written before the field takes the record's origin.
		expect(
			snapshot(
				applySettlementPlanEffect(base, copySettlementPlanEffect(effect({ sourceSequence: 9 }))!, 12).reissueOrigins
			)
		).toEqual(snapshot([origin(12, 2)]));
		// An origin other than the record's is refused.
		expect(() =>
			applySettlementPlanEffect(base, copySettlementPlanEffect(effect({ sourceSequence: 9, originSequence: 3 }))!, 12)
		).toThrow();
	});

	it("bounds: the record bound counts unconsumed records only; entries have their own bound of 64", () => {
		const full = Array.from({ length: SETTLEMENT_HAND_BACK_LIMITS.maxRecords }, (_, index) =>
			record({ sourceSequence: 1_000 + index, exactCanonicalOperationBytes: new Uint8Array([index + 1]) })
		);
		const origins = Array.from({ length: SETTLEMENT_HAND_BACK_LIMITS.maxRecords }, (_, index) =>
			origin(2_000 + index, 1 + index)
		);
		// 64 unconsumed records and 64 entries in one plan.
		const atBound = copied(plan(0, { handBacks: full, reissueOrigins: origins }));
		expect(atBound.handBacks).toHaveLength(64);
		expect(atBound.reissueOrigins).toHaveLength(64);
		// The entry bound refuses one more reissue; the record stays unconsumed.
		expect(
			code(
				thrown(() =>
					applySettlementPlanEffect(atBound, copySettlementPlanEffect(effect({ sourceSequence: 1_000 }))!, 3_000)
				)
			)
		).toBe("ISSUANCE_RETRY_REQUIRED");
		expect(atBound.handBacks?.[0]?.reissueSequence).toBeNull();
		// A merge drops consumed records: they hold no slot, the entry keeps the move.
		const consumed = applySettlementPlanEffect(
			copied(plan(0, { handBacks: full })),
			copySettlementPlanEffect(effect({ sourceSequence: 1_000 }))!,
			3_000
		);
		const merged = settlementWindowHandBacks(consumed, [
			{
				sourceSequence: 3_001,
				sourceDigest: new Uint8Array(32).fill(7),
				sourceEpoch: 9,
				operations: [new Uint8Array([200])],
			},
		]);
		expect(merged.deferredMoves).toBe(0);
		expect(merged.handBacks).toHaveLength(64);
		expect(snapshot(merged.reissueOrigins)).toEqual(snapshot([origin(3_000, 1_000)]));
	});

	it("record bound full: a new expiry finds no free slot, the move is deferred and no entry is dropped", () => {
		// 64 unconsumed records, and entries for two reissued moves, one of which (row 2001) now expires.
		const full = Array.from({ length: SETTLEMENT_HAND_BACK_LIMITS.maxRecords }, (_, index) =>
			record({ sourceSequence: 1_000 + index, exactCanonicalOperationBytes: new Uint8Array([index + 1]) })
		);
		const before = copied(plan(5, { handBacks: full, reissueOrigins: [origin(2_000, 3), origin(2_001, 4)] }));
		const merged = settlementWindowHandBacks(before, [
			{
				sourceSequence: 2_001,
				sourceDigest: new Uint8Array(32).fill(7),
				sourceEpoch: 9,
				operations: [new Uint8Array([200])],
			},
		]);
		expect(merged.deferredMoves).toBe(1);
		expect(merged.expired.has(2_001)).toBe(false);
		expect(snapshot(merged.reissueOrigins)).toEqual(snapshot(before.reissueOrigins));
		expect(snapshot(merged.handBacks)).toEqual(snapshot(before.handBacks));
	});

	it("an expiry of a reissued move keeps its origin through replacements; admission drops the entry on the signed frontier only", () => {
		// Row 20 reissued the move that began at 3; it was displaced and replaced by 24, which expires.
		const before = copied(
			plan(5, {
				entries: [
					{
						disposition: "rebase",
						replacementSequence: 24,
						sourceDigest: new Uint8Array(32).fill(0xd2),
						sourceSequence: 20,
					},
				],
				reissueOrigins: [origin(20, 3)],
			})
		);
		expect(settlementMoveOrigin(before, 24)).toEqual({ originSequence: 3, reissue: origin(20, 3) });
		expect(settlementReissueLastCarrier(before, 20)).toBe(24);
		// Replacement never drops the entry: the frontier admitted the reissued row's sequence, not the carrier.
		expect(snapshot(settlementReissueOriginsUnsettled(before, before.reissueOrigins, 20))).toEqual(
			snapshot([origin(20, 3)])
		);
		expect(settlementReissueOriginsUnsettled(before, before.reissueOrigins, null)).toBe(before.reissueOrigins);
		expect(settlementReissueOriginsUnsettled(before, before.reissueOrigins, 24)).toBeUndefined();
		// At or below the frontier is not admitted: a last carrier displaced in this write, or with an own
		// plan entry still settling (the frontier passed it through a later fence), keeps the entry for its
		// later give-back (model settlement-window.qnt settlementAuthorOrder, terminalDrop).
		expect(snapshot(settlementReissueOriginsUnsettled(before, before.reissueOrigins, 30, new Set([24])))).toEqual(
			snapshot([origin(20, 3)])
		);
		for (const disposition of ["rebase", "transform", "expire", "manual-review"] as const) {
			const settling = copied(
				plan(5, {
					entries: [
						...before.entries,
						{ disposition, replacementSequence: null, sourceDigest: new Uint8Array(32).fill(0xd4), sourceSequence: 24 },
					],
					reissueOrigins: [origin(20, 3)],
				})
			);
			expect(snapshot(settlementReissueOriginsUnsettled(settling, settling.reissueOrigins, 30)), disposition).toEqual(
				snapshot([origin(20, 3)])
			);
		}
		// With no settling entry of its own, a last carrier at or below the frontier is admitted: dropped.
		expect(settlementReissueOriginsUnsettled(before, before.reissueOrigins, 30, new Set([20]))).toBeUndefined();
		// The expiry of the last carrier writes the record at the origin and drops the entry in the same write.
		const merged = settlementWindowHandBacks(before, [
			{ sourceSequence: 24, sourceDigest: new Uint8Array(32).fill(0xd3), sourceEpoch: 9, operations: [OPERATION] },
		]);
		expect(merged.handBacks?.map((value) => [value.sourceSequence, value.originSequence])).toEqual([[24, 3]]);
		expect(merged.reissueOrigins).toBeUndefined();
		const after = copied({ ...plan(6, { entries: before.entries }), handBacks: merged.handBacks });
		expect(() => assertSettlementPlanProgressTransition(before, after)).not.toThrow();
	});

	it("backlog: a reissued move counts once through reissue, displacement, replacement and expiry", () => {
		// slow-member review: a move counted zero times while displaced would let V3RoomLocalBacklogFull
		// admit a 65th move. The entry counts while the chain is live; the displaced row's own entry counts
		// it while the rebase scan lists it; the record counts it once it expires.
		const total = (value: SettlementPlan, displaced: ReadonlyMap<number, number>) => {
			const backlog = settlementBacklogMoves(value, displaced);
			return backlog.fixed + backlog.pending.reduce((sum, move) => sum + move.moves, 0);
		};
		const given = copied(plan(1, { handBacks: [record()] }));
		expect(total(given, new Map())).toBe(1);
		// The reissue (row 20) consumes the record and adds its entry in the same transaction.
		const reissued = applySettlementPlanEffect(given, copySettlementPlanEffect(effect({ originSequence: 7 }))!, 20);
		expect(snapshot(reissued.reissueOrigins)).toEqual(snapshot([origin(20, 7)]));
		expect(total(reissued, new Map())).toBe(1);
		expect(settlementBacklogMoves(reissued, new Map()).pending.map((move) => move.rows)).toEqual([[20]]);
		// The next install displaces row 20: its rebase entry counts it, the entry does not.
		const rebase = { disposition: "rebase", sourceDigest: new Uint8Array(32).fill(0xd2), sourceSequence: 20 };
		const displacedPlan = copied(
			plan(2, { entries: [expired(), { ...rebase, replacementSequence: null }], reissueOrigins: [origin(20, 7)] })
		);
		expect(total(displacedPlan, new Map([[20, 1]]))).toBe(1);
		// The drain replaces it (row 24): pending on the replacement, once, whether or not the scan still lists 20.
		const replaced = copied(
			plan(3, { entries: [expired(), { ...rebase, replacementSequence: 24 }], reissueOrigins: [origin(20, 7)] })
		);
		for (const displaced of [new Map([[20, 1]]), new Map<number, number>()]) {
			expect(total(replaced, displaced)).toBe(1);
			expect(settlementBacklogMoves(replaced, displaced).pending.map((move) => move.rows)).toEqual([[24]]);
		}
		// The next install displaces row 24 before the scan gives it an entry (alone, or with row 20 still
		// listed): no entry counts it, so the reissueOrigins entry does, on 24, which no creator row reaches.
		for (const displaced of [
			new Map([[24, 1]]),
			new Map([
				[20, 1],
				[24, 1],
			]),
		]) {
			expect(total(replaced, displaced)).toBe(1);
			expect(settlementBacklogMoves(replaced, displaced).pending.map((move) => move.rows)).toEqual([[24]]);
		}
		// Once the scan gives row 24 its own rebase entry, that entry counts the move instead.
		const redisplaced = copied(
			plan(3, {
				entries: [
					expired(),
					{ ...rebase, replacementSequence: 24 },
					{ ...rebase, sourceDigest: new Uint8Array(32).fill(0xd3), sourceSequence: 24, replacementSequence: null },
				],
				reissueOrigins: [origin(20, 7)],
			})
		);
		expect(total(redisplaced, new Map([[24, 1]]))).toBe(1);
		expect(settlementBacklogMoves(redisplaced, new Map([[24, 1]])).pending).toEqual([]);
		// Row 24 displaced and expired: the record holds the origin, the entry is dropped, still one move.
		const merged = settlementWindowHandBacks(replaced, [
			{ sourceSequence: 24, sourceDigest: new Uint8Array(32).fill(0xd3), sourceEpoch: 9, operations: [OPERATION] },
		]);
		expect(merged.handBacks?.map((value) => [value.sourceSequence, value.originSequence])).toEqual([[24, 7]]);
		expect(merged.reissueOrigins).toBeUndefined();
		const expiredPlan = copied({
			...plan(4, { entries: [expired(), { ...rebase, replacementSequence: 24 }, expired(24)] }),
			handBacks: merged.handBacks,
		});
		expect(
			total(
				expiredPlan,
				new Map([
					[20, 1],
					[24, 1],
				])
			)
		).toBe(1);
		expect(total(expiredPlan, new Map())).toBe(1);
	});

	it("a refused replay of a reissued move's row (row 97) gives it back at its origin, with its reason, and drops the entry", () => {
		// Row 20 reissued the move that began at 3; the drain's replay of 20 was refused by the Writer's own
		// admission. The room's ONE hand-back write (handBackRefusedReplay) merges records through
		// settlementHandBacksAtOrigin: each keeps its reason and gains the origin, and 20's entry passes to
		// them. It was the plan's only entry: the write carries none (no field), the last one dropped too.
		const rebase = Object.freeze({
			disposition: "rebase",
			replacementSequence: null,
			sourceDigest: new Uint8Array(32).fill(0xd2),
			sourceSequence: 20,
		});
		const before = copied(plan(5, { entries: [rebase], reissueOrigins: [origin(20, 3)] }));
		const recorded = settlementHandBacksAtOrigin(before, before.handBacks, before.reissueOrigins, [
			{
				...record({ sourceSequence: 20, sourceEpoch: 9, sourceDigest: new Uint8Array(32).fill(0xd2) }),
				reason: "application-state-limit",
			},
		] as never);
		expect(recorded).toBeDefined();
		expect(recorded!.handBacks.map((value) => [value.sourceSequence, value.originSequence, value.reason])).toEqual([
			[20, 3, "application-state-limit"],
		]);
		expect(recorded!.reissueOrigins).toBeUndefined();
		const after = copied({
			...plan(6, {
				entries: [
					{ ...rebase, disposition: "expire", handedBack: { fromIntent: 0, reason: "application-state-limit" } },
				],
			}),
			handBacks: recorded!.handBacks,
		});
		expect(() => assertSettlementPlanProgressTransition(before, after)).not.toThrow();
		// The move is counted once, by its record (the entry no longer counts it).
		expect(settlementBacklogMoves(after, new Map()).fixed).toBe(1);
		expect(settlementBacklogMoves(after, new Map()).pending).toEqual([]);
	});

	it("a plan write keeps or drops an entry, never adds or alters one", () => {
		const before = copied(plan(1, { reissueOrigins: [origin(9, 7)] }));
		expect(() => assertSettlementPlanProgressTransition(before, copied(plan(2)))).not.toThrow();
		expect(() =>
			assertSettlementPlanProgressTransition(before, copied(plan(2, { reissueOrigins: [origin(9, 7)] })))
		).not.toThrow();
		for (const candidate of [[origin(9, 6)], [origin(9, 7), origin(10, 7)]])
			expect(
				code(
					thrown(() => assertSettlementPlanProgressTransition(before, copied(plan(2, { reissueOrigins: candidate }))))
				)
			).toBe("ISSUANCE_RETRY_REQUIRED");
		expect(() =>
			assertSettlementPlanProgressTransition(null, copied(plan(0, { reissueOrigins: [origin(9, 7)] })))
		).toThrow();
	});
});

describe("settlement reissue origins: stores", () => {
	for (const kind of ["memory", "node", "browser"] as const) {
		it(`${kind}: the reissue's own issuance transaction consumes the record and adds the entry; plan writes keep or drop it`, async () => {
			const store = await openStore(kind);
			try {
				await advance(store, 10);
				const given = record({ sourceSequence: 9, originSequence: 2 });
				await store.transactWriteSettlementPlan({
					expectedRevision: null,
					plan: plan(0, { handBacks: [given, record()], entries: [expired(), expired(9)] }),
					scope: SCOPE,
				});
				// Read back in origin order (row 9's move began at 2).
				expect(snapshot(await store.readSettlementPlan(SCOPE))).toEqual(
					snapshot(plan(0, { handBacks: [given, record()], entries: [expired(), expired(9)] }))
				);
				// A plan write never adds an entry.
				expect(
					code(
						await failure(
							store.transactWriteSettlementPlan({
								expectedRevision: 0,
								plan: plan(1, {
									handBacks: [given, record()],
									entries: [expired(), expired(9)],
									reissueOrigins: [origin(9, 2)],
								}),
								scope: SCOPE,
							})
						)
					)
				).toBe("ISSUANCE_RETRY_REQUIRED");
				await store.transactIssue(SCOPE, (sequence) =>
					Promise.resolve(commit(sequence, effect({ sourceSequence: 9, originSequence: 2 })))
				);
				const consumed = plan(1, {
					handBacks: [{ ...given, reissueSequence: 10 }, record()],
					entries: [expired(), expired(9)],
					reissueOrigins: [origin(10, 2)],
				});
				expect(snapshot(await store.readSettlementPlan(SCOPE))).toEqual(snapshot(consumed));
				// An effect naming another origin issues nothing.
				expect(
					code(
						await failure(
							store.transactIssue(SCOPE, (sequence) => Promise.resolve(commit(sequence, effect({ originSequence: 6 }))))
						)
					)
				).toBe("ISSUANCE_RETRY_REQUIRED");
				expect((await store.readLineage(SCOPE)).next).toBe(11);
				// A merge drops the consumed record and keeps the entry; altering it is refused.
				const merged = plan(2, {
					handBacks: [record()],
					entries: [expired(), expired(9)],
					reissueOrigins: [origin(10, 2)],
				});
				expect(
					code(
						await failure(
							store.transactWriteSettlementPlan({
								expectedRevision: 1,
								plan: { ...merged, reissueOrigins: [origin(10, 1)] },
								scope: SCOPE,
							})
						)
					)
				).toBe("ISSUANCE_RETRY_REQUIRED");
				await store.transactWriteSettlementPlan({ expectedRevision: 1, plan: merged, scope: SCOPE });
				expect(snapshot(await store.readSettlementPlan(SCOPE))).toEqual(snapshot(merged));
				// The move settled: the entry is dropped.
				const settled = plan(3, { handBacks: [record()], entries: [expired(), expired(9)] });
				await store.transactWriteSettlementPlan({ expectedRevision: 2, plan: settled, scope: SCOPE });
				expect(snapshot(await store.readSettlementPlan(SCOPE))).toEqual(snapshot(settled));
			} finally {
				await store.close();
			}
		});
	}

	it("node: records and entries survive reopen", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reissue-origins-reopen-"));
		directories.push(directory);
		let store = await openStore("node", directory);
		await advance(store, 10);
		const given = record({ sourceSequence: 9, originSequence: 2 });
		await store.transactWriteSettlementPlan({
			expectedRevision: null,
			plan: plan(0, { handBacks: [given], entries: [expired(9)] }),
			scope: SCOPE,
		});
		await store.transactIssue(SCOPE, (sequence) => Promise.resolve(commit(sequence, effect({ sourceSequence: 9 }))));
		await store.close();
		store = await openStore("node", directory);
		try {
			expect(snapshot(await store.readSettlementPlan(SCOPE))).toEqual(
				snapshot(
					plan(1, {
						handBacks: [{ ...given, reissueSequence: 10 }],
						entries: [expired(9)],
						reissueOrigins: [origin(10, 2)],
					})
				)
			);
		} finally {
			await store.close();
		}
	});
});
