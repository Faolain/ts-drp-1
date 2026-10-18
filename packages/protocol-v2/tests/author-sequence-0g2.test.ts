import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it, vi } from "vitest";

import { makeAdmissionContext } from "./admission-context-fixture.js";
import {
	type AdmissionHooks,
	admitVertex,
	decodeCanonical,
	encodeCanonical,
	signIdentityDigest,
	vertexDigest,
	type VertexInput,
	vertexPreimage,
} from "../src/index.js";
import { protocolRegistry } from "../src/registry.js";

const IDENTITY_DOMAIN = "ts-drp/vertex/v2";
const PRIVATE_KEY_SEED = fromHex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
const PUBLIC_KEY = ed25519.getPublicKey(PRIVATE_KEY_SEED);
const registry = protocolRegistry();
const context = makeAdmissionContext({ objectId: "room-sequence" });

type SequencedVertexInput = VertexInput & {
	readonly authorSequence: number;
};

function fromHex(value: string): Uint8Array {
	return Uint8Array.from(value.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function hex(value: Uint8Array): string {
	return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function input(authorSequence: number): SequencedVertexInput {
	return {
		anchor: context.currentAnchor,
		author: "peer-sequence",
		authorSequence,
		dependencies: [context.currentAnchor],
		epoch: context.currentEpoch,
		logicalTime: 1,
		objectId: context.objectId,
		operation: { action: "append", value: "same-payload" },
		protocolMajor: context.protocolMajor,
	};
}

function signedVertex(authorSequence: number): Readonly<Record<string, unknown>> {
	const fields = input(authorSequence);
	const digest = vertexDigest(fields);
	return Object.freeze({
		...vertexPreimage(fields),
		// Keep the field explicit in RED: the current registry-driven builder silently drops it.
		authorSequence,
		hash: hex(digest),
		signature: signIdentityDigest(PRIVATE_KEY_SEED, digest),
	});
}

function admissionHarness(): {
	readonly hooks: AdmissionHooks;
	readonly resolveAuthorPublicKey: ReturnType<typeof vi.fn>;
} {
	const resolveAuthorPublicKey = vi.fn(() => ({ bytes: PUBLIC_KEY, format: "raw" as const }));
	const hooks: AdmissionHooks = {
		authorize: () => true,
		isDependencyAccepted: () => true,
		resolveAuthorPublicKey,
		resolveDependencies: () => [context.currentEpochAnchor],
		validateDeterministicInvariant: () => true,
		validateOperationSchema: () => true,
	};
	return { hooks, resolveAuthorPublicKey };
}

describe("Phase 0g(ii) authenticated author sequence", () => {
	it("registers one required nonnegative safe-integer field in the signed vertex preimage", () => {
		const fields = registry.kinds.vertex?.fields;
		const sequenceIndex = fields?.findIndex(({ name }) => name === "authorSequence");
		const sequence = fields?.[sequenceIndex ?? -1];

		expect(sequence, "vertex.authorSequence must be frozen before any signed bytes use it").toMatchObject({
			name: "authorSequence",
			type: "safe-integer",
			const: null,
			constraints: { minimum: 0 },
			required: true,
			sortRule: null,
		});
		expect(sequenceIndex, "authorSequence has one registry-selected field position").toBeGreaterThanOrEqual(0);

		const preimage = vertexPreimage(input(0));
		expect(Object.keys(preimage)).toEqual(fields?.map(({ name }) => name));
		expect(preimage.authorSequence).toBe(0);
	});

	it("rejects missing, negative, fractional, and unsafe values at the registry/preimage boundary", () => {
		const valid = input(0);
		const missing = { ...valid } as Record<string, unknown>;
		delete missing.authorSequence;

		expect(() => vertexPreimage(missing as unknown as VertexInput)).toThrow(/authorSequence/);
		for (const authorSequence of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
			expect(
				() => vertexPreimage({ ...valid, authorSequence } as SequencedVertexInput),
				String(authorSequence)
			).toThrow(/authorSequence/);
		}
		expect(vertexPreimage(input(Number.MAX_SAFE_INTEGER)).authorSequence).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("changes signing bytes and digest when only authorSequence changes", () => {
		const sequenceZero = input(0);
		const sequenceOne = { ...sequenceZero, authorSequence: 1, operation: sequenceZero.operation };
		const preimageZero = vertexPreimage(sequenceZero);
		const preimageOne = vertexPreimage(sequenceOne);

		expect(preimageZero).toMatchObject({ authorSequence: 0 });
		expect(preimageOne).toMatchObject({ authorSequence: 1 });
		expect(encodeCanonical(preimageOne)).not.toEqual(encodeCanonical(preimageZero));
		expect(vertexDigest(sequenceOne)).not.toEqual(vertexDigest(sequenceZero));
	});

	it("admits a valid signed sequence and rejects N-to-N+1 tampering at signature authentication", () => {
		const valid = signedVertex(0);
		const validHarness = admissionHarness();

		expect(admitVertex(valid, context, validHarness.hooks)).toEqual({
			status: "accept",
			code: "ADMISSIBLE",
			latchByHash: false,
		});
		expect(validHarness.resolveAuthorPublicKey).toHaveBeenCalledOnce();

		const sequenceOneInput = input(1);
		const tampered = {
			...valid,
			authorSequence: 1,
			hash: hex(vertexDigest(sequenceOneInput)),
			// Deliberately retain the signature over sequence 0.
		};
		const tamperedHarness = admissionHarness();
		expect(admitVertex(tampered, context, tamperedHarness.hooks)).toEqual({
			status: "terminal",
			code: "INVALID_SIGNATURE",
			latchByHash: false,
		});
		expect(tamperedHarness.resolveAuthorPublicKey).toHaveBeenCalledOnce();
	});

	it("fails malformed sequence values before author-key resolution", () => {
		const valid = signedVertex(0);
		const cases: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> = [
			["missing", Object.fromEntries(Object.entries(valid).filter(([name]) => name !== "authorSequence"))],
			["negative", { ...valid, authorSequence: -1 }],
			["fractional", { ...valid, authorSequence: 0.5 }],
			["unsafe", { ...valid, authorSequence: Number.MAX_SAFE_INTEGER + 1 }],
			["wrong-type", { ...valid, authorSequence: "0" }],
		];

		for (const [label, candidate] of cases) {
			const harness = admissionHarness();
			expect(admitVertex(candidate, context, harness.hooks), label).toEqual({
				status: "terminal",
				code: "INVALID_HASH",
				latchByHash: false,
			});
			expect(harness.resolveAuthorPublicKey, label).not.toHaveBeenCalled();
		}
	});

	it("round-trips the exact sequence in canonical preimage wire bytes", () => {
		for (const authorSequence of [0, 1, Number.MAX_SAFE_INTEGER]) {
			const preimage = vertexPreimage(input(authorSequence));
			const canonicalPreimage = encodeCanonical(preimage);
			const decoded = decodeCanonical(canonicalPreimage) as Readonly<Record<string, unknown>>;

			expect(decoded.authorSequence, String(authorSequence)).toBe(authorSequence);
			expect(encodeCanonical(decoded), String(authorSequence)).toEqual(canonicalPreimage);
		}
		const wireFormat = (
			registry as typeof registry & {
				readonly wireFormat: Readonly<Record<string, unknown>>;
			}
		).wireFormat;
		expect(wireFormat).toEqual({
			canonicalPreimage: "bytes",
			signature: "bytes",
			digestVerification: "received-bytes",
			reencodeBeforeDigest: false,
		});
	});

	it("rejects duplicate and non-minimal sequence wire representations at canonical decode", () => {
		const key = "050e617574686f7253657175656e6365";
		const duplicateSequenceKey = fromHex(`0802${key}0300${key}0302`);
		const nonMinimalZero = fromHex(`0801${key}038000`);
		const trailingBytes = Uint8Array.from([...encodeCanonical({ authorSequence: 0 }), 0xff]);

		expect(() => decodeCanonical(duplicateSequenceKey)).toThrow(/canonical order or are duplicated/);
		expect(() => decodeCanonical(nonMinimalZero)).toThrow(/non-minimal varuint/);
		expect(() => decodeCanonical(trailingBytes)).toThrow(/trailing bytes/);
	});

	it("distinguishes an authenticated sequence from a naive unsigned completion-order counter", async () => {
		let releaseFirst!: () => void;
		const firstBarrier = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let tail = Promise.resolve();
		let nextUnsignedSequence = 0;
		const completionOrder: number[] = [];
		const submit = (work: () => Promise<void>): Promise<void> => {
			const current = tail.then(async () => {
				await work();
				completionOrder.push(nextUnsignedSequence++);
			});
			tail = current;
			return current;
		};

		const first = submit(() => firstBarrier);
		const second = submit(() => Promise.resolve());
		await Promise.resolve();
		releaseFirst();
		await Promise.all([first, second]);
		expect(completionOrder, "positive control: a global lane can order completions").toEqual([0, 1]);

		const unsignedZero = input(0);
		const unsignedOne = { ...unsignedZero, authorSequence: 1, operation: unsignedZero.operation };
		const signedBytesZero = encodeCanonical(vertexPreimage(unsignedZero));
		const signedBytesOne = encodeCanonical(vertexPreimage(unsignedOne));
		const digestZero = vertexDigest(unsignedZero);
		const digestOne = vertexDigest(unsignedOne);
		const signatureOverZero = signIdentityDigest(PRIVATE_KEY_SEED, digestZero);
		expect(
			signedBytesOne,
			"a completion-order counter is not the contract unless its value changes the signed canonical bytes"
		).not.toEqual(signedBytesZero);
		expect(digestOne).not.toEqual(digestZero);
		expect(ed25519.verify(signatureOverZero, digestZero, PUBLIC_KEY, { zip215: false })).toBe(true);
		expect(
			ed25519.verify(signatureOverZero, digestOne, PUBLIC_KEY, { zip215: false }),
			"positive completion order cannot compensate for a signature that authenticates no sequence"
		).toBe(false);
	});

	it("uses the existing vertex signature domain for the sequence-bearing digest", () => {
		const fields = input(7);
		const digest = vertexDigest(fields);
		const signature = signIdentityDigest(PRIVATE_KEY_SEED, digest);

		expect(ed25519.verify(signature, digest, PUBLIC_KEY, { zip215: false })).toBe(true);
		expect(IDENTITY_DOMAIN).toBe(registry.domains.vertex);
	});
});
