import { describe, expect, it } from "vitest";

import { compareBytes, encodeCanonical, signerSetBytes, vertexPreimage } from "../src/index.js";

const ZERO_DIGEST = "0".repeat(64);

describe("pinned-reference differential", () => {
	it("has no divergence outside the two approved D1/D2 amendments", async () => {
		const canonicalPath: string = "../conformance/ahe-reference/src/canonical.js";
		const protocolPath: string = "../conformance/ahe-reference/src/protocol.js";
		const referenceCanonical = (await import(canonicalPath)) as {
			encodeCanonical(value: unknown): Uint8Array;
		};
		const referenceProtocol = (await import(protocolPath)) as {
			normalizeSignerSet(signers: readonly Readonly<Record<string, unknown>>[]): readonly unknown[];
			vertexPreimage(vertex: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
		};

		const sharedValues = [null, false, true, 0, -1, 1.5, "peer-😀", Uint8Array.of(0, 255), { b: 2, a: 1 }];
		for (const value of sharedValues) {
			expect(encodeCanonical(value), String(value)).toEqual(referenceCanonical.encodeCanonical(value));
		}

		const vertex = {
			objectId: "room-a",
			protocolMajor: 2,
			epoch: 4,
			anchor: ZERO_DIGEST,
			author: "peer-a",
			logicalTime: 1,
			dependencies: [ZERO_DIGEST],
			operation: { op: "set" },
		};
		expect(encodeCanonical(vertexPreimage(vertex))).toEqual(
			referenceCanonical.encodeCanonical(referenceProtocol.vertexPreimage(vertex))
		);

		const divergences: string[] = [];
		if (
			compareBytes(encodeCanonical(Float32Array.of(-0)), referenceCanonical.encodeCanonical(Float32Array.of(-0))) !== 0
		) {
			divergences.push("D2 Float32Array -0 normalization");
		}

		const signers = ["peer-B", "peer-a", "Peer-a", "peer_a", "peerä"].map((signerId) => ({
			signerId,
			publicKey: `pk-${signerId}`,
		}));
		if (
			compareBytes(
				signerSetBytes(signers),
				referenceCanonical.encodeCanonical(referenceProtocol.normalizeSignerSet(signers))
			) !== 0
		) {
			divergences.push("D1 codepoint sort");
		}

		expect(divergences.sort()).toEqual(["D1 codepoint sort", "D2 Float32Array -0 normalization"]);
	});
});
