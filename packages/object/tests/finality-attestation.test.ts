import { bls } from "@chainsafe/bls/herumi";
import { Keychain } from "@ts-drp/keychain";
import { AggregatedAttestation, SyncAccept } from "@ts-drp/types";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";
import { beforeEach, describe, expect, test } from "vitest";

import { FinalityState } from "../src/finality/index.js";

describe("finality attestation interoperability", () => {
	const hash = "vertex-shared-by-node-a-and-node-b";
	const peerIds = ["node-a", "node-b", "node-c"];
	let keychains: Keychain[];
	let signerKeys: Map<string, string>;

	beforeEach(async () => {
		keychains = peerIds.map(() => new Keychain());
		await Promise.all(keychains.map((keychain) => keychain.start()));
		signerKeys = new Map(peerIds.map((peerId, index) => [peerId, keychains[index].blsPublicKey]));
	});

	test("a valid node B attestation survives SyncAccept protobuf transport and merges on node A", () => {
		const nodeB = new FinalityState(hash, new Map([...signerKeys].reverse()));
		nodeB.addSignature("node-b", keychains[1].signWithBls(hash));
		const attestation = AggregatedAttestation.create({
			data: hash,
			signature: nodeB.signature,
			aggregationBits: nodeB.aggregation_bits.toBytes(),
		});

		const encoded = SyncAccept.encode(
			SyncAccept.create({ requested: [], requesting: [], attestations: [attestation] })
		).finish();
		const framedMessage = Buffer.alloc(encoded.length + 8);
		framedMessage.set(encoded, 8);
		const transported = SyncAccept.decode(framedMessage.subarray(8)).attestations[0];

		expect([...transported.aggregationBits]).toEqual([...attestation.aggregationBits]);
		expect(transported.aggregationBits.byteOffset).toBeGreaterThan(0);

		const nodeA = new FinalityState(hash, signerKeys);
		expect(() => nodeA.merge(transported)).not.toThrow();
		expect(nodeA.numberOfSignatures).toBe(1);
		const nodeBIndex = nodeA.signerIndices.get("node-b");
		if (nodeBIndex === undefined) throw new Error("node-b is missing from node A's signer set");
		expect(nodeA.aggregation_bits.get(nodeBIndex)).toBe(true);
	});

	test("merging disjoint local and remote attestations verifies against the union signer set", () => {
		const nodeA = new FinalityState(hash, signerKeys);
		nodeA.addSignature("node-a", keychains[0].signWithBls(hash));

		const nodeB = new FinalityState(hash, new Map([...signerKeys].reverse()));
		nodeB.addSignature("node-b", keychains[1].signWithBls(hash));
		nodeB.addSignature("node-c", keychains[2].signWithBls(hash));
		nodeA.merge(
			AggregatedAttestation.create({
				data: hash,
				signature: nodeB.signature,
				aggregationBits: nodeB.aggregation_bits.toBytes(),
			})
		);

		const unionPublicKeys = nodeA.signerCredentials.map((credential) => uint8ArrayFromString(credential, "base64"));
		if (!nodeA.signature) throw new Error("node A lost its local signature");
		expect({
			numberOfSignatures: nodeA.numberOfSignatures,
			verifiesUnion: bls.verifyAggregate(unionPublicKeys, uint8ArrayFromString(hash), nodeA.signature),
		}).toEqual({ numberOfSignatures: 3, verifiesUnion: true });
	});
});
