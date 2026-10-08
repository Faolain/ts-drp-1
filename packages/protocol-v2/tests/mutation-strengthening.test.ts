import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2";
import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_ADMISSION_PARAMETERS, makeAdmissionContext } from "./admission-context-fixture.js";
import registry from "../registry/field-registry.json" with { type: "json" };
import {
	type AdmissionHooks,
	admitVertex,
	compareBytes,
	decodeCanonical,
	encodeCanonical,
	hashDomain,
	makeRegistryPreimageBuilder,
	type PreparedAdmissionContext,
	type QcVote,
	quorumCertificateBytes,
	quorumSize,
	type RegistryDocument,
	type RegistryField,
	type SignaturePublicKey,
	type Signer,
	signerSetBytes,
	signIdentityDigest,
	validateProtocolString,
	vertexDigest,
	type VertexInput,
	vertexPreimage,
} from "../src/index.js";
import { protocolRegistry } from "../src/registry.js";

const ZERO_DIGEST = "0".repeat(64);
const ONE_DIGEST = "1".repeat(64);
const ADMISSION_SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const ADMISSION_PUBLIC_KEY: SignaturePublicKey = {
	bytes: ed25519.getPublicKey(ADMISSION_SEED),
	format: "raw",
};

function bytes(hex: string): Uint8Array {
	return Uint8Array.from(Buffer.from(hex, "hex"));
}

function hex(value: Uint8Array): string {
	return Buffer.from(value).toString("hex");
}

function varUint(value: bigint): Uint8Array {
	const output: number[] = [];
	do {
		let byte = Number(value & BigInt(0x7f));
		value >>= BigInt(7);
		if (value !== BigInt(0)) byte |= 0x80;
		output.push(byte);
	} while (value !== BigInt(0));
	return Uint8Array.from(output);
}

function required<T>(value: T | undefined, name: string): T {
	if (value === undefined) throw new Error(`missing test fixture ${name}`);
	return value;
}

describe("mutation-strengthened canonical contract", () => {
	it("pins one independent golden encoding for every canonical type", () => {
		const cases: readonly [unknown, string][] = [
			[null, "00"],
			[false, "01"],
			[true, "02"],
			[0, "0300"],
			[-1, "0301"],
			[1, "0302"],
			[64, "038001"],
			[-65, "038101"],
			[Number.MIN_SAFE_INTEGER, "03fdffffffffffff1f"],
			[1.5, "043ff8000000000000"],
			["A", "050141"],
			["😀", "0504f09f9880"],
			[bytes("00ff"), "060200ff"],
			[[null, true], "07020002"],
			[{ b: 2, a: 1 }, "080205016103020501620304"],
			[
				new Map<unknown, unknown>([
					["a", 1],
					[0, 2],
				]),
				"0902030003040501610302",
			],
			[new Set<unknown>(["a", 0]), "0a020300050161"],
			[Float32Array.of(1.5), "0b013fc00000"],
			[Float64Array.of(1.5), "0c013ff8000000000000"],
			[Int32Array.of(0x01020304), "0d0101020304"],
			[Uint32Array.of(0xf1020304), "0e01f1020304"],
		];

		for (const [value, expected] of cases) {
			const encoded = encodeCanonical(value);
			expect(hex(encoded), expected).toBe(expected);
			expect(encodeCanonical(decodeCanonical(encoded)), expected).toEqual(encoded);
		}
		expect(encodeCanonical(Float64Array.of(-0))).toEqual(encodeCanonical(Float64Array.of(+0)));
	});

	it("pins multi-element typed-array offsets and empty scalar lengths", () => {
		const cases: readonly [unknown, string][] = [
			["", "0500"],
			[new Uint8Array(), "0600"],
			[Float32Array.of(1.5, -2.25), "0b023fc00000c0100000"],
			[Float64Array.of(1.5, -2.25), "0c023ff8000000000000c002000000000000"],
			[Int32Array.of(0x01020304, -2), "0d0201020304fffffffe"],
			[Uint32Array.of(0x01020304, 0xf1020304), "0e0201020304f1020304"],
		];
		for (const [value, expected] of cases) {
			const encoded = encodeCanonical(value);
			expect(hex(encoded), expected).toBe(expected);
			expect(encodeCanonical(decodeCanonical(encoded)), expected).toEqual(encoded);
		}
	});

	it("compares unsigned byte strings lexicographically, including prefix boundaries", () => {
		expect(compareBytes(bytes(""), bytes(""))).toBe(0);
		expect(compareBytes(bytes("00"), bytes("00"))).toBe(0);
		expect(compareBytes(bytes("00"), bytes("0000"))).toBe(-1);
		expect(compareBytes(bytes("0000"), bytes("00"))).toBe(1);
		expect(compareBytes(bytes("00ff"), bytes("0100"))).toBe(-1);
		expect(compareBytes(bytes("ff"), bytes("00"))).toBe(1);
	});

	it("accepts paired surrogate endpoints and rejects every unpaired endpoint", () => {
		for (const value of ["\ud800\udc00", "\udbff\udfff"]) {
			expect(decodeCanonical(encodeCanonical(value))).toBe(value);
		}
		for (const value of ["\ud800", "\udbff", "\udc00", "\udfff", "\ud800A", "\udbffA"]) {
			expect(() => encodeCanonical(value), JSON.stringify(value)).toThrow(/unpaired surrogate/);
		}
		for (const value of ["\ue000", "\ue000\udc00", "\ud800\ue000"]) {
			if (value === "\ue000") expect(decodeCanonical(encodeCanonical(value))).toBe(value);
			else expect(() => encodeCanonical(value), JSON.stringify(value)).toThrow(/unpaired surrogate/);
		}
	});

	it("rejects every unsupported or ambiguous JavaScript value family", () => {
		const cyclic: unknown[] = [];
		cyclic.push(cyclic);
		const sparse = new Array(1);
		const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => 1 });
		const hidden = Object.defineProperty({ visible: 1 }, "hidden", { enumerable: false, value: 2 });
		const symbolKey = { value: 1 };
		Object.defineProperty(symbolKey, Symbol("hidden"), { enumerable: true, value: 2 });
		class Message {
			public value = 1;
		}
		const unsupported = [
			undefined,
			BigInt(1),
			Symbol("x"),
			(): undefined => undefined,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			Number.MAX_SAFE_INTEGER + 1,
			cyclic,
			sparse,
			accessor,
			symbolKey,
			new Message(),
			new ArrayBuffer(1),
			new DataView(new ArrayBuffer(1)),
			new Date(0),
			/x/u,
		];
		for (const value of unsupported) expect(() => encodeCanonical(value), String(value)).toThrow();
		expect(() => encodeCanonical(cyclic)).toThrow(/cyclic values/);
		expect(() => encodeCanonical(symbolKey)).toThrow(/symbol keys/);
		expect(() => encodeCanonical(accessor)).toThrow(/accessor property value/);
		expect(decodeCanonical(encodeCanonical(hidden))).toEqual({ visible: 1 });
		expect(() => encodeCanonical(Float32Array.of(Number.NaN))).toThrow(/typed arrays cannot contain NaN or Infinity/);
		expect(() => encodeCanonical(Float64Array.of(Number.POSITIVE_INFINITY))).toThrow(
			/typed arrays cannot contain NaN or Infinity/
		);
	});

	it("enforces exact encode limits and rejects duplicate canonical Map/Set values", () => {
		expect(hex(encodeCanonical("a", { maxBytes: 3 }))).toBe("050161");
		expect(() => encodeCanonical("x".repeat(257))).not.toThrow();
		expect(() => encodeCanonical("a", { maxBytes: 2 })).toThrow(/byte limit/);
		expect(() => encodeCanonical("a", { maxBytes: 1 })).toThrow(/canonical value exceeds byte limit/);
		expect(() => encodeCanonical("aa", { maxBytes: 1 })).toThrow(/string exceeds byte limit/);
		expect(() => encodeCanonical([0], { maxItems: 0 })).toThrow(/item limit/);
		expect(encodeCanonical([], { maxItems: 0 })).toEqual(bytes("0700"));
		expect(() => encodeCanonical([[0]], { maxDepth: 1 })).toThrow(/nesting depth/);
		expect(encodeCanonical([0], { maxDepth: 1 })).toEqual(bytes("07010300"));
		let defaultDepth: unknown = 0;
		for (let depth = 0; depth <= 128; depth++) defaultDepth = [defaultDepth];
		expect(() => encodeCanonical(defaultDepth)).toThrow(/nesting depth/);
		expect(() => encodeCanonical(new Map([[0, 0]]), { maxItems: 0 })).toThrow(/map exceeds item limit/);
		expect(encodeCanonical(new Map(), { maxItems: 0 })).toEqual(bytes("0900"));
		expect(() => encodeCanonical(new Set([0]), { maxItems: 0 })).toThrow(/set exceeds item limit/);
		expect(encodeCanonical(new Set(), { maxItems: 0 })).toEqual(bytes("0a00"));

		const left = {};
		const right = Object.create(null) as Record<string, never>;
		expect(() =>
			encodeCanonical(
				new Map<unknown, unknown>([
					[left, 1],
					[right, 2],
				])
			)
		).toThrow(/duplicate/);
		expect(() => encodeCanonical(new Set<unknown>([left, right]))).toThrow(/duplicate/);
		const shared = { value: 1 };
		expect(() => encodeCanonical([shared, shared])).not.toThrow();

		for (const nested of [
			new Map<unknown, unknown>([[[[0]], 0]]),
			new Map<unknown, unknown>([[0, [[0]]]]),
			new Set<unknown>([[[0]]]),
			{ value: [[0]] },
		]) {
			expect(() => encodeCanonical(nested, { maxDepth: 2 })).toThrow(/nesting depth/);
		}
	});

	it("rejects malformed scalar encodings at every canonical boundary", () => {
		const unsafeInteger = new Uint8Array([0x03, ...varUint(BigInt(Number.MAX_SAFE_INTEGER) * BigInt(2) + BigInt(2))]);
		const invalid = [
			bytes(""),
			bytes("00ff"),
			bytes("0f"),
			bytes("0501"),
			bytes("058000"),
			new Uint8Array([0x05, ...Array<number>(10).fill(0x80)]),
			unsafeInteger,
			bytes("0501ff"),
			bytes("047ff8000000000000"),
			bytes("047ff0000000000000"),
			bytes("048000000000000000"),
			bytes("043ff0000000000000"),
		];
		for (const encoded of invalid) expect(() => decodeCanonical(encoded), hex(encoded)).toThrow();
	});

	it("rejects malformed collections, ordering, typed arrays, and decode limits", () => {
		const invalid = [
			bytes("0a0203020300"), // descending Set values
			bytes("0a0203000300"), // duplicate Set values
			bytes("090205016203000501610302"), // descending Map keys
			bytes("090205016103000501610302"), // duplicate Map keys
			bytes("080103000300"), // non-string object key
			bytes("0b0180000000"), // Float32 -0
			bytes("0b017f800000"), // Float32 +Infinity
			bytes("0c018000000000000000"), // Float64Array -0
			bytes("0c017ff0000000000000"), // Float64Array +Infinity
			bytes("0d01ff"), // truncated typed array
		];
		for (const encoded of invalid) expect(() => decodeCanonical(encoded), hex(encoded)).toThrow();

		expect(() => decodeCanonical(bytes("07010300"), { maxItems: 1 })).toThrow(/item limit/);
		expect(() => decodeCanonical(bytes("070107010300"), { maxDepth: 1 })).toThrow(/nesting depth/);
		expect(() => decodeCanonical(bytes("060100"), { maxBytes: 2 })).toThrow(/byte limit/);
		expect(decodeCanonical(bytes("060100"), { maxBytes: 3 })).toEqual(bytes("00"));
		expect(decodeCanonical(bytes("00"), { maxItems: 1 })).toBeNull();
		expect(() => decodeCanonical(bytes("00"), { maxItems: 0 })).toThrow(/item limit/);
		const encodedMap = encodeCanonical(new Map([[0, 0]]));
		expect(() => decodeCanonical(encodedMap, { maxItems: 4 })).toThrow(/item limit/);
		expect(() => decodeCanonical(encodedMap, { maxItems: 5 })).not.toThrow();
		expect(() => decodeCanonical(bytes("07010300"), { maxDepth: 1 })).not.toThrow();
		for (const nested of [
			new Map<unknown, unknown>([[[[0]], 0]]),
			new Map<unknown, unknown>([[0, [[0]]]]),
			new Set<unknown>([[[0]]]),
			{ value: [[0]] },
		]) {
			expect(() => decodeCanonical(encodeCanonical(nested), { maxDepth: 2 })).toThrow(/nesting depth/);
		}

		const unsafeNegative = new Uint8Array([0x03, ...varUint(BigInt(Number.MAX_SAFE_INTEGER) * BigInt(2) + BigInt(1))]);
		expect(() => decodeCanonical(unsafeNegative)).toThrow(/integer exceeds safe range/);
	});

	it("preserves the registered canonical rejection reasons", () => {
		const encodeFailures: readonly [unknown, RegExp][] = [
			[Number.NaN, /NaN and Infinity/],
			[Number.MAX_SAFE_INTEGER + 1, /safe range/],
			[undefined, /undefined is outside/],
			[new Uint8Array([0]).buffer, /explicit protocol codec/],
			[new Array(1), /sparse arrays/],
			[
				new (class Message {
					public marker = true;
				})(),
				/class instances/,
			],
		];
		for (const [value, reason] of encodeFailures) expect(() => encodeCanonical(value)).toThrow(reason);

		const decodeFailures: readonly [string, RegExp][] = [
			["04", /truncated canonical value/],
			["058000", /non-minimal varuint/],
			[`05${"80".repeat(10)}`, /varuint exceeds safe range/],
			[`05${"80".repeat(8)}01`, /varuint exceeds safe range/],
			["0a0203020300", /canonical order or are duplicated/],
			["090205016203000501610302", /map\/object keys are not in canonical order or are duplicated/],
			["080103000300", /object key must be a string/],
			["0b017f800000", /non-finite number/],
			["0b0180000000", /negative zero/],
			["047ff0000000000000", /non-finite float/],
			["048000000000000000", /negative zero/],
			["043ff0000000000000", /integral float/],
			["0501ff", /invalid UTF-8/],
			["0f", /unknown canonical tag 0x0f/],
			["00ff", /trailing bytes/],
		];
		for (const [encoded, reason] of decodeFailures) expect(() => decodeCanonical(bytes(encoded))).toThrow(reason);
	});
});

describe("mutation-strengthened registry and protocol contract", () => {
	it("builds constants, required fields, optional fields, and registry order exactly", () => {
		const document = {
			registryVersion: 1,
			domains: { probe: "ts-drp/probe/v2" },
			quorum: { q: "ceil(2*n/3)", f: "floor((n-1)/3)", callerSuppliedMaxByzantine: false },
			kinds: {
				probe: {
					domain: "ts-drp/probe/v2",
					encoding: "canonical",
					fields: [
						{ name: "constant", type: "string", const: "fixed", constraints: {}, required: true, sortRule: null },
						{ name: "required", type: "string", const: null, constraints: {}, required: true, sortRule: null },
						{ name: "optional", type: "string", const: null, constraints: {}, required: false, sortRule: null },
					],
				},
			},
		} satisfies RegistryDocument;
		const build = makeRegistryPreimageBuilder(document, "probe");

		expect(build({ required: "yes" })).toEqual({ constant: "fixed", required: "yes" });
		expect(Object.keys(build({ optional: "later", required: "yes" }))).toEqual(["constant", "required", "optional"]);
		expect(() => build({})).toThrow(/missing required.*required/);
		expect(() => build({ constant: "wrong", required: "yes" })).toThrow(/constant/);
		expect(() => build({ required: "yes", unknown: true })).toThrow(/unknown field/);
		expect(() => makeRegistryPreimageBuilder(document, "missing")).toThrow(/unknown registry kind/);
		expect(Object.keys(build({ required: "yes" }))).not.toContain("optional");

		const undefinedConstant = structuredClone(document) as {
			kinds: { probe: { fields: Array<Record<string, unknown>> } };
		};
		delete required(undefinedConstant.kinds.probe.fields[0], "constant field").const;
		expect(() =>
			makeRegistryPreimageBuilder(
				undefinedConstant as unknown as RegistryDocument,
				"probe"
			)({
				constant: "caller-value",
				required: "yes",
			})
		).not.toThrow();
		delete required(undefinedConstant.kinds.probe.fields[2], "optional field").const;
		expect(
			Object.keys(
				makeRegistryPreimageBuilder(
					undefinedConstant as unknown as RegistryDocument,
					"probe"
				)({
					constant: "caller-value",
					required: "yes",
				})
			)
		).not.toContain("optional");
	});

	it("applies codepoint sortRule to strings and signer objects, and only when registered", () => {
		const field = (name: string, sortRule: string | null): RegistryField => ({
			name,
			type: "array<canonical-value>",
			const: null,
			constraints: {},
			required: true,
			sortRule,
		});
		const document = {
			registryVersion: 1,
			domains: { probe: "ts-drp/probe/v2" },
			quorum: { q: "ceil(2*n/3)", f: "floor((n-1)/3)", callerSuppliedMaxByzantine: false },
			kinds: {
				probe: {
					domain: "ts-drp/probe/v2",
					encoding: "canonical",
					fields: [field("strings", "codepoint"), field("signers", "codepoint"), field("untouched", null)],
				},
			},
		} satisfies RegistryDocument;
		const build = makeRegistryPreimageBuilder(document, "probe");
		const output = build({
			strings: ["ä", "A", "_"],
			signers: [{ signerId: "ä" }, { signerId: "A" }, { signerId: "_" }],
			untouched: ["z", "a"],
		});
		expect(output.strings).toEqual(["A", "_", "ä"]);
		expect(output.signers).toEqual([{ signerId: "A" }, { signerId: "_" }, { signerId: "ä" }]);
		expect(output.untouched).toEqual(["z", "a"]);
		expect(() =>
			makeRegistryPreimageBuilder(document, "probe")({ strings: "scalar", signers: [], untouched: [] })
		).toThrow(/must be an array/);
		expect(() => build({ strings: [1, 2], signers: [], untouched: [] })).toThrow(/codepoint-sortable/);
		expect(() => build({ strings: [], signers: [{ signerId: 1 }, { signerId: 2 }], untouched: [] })).toThrow(
			/codepoint-sortable/
		);
		for (const invalid of [
			["a", 1],
			[1, "a"],
			[null, { signerId: "a" }],
			[{ signerId: "a" }, null],
			[{}, { signerId: "a" }],
			[{ signerId: "a" }, {}],
			[{ signerId: 1 }, { signerId: "a" }],
			[{ signerId: "a" }, { signerId: 1 }],
		]) {
			expect(() => build({ strings: invalid, signers: [], untouched: [] })).toThrow(/codepoint-sortable/);
		}
	});

	it("pins hash framing for empty and non-empty domains and parts", () => {
		const frame = (domain: string, parts: readonly Uint8Array[]): Uint8Array => {
			const domainBytes = new TextEncoder().encode(domain);
			const domainLength = new Uint8Array(4);
			new DataView(domainLength.buffer).setUint32(0, domainBytes.byteLength, false);
			const chunks = [bytes("44525000"), domainLength, domainBytes];
			for (const part of parts) {
				const length = new Uint8Array(8);
				new DataView(length.buffer).setBigUint64(0, BigInt(part.byteLength), false);
				chunks.push(length, part);
			}
			return Uint8Array.from(chunks.flatMap((part) => [...part]));
		};
		for (const [domain, parts] of [
			["", []],
			["ts-drp/test/v2", [new Uint8Array()]],
			["é", [bytes("00"), bytes("ff00")]],
		] as const) {
			expect(hashDomain(domain, ...parts)).toEqual(sha256(frame(domain, parts)));
		}
	});

	it("validates protocol strings and signer boundaries independently", () => {
		expect(validateProtocolString("a", 1)).toBe("a");
		for (const [value, limit] of [
			["", 1],
			["a", 0],
			["a", -1],
			["a", 1.5],
			["a", Number.NaN],
		] as const) {
			expect(() => validateProtocolString(value, limit)).toThrow(/protocol string/);
		}
		expect(() => validateProtocolString(1 as unknown as string, 1)).toThrow(/protocol string/);

		const allowed = ["peer\u0020", "peer\u007e", "peer\u00a0"].map((signerId) => ({ publicKey: "pk", signerId }));
		expect(() => signerSetBytes(allowed)).not.toThrow();
		for (const code of [0x00, 0x1f, 0x7f, 0x9f]) {
			expect(() => signerSetBytes([{ publicKey: "pk", signerId: `peer${String.fromCharCode(code)}` }])).toThrow(
				/control character/
			);
		}
	});

	it("validates and canonicalizes signer sets including duplicates and public keys", () => {
		const signers: Signer[] = [
			{ signerId: "b", publicKey: "pk-b" },
			{ signerId: "a", publicKey: "pk-a" },
		];
		expect(decodeCanonical(signerSetBytes(signers))).toEqual([
			{ publicKey: "pk-a", signerId: "a" },
			{ publicKey: "pk-b", signerId: "b" },
		]);
		expect(() => signerSetBytes("not-array" as unknown as Signer[])).toThrow(/array/);
		expect(() => signerSetBytes([{ signerId: "", publicKey: "pk" }])).toThrow(/signerId|protocol string/);
		expect(() => signerSetBytes([{ signerId: "a", publicKey: 1 as unknown as string }])).toThrow(/publicKey/);
		expect(() =>
			signerSetBytes([
				{ signerId: "a", publicKey: "1" },
				{ signerId: "a", publicKey: "2" },
			])
		).toThrow(/duplicate/);
	});

	it("validates and canonicalizes every QC field and vote ordering", () => {
		const vote = (signerId: string): QcVote => ({
			objectId: "room",
			epoch: 1,
			round: 2,
			phase: "prepare",
			proposalDigest: ZERO_DIGEST,
			proposalHash: ONE_DIGEST,
			signerId,
			signature: `sig-${signerId}`,
		});
		const certificate = {
			objectId: "room",
			epoch: 1,
			round: 2,
			phase: "prepare" as const,
			proposalDigest: ZERO_DIGEST,
			proposalHash: ONE_DIGEST,
			votes: [vote("b"), vote("a")],
		};
		const decoded = decodeCanonical(quorumCertificateBytes(certificate)) as Record<string, unknown>;
		expect((decoded.votes as Record<string, unknown>[]).map(({ signerId }) => signerId)).toEqual(["a", "b"]);
		expect(() => quorumCertificateBytes({ ...certificate, votes: [vote("a"), vote("a")] })).toThrow(/duplicate/);
		expect(() => quorumCertificateBytes({ ...certificate, votes: [vote("a"), vote("b"), vote("a")] })).toThrow(
			/duplicate/
		);
		expect(() =>
			quorumCertificateBytes({ ...certificate, votes: [{ ...vote("a"), signature: 1 as unknown as string }] })
		).toThrow(/signature/);
		expect(() => quorumCertificateBytes({ ...certificate, epoch: -1 })).toThrow(/epoch/);
		expect(() => quorumCertificateBytes({ ...certificate, epoch: 1.5 })).toThrow(/epoch/);
		expect(() => quorumCertificateBytes({ ...certificate, round: -1 })).toThrow(/round/);
		expect(() => quorumCertificateBytes({ ...certificate, objectId: "" })).toThrow(/protocol string/);
		expect(() => quorumCertificateBytes({ ...certificate, proposalDigest: "x" })).toThrow(/proposalDigest/);
		expect(() => quorumCertificateBytes({ ...certificate, proposalHash: "x" })).toThrow(/proposalHash/);
		expect(() => quorumCertificateBytes({ ...certificate, votes: [{ ...vote("a"), epoch: -1 }] })).toThrow(/epoch/);
		expect(() => quorumCertificateBytes({ ...certificate, votes: [{ ...vote("a"), round: -1 }] })).toThrow(/round/);
		expect(() => quorumCertificateBytes({ ...certificate, votes: [{ ...vote("a"), proposalDigest: "x" }] })).toThrow(
			/proposalDigest/
		);
		expect(() => quorumCertificateBytes({ ...certificate, votes: [{ ...vote("a"), proposalHash: "x" }] })).toThrow(
			/proposalHash/
		);
		expect(() => quorumCertificateBytes({ ...certificate, votes: [{ ...vote("a"), signerId: "" }] })).toThrow(
			/signerId|protocol string/
		);
	});

	it("validates and canonicalizes every vertex field and dependency order", () => {
		const input: VertexInput = {
			protocolMajor: 2,
			objectId: "room",
			epoch: 0,
			anchor: ZERO_DIGEST,
			author: "peer",
			logicalTime: 1,
			dependencies: [ONE_DIGEST, ZERO_DIGEST],
			operation: { op: "set" },
		};
		const preimage = vertexPreimage(input);
		expect(Object.keys(preimage)).toEqual(registry.kinds.vertex.fields.map(({ name }) => name));
		expect(preimage.dependencies).toEqual([ZERO_DIGEST, ONE_DIGEST]);
		expect(preimage.protocolMajor).toBe(2);
		expect(() => vertexPreimage({ ...input, dependencies: [] })).toThrow(/at least one/);
		expect(() => vertexPreimage({ ...input, dependencies: [ZERO_DIGEST, ZERO_DIGEST] })).toThrow(/duplicate/);
		expect(() => vertexPreimage({ ...input, dependencies: [ZERO_DIGEST, ONE_DIGEST, ZERO_DIGEST] })).toThrow(
			/duplicate/
		);
		expect(() => vertexPreimage({ ...input, dependencies: ["x"] })).toThrow(/dependency/);
		expect(() => vertexPreimage({ ...input, anchor: "x" })).toThrow(/anchor/);
		for (const invalidDigest of [`x${ZERO_DIGEST}`, `${ZERO_DIGEST}x`, "0", "g".repeat(64)]) {
			expect(() => vertexPreimage({ ...input, anchor: invalidDigest })).toThrow(/anchor/);
		}
		expect(() => vertexPreimage({ ...input, epoch: -1 })).toThrow(/epoch/);
		expect(() => vertexPreimage({ ...input, logicalTime: 0 })).toThrow(/logicalTime/);
		expect(() => vertexPreimage({ ...input, objectId: "" })).toThrow(/protocol string/);
		expect(() => vertexPreimage({ ...input, author: "" })).toThrow(/protocol string/);
		for (const operation of [null, [], "set"]) {
			expect(() => vertexPreimage({ ...input, operation: operation as never })).toThrow(/operation/);
		}
		expect(() => vertexPreimage({ ...input, anchor: BigInt("1".repeat(64)) as unknown as string })).toThrow(/anchor/);
		expect(() => vertexPreimage({ ...input, epoch: Number.NaN })).toThrow(/epoch/);
	});

	it("pins the quorum formula across residues and prevents drift in either registry rule", () => {
		for (let signerCount = 1; signerCount <= 12; signerCount++) {
			expect(quorumSize(signerCount), String(signerCount)).toBe(Math.ceil((2 * signerCount) / 3));
		}
		for (const signerCount of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
			expect(() => quorumSize(signerCount)).toThrow(/positive safe integer/);
		}

		const liveRegistry = protocolRegistry();
		const quorum = liveRegistry.quorum as { callerSuppliedMaxByzantine: boolean; q: string };
		expect(Object.isFrozen(quorum)).toBe(true);
		expect(() => {
			quorum.callerSuppliedMaxByzantine = true;
		}).toThrow(TypeError);
		expect(() => {
			quorum.q = "floor(2*n/3)";
		}).toThrow(TypeError);
	});

	it("prevents either registry sort rule from drifting", () => {
		const liveRegistry = protocolRegistry();
		const signerDefinition = required(liveRegistry.kinds.signerSet, "signerSet kind");
		const signerField = required(signerDefinition.fields[0], "signerSet.signers") as { sortRule: string | null };
		const certificateDefinition = required(liveRegistry.kinds.sealQC, "sealQC kind");
		const votesField = required(
			certificateDefinition.fields.find(({ name }) => name === "votes"),
			"sealQC.votes"
		) as {
			sortRule: string | null;
		};
		expect(Object.isFrozen(signerField)).toBe(true);
		expect(Object.isFrozen(votesField)).toBe(true);
		expect(() => {
			signerField.sortRule = null;
		}).toThrow(TypeError);
		expect(() => {
			votesField.sortRule = null;
		}).toThrow(TypeError);
	});

	it("consults frozen live registry string limits rather than coincidentally equal fallbacks", () => {
		const liveRegistry = protocolRegistry();
		const vertexFields = required(liveRegistry.kinds.vertex, "vertex kind").fields;
		const objectId = required(
			vertexFields.find(({ name }) => name === "objectId"),
			"vertex.objectId"
		);
		const author = required(
			vertexFields.find(({ name }) => name === "author"),
			"vertex.author"
		);
		const signer = required(required(liveRegistry.kinds.signerSet, "signerSet kind").fields[0], "signerSet.signers");
		const input: VertexInput = {
			objectId: "x".repeat(1024),
			epoch: 1,
			anchor: ZERO_DIGEST,
			author: "x".repeat(1024),
			logicalTime: 1,
			dependencies: [ZERO_DIGEST],
			operation: {},
		};
		expect(objectId.constraints.maximumUtf16Units).toBe(1024);
		expect(author.constraints.maximumUtf16Units).toBe(1024);
		expect(signer.constraints.maxSignerIdUtf16Units).toBe(512);
		expect(() => vertexPreimage(input)).not.toThrow();
		expect(() => vertexPreimage({ ...input, objectId: "x".repeat(1025) })).toThrow(/at most 1024/);
		expect(() => vertexPreimage({ ...input, author: "x".repeat(1025) })).toThrow(/at most 1024/);
		expect(() => signerSetBytes([{ signerId: "x".repeat(513), publicKey: "pk" }])).toThrow(/at most 512/);
	});
});

describe("mutation-strengthened admission contract", () => {
	const context: PreparedAdmissionContext = makeAdmissionContext({
		objectId: "room",
		parameters: { ...DEFAULT_ADMISSION_PARAMETERS, maxDependencies: 2 },
	});
	function admissionEnvelope(fields: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
		const digest = vertexDigest(fields as never);
		return {
			...fields,
			hash: hex(digest),
			signature: signIdentityDigest(ADMISSION_SEED, digest),
		};
	}
	const admissionHooks: Omit<AdmissionHooks, "resolveDependencies"> = {
		authorize: () => true,
		isDependencyAccepted: () => true,
		resolveAuthorPublicKey: () => ADMISSION_PUBLIC_KEY,
		validateDeterministicInvariant: () => true,
		validateOperationSchema: () => true,
	};

	const parent = admissionEnvelope({
		kind: "drp-vertex",
		protocolMajor: 2,
		objectId: "room",
		epoch: 4,
		anchor: context.currentAnchor,
		dependencies: [context.currentAnchor],
		author: "peer-a",
		logicalTime: 1,
		operation: { op: "parent" },
	});
	const secondParent = admissionEnvelope({
		kind: "drp-vertex",
		protocolMajor: 2,
		objectId: "room",
		epoch: 4,
		anchor: context.currentAnchor,
		dependencies: [ONE_DIGEST],
		author: "peer-b",
		logicalTime: 1,
		operation: { op: "parent" },
	});
	const valid = admissionEnvelope({
		kind: "drp-vertex",
		protocolMajor: 2,
		objectId: "room",
		epoch: 4,
		anchor: context.currentAnchor,
		dependencies: [parent.hash],
		author: "peer-c",
		logicalTime: 2,
		operation: { op: "child" },
	});

	function run(vertex: unknown): {
		calls: string[];
		result: ReturnType<typeof admitVertex>;
	} {
		const calls: string[] = [];
		const result = admitVertex(vertex as Readonly<Record<string, unknown>>, context, {
			...admissionHooks,
			resolveDependencies: (dependencies) => {
				calls.push(`deps:${dependencies.join(",")}`);
				return dependencies.map((dependency) => {
					if (dependency === parent.hash) return parent;
					if (dependency === secondParent.hash) return secondParent;
					return undefined;
				});
			},
		});
		return { calls, result };
	}

	it("rejects every malformed syntax and exact limit overflow before hooks", () => {
		const cases: readonly [unknown, string, string][] = [
			[null, "terminal", "MALFORMED_VERTEX"],
			["vertex", "terminal", "MALFORMED_VERTEX"],
			[{ ...valid, encodedByteLength: undefined }, "quarantine", "NON_CANONICAL_ENVELOPE"],
			[{ ...valid, encodedByteLength: "1" }, "quarantine", "NON_CANONICAL_ENVELOPE"],
			[{ ...valid, encodedByteLength: 1.5 }, "quarantine", "NON_CANONICAL_ENVELOPE"],
			[{ ...valid, encodedByteLength: -1 }, "quarantine", "NON_CANONICAL_ENVELOPE"],
			[{ ...valid, encodedByteLength: 129 }, "quarantine", "NON_CANONICAL_ENVELOPE"],
			[{ ...valid, dependencies: "digest" }, "quarantine", "NON_CANONICAL_ENVELOPE"],
			[{ ...valid, dependencies: [ZERO_DIGEST, ONE_DIGEST, "2".repeat(64)] }, "terminal", "LIMIT_EXCEEDED"],
			[{ ...valid, dependencies: [ZERO_DIGEST, 1] }, "quarantine", "NON_CANONICAL_ENVELOPE"],
		];
		for (const [vertex, status, code] of cases) {
			const observed = run(vertex);
			expect(observed.result, code).toEqual({ status, code, latchByHash: false });
			expect(observed.calls, code).toEqual([]);
		}
	});

	it("classifies every identity mismatch without hashing", () => {
		const cases: readonly [Readonly<Record<string, unknown>>, string, string][] = [
			[{ ...valid, objectId: "other" }, "terminal", "WRONG_OBJECT"],
			[{ ...valid, protocolMajor: 3 }, "pending", "FUTURE_PROTOCOL"],
			[{ ...valid, protocolMajor: 1 }, "terminal", "LEGACY_PROTOCOL"],
			[{ ...valid, protocolMajor: "2" }, "terminal", "LEGACY_PROTOCOL"],
			[{ ...valid, protocolMajor: "3" }, "terminal", "LEGACY_PROTOCOL"],
			[{ ...valid, epoch: 5 }, "pending", "FUTURE_EPOCH"],
			[{ ...valid, epoch: 3 }, "terminal", "STALE_EPOCH"],
			[{ ...valid, epoch: "4" }, "terminal", "STALE_EPOCH"],
			[{ ...valid, epoch: "5" }, "terminal", "STALE_EPOCH"],
			[{ ...valid, anchor: ONE_DIGEST }, "terminal", "WRONG_ANCHOR"],
		];
		for (const [vertex, status, code] of cases) {
			const observed = run(vertex);
			expect(observed.result, code).toEqual({ status, code, latchByHash: false });
			expect(observed.calls, code).toEqual([]);
		}
	});

	it("rejects callable records at the object syntax gate", () => {
		const callable = Object.assign(() => undefined, valid);
		expect(run(callable)).toEqual({
			result: { status: "terminal", code: "MALFORMED_VERTEX", latchByHash: false },
			calls: [],
		});
	});

	it("accepts exact boundaries and rejects absent dependencies before hashing", () => {
		expect(run(valid).result).toEqual({ status: "accept", code: "ADMISSIBLE", latchByHash: false });
		const dependencyHashes = [parent.hash as string, secondParent.hash as string].sort();
		const twoDependencies = admissionEnvelope({
			...valid,
			dependencies: dependencyHashes,
		});
		expect(run(twoDependencies).calls).toEqual([`deps:${dependencyHashes.join(",")}`]);
		const withoutDependencies = { ...valid } as Record<string, unknown>;
		delete withoutDependencies.dependencies;
		expect(run(withoutDependencies)).toEqual({
			result: { status: "terminal", code: "MISSING_DEPENDENCIES", latchByHash: false },
			calls: [],
		});
	});

	it("never resolves dependencies if hashing fails", () => {
		const resolveDependencies = vi.fn();
		expect(
			admitVertex({ ...valid, hash: ONE_DIGEST }, context, {
				...admissionHooks,
				resolveDependencies,
			})
		).toEqual({ status: "terminal", code: "INVALID_HASH", latchByHash: false });
		expect(resolveDependencies).not.toHaveBeenCalled();
	});
});
