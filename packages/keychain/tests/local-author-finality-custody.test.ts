import type * as CryptoKeys from "@libp2p/crypto/keys";
import type { Ed25519PrivateKey } from "@libp2p/interface";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
	bindSealSigningRequest,
	mintSealSigningRequest,
	type SigningNativeAdmission,
} from "@ts-drp/protocol-v3/internal/seal-signing-request";
import { beforeEach, expect, test, vi } from "vitest";

import { type FinalitySigner, signSealRegisteredDigest } from "../src/finality.js";
import { Keychain } from "../src/keychain.js";

const hooks = vi.hoisted(() => ({
	generationWait: undefined as Promise<void> | undefined,
	failGeneration: false,
	signingWait: undefined as Promise<void> | undefined,
	entered: 0,
}));
vi.mock("@libp2p/crypto/keys", async (importOriginal) => {
	const actual = await importOriginal<typeof CryptoKeys>();
	return {
		...actual,
		async generateKeyPairFromSeed(type: "Ed25519", seed: Uint8Array): Promise<Ed25519PrivateKey> {
			if (hooks.failGeneration) throw new Error("AUTHOR_GENERATION_FAILURE");
			await hooks.generationWait;
			const key = await actual.generateKeyPairFromSeed(type, seed);
			const sign = key.sign.bind(key);
			Object.defineProperty(key, "sign", {
				async value(digest: Uint8Array): Promise<Uint8Array> {
					hooks.entered += 1;
					await hooks.signingWait;
					return sign(digest);
				},
			});
			return key;
		},
	};
});

const digest = new Uint8Array(32).fill(7);
const publicKey = (author: string): Uint8Array => Uint8Array.from(Buffer.from(author, "hex"));
// These units exercise genuine crypto and local lifetime custody. This admitted
// native double is a premise, not SQLite exclusion or durable-floor evidence.
const nativePremise = (): Promise<SigningNativeAdmission> =>
	Promise.resolve({
		check: () => Promise.resolve(),
		release: () => Promise.resolve(),
	});
function sign(signer: FinalitySigner, author: string): Promise<Uint8Array> {
	const request = mintSealSigningRequest(digest, {
		objectId: "unit:keychain-author-finality",
		epoch: 0,
		round: 0,
		signerId: "creator",
		publicKey: publicKey(author),
	});
	bindSealSigningRequest(request, nativePremise);
	return signSealRegisteredDigest({ signer, request });
}
function deferred(): Readonly<{ promise: Promise<void>; release(): void }> {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
beforeEach(() => {
	hooks.generationWait = undefined;
	hooks.failGeneration = false;
	hooks.signingWait = undefined;
	hooks.entered = 0;
});

test("configured author acquires one genuine same-key creator signer; absent authors and forged custody refuse", async () => {
	const keychain = new Keychain({ private_key_seed: "genuine-browser-author" });
	await expect(keychain.acquireLocalAuthorFinalitySigner()).rejects.toThrow("local author identity is unavailable");
	await keychain.start();
	const [first, second] = await Promise.all([
		keychain.acquireLocalAuthorFinalitySigner(),
		keychain.acquireLocalAuthorFinalitySigner(),
	]);
	expect(first).toBe(second);
	const ordinary = await keychain.signWithLocalAuthor(digest.slice());
	const sealed = await sign(first, keychain.localAuthorId);
	expect(sealed).toEqual(ordinary);
	expect(ed25519.verify(sealed, digest, publicKey(keychain.localAuthorId), { zip215: false })).toBe(true);
	await expect(sign({ ...first }, keychain.localAuthorId)).rejects.toThrow("untrusted finality signer");
	await keychain.stop();
	const unconfigured = new Keychain();
	await unconfigured.start();
	await expect(unconfigured.acquireLocalAuthorFinalitySigner()).rejects.toThrow("local author identity is unavailable");
	await unconfigured.stop();
});

test("Keychain shutdown immediately revokes aliases and joins admitted ordinary and creator signatures", async () => {
	const keychain = new Keychain({ private_key_seed: "joined-browser-author" });
	await keychain.start();
	const author = keychain.localAuthorId;
	const signer = await keychain.acquireLocalAuthorFinalitySigner();
	const wait = deferred();
	hooks.signingWait = wait.promise;
	const ordinary = keychain.signWithLocalAuthor(digest.slice());
	const sealed = sign(signer, author);
	await vi.waitFor(() => expect(hooks.entered).toBe(2));
	let joined = false;
	const stopping = keychain.stop().then(() => {
		joined = true;
	});
	let secondJoined = false;
	const stoppingAgain = keychain.stop().then(() => {
		secondJoined = true;
	});
	await expect(sign(signer, author)).rejects.toThrow("finality signer is retired");
	await expect(keychain.acquireLocalAuthorFinalitySigner()).rejects.toThrow("local author identity is unavailable");
	await expect(keychain.signWithLocalAuthor(digest.slice())).rejects.toThrow("local author identity is unavailable");
	expect(joined).toBe(false);
	expect(secondJoined).toBe(false);
	wait.release();
	for (const signature of await Promise.all([ordinary, sealed])) {
		expect(ed25519.verify(signature, digest, publicKey(author), { zip215: false })).toBe(true);
	}
	await Promise.all([stopping, stoppingAgain]);
	hooks.signingWait = undefined;
	await keychain.start();
	expect(keychain.localAuthorId).toBe(author);
	const fresh = await keychain.acquireLocalAuthorFinalitySigner();
	expect(fresh).not.toBe(signer);
	await expect(sign(signer, author)).rejects.toThrow("finality signer is retired");
	expect(ed25519.verify(await sign(fresh, author), digest, publicKey(author), { zip215: false })).toBe(true);
	await keychain.stop();
});

test("failed restart preserves creator custody; successful replacement retires the old author signer", async () => {
	const config = { private_key_seed: "first-author" };
	const keychain = new Keychain(config);
	await keychain.start();
	const author = keychain.localAuthorId;
	const signer = await keychain.acquireLocalAuthorFinalitySigner();
	config.private_key_seed = "replacement-author";
	hooks.failGeneration = true;
	await expect(keychain.start()).rejects.toThrow("AUTHOR_GENERATION_FAILURE");
	expect(keychain.localAuthorId).toBe(author);
	expect(await keychain.acquireLocalAuthorFinalitySigner()).toBe(signer);
	expect(ed25519.verify(await sign(signer, author), digest, publicKey(author), { zip215: false })).toBe(true);
	hooks.failGeneration = false;
	await keychain.start();
	expect(keychain.localAuthorId).not.toBe(author);
	await expect(sign(signer, author)).rejects.toThrow("finality signer is retired");
	const fresh = await keychain.acquireLocalAuthorFinalitySigner();
	expect(
		ed25519.verify(await sign(fresh, keychain.localAuthorId), digest, publicKey(keychain.localAuthorId), {
			zip215: false,
		})
	).toBe(true);
	await keychain.stop();
});

test("shutdown joins an in-flight creator acquisition without delivering a stale signer", async () => {
	const keychain = new Keychain({ private_key_seed: "pending-author" });
	await keychain.start();
	const wait = deferred();
	hooks.generationWait = wait.promise;
	const acquisition = keychain.acquireLocalAuthorFinalitySigner();
	const refusal = expect(acquisition).rejects.toThrow("local author identity changed during signer acquisition");
	let joined = false;
	const stopping = keychain.stop().then(() => {
		joined = true;
	});
	await Promise.resolve();
	expect(joined).toBe(false);
	wait.release();
	await refusal;
	await stopping;
	expect(joined).toBe(true);
});
