import { bls } from "@chainsafe/bls/herumi";
import { deriveKeyFromEntropy } from "@chainsafe/bls-keygen";
import { generateKeyPairFromSeed, privateKeyFromRaw } from "@libp2p/crypto/keys";
import { sha256, sha512 } from "@noble/hashes/sha2";
import { etc } from "@noble/secp256k1";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { toString as uint8ArrayToString } from "uint8arrays/to-string";
import { describe, expect, test } from "vitest";

import { asP5Keychain, bytesToHex, P5_KEYCHAIN_VECTORS, startP5Configured } from "./phase-3a1b-p5-keychain-contract.js";
import * as keychainModule from "../src/index.js";
import { Keychain } from "../src/keychain.js";

const { alphaAuthorId, alphaLocalSeedHex, alphaSeed, alphaSignatureHex, betaAuthorId, betaSeed, digest, domain } =
	P5_KEYCHAIN_VECTORS;
const FRESH_PROCESS_FIXTURE = fileURLToPath(
	new URL("../../../tests/fixtures/phase-3a1b-p5/keychain-fresh-process.ts", import.meta.url)
);
const execFileAsync = promisify(execFile);

function exactLocalAuthorSeed(seed: string): Uint8Array {
	const encoder = new TextEncoder();
	const seed64 = sha512(encoder.encode(seed));
	const domainBytes = encoder.encode(domain);
	const preimage = new Uint8Array(domainBytes.byteLength + 1 + seed64.byteLength);
	preimage.set(domainBytes, 0);
	preimage[domainBytes.byteLength] = 0;
	preimage.set(seed64, domainBytes.byteLength + 1);
	return sha256(preimage);
}

describe("D.93.35 p5 Keychain configured local-author RED", () => {
	test("[RED] derives the literal domain-zero-SHA512 KDF and exact lowercase identity/signature vectors", async () => {
		expect(bytesToHex(exactLocalAuthorSeed(alphaSeed))).toBe(alphaLocalSeedHex);
		const oracleKey = await generateKeyPairFromSeed("Ed25519", exactLocalAuthorSeed(alphaSeed));
		expect(bytesToHex(oracleKey.publicKey.raw)).toBe(alphaAuthorId);
		const lockedNodeSignature = await oracleKey.sign(digest);
		expect(Buffer.isBuffer(lockedNodeSignature)).toBe(true);
		expect(bytesToHex(lockedNodeSignature)).toBe(alphaSignatureHex);

		const keychain = await startP5Configured();
		expect(keychain.localAuthorId).toBe(alphaAuthorId);
		expect(keychain.localAuthorId).toMatch(/^[0-9a-f]{64}$/u);
		await expect(keychain.signWithLocalAuthor(digest.slice())).resolves.toSatisfy(
			(signature: Uint8Array) => bytesToHex(signature) === alphaSignatureHex
		);

		const changed = await startP5Configured(betaSeed);
		expect(changed.localAuthorId).toBe(betaAuthorId);
		expect(changed.localAuthorId).not.toBe(keychain.localAuthorId);
	});

	test("[RED] reproduces byte-identical identity and signature in independent fresh processes", async () => {
		const args = ["--import", "tsx", FRESH_PROCESS_FIXTURE, alphaSeed, bytesToHex(digest)];
		const [first, second] = await Promise.all([
			execFileAsync(process.execPath, args),
			execFileAsync(process.execPath, args),
		]);
		expect(first.stderr).toBe("");
		expect(second.stderr).toBe("");
		expect(first.stdout).toBe(second.stdout);
		expect(JSON.parse(first.stdout)).toEqual({
			authorId: alphaAuthorId,
			signatureHex: alphaSignatureHex,
		});
	});

	test("[RED] seedless start never mints a local author and both unavailable errors stay exact", async () => {
		const keychain = asP5Keychain(new Keychain());
		await keychain.start();
		expect(() => keychain.localAuthorId).toThrowError(new Error("local author identity is unavailable"));
		await expect(keychain.signWithLocalAuthor(digest.slice())).rejects.toThrowError(
			new Error("local author identity is unavailable")
		);
	});

	test("[RED] unavailable signing wins before any hostile argument inspection and never lazily derives", async () => {
		let traps = 0;
		const hostile = new Proxy(new Uint8Array(32), {
			get(): never {
				traps += 1;
				throw new Error("input inspected");
			},
			getPrototypeOf(): never {
				traps += 1;
				throw new Error("prototype inspected");
			},
		});
		const keychain = asP5Keychain(new Keychain({ private_key_seed: alphaSeed }));

		expect(() => keychain.localAuthorId).toThrowError(new Error("local author identity is unavailable"));
		await expect(keychain.signWithLocalAuthor(hostile)).rejects.toThrowError(
			new Error("local author identity is unavailable")
		);
		expect(traps).toBe(0);
	});

	test("[RED] rejects an unpaired surrogate instead of replacement-encoding or publishing legacy candidates", async () => {
		const keychain = asP5Keychain(new Keychain({ private_key_seed: "phase-p5-\ud800-invalid" }));
		await expect(keychain.start()).rejects.toThrow();
		expect(() => keychain.localAuthorId).toThrowError(new Error("local author identity is unavailable"));
		expect(() => keychain.secp256k1PublicKey).toThrow();
		expect(() => keychain.blsPublicKey).toThrow();
	});

	test("[RED] snapshots the configured seed before start reaches its first await", async () => {
		const config: { private_key_seed: string } = { private_key_seed: alphaSeed };
		const keychain = asP5Keychain(new Keychain(config));
		const starting = keychain.start();
		config.private_key_seed = betaSeed;
		await starting;
		expect(keychain.localAuthorId).toBe(alphaAuthorId);
	});

	test("[RED] copies the complete 32-byte digest before await and returns a fresh complete 64-byte signature", async () => {
		const keychain = await startP5Configured();
		const callerDigest = digest.slice();
		const signing = keychain.signWithLocalAuthor(callerDigest);
		callerDigest.fill(0xff);
		const signature = await signing;

		expect(bytesToHex(signature)).toBe(alphaSignatureHex);
		expect(Object.getPrototypeOf(signature)).toBe(Uint8Array.prototype);
		expect(signature.buffer).toBeInstanceOf(ArrayBuffer);
		expect(signature.byteOffset).toBe(0);
		expect(signature.byteLength).toBe(64);
		expect(signature.buffer.byteLength).toBe(64);

		signature.fill(0);
		expect(keychain.localAuthorId).toBe(alphaAuthorId);
		await expect(keychain.signWithLocalAuthor(digest.slice())).resolves.toSatisfy(
			(next: Uint8Array) => bytesToHex(next) === alphaSignatureHex
		);
	});

	test("[RED] accepts only an ordinary non-shared complete 32-byte digest view", async () => {
		class DigestSubclass extends Uint8Array {}
		const detached = new Uint8Array(32);
		structuredClone(detached.buffer, { transfer: [detached.buffer] });
		const shared = new Uint8Array(new SharedArrayBuffer(32));
		const partialAtZero = new Uint8Array(new ArrayBuffer(64), 0, 32);
		const partialAtOffset = new Uint8Array(new ArrayBuffer(64), 16, 32);
		let fakeReads = 0;
		const accessorFake = Object.defineProperties(
			{},
			{
				buffer: { get: () => (fakeReads += 1) },
				byteLength: { get: () => (fakeReads += 1) },
				byteOffset: { get: () => (fakeReads += 1) },
			}
		);
		const keychain = await startP5Configured();

		for (const hostile of [
			detached,
			new Uint8Array(31),
			new Uint8Array(33),
			new DigestSubclass(32),
			shared,
			partialAtZero,
			partialAtOffset,
			accessorFake,
		]) {
			await expect(keychain.signWithLocalAuthor(hostile as Uint8Array)).rejects.toBeInstanceOf(TypeError);
		}
		expect(fakeReads).toBe(0);
	});

	test("[RED] rejects proxied typed arrays without forwarding digest bytes to the signer", async () => {
		let propertyReads = 0;
		const proxied = new Proxy(digest.slice(), {
			get(target, property, receiver): unknown {
				propertyReads += 1;
				return Reflect.get(target, property, receiver);
			},
		});
		const keychain = await startP5Configured();
		await expect(keychain.signWithLocalAuthor(proxied)).rejects.toBeInstanceOf(TypeError);
		expect(propertyReads).toBe(0);
	});

	test("[RED] exposes exactly the two new class members and no secret, generic-signer, serialization, stop or zeroization hook", () => {
		expect(Object.keys(keychainModule).sort()).toEqual(["Keychain"]);
		expect(Reflect.ownKeys(Keychain.prototype).map(String).sort()).toEqual([
			"blsPublicKey",
			"constructor",
			"localAuthorId",
			"secp256k1PrivateKey",
			"secp256k1PublicKey",
			"signWithBls",
			"signWithLocalAuthor",
			"signWithSecp256k1",
			"start",
		]);
		expect(Reflect.ownKeys(Keychain).map(String).sort()).toEqual(["length", "name", "prototype"]);
	});
});

describe("D.93.35 p5 Keychain legacy-preservation controls", () => {
	test("[RED] seedless and empty-seed starts publish no local-author authority", async () => {
		for (const keychain of [asP5Keychain(new Keychain()), asP5Keychain(new Keychain({ private_key_seed: "" }))]) {
			await keychain.start();
			expect(() => keychain.localAuthorId).toThrowError(new Error("local author identity is unavailable"));
			await expect(keychain.signWithLocalAuthor(digest.slice())).rejects.toThrowError(
				new Error("local author identity is unavailable")
			);
		}
	});

	test("[CONTROL] configured secp256k1 and BLS derivation remain bound to the legacy SHA-512 bytes", async () => {
		const legacy = new Keychain({ private_key_seed: alphaSeed });
		await legacy.start();
		const legacySeed64 = sha512.create().update(alphaSeed).digest();
		const expectedSecp256k1 = privateKeyFromRaw(etc.hashToPrivateKey(legacySeed64));
		if (expectedSecp256k1.type !== "secp256k1") throw new Error("legacy secp256k1 oracle type mismatch");
		const expectedBls = bls.SecretKey.fromBytes(deriveKeyFromEntropy(legacySeed64));

		expect(legacy.secp256k1PublicKey).toBe(uint8ArrayToString(expectedSecp256k1.publicKey.raw, "base64"));
		expect(legacy.blsPublicKey).toBe(uint8ArrayToString(expectedBls.toPublicKey().toBytes(), "base64"));
		expect(bytesToHex(legacy.secp256k1PrivateKey)).toBe(bytesToHex(expectedSecp256k1.raw));
		expect(bytesToHex(legacy.signWithBls("p5-legacy-message"))).toBe(
			bytesToHex(expectedBls.sign(new TextEncoder().encode("p5-legacy-message")).toBytes())
		);
	});

	test("[CONTROL] seedless starts preserve random legacy secp256k1/BLS behavior", async () => {
		const first = new Keychain();
		const second = new Keychain({ private_key_seed: "" });
		await Promise.all([first.start(), second.start()]);
		expect(first.secp256k1PublicKey).not.toBe(second.secp256k1PublicKey);
		expect(first.blsPublicKey).not.toBe(second.blsPublicKey);
		expect(first.signWithBls("p5-control")).toHaveLength(96);
		await expect(first.signWithSecp256k1("p5-control")).resolves.toHaveLength(65);
	});

	test("[CONTROL] pre-start legacy unavailable errors remain unchanged", async () => {
		const keychain = new Keychain({ private_key_seed: alphaSeed });
		expect(() => keychain.signWithBls("p5-control")).toThrowError("Private key not found");
		await expect(keychain.signWithSecp256k1("p5-control")).rejects.toThrowError("Private key not found");
	});
});
