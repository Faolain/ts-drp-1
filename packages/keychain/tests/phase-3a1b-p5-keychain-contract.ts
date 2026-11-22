import { Keychain } from "../src/keychain.js";

export type P5Keychain = Keychain &
	Readonly<{
		localAuthorId: string;
		signWithLocalAuthor(registeredDigest: Uint8Array): Promise<Uint8Array>;
	}>;

export const P5_KEYCHAIN_VECTORS = Object.freeze({
	alphaAuthorId: "e36c47ced7435513aeb6cc03bcfd238509898b11833d3dab98be46ad56fc84fe",
	alphaLocalSeedHex: "f2c99eadfb651f7f182aa566b4895f3fccfb4b5cc6136e0d6b010560d3741b95",
	alphaSeed: "phase-3a1b-p5-alpha",
	alphaSignatureHex:
		"f10f6b745ca2eba58e2e58a15190b45aba9fc3c3b197960de9a0c74e04b9e0ae3e14670acb9665ca87da8b0f598be6ca8661592b47d7cb9725ed46e229b5c40a",
	betaAuthorId: "6116430cfffe3547114b10afb04e4d34ce9e45e6a019a83aa7c704a9c6e43950",
	betaSeed: "phase-3a1b-p5-beta",
	digest: Uint8Array.from({ length: 32 }, (_, index) => index),
	domain: "ts-drp-keychain/local-author-ed25519/v1",
});

/**
 * Treat the pre-GREEN class as the frozen p5 Keychain surface.
 * @param keychain - The genuine Keychain instance under test.
 * @returns The same instance viewed through the ratified p5 surface.
 */
export function asP5Keychain(keychain: Keychain): P5Keychain {
	return keychain as P5Keychain;
}

/**
 * Encode an observed byte vector without Node-only Buffer semantics.
 * @param bytes - The bytes to encode.
 * @returns Lowercase hexadecimal text.
 */
export function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (octet) => octet.toString(16).padStart(2, "0")).join("");
}

/**
 * Start a configured Keychain through the p5 surface.
 * @param seed - The configured private-key seed.
 * @returns The successfully started Keychain.
 */
export async function startP5Configured(seed: string = P5_KEYCHAIN_VECTORS.alphaSeed): Promise<P5Keychain> {
	const keychain = asP5Keychain(new Keychain({ private_key_seed: seed }));
	await keychain.start();
	return keychain;
}
