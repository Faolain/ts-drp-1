import { encodeCanonical } from "@ts-drp/canonical";
import { describe, expect, it, vi } from "vitest";

import { durablePreimageMatchesScopeAndSequence } from "../src/contract.js";
import {
	decodeDurableIssuancePreimage,
	issuanceRetirementImage,
	type IssuanceRetirementRows,
} from "../src/retirement.js";
import { d109bCommit } from "../../../tests/fixtures/phase-6b/issuance-retention-contract.js";

// Verify-once contract for durable issuance preimages. Every durable read (image,
// census, retention, prune, copy) re-checks the scope, ordinal and epoch inside each
// issued row's immutable canonical preimage. Only those scalars are read, and they are
// a pure function of the exact preimage bytes: byte-identical preimages need decoding
// once, every other byte string is decoded and judged on its own.
const work = vi.hoisted(() => ({ decode: 0 }));
vi.mock("@ts-drp/canonical", async (importOriginal) => {
	const original = await importOriginal<typeof import("@ts-drp/canonical")>();
	return {
		...original,
		decodeCanonical: (...args: Parameters<typeof original.decodeCanonical>) => {
			work.decode++;
			return original.decodeCanonical(...args);
		},
	};
});
function decodes(operation: () => void): number {
	work.decode = 0;
	operation();
	return work.decode;
}

let fixtureSeed = 0;
// Fresh bytes per test: the process-wide memo is never cleared between tests.
function scope(): Readonly<{ objectId: string; author: string }> {
	return { objectId: `preimage-room-${++fixtureSeed}`, author: `writer-${fixtureSeed}` };
}
function preimage(owner: Readonly<{ objectId: string; author: string }>, authorSequence: number, epoch: number): Uint8Array {
	return encodeCanonical({ author: owner.author, authorSequence, epoch, kind: "drp-vertex", objectId: owner.objectId,
		protocolMajor: 3 });
}
function rows(owner: Readonly<{ objectId: string; author: string }>, count: number): IssuanceRetirementRows {
	const commits = Array.from({ length: count }, (_, sequence) => d109bCommit(owner, sequence, sequence));
	return {
		lineages: [{ ...owner, next: count, exhausted: false, prunedThroughAuthorSequence: null }],
		issued: commits.map((commit) => ({ ...owner, authorSequence: commit.authorSequence, ...commit.envelope })),
		outbox: commits.map((commit) => ({ ...owner, authorSequence: commit.authorSequence,
			digest: commit.envelope.digest, publishState: "published" as const })),
		plans: [],
	};
}

describe("durable preimage verify-once work counts", () => {
	it("decodes each issued preimage once across repeated retirement images", () => {
		const owner = scope(), source = rows(owner, 8);
		const first = issuanceRetirementImage(source, owner.objectId);
		const repeated = decodes(() => {
			for (let read = 0; read < 6; read++) expect(issuanceRetirementImage(source, owner.objectId)).toEqual(first);
		});
		console.info("six repeated images of 8 issued rows: preimage decodes", repeated);
		expect(repeated).toBe(0);
	});

	it("shares one decode between the ordinal check and the epoch read of the same bytes", () => {
		const owner = scope(), bytes = preimage(owner, 3, 2);
		const total = decodes(() => {
			for (let read = 0; read < 6; read++) {
				expect(durablePreimageMatchesScopeAndSequence(bytes, owner, 3)).toBe(true);
				expect(decodeDurableIssuancePreimage(bytes, owner, 3)).toEqual({ epoch: 2 });
			}
		});
		console.info("six matches + six epoch reads of one preimage: decodes", total);
		expect(total).toBe(1);
	});

	it("reuses a verified preimage read through a fresh copy of the same bytes", () => {
		const owner = scope(), bytes = preimage(owner, 1, 1);
		expect(decodeDurableIssuancePreimage(bytes, owner, 1)).toEqual({ epoch: 1 });
		expect(decodes(() => expect(decodeDurableIssuancePreimage(new Uint8Array(bytes), owner, 1)).toEqual({ epoch: 1 })))
			.toBe(0);
	});
});

describe("durable preimage verify-once soundness", () => {
	it("judges each distinct byte string on its own, including same-length neighbours", () => {
		const owner = scope(), first = preimage(owner, 4, 1), second = preimage(owner, 5, 1);
		expect(second.byteLength).toBe(first.byteLength);
		expect(decodeDurableIssuancePreimage(first, owner, 4)).toEqual({ epoch: 1 });
		expect(decodes(() => expect(decodeDurableIssuancePreimage(second, owner, 4)).toBeUndefined())).toBe(1);
		expect(decodeDurableIssuancePreimage(second, owner, 5)).toEqual({ epoch: 1 });
		expect(durablePreimageMatchesScopeAndSequence(first, owner, 5)).toBe(false);
		// The scope is a call argument, never part of the memoized verdict.
		expect(decodeDurableIssuancePreimage(first, { ...owner, author: "someone-else" }, 4)).toBeUndefined();
		expect(durablePreimageMatchesScopeAndSequence(first, { ...owner, objectId: "elsewhere" }, 4)).toBe(false);
	});

	it("never memoizes an undecodable or non-record preimage", () => {
		const owner = scope(), valid = preimage(owner, 2, 2);
		const truncated = valid.subarray(0, valid.byteLength - 1).slice();
		const list = encodeCanonical([owner.author, 2, 2]);
		for (const refused of [truncated, list, new Uint8Array(0)]) {
			const counted = decodes(() => {
				for (let read = 0; read < 3; read++) {
					expect(decodeDurableIssuancePreimage(refused, owner, 2)).toBeUndefined();
					expect(durablePreimageMatchesScopeAndSequence(refused, owner, 2)).toBe(false);
				}
			});
			expect(counted).toBe(6);
		}
		expect(decodeDurableIssuancePreimage(valid, owner, 2)).toEqual({ epoch: 2 });
	});

	it("refuses non-scalar or mistyped header fields exactly as a fresh decode does", () => {
		const owner = scope();
		const variants = [
			{ author: [owner.author], authorSequence: 1, epoch: 1, kind: "drp-vertex", objectId: owner.objectId, protocolMajor: 3 },
			{ author: owner.author, authorSequence: "1", epoch: 1, kind: "drp-vertex", objectId: owner.objectId, protocolMajor: 3 },
			{ author: owner.author, authorSequence: 1, epoch: -1, kind: "drp-vertex", objectId: owner.objectId, protocolMajor: 3 },
			{ author: owner.author, authorSequence: 1, epoch: { n: 1 }, kind: "drp-vertex", objectId: owner.objectId, protocolMajor: 3 },
			{ author: owner.author, authorSequence: 1, epoch: 1, kind: "drp-anchor", objectId: owner.objectId, protocolMajor: 3 },
			{ author: owner.author, authorSequence: 1, epoch: 1, kind: "drp-vertex", objectId: owner.objectId, protocolMajor: 2 },
		];
		for (const variant of variants) {
			const bytes = encodeCanonical(variant);
			for (let read = 0; read < 2; read++) {
				expect(decodeDurableIssuancePreimage(bytes, owner, 1)).toBeUndefined();
				expect(durablePreimageMatchesScopeAndSequence(bytes, owner, 1)).toBe(
					variant.author === owner.author && variant.authorSequence === 1);
			}
		}
	});

	it("never lets a mutated input or result poison a later read", () => {
		const owner = scope(), bytes = preimage(owner, 6, 3), pristine = bytes.slice();
		const first = decodeDurableIssuancePreimage(bytes, owner, 6);
		expect(first).toEqual({ epoch: 3 });
		expect(Object.isFrozen(first)).toBe(true);
		expect(() => {
			(first as { epoch: number }).epoch = 99;
		}).toThrow();
		// Mutate the caller's own carrier in place: an ordinal byte now differs.
		const at = bytes.findIndex((byte, index) => byte !== preimage(owner, 7, 3)[index]);
		bytes.set(preimage(owner, 7, 3).subarray(at, at + 1), at);
		expect(decodes(() => expect(decodeDurableIssuancePreimage(bytes, owner, 6)).toBeUndefined())).toBe(1);
		expect(decodeDurableIssuancePreimage(bytes, owner, 7)).toEqual({ epoch: 3 });
		// The memo kept its own copy of the original bytes, which still verify as before.
		expect(decodes(() => expect(decodeDurableIssuancePreimage(pristine, owner, 6)).toEqual({ epoch: 3 }))).toBe(0);
	});

	it("bounds retained preimages and verifies an evicted one again", () => {
		const owner = scope(), oldest = preimage(owner, 0, 0);
		expect(decodeDurableIssuancePreimage(oldest, owner, 0)).toEqual({ epoch: 0 });
		for (let sequence = 1; sequence <= 1024; sequence++) decodeDurableIssuancePreimage(preimage(owner, sequence, 0), owner, sequence);
		expect(decodes(() => expect(decodeDurableIssuancePreimage(oldest, owner, 0)).toEqual({ epoch: 0 }))).toBe(1);
		// A preimage larger than the whole byte bound is verified but never retained.
		const huge = encodeCanonical({ author: owner.author, authorSequence: 9, epoch: 0, kind: "drp-vertex",
			objectId: owner.objectId, padding: new Uint8Array(4 * 1024 * 1024 + 1), protocolMajor: 3 });
		expect(decodes(() => {
			expect(decodeDurableIssuancePreimage(huge, owner, 9)).toEqual({ epoch: 0 });
			expect(decodeDurableIssuancePreimage(huge, owner, 9)).toEqual({ epoch: 0 });
		})).toBe(2);
		// And it did not evict the recently verified entries to make room.
		expect(decodes(() => expect(decodeDurableIssuancePreimage(oldest, owner, 0)).toEqual({ epoch: 0 }))).toBe(0);
	});
});
