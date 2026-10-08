import "fake-indexeddb/auto";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { openGenuineCreatorAdoptionFixture } from "./fixtures/phase-6a-v3/creator-adoption-contract.js";

const NODE_SOURCE_PATH = resolve(import.meta.dirname, "../packages/node/src/v3-live.ts");
const JOURNAL_CONTRACT_PATH = resolve(import.meta.dirname, "../packages/live-journal/src/contract.ts");
const ADDITIONAL_ROWS = 127;

beforeAll(() => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000, usage: 0 }) }),
	});
});

function d110apSourceAudit(): Readonly<{
	readonly ownerUsesBoundedPagination: boolean;
	readonly publicPageLimitIs128: boolean;
}> {
	const nodeSource = readFileSync(NODE_SOURCE_PATH, "utf8");
	const journalContractSource = readFileSync(JOURNAL_CONTRACT_PATH, "utf8");
	const ownerStart = nodeSource.indexOf("async function readCreatorReplayRows(");
	const ownerEnd = nodeSource.indexOf("async function sealCreatorDurableReplay(", ownerStart);
	const owner = ownerStart >= 0 && ownerEnd > ownerStart ? nodeSource.slice(ownerStart, ownerEnd) : "";
	return Object.freeze({
		ownerUsesBoundedPagination:
			!owner.includes("limit: readiness.rowCount") &&
			/while\s*\(rows\.length < readiness\.rowCount\)/u.test(owner) &&
			/limit:\s*Math\.min\(128, remaining\)/u.test(owner) &&
			/page\.rows\.length === 0/u.test(owner) &&
			/page\.rows\.length > remaining/u.test(owner) &&
			/page\.nextSequence !== expectedNext/u.test(owner),
		publicPageLimitIs128: /isSafeIntegerBetween\(limit, 1, 128\)/u.test(journalContractSource),
	});
}

describe("D.110a-p creator durable-replay pagination RED", () => {
	it("closes a genuine 129-row creator journal across the public page boundary", async () => {
		let opened: Awaited<ReturnType<typeof openGenuineCreatorAdoptionFixture>> | undefined;
		try {
			opened = await openGenuineCreatorAdoptionFixture({
				beforeCreatorClose: async ({ firstLogicalTime, plane, signRegisteredVertexDigest }) => {
					let latest: Readonly<{ readonly authorSequence: number; readonly digest: string }> | undefined;
					for (let index = 0; index < ADDITIONAL_ROWS; index += 1) {
						const issued = await plane.issueLocal({
							operations: Object.freeze([
								Object.freeze({
									logicalTime: firstLogicalTime + index,
									operation: Object.freeze({ action: "add", value: 1 }),
								}),
							]),
							signRegisteredVertexDigest,
						});
						if (!issued.ok) throw new TypeError(`D110AP_ISSUE_FAILED:${issued.kind}:${issued.detail}`);
						const published = await plane.publishPending();
						if (!published.ok || published.kind !== "published") {
							throw new TypeError(`D110AP_PUBLISH_FAILED:${published.kind}`);
						}
						latest = Object.freeze({ authorSequence: issued.authorSequence, digest: issued.digest });
					}
					if (latest === undefined) throw new TypeError("D110AP_LAST_ISSUE_MISSING");
					return latest;
				},
			});
			expect(opened.evidence.journalRows).toHaveLength(129);
			expect(opened.evidence.localIssued.authorSequence).toBe(ADDITIONAL_ROWS + 1);
		} finally {
			await opened?.close();
		}
	});

	it("keeps the public bound and requires bounded private-owner pagination", () => {
		expect(d110apSourceAudit()).toEqual({
			ownerUsesBoundedPagination: true,
			publicPageLimitIs128: true,
		});
	});
});
