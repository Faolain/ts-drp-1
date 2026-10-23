import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { expect, it } from "vitest";
import { CREATOR_REATTACHMENT_CHECKPOINT_MAX_BYTES, decodeCreatorReattachmentCheckpoint, encodeCreatorReattachmentCheckpoint } from "../packages/protocol-v3/src/creator-checkpoint.js";
import { CREATOR_CLOSE_HISTORY_MAX_BYTES } from "../packages/node/src/internal/creator-close-history.js";
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

it("bounds separately requested checkpoint proof without spending the adjacent membership allowance", async () => {
	const point = {
		exactCanonicalPredecessorTrustStateRecordBytes: new Uint8Array(8192),
		exactCanonicalPredecessorAclBytes: new Uint8Array(65_536),
		exactCanonicalPredecessorSettlementBytes: new Uint8Array(32_768),
	};
	const carrier = encodeCreatorReattachmentCheckpoint(point);
	expect(carrier.byteLength).toBe(106_686);
	expect(carrier.byteLength).toBe(CREATOR_REATTACHMENT_CHECKPOINT_MAX_BYTES);
	expect(decodeCreatorReattachmentCheckpoint(carrier)).toEqual(point);
	const response = { ...base, version: 3, exactCanonicalReattachmentCheckpointBytes: carrier,
		exactCanonicalSettlementBytes: new Uint8Array(32_768),
		exactCanonicalHistoryBytes: new Uint8Array(CREATOR_CLOSE_HISTORY_MAX_BYTES) };
	// The actual signed frame, not just the three carrier fields, fits the
	// original request profile. The outer codec bounds any variable routing text.
	expect(encodeCanonical({ ...response, signature: new Uint8Array(64) }).byteLength)
		.toBeLessThan(CREATOR_SUCCESSOR_TRANSPORT_LIMITS.maxRequestBytes);
	expect(await admitted(response)).toBe("transport");
	const request = { kind: "creator-successor-material-request", version: 2, materialKind: "checkpoint",
		nonce: base.nonce, author: base.author, manifestDigest: base.manifestDigest,
		requesterPeer: base.requesterPeer, sourcePeer: base.sourcePeer };
	expect(await admitted(request)).toBe("transport");
	for (const frame of [
		{ ...response, version: 2 },
		{ ...response, exactCanonicalCloseMembershipBytes: Uint8Array.of(1) },
		{ ...response, exactCanonicalReattachmentCheckpointBytes: new Uint8Array(0) },
		{ ...response, sourcePeer: "x".repeat(CREATOR_SUCCESSOR_TRANSPORT_LIMITS.maxRequestBytes) },
		{ ...request, version: 1 },
		{ ...request, materialKind: "arbitrary" },
		{ ...request, exactCanonicalReattachmentCheckpointBytes: carrier },
	]) await expect(admitted(frame)).rejects.toThrow();
	expect(() => encodeCreatorReattachmentCheckpoint({ ...point, exactCanonicalPredecessorAclBytes: new Uint8Array(65_537) })).toThrow();
	expect(decodeCreatorReattachmentCheckpoint(encodeCanonical({ kind: "creator-reattachment-checkpoint-1", version: 1,
		...point, extra: true }))).toBeUndefined();
});

it("signs only an exact typed checkpoint unavailable frame", async () => {
	const unavailable = { kind: "creator-successor-material-unavailable", version: 1, reason: "checkpoint-not-adopted",
		nonce: base.nonce, author: base.author, manifestDigest: base.manifestDigest,
		requesterPeer: base.requesterPeer, sourcePeer: base.sourcePeer };
	expect(await admitted(unavailable)).toBe("transport");
	for (const change of [{ reason: "arbitrary" }, { version: 3 }, { exactCanonicalSettlementBytes: Uint8Array.of(1) },
		{ exactCanonicalCloseMembershipBytes: Uint8Array.of(1) }, { materialKind: "checkpoint" }])
		await expect(admitted({ ...unavailable, ...change })).rejects.toThrow();
});
