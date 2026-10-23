import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { expect, it } from "vitest";
import {
	consumeOwnedSigningRequest,
	CREATOR_SUCCESSOR_TRANSPORT_LIMITS,
	withAuthoredIdentityChallengeSigningRequest,
} from "../packages/protocol-v3/src/internal/owned-signing-request.js";

const key = ed25519.getPublicKey(new Uint8Array(32).fill(1));
const base = {
	kind: "creator-successor-material-response",
	version: 2,
	nonce: new Uint8Array(32),
	author: Buffer.from(key).toString("hex"),
	manifestDigest: "a".repeat(64),
	requesterPeer: "writer",
	sourcePeer: "creator",
	exactCanonicalSettlementBytes: Uint8Array.of(1),
	exactCanonicalHistoryBytes: Uint8Array.of(1),
};
async function admitted(frame: object) {
	const bytes = encodeCanonical(frame);
	return withAuthoredIdentityChallengeSigningRequest(
		{ kind: "transport", exactCanonicalChallengeBytes: bytes, signerPublicKey: key },
		async (request) => {
			const captured = consumeOwnedSigningRequest(request);
			expect(captured?.digest).toEqual(hashDomain("ts-drp/creator-successor-transport/v1", bytes));
			expect(consumeOwnedSigningRequest(request)).toBeUndefined();
			return captured?.kind;
		}
	);
}

it.each([1, 262144, CREATOR_SUCCESSOR_TRANSPORT_LIMITS.maxMembershipBytes])(
	"the original signing validator admits a bounded membership response of %d bytes",
	async (size) => {
		expect(await admitted({ ...base, exactCanonicalCloseMembershipBytes: new Uint8Array(size) })).toBe("transport");
	}
);

it("retains v1 signing admission and refuses version, kind and membership boundary mismatches", async () => {
	expect(await admitted({ ...base, version: 1 })).toBe("transport");
	for (const frame of [
		base,
		{ ...base, version: 1, exactCanonicalCloseMembershipBytes: Uint8Array.of(1) },
		{ ...base, kind: "creator-successor-material-request", exactCanonicalCloseMembershipBytes: Uint8Array.of(1) },
		{ ...base, exactCanonicalCloseMembershipBytes: new Uint8Array(0) },
		{
			...base,
			exactCanonicalCloseMembershipBytes: new Uint8Array(CREATOR_SUCCESSOR_TRANSPORT_LIMITS.maxMembershipBytes + 1),
		},
		{
			...base,
			version: 1,
			exactCanonicalHistoryBytes: new Uint8Array(CREATOR_SUCCESSOR_TRANSPORT_LIMITS.maxRequestBytes),
		},
	])
		await expect(admitted(frame)).rejects.toThrow();
});
