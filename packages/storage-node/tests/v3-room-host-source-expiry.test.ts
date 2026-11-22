import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type * as Live from "@ts-drp/node/v3-live";
import { creatorSourceExpiryFields } from "@ts-drp/protocol-v3/internal/creator-source-expiry";
import { withAuthoredSourceExpirySigningRequest, type OwnedSigningRequest } from "@ts-drp/protocol-v3/internal/owned-signing-request";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { createNodeV3RoomStorageHost } from "../src/v3-room-host.js";

// Stands in ONLY for v3-live's private admitted-request registry (whose genuine
// producer needs a whole live room; tests/creator-source-abandonment-native
// covers it end to end). The host, lifetime, keychain and crypto are real.
type Admission = NonNullable<ReturnType<typeof Live.consumeOwnedCreatorSourceExpirySigningRequest>>;
const admitted = vi.hoisted(() => new WeakMap<object, unknown>());
vi.mock("@ts-drp/node/v3-live", async (importOriginal) => {
	const actual = await importOriginal<typeof Live>();
	return { ...actual, consumeOwnedCreatorSourceExpirySigningRequest(request: unknown) {
		if (request !== null && typeof request === "object" && admitted.has(request)) {
			const value = admitted.get(request); admitted.delete(request); return value;
		}
		return actual.consumeOwnedCreatorSourceExpirySigningRequest(request);
	} };
});

const directories = new Set<string>();
const leases = new Set<{ close(): Promise<void> }>();
afterEach(async () => {
	for (const lease of leases) await lease.close(); leases.clear();
	for (const directory of directories) rmSync(directory, { recursive: true, force: true }); directories.clear();
});
async function session() {
	const directory = mkdtempSync(join(tmpdir(), "source-expiry-host-")); directories.add(directory);
	const host = createNodeV3RoomStorageHost({ directory, initialization: () => "create", localSessionSlots: 2,
		localSessionStoreScopes: 8, localSessionHandles: 16 });
	const lease = await host.acquireLocalSession({ kind: "create" }); leases.add(lease);
	return lease;
}
function receipt(author: string): Uint8Array {
	return encodeCanonical(creatorSourceExpiryFields({ objectId: "unit:host-expiry", pinnedGenesisAnchorDigest: "a".repeat(64),
		sourceAuthor: author, sourceSequence: 0, sourceDigest: new Uint8Array(32).fill(1), sourceContextDigest: new Uint8Array(32).fill(2),
		signingEpoch: 1, signingAnchorDigest: "b".repeat(64), signingNativeHeadDigest: new Uint8Array(32).fill(3),
		signingFloorDigest: new Uint8Array(32).fill(4) }));
}
function admit(bytes: Uint8Array, publicKey: Uint8Array, checkWhile: Admission["checkWhile"] = (action) => action()): OwnedSigningRequest {
	const request = Object.freeze({}) as OwnedSigningRequest;
	admitted.set(request, Object.freeze({ bytes, digest: hashDomain("ts-drp/settlement-source-expiry/v1", bytes), publicKey, checkWhile }));
	return request;
}

it("refuses a raw protocol expiry request without the original v3-live admission", async () => {
	const lease = await session();
	const bytes = receipt(lease.signing.author);
	await expect(withAuthoredSourceExpirySigningRequest({ exactCanonicalReceiptBytes: bytes, signerPublicKey: lease.signing.publicKeyBytes },
		(request) => lease.signing.signRequest(request))).rejects.toThrow("LOCAL_SESSION_ORIGINAL_SOURCE_EXPIRY_ADMISSION_REQUIRED");
});

it("signs an admitted expiry only with the owned key inside the owner turn", async () => {
	const lease = await session();
	const bytes = receipt(lease.signing.author);
	let turns = 0;
	const signature = await lease.signing.signRequest(admit(bytes, lease.signing.publicKeyBytes, async (action) => { turns++; return action(); }));
	expect(turns).toBe(1);
	expect(ed25519.verify(signature, hashDomain("ts-drp/settlement-source-expiry/v1", bytes), lease.signing.publicKeyBytes, { zip215: false })).toBe(true);
	// The owner revokes during its own turn: no signature is delivered.
	await expect(lease.signing.signRequest(admit(bytes, lease.signing.publicKeyBytes, async () => {
		throw new TypeError("creator source expiry original owner is revoked"); }))).rejects.toThrow("original owner is revoked");
});

it("refuses a foreign signer key and a revoked session", async () => {
	const lease = await session();
	const foreign = ed25519.getPublicKey(new Uint8Array(32).fill(7));
	await expect(lease.signing.signRequest(admit(receipt(Buffer.from(foreign).toString("hex")), foreign)))
		.rejects.toThrow("LOCAL_SESSION_BORROWED_SIGNING_FLOOR");
	const request = admit(receipt(lease.signing.author), lease.signing.publicKeyBytes);
	await lease.close();
	await expect(lease.signing.signRequest(request)).rejects.toThrow("LOCAL_SESSION_REVOKED");
});
