import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DurableIssuanceStore, DurableIssueCommit, SettlementPlan } from "@ts-drp/issuance-store";
import { createEphemeralDurableIssuanceStore } from "@ts-drp/issuance-store/conformance";
import {
	durableIssuancePruningMaintenanceForStore,
	ISSUANCE_RETIREMENT_LIMITS,
	issuanceUnsignedBatchPostimageCharge,
} from "@ts-drp/issuance-store/maintenance";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { issueBatch, issueOne, replacement, SCOPE, snapshot } from "./fixtures/issuance-batch/conformance.js";
import { issuanceSourceCustodyPlanResourceForSizing } from "../packages/issuance-store/src/retirement.js";
import { createNodeDurableIssuanceStore } from "../packages/storage-node/src/issuance.js";

// Track 46 with the settlement batch (7696e9e6): a hand-back followed by a batched drain chunk on the same
// plan. The re-offered move takes the single path (a batch never mixes a hand-back with settlement work),
// its record keeps the move's origin, the batch's replacement effects leave reissueOrigins exactly as the
// reissue wrote it (and the plan equals the same rows issued singly), and both sizings hold: the custody
// sizing of the plan before the reissue covers the plan after it, and the batch charge sized before the
// batch's marker covers the rows the batch wrote.

const stores: DurableIssuanceStore[] = [];
const directories: string[] = [];
afterEach(async () => {
	await Promise.allSettled(stores.splice(0).map((store) => store.close()));
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const factories = {
	ephemeral: (): Promise<DurableIssuanceStore> => {
		const store = createEphemeralDurableIssuanceStore();
		stores.push(store);
		return Promise.resolve(store);
	},
	sqlite: (name: string): Promise<DurableIssuanceStore> => {
		const directory = mkdtempSync(join(tmpdir(), `handback-batch-${name}-`));
		directories.push(directory);
		const store = createNodeDurableIssuanceStore({ primaryFilename: join(directory, "issuance.sqlite") });
		stores.push(store);
		return Promise.resolve(store);
	},
} as const;

const hex = (seed: number): string => seed.toString(16).padStart(64, "0");
const digestOf = (bytes: Uint8Array): Uint8Array => hashDomain("ts-drp/vertex/v3", bytes);
const operationOf = (sourceSequence: number): Readonly<Record<string, unknown>> => ({
	action: "place",
	id: `m-${sourceSequence}`,
	x: 1,
	y: 2,
});
/**
 * A vertex preimage in the batch fixture's shape.
 * @param sequence - The author sequence.
 * @param epoch - The signed epoch.
 * @param operation - The operation.
 * @returns The canonical preimage bytes.
 */
function preimage(sequence: number, epoch: number, operation: Readonly<Record<string, unknown>>): Uint8Array {
	return encodeCanonical({
		anchor: hex(epoch + 1),
		author: SCOPE.author,
		authorSequence: sequence,
		dependencies: [hex(1_000_000 + sequence)],
		epoch,
		kind: "drp-vertex",
		logicalTime: 1_000 + 2 * sequence,
		objectId: SCOPE.objectId,
		operation,
		protocolMajor: 3,
	});
}

// Rows 0..6 in epoch 0. Row 2 was given back: its move began at row 1 (a reissued move given back again),
// so its record carries originSequence 1. Rows 3..6 are rebased by one batched drain chunk.
const GIVEN = 2;
const ORIGIN = 1;
const DRAIN = [3, 4, 5, 6] as const;
const MOVES = 7;
const FENCE = 7;
const REISSUE = 8;
const BATCH_FIRST = 9;
const BATCH = DRAIN.map((_, index) => BATCH_FIRST + index);
// The custody sizing's geometry (packages/issuance-store/tests/source-custody-sizing-dispositions.test.ts).
const GEOMETRY = {
	maxContextByteLength: 74_107,
	maxCompletionByteLength: 70_432,
	maxCompletionMemberByteLength: 512,
	maxExpiryByteLength: 1_024,
	maxNativeReadByteLength: 786_432,
	maxMemberFrontierByteLength: 4_096,
};

const handBackEffect = Object.freeze({
	kind: "hand-back" as const,
	sourceSequence: GIVEN,
	intent: 0,
	originSequence: ORIGIN,
});
const reissueRow = {
	effect: handBackEffect as DurableIssueCommit["planEffect"],
	bytes: (sequence: number): Uint8Array => preimage(sequence, 1, operationOf(GIVEN)),
};

/**
 * The store after the epoch-0 rows, the plan with the given-back record and the drain's rebase entries,
 * and the plan's fence.
 * @param factory - Opens a named store.
 * @param name - The store's name.
 * @returns The store.
 */
async function givenBackStore(
	factory: (name: string) => Promise<DurableIssuanceStore>,
	name: string
): Promise<DurableIssuanceStore> {
	const store = await factory(name);
	const sources: DurableIssueCommit[] = [];
	for (let index = 0; index < MOVES; index++)
		sources.push(await issueOne(store, { bytes: (sequence) => preimage(sequence, 0, operationOf(sequence)) }));
	const digest = (sequence: number): Uint8Array => {
		const source = sources[sequence];
		if (source === undefined) throw new Error(`fixture: no row ${sequence}`);
		return source.envelope.digest;
	};
	const plan: SettlementPlan = {
		scope: SCOPE,
		revision: 0,
		fenceSequence: null,
		entries: [
			{ sourceSequence: GIVEN, sourceDigest: digest(GIVEN), disposition: "expire", replacementSequence: null },
			...DRAIN.map((sequence) => ({
				sourceSequence: sequence,
				sourceDigest: digest(sequence),
				disposition: "rebase" as const,
				replacementSequence: null,
			})),
		],
		handBacks: [
			{
				sourceSequence: GIVEN,
				sourceDigest: digest(GIVEN),
				sourceEpoch: 0,
				intent: 0,
				exactCanonicalOperationBytes: encodeCanonical(operationOf(GIVEN)),
				reissueSequence: null,
				originSequence: ORIGIN,
			},
		],
	};
	await store.transactWriteSettlementPlan({ scope: SCOPE, expectedRevision: null, plan });
	const fence = await issueOne(store, {
		effect: { kind: "fence" },
		bytes: (sequence) => preimage(sequence, 1, { action: "$drp.author-fence.v1", fenceSequence: sequence, version: 1 }),
	});
	if (fence.authorSequence !== FENCE) throw new Error(`fixture: fence at ${fence.authorSequence}`);
	return store;
}

/**
 * The store's plan, or a thrown fixture error.
 * @param store - The store.
 * @returns The plan.
 */
async function planOf(store: DurableIssuanceStore): Promise<SettlementPlan> {
	const plan = await store.readSettlementPlan(SCOPE);
	if (plan === null) throw new Error("fixture: no plan");
	return plan;
}

const view = (plan: SettlementPlan): unknown => ({
	revision: plan.revision,
	handBacks: plan.handBacks?.map(({ sourceSequence, intent, originSequence, reissueSequence }) => ({
		sourceSequence,
		intent,
		originSequence,
		reissueSequence,
	})),
	reissueOrigins: plan.reissueOrigins,
	replaced: plan.entries.map((entry) => [entry.sourceSequence, entry.replacementSequence]),
});

describe.each(Object.keys(factories) as (keyof typeof factories)[])(
	"a hand-back followed by a batched drain chunk on %s",
	(kind) => {
		it("the re-offered move takes the single path, keeps its origin, and the batch leaves reissueOrigins and sizing intact", async () => {
			const native = kind !== "ephemeral";
			const store = await givenBackStore(factories[kind], `${kind}-batched`);
			const fenced = await planOf(store);

			// Single path: a batch carrying the hand-back with settlement work is refused before any signature.
			const before = await snapshot(store, REISSUE, BATCH_FIRST + DRAIN.length - 1);
			const mixed = await issueBatch(store, [reissueRow, replacement(DRAIN[0])]);
			expect(mixed).toMatchObject({ ok: false, code: "ISSUANCE_COMMIT_INVALID" });
			expect(mixed.signed).toEqual([]);
			expect(await snapshot(store, REISSUE, BATCH_FIRST + DRAIN.length - 1)).toEqual(before);

			// The reissue issues singly: the record is consumed, keeps its origin, and the entry maps the reissue to it.
			const reissued = await issueOne(store, reissueRow);
			expect(reissued.authorSequence).toBe(REISSUE);
			const afterReissue = await planOf(store);
			expect(view(afterReissue)).toEqual({
				revision: fenced.revision + 1,
				handBacks: [{ sourceSequence: GIVEN, intent: 0, originSequence: ORIGIN, reissueSequence: REISSUE }],
				reissueOrigins: [{ originSequence: ORIGIN, reissueSequence: REISSUE }],
				replaced: [[GIVEN, null], ...DRAIN.map((sequence) => [sequence, null])],
			});

			// Custody sizing (G22, composed hand-back charge): the plan before the reissue sizes the plan after it.
			const resource = issuanceSourceCustodyPlanResourceForSizing(
				SCOPE,
				fenced,
				0,
				GEOMETRY,
				encodeCanonical(operationOf(GIVEN)).byteLength
			);
			const reissuedBytes = encodeCanonical(afterReissue, {
				maxBytes: resource.byteLength,
				maxItems: resource.items,
				maxDepth: resource.maxDepth,
			}).byteLength;
			expect(reissuedBytes).toBeLessThanOrEqual(resource.byteLength);

			// The batch charge, sized before the marker against the plan that now carries the entry (native stores).
			const rows = DRAIN.map((sequence) => replacement(sequence));
			let charged: number | undefined;
			const census = native ? durableIssuancePruningMaintenanceForStore(store)?.readBoundedRecoveryCensus : undefined;
			const read = async (): Promise<unknown> => {
				if (census === undefined) throw new Error("native store has no recovery census");
				return (
					await census({
						objectId: SCOPE.objectId,
						limits: { maxRows: ISSUANCE_RETIREMENT_LIMITS.maxRows, maxBytes: ISSUANCE_RETIREMENT_LIMITS.maxBytes },
					})
				).rows;
			};
			if (native) {
				const intents = rows.map((row, index) => {
					const bytes = row.bytes(BATCH_FIRST + index);
					if (row.effect === undefined) throw new Error("fixture: a drain row has no plan effect");
					return {
						authorSequence: BATCH_FIRST + index,
						canonicalPreimageBytes: bytes,
						digest: digestOf(bytes),
						planEffect: row.effect,
					};
				});
				const [head, ...following] = intents;
				if (head === undefined) throw new Error("fixture: an empty drain chunk");
				charged = issuanceUnsignedBatchPostimageCharge((await read()) as never, SCOPE, {
					...head,
					exactCanonicalPlanBytes: encodeCanonical(afterReissue),
					followingIntents: following,
				}).logicalBytes;
			}

			// The batched drain chunk: its replacement effects leave the record and the entry exactly as the reissue
			// wrote them.
			const batched = await issueBatch(store, rows);
			expect(batched.ok, JSON.stringify(batched).slice(0, 300)).toBe(true);
			if (batched.ok) expect(batched.commits.map((commit) => commit.authorSequence)).toEqual(BATCH);
			const afterBatch = await planOf(store);
			expect(view(afterBatch)).toEqual({
				revision: afterReissue.revision + DRAIN.length,
				handBacks: [{ sourceSequence: GIVEN, intent: 0, originSequence: ORIGIN, reissueSequence: REISSUE }],
				reissueOrigins: [{ originSequence: ORIGIN, reissueSequence: REISSUE }],
				replaced: [[GIVEN, null], ...DRAIN.map((sequence, index) => [sequence, BATCH[index]])],
			});

			// The same rows issued singly on a twin store leave the same plan, byte for byte.
			const twin = await givenBackStore(factories[kind], `${kind}-singles`);
			await issueOne(twin, reissueRow);
			for (const row of rows) await issueOne(twin, row);
			expect(Array.from(encodeCanonical(await planOf(twin)))).toEqual(Array.from(encodeCanonical(afterBatch)));

			// Batch sizing: the charge covers the rows the batch wrote (sized >= written).
			if (native) {
				const written = encodeCanonical(await read()).byteLength;
				process.stdout.write(
					`HANDBACK_BATCH_SIZING ${JSON.stringify({ kind, charged, written, reissuedBytes, custody: resource.byteLength })}\n`
				);
				expect(charged).toBeGreaterThanOrEqual(written);
			}
		});
	}
);
