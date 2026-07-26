import { sha256 } from "@noble/hashes/sha2";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import registry from "../registry/field-registry.json" with { type: "json" };
import {
	decodeCanonical,
	deepCloneCanonical,
	encodeCanonical,
	hashDomain,
	signerSetBytes,
	validateProtocolString,
	type VertexInput,
	vertexPreimage,
} from "../src/index.js";

interface ReferenceCanonicalModule {
	encodeCanonical(value: unknown): Uint8Array;
}

interface ReferenceProtocolModule {
	vertexPreimage(value: VertexInput): unknown;
}

async function loadReferenceModules(): Promise<{
	canonical: ReferenceCanonicalModule;
	protocol: ReferenceProtocolModule;
}> {
	const canonicalPath: string = "../conformance/ahe-reference/src/canonical.js";
	const protocolPath: string = "../conformance/ahe-reference/src/protocol.js";
	return {
		canonical: (await import(canonicalPath)) as ReferenceCanonicalModule,
		protocol: (await import(protocolPath)) as ReferenceProtocolModule,
	};
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
	const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.byteLength;
	}
	return output;
}

function u32be(value: number): Uint8Array {
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setUint32(0, value, false);
	return bytes;
}

function u64be(value: number): Uint8Array {
	const bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
	return bytes;
}

function frame(domain: string, parts: readonly Uint8Array[]): Uint8Array {
	const domainBytes = new TextEncoder().encode(domain);
	return concatBytes([
		Uint8Array.of(0x44, 0x52, 0x50, 0x00),
		u32be(domainBytes.byteLength),
		domainBytes,
		...parts.flatMap((part) => [u64be(part.byteLength), part]),
	]);
}

function shuffledMap(seed: number): Map<string, number> {
	const entries: [string, number][] = [
		["z", 1],
		["ä", 2],
		["A", 3],
		["😀", 4],
	];
	let state = seed >>> 0;
	for (let index = entries.length - 1; index > 0; index--) {
		state = (Math.imul(state, 1103515245) + 12345) >>> 0;
		const target = state % (index + 1);
		[entries[index], entries[target]] = [entries[target] as [string, number], entries[index] as [string, number]];
	}
	return new Map(entries);
}

describe("§2.5 semantics-preserving port rules", () => {
	it("rule 1 — safe number integers round-trip; unsafe numbers and bigint throw", () => {
		const maximum = Number.MAX_SAFE_INTEGER;
		expect(decodeCanonical(encodeCanonical(maximum))).toBe(maximum);
		expect(() => encodeCanonical(maximum + 1)).toThrow();
		expect(() => encodeCanonical(BigInt(1))).toThrow();
	});

	it("rule 2 — all float paths normalize -0 and reject non-finite values", () => {
		const negativeZero = encodeCanonical(Float32Array.of(-0));
		const positiveZero = encodeCanonical(Float32Array.of(+0));
		expect(negativeZero).toEqual(positiveZero);
		expect(decodeCanonical(negativeZero)).toEqual(Float32Array.of(0));
		expect(() => encodeCanonical(Number.NaN)).toThrow();
		expect(() => encodeCanonical(Float64Array.of(Number.POSITIVE_INFINITY))).toThrow();
	});

	it("rule 3 — exact optional properties forbid undefined and absent builders match the reference", async () => {
		const input: VertexInput = {
			anchor: "0".repeat(64),
			author: "peer-a",
			dependencies: ["1".repeat(64)],
			epoch: 1,
			logicalTime: 1,
			objectId: "room-a",
			operation: { op: "set" },
		};
		// @ts-expect-error exactOptionalPropertyTypes forbids explicitly assigning undefined.
		const invalid: VertexInput = { ...input, protocolMajor: undefined };
		void invalid;

		const referenceModules = await loadReferenceModules();
		const candidate = encodeCanonical(vertexPreimage(input));
		const reference = referenceModules.canonical.encodeCanonical(referenceModules.protocol.vertexPreimage(input));
		expect(candidate).toEqual(reference);
	});

	it("rule 4 — decoded objects are null-prototype and class or proto-like instances reject", () => {
		const decoded = decodeCanonical(encodeCanonical({ field: 1 }));
		expect(Object.getPrototypeOf(decoded)).toBeNull();

		class Message {
			field = 1;
		}
		expect(() => encodeCanonical(new Message())).toThrow();
		expect(() => encodeCanonical(Object.assign(Object.create({ generatedMessage: true }), { field: 1 }))).toThrow();
	});

	it("rule 5 — Map insertion shuffles have one canonical encoding", () => {
		const expected = encodeCanonical(shuffledMap(0));
		for (let seed = 1; seed <= 128; seed++) {
			expect(encodeCanonical(shuffledMap(seed))).toEqual(expected);
		}
	});

	it("rule 6 — canonical clone normalizes -0 and protocol lint bans structuredClone", () => {
		const eslintConfig = readFileSync(new URL("../../../eslint.config.mjs", import.meta.url), "utf8");
		expect(eslintConfig).toMatch(/packages\/protocol-v2\/src\/\*\*\/\*\.ts/);
		expect(eslintConfig).toMatch(/no-restricted-globals/);
		expect(eslintConfig).toMatch(/structuredClone/);

		const canonical = deepCloneCanonical({ value: -0 });
		const platform = structuredClone({ value: -0 });
		expect(Object.is(canonical.value, +0)).toBe(true);
		expect(Object.is(platform.value, -0)).toBe(true);
	});

	it("rule 7 — hashDomain is sync Uint8Array and noble equals WebCrypto on exact framing", async () => {
		const syncTypeAssertion: Uint8Array = hashDomain("ts-drp/test/v2", Uint8Array.of(1));
		expect(syncTypeAssertion).toBeInstanceOf(Uint8Array);
		expect(syncTypeAssertion).not.toBeInstanceOf(Promise);

		const domain = "ts-drp/test/v2";
		const parts = [Uint8Array.of(0, 1, 2), new TextEncoder().encode("peer-😀")];
		const expected = sha256(frame(domain, parts));
		const webCrypto = new Uint8Array(await crypto.subtle.digest("SHA-256", frame(domain, parts)));
		expect(hashDomain(domain, ...parts)).toEqual(expected);
		expect(expected).toEqual(webCrypto);
	});

	it("rule 8 — typed-array vectors are big-endian and protocol lint bans Buffer", () => {
		const eslintConfig = readFileSync(new URL("../../../eslint.config.mjs", import.meta.url), "utf8");
		expect(registry.endianness).toBe("big-endian");
		expect(eslintConfig).toMatch(/name: "Buffer"/);
		expect(toHex(encodeCanonical(Int32Array.of(0x01020304)))).toBe("0d0101020304");
		expect(toHex(encodeCanonical(Uint32Array.of(0xf1020304)))).toBe("0e01f1020304");
	});

	it("rule 9 — signer ordering is UTF-8 byte order, independent of localeCompare", () => {
		const signers = ["peerä", "peer_a", "Peer-a", "peer-a", "peer-B"].map((signerId) => ({
			publicKey: signerId,
			signerId,
		}));
		const expected = [...signers].sort((left, right) =>
			Buffer.compare(Buffer.from(left.signerId, "utf8"), Buffer.from(right.signerId, "utf8"))
		);
		expect(signerSetBytes(signers)).toEqual(signerSetBytes(expected));
	});

	it("rule 10 — protocol limits count UTF-16 units at the 1024/1025 boundary", () => {
		const exactly1024Units = "😀".repeat(512);
		const overLimit = `${exactly1024Units}a`;
		expect(exactly1024Units.length).toBe(1024);
		expect(overLimit.length).toBe(1025);
		expect(validateProtocolString(exactly1024Units, 1024)).toBe(exactly1024Units);
		expect(() => validateProtocolString(overLimit, 1024)).toThrowError(/1024/);
	});
});
