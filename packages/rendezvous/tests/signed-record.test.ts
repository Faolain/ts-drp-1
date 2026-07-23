import { generateKeyPairFromSeed, publicKeyToProtobuf } from "@libp2p/crypto/keys";
import { canonicalPayloadBytes, type DrpCapability } from "@ts-drp/rendezvous";
import { base64url } from "multiformats/bases/base64";
import { describe, expect, it } from "vitest";

import { address, context, fixtureInput, fixtureSigner, seed, validator } from "./fixtures.js";

describe("SignedDrpRecordV1", () => {
	it("creates deterministic canonical signed records bound to their Peer ID", async () => {
		const { peerId, signer } = await fixtureSigner(1);
		const first = await signer.sign(
			fixtureInput(peerId, {
				addresses: [address(peerId, 4002), address(peerId, 4001)],
				capabilities: ["webrtc", "drp-gossipsub"],
			})
		);
		const second = await signer.sign(
			fixtureInput(peerId, {
				addresses: [address(peerId, 4001), address(peerId, 4002)],
				capabilities: ["drp-gossipsub", "webrtc"],
			})
		);

		expect(first).toEqual(second);
		expect(first.addresses).toEqual([address(peerId, 4001), address(peerId, 4002)]);
		expect(new TextDecoder().decode(canonicalPayloadBytes(first))).toContain(`"peerId":"${peerId}"`);
		expect(await validator().validate(first, context())).toMatchObject({ accepted: true });

		const otherKey = await generateKeyPairFromSeed("Ed25519", seed(2));
		const mismatched = {
			...first,
			publicKey: base64url.baseEncode(publicKeyToProtobuf(otherKey.publicKey)),
		};
		expect(await validator().validate(mismatched, context())).toMatchObject({
			accepted: false,
			code: "peer-id-mismatch",
		});
	});

	it("freezes the drp-network:v1 namespace and relay capability vocabulary", async () => {
		const { peerId, signer } = await fixtureSigner(3);
		for (const capabilities of [
			["drp-gossipsub", "relay-client"],
			["drp-gossipsub", "relay-hop-v2-service"],
			["drp-gossipsub", "relay-client", "relay-hop-v2-service"],
		] as const) {
			const record = await signer.sign(
				fixtureInput(peerId, { capabilities: capabilities as readonly DrpCapability[] })
			);
			expect(await validator().validate(record, context())).toMatchObject({ accepted: true });
		}

		const removedCapability = await signer.sign(
			fixtureInput(peerId, {
				capabilities: ["circuit-relay" as DrpCapability, "drp-gossipsub"],
			})
		);
		expect(await validator().validate(removedCapability, context())).toMatchObject({
			accepted: false,
			code: "unsupported-capability",
		});

		for (const invalidNamespace of [
			`drp-rendezvous:v1:${"a".repeat(43)}`,
			`drp-relays:v1:${"a".repeat(43)}`,
			`evil drp-network:v1:${"a".repeat(43)}`,
		]) {
			const record = await signer.sign(fixtureInput(peerId, { namespace: invalidNamespace }));
			expect(await validator().validate(record, context({ expectedNamespace: invalidNamespace }))).toMatchObject({
				accepted: false,
				code: "invalid-namespace",
			});
		}
	});
});
