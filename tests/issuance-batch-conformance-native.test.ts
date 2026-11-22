import { ed25519 } from "@noble/curves/ed25519.js";
import type { DurableIssuanceStore } from "@ts-drp/issuance-store";
import { createEphemeralDurableIssuanceStore } from "@ts-drp/issuance-store/conformance";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runBatchConformance } from "./fixtures/issuance-batch/conformance.js";
import {
	createTransactionalVertexIssuer,
	type IssueCommit,
	type TransactionalVertexIssuer,
} from "../packages/protocol-v3/src/index.js";
import { createNodeDurableIssuanceStore } from "../packages/storage-node/src/issuance.js";

// transactIssueBatch conformance on the ephemeral control and the SQLite store (the IndexedDB store
// runs the same driver in packages/storage-browser/tests/issuance-batch.pw.ts).

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
		const directory = mkdtempSync(join(tmpdir(), `issuance-batch-${name}-`));
		directories.push(directory);
		const store = createNodeDurableIssuanceStore({ primaryFilename: join(directory, "issuance.sqlite") });
		stores.push(store);
		return Promise.resolve(store);
	},
} as const;

describe.each(Object.keys(factories) as (keyof typeof factories)[])("transactIssueBatch on %s", (kind) => {
	it("commits whole, refuses whole, and equals the same singles", async () => {
		const native = kind !== "ephemeral";
		const report = (await runBatchConformance(factories[kind], native)) as Record<string, Record<string, unknown>>;
		process.stdout.write(`ISSUANCE_BATCH_CONFORMANCE ${kind} ${JSON.stringify(report)}\n`);
		expect(report.commit).toMatchObject({
			ok: true,
			sequences: [9, 10, 11, 12, 13, 14, 15, 16],
			lineageBefore: { exhausted: false, next: 9 },
			lineageAfter: { exhausted: false, next: 17 },
			issuedAfter: [9, 10, 11, 12, 13, 14, 15, 16],
			planEqualsSingles: true,
			replaced: [9, 10, 11, 12, 13, 14, 15, 16],
		});
		const commit = report.commit ?? {};
		expect(commit.revisionAfter).toBe((commit.revisionBefore as number) + 8);
		expect(commit.revisionAfter).toBe(commit.revisionSingles);
		if (native) expect(commit.signed).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
		expect(report.revisionCas).toEqual({
			ok: false,
			code: "ISSUANCE_RETRY_REQUIRED",
			signed: 0,
			unchanged: true,
			retryOk: true,
		});
		expect(report.validation).toEqual({ ok: false, code: "ISSUANCE_COMMIT_INVALID", unchanged: true });
		expect(report.duplicate).toMatchObject({
			duplicateOk: false,
			duplicateCode: "ISSUANCE_COMMIT_INVALID",
			mixedOk: false,
			mixedCode: "ISSUANCE_COMMIT_INVALID",
			unchanged: true,
			thenValidOk: true,
		});
		if (native) expect(report.duplicate).toMatchObject({ duplicateSigned: 0, mixedSigned: 0 });
		expect(report.precondition).toMatchObject({
			ok: false,
			code: "ISSUANCE_RETRY_REQUIRED",
			unchanged: true,
			restOk: true,
		});
		if (native) expect(report.precondition?.signed).toBe(0);
		expect(report.progress).toEqual({
			firstOk: true,
			secondOk: true,
			midEqualsSingles: true,
			endEqualsSingles: true,
			twoChunksOneBatchOk: false,
			twoChunksOneBatchCode: "ISSUANCE_COMMIT_INVALID",
		});
		if (native)
			expect(report.resume).toEqual({
				failedOk: false,
				failedCode: "ISSUANCE_OUTCOME_UNKNOWN",
				between: [null, null, null, null],
				foreignOk: false,
				resumedOk: true,
				after: [5, 6, 7, 8],
				lineageAfter: { exhausted: false, next: 9 },
			});
		if (native)
			expect(report.prefix).toEqual({
				stoppedOk: true,
				stoppedCode: null,
				sequences: [9, 10, 11],
				signed: [9, 10, 11],
				lineageBetween: { exhausted: false, next: 12 },
				issuedBetween: [9, 10, 11, null, null, null, null, null],
				replacedBetween: [9, 10, 11, null, null, null, null, null],
				revisionStep: 3,
				restOk: true,
				restSequences: [12, 13, 14, 15, 16],
				issuedAfter: [9, 10, 11, 12, 13, 14, 15, 16],
				planEqualsSingles: true,
			});
		if (native)
			expect(report.sizing).toMatchObject({
				overOk: false,
				overSigned: 0,
				unchanged: true,
				fitsOk: true,
				after: [9, 10, 11, 12, 13, 14, 15, null],
				chargedCoversWritten: true,
			});
	}, 120_000);
});

// The vertices a batch signs are the vertices the same singles sign: byte-identical preimages
// (dependencies chained, row i on row i-1's digest, as a frontier the previous single left; the same
// logical times), digests and (deterministic Ed25519) signatures.
it("issueBatch signs exactly the vertices the same sequential singles sign", async () => {
	const seed = new Uint8Array(32).fill(7);
	const publicKey = ed25519.getPublicKey(seed);
	const author = Buffer.from(publicKey).toString("hex");
	const objectId = "issuance-batch-equivalence";
	const anchor = "a".repeat(64);
	const root = "b".repeat(64);
	const operations = Array.from({ length: 8 }, (_, index) => ({ action: "place", id: `m-${index}`, x: index, y: 2 }));
	const singlesStore = await factories.sqlite("equivalence-singles");
	const batchStore = await factories.sqlite("equivalence-batch");
	const issuerOf = (store: DurableIssuanceStore): TransactionalVertexIssuer =>
		createTransactionalVertexIssuer({
			author,
			privateKeySeed: seed,
			publicKey: { bytes: publicKey, format: "raw" },
			transactIssue: (scope, build) => store.transactIssue(scope, build),
		});
	const singles: IssueCommit[] = [];
	for (const operation of operations) {
		const previous = singles.at(-1);
		singles.push(
			await issuerOf(singlesStore).issue({
				anchor,
				dependencies: previous === undefined ? [root] : [Buffer.from(previous.envelope.digest).toString("hex")],
				epoch: 1,
				logicalTime: 1 + 2 * singles.length,
				objectId,
				operation,
			})
		);
	}
	const transactIssueBatch = batchStore.transactIssueBatch;
	if (transactIssueBatch === undefined) throw new Error("the SQLite store has no transactIssueBatch");
	const batched = await issuerOf(batchStore).issueBatch(
		{
			anchor,
			dependencies: [root],
			epoch: 1,
			objectId,
			entries: operations.map((operation, index) => ({ logicalTime: 1 + 2 * index, operation })),
		},
		(scope, count, build) =>
			transactIssueBatch({ scope, count, expectedPlanRevision: null }, (first, admission) =>
				build(
					first,
					admission === undefined
						? undefined
						: (preimages, sign): Promise<readonly Uint8Array[]> =>
								admission(
									preimages.map((bytes) => ({ exactCanonicalUnsignedVertexBytes: bytes })),
									sign
								)
				)
			)
	);
	const view = (
		commits: readonly IssueCommit[]
	): { authorSequence: number; preimage: string; digest: string; signature: string }[] =>
		commits.map((commit) => ({
			authorSequence: commit.authorSequence,
			preimage: Buffer.from(commit.envelope.canonicalPreimageBytes).toString("hex"),
			digest: Buffer.from(commit.envelope.digest).toString("hex"),
			signature: Buffer.from(commit.envelope.signature).toString("hex"),
		}));
	expect(batched).toHaveLength(8);
	expect(view(batched)).toEqual(view(singles));
	expect(await batchStore.readLineage({ objectId, author })).toEqual(
		await singlesStore.readLineage({ objectId, author })
	);
}, 60_000);

// Rule R (fix/browser-rollover-member-stall, blocker (a)): a caller that stops a batch before a row's
// signature (the creator sealed the epoch mid-chunk) gets the signed prefix committed alone: the issuer
// builds commits for the rows signed, the same vertices as the first singles, and the lineage advances
// past them only.
it("issueBatch stopped before its 4th signature commits the 3 signed vertices, the same as the first singles", async () => {
	const seed = new Uint8Array(32).fill(9);
	const publicKey = ed25519.getPublicKey(seed);
	const author = Buffer.from(publicKey).toString("hex");
	const objectId = "issuance-batch-prefix";
	const anchor = "a".repeat(64);
	const root = "b".repeat(64);
	const operations = Array.from({ length: 8 }, (_, index) => ({ action: "place", id: `m-${index}`, x: index, y: 2 }));
	const singlesStore = await factories.sqlite("prefix-singles");
	const batchStore = await factories.sqlite("prefix-batch");
	const issuerOf = (store: DurableIssuanceStore): TransactionalVertexIssuer =>
		createTransactionalVertexIssuer({
			author,
			privateKeySeed: seed,
			publicKey: { bytes: publicKey, format: "raw" },
			transactIssue: (scope, build) => store.transactIssue(scope, build),
		});
	const singles: IssueCommit[] = [];
	for (const operation of operations.slice(0, 3)) {
		const previous = singles.at(-1);
		singles.push(
			await issuerOf(singlesStore).issue({
				anchor,
				dependencies: previous === undefined ? [root] : [Buffer.from(previous.envelope.digest).toString("hex")],
				epoch: 1,
				logicalTime: 1 + 2 * singles.length,
				objectId,
				operation,
			})
		);
	}
	const transactIssueBatch = batchStore.transactIssueBatch;
	if (transactIssueBatch === undefined) throw new Error("the SQLite store has no transactIssueBatch");
	const asked: number[] = [];
	const batched = await issuerOf(batchStore).issueBatch(
		{
			anchor,
			dependencies: [root],
			epoch: 1,
			objectId,
			entries: operations.map((operation, index) => ({ logicalTime: 1 + 2 * index, operation })),
		},
		(scope, count, build) =>
			transactIssueBatch({ scope, count, expectedPlanRevision: null }, (first, admission) =>
				build(
					first,
					admission === undefined
						? undefined
						: (preimages, sign): Promise<readonly Uint8Array[]> =>
								admission(
									preimages.map((bytes) => ({ exactCanonicalUnsignedVertexBytes: bytes })),
									sign,
									undefined,
									(index) => {
										asked.push(index);
										return index < 3;
									}
								)
				)
			)
	);
	const view = (
		commits: readonly IssueCommit[]
	): { authorSequence: number; preimage: string; digest: string; signature: string }[] =>
		commits.map((commit) => ({
			authorSequence: commit.authorSequence,
			preimage: Buffer.from(commit.envelope.canonicalPreimageBytes).toString("hex"),
			digest: Buffer.from(commit.envelope.digest).toString("hex"),
			signature: Buffer.from(commit.envelope.signature).toString("hex"),
		}));
	// Asked before each signature after the first, until it says stop.
	expect(asked).toEqual([1, 2, 3]);
	expect(view(batched)).toEqual(view(singles));
	expect(await batchStore.readLineage({ objectId, author })).toEqual({ exhausted: false, next: 3 });
	expect(await batchStore.readIssued({ objectId, author }, 3)).toBeNull();
}, 60_000);
