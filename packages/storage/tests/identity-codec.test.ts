import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { describe, expect, it } from "vitest";

import { bytes, must, noHead, OBJECT_A, record, ref } from "./fixtures.js";
import v2Registry from "../../protocol-v2/registry/field-registry.json" with { type: "json" };
import v3Registry from "../../protocol-v3/registry/registry-v1.json" with { type: "json" };
import {
	decodeGenerationRecordV1,
	decodeHeadRecordV1,
	digestBlob,
	digestClosure,
	encodeGenerationRecordV1,
	encodeHeadRecordV1,
	parseBlobDigest,
	parseClosureDigest,
	parseGenerationId,
	parseHeadRevision,
	parseStorageObjectId,
} from "../src/index.js";

const hex = (value: Uint8Array): string => Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");

describe("Phase 2a nominal identity and digest boundary", () => {
	it("accepts the one canonical creator-bound storage object spelling", () => {
		expect(parseStorageObjectId(`peer-α:${"a".repeat(32)}`)).toMatchObject({ ok: true });
	});

	it.each([
		"legacy-room-id",
		`:${"a".repeat(32)}`,
		`peer:${"A".repeat(32)}`,
		`peer:${"a".repeat(31)}`,
		`peer:extra:${"a".repeat(32)}`,
		`peer\u0000:${"a".repeat(32)}`,
		`peer\ud800:${"a".repeat(32)}`,
		`${"p".repeat(993)}:${"a".repeat(32)}`,
	])("rejects plain, legacy, normalized, or malformed object ID %j", (candidate) => {
		expect(parseStorageObjectId(candidate)).toEqual({ ok: false, reason: "INVALID_ARGUMENT" });
	});

	it.each(["", "a".repeat(63), "A".repeat(64), `${"a".repeat(63)}g`])(
		"rejects non-canonical generation/digest spelling %j",
		(candidate) => {
			expect(parseGenerationId(candidate)).toEqual({ ok: false, reason: "INVALID_ARGUMENT" });
			expect(parseBlobDigest(candidate)).toEqual({ ok: false, reason: "INVALID_ARGUMENT" });
			expect(parseClosureDigest(candidate)).toEqual({ ok: false, reason: "INVALID_ARGUMENT" });
		}
	);

	it.each([0, -1, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 1.5])(
		"rejects sentinel or unsafe head revision %j",
		(candidate) => {
			expect(parseHeadRevision(candidate)).toEqual({ ok: false, reason: "INVALID_ARGUMENT" });
		}
	);

	it("uses distinct storage-only domains and keeps them out of both protocol registries", () => {
		const payload = bytes(1, 2, 3);
		const blob = must(digestBlob(payload));
		const closure = [ref(payload)];
		const closureDigest = must(digestClosure(closure));
		expect(blob).toBe(hex(hashDomain("ts-drp-storage/blob/v1", payload)));
		expect(closureDigest).toBe(hex(hashDomain("ts-drp-storage/closure/v1", encodeCanonical(closure))));
		expect(blob).not.toBe(closureDigest);
		for (const registry of [v2Registry, v3Registry]) {
			expect(Object.values(registry.domains)).not.toContain("ts-drp-storage/blob/v1");
			expect(Object.values(registry.domains)).not.toContain("ts-drp-storage/closure/v1");
		}
	});

	it("canonicalizes closure order before hashing", () => {
		const left = ref(bytes(1));
		const right = ref(bytes(2));
		expect(must(digestClosure([left, right]))).toBe(must(digestClosure([right, left])));
	});

	it("rejects SharedArrayBuffer-backed digest input before hashing", () => {
		const shared = new Uint8Array(new SharedArrayBuffer(4));
		expect(digestBlob(shared)).toEqual({ ok: false, reason: "SHARED_BUFFER_INPUT" });
	});
});

describe("Phase 2a exact persistence codecs", () => {
	it("round-trips canonical head and generation records", () => {
		const head = noHead();
		const generation = record();
		expect(decodeHeadRecordV1(encodeHeadRecordV1(head))).toEqual({ ok: true, value: head });
		expect(decodeGenerationRecordV1(encodeGenerationRecordV1(generation))).toEqual({
			ok: true,
			value: generation,
		});
	});

	it.each(["head", "generation"] as const)(
		"maps canonical unknown schema/kind for %s without a v0 fallback",
		(kind) => {
			const unknownVersion = encodeCanonical({
				storageSchemaVersion: 2,
				kind,
				body: kind === "head" ? noHead() : record(),
			});
			const unknownKind = encodeCanonical({ storageSchemaVersion: 1, kind: "legacy", body: noHead() });
			const decode = kind === "head" ? decodeHeadRecordV1 : decodeGenerationRecordV1;
			expect(decode(unknownVersion)).toEqual({ ok: false, reason: "UNSUPPORTED_STORAGE_SCHEMA" });
			expect(decode(unknownKind)).toEqual({ ok: false, reason: "UNSUPPORTED_STORAGE_SCHEMA" });
		}
	);

	it("rejects extra fields and non-canonical/trailing bytes without a partial value", () => {
		const extra = encodeCanonical({
			storageSchemaVersion: 1,
			kind: "head",
			body: { ...noHead(), legacyId: "room" },
		});
		const canonical = encodeHeadRecordV1(noHead());
		const trailing = new Uint8Array(canonical.byteLength + 1);
		trailing.set(canonical);
		expect(decodeHeadRecordV1(extra)).toEqual({ ok: false, reason: "NON_CANONICAL_RECORD" });
		expect(decodeHeadRecordV1(trailing)).toEqual({ ok: false, reason: "NON_CANONICAL_RECORD" });
		expect(decodeHeadRecordV1(Uint8Array.of(255))).toEqual({ ok: false, reason: "NON_CANONICAL_RECORD" });
	});

	it("rejects non-closed generation bodies and sparse closures", () => {
		const invalidState = encodeCanonical({
			storageSchemaVersion: 1,
			kind: "generation",
			body: { ...record(), state: "LegacyComplete", extra: true },
		});
		expect(decodeGenerationRecordV1(invalidState)).toEqual({ ok: false, reason: "NON_CANONICAL_RECORD" });

		const sparse = record();
		const sparseClosure = new Array(1) as typeof sparse.closure;
		expect(() => encodeGenerationRecordV1({ ...sparse, closure: sparseClosure })).toThrow(TypeError);
	});

	it("rejects SharedArrayBuffer before decode", () => {
		const shared = new Uint8Array(new SharedArrayBuffer(8));
		expect(decodeHeadRecordV1(shared)).toEqual({ ok: false, reason: "SHARED_BUFFER_INPUT" });
	});

	it("encoders reject inherited, accessor, symbol, undefined, and extra fields", () => {
		const symbol = Symbol("extra");
		const inherited = Object.create({ legacy: true }) as Record<PropertyKey, unknown>;
		Object.assign(inherited, noHead());
		const accessor = {
			...noHead(),
			get legacy(): string {
				return "room";
			},
		};
		const invalid = [
			{ ...noHead(), extra: true },
			{ ...noHead(), extra: undefined },
			Object.assign({ ...noHead() }, { [symbol]: true }),
			inherited,
			accessor,
		];
		for (const value of invalid) {
			expect(() => encodeHeadRecordV1(value as ReturnType<typeof noHead>)).toThrow(TypeError);
		}
	});

	it("decoded values are detached from decoder input and one another", () => {
		const encoded = encodeHeadRecordV1(noHead(OBJECT_A));
		const first = decodeHeadRecordV1(encoded);
		const second = decodeHeadRecordV1(encoded);
		expect(first).toEqual(second);
		expect(first).not.toBe(second);
		encoded.fill(0);
		expect(first).toEqual({ ok: true, value: noHead(OBJECT_A) });
	});

	it("does not treat an arbitrary canonical body as a legacy record", () => {
		const bareLegacy = encodeCanonical(noHead());
		expect(() => decodeCanonical(bareLegacy)).not.toThrow();
		expect(decodeHeadRecordV1(bareLegacy)).toEqual({ ok: false, reason: "NON_CANONICAL_RECORD" });
	});
});
