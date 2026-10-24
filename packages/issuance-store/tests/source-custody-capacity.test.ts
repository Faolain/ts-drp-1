import {encodeCanonical, hashDomain} from "@ts-drp/canonical";
import {describe, expect, it} from "vitest";
import {copySettlementPlan} from "../src/contract.js";
import {issuanceCanonicalSettlementPlanStorageByteLength, issuanceSourceCustodyPlanResourceForSizing,
	issuanceUnsignedPostimageWidths, issuanceOrdinaryFinishingCapacityWidths, type IssuanceRetirementRows} from "../src/retirement.js";
import {d109bCommit} from "../../../tests/fixtures/phase-6b/issuance-retention-contract.js";

const scope = {objectId: "source-custody-capacity", author: "writer"};
const geometry = {maxContextByteLength: 74_107, maxCompletionByteLength: 70_432, maxCompletionMemberByteLength: 512, maxExpiryByteLength: 1_024, maxNativeReadByteLength: 786_432};
const empty: IssuanceRetirementRows = {lineages: [], issued: [], outbox: [], plans: []};

describe("accepted source custody numerical reserve", () => {
	it.each([1, 127, 128])("bounds a maximum context and %i exact references in the full native carrier", count => {
		const bytes = new Uint8Array(geometry.maxContextByteLength), digest = hashDomain("ts-drp/settlement-source-context/v1", bytes);
		const proof = new Uint8Array(geometry.maxCompletionByteLength + count * geometry.maxCompletionMemberByteLength), resolution = hashDomain("ts-drp/settlement-source-context/v1", proof);
		const plan = copySettlementPlan({scope, revision: Number.MAX_SAFE_INTEGER, fenceSequence: Number.MAX_SAFE_INTEGER,
			entries: Array.from({length: count}, (_, sourceSequence) => ({sourceSequence, sourceDigest: new Uint8Array(32),
				sourceContextDigest: digest, sourceResolutionDigest: resolution, disposition: "committed", replacementSequence: null})),
			sourceContexts: [{digest, exactCanonicalContextBytes: bytes}, {digest: resolution, exactCanonicalContextBytes: proof}]
				.sort((a, b) => Buffer.compare(a.digest, b.digest))}, scope)!;
		expect(plan).toBeDefined();
		const canonical = encodeCanonical(plan), resource = issuanceSourceCustodyPlanResourceForSizing(scope, null, count, geometry);
		expect(canonical.byteLength).toBeLessThanOrEqual(resource.byteLength);
		const native = JSON.stringify({kind: "canonical-settlement-plan-1", bytes: Buffer.from(canonical).toString("base64")});
		expect(Buffer.byteLength(native)).toBe(issuanceCanonicalSettlementPlanStorageByteLength(canonical.byteLength));
		expect(Buffer.byteLength(native)).toBeLessThanOrEqual(resource.nativeStorageByteLength);
		expect(resource.nativeStorageByteLength).toBeGreaterThan(resource.byteLength);
	});
	it.each([1, 64, 128])("bounds %i sources all abandoned with maximum signed expiry resolutions", count => {
		const bytes = new Uint8Array(geometry.maxContextByteLength), digest = hashDomain("ts-drp/settlement-source-context/v1", bytes);
		const expiries = Array.from({length: count}, (_, index) => {
			const exactCanonicalContextBytes = new Uint8Array(geometry.maxExpiryByteLength).fill(index % 251, 0, 4);
			exactCanonicalContextBytes.set(new Uint8Array(new Uint32Array([index]).buffer), 4);
			return {digest: hashDomain("ts-drp/settlement-source-context/v1", exactCanonicalContextBytes), exactCanonicalContextBytes};
		});
		const plan = copySettlementPlan({scope, revision: Number.MAX_SAFE_INTEGER, fenceSequence: null,
			entries: expiries.map((expiry, sourceSequence) => ({sourceSequence, sourceDigest: new Uint8Array(32),
				sourceContextDigest: digest, sourceResolutionDigest: expiry.digest, disposition: "expire", replacementSequence: null})),
			sourceContexts: [{digest, exactCanonicalContextBytes: bytes}, ...expiries].sort((a, b) => Buffer.compare(a.digest, b.digest))}, scope)!;
		// count + 1 contexts stays within the entries * 2 context cap.
		expect(plan).toBeDefined();
		expect(plan.sourceContexts).toHaveLength(count + 1);
		const canonical = encodeCanonical(plan), resource = issuanceSourceCustodyPlanResourceForSizing(scope, null, count, geometry);
		expect(canonical.byteLength).toBeLessThanOrEqual(resource.byteLength);
		const native = JSON.stringify({kind: "canonical-settlement-plan-1", bytes: Buffer.from(canonical).toString("base64")});
		expect(Buffer.byteLength(native)).toBeLessThanOrEqual(resource.nativeStorageByteLength);
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
	it("accepts the exact native carrier ceiling and refuses one byte below with maximum source and completion contexts", () => {
		const size = issuanceSourceCustodyPlanResourceForSizing(scope, null, 128, geometry);
		expect(issuanceSourceCustodyPlanResourceForSizing(scope, null, 128,
			{...geometry, maxNativeReadByteLength: size.nativeStorageByteLength})).toEqual(size);
		expect(() => issuanceSourceCustodyPlanResourceForSizing(scope, null, 128,
			{...geometry, maxNativeReadByteLength: size.nativeStorageByteLength - 1})).toThrow("native read bound");
	});
	it("retains existing whole contexts when reserving another epoch completion", () => {
		const context = (size: number, marker: number) => {const exactCanonicalContextBytes = new Uint8Array(size).fill(marker);
			return {digest: hashDomain("ts-drp/settlement-source-context/v1", exactCanonicalContextBytes), exactCanonicalContextBytes};};
		const source = context(geometry.maxContextByteLength, 1), proof = context(geometry.maxCompletionByteLength, 2);
		const prior = copySettlementPlan({scope, revision: 0, fenceSequence: null, entries: [{sourceSequence: 0,
			sourceDigest: new Uint8Array(32), sourceContextDigest: source.digest, sourceResolutionDigest: proof.digest,
			disposition: "committed", replacementSequence: null}], sourceContexts: [source, proof].sort((a, b) => Buffer.compare(a.digest, b.digest))}, scope)!;
		const baseline = issuanceSourceCustodyPlanResourceForSizing(scope, null, 1, geometry);
		const retained = issuanceSourceCustodyPlanResourceForSizing(scope, prior, 1, geometry);
		expect(retained.byteLength - baseline.byteLength).toBeGreaterThan(source.exactCanonicalContextBytes.length + proof.exactCanonicalContextBytes.length);
		expect(() => issuanceSourceCustodyPlanResourceForSizing(scope, prior, 1,
			{...geometry, maxNativeReadByteLength: baseline.nativeStorageByteLength})).toThrow("native read bound");
	});
	it("refuses a native wrapper overflow even when the canonical plan still fits", () => {
		const size = issuanceSourceCustodyPlanResourceForSizing(scope, null, 1, geometry);
		expect(() => issuanceSourceCustodyPlanResourceForSizing(scope, null, 1,
			{...geometry, maxNativeReadByteLength: size.byteLength})).toThrow("native read bound");
	});
});
