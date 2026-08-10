import { describe, expect, it } from "vitest";

import { phase2e6Edges, PHASE_2E5_BROWSER_REQUEST_INVENTORY } from "./fixtures/phase-2e5-browser-request-inventory.js";
import {
	declaredPhase2gObservations,
	derivePhase2gQuotaEdges,
	phase2gEngineQuotaErrors,
	phase2gQuotaCaseErrors,
	type Phase2gQuotaCaseEvidence,
	phase2gQuotaInventoryErrors,
	phase2gRejectedInputErrors,
	type Phase2gWholeImage,
} from "./fixtures/phase-2g-c-quota-fault-contract.js";

const hex = (value: string): string =>
	[...value].map((character) => character.charCodeAt(0).toString(16).padStart(2, "0")).join("");

const image = (label: string): Phase2gWholeImage => ({
	schemaVersion: 1,
	storeCensus: ["blobs", "generations", "objects", "promotions"],
	stores: {
		blobs: [
			{ keyBytesHex: hex("global-blob"), valueBytesHex: hex(`global-blob:${label}`) },
			{ keyBytesHex: hex("unrelated-adopted-blob"), valueBytesHex: hex(`unrelated-adopted-blob:${label}`) },
		],
		generations: [
			{ keyBytesHex: hex("subject-generation"), valueBytesHex: hex(`subject-generation:${label}`) },
			{
				keyBytesHex: hex("unrelated-adopted-generation"),
				valueBytesHex: hex(`unrelated-adopted-generation:${label}`),
			},
		],
		objects: [
			{ keyBytesHex: hex("subject-head"), valueBytesHex: hex(`subject-head:${label}`) },
			{ keyBytesHex: hex("unrelated-adopted-head"), valueBytesHex: hex(`unrelated-adopted-head:${label}`) },
		],
		promotions: [
			{ keyBytesHex: hex("subject-promotion"), valueBytesHex: hex(`subject-promotion:${label}`) },
			{
				keyBytesHex: hex("unrelated-adopted-promotion"),
				valueBytesHex: hex(`unrelated-adopted-promotion:${label}`),
			},
		],
	},
});

describe("Phase 2g-c finite quota-fault acceptance contract", () => {
	it("preserves frozen 8/10/28 and 2e6 18 while deriving extended 9/13/35", () => {
		const historical = PHASE_2E5_BROWSER_REQUEST_INVENTORY.filter(
			(row) => row.transaction?.mode === "readwrite" && row.transaction.terminal === "complete" && row.writes.length > 0
		);
		expect(historical).toHaveLength(8);
		expect(historical.flatMap(({ writes }) => writes)).toHaveLength(10);
		expect(phase2e6Edges(PHASE_2E5_BROWSER_REQUEST_INVENTORY)).toHaveLength(18);
		const observed = declaredPhase2gObservations();
		expect(phase2gQuotaInventoryErrors(observed)).toEqual([]);
		const edges = derivePhase2gQuotaEdges(observed);
		expect(edges).toHaveLength(35);
		expect(edges.filter(({ target }) => target === "creation")).toHaveLength(13);
		expect(edges.filter(({ target }) => target === "settlement")).toHaveLength(13);
		expect(edges.filter(({ target }) => target === "terminal")).toHaveLength(9);
	});

	it("derives occurrence-sensitive cases rather than a handwritten syntax matrix", () => {
		const observed = declaredPhase2gObservations();
		const edges = derivePhase2gQuotaEdges(observed);
		const supersession = edges.filter(({ scenarioId }) => scenarioId === "swap-head-present-supersession");
		expect(supersession.map(({ target }) => target)).toEqual([
			"creation",
			"settlement",
			"creation",
			"settlement",
			"creation",
			"settlement",
			"terminal",
		]);
		expect(new Set(edges.map(({ id }) => id)).size).toBe(35);
	});

	it("kills every named hollow quota oracle", () => {
		const edge = derivePhase2gQuotaEdges(declaredPhase2gObservations())[0];
		if (edge === undefined) throw new Error("missing quota edge control");
		const before = image("old");
		const expectedNew = image("new");
		const control: Phase2gQuotaCaseEvidence = {
			afterReopen: before,
			before,
			causeIsSameObject: true,
			causeIsSameRealmDOMException: true,
			causeName: "QuotaExceededError",
			edgeId: edge.id,
			expectedNew,
			faultsFired: 1,
			operationReturnedAfterTerminal: true,
			quotaReasonAbsent: true,
			resultReason: "SUBSTRATE_FAILURE",
			retry: expectedNew,
			retryResult: "OK",
			selectedOccurrenceInTrace: true,
			staleRecoveryCertificateCleared: true,
			storeRemainedOpenAndUnpoisoned: true,
		};
		expect(phase2gQuotaCaseErrors(edge, control)).toEqual([]);
		const headOnlyLeak = {
			...before,
			stores: {
				...before.stores,
				blobs: [...before.stores.blobs, { keyBytesHex: "00", valueBytesHex: "ff" }],
			},
		};
		const missingPromotion = {
			...expectedNew,
			stores: { ...expectedNew.stores, promotions: expectedNew.stores.promotions.slice(1) },
		};
		const mutants: readonly Phase2gQuotaCaseEvidence[] = [
			{ ...control, afterReopen: headOnlyLeak },
			{ ...control, retry: missingPromotion },
			{ ...control, operationReturnedAfterTerminal: false },
			{ ...control, storeRemainedOpenAndUnpoisoned: false },
			{ ...control, causeIsSameObject: false },
			{ ...control, selectedOccurrenceInTrace: false },
			{ ...control, staleRecoveryCertificateCleared: false },
		];
		for (const mutant of mutants) expect(phase2gQuotaCaseErrors(edge, mutant)).not.toEqual([]);
	});

	it("kills omission of the real present-head supersession branch", () => {
		const observed = declaredPhase2gObservations();
		expect(phase2gQuotaInventoryErrors(observed.slice(0, -1))).not.toEqual([]);
	});

	it("requires armed invalid and semantic rejections to remain zero-write and zero-fault", () => {
		for (const resultReason of ["INVALID_ARGUMENT", "GENERATION_ALREADY_EXISTS"] as const) {
			expect(phase2gRejectedInputErrors({ faultArmed: true, faultsFired: 0, resultReason, writesObserved: 0 })).toEqual(
				[]
			);
		}
		expect(
			phase2gRejectedInputErrors({
				faultArmed: true,
				faultsFired: 1,
				resultReason: "INVALID_ARGUMENT",
				writesObserved: 1,
			})
		).not.toEqual([]);
	});

	it("fails closed when the bounded Chromium engine control is skipped, injected, or unbounded", () => {
		const control = {
			capBytes: 16 * 1024 * 1024,
			elapsedMilliseconds: 10,
			engineGenerated: true,
			faultProduced: true,
			name: "QuotaExceededError",
			supportedOverrideAttempted: true,
			timeoutMilliseconds: 15_000,
		};
		expect(phase2gEngineQuotaErrors(control)).toEqual([]);
		for (const mutant of [
			{ ...control, faultProduced: false },
			{ ...control, engineGenerated: false },
			{ ...control, supportedOverrideAttempted: false },
			{ ...control, capBytes: 16 * 1024 * 1024 + 1 },
			{ ...control, timeoutMilliseconds: 15_001 },
		])
			expect(phase2gEngineQuotaErrors(mutant)).not.toEqual([]);
	});
});
