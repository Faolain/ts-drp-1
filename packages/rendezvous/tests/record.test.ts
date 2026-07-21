import { generateKeyPairFromSeed, publicKeyToProtobuf } from "@libp2p/crypto/keys";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import {
	canonicalPayloadBytes,
	type DrpCapability,
	RecordSigner,
	type RecordValidationContext,
	RecordValidator,
	type SignedDrpRecordV1,
	type UnsignedDrpRecordV1,
} from "@ts-drp/rendezvous";
import { base64url } from "multiformats/bases/base64";
import { describe, expect, it } from "vitest";

const NOW = 1_750_000_000_000;
const namespace = `drp-network:v1:${"a".repeat(43)}`;
const admission = { accepted: true, mode: "invite" } as const;

describe("signed rendezvous records", () => {
	it("signs deterministic canonical bytes and binds the public key to the Peer ID", async () => {
		const { signer, peerId } = await fixtureSigner(1);
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
		expect(JSON.stringify(first)).not.toContain("private");
		await expectAccepted(first);

		const otherKey = await generateKeyPairFromSeed("Ed25519", seed(2));
		const mismatched = copy(first, {
			publicKey: base64url.baseEncode(publicKeyToProtobuf(otherKey.publicKey)),
		});
		await expectRejected(mismatched, "peer-id-mismatch");
	});

	it("rejects altered payloads and forged signatures", async () => {
		const record = await signedFixture(3);
		await expectRejected(copy(record, { expiresAtMs: record.expiresAtMs + 1 }), "invalid-signature");
		await expectRejected(copy(record, { signature: mutateBase64(record.signature) }), "invalid-signature");
		await expectRejected(copy(record, { peerId: "not-a-peer-id" }), "invalid-peer-id");
	});

	it("enforces namespace, canonical ordering, capabilities, and shape", async () => {
		const record = await signedFixture(4);
		await expectRejected(record, "namespace-mismatch", {
			expectedNamespace: `drp-network:v1:${"b".repeat(43)}`,
		});
		await expectRejected(copy(record, { namespace: "public-room-name" }), "invalid-namespace");
		await expectRejected(copy(record, { version: 2 as 1 }), "unsupported-version");
		await expectRejected(copy(record, { addresses: [...record.addresses, ...record.addresses] }), "non-canonical");
		await expectRejected(
			copy(record, { capabilities: ["drp-gossipsub", "not-supported" as DrpCapability] }),
			"unsupported-capability"
		);
		await expectRejected(copy(record, { capabilities: ["webrtc"] }), "unsupported-capability");
		await expectRejected({ ...record, unexpected: true }, "invalid-shape");
	});

	it("accepts the frozen drp-network namespace and rejects the legacy drp-rendezvous namespace", async () => {
		const { signer, peerId } = await fixtureSigner(41);
		await expectAccepted(await signer.sign(fixtureInput(peerId)));

		const legacyNamespace = `drp-rendezvous:v1:${base64url.baseEncode(seed(41))}`;
		const legacyRecord = await signer.sign(fixtureInput(peerId, { namespace: legacyNamespace }));
		await expectRejected(legacyRecord, "invalid-namespace", { expectedNamespace: legacyNamespace });
	});

	it.each([
		["relay keyspace", `drp-relays:v1:${"a".repeat(43)}`],
		["leading junk", `evil drp-network:v1:${"a".repeat(43)}`],
		["trailing junk", `drp-network:v1:${"a".repeat(43)} evil`],
	])("rejects a namespace from the %s", async (_case, invalidNamespace) => {
		const { signer, peerId } = await fixtureSigner(44);
		const record = await signer.sign(fixtureInput(peerId, { namespace: invalidNamespace }));

		await expectRejected(record, "invalid-namespace", { expectedNamespace: invalidNamespace });
	});

	it("accepts exactly the frozen relay capability names", async () => {
		const { signer, peerId } = await fixtureSigner(42);
		for (const capabilities of [
			["drp-gossipsub", "relay-client"],
			["drp-gossipsub", "relay-hop-v2-service"],
			["drp-gossipsub", "relay-client", "relay-hop-v2-service"],
		] as const) {
			await expectAccepted(
				await signer.sign(fixtureInput(peerId, { capabilities: capabilities as readonly DrpCapability[] }))
			);
		}
	});

	it("rejects the removed circuit-relay capability", async () => {
		const { signer, peerId } = await fixtureSigner(43);
		const record = await signer.sign(
			fixtureInput(peerId, { capabilities: ["circuit-relay" as DrpCapability, "drp-gossipsub"] })
		);

		await expectRejected(record, "unsupported-capability");
	});

	it("enforces monotonic sequences without burning a rejected sequence", async () => {
		const { signer, peerId } = await fixtureSigner(5);
		const validator = fixtureValidator();
		const first = await signer.sign(fixtureInput(peerId));
		const second = await signer.sign(fixtureInput(peerId, { sequence: 2 }));

		expect(await validator.validate(first, context())).toMatchObject({ accepted: true });
		expect(await validator.validate(first, context())).toMatchObject({
			accepted: false,
			code: "replayed-sequence",
		});
		expect(await validator.validate(second, context({ admission: { accepted: false, mode: "invite" } }))).toMatchObject(
			{
				accepted: false,
				code: "admission-rejected",
			}
		);
		expect(await validator.validate(second, context())).toMatchObject({ accepted: true });
	});

	it("hard-rejects new identities when the bounded replay ledger is full", async () => {
		const validator = fixtureValidator(undefined, { maxReplayEntries: 2 });
		for (const index of [51, 52]) {
			const record = await signedFixture(index);
			expect(await validator.validate(record, context())).toMatchObject({ accepted: true });
		}
		expect(await validator.validate(await signedFixture(53), context())).toMatchObject({
			accepted: false,
			code: "replay-capacity-exceeded",
			detail: "2/2",
		});
	});

	it("reclaims replay entries only after their signed record has expired", async () => {
		let now = NOW;
		const validator = new RecordValidator({
			limits: { maxReplayEntries: 1 },
			now: (): number => now,
			resolver: { resolve: (): Promise<string[]> => Promise.resolve(["93.184.216.34"]) },
		});
		const first = await signedFixture(54);
		const second = await signedFixture(55, { issuedAtMs: NOW + 60_000, expiresAtMs: NOW + 120_000 });
		expect(await validator.validate(first, context())).toMatchObject({ accepted: true });
		expect(await validator.validate(await signedFixture(56), context())).toMatchObject({
			accepted: false,
			code: "replay-capacity-exceeded",
		});
		now = first.expiresAtMs;
		expect(await validator.validate(second, context({ expectedNamespace: second.namespace }))).toMatchObject({
			accepted: true,
		});
	});

	it("rejects expired, future, invalid, and out-of-range lifetimes", async () => {
		const { signer, peerId } = await fixtureSigner(6);
		await expectRejected(
			await signer.sign(fixtureInput(peerId, { issuedAtMs: NOW - 70_000, expiresAtMs: NOW - 10_000 })),
			"expired"
		);
		await expectRejected(
			await signer.sign(fixtureInput(peerId, { issuedAtMs: NOW + 30_001, expiresAtMs: NOW + 90_001 })),
			"issued-in-future"
		);
		await expectAccepted(
			await signer.sign(fixtureInput(peerId, { issuedAtMs: NOW + 30_000, expiresAtMs: NOW + 90_000 }))
		);
		await expectRejected(
			await signer.sign(fixtureInput(peerId, { issuedAtMs: NOW, expiresAtMs: NOW + 9_999 })),
			"ttl-out-of-range"
		);
		await expectRejected(
			await signer.sign(fixtureInput(peerId, { issuedAtMs: NOW, expiresAtMs: NOW + 300_001 })),
			"ttl-out-of-range"
		);
		await expectRejected(await signer.sign(fixtureInput(peerId, { expiresAtMs: NOW })), "invalid-time");
	});

	it("rejects oversized records, address floods, capability floods, and response floods", async () => {
		const { signer, peerId } = await fixtureSigner(7);
		const record = await signer.sign(fixtureInput(peerId));
		await expectRejected(copy(record, { signature: "A".repeat(9_000) }), "oversized");
		await expectRejected(
			await signer.sign(
				fixtureInput(peerId, {
					addresses: Array.from({ length: 9 }, (_, index) => address(peerId, 4100 + index)),
				})
			),
			"too-many-addresses"
		);
		const fullCapabilityRecord = await signer.sign(
			fixtureInput(peerId, {
				capabilities: ["drp-gossipsub", "webrtc", "relay-client", "relay-hop-v2-service"],
			})
		);
		await expectAccepted(fullCapabilityRecord);
		expect(await fixtureValidator(undefined, { maxCapabilities: 3 }).validate(fullCapabilityRecord, context())).toEqual(
			{ accepted: false, code: "too-many-capabilities", detail: "4/3" }
		);

		const results = await fixtureValidator().validateResponse(
			Array.from({ length: 65 }, () => record),
			context()
		);
		expect(results).toEqual([{ accepted: false, code: "response-cap-exceeded", detail: "65/64" }]);
	});

	it("rejects private/local addresses and requires the terminal Peer ID to match", async () => {
		const { signer, peerId } = await fixtureSigner(8);
		await expectRejected(
			await signer.sign(fixtureInput(peerId, { addresses: [`/ip4/127.0.0.1/tcp/4001/p2p/${peerId}`] })),
			"unsafe-address"
		);
		await expectRejected(
			await signer.sign(fixtureInput(peerId, { addresses: [`/ip4/10.0.0.1/tcp/4001/p2p/${peerId}`] })),
			"unsafe-address"
		);
		const other = peerIdFromPublicKey((await generateKeyPairFromSeed("Ed25519", seed(81))).publicKey).toString();
		await expectRejected(
			await signer.sign(fixtureInput(peerId, { addresses: [address(other, 4001)] })),
			"invalid-address"
		);
	});

	it("re-resolves DNS immediately before dial and rejects a rebinding result", async () => {
		const { signer, peerId } = await fixtureSigner(9);
		let resolutions = 0;
		const validator = fixtureValidator({
			resolve(): Promise<string[]> {
				resolutions += 1;
				return Promise.resolve(resolutions <= 2 ? ["93.184.216.34"] : ["127.0.0.1"]);
			},
		});
		const first = await signer.sign(fixtureInput(peerId));

		expect(await validator.validate(first, context())).toMatchObject({ accepted: true });
		expect(await validator.recheckAddressesAtDial(first, new AbortController().signal)).toMatchObject({
			accepted: false,
			code: "unsafe-address",
		});
		expect(resolutions).toBe(4);
	});

	it("rejects a record that expires between validation and the literal dial-time recheck", async () => {
		const { signer, peerId } = await fixtureSigner(91);
		let now = NOW;
		const validator = new RecordValidator({
			now: (): number => now,
			resolver: { resolve: (): Promise<string[]> => Promise.resolve(["93.184.216.34"]) },
		});
		const record = await signer.sign(fixtureInput(peerId, { expiresAtMs: NOW + 10_000 }));

		expect(await validator.validate(record, context())).toMatchObject({ accepted: true });
		now = record.expiresAtMs;
		expect(await validator.recheckAddressesAtDial(record, new AbortController().signal)).toEqual({
			accepted: false,
			code: "expired",
			detail: "record expired before dial",
		});
	});

	it("requires an explicit admission decision and preserves the selected mode without publishing credentials", async () => {
		const record = await signedFixture(10);
		await expectRejected(record, "admission-required", { admission: undefined });
		await expectRejected(record, "admission-rejected", {
			admission: { accepted: false, mode: "invite", reason: "invite-invalid" },
		});
		const result = await fixtureValidator().validate(record, context());
		expect(result).toMatchObject({ accepted: true, admissionMode: "invite" });
		expect(record).not.toHaveProperty("admission");
	});

	it("honors caller abort before validation work", async () => {
		const controller = new AbortController();
		controller.abort(new Error("stop"));
		await expect(
			fixtureValidator().validate(await signedFixture(11), context({ signal: controller.signal }))
		).rejects.toThrow("stop");
	});
});

async function fixtureSigner(index: number): Promise<{ peerId: string; signer: RecordSigner }> {
	const key = await generateKeyPairFromSeed("Ed25519", seed(index));
	return {
		peerId: peerIdFromPublicKey(key.publicKey).toString(),
		signer: new RecordSigner(key),
	};
}

async function signedFixture(index: number, overrides: Partial<UnsignedDrpRecordV1> = {}): Promise<SignedDrpRecordV1> {
	const { signer, peerId } = await fixtureSigner(index);
	return signer.sign(fixtureInput(peerId, overrides));
}

function fixtureInput(peerId: string, overrides: Partial<UnsignedDrpRecordV1> = {}): UnsignedDrpRecordV1 {
	return {
		namespace,
		addresses: [address(peerId, 4001)],
		capabilities: ["drp-gossipsub", "webrtc"],
		sequence: 1,
		issuedAtMs: NOW,
		expiresAtMs: NOW + 60_000,
		...overrides,
	};
}

function address(peerId: string, port: number): string {
	return `/dns4/relay.example.test/tcp/${port}/wss/p2p/${peerId}`;
}

function fixtureValidator(
	resolver = { resolve: (): Promise<string[]> => Promise.resolve(["93.184.216.34"]) },
	limits?: ConstructorParameters<typeof RecordValidator>[0]["limits"]
): RecordValidator {
	return new RecordValidator({ limits, now: fixtureNow, resolver });
}

function context(overrides: Partial<Parameters<RecordValidator["validate"]>[1]> = {}): RecordValidationContext {
	return {
		admission,
		expectedNamespace: namespace,
		signal: new AbortController().signal,
		...overrides,
	};
}

function fixtureNow(): number {
	return NOW;
}

async function expectAccepted(record: SignedDrpRecordV1): Promise<void> {
	expect(await fixtureValidator().validate(record, context())).toMatchObject({ accepted: true });
}

async function expectRejected(
	record: unknown,
	code: string,
	contextOverrides: Partial<Parameters<RecordValidator["validate"]>[1]> = {}
): Promise<void> {
	expect(await fixtureValidator().validate(record, context(contextOverrides))).toMatchObject({
		accepted: false,
		code,
	});
}

function copy(record: SignedDrpRecordV1, patch: Partial<SignedDrpRecordV1>): SignedDrpRecordV1 {
	return { ...record, ...patch };
}

function seed(index: number): Uint8Array {
	return Uint8Array.from({ length: 32 }, (_, offset) => (index * 17 + offset * 13) % 256);
}

function mutateBase64(value: string): string {
	const last = value.at(-1);
	return `${value.slice(0, -1)}${last === "A" ? "B" : "A"}`;
}
