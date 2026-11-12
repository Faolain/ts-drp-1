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
	it.each([2, 64, 128])("bounds %i sources resolved from the settlement frontier beside a maximum completion", count => {
		// One source committed by a maximum completion proof; every other source resolved from the
		// frontier with a maximum signed expiry. The frontier kind is charged on every potential row.
		const bytes = new Uint8Array(geometry.maxContextByteLength), digest = hashDomain("ts-drp/settlement-source-context/v1", bytes);
		const proof = new Uint8Array(geometry.maxCompletionByteLength + count * geometry.maxCompletionMemberByteLength), completion = hashDomain("ts-drp/settlement-source-context/v1", proof);
		const expiries = Array.from({length: count - 1}, (_, index) => {
			const exactCanonicalContextBytes = new Uint8Array(geometry.maxExpiryByteLength).fill(index % 251, 0, 4);
			exactCanonicalContextBytes.set(new Uint8Array(new Uint32Array([index]).buffer), 4);
			return {digest: hashDomain("ts-drp/settlement-source-context/v1", exactCanonicalContextBytes), exactCanonicalContextBytes};
		});
		const base = Number.MAX_SAFE_INTEGER - count;
		const plan = copySettlementPlan({scope, revision: Number.MAX_SAFE_INTEGER, fenceSequence: Number.MAX_SAFE_INTEGER,
			entries: [{sourceSequence: base, sourceDigest: new Uint8Array(32), sourceContextDigest: digest,
				sourceResolutionDigest: completion, disposition: "committed" as const, replacementSequence: null},
			...expiries.map((expiry, index) => ({sourceSequence: base + 1 + index, sourceDigest: new Uint8Array(32),
				sourceContextDigest: digest, sourceResolutionDigest: expiry.digest, sourceResolutionKind: "frontier" as const,
				disposition: "expire" as const, replacementSequence: null}))],
			sourceContexts: [{digest, exactCanonicalContextBytes: bytes}, {digest: completion, exactCanonicalContextBytes: proof}, ...expiries]
				.sort((a, b) => Buffer.compare(a.digest, b.digest))}, scope)!;
		expect(plan).toBeDefined();
		expect(plan.entries.filter(entry => entry.sourceResolutionKind === "frontier")).toHaveLength(count - 1);
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
	// fix/creator-replaced-source-resolution (b): a completed replacement entry may later carry a write-once
	// replaced-source frontier resolution (the scope and frontier kind on a `rebase`/`transform` with its
	// replacement) and its signed receipt context. Both forms are charged: every potential row, and every
	// existing completed replacement entry that is still unresolved.
	const receipts = (count: number) => Array.from({length: count}, (_, index) => {
		const exactCanonicalContextBytes = new Uint8Array(geometry.maxExpiryByteLength).fill(index % 251, 0, 4);
		exactCanonicalContextBytes.set(new Uint8Array(new Uint32Array([index]).buffer), 4);
		return {digest: hashDomain("ts-drp/settlement-source-context/v1", exactCanonicalContextBytes), exactCanonicalContextBytes};
	});
	it.each([64, 128])("bounds %i potential sources replaced and resolved as replaced sources beside a maximum completion", count => {
		const bytes = new Uint8Array(geometry.maxContextByteLength), digest = hashDomain("ts-drp/settlement-source-context/v1", bytes);
		const proof = new Uint8Array(geometry.maxCompletionByteLength + count * geometry.maxCompletionMemberByteLength), completion = hashDomain("ts-drp/settlement-source-context/v1", proof);
		const resolutions = receipts(count - 1), base = Number.MAX_SAFE_INTEGER - count;
		const raw = {scope, revision: Number.MAX_SAFE_INTEGER, fenceSequence: null,
			entries: [{sourceSequence: base, sourceDigest: new Uint8Array(32), sourceContextDigest: digest,
				sourceResolutionDigest: completion, disposition: "committed" as const, replacementSequence: null},
			...resolutions.map((receipt, index) => ({sourceSequence: base + 1 + index, sourceDigest: new Uint8Array(32),
				sourceContextDigest: digest, sourceResolutionDigest: receipt.digest, sourceResolutionKind: "frontier" as const,
				sourceResolutionScope: "replaced-source" as const, disposition: "transform" as const,
				replacementSequence: Number.MAX_SAFE_INTEGER - index}))],
			sourceContexts: [{digest, exactCanonicalContextBytes: bytes}, {digest: completion, exactCanonicalContextBytes: proof}, ...resolutions]
				.sort((a, b) => Buffer.compare(a.digest, b.digest))};
		const canonical = encodeCanonical(raw), resource = issuanceSourceCustodyPlanResourceForSizing(scope, null, count, geometry);
		expect(canonical.byteLength, "the replaced-source form of every potential row is charged").toBeLessThanOrEqual(resource.byteLength);
		const native = JSON.stringify({kind: "canonical-settlement-plan-1", bytes: Buffer.from(canonical).toString("base64")});
		expect(Buffer.byteLength(native)).toBeLessThanOrEqual(resource.nativeStorageByteLength);
		expect(copySettlementPlan(raw as never, scope)?.entries.filter(entry => Reflect.get(entry, "sourceResolutionScope") === "replaced-source"))
			.toHaveLength(count - 1);
	});
	it.each([1, 64])("charges the resolution and receipt an existing completed replacement entry may still gain (%i entries)", count => {
		const base = 1_000;
		const completed = Array.from({length: count}, (_, index) => ({sourceSequence: base + index, sourceDigest: new Uint8Array(32).fill(index),
			disposition: "transform" as const, replacementSequence: Number.MAX_SAFE_INTEGER - index}));
		const prior = copySettlementPlan({scope, revision: 7, fenceSequence: null, entries: completed}, scope)!;
		expect(prior).toBeDefined();
		const resolutions = receipts(count);
		// The reserve always holds one current-epoch context and one completion beside them: the receipts
		// are charged on top of both, not inside their slack.
		const bytes = new Uint8Array(geometry.maxContextByteLength).fill(1), proof = new Uint8Array(geometry.maxCompletionByteLength +
			count * geometry.maxCompletionMemberByteLength).fill(2);
		const reserved = [bytes, proof].map(exactCanonicalContextBytes => ({digest: hashDomain("ts-drp/settlement-source-context/v1",
			exactCanonicalContextBytes), exactCanonicalContextBytes}));
		const raw = {...prior, revision: 8, entries: completed.map((entry, index) => ({...entry,
			sourceResolutionDigest: resolutions[index]!.digest, sourceResolutionKind: "frontier" as const,
			sourceResolutionScope: "replaced-source" as const})),
		sourceContexts: [...reserved, ...resolutions].sort((a, b) => Buffer.compare(a.digest, b.digest))};
		const canonical = encodeCanonical(raw), resource = issuanceSourceCustodyPlanResourceForSizing(scope, prior, 0, geometry);
		expect(canonical.byteLength, "the existing entries' replaced-source form and receipts are charged").toBeLessThanOrEqual(resource.byteLength);
		const native = JSON.stringify({kind: "canonical-settlement-plan-1", bytes: Buffer.from(canonical).toString("base64")});
		expect(Buffer.byteLength(native)).toBeLessThanOrEqual(resource.nativeStorageByteLength);
	});
});
