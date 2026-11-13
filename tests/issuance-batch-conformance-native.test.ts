import { ed25519 } from "@noble/curves/ed25519.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DurableIssuanceStore } from "@ts-drp/issuance-store";
import { createEphemeralDurableIssuanceStore } from "@ts-drp/issuance-store/conformance";
import { afterEach, describe, expect, it } from "vitest";

import { runBatchConformance } from "./fixtures/issuance-batch/conformance.js";
import { createTransactionalVertexIssuer, type IssueCommit } from "../packages/protocol-v3/src/index.js";
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
		expect(report.commit!.revisionAfter).toBe((report.commit!.revisionBefore as number) + 8);
		expect(report.commit!.revisionAfter).toBe(report.commit!.revisionSingles);
		if (native) expect(report.commit!.signed).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
		expect(report.revisionCas).toEqual({ ok: false, code: "ISSUANCE_RETRY_REQUIRED", signed: 0, unchanged: true, retryOk: true });
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
		expect(report.precondition).toMatchObject({ ok: false, code: "ISSUANCE_RETRY_REQUIRED", unchanged: true, restOk: true });
		if (native) expect(report.precondition!.signed).toBe(0);
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
	const issuerOf = (store: DurableIssuanceStore) =>
		createTransactionalVertexIssuer({
			author,
			privateKeySeed: seed,
			publicKey: { bytes: publicKey, format: "raw" },
			transactIssue: (scope, build) => store.transactIssue(scope, build),
		});
	const singles: IssueCommit[] = [];
	for (const [index, operation] of operations.entries())
		singles.push(
			await issuerOf(singlesStore).issue({
				anchor,
				dependencies: index === 0 ? [root] : [Buffer.from(singles[index - 1]!.envelope.digest).toString("hex")],
				epoch: 1,
				logicalTime: 1 + 2 * index,
				objectId,
				operation,
			})
		);
	const batched = await issuerOf(batchStore).issueBatch(
		{ anchor, dependencies: [root], epoch: 1, objectId, entries: operations.map((operation, index) => ({ logicalTime: 1 + 2 * index, operation })) },
		(scope, count, build) =>
			batchStore.transactIssueBatch!({ scope, count, expectedPlanRevision: null }, (first, admission) =>
				build(
					first,
					admission === undefined
						? undefined
						: (preimages, sign) => admission(preimages.map((bytes) => ({ exactCanonicalUnsignedVertexBytes: bytes })), sign)
				)
			)
	);
	const view = (commits: readonly IssueCommit[]) =>
		commits.map((commit) => ({
			authorSequence: commit.authorSequence,
			preimage: Buffer.from(commit.envelope.canonicalPreimageBytes).toString("hex"),
			digest: Buffer.from(commit.envelope.digest).toString("hex"),
			signature: Buffer.from(commit.envelope.signature).toString("hex"),
		}));
	expect(batched).toHaveLength(8);
	expect(view(batched)).toEqual(view(singles));
	expect(await batchStore.readLineage({ objectId, author })).toEqual(await singlesStore.readLineage({ objectId, author }));
}, 60_000);
