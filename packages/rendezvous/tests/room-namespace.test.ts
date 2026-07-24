import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { peerNamespace, RecordSigner, RecordValidator, ROOM_NAMESPACE_PREFIX, roomNamespace } from "@ts-drp/rendezvous";
import { describe, expect, it } from "vitest";

const OBJECT_ID = "12D3KooWCreatorPeer:room-salt-alpha";

describe("room namespace v1", () => {
	it("derives a deterministic namespace that distinguishes object ids and salts", () => {
		const first = roomNamespace(OBJECT_ID);

		expect(roomNamespace(OBJECT_ID)).toBe(first);
		expect(roomNamespace("12D3KooWCreatorPeer:room-salt-beta")).not.toBe(first);
		expect(roomNamespace("12D3KooWOtherCreator:room-salt-alpha")).not.toBe(first);
	});

	it("uses the versioned room namespace prefix", () => {
		expect(ROOM_NAMESPACE_PREFIX).toBe("drp-room:v1:");
		expect(roomNamespace(OBJECT_ID)).toMatch(/^drp-room:v1:/u);
	});

	it("uses an unpadded 43-character base64url digest accepted as a network id", () => {
		const namespace = roomNamespace(OBJECT_ID);
		const suffix = namespace.slice(ROOM_NAMESPACE_PREFIX.length);

		expect(suffix).toMatch(/^[A-Za-z0-9_-]{43}$/u);
		expect(suffix).not.toContain("=");
		expect(() => peerNamespace(suffix)).not.toThrow();
	});

	it("does not expose the raw object id in relay-visible namespace text", () => {
		expect(roomNamespace(OBJECT_ID)).not.toContain(OBJECT_ID);
	});

	it("rejects an empty object id", () => {
		expect(() => roomNamespace("")).toThrow();
	});

	it("validates a genuinely signed room record under its expected namespace", async () => {
		const now = 1_750_000_000_000;
		const namespace = roomNamespace(OBJECT_ID);
		const privateKey = await generateKeyPairFromSeed(
			"Ed25519",
			Uint8Array.from({ length: 32 }, (_, index) => (index * 17 + 3) % 256)
		);
		const peerId = peerIdFromPublicKey(privateKey.publicKey).toString();
		const record = await new RecordSigner(privateKey).sign({
			addresses: [`/ip4/93.184.216.34/tcp/4100/p2p/${peerId}`],
			capabilities: ["drp-gossipsub"],
			expiresAtMs: now + 60_000,
			issuedAtMs: now,
			namespace,
			sequence: now,
		});
		const validator = new RecordValidator({
			now: (): number => now,
			resolver: { resolve: (): Promise<string[]> => Promise.resolve(["93.184.216.34"]) },
		});

		await expect(
			validator.validate(record, {
				admission: { accepted: true, mode: "open" },
				expectedNamespace: namespace,
				signal: new AbortController().signal,
			})
		).resolves.toMatchObject({
			accepted: true,
			record: { namespace, sequence: now },
		});
	});
});
