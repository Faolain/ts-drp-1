import "fake-indexeddb/auto";

import { hashDomain } from "@ts-drp/canonical";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createEphemeralDurableIssuanceStore } from "../packages/issuance-store/src/conformance.js";
import {
	applySettlementPlanEffect,
	copySettlementPlan,
	normalizeSettlementSourceAuthorities,
	SETTLEMENT_SOURCE_AUTHORITY_DOMAIN,
} from "../packages/issuance-store/src/contract.js";
import { issuanceSourceCustodyPlanResourceForSizing } from "../packages/issuance-store/src/retirement.js";
import { SETTLEMENT_SOURCE_AUTHORITY_LIMITS, type SettlementPlan } from "../packages/issuance-store/src/types.js";
import { createBrowserDurableIssuanceStore } from "../packages/storage-browser/src/issuance.js";
import { createNodeDurableIssuanceStore } from "../packages/storage-node/src/issuance.js";

// fix/browser-rollover-member-stall (cold reopen): a plan's source-authority records
// (`sourceAuthorities`, SettlementSourceAuthority). A record holds one source epoch's authority while
// the plan owes a replacement of a row of that epoch (an unreplaced rebase/transform entry): it is
// written with those entries, never changes its bytes, loses a source in the same write or issue effect
// that replaces or gives back that row, and leaves with the last one. It is no source context, so its
// rows are not retained work. The same law in the memory, Node (SQLite) and browser (IndexedDB) stores,
// and Node reopen. The store checks only shape and digest; Node authenticates the bytes on every open.

const SCOPE = Object.freeze({ author: "author:source-authority-store", objectId: "room:source-authority-store" });
const authorityBytes = (fill: number, length = 512) => new Uint8Array(length).fill(fill);
const record = (sourceEpoch: number, sources: readonly number[], fill = sourceEpoch, length = 512) => {
	const bytes = authorityBytes(fill, length);
	return Object.freeze({
		digest: hashDomain(SETTLEMENT_SOURCE_AUTHORITY_DOMAIN, bytes),
		exactCanonicalAuthorityBytes: bytes,
		sourceEpoch,
		sources: Object.freeze([...sources]),
	});
};
const entry = (sourceSequence: number, overrides: Readonly<Record<string, unknown>> = {}) =>
	Object.freeze({
		disposition: "rebase",
		replacementSequence: null,
		sourceDigest: new Uint8Array(32).fill(sourceSequence),
		sourceSequence,
		...overrides,
	});
/** Owed rows 1, 2 (epoch 2) and 3 (epoch 3); 4 is already replaced; 5 is a window expiry. */
const ENTRIES = Object.freeze([
	entry(1),
	entry(2, { disposition: "transform" }),
	entry(3),
	entry(4, { replacementSequence: 9 }),
	entry(5, { disposition: "expire" }),
]);
const plan = (revision: number, input: Readonly<{ entries?: readonly unknown[]; records?: readonly unknown[] }> = {}) =>
	Object.freeze({
		entries: Object.freeze([...(input.entries ?? ENTRIES)]),
		fenceSequence: null,
		...(input.records === undefined ? {} : { sourceAuthorities: Object.freeze([...input.records]) }),
		revision,
		scope: SCOPE,
	}) as unknown as SettlementPlan;
const RECORDS = Object.freeze([record(2, [1, 2]), record(3, [3])]);

const snapshot = (value: unknown): unknown => {
	if (value === null || typeof value !== "object") return value;
	if (value instanceof Uint8Array) return [...value];
	if (Array.isArray(value)) return value.map(snapshot);
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item)]));
};
const failure = async (promise: Promise<unknown>) =>
	promise.then(
		() => undefined,
		(error: unknown) => error
	);
const code = (error: unknown) => (error !== null && typeof error === "object" ? Reflect.get(error, "code") : undefined);

interface Store {
	close(): Promise<void>;
	readSettlementPlan(scope: unknown): Promise<unknown>;
	transactWriteSettlementPlan(input: unknown): Promise<unknown>;
}
const directories: string[] = [];
let browserId = 0;
async function openStore(kind: "browser" | "memory" | "node", directory?: string): Promise<Store> {
	if (kind === "memory") return createEphemeralDurableIssuanceStore() as unknown as Store;
	if (kind === "browser")
		return (await createBrowserDurableIssuanceStore({
			primaryDatabaseName: `source-authority-${browserId++}`,
		})) as unknown as Store;
	const selected = directory ?? (await mkdtemp(join(tmpdir(), "source-authority-store-")));
	if (directory === undefined) directories.push(selected);
	return createNodeDurableIssuanceStore({ primaryFilename: join(selected, "primary.sqlite") }) as unknown as Store;
}
afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("settlement source-authority record contract", () => {
	it("copies records exactly and refuses malformed ones", () => {
		expect(snapshot(copySettlementPlan(plan(0, { records: RECORDS }), SCOPE))).toEqual(
			snapshot(plan(0, { records: RECORDS }))
		);
		const two = record(2, [1, 2]);
		for (const bad of [
			[], // present only when non-empty
			[record(3, [3]), two], // ascending by epoch
			[two, record(2, [3], 7)], // one record per epoch
			[record(2, [2, 1])], // sources ascending
			[record(2, [1, 1])],
			[record(2, [1]), record(3, [1])], // a source in exactly one record
			[record(2, [4])], // a replaced row is not owed
			[record(2, [5])], // nor is an expiry
			[record(2, [6])], // nor a row with no entry
			[record(2, [])],
			[{ ...two, digest: new Uint8Array(32) }],
			[{ ...two, exactCanonicalAuthorityBytes: new Uint8Array(0) }],
			[record(2, [1], 2, SETTLEMENT_SOURCE_AUTHORITY_LIMITS.maxBytes + 1)],
			[{ ...two, extra: 1 }],
			[record(1, [1]), record(2, [2]), record(3, [3]), record(4, [])].slice(0, 4),
			null,
		])
			expect(
				copySettlementPlan({ ...plan(0), sourceAuthorities: bad }, SCOPE),
				JSON.stringify(snapshot(bad)).slice(0, 120)
			).toBeUndefined();
		expect(SETTLEMENT_SOURCE_AUTHORITY_LIMITS.maxRecords).toBe(3);
	});

	it("normalizes records to the rows still owed and drops an empty record", () => {
		const current = plan(0, { records: RECORDS });
		expect(normalizeSettlementSourceAuthorities(current)).toBe(current);
		// Row 1 replaced: record 2 narrows. Row 3 given back (expire): record 3 leaves.
		const next = plan(1, {
			entries: ENTRIES.map((value) =>
				value.sourceSequence === 1
					? { ...value, replacementSequence: 10 }
					: value.sourceSequence === 3
						? { ...value, disposition: "expire" }
						: value
			),
			records: RECORDS,
		});
		expect(snapshot(normalizeSettlementSourceAuthorities(next).sourceAuthorities)).toEqual(snapshot([record(2, [2])]));
		const none = plan(1, { entries: ENTRIES.filter((value) => value.sourceSequence > 3), records: RECORDS });
		expect(Object.hasOwn(normalizeSettlementSourceAuthorities(none), "sourceAuthorities")).toBe(false);
	});

	it("a replacement effect prunes its row from the record in the same write", () => {
		const current = plan(0, { records: RECORDS });
		const first = applySettlementPlanEffect(current, { kind: "replacement", sourceSequence: 3 }, 11);
		expect(snapshot(first.sourceAuthorities)).toEqual(snapshot([record(2, [1, 2])]));
		expect(copySettlementPlan(first, SCOPE)).toBeDefined();
		const second = applySettlementPlanEffect(first, { kind: "replacement", sourceSequence: 1 }, 12);
		expect(snapshot(second.sourceAuthorities)).toEqual(snapshot([record(2, [2])]));
		const third = applySettlementPlanEffect(second, { kind: "replacement", sourceSequence: 2 }, 13);
		expect(Object.hasOwn(third, "sourceAuthorities")).toBe(false);
		expect(copySettlementPlan(third, SCOPE)).toBeDefined();
	});

	it("custody sizing charges stored records exactly and the potential record of the sizing epoch (G22)", () => {
		const geometry = Object.freeze({
			maxContextByteLength: 4096,
			maxCompletionByteLength: 4096,
			maxCompletionMemberByteLength: 64,
			maxExpiryByteLength: 512,
			maxNativeReadByteLength: 786_432,
			minSourceEpoch: 4,
		});
		const size = (prior: SettlementPlan | null, count: number, minSourceEpoch = 4) =>
			issuanceSourceCustodyPlanResourceForSizing(SCOPE, prior, count, { ...geometry, minSourceEpoch }).byteLength;
		const bare = plan(0);
		const stored = plan(0, { records: RECORDS });
		// A stored record is charged at least at its exact width.
		const storedWidth = new TextEncoder().encode("sourceAuthorities").byteLength;
		expect(size(stored, 0) - size(bare, 0)).toBeGreaterThan(storedWidth + 2 * 512);
		// Potential sources of epoch 4 may join a new record of epoch 4, one context wide.
		expect(size(bare, 3) - size(bare, 0)).toBeGreaterThan(geometry.maxContextByteLength);
		// Of epoch 3 (a record exists): only their sequences are added, not a second context.
		const grown = size(stored, 3, 3) - size(stored, 0, 3);
		expect(grown).toBeLessThan(geometry.maxContextByteLength);
		// A write that adds a record of epoch 4 with three sources fits the sizing.
		const written = plan(1, {
			entries: [...ENTRIES, entry(6), entry(7), entry(8)],
			records: [...RECORDS, record(4, [6, 7, 8], 4, geometry.maxContextByteLength)],
		});
		expect(copySettlementPlan(written, SCOPE)).toBeDefined();
		expect(size(written, 0)).toBeLessThanOrEqual(size(stored, 3));
	});

	for (const kind of ["memory", "node", "browser"] as const) {
		it(`${kind}: records keep their bytes while owed and leave only with their rows`, async () => {
			const store = await openStore(kind);
			const refused = async (candidate: unknown, revision: number) =>
				expect(
					code(
						await failure(
							store.transactWriteSettlementPlan({ expectedRevision: revision, plan: candidate, scope: SCOPE })
						)
					),
					JSON.stringify(snapshot(candidate)).slice(0, 160)
				).toBe("ISSUANCE_RETRY_REQUIRED");
			try {
				await store.transactWriteSettlementPlan({
					expectedRevision: null,
					plan: plan(0, { records: [record(2, [1, 2])] }),
					scope: SCOPE,
				});
				expect(snapshot(await store.readSettlementPlan(SCOPE))).toEqual(
					snapshot(plan(0, { records: [record(2, [1, 2])] }))
				);
				// A record of another epoch is added with its owed rows.
				await store.transactWriteSettlementPlan({
					expectedRevision: 0,
					plan: plan(1, { records: RECORDS }),
					scope: SCOPE,
				});
				// Its bytes never change; it is never dropped or narrowed while its rows are owed.
				await refused(plan(2, { records: [record(2, [1, 2], 9), record(3, [3])] }), 1);
				await refused(plan(2, { records: [record(2, [1, 2])] }), 1);
				await refused(plan(2, { records: [record(2, [1]), record(3, [3])] }), 1);
				await refused(plan(2), 1);
				// Giving back row 3 (the window's expiry, with its hand-back record) drops its record in the same write.
				const handBack = Object.freeze({
					exactCanonicalOperationBytes: new Uint8Array([0xa0]),
					intent: 0,
					reissueSequence: null,
					sourceDigest: new Uint8Array(32).fill(3),
					sourceEpoch: 3,
					sourceSequence: 3,
				});
				const givenBack = Object.freeze({
					...plan(2, {
						entries: ENTRIES.map((value) => (value.sourceSequence === 3 ? { ...value, disposition: "expire" } : value)),
						records: [record(2, [1, 2])],
					}),
					handBacks: Object.freeze([handBack]),
				});
				const keptRecord = Object.freeze({ ...givenBack, sourceAuthorities: RECORDS });
				expect(copySettlementPlan(keptRecord, SCOPE)).toBeUndefined();
				await store.transactWriteSettlementPlan({ expectedRevision: 1, plan: givenBack, scope: SCOPE });
				expect(snapshot(await store.readSettlementPlan(SCOPE))).toEqual(snapshot(givenBack));
			} finally {
				await store.close();
			}
		});
	}

	it("node: records survive reopen and stay immutable", async () => {
		const directory = await mkdtemp(join(tmpdir(), "source-authority-store-reopen-"));
		directories.push(directory);
		let store = await openStore("node", directory);
		await store.transactWriteSettlementPlan({
			expectedRevision: null,
			plan: plan(0, { records: RECORDS }),
			scope: SCOPE,
		});
		await store.close();
		store = await openStore("node", directory);
		try {
			expect(snapshot(await store.readSettlementPlan(SCOPE))).toEqual(snapshot(plan(0, { records: RECORDS })));
			expect(
				code(await failure(store.transactWriteSettlementPlan({ expectedRevision: 0, plan: plan(1), scope: SCOPE })))
			).toBe("ISSUANCE_RETRY_REQUIRED");
		} finally {
			await store.close();
		}
	});
});
