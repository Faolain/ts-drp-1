import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import { sha256, sha512 } from "@noble/hashes/sha2";
import { bindSealSigningRequest, mintSealSigningRequest } from "@ts-drp/protocol-v3/internal/seal-signing-request";

import { acquireBrowserIdentity, type BrowserIdentityLease } from "../../../examples/browser-network/src/identity.js";
import { signSealRegisteredDigest } from "../../../packages/keychain/src/finality.js";
import { Keychain } from "../../../packages/keychain/src/keychain.js";
import { verifyEd25519RegisteredDigest } from "../../../packages/protocol-v3/src/index.js";

const DIGEST = Uint8Array.from({ length: 32 }, (_, index) => index);
const DOMAIN = new TextEncoder().encode("ts-drp-keychain/local-author-ed25519/v1");

function bytesToHex(bytes: Uint8Array): string {
	let output = "";
	for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
	return output;
}

function hexToBytes(value: string): Uint8Array {
	return Uint8Array.from({ length: value.length / 2 }, (_, index) =>
		Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
	);
}

async function unavailableSummary(): Promise<Readonly<{ readonly identity: string; readonly signing: string }>> {
	const keychain = new Keychain();
	await keychain.start();
	let identity = "available";
	let signing = "available";
	try {
		void keychain.localAuthorId;
	} catch (error) {
		identity = error instanceof Error ? `${error.constructor.name}:${error.message}` : "non-error";
	}
	try {
		await keychain.signWithLocalAuthor(DIGEST);
	} catch (error) {
		signing = error instanceof Error ? `${error.constructor.name}:${error.message}` : "non-error";
	}
	return Object.freeze({ identity, signing });
}

async function configuredSummary(seed: string): Promise<
	Readonly<{
		readonly authorId: string;
		readonly signatureHex: string;
		readonly strictVerification: boolean;
	}>
> {
	const keychain = new Keychain({ private_key_seed: seed });
	await keychain.start();
	const authorId = keychain.localAuthorId;
	const signature = await keychain.signWithLocalAuthor(DIGEST);
	return Object.freeze({
		authorId,
		signatureHex: bytesToHex(signature),
		strictVerification: verifyEd25519RegisteredDigest(signature, DIGEST, hexToBytes(authorId)),
	});
}

async function controlSummary(seed: string): Promise<
	Readonly<{
		readonly authorId: string;
		readonly signatureHex: string;
		readonly strictVerification: boolean;
	}>
> {
	const seed64 = sha512(new TextEncoder().encode(seed));
	const preimage = new Uint8Array(DOMAIN.byteLength + 1 + seed64.byteLength);
	preimage.set(DOMAIN);
	preimage[DOMAIN.byteLength] = 0;
	preimage.set(seed64, DOMAIN.byteLength + 1);
	const key = await generateKeyPairFromSeed("Ed25519", sha256(preimage));
	const signature = await key.sign(DIGEST);
	return Object.freeze({
		authorId: bytesToHex(key.publicKey.raw),
		signatureHex: bytesToHex(signature),
		strictVerification: verifyEd25519RegisteredDigest(signature, DIGEST, key.publicKey.raw),
	});
}

async function creatorSummary(seed: string): Promise<
	Readonly<{
		readonly exactAuthorKey: boolean;
		readonly sameCustody: boolean;
		readonly retiredAliasRefused: boolean;
		readonly unavailableAfterStop: boolean;
	}>
> {
	const keychain = new Keychain({ private_key_seed: seed });
	await keychain.start();
	const signer = await keychain.acquireLocalAuthorFinalitySigner();
	const author = keychain.localAuthorId;
	const sameCustody = signer === (await keychain.acquireLocalAuthorFinalitySigner());
	const sign = (): Promise<Uint8Array> => {
		const request = mintSealSigningRequest(DIGEST, {
			objectId: "browser:author-custody",
			epoch: 0,
			round: 0,
			signerId: "creator",
			publicKey: hexToBytes(author),
		});
		// Local-custody browser control only. Native signing exclusion is proven
		// by the separate SQLite consumer, not this admitted double.
		bindSealSigningRequest(request, () =>
			Promise.resolve({
				check: () => Promise.resolve(),
				release: () => Promise.resolve(),
			})
		);
		return signSealRegisteredDigest({ signer, request });
	};
	const signature = await sign();
	const ordinary = await keychain.signWithLocalAuthor(DIGEST);
	const exactAuthorKey =
		bytesToHex(signature) === bytesToHex(ordinary) &&
		verifyEd25519RegisteredDigest(signature, DIGEST, hexToBytes(author));
	await keychain.stop();
	let retiredAliasRefused = false,
		unavailableAfterStop = false;
	try {
		await sign();
	} catch (error) {
		retiredAliasRefused = error instanceof Error && error.message === "finality signer is retired";
	}
	try {
		await keychain.acquireLocalAuthorFinalitySigner();
	} catch (error) {
		unavailableAfterStop = error instanceof Error && error.message === "local author identity is unavailable";
	}
	return { exactAuthorKey, sameCustody, retiredAliasRefused, unavailableAfterStop };
}

let liveIdentity: Readonly<{ lease: BrowserIdentityLease; keychain: Keychain }> | undefined;
async function acquireIdentitySummary(): Promise<string> {
	if (liveIdentity !== undefined) throw new Error("browser fixture author is already acquired");
	const lease = await acquireBrowserIdentity({
		lockPrefix: "r9-browser:identity-slot",
		seedKey: "r9-browser:identity-seed",
	});
	const keychain = new Keychain({ private_key_seed: lease.seed });
	try {
		await keychain.start();
		await keychain.acquireLocalAuthorFinalitySigner();
		liveIdentity = { lease, keychain };
		return keychain.localAuthorId;
	} catch (error) {
		await keychain.stop();
		lease.release();
		throw error;
	}
}
async function releaseIdentity(): Promise<void> {
	const owned = liveIdentity;
	if (owned === undefined) return;
	await owned.keychain.stop();
	owned.lease.release();
	liveIdentity = undefined;
}

Object.defineProperty(globalThis, "phase3a1bP5", {
	configurable: false,
	enumerable: true,
	value: Object.freeze({
		configuredSummary,
		controlSummary,
		unavailableSummary,
		creatorSummary,
		acquireIdentitySummary,
		releaseIdentity,
	}),
	writable: false,
});
