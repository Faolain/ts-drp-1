import "fake-indexeddb/auto";

import { hashDomain } from "@ts-drp/canonical";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createEphemeralDurableIssuanceStore } from "../packages/issuance-store/src/conformance.js";
import { copySettlementPlan } from "../packages/issuance-store/src/contract.js";
import { SETTLEMENT_MEMBER_FRONTIER_MAX_BYTES } from "../packages/issuance-store/src/types.js";
import { createBrowserDurableIssuanceStore } from "../packages/storage-browser/src/issuance.js";
import { createNodeDurableIssuanceStore } from "../packages/storage-node/src/issuance.js";

// The removed author's settlement plan (fix/removed-author-replaced-source-classification):
// - `memberFrontier`, the creator-signed settlement frontier the author held at its last install as a
//   member, is written once (at the close that removes it) and never changed or cleared;
// - a completed replacement entry (`rebase`/`transform` with its replacement; a progress record, if
//   any, is complete) may gain its displaced source's context once (custody of the still-present
//   source); it is never changed or cleared afterwards, and an entry already terminal (`expire`,
//   `inherited`; a `committed` entry always carries one) never gains one.
// The same contract path in the memory, Node (SQLite) and browser (IndexedDB) stores, and Node reopen.
// The store checks only shape and digest; Node authenticates the signed statement on every open.

const SCOPE = Object.freeze({ author: "author:member-frontier-store", objectId: "room:member-frontier-store" });
const DOMAIN = "ts-drp/settlement-source-context/v1";
const context = (fill: number, length = 96) => {
	const bytes = new Uint8Array(length).fill(fill);
	return Object.freeze({ digest: hashDomain(DOMAIN, bytes), exactCanonicalContextBytes: bytes });
};
const FRONTIER = context(0xf1, 4096);
const OTHER_FRONTIER = context(0xf2, 4096);
const DISPLACED = context(0xc1);
const OTHER_DISPLACED = context(0xc2);

const entry = (sourceSequence: number, overrides: Readonly<Record<string, unknown>> = {}) =>
	Object.freeze({
		disposition: "rebase",
		replacementSequence: sourceSequence + 4,
		sourceDigest: new Uint8Array(32).fill(sourceSequence),
		sourceSequence,
		...overrides,
	});
/** A complete progress record: the replacement (sequence 8) carries every intent. */
const PROGRESS = Object.freeze({
	chunks: [Object.freeze({ lastLogicalTime: 3, replacementSequence: 8, throughIntent: 2 })],
	intentCount: 2,
	intentDigest: new Uint8Array(32).fill(0xab),
	version: 1,
});
const INHERITANCE = Object.freeze({
	sourceObjectId: "room:member-frontier-source",
	targetAuthor: SCOPE.author,
	targetAuthorSequence: 3,
	targetObjectId: SCOPE.objectId,
	targetVertexDigest: new Uint8Array(32).fill(0x33),
});
/** A completed rebase (1), an expire (2), an inherited (3), a completed transform with a complete progress record (4). */
const ENTRIES = Object.freeze([
	entry(1),
	entry(2, { disposition: "expire", replacementSequence: null }),
	entry(3, { disposition: "inherited", inheritance: INHERITANCE, replacementSequence: null }),
	entry(4, { disposition: "transform", replacementProgress: PROGRESS, replacementSequence: 8 }),
]);
const gained = (sequences: readonly number[], digest: Uint8Array) =>
	ENTRIES.map(value => sequences.includes(value.sourceSequence) ? { ...value, sourceContextDigest: digest } : value);
const plan = (revision: number, input: Readonly<{
	entries?: readonly unknown[];
	contexts?: readonly Readonly<{ digest: Uint8Array; exactCanonicalContextBytes: Uint8Array }>[];
	memberFrontier?: Readonly<{ digest: Uint8Array; exactCanonicalContextBytes: Uint8Array }>;
}> = {}) =>
	Object.freeze({
		entries: Object.freeze([...(input.entries ?? ENTRIES)]),
		fenceSequence: 4,
		...(input.contexts === undefined || input.contexts.length === 0 ? {} : {
			sourceContexts: Object.freeze([...input.contexts].sort((a, b) =>
				Buffer.from(a.digest).toString("hex").localeCompare(Buffer.from(b.digest).toString("hex")))),
		}),
		...(input.memberFrontier === undefined ? {} : { memberFrontier: input.memberFrontier }),
		revision,
		scope: SCOPE,
	});
/** The first custody write at the removing close: the frontier and both completed entries' displaced context. */
const withCustody = (revision: number, displaced = DISPLACED, frontier = FRONTIER) =>
	plan(revision, { entries: gained([1, 4], displaced.digest), contexts: [displaced], memberFrontier: frontier });

const snapshot = (value: unknown): unknown => {
	if (value === null || typeof value !== "object") return value;
	if (value instanceof Uint8Array) return [...value];
	if (Array.isArray(value)) return value.map(snapshot);
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item)]));
};
const failure = async (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);
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
		return (await createBrowserDurableIssuanceStore({ primaryDatabaseName: `member-frontier-${browserId++}` })) as unknown as Store;
	const selected = directory ?? (await mkdtemp(join(tmpdir(), "member-frontier-store-")));
	if (directory === undefined) directories.push(selected);
	return createNodeDurableIssuanceStore({ primaryFilename: join(selected, "primary.sqlite") }) as unknown as Store;
}
afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("settlement member frontier and completed-entry custody contract", () => {
	it("copies a member frontier exactly and refuses malformed ones", () => {
		expect(snapshot(copySettlementPlan(plan(0, { memberFrontier: FRONTIER }), SCOPE))).toEqual(
			snapshot(plan(0, { memberFrontier: FRONTIER })));
		const oversize = context(1, SETTLEMENT_MEMBER_FRONTIER_MAX_BYTES + 1);
		for (const bad of [
			{ digest: new Uint8Array(32), exactCanonicalContextBytes: FRONTIER.exactCanonicalContextBytes },
			{ digest: FRONTIER.digest, exactCanonicalContextBytes: new Uint8Array(0) },
			{ digest: FRONTIER.digest.slice(1), exactCanonicalContextBytes: FRONTIER.exactCanonicalContextBytes },
			{ ...FRONTIER, extra: 1 },
			oversize,
			null,
		])
			expect(copySettlementPlan({ ...plan(0), memberFrontier: bad }, SCOPE)).toBeUndefined();
	});

	for (const kind of ["memory", "node", "browser"] as const) {
		it(`${kind}: the frontier and a completed entry's context are written once, never changed or cleared`, async () => {
			const store = await openStore(kind);
			const refused = async (candidate: unknown, revision: number) =>
				expect(code(await failure(store.transactWriteSettlementPlan({ expectedRevision: revision, plan: candidate, scope: SCOPE }))),
					JSON.stringify(snapshot(candidate)).slice(0, 160)).toBe("ISSUANCE_RETRY_REQUIRED");
			try {
				await store.transactWriteSettlementPlan({ expectedRevision: null, plan: plan(0), scope: SCOPE });
				// Terminal entries (expire, inherited) never gain a context.
				for (const sequence of [2, 3]) await refused(plan(1, { entries: gained([sequence], DISPLACED.digest), contexts: [DISPLACED] }), 0);
				// The removing close: the frontier and the completed entry's displaced context, once.
				await store.transactWriteSettlementPlan({ expectedRevision: 0, plan: withCustody(1), scope: SCOPE });
				expect(snapshot(await store.readSettlementPlan(SCOPE))).toEqual(snapshot(withCustody(1)));
				// No change and no clear of either; no second, different write.
				await refused(withCustody(2, OTHER_DISPLACED), 1);
				await refused(withCustody(2, DISPLACED, OTHER_FRONTIER), 1);
				await refused(plan(2, { entries: gained([1, 4], DISPLACED.digest), contexts: [DISPLACED] }), 1);
				await refused(plan(2, { entries: gained([1], DISPLACED.digest), contexts: [DISPLACED], memberFrontier: FRONTIER }), 1);
				await refused(plan(2, { memberFrontier: FRONTIER }), 1);
				// Rewriting both unchanged is a valid later plan write; the completed entry stays completed.
				await store.transactWriteSettlementPlan({ expectedRevision: 1, plan: withCustody(2), scope: SCOPE });
				expect(snapshot(await store.readSettlementPlan(SCOPE))).toEqual(snapshot(withCustody(2)));
			} finally {
				await store.close();
			}
		});
	}

	it("node: the frontier and the completed entry's context survive reopen and stay immutable", async () => {
		const directory = await mkdtemp(join(tmpdir(), "member-frontier-store-reopen-"));
		directories.push(directory);
		let store = await openStore("node", directory);
		await store.transactWriteSettlementPlan({ expectedRevision: null, plan: plan(0), scope: SCOPE });
		await store.transactWriteSettlementPlan({ expectedRevision: 0, plan: withCustody(1), scope: SCOPE });
		await store.close();
		store = await openStore("node", directory);
		try {
			expect(snapshot(await store.readSettlementPlan(SCOPE))).toEqual(snapshot(withCustody(1)));
			expect(code(await failure(store.transactWriteSettlementPlan({ expectedRevision: 1, plan: plan(2), scope: SCOPE }))))
				.toBe("ISSUANCE_RETRY_REQUIRED");
		} finally {
			await store.close();
		}
	});
});
