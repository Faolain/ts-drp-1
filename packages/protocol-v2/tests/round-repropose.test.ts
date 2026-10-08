import { describe, expect, it } from "vitest";

import registryJson from "../registry/field-registry.json" with { type: "json" };
import { digestRegistryPreimage, makeRegistryPreimageBuilder, type RegistryDocument } from "../src/index.js";

const ZERO_DIGEST = "0".repeat(64);
const ONE_DIGEST = "1".repeat(64);

function cutValue(): Readonly<Record<string, unknown>> {
	return {
		objectId: "room-a",
		epoch: 4,
		previousAnchor: ZERO_DIGEST,
		previousCutDigest: ZERO_DIGEST,
		previousHistoryRoot: ZERO_DIGEST,
		previousHistorySize: 0,
		closeSetRoot: ONE_DIGEST,
		closeSetCount: 1,
		historyRoot: ONE_DIGEST,
		historySize: 1,
		stateDigest: ZERO_DIGEST,
		aclDigest: ZERO_DIGEST,
		snapshotManifestDigest: ZERO_DIGEST,
		blueprintDigest: ZERO_DIGEST,
		archiveIndexRoot: ZERO_DIGEST,
		availabilityPolicyDigest: ZERO_DIGEST,
		nextSignerSet: [],
		parameters: {},
		closeReason: "size",
	};
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("B3 Phase -1c round reproposal", () => {
	it("keeps the CutValue digest stable while SealProposal hashes change by round", () => {
		const registry = registryJson as RegistryDocument & { domains: Readonly<Record<string, string>> };
		const buildCut = makeRegistryPreimageBuilder(registry, "cutValue");
		const buildProposal = makeRegistryPreimageBuilder(registry, "sealProposal");
		const cutInput = cutValue();
		const cut = buildCut(cutInput);
		const valueDigest = hex(digestRegistryPreimage(registry, "cutValue", cutInput));

		const proposalRound7 = buildProposal({ objectId: "room-a", epoch: 4, round: 7, valueDigest });
		const proposalRound8 = buildProposal({ objectId: "room-a", epoch: 4, round: 8, valueDigest });
		const proposalHash7 = digestRegistryPreimage(registry, "sealProposal", {
			objectId: "room-a",
			epoch: 4,
			round: 7,
			valueDigest,
		});
		const proposalHash8 = digestRegistryPreimage(registry, "sealProposal", {
			objectId: "room-a",
			epoch: 4,
			round: 8,
			valueDigest,
		});

		expect(Object.keys(cut)).not.toContain("round");
		expect(proposalRound7.valueDigest).toBe(valueDigest);
		expect(proposalRound8.valueDigest).toBe(valueDigest);
		expect(proposalHash7).not.toEqual(proposalHash8);
	});
});
