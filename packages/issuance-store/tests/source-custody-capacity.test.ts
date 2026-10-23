import {encodeCanonical, hashDomain} from "@ts-drp/canonical";
import {describe, expect, it} from "vitest";
import {copySettlementPlan} from "../src/contract.js";
import {issuanceCanonicalSettlementPlanStorageByteLength, issuanceSourceCustodyPlanResourceForSizing,
	issuanceUnsignedPostimageWidths, issuanceOrdinaryFinishingCapacityWidths, type IssuanceRetirementRows} from "../src/retirement.js";
import {d109bCommit} from "../../../tests/fixtures/phase-6b/issuance-retention-contract.js";

const scope = {objectId: "source-custody-capacity", author: "writer"};
const geometry = {maxContextByteLength: 74_107, maxNativeReadByteLength: 786_432};
const empty: IssuanceRetirementRows = {lineages: [], issued: [], outbox: [], plans: []};

describe("accepted source custody numerical reserve", () => {
	it.each([1, 127, 128])("bounds a maximum context and %i exact references in the full native carrier", count => {
		const bytes = new Uint8Array(geometry.maxContextByteLength), digest = hashDomain("ts-drp/settlement-source-context/v1", bytes);
		const plan = copySettlementPlan({scope, revision: Number.MAX_SAFE_INTEGER, fenceSequence: Number.MAX_SAFE_INTEGER,
			entries: Array.from({length: count}, (_, sourceSequence) => ({sourceSequence, sourceDigest: new Uint8Array(32),
				sourceContextDigest: digest, disposition: "manual-review", replacementSequence: null})),
			sourceContexts: [{digest, exactCanonicalContextBytes: bytes}]}, scope)!;
		expect(plan).toBeDefined();
		const canonical = encodeCanonical(plan), resource = issuanceSourceCustodyPlanResourceForSizing(scope, null, count, geometry);
		expect(canonical.byteLength).toBeLessThanOrEqual(resource.byteLength);
		const native = JSON.stringify({kind: "canonical-settlement-plan-1", bytes: Buffer.from(canonical).toString("base64")});
		expect(Buffer.byteLength(native)).toBe(issuanceCanonicalSettlementPlanStorageByteLength(canonical.byteLength));
		expect(Buffer.byteLength(native)).toBeLessThanOrEqual(resource.nativeStorageByteLength);
		expect(resource.nativeStorageByteLength).toBeGreaterThan(resource.byteLength);
	});
	it("charges the same custody alternative in exact and warmed native forecasts", () => {
		const commit = d109bCommit(scope, 0, 0);
		const intent = {kind: "v3-issuance-pending-unsigned-1" as const, authorSequence: 0,
			canonicalPreimageBytes: commit.envelope.canonicalPreimageBytes,
			digest: hashDomain("ts-drp/vertex/v3", commit.envelope.canonicalPreimageBytes)};
		const exact = issuanceUnsignedPostimageWidths(empty, scope, intent, null, geometry);
		const plain = issuanceUnsignedPostimageWidths(empty, scope, intent, null);
		const warmed = issuanceOrdinaryFinishingCapacityWidths({rows: empty, scope, control: null,
			maxAdditionalCurrentIssued: 1, maxCanonicalPreimageByteLength: intent.canonicalPreimageBytes.byteLength,
			sourceCustody: geometry});
		expect(exact.final.canonicalRowsBytes - plain.final.canonicalRowsBytes).toBeGreaterThan(geometry.maxContextByteLength);
		expect(warmed.ordinaryFinal.canonicalRowsBytes).toBeGreaterThanOrEqual(exact.final.canonicalRowsBytes);
		expect(warmed.planRewriteResource!.byteLength).toBeGreaterThan(2 * geometry.maxContextByteLength);
	});
	it("refuses a native wrapper overflow even when the canonical plan still fits", () => {
		const size = issuanceSourceCustodyPlanResourceForSizing(scope, null, 1, geometry);
		expect(() => issuanceSourceCustodyPlanResourceForSizing(scope, null, 1,
			{...geometry, maxNativeReadByteLength: size.byteLength})).toThrow("native read bound");
	});
});
