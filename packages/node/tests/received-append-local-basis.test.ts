import {encodeCanonical, hashDomain} from "@ts-drp/canonical";
import {issuanceUnsignedContinuationWidths, issuanceUnsignedSuccessorFenceWidths,
	issuanceRetirementImage, type IssuanceRetirementRows} from "@ts-drp/issuance-store/maintenance";
import {describe, expect, it} from "vitest";

// Structural sizing tests, not signature authentication or native acceptance.
const scope = {objectId: "room", author: "f".repeat(64)};
const preimage = encodeCanonical({kind: "drp-vertex", protocolMajor: 3, ...scope, epoch: 0,
	anchor: "a".repeat(64), authorSequence: 0, logicalTime: 0,
	dependencies: ["a".repeat(64)], operation: {action: "bootstrap"}});
const digest = hashDomain("ts-drp/vertex/v3", preimage);
const rows: IssuanceRetirementRows = {lineages: [{...scope, next: 1, exhausted: false,
	prunedThroughAuthorSequence: null}], issued: [{...scope, authorSequence: 0,
	canonicalPreimageBytes: preimage, digest, signature: new Uint8Array(64)}],
	outbox: [{...scope, authorSequence: 0, digest, publishState: "pending"}], plans: []};
const plan = {scope, revision: 0, fenceSequence: null, entries: []};

describe("received candidate keeps its actual local future-job basis", () => {
	it("has no immediate issuer, ACK, lineage, plan or control change when no local job is prepared", () => {
		const before = encodeCanonical(rows), sized = issuanceUnsignedContinuationWidths(rows, scope, undefined, null, []);
		expect(encodeCanonical(sized.finalRows)).toEqual(before);
		expect(sized.phases).toEqual([]);
		expect(sized.final.controlRevisionDelta).toBe(0);
		expect(sized.final.canonicalRowsBytes).toBe(before.byteLength);
		expect(sized.final.nativeImageBytes).toBe(encodeCanonical(issuanceRetirementImage(rows, scope.objectId)).byteLength);
		expect(encodeCanonical(rows)).toEqual(before);
	});
	it("quotes a real subsequent C0 fence from next=1 without a fake received-native row", () => {
		const before = encodeCanonical(rows);
		const sized = issuanceUnsignedSuccessorFenceWidths(rows, scope, undefined, null,
			{plan, canonicalPreimageByteLength: 512});
		expect(sized.reserved.controlRevisionDelta).toBe(3); // actual pending ACK, plan write, fence reserve
		expect(sized.entered.controlRevisionDelta).toBe(4);
		expect(sized.final.controlRevisionDelta).toBe(5);
		expect(sized.final.canonicalRowsBytes).toBeGreaterThan(before.byteLength);
		expect(encodeCanonical(rows)).toEqual(before);
	});
	it("refuses an absent, exhausted, foreign or pending local basis before projection", () => {
		for (const bad of [{...rows, lineages: []}, {...rows, lineages: [{...rows.lineages[0]!, exhausted: true}]},
			{...rows, lineages: [{...rows.lineages[0]!, author: "e".repeat(64)}]}])
			expect(() => issuanceUnsignedContinuationWidths(bad, scope, undefined, null, [])).toThrow();
		expect(() => issuanceUnsignedSuccessorFenceWidths(rows, scope, undefined, null,
			{plan: {...plan, scope: {...scope, author: "e".repeat(64)}}, canonicalPreimageByteLength: 512})).toThrow();
	});
});
