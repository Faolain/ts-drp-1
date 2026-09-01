import "fake-indexeddb/auto";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import {
	D109D_CENSUS_KEYS,
	D109D_ERROR_CODES,
	D109D_GREEN_PATHS,
	D109D_IDENTITY_MUTANTS,
	D109D_INPUT_KEYS,
	D109D_PRECEDENCE,
	D109D_RECEIPT_MUTANTS,
	D109D_RED_PATHS,
	D109D_REPLAY_AUTHORITY_MUTANTS,
	D109D_REPLAY_OUTCOME_FIELDS,
	D109D_SUCCESS_KEYS,
	d109dReadiness,
	d109dSourceGovernance,
	openD109dHotFixture,
	REPOSITORY_ROOT,
} from "./fixtures/phase-6b/runtime-reclamation-contract.js";

const readiness = d109dReadiness();

beforeAll(() => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
	});
});

function greenContractPending(name: string): never {
	throw new TypeError(`D109D_GREEN_CONTRACT_PENDING:${name}`);
}

describe("D.109d receipt-gated installed-v3 runtime reclamation RED", () => {
	it("freezes exactly two RED and three GREEN owners", () => {
		expect(D109D_RED_PATHS).toEqual([
			"tests/fixtures/phase-6b/runtime-reclamation-contract.ts",
			"tests/phase-6b-runtime-reclamation-red.test.ts",
		]);
		expect(D109D_GREEN_PATHS).toEqual([
			"packages/node/src/internal/runtime-reclamation.ts",
			"packages/node/src/v3-live.ts",
			"packages/node/src/creator-close.ts",
		]);
		expect(new Set([...D109D_RED_PATHS, ...D109D_GREEN_PATHS]).size).toBe(5);
		expect(D109D_RED_PATHS.every((entry) => readFileSync(resolve(REPOSITORY_ROOT, entry)).byteLength > 0)).toBe(true);
	});

	it("freezes the closed input, result, error and precedence contracts", () => {
		expect(D109D_INPUT_KEYS).toEqual(["aheReceipt", "issuanceReceipt", "successor"]);
		expect(D109D_SUCCESS_KEYS).toEqual([
			"after",
			"before",
			"closedEpoch",
			"objectId",
			"ok",
			"replay",
			"successorEpoch",
		]);
		expect(D109D_ERROR_CODES).toEqual([
			"D109D_INVALID_ARGUMENT",
			"D109D_RECEIPT_MISMATCH",
			"D109D_IDENTITY_MISMATCH",
			"D109D_RUNTIME_NOT_READY",
			"D109D_INTERNAL_INVARIANT",
		]);
		expect(D109D_PRECEDENCE).toEqual([
			"shape",
			"receipt-internal",
			"identity",
			"registration-bound",
			"readiness",
			"internal",
		]);
	});

	it("freezes the complete receipt, identity, replay and census matrices", () => {
		expect(D109D_RECEIPT_MUTANTS).toHaveLength(27);
		expect(D109D_IDENTITY_MUTANTS).toHaveLength(7);
		expect(D109D_REPLAY_AUTHORITY_MUTANTS).toHaveLength(14);
		expect(D109D_REPLAY_OUTCOME_FIELDS).toEqual([
			"issuanceReceipt.deletedAuthorSequenceRange",
			"aheReceipt.deletedBlobDigests",
			"aheReceipt.deletedGenerationIds",
			"aheReceipt.deletedPromotionCount",
			"aheReceipt.floor.normalizedThisCall",
		]);
		expect(D109D_REPLAY_AUTHORITY_MUTANTS).toContain("issuance-observed-lineage");
		expect(D109D_REPLAY_AUTHORITY_MUTANTS).toContain("ahe-reclaimed-generation-ids");
		expect(D109D_REPLAY_OUTCOME_FIELDS.some((field) => /observedLineage|reclaimedGenerationIds/u.test(field))).toBe(
			false
		);
		expect(D109D_CENSUS_KEYS).toHaveLength(22);
		expect(new Set(D109D_CENSUS_KEYS).size).toBe(D109D_CENSUS_KEYS.length);
	});

	it("keeps runtime reclamation internal and the legacy object runtime detached", () => {
		expect(d109dSourceGovernance()).toEqual({
			noLegacyObjectBinding: true,
			noManifestExport: true,
			noProductHandleMethod: true,
			noRootExport: true,
		});
	});

	it("[RED readiness] requires the private runtime and creator-close release kernels", () => {
		expect(readiness, "D109D_RUNTIME_RECLAMATION_MISSING").toEqual({ missing: [], ready: true });
	});

	it.skipIf(!readiness.ready)("uses genuine close, verify, commit and hot activation identities", async () => {
		const fixture = await openD109dHotFixture();
		try {
			expect(fixture.successor).not.toBe(fixture.predecessor);
			expect(fixture.oracle.epoch).toBe(1);
			expect(fixture.successor.topic).toBe(fixture.oracle.stableTopic);
			greenContractPending("genuine-receipts");
		} finally {
			await fixture.close();
		}
	});

	it.skipIf(!readiness.ready)("enforces the exact refusal matrix and precedence with zero writes", () => {
		greenContractPending("refusal-matrix");
	});

	it.skipIf(!readiness.ready)("accepts hot and cold real receipts and latches every authority field", () => {
		greenContractPending("hot-cold-authority");
	});

	it.skipIf(!readiness.ready)("serializes behind successor and predecessor gates with atomic observation", () => {
		greenContractPending("serialization");
	});

	it.skipIf(!readiness.ready)("releases every predecessor owner while preserving the live successor", () => {
		greenContractPending("census-and-dependencies");
	});

	it.skipIf(!readiness.ready)("returns frozen replay success and refuses changed authority after release", () => {
		greenContractPending("replay-latch");
	});

	it.skipIf(!readiness.ready)("keeps precommit construction failure byte-identical and subsequently usable", () => {
		greenContractPending("precommit-failure");
	});
});
