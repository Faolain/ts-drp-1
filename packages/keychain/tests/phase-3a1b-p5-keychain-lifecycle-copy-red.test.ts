import type * as Libp2pCryptoKeys from "@libp2p/crypto/keys";
import type { Ed25519PrivateKey } from "@libp2p/interface";
import { Buffer } from "node:buffer";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { asP5Keychain, bytesToHex, P5_KEYCHAIN_VECTORS, startP5Configured } from "./phase-3a1b-p5-keychain-contract.js";
import { Keychain } from "../src/keychain.js";

const keyHooks = vi.hoisted(() => ({
	dependencyOutputs: [] as Uint8Array[],
	failLocalGeneration: false,
	generationWait: undefined as Promise<void> | undefined,
	generatedSeeds: [] as Uint8Array[],
	signImplementation: undefined as
		| undefined
		| ((input: Uint8Array, actualSign: (input: Uint8Array) => Promise<Uint8Array>) => Promise<Uint8Array> | Uint8Array),
	signInputs: [] as Uint8Array[],
}));

vi.mock("@libp2p/crypto/keys", async (importOriginal) => {
	const actual = (await importOriginal()) as typeof Libp2pCryptoKeys;
	return {
		...actual,
		async generateKeyPairFromSeed(type: "Ed25519", seed: Uint8Array): Promise<Ed25519PrivateKey> {
			keyHooks.generatedSeeds.push(seed.slice());
			if (keyHooks.failLocalGeneration) {
				throw new Error("p5 injected local-author derivation failure");
			}
			await keyHooks.generationWait;
			const key = await actual.generateKeyPairFromSeed(type, seed);
			const dependencySign = key.sign.bind(key);
			const actualSign = (input: Uint8Array): Promise<Uint8Array> => Promise.resolve(dependencySign(input));
			Object.defineProperty(key, "sign", {
				configurable: true,
				value(input: Uint8Array): Promise<Uint8Array> | Uint8Array {
					keyHooks.signInputs.push(input);
					return keyHooks.signImplementation?.(input, actualSign) ?? actualSign(input);
				},
			});
			return key;
		},
	};
});

const { alphaAuthorId, alphaLocalSeedHex, alphaSeed, alphaSignatureHex, betaSeed, digest } = P5_KEYCHAIN_VECTORS;
const INVALID_SIGNER_RESULT = new TypeError("local author signer must return a 64-byte Uint8Array");

function signatureBytes(): Uint8Array {
	return Uint8Array.from(alphaSignatureHex.match(/../gu) ?? [], (octet) => Number.parseInt(octet, 16));
}

function intrinsicSignatureHex(source: Uint8Array): string {
	const copy = new Uint8Array(64);
	Uint8Array.prototype.set.call(copy, source);
	return bytesToHex(copy);
}

function expectFreshOrdinarySignature(returned: Uint8Array, dependencyOutput: Uint8Array): void {
	expect(returned).not.toBe(dependencyOutput);
	expect(returned.buffer).not.toBe(dependencyOutput.buffer);
	expect(Object.getPrototypeOf(returned)).toBe(Uint8Array.prototype);
	expect(returned.buffer).toBeInstanceOf(ArrayBuffer);
	expect(returned.byteOffset).toBe(0);
	expect(returned.byteLength).toBe(64);
	expect(returned.buffer.byteLength).toBe(64);
	expect(bytesToHex(returned)).toBe(alphaSignatureHex);
}

beforeEach(() => {
	keyHooks.dependencyOutputs.length = 0;
	keyHooks.failLocalGeneration = false;
	keyHooks.generationWait = undefined;
	keyHooks.generatedSeeds.length = 0;
	keyHooks.signImplementation = undefined;
	keyHooks.signInputs.length = 0;
});

describe("D.93.35 p5 Keychain lifecycle and copy-boundary RED", () => {
	test("[RED] passes the exact KDF output once to the retained Ed25519 dependency", async () => {
		const keychain = await startP5Configured();
		expect(keychain.localAuthorId).toBe(alphaAuthorId);
		expect(keyHooks.generatedSeeds.map(bytesToHex)).toEqual([alphaLocalSeedHex]);
	});

	test("[RED] first-start local-author failure publishes none of the three candidate capabilities", async () => {
		keyHooks.failLocalGeneration = true;
		const keychain = asP5Keychain(new Keychain({ private_key_seed: alphaSeed }));

		await expect(keychain.start()).rejects.toThrowError("p5 injected local-author derivation failure");
		expect(keyHooks.generatedSeeds).toHaveLength(1);
		expect(() => keychain.localAuthorId).toThrowError(new Error("local author identity is unavailable"));
		expect(() => keychain.secp256k1PublicKey).toThrow();
		expect(() => keychain.blsPublicKey).toThrow();
		await expect(keychain.signWithSecp256k1("p5-after-failure")).rejects.toThrow();
		expect(() => keychain.signWithBls("p5-after-failure")).toThrow();
	});

	test("[RED] failed changed-seed restart atomically preserves the complete previous published set", async () => {
		const config: { private_key_seed: string } = { private_key_seed: alphaSeed };
		const keychain = asP5Keychain(new Keychain(config));
		await keychain.start();
		const previous = {
			authorId: keychain.localAuthorId,
			blsPublicKey: keychain.blsPublicKey,
			blsSignature: bytesToHex(keychain.signWithBls("p5-restart")),
			secp256k1PrivateKey: bytesToHex(keychain.secp256k1PrivateKey),
			secp256k1PublicKey: keychain.secp256k1PublicKey,
		};

		config.private_key_seed = betaSeed;
		keyHooks.failLocalGeneration = true;
		await expect(keychain.start()).rejects.toThrowError("p5 injected local-author derivation failure");

		expect(keychain.localAuthorId).toBe(previous.authorId);
		expect(keychain.blsPublicKey).toBe(previous.blsPublicKey);
		expect(bytesToHex(keychain.signWithBls("p5-restart"))).toBe(previous.blsSignature);
		expect(bytesToHex(keychain.secp256k1PrivateKey)).toBe(previous.secp256k1PrivateKey);
		expect(keychain.secp256k1PublicKey).toBe(previous.secp256k1PublicKey);
	});

	test("[RED] successful changed-seed restart atomically publishes one complete new candidate set", async () => {
		const config: { private_key_seed: string } = { private_key_seed: alphaSeed };
		const keychain = asP5Keychain(new Keychain(config));
		await keychain.start();
		const previous = {
			authorId: keychain.localAuthorId,
			blsPublicKey: keychain.blsPublicKey,
			blsSignature: bytesToHex(keychain.signWithBls("p5-successful-restart")),
			localSignature: bytesToHex(await keychain.signWithLocalAuthor(digest.slice())),
			secp256k1PrivateKey: bytesToHex(keychain.secp256k1PrivateKey),
			secp256k1PublicKey: keychain.secp256k1PublicKey,
		};

		config.private_key_seed = betaSeed;
		let releaseGeneration: (() => void) | undefined;
		keyHooks.generationWait = new Promise<void>((resolve) => {
			releaseGeneration = resolve;
		});
		const restarting = keychain.start();

		expect(keyHooks.generatedSeeds).toHaveLength(2);
		expect(keychain.localAuthorId).toBe(previous.authorId);
		expect(keychain.blsPublicKey).toBe(previous.blsPublicKey);
		expect(bytesToHex(keychain.signWithBls("p5-successful-restart"))).toBe(previous.blsSignature);
		expect(bytesToHex(await keychain.signWithLocalAuthor(digest.slice()))).toBe(previous.localSignature);
		expect(bytesToHex(keychain.secp256k1PrivateKey)).toBe(previous.secp256k1PrivateKey);
		expect(keychain.secp256k1PublicKey).toBe(previous.secp256k1PublicKey);

		if (releaseGeneration === undefined) throw new Error("local-author generation did not reach the injected wait");
		releaseGeneration();
		await restarting;

		expect(keychain.localAuthorId).not.toBe(previous.authorId);
		expect(keychain.blsPublicKey).not.toBe(previous.blsPublicKey);
		expect(bytesToHex(keychain.signWithBls("p5-successful-restart"))).not.toBe(previous.blsSignature);
		expect(bytesToHex(await keychain.signWithLocalAuthor(digest.slice()))).not.toBe(previous.localSignature);
		expect(bytesToHex(keychain.secp256k1PrivateKey)).not.toBe(previous.secp256k1PrivateKey);
		expect(keychain.secp256k1PublicKey).not.toBe(previous.secp256k1PublicKey);
		expect(keyHooks.generatedSeeds).toHaveLength(2);
	});

	test("[RED] gives the signer one detached digest copy before await and retains a separate verification-stable value", async () => {
		let release: (() => void) | undefined;
		keyHooks.signImplementation = (input, actualSign): Promise<Uint8Array> =>
			new Promise<Uint8Array>((resolve, reject) => {
				release = (): void => {
					actualSign(input).then(resolve, reject);
				};
			});
		const keychain = await startP5Configured();
		const callerDigest = digest.slice();
		const signing = keychain.signWithLocalAuthor(callerDigest);

		expect(keyHooks.signInputs).toHaveLength(1);
		expect(keyHooks.signInputs[0]).not.toBe(callerDigest);
		expect(keyHooks.signInputs[0]?.buffer).not.toBe(callerDigest.buffer);
		callerDigest.fill(0xff);
		expect(bytesToHex(keyHooks.signInputs[0] ?? new Uint8Array())).toBe(bytesToHex(digest));
		release?.();
		await expect(signing).resolves.toSatisfy((signature: Uint8Array) => bytesToHex(signature) === alphaSignatureHex);
		expect(keyHooks.signInputs).toHaveLength(1);
	});

	test("[RED] accepts synchronous or asynchronous dependency signatures but always returns an independent fresh copy", async () => {
		const keychain = await startP5Configured();
		for (const asynchronous of [false, true]) {
			keyHooks.signImplementation = (input, actualSign): Promise<Uint8Array> | Uint8Array => {
				const produce = async (): Promise<Uint8Array> => {
					const dependencyOutput = await actualSign(input);
					keyHooks.dependencyOutputs.push(dependencyOutput);
					return dependencyOutput;
				};
				if (asynchronous) return produce();
				const knownSignature = signatureBytes();
				keyHooks.dependencyOutputs.push(knownSignature);
				return knownSignature;
			};

			const returned = await keychain.signWithLocalAuthor(digest.slice());
			const dependencyOutput = keyHooks.dependencyOutputs.at(-1);
			if (dependencyOutput === undefined) throw new Error("dependency signature was not observed");
			expectFreshOrdinarySignature(returned, dependencyOutput);
			returned[0] = 0;
			expect(bytesToHex(dependencyOutput)).toBe(alphaSignatureHex);
		}
		expect(keyHooks.signInputs).toHaveLength(2);
	});

	test("[RED] privately accepts genuine Uint8Array-brand Buffer, subclass and partial views but returns only a fresh ordinary full view", async () => {
		class SignatureSubclass extends Uint8Array {}
		class HostileSignatureSubclass extends Uint8Array {
			static get [Symbol.species](): never {
				throw new Error("species must not be observed");
			}

			override [Symbol.iterator](): never {
				throw new Error("iterator must not be invoked");
			}

			override set(): never {
				throw new Error("source set must not be invoked");
			}

			override slice(): never {
				throw new Error("source slice must not be invoked");
			}
		}

		const expected = signatureBytes();
		const subclass = new SignatureSubclass(64);
		Uint8Array.prototype.set.call(subclass, expected);
		const partialAtZero = new Uint8Array(new ArrayBuffer(128), 0, 64);
		partialAtZero.set(expected);
		const partialAtOffset = new Uint8Array(new ArrayBuffer(128), 32, 64);
		partialAtOffset.set(expected);
		const hostileSubclass = new HostileSignatureSubclass(64);
		Uint8Array.prototype.set.call(hostileSubclass, expected);
		Object.defineProperty(hostileSubclass, "constructor", {
			get(): never {
				throw new Error("constructor must not be observed");
			},
		});
		const dependencyResults = [
			expected,
			Buffer.from(expected),
			subclass,
			partialAtZero,
			partialAtOffset,
			hostileSubclass,
		];
		const keychain = await startP5Configured();

		for (const dependencyResult of dependencyResults) {
			keyHooks.signImplementation = (): Uint8Array => dependencyResult;
			const returned = await keychain.signWithLocalAuthor(digest.slice());
			expectFreshOrdinarySignature(returned, dependencyResult);
			returned.fill(0);
			expect(intrinsicSignatureHex(dependencyResult)).toBe(alphaSignatureHex);
		}
		expect(keyHooks.signInputs).toHaveLength(dependencyResults.length);
	});

	test("[RED] rejects non-Uint8Array, shared, detached, resizable and wrong-length dependency results with the fixed error", async () => {
		const detached = new Uint8Array(64);
		structuredClone(detached.buffer, { transfer: [detached.buffer] });
		let fakeReads = 0;
		const accessorFake = Object.defineProperties(
			{},
			{
				buffer: { get: () => (fakeReads += 1) },
				byteLength: { get: () => (fakeReads += 1) },
				byteOffset: { get: () => (fakeReads += 1) },
			}
		);
		const invalidResults: unknown[] = [
			detached,
			new Uint8Array(63),
			new Uint8Array(65),
			new Uint16Array(32),
			new DataView(new ArrayBuffer(64)),
			new Uint8Array(new SharedArrayBuffer(64)),
			accessorFake,
			"not a signature",
		];
		type ResizableArrayBuffer = ArrayBuffer & Readonly<{ resizable: boolean }>;
		const ResizableArrayBufferConstructor = ArrayBuffer as typeof ArrayBuffer & {
			new (byteLength: number, options: { maxByteLength: number }): ResizableArrayBuffer;
		};
		const resizableBacking = new ResizableArrayBufferConstructor(64, { maxByteLength: 128 });
		expect(resizableBacking.resizable).toBe(true);
		invalidResults.push(new Uint8Array(resizableBacking));
		const keychain = await startP5Configured();

		for (const invalid of invalidResults) {
			const callsBefore = keyHooks.signInputs.length;
			keyHooks.signImplementation = (): Uint8Array => invalid as Uint8Array;
			await expect(keychain.signWithLocalAuthor(digest.slice())).rejects.toThrowError(INVALID_SIGNER_RESULT);
			expect(keyHooks.signInputs).toHaveLength(callsBefore + 1);
		}
		expect(fakeReads).toBe(0);
	});

	test("[RED] contains hostile reflection failure from a proxied dependency result without reading signature bytes", async () => {
		let propertyReads = 0;
		const hostileResult = new Proxy(new Uint8Array(64), {
			get(): never {
				propertyReads += 1;
				throw new Error("signature property exposed");
			},
			getPrototypeOf(): never {
				throw new Error("signature prototype denied");
			},
		});
		keyHooks.signImplementation = (): Uint8Array => hostileResult;
		const keychain = await startP5Configured();

		await expect(keychain.signWithLocalAuthor(digest.slice())).rejects.toThrowError(INVALID_SIGNER_RESULT);
		expect(propertyReads).toBe(0);
		expect(keyHooks.signInputs).toHaveLength(1);
	});
});
