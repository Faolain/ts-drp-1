import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import type { PrivateKey } from "@libp2p/interface";
import type { RecordValidator, SignedDrpRecordV1, ValidatedDrpRecord } from "@ts-drp/rendezvous";
import { base64url } from "multiformats/bases/base64";
import { describe, expect, it } from "vitest";

import { fixtureInput, fixtureSigner, NAMESPACE, NOW, seed, validator } from "./fixtures.js";

interface InvitePayloadV1 {
	readonly contacts: readonly SignedDrpRecordV1[];
	readonly expiresAtMs: number;
	readonly issuedAtMs: number;
	readonly membershipCapability: string;
	readonly namespace: string;
	readonly registryEndpoints: readonly string[];
}

interface VerifiedInvite {
	readonly contacts: readonly ValidatedDrpRecord[];
	readonly expiresAtMs: number;
	readonly issuedAtMs: number;
	readonly issuerPublicKey: string;
	readonly membershipCapability: string;
	readonly namespace: string;
	readonly registryEndpoints: readonly string[];
}

interface InviteDirectoryLike {
	discover(namespace: string, signal: AbortSignal): Promise<readonly ValidatedDrpRecord[]>;
}

interface InviteDecodeOptions {
	readonly allow_insecure_loopback_fixture?: boolean;
	clock?(): number;
	validatorFactory(): RecordValidator;
}

interface PhaseFourInviteModule {
	InviteDirectory: new (options: {
		clock?(): number;
		readonly invite: VerifiedInvite;
		validatorFactory(): RecordValidator;
	}) => InviteDirectoryLike;
	decodeInvite(encoded: string, options: InviteDecodeOptions): Promise<VerifiedInvite>;
	encodeInvite(payload: InvitePayloadV1, signer: Pick<PrivateKey, "publicKey" | "sign">): Promise<string>;
}

interface InviteWireV1 {
	issuerPublicKey: string;
	kind: "ts-drp-rendezvous-invite";
	payload: InvitePayloadV1;
	signature: string;
	version: 1;
}

describe("Phase 4b signed invite bootstrap", () => {
	it("round-trips a signed payload and exposes validated contacts separately from the membership token verifier", async () => {
		const phaseFour = await loadInviteModule();
		if (phaseFour === undefined) return;
		const issuer = await inviteIssuer(501);
		const contacts = [await publicContact(502), await publicContact(503)];
		const payload = invitePayload(contacts);

		const encoded = await phaseFour.encodeInvite(payload, issuer);
		const wire = decodeWire(encoded);
		expect(wire).toMatchObject({
			kind: "ts-drp-rendezvous-invite",
			payload,
			version: 1,
		});
		expect(wire.issuerPublicKey).toBeTypeOf("string");
		expect(wire.signature).toBeTypeOf("string");

		await expect(phaseFour.decodeInvite(encoded, decodeOptions())).resolves.toMatchObject({
			contacts: contacts.map((record) => ({ record: { peerId: record.peerId } })),
			membershipCapability: payload.membershipCapability,
			namespace: NAMESPACE,
			registryEndpoints: payload.registryEndpoints,
		});
	});

	it.each(["signature", "payload"] as const)(
		"rejects an invite with a tampered %s under the full-envelope issuer signature",
		async (tamper) => {
			const phaseFour = await loadInviteModule();
			if (phaseFour === undefined) return;
			const issuer = await inviteIssuer(504);
			const encoded = await phaseFour.encodeInvite(invitePayload([await publicContact(505)]), issuer);
			const wire = decodeWire(encoded);
			const tampered = encodeWire(
				tamper === "signature"
					? { ...wire, signature: mutate(wire.signature) }
					: {
							...wire,
							payload: { ...wire.payload, membershipCapability: `${wire.payload.membershipCapability}-tampered` },
						}
			);

			await expect(phaseFour.decodeInvite(tampered, decodeOptions())).rejects.toMatchObject({
				code: "invalid-issuer-signature",
				name: "InviteDecodeError",
			});
		}
	);

	it("signs the full unsigned envelope, including kind, version, issuer key, and payload", async () => {
		const phaseFour = await loadInviteModule();
		if (phaseFour === undefined) return;
		const issuer = await inviteIssuer(506);
		let signedBytes: Uint8Array | undefined;
		await phaseFour.encodeInvite(invitePayload([await publicContact(507)]), {
			publicKey: issuer.publicKey,
			sign: async (bytes) => {
				signedBytes = bytes.subarray();
				return issuer.sign(bytes);
			},
		});

		expect(JSON.parse(new TextDecoder().decode(signedBytes))).toMatchObject({
			issuerPublicKey: expect.any(String),
			kind: "ts-drp-rendezvous-invite",
			payload: expect.objectContaining({ namespace: NAMESPACE }),
			version: 1,
		});
	});

	it("enforces invite expiry with the decoding client's clock", async () => {
		const phaseFour = await loadInviteModule();
		if (phaseFour === undefined) return;
		const issuer = await inviteIssuer(509);
		const payload = invitePayload([await publicContact(510)]);
		const encoded = await phaseFour.encodeInvite(payload, issuer);

		await expect(
			phaseFour.decodeInvite(encoded, { ...decodeOptions(), clock: () => payload.expiresAtMs })
		).rejects.toMatchObject({ code: "expired", name: "InviteDecodeError" });
	});

	it.each(["invalid-signature", "namespace-mismatch"] as const)(
		"rejects the whole invite when one contact has %s",
		async (failure) => {
			const phaseFour = await loadInviteModule();
			if (phaseFour === undefined) return;
			const issuer = await inviteIssuer(511);
			const good = await publicContact(512);
			const bad =
				failure === "invalid-signature"
					? { ...good, signature: mutate(good.signature) }
					: await publicContact(513, { namespace: `drp-network:v1:${"z".repeat(43)}` });
			const encoded = await phaseFour.encodeInvite(invitePayload([good, bad]), issuer);

			await expect(phaseFour.decodeInvite(encoded, decodeOptions())).rejects.toMatchObject({
				code: "invalid-contact",
				name: "InviteDecodeError",
			});
		}
	);

	it.each(["http://registry.example/v1", "https://user:secret@registry.example/v1"])(
		"rejects a registry endpoint outside the HTTPS/no-credentials URL policy: %s",
		async (endpoint) => {
			const phaseFour = await loadInviteModule();
			if (phaseFour === undefined) return;
			const issuer = await inviteIssuer(514);
			const encoded = await phaseFour.encodeInvite(
				invitePayload([await publicContact(515)], { registryEndpoints: [endpoint] }),
				issuer
			);

			await expect(phaseFour.decodeInvite(encoded, decodeOptions())).rejects.toMatchObject({
				code: "invalid-endpoint",
				name: "InviteDecodeError",
			});
		}
	);

	it("allows plaintext loopback registry URLs only behind the explicit fixture flag", async () => {
		const phaseFour = await loadInviteModule();
		if (phaseFour === undefined) return;
		const issuer = await inviteIssuer(519);
		const encoded = await phaseFour.encodeInvite(
			invitePayload([await publicContact(529)], { registryEndpoints: ["http://127.0.0.1:4101/v1"] }),
			issuer
		);

		await expect(
			phaseFour.decodeInvite(encoded, { ...decodeOptions(), allow_insecure_loopback_fixture: true })
		).resolves.toMatchObject({ registryEndpoints: ["http://127.0.0.1:4101/v1"] });
	});

	it.each(["/ip4/10.0.0.8/tcp/443/wss", "/ip4/127.0.0.1/tcp/443/wss", "/ip4/192.0.2.8/tcp/443/wss"])(
		"encode rejects non-public contact addressing: %s",
		async (address) => {
			const phaseFour = await loadInviteModule();
			if (phaseFour === undefined) return;
			const issuer = await inviteIssuer(516);
			const contact = await publicContact(517, { addresses: [address] });

			await expect(phaseFour.encodeInvite(invitePayload([contact]), issuer)).rejects.toMatchObject({
				code: "unsafe-contact-address",
				name: "InviteEncodeError",
			});
		}
	);

	it("rejects contact lists above the v1 maximum of eight", async () => {
		const phaseFour = await loadInviteModule();
		if (phaseFour === undefined) return;
		const issuer = await inviteIssuer(518);
		const contacts = await Promise.all(Array.from({ length: 9 }, (_, index) => publicContact(520 + index)));

		await expect(phaseFour.encodeInvite(invitePayload(contacts), issuer)).rejects.toMatchObject({
			code: "too-many-contacts",
			name: "InviteEncodeError",
		});
	});

	it("InviteDirectory revalidates its untrusted snapshot and surfaces only valid contacts for its namespace", async () => {
		const phaseFour = await loadInviteModule();
		if (phaseFour === undefined) return;
		const issuer = await inviteIssuer(530);
		const contact = await publicContact(531);
		const verified = await phaseFour.decodeInvite(
			await phaseFour.encodeInvite(invitePayload([contact]), issuer),
			decodeOptions()
		);
		const tampered = {
			...verified.contacts[0],
			record: { ...contact, signature: mutate(contact.signature) },
		} as ValidatedDrpRecord;
		const directory = new phaseFour.InviteDirectory({
			clock: (): number => NOW,
			invite: { ...verified, contacts: [...verified.contacts, tampered] },
			validatorFactory: (): RecordValidator => validator(),
		});

		expect(await directory.discover(NAMESPACE, AbortSignal.timeout(100))).toMatchObject([
			{ record: { peerId: contact.peerId } },
		]);
		expect(await directory.discover(`drp-network:v1:${"q".repeat(43)}`, AbortSignal.timeout(100))).toEqual([]);
	});

	it("InviteDirectory stops serving contacts once the invite expires", async () => {
		const phaseFour = await loadInviteModule();
		if (phaseFour === undefined) return;
		const issuer = await inviteIssuer(532);
		const contact = await publicContact(533, { expiresAtMs: NOW + 300_000 });
		const payload = invitePayload([contact]);
		const verified = await phaseFour.decodeInvite(await phaseFour.encodeInvite(payload, issuer), decodeOptions());
		let now = NOW;
		const directory = new phaseFour.InviteDirectory({
			clock: (): number => now,
			invite: verified,
			validatorFactory: (): RecordValidator => validator(() => NOW),
		});

		expect(await directory.discover(NAMESPACE, AbortSignal.timeout(100))).toHaveLength(1);
		now = payload.expiresAtMs;
		expect(await directory.discover(NAMESPACE, AbortSignal.timeout(100))).toEqual([]);
	});
});

async function loadInviteModule(): Promise<PhaseFourInviteModule | undefined> {
	const loaded = (await import("@ts-drp/rendezvous")) as unknown as Partial<PhaseFourInviteModule>;
	expect(loaded.encodeInvite, "Phase 4b must export encodeInvite").toBeTypeOf("function");
	expect(loaded.decodeInvite, "Phase 4b must export decodeInvite").toBeTypeOf("function");
	expect(loaded.InviteDirectory, "Phase 4b must export InviteDirectory").toBeTypeOf("function");
	if (loaded.encodeInvite === undefined || loaded.decodeInvite === undefined || loaded.InviteDirectory === undefined) {
		return undefined;
	}
	return loaded as PhaseFourInviteModule;
}

function invitePayload(
	contacts: readonly SignedDrpRecordV1[],
	overrides: Partial<InvitePayloadV1> = {}
): InvitePayloadV1 {
	return {
		contacts,
		expiresAtMs: NOW + 120_000,
		issuedAtMs: NOW,
		membershipCapability: "opaque-membership-capability-fixture",
		namespace: NAMESPACE,
		registryEndpoints: ["https://registry-a.example/v1", "https://registry-b.example/v1"],
		...overrides,
	};
}

function decodeOptions(): InviteDecodeOptions {
	return { clock: () => NOW, validatorFactory: () => validator() };
}

async function publicContact(
	index: number,
	overrides: Partial<ReturnType<typeof fixtureInput>> = {}
): Promise<SignedDrpRecordV1> {
	const { peerId, signer } = await fixtureSigner(index);
	const addresses = (overrides.addresses ?? ["/ip4/93.184.216.34/tcp/443/wss"]).map((value) =>
		value.includes("/p2p/") ? value : `${value}/p2p/${peerId}`
	);
	return signer.sign(
		fixtureInput(peerId, {
			expiresAtMs: NOW + 60_000,
			issuedAtMs: NOW,
			...overrides,
			addresses,
		})
	);
}

function inviteIssuer(index: number): Promise<PrivateKey> {
	return generateKeyPairFromSeed("Ed25519", seed(index));
}

function decodeWire(encoded: string): InviteWireV1 {
	return JSON.parse(new TextDecoder().decode(base64url.baseDecode(encoded))) as InviteWireV1;
}

function encodeWire(wire: InviteWireV1): string {
	return base64url.baseEncode(new TextEncoder().encode(JSON.stringify(wire)));
}

function mutate(value: string): string {
	return `${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`;
}
