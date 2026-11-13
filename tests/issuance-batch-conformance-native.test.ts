import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DurableIssuanceStore } from "@ts-drp/issuance-store";
import { createEphemeralDurableIssuanceStore } from "@ts-drp/issuance-store/conformance";
import { afterEach, describe, expect, it } from "vitest";

import { runBatchConformance } from "./fixtures/issuance-batch/conformance.js";
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
