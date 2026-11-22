import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { afterEach, describe, expect, it } from "vitest";
import type { DurableIssuanceStore, DurableIssueCommit, DurableIssueSignContext } from "@ts-drp/issuance-store";
import { createNodeDurableIssuanceStore } from "../src/issuance.js";

// fix/maintenance-image-capacity, Writer side: a settlement-profile Writer's admission and its own
// settlement agree on one issuance bound. The Writer admits its own moves of an epoch; the creator
// may close the epoch with none of them; at the successor's install the Writer writes its plan,
// issues its fence and replaces every move, under the same row and byte bound. A store that admits
// every move the bound allows cannot replace them (the install deadlocked at drainRebaseOutbox);
// with the settlement replacement reserve on each own move, every admitted move is replaced.

const directories: string[] = [];
const stores: DurableIssuanceStore[] = [];
afterEach(async () => {
	await Promise.all(stores.splice(0).map((store) => store.close()));
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const scope = { objectId: "settlement-replacement-reserve-room", author: "b".repeat(64) };
const MAX_DEPENDENCIES = 16;
const hex = (seed: number): string => seed.toString(16).padStart(64, "0");

async function openStore(): Promise<DurableIssuanceStore> {
	const directory = await mkdtemp(join(tmpdir(), "issuance-settlement-reserve-"));
	directories.push(directory);
	const store = createNodeDurableIssuanceStore({ primaryFilename: join(directory, "primary.sqlite") });
	stores.push(store);
	return store;
}

function preimage(sequence: number, epoch: number, dependencies: number, operation: Readonly<Record<string, unknown>>): Uint8Array {
	return encodeCanonical({
		anchor: hex(epoch + 1),
		author: scope.author,
		authorSequence: sequence,
		dependencies: Array.from({ length: dependencies }, (_, index) => hex(1_000_000 + sequence * 32 + index)).sort(),
		epoch,
		kind: "drp-vertex",
		logicalTime: 1_000 + 2 * sequence,
		objectId: scope.objectId,
		operation,
		protocolMajor: 3,
	});
}

/** One native issue, exactly as the live plane drives it: the store selects the sequence. */
async function issue(
	store: DurableIssuanceStore,
	build: (sequence: number) => Uint8Array,
	context?: DurableIssueSignContext
): Promise<DurableIssueCommit> {
	const commit = await store.transactIssue(scope, async (sequence, admission) => {
		const bytes = build(sequence);
		if (!admission) throw new Error("native admission missing");
		const signature = await admission(bytes, () => Promise.resolve(new Uint8Array(64).fill(sequence % 251)), context);
		const envelope = { canonicalPreimageBytes: bytes, digest: hashDomain("ts-drp/vertex/v3", bytes), signature };
		return { authorSequence: sequence, envelope, issuedRecord: { authorSequence: sequence, envelope, scope },
			outboxEntry: { authorSequence: sequence, envelope, scope },
			...(context?.planEffect === undefined ? {} : { planEffect: context.planEffect }) };
	});
	await store.compareAndMarkOutboxPublished({ scope, authorSequence: commit.authorSequence, digest: commit.envelope.digest });
	return commit;
}

const move = (sequence: number, epoch: number) =>
	preimage(sequence, epoch, 1, { action: "place", id: `block-1-${sequence}`, x: sequence % 16, y: 3 });

/** The Writer's own moves of epoch 0 until its store refuses one; every refusal must be the typed capacity reason. */
async function admitUntilRefused(store: DurableIssuanceStore, context?: DurableIssueSignContext) {
	const sources: DurableIssueCommit[] = [];
	for (;;) {
		try {
			sources.push(await issue(store, (sequence) => move(sequence, 0), context));
		} catch (error) {
			return { sources, refusal: String((error as Error).message) };
		}
		if (sources.length > 2_048) throw new Error("the Writer's admission never refused");
	}
}

/** The install's settlement of epoch 0 in epoch 1: plan, fence, then one replacement per source. */
async function settle(store: DurableIssuanceStore, sources: readonly DurableIssueCommit[]) {
	let stage = "plan";
	let replaced = 0;
	try {
		await store.transactWriteSettlementPlan({ scope, expectedRevision: null, plan: {
			scope, revision: 0, fenceSequence: null,
			entries: sources.map((source) => ({ sourceSequence: source.authorSequence, sourceDigest: source.envelope.digest,
				disposition: "rebase" as const, replacementSequence: null })),
		} });
		stage = "fence";
		await issue(store, (sequence) => preimage(sequence, 1, MAX_DEPENDENCIES, { action: "$drp.authorFence", fenceSequence: sequence }),
			{ planEffect: { kind: "fence" } });
		stage = "replacement";
		for (const source of sources) {
			await issue(store, (sequence) => preimage(sequence, 1, MAX_DEPENDENCIES,
				{ action: "place", id: `block-1-${source.authorSequence}`, x: source.authorSequence % 16, y: 3 }),
			{ planEffect: { kind: "replacement", sourceSequence: source.authorSequence } });
			replaced++;
		}
		return { replaced, stage: "done", refusal: undefined };
	} catch (error) {
		const cause = (error as Error).cause;
		return { replaced, stage, refusal: `${String((error as Error).message)}${cause instanceof Error ? `: ${cause.message}` : ""}` };
	}
}

describe("a Writer's admission reserves its own settlement", () => {
	it("every move admitted with the reserve is replaced at the next install", async () => {
		const store = await openStore();
		const admitted = await admitUntilRefused(store, { settlementReplacementReserve: { maxDependencies: MAX_DEPENDENCIES } });
		expect(admitted.refusal).toContain("unsigned postimage exceeds row bound with its settlement replacement reserve");
		expect(admitted.sources.length).toBeGreaterThan(200);
		const settled = await settle(store, admitted.sources);
		process.stdout.write(`SETTLEMENT_RESERVE ${JSON.stringify({ admitted: admitted.sources.length, ...settled })}\n`);
		expect(settled).toEqual({ replaced: admitted.sources.length, stage: "done", refusal: undefined });
	}, 600_000);

	it("control: without the reserve the store admits moves whose replacements it then refuses", async () => {
		const store = await openStore();
		const admitted = await admitUntilRefused(store);
		expect(admitted.refusal).toContain("unsigned postimage exceeds row bound");
		const settled = await settle(store, admitted.sources);
		process.stdout.write(`SETTLEMENT_UNRESERVED ${JSON.stringify({ admitted: admitted.sources.length, ...settled })}\n`);
		// The plan row alone no longer fits; even with it, no replacement would.
		expect(settled.replaced).toBeLessThan(admitted.sources.length);
		expect(settled.refusal).toMatch(/exceeds (its )?row bound|row bound/u);
	}, 600_000);
});
