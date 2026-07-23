import {
	namespaceCid,
	PEER_NAMESPACE_PREFIX,
	peerNamespace,
	RELAY_NAMESPACE_PREFIX,
	relayNamespace,
	relayNamespaceCid,
} from "@ts-drp/rendezvous";
import { describe, expect, it } from "vitest";

const NETWORK_ID = "abcdefghijklmnopqrstuv";
const PEER_NAMESPACE = `drp-network:v1:${NETWORK_ID}`;
const PEER_NAMESPACE_CID = "bafkreihxfun5hsyao7xexqlp7i2vilair3tejypdngwrcd6zp3ojjwcq4i";
const RELAY_NAMESPACE_CID = "bafkreihsg6uuljfhwpwztgxqy47gugpgluh5xsyvafirz5cwlprxwegyha";

describe("network namespace v1", () => {
	it("freezes the peer and relay namespace prefixes", () => {
		expect(PEER_NAMESPACE_PREFIX).toBe("drp-network:v1:");
		expect(RELAY_NAMESPACE_PREFIX).toBe("drp-relays:v1:");
	});

	it.each([
		["minimum", "a".repeat(22)],
		["maximum", "Z_".repeat(43)],
	])("builds peer and relay namespaces at the %s network ID length", (_boundary, networkId) => {
		expect(peerNamespace(networkId)).toBe(`drp-network:v1:${networkId}`);
		expect(relayNamespace(networkId)).toBe(`drp-relays:v1:${networkId}`);
	});

	it.each([
		["is empty", ""],
		["is too short", "a".repeat(21)],
		["is too long", "a".repeat(87)],
		["contains invalid characters", `${"a".repeat(21)}+`],
	])("rejects a network ID that %s", (_case, networkId) => {
		expect(() => peerNamespace(networkId)).toThrow();
		expect(() => relayNamespace(networkId)).toThrow();
	});

	it("rejects an invalid relay network ID through the promise boundary", async () => {
		await expect(relayNamespaceCid("too-short")).rejects.toThrow("networkId must contain 22..86 base64url characters");
	});

	it("pins the peer namespace CID golden vector and multiformats envelope", async () => {
		const cid = await namespaceCid(PEER_NAMESPACE);

		expect(cid.toString()).toBe(PEER_NAMESPACE_CID);
		expect(cid.version).toBe(1);
		expect(cid.code).toBe(0x55);
		expect(cid.multihash.code).toBe(0x12);
	});

	it("pins the relay namespace CID golden vector and multiformats envelope", async () => {
		const cid = await relayNamespaceCid(NETWORK_ID);

		expect(cid.toString()).toBe(RELAY_NAMESPACE_CID);
		expect(cid.version).toBe(1);
		expect(cid.code).toBe(0x55);
		expect(cid.multihash.code).toBe(0x12);
	});
});
