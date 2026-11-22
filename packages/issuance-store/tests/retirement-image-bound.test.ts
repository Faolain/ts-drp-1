import { encodeCanonical } from "@ts-drp/canonical";
import { describe, expect, it } from "vitest";
import {
	ISSUANCE_RETIREMENT_LIMITS,
	issuanceRetirementImage,
	issuanceRetirementImageBound,
	type IssuanceRetirementRows,
} from "../src/retirement.js";
import { d109bCommit } from "../../../tests/fixtures/phase-6b/issuance-retention-contract.js";

// issuanceRetirementImageBound is the gate form of issuanceRetirementImage for callers that
// discard the image (the reserved-postimage check in reserveUnsignedIntent). It must throw iff
// issuanceRetirementImage throws, with the same message at the same check, and otherwise
// return exactly the image's logicalBytes, without encoding the whole image or hashing it.

const objectId = "bound-room";
type Outcome = { ok: true; logicalBytes: number } | { ok: false; message: string; name: string };
function outcome(run: () => number): Outcome {
	try {
		return { ok: true, logicalBytes: run() };
	} catch (error) {
		return { ok: false, message: (error as Error).message, name: (error as Error).name };
	}
}
const original = (rows: unknown) => outcome(() => issuanceRetirementImage(rows as IssuanceRetirementRows, objectId).logicalBytes);
const bound = (rows: unknown) => outcome(() => issuanceRetirementImageBound(rows as IssuanceRetirementRows, objectId));
function same(rows: unknown): Outcome {
	const expected = original(rows);
	expect(bound(rows)).toEqual(expected);
	return expected;
}

/** One author per entry of `held`: `held[i]` issued rows still retained after `pruned` pruned ones. */
function rows(options: { authors?: readonly { held: number; pruned?: number }[]; plan?: boolean } = {}): IssuanceRetirementRows {
	const authors = options.authors ?? [{ held: 3, pruned: 1 }];
	const out: { lineages: unknown[]; issued: unknown[]; outbox: unknown[]; plans: unknown[] } = { lineages: [], issued: [], outbox: [], plans: [] };
	authors.forEach(({ held, pruned = 0 }, index) => {
		const scope = { objectId, author: `writer-${index}` };
		out.lineages.push({ ...scope, next: pruned + held, exhausted: false, prunedThroughAuthorSequence: pruned === 0 ? null : pruned - 1 });
		for (let sequence = pruned; sequence < pruned + held; sequence++) {
			const commit = d109bCommit(scope, sequence, sequence, sequence * 7 + index + 1);
			out.issued.push({ ...scope, authorSequence: sequence, ...commit.envelope });
			out.outbox.push({ ...scope, authorSequence: sequence, digest: commit.envelope.digest, publishState: "published" });
		}
		if (options.plan === true && held > 0) {
			const source = d109bCommit(scope, pruned, pruned, pruned * 7 + index + 1);
			out.plans.push({ scope, revision: 3, fenceSequence: null, sourceContexts: [], entries: [{
				sourceSequence: pruned, sourceDigest: source.envelope.digest, disposition: "expire" as const, replacementSequence: null }] });
		}
	});
	return out as unknown as IssuanceRetirementRows;
}
/** Nested arrays `levels` deep under one lineage field. */
function nested(levels: number): unknown {
	let value: unknown = 0;
	for (let index = 0; index < levels; index++) value = [value];
	return value;
}

describe("issuanceRetirementImageBound throws iff issuanceRetirementImage throws, else returns its logicalBytes", () => {
	it("agrees on accepted row sets of many shapes, including array lengths across the one-byte varuint boundary", () => {
		const shapes = [
			{ authors: [] },
			{ authors: [{ held: 0 }] },
			{ authors: [{ held: 3, pruned: 1 }] },
			{ authors: [{ held: 3, pruned: 1 }], plan: true },
			{ authors: [{ held: 2 }, { held: 5, pruned: 2 }, { held: 0, pruned: 4 }], plan: true },
			{ authors: [{ held: 127 }] },
			{ authors: [{ held: 128 }] },
			{ authors: [{ held: 63 }, { held: 64 }] },
			{ authors: [{ held: 64 }, { held: 64 }], plan: true },
			{ authors: Array.from({ length: 127 }, () => ({ held: 0 })) },
			{ authors: Array.from({ length: 128 }, () => ({ held: 0 })) },
			{ authors: Array.from({ length: 128 }, (_, index) => ({ held: index % 2 })), plan: true },
		];
		for (const shape of shapes) {
			const result = same(rows(shape));
			expect(result.ok, JSON.stringify(shape).slice(0, 80)).toBe(true);
		}
	});
	it("agrees on every refusal before the image bound, with the same message at the same check", () => {
		const base = () => rows({ authors: [{ held: 3, pruned: 1 }], plan: true }) as unknown as Record<string, any[]>;
		const cases: ((value: Record<string, any[]>) => void)[] = [
			(value) => { value.issued[0] = { ...value.issued[0], objectId: "other-room" }; },
			(value) => { value.outbox.pop(); },
			(value) => { value.issued[1] = { ...value.issued[1], digest: new Uint8Array(32).fill(9) }; },
			(value) => { value.lineages[0] = { ...value.lineages[0], next: 9 }; },
			(value) => { value.plans[0] = { ...value.plans[0], scope: { objectId, author: "nobody" } }; },
			(value) => { value.issued.push(undefined); },
			(value) => { value.lineages = Array.from({ length: ISSUANCE_RETIREMENT_LIMITS.maxRows + 1 }, () => value.lineages[0]); },
			// A deep row that also fails classification: the classification message comes first.
			(value) => { value.lineages[0] = { ...value.lineages[0], next: 9, extra: nested(15) }; },
		];
		for (const change of cases) {
			const value = base();
			change(value);
			const result = same(value);
			expect(result.ok).toBe(false);
		}
	});
	it("refuses exactly the rows nested too deep for the whole image, before its byte bound", () => {
		// Rows sit two levels inside the image: a row whose own depth fits the per-row encode (16)
		// but exceeds 14 fails only the whole image, with the encoder's depth message.
		for (const levels of [12, 13, 14, 15, 16, 17]) {
			const value = rows() as unknown as Record<string, any[]>;
			value.lineages[0] = { ...value.lineages[0], extra: nested(levels) };
			same(value);
		}
		const deep = rows() as unknown as Record<string, any[]>;
		deep.lineages[0] = { ...deep.lineages[0], extra: nested(14) };
		expect(original(deep)).toMatchObject({ ok: false, message: "canonical value exceeds maximum nesting depth" });
	});
	it("agrees at maxBytes - 1, maxBytes and maxBytes + 1 of the whole image", () => {
		const max = ISSUANCE_RETIREMENT_LIMITS.maxBytes;
		const padded = (length: number) => {
			const value = rows({ authors: [{ held: 2 }], plan: true }) as unknown as Record<string, any[]>;
			value.lineages[0] = { ...value.lineages[0], pad: "x".repeat(length) };
			return value;
		};
		const width = (length: number) => encodeCanonical(padded(length), { maxBytes: 2 * max, maxDepth: 64, maxItems: 1 << 20 }).byteLength;
		let length = max - width(0);
		for (let step = 0; step < 8 && width(length) !== max; step++) length += max - width(length);
		expect(width(length)).toBe(max);
		expect(same(padded(length - 1))).toEqual({ ok: true, logicalBytes: max - 1 });
		expect(same(padded(length))).toEqual({ ok: true, logicalBytes: max });
		expect(same(padded(length + 1))).toMatchObject({ ok: false, message: "canonical value exceeds byte limit" });
		// The per-row running charge stays under the bound there: only the whole image refuses.
		expect(same(padded(length + 200))).toMatchObject({ ok: false });
	});
	it("falls back to the whole image for a row record outside the four known arrays", () => {
		const extra = { ...rows(), note: "outside" };
		same(extra);
		const missing = rows() as unknown as Record<string, unknown>;
		delete missing.plans;
		same(missing);
	});
});
