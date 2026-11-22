import { describe, expect, it, vi } from "vitest";

import { encodeGenerationRecordV1, encodeHeadRecordV1 } from "../src/codecs.js";
import {
	boundedRecoveryRoleReadSteps,
	boundedRetirementAdmissionSteps,
	createBoundedRecoveryRoleRead,
	type RetirementAdmissionRequest,
} from "../src/internal/bounded-read.js";
import {
	type AheRetirementControl,
	decodeAheRetirementControl,
	encodeAheRetirementControl,
} from "../src/retirement-control.js";
import { AHE_BOUNDED_READ_LIMITS } from "../src/types.js";
import { digestBlob, digestClosure, parseGenerationId, parseHeadRevision, parseStorageObjectId } from "../src/values.js";

// Count actual codec work underneath every storage entry point. These are the
// operations the continued-play maintenance profile attributes to the codec.
const work = vi.hoisted(() => ({ encode: 0, decode: 0, hash: 0 }));
vi.mock("@ts-drp/canonical", async (importOriginal) => {
	const original = await importOriginal<typeof import("@ts-drp/canonical")>();
	return {
		...original,
		encodeCanonical: (...args: Parameters<typeof original.encodeCanonical>) => {
			work.encode++;
			return original.encodeCanonical(...args);
		},
		decodeCanonical: (...args: Parameters<typeof original.decodeCanonical>) => {
			work.decode++;
			return original.decodeCanonical(...args);
		},
		hashDomain: (...args: Parameters<typeof original.hashDomain>) => {
			work.hash++;
			return original.hashDomain(...args);
		},
	};
});
vi.mock("@ts-drp/canonical/exact", async (importOriginal) => {
	const original = await importOriginal<typeof import("@ts-drp/canonical/exact")>();
	return {
		...original,
		decodeCanonicalExactness: (...args: Parameters<typeof original.decodeCanonicalExactness>) => {
			work.decode++;
			return original.decodeCanonicalExactness(...args);
		},
	};
});

function reset(): void {
	work.encode = 0;
	work.decode = 0;
	work.hash = 0;
}
function snapshot(): Readonly<{ encode: number; decode: number; hash: number }> {
	return { ...work };
}
const must = <T>(value: { ok: true; value: T } | { ok: false }): T => {
	if (!value.ok) throw Error("fixture refused");
	return value.value;
};

let fixtureSeed = 0;
// Controlled native responses drive the real storage algorithms; SQLite and
// IndexedDB fixtures separately establish native transaction behavior.
function nativeImage(count: number) {
	const seed = ++fixtureSeed;
	const objectId = must(parseStorageObjectId(`creator:${seed.toString(16).padStart(32, "0")}`)),
		blobs = Array.from({ length: count }, (_, index) => {
			const bytes = new Uint8Array(4096);
			for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + index * 7 + seed) & 0xff;
			return bytes;
		}),
		byDigest = new Map(blobs.map((raw) => [must(digestBlob(raw)), raw])),
		closure = [...byDigest]
			.map(([digest, raw]) => ({ digest, byteLength: raw.byteLength }))
			.sort((a, b) => a.digest.localeCompare(b.digest)),
		generations = Array.from({ length: Math.ceil(count / 7) }, (_, index) => {
			const refs = closure.slice(index * 7, (index + 1) * 7);
			return {
				objectId,
				generationId: must(parseGenerationId((index + 1 + seed * 16).toString(16).padStart(64, "0"))),
				closure: refs,
				closureDigest: must(digestClosure(refs)),
				state: index === Math.ceil(count / 7) - 1 ? ("Adopted" as const) : ("Superseded" as const),
				baseExpectedHead: { kind: "none" as const, objectId },
			};
		}),
		last = generations.at(-1)!,
		head = {
			kind: "present" as const,
			objectId,
			generationId: last.generationId,
			closureDigest: last.closureDigest,
			revision: must(parseHeadRevision(1)),
		};
	const records = new Map(generations.map((row) => [row.generationId, encodeGenerationRecordV1(row)]));
	const headRecord = encodeHeadRecordV1(head);
	function drive<T>(steps: Generator<RetirementAdmissionRequest, T, unknown>): T {
		let step = steps.next();
		while (!step.done) {
			const request = step.value;
			// Every response is a FRESH native carrier, like a SQLite/IDB read.
			const response =
				request.kind === "head"
					? { objectId, record: headRecord.slice() }
					: request.kind === "keys"
						? generations.map((row) => row.generationId)
						: request.kind === "generation"
							? { objectId, generationId: request.generationId, record: records.get(request.generationId)!.slice() }
							: request.kind === "promotions"
								? generations.flatMap((row) =>
										row.closure.map((ref) => ({ generationId: row.generationId, digest: ref.digest }))
									)
								: request.kind === "promotion" ||
									  request.kind === "blob-preflight" ||
									  request.kind === "blob-census-preflight"
									? true
									: (byDigest.get(request.digest)?.slice() ?? null);
			step = steps.next(response);
		}
		return step.value;
	}
	return { objectId, blobs, byDigest, generations, records, drive };
}

function control(objectId: string, revision: number): AheRetirementControl {
	const domain = (bit: number) =>
		[bit, new Uint8Array(32).fill(bit), new Uint8Array(32), 0, new Uint8Array(32), new Uint8Array(32), 0] as const;
	return {
		kind: "ahe-retirement-control-3",
		objectId,
		incarnation: "a".repeat(64),
		revision,
		sequence: 1,
		completed: {
			throughEpoch: 4,
			decisionDigest: "b".repeat(64),
			snapshotHoles: [],
			generationHoles: [],
			sourceProofDigest: "c".repeat(64),
			generationIdentities: [],
			domains: Array.from({ length: 8 }, (_, i) => domain(2 ** i)),
		},
		active: null,
		binding: null,
		nominee: null,
	} as unknown as AheRetirementControl;
}

describe("verify-once maintenance work", () => {
	it("control admission: steady-state native image admission re-encodes and re-hashes nothing it already verified", () => {
		const image = nativeImage(14);
		const first = must(image.drive(boundedRetirementAdmissionSteps(image.objectId, 900, false)));
		reset();
		const second = must(image.drive(boundedRetirementAdmissionSteps(image.objectId, 900, false)));
		const counts = snapshot();
		console.info("control admission steady-state work", counts);
		expect(second).toEqual(first);
		// 2 generations, 14 promotions, 14 blobs: the original admission
		// re-encodes every row frame, the image and each identity, re-decodes
		// every generation record and re-hashes every blob, record and identity.
		expect(counts).toEqual({ encode: 0, decode: 0, hash: 0 });
	});

	it("control admission still observes every native byte change after warming", () => {
		const image = nativeImage(7);
		const warm = must(image.drive(boundedRetirementAdmissionSteps(image.objectId, 900, false)));
		// Same-length in-place blob corruption: the same digest key, different bytes.
		const victim = image.blobs[3]!;
		victim[victim.length >>> 1] ^= 1;
		expect(image.drive(boundedRetirementAdmissionSteps(image.objectId, 900, false))).toEqual({
			ok: false,
			reason: "BLOB_CORRUPT",
		});
		victim[victim.length >>> 1] ^= 1;
		expect(must(image.drive(boundedRetirementAdmissionSteps(image.objectId, 900, false)))).toEqual(warm);
		// Same-length generation record rewrite (Superseded -> Discarded is not
		// same length, so flip a closure-digest nibble): exact refusal, not a hit.
		const generationId = image.generations[0]!.generationId,
			record = image.records.get(generationId)!,
			original = record.slice(),
			position = record.lastIndexOf(0x61 /* "a"..."f" digit in a digest */);
		if (position >= 0) {
			record[position] = record[position] === 0x61 ? 0x62 : 0x61;
			expect(image.drive(boundedRetirementAdmissionSteps(image.objectId, 900, false)).ok).toBe(false);
			record.set(original);
		}
		expect(must(image.drive(boundedRetirementAdmissionSteps(image.objectId, 900, false)))).toEqual(warm);
	});

	it("control decode: re-decoding identical control bytes neither decodes nor re-encodes again", () => {
		const bytes = encodeAheRetirementControl(control(`creator:${"e".repeat(32)}`, 7));
		const first = must(decodeAheRetirementControl(bytes));
		reset();
		const second = must(decodeAheRetirementControl(bytes.slice()));
		const counts = snapshot();
		console.info("control decode steady-state work", counts);
		expect(second).toEqual(first);
		expect(second).not.toBe(first);
		// Each decode still returns a detached value whose byte carriers are fresh.
		const domains = (second.completed as unknown as { domains: Uint8Array[][] }).domains;
		domains[0]![1]!.fill(9);
		expect(must(decodeAheRetirementControl(bytes))).toEqual(first);
		expect(counts).toEqual({ encode: 0, decode: 0, hash: 0 });
	});

	it("control decode refuses or re-verifies byte-different input after warming", () => {
		const objectId = `creator:${"f".repeat(32)}`;
		const bytes = encodeAheRetirementControl(control(objectId, 7));
		must(decodeAheRetirementControl(bytes));
		const next = encodeAheRetirementControl(control(objectId, 8));
		expect(next.byteLength).toBe(bytes.byteLength);
		expect(must(decodeAheRetirementControl(next)).revision).toBe(8);
		const corrupt = bytes.slice();
		corrupt[corrupt.length - 1] ^= 0xff;
		expect(decodeAheRetirementControl(corrupt).ok).toBe(false);
		expect(must(decodeAheRetirementControl(bytes)).revision).toBe(7);
	});

	it("baseline-intact check: steady-state role currency hashes no unchanged borrowed or native blob again", async () => {
		const image = nativeImage(14);
		const observation = must(
			image.drive(boundedRecoveryRoleReadSteps({ objectId: image.objectId, limits: AHE_BOUNDED_READ_LIMITS }))
		);
		const reader = createBoundedRecoveryRoleRead(observation, (steps) => Promise.resolve(image.drive(steps)));
		expect(await reader.checkCurrency()).toEqual({ ok: true, value: { kind: "current" } });
		reset();
		expect(await reader.checkCurrency()).toEqual({ ok: true, value: { kind: "current" } });
		const counts = snapshot();
		console.info("baseline-intact currency steady-state work", counts);
		expect(counts).toEqual({ encode: 0, decode: 0, hash: 0 });
		// A borrowed carrier mutated after warming is still refused.
		reader.blobs[2]!.bytes[5] ^= 1;
		expect(await reader.checkCurrency()).toEqual({ ok: false, reason: "READ_STALE_ROLE_VIEW" });
		reader.blobs[2]!.bytes[5] ^= 1;
		expect(await reader.checkCurrency()).toEqual({ ok: true, value: { kind: "current" } });
		await reader.release();
	});

	it("blob digests are content-verified: same-length different bytes never reuse a digest", () => {
		const bytes = new Uint8Array(65536).map((_, i) => (i * 13) & 0xff);
		const digest = must(digestBlob(bytes));
		const changed = bytes.slice();
		changed[40_000] ^= 1;
		expect(must(digestBlob(changed))).not.toBe(digest);
		expect(must(digestBlob(bytes))).toBe(digest);
	});
});
