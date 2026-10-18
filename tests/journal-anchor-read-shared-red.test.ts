import { expect, it } from "vitest";

import { anchorMaterial } from "./fixtures/journal-anchor-read/material.js";
import * as journal from "../packages/live-journal/dist/src/index.js";

function observation(input: unknown, value: unknown): unknown {
	const helper = (
		journal as unknown as { captureLiveJournalAnchorReadObservation?(input: unknown, value: unknown): unknown }
	).captureLiveJournalAnchorReadObservation;
	return helper === undefined ? { wiring: "missing-captureLiveJournalAnchorReadObservation" } : helper(input, value);
}

it("exports the fixed cap without widening ordinary failure vocabulary", () => {
	expect((journal as unknown as Record<string, unknown>).LIVE_JOURNAL_ANCHOR_READ_MAX_BYTES).toBe(8192);
	expect(journal.LIVE_JOURNAL_FAILURE_KINDS).not.toContain("read-budget-exceeded");
});

it("tiny intrinsic control: ordinary byteLength and buffer can lie about real oversized/SAB backing", () => {
	const intrinsic = Object.getPrototypeOf(Uint8Array.prototype) as object;
	const byteLength = Object.getOwnPropertyDescriptor(intrinsic, "byteLength")?.get;
	const buffer = Object.getOwnPropertyDescriptor(intrinsic, "buffer")?.get;
	const oversized = new Uint8Array(8193);
	Object.defineProperties(oversized, { byteLength: { value: 1 }, buffer: { value: new ArrayBuffer(1) } });
	expect(oversized.byteLength).toBe(1);
	expect(byteLength?.call(oversized)).toBe(8193);
	const shared = new Uint8Array(new SharedArrayBuffer(8));
	Object.defineProperty(shared, "buffer", { value: new ArrayBuffer(8) });
	expect(shared.buffer).toBeInstanceOf(ArrayBuffer);
	expect(buffer?.call(shared)).toBeInstanceOf(SharedArrayBuffer);
});

it("direct helper: intrinsic8193 refuses before avoidable iterator/copy, despite shadowed properties", () => {
	const material = anchorMaterial();
	let copies = 0;
	const bytes = new Uint8Array(8193);
	Object.defineProperties(bytes, {
		byteLength: { value: 1 },
		buffer: { value: new ArrayBuffer(1) },
		[Symbol.iterator]: {
			value(): never {
				copies++;
				throw new Error("must gate before copying");
			},
		},
	});
	expect(
		observation(
			{ maxBytes: 8192, scope: material.scope },
			{ exactCanonicalAnchorPreimageBytes: bytes, scope: material.scope }
		)
	).toEqual({ kind: "read-budget-exceeded", ok: false });
	expect(copies).toBe(0);
});

it("direct helper: real shared backing is poisoned even when ordinary buffer lies", () => {
	const material = anchorMaterial();
	const bytes = new Uint8Array(new SharedArrayBuffer(material.bytes.length));
	bytes.set(material.bytes);
	Object.defineProperty(bytes, "buffer", { value: new ArrayBuffer(bytes.length) });
	expect(
		observation(
			{ maxBytes: 8192, scope: material.scope },
			{ exactCanonicalAnchorPreimageBytes: bytes, scope: material.scope }
		)
	).toEqual({ kind: "store-poisoned", ok: false });
});

it("direct helper owns closed observation/input, exact hash/scope, freezing and detached admitted bytes", () => {
	const material = anchorMaterial();
	const input = { maxBytes: 8192, scope: material.scope };
	const actual = { exactCanonicalAnchorPreimageBytes: material.bytes, scope: material.scope };
	const result = observation(input, actual) as { exactCanonicalAnchorPreimageBytes?: Uint8Array; scope?: unknown };
	expect(result).toEqual({ ...actual, kind: "present", ok: true });
	expect(Object.isFrozen(result)).toBe(true);
	expect(Object.isFrozen(result.scope)).toBe(true);
	expect(result.exactCanonicalAnchorPreimageBytes).not.toBe(material.bytes);
	result.exactCanonicalAnchorPreimageBytes?.fill(9);
	expect(material.bytes).toEqual(anchorMaterial().bytes);
	for (const invalid of [
		{ ...input, maxBytes: 8193 },
		{ ...input, extra: true },
	])
		expect(observation(invalid, actual)).toEqual({ kind: "malformed-input", ok: false });
	for (const invalid of [
		{ ...actual, extra: true },
		{ ...actual, scope: { ...material.scope, epoch: 1 } },
		{ ...actual, exactCanonicalAnchorPreimageBytes: anchorMaterial(0, { aclDigest: "9".repeat(64) }).bytes },
		{ ...actual, exactCanonicalAnchorPreimageBytes: "not-bytes" },
		{ ...actual, exactCanonicalAnchorPreimageBytes: new Uint8Array() },
	])
		expect(observation(input, invalid)).toEqual({ kind: "store-poisoned", ok: false });
});
