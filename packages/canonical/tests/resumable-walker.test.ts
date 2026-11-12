import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as codec from "../src/internal/codec.js";
import type { CanonicalWalkEvent, CanonicalWalker, CanonicalWalkerOptions } from "../src/internal/codec.js";

// The resumable canonical walker (createCanonicalWalker) seeds an application's state bound over a
// room's base state in bounded steps instead of one whole-value decode. It must accept exactly the
// inputs decodeCanonicalExactness decodes and reports exact, describe exactly decodeCanonical's value,
// and do so for ANY step budget: one byte or the whole value.

type CreateWalker = (input: Uint8Array, options?: CanonicalWalkerOptions) => CanonicalWalker;

function rng(seed: number): () => number {
	let state = seed >>> 0 || 1;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 0x1_0000_0000;
	};
}

const STRINGS = ["", "a", "kind", "epoch", "objectId", "peer-B", "peer-a", "Peer-a", "peerä", "peer-😀", "﻿bom",
	"x".repeat(127), "y".repeat(128), "z".repeat(300), "é".repeat(40), "日本語テキスト", "\u0000", "__proto__"];

function randomValue(next: () => number, depth: number): unknown {
	const pick = Math.floor(next() * (depth > 4 ? 8 : 14));
	switch (pick) {
		case 0: return null;
		case 1: return next() < 0.5;
		case 2: return Math.floor((next() - 0.5) * 2 ** Math.floor(next() * 54));
		case 3: return [0, 1, -1, 63, 64, -64, -65, 2 ** 31, 2 ** 52, Number.MAX_SAFE_INTEGER, 2 ** 60, 0.5][Math.floor(next() * 12)];
		case 4: return (next() - 0.5) * 1e6;
		case 5: return STRINGS[Math.floor(next() * STRINGS.length)];
		case 6: return Uint8Array.from({ length: Math.floor(next() * 40) }, () => Math.floor(next() * 256));
		case 7: return "s" + Math.floor(next() * 1000);
		case 8:
		case 9: return Array.from({ length: Math.floor(next() * 6) }, () => randomValue(next, depth + 1));
		case 10: {
			const object: Record<string, unknown> = Object.create(null);
			const count = Math.floor(next() * 6);
			for (let index = 0; index < count; index++) object[STRINGS[Math.floor(next() * 10)]! + (next() < 0.3 ? index : "")] = randomValue(next, depth + 1);
			return object;
		}
		case 11: return new Map(Array.from({ length: Math.floor(next() * 4) }, () => [randomValue(next, depth + 2), randomValue(next, depth + 1)]));
		case 12: return new Set(Array.from({ length: Math.floor(next() * 4) }, () => randomValue(next, depth + 2)));
		default: return [Float32Array.of(1.5, 2), Float64Array.of(next() * 1e9), Int32Array.of(-5, 7), Uint32Array.of(0xffffffff, 3)][Math.floor(next() * 4)];
	}
}

/** Rebuilds the value the events describe; throws if the event stream is not well formed. */
function rebuild(events: readonly CanonicalWalkEvent[]): unknown {
	type Open = { kind: string; value: unknown[] | Record<string, unknown> | Map<unknown, unknown> | Set<unknown>; depth: number };
	const open: Open[] = [];
	let root: unknown;
	let rooted = false;
	const place = (depth: number, key: unknown, value: unknown): void => {
		if (open.length === 0) {
			if (rooted || depth !== 0) throw new Error("second root");
			rooted = true;
			root = value;
			return;
		}
		const parent = open[open.length - 1]!;
		if (depth !== parent.depth + 1) throw new Error("depth skew");
		if (parent.kind === "array") (parent.value as unknown[]).push(value);
		else if (parent.kind === "set") (parent.value as Set<unknown>).add(value);
		else if (parent.kind === "map") (parent.value as Map<unknown, unknown>).set(key, value);
		else (parent.value as Record<string, unknown>)[key as string] = value;
	};
	for (const event of events) {
		if (event.type === "value") place(event.depth, event.key, event.value);
		else if (event.type === "enter") {
			const value = event.kind === "array" ? [] : event.kind === "set" ? new Set() : event.kind === "map" ? new Map() : Object.create(null);
			place(event.depth, event.key, value);
			open.push({ kind: event.kind, value, depth: event.depth });
		} else {
			const closed = open.pop();
			if (closed === undefined || closed.depth !== event.depth || closed.kind !== event.kind) throw new Error("unbalanced leave");
		}
	}
	if (open.length !== 0 || !rooted) throw new Error("incomplete walk");
	return root;
}

type Walked = { ok: true; value: unknown; steps: number; consumed: number[] } | { ok: false; message: string };

function walk(create: CreateWalker, bytes: Uint8Array, budget: number | "whole", options?: CanonicalWalkerOptions): Walked {
	const events: CanonicalWalkEvent[] = [];
	const consumed: number[] = [];
	let walker: CanonicalWalker;
	try {
		walker = create(bytes, options);
	} catch (error) {
		if ((error as { code?: unknown }).code !== "CANONICAL_DECODING") throw error;
		return { ok: false, message: (error as Error).message };
	}
	const size = budget === "whole" ? Math.max(1, bytes.byteLength) : budget;
	try {
		for (let steps = 1; ; steps++) {
			const before = walker.offset;
			const finished = walker.step(size, (event) => events.push(event));
			consumed.push(walker.offset - before);
			if (finished) return { ok: true, value: rebuild(events), steps, consumed };
			if (steps > bytes.byteLength + 64) throw new Error("walker made no progress");
		}
	} catch (error) {
		// The decoding error's code, not its class: a mutant module has its own class.
		if ((error as { code?: unknown }).code !== "CANONICAL_DECODING") throw error;
		const message = (error as Error).message;
		// A refused walker stays refused.
		expect(() => walker.step(size, () => {})).toThrow(message);
		return { ok: false, message };
	}
}

/** The reference verdict: decodeCanonicalExactness decodes the input and reports it exact. */
function reference(bytes: Uint8Array, limits?: Partial<codec.CanonicalLimits>): { ok: true; value: unknown } | { ok: false } {
	try {
		const decoded = codec.decodeCanonicalExactness(bytes, limits);
		return decoded.exact ? { ok: true, value: decoded.value } : { ok: false };
	} catch (error) {
		if (!(error instanceof codec.CanonicalDecodingError)) throw error;
		return { ok: false };
	}
}

function sameVerdict(create: CreateWalker, bytes: Uint8Array, label: string, limits?: Partial<codec.CanonicalLimits>): boolean {
	const expected = reference(bytes, limits);
	const whole = bytes.byteLength;
	for (const splitDepth of [0, 1, 2, 3, 128]) {
		for (const budget of [1, 2, 7, 64, whole === 0 ? 1 : whole]) {
			const walked = walk(create, bytes, budget, { splitDepth, limits });
			const where = `${label} split ${splitDepth} budget ${budget}`;
			expect(walked.ok, where).toBe(expected.ok);
			if (walked.ok && expected.ok) expect(walked.value, where).toStrictEqual(expected.value);
		}
	}
	return expected.ok;
}

/** Adversarial inputs every walker must refuse, at every budget and split depth. */
const ADVERSARIAL: Readonly<Record<string, Uint8Array>> = Object.freeze({
	"duplicate object key": Uint8Array.of(0x08, 2, 0x05, 1, 0x61, 0x00, 0x05, 1, 0x61, 0x00),
	"unsorted object keys": Uint8Array.of(0x08, 2, 0x05, 1, 0x62, 0x00, 0x05, 1, 0x61, 0x00),
	"duplicate map key": Uint8Array.of(0x09, 2, 0x03, 2, 0x00, 0x03, 2, 0x00),
	"unsorted map keys": Uint8Array.of(0x09, 2, 0x03, 4, 0x00, 0x03, 2, 0x00),
	"duplicate set element": Uint8Array.of(0x0a, 2, 0x03, 2, 0x03, 2),
	"unsorted set elements": Uint8Array.of(0x0a, 2, 0x03, 4, 0x03, 2),
	"non-string object key": Uint8Array.of(0x08, 1, 0x03, 2, 0x00),
	"non-minimal array length": Uint8Array.of(0x07, 0x81, 0x00, 0x00),
	"non-minimal string length": Uint8Array.of(0x05, 0x81, 0x00, 0x61),
	"non-minimal integer": Uint8Array.of(0x07, 1, 0x03, 0x82, 0x00),
	"non-minimal object length deep in an entered object": Uint8Array.of(0x08, 1, 0x05, 1, 0x61, 0x08, 0x80, 0x00),
	"trailing bytes": Uint8Array.of(0x07, 1, 0x00, 0x00),
	"trailing bytes after a scalar root": Uint8Array.of(0x00, 0x00),
	"truncated array": Uint8Array.of(0x07, 3, 0x00, 0x00),
	"truncated object value": Uint8Array.of(0x08, 1, 0x05, 1, 0x61),
	"truncated length": Uint8Array.of(0x07, 0x80),
	"empty input": new Uint8Array(0),
	"string with a leading BOM": Uint8Array.of(0x07, 1, 0x05, 3, 0xef, 0xbb, 0xbf),
	"invalid UTF-8": Uint8Array.of(0x07, 1, 0x05, 1, 0xff),
	"integral float in the safe range": Uint8Array.of(0x07, 1, 0x04, 0x3f, 0xf0, 0, 0, 0, 0, 0, 0),
	"integral float beyond the safe range": Uint8Array.of(0x07, 1, 0x04, 0x44, 0x30, 0, 0, 0, 0, 0, 0),
	"unknown tag": Uint8Array.of(0x07, 1, 0x7f),
});

function assertRefusesAdversarial(create: CreateWalker): void {
	for (const [label, bytes] of Object.entries(ADVERSARIAL)) {
		for (const splitDepth of [0, 1, 2, 128]) {
			for (const budget of [1, 3, "whole"] as const) {
				expect(walk(create, bytes, budget, { splitDepth }).ok, `${label} split ${splitDepth} budget ${budget}`).toBe(false);
			}
		}
	}
}

describe("resumable canonical walker", () => {
	it("refuses truncation, non-minimal lengths, unsorted or duplicate keys, trailing bytes and non-exact forms", () => {
		assertRefusesAdversarial(codec.createCanonicalWalker);
		for (const label of Object.keys(ADVERSARIAL)) expect(reference(ADVERSARIAL[label]!).ok, label).toBe(false);
	});

	it("refuses every strict prefix of a valid value", () => {
		const bytes = codec.encodeCanonical({ blocks: [{ id: "a", x: 1 }, { id: "b", x: 2 }], roster: ["p", "q"], version: 2 });
		for (let end = 0; end < bytes.byteLength; end++) {
			for (const budget of [1, "whole"] as const)
				expect(walk(codec.createCanonicalWalker, bytes.subarray(0, end), budget, { splitDepth: 2 }).ok, `prefix ${end}`).toBe(false);
		}
		expect(walk(codec.createCanonicalWalker, bytes, 1, { splitDepth: 2 }).ok).toBe(true);
	});

	it("matches decodeCanonicalExactness for any budget and split depth (property)", () => {
		const verdicts = { accepted: 0, refused: 0 };
		for (let seed = 1; seed <= 1500; seed++) {
			const next = rng(seed);
			let bytes: Uint8Array;
			try {
				bytes = codec.encodeCanonical(randomValue(next, 0));
			} catch {
				continue;
			}
			verdicts[sameVerdict(codec.createCanonicalWalker, bytes, `seed ${seed}`) ? "accepted" : "refused"]++;
			const budget = 1 + Math.floor(next() * bytes.byteLength);
			const walked = walk(codec.createCanonicalWalker, bytes, budget, { splitDepth: Math.floor(next() * 5) });
			const expected = reference(bytes);
			expect(walked.ok, `seed ${seed} random budget ${budget}`).toBe(expected.ok);
		}
		// Encoder output is exact except a string with a leading BOM (which decodes stripped).
		expect(verdicts.accepted).toBeGreaterThan(1000);
		expect(sameVerdict(codec.createCanonicalWalker, codec.encodeCanonical({ a: [1, "\ufeffbom"] }), "encoded BOM")).toBe(false);
	});

	it("matches decodeCanonicalExactness on mutated, truncated and extended bytes (property)", () => {
		const verdicts = { accepted: 0, refused: 0 };
		for (let seed = 1; seed <= 1500; seed++) {
			const next = rng(seed * 7919);
			let bytes: Uint8Array;
			try {
				bytes = codec.encodeCanonical(randomValue(next, 0));
			} catch {
				continue;
			}
			const mutated = new Uint8Array(bytes);
			const mode = seed % 3;
			let input = mutated;
			if (mode === 0 && mutated.byteLength > 0) mutated[Math.floor(next() * mutated.byteLength)] = Math.floor(next() * 256);
			else if (mode === 1) input = mutated.subarray(0, Math.floor(next() * mutated.byteLength));
			else input = Uint8Array.of(...mutated, Math.floor(next() * 256));
			verdicts[sameVerdict(codec.createCanonicalWalker, input, `mutated seed ${seed}`) ? "accepted" : "refused"]++;
		}
		expect(verdicts.accepted).toBeGreaterThan(50);
		expect(verdicts.refused).toBeGreaterThan(500);
	});

	it("applies the decoder's resource limits", () => {
		const deep = codec.encodeCanonical([[[[1]]]]);
		const wide = codec.encodeCanonical([1, 2, 3, 4, 5, 6]);
		for (const [bytes, limits] of [[deep, { maxDepth: 2 }], [wide, { maxItems: 4 }], [wide, { maxBytes: 3 }]] as const)
			sameVerdict(codec.createCanonicalWalker, bytes, JSON.stringify(limits), limits);
	});

	it("bounds each step: at least one event, then stops at the budget (a split-depth node is whole)", () => {
		const values = Array.from({ length: 500 }, (_, index) => ({ id: `block-${index}`, x: index, y: -index }));
		const bytes = codec.encodeCanonical({ blocks: values, version: 2 });
		const unit = Math.max(...values.map((value) => codec.encodeCanonical(value).byteLength));
		for (const budget of [1, 16, 100, 1024]) {
			const walked = walk(codec.createCanonicalWalker, bytes, budget, { splitDepth: 2 });
			expect(walked.ok).toBe(true);
			if (!walked.ok) continue;
			for (const consumed of walked.consumed) expect(consumed).toBeLessThan(budget + unit + 16);
			expect(walked.steps).toBeGreaterThanOrEqual(Math.floor(bytes.byteLength / (budget + unit + 16)));
		}
	});

	it("catches a mutant walker that accepts a duplicate key", async () => {
		const source = readFileSync(fileURLToPath(new URL("../src/internal/codec.ts", import.meta.url)), "utf8");
		const walkerStart = source.indexOf("export function createCanonicalWalker");
		const check = 'compareRanges(bytes, frame.previousStart, frame.previousEnd, start, reader.offset) >= 0)\n\t\t\tthrow new CanonicalDecodingError("map/object keys';
		const at = source.indexOf(check, walkerStart);
		expect(walkerStart, "walker present").toBeGreaterThan(0);
		expect(at, "the walker's own key-order check").toBeGreaterThan(walkerStart);
		const mutantSource = source.slice(0, at) + check.replace(">= 0)", "> 0)") + source.slice(at + check.length);
		const mutantPath = fileURLToPath(new URL(`../src/internal/.codec-mutant-${process.pid}.ts`, import.meta.url));
		writeFileSync(mutantPath, mutantSource);
		try {
			const mutant = (await import(/* @vite-ignore */ mutantPath)) as typeof codec;
			expect(walk(mutant.createCanonicalWalker, ADVERSARIAL["duplicate object key"]!, "whole", { splitDepth: 1 }).ok,
				"the mutant accepts the duplicate key").toBe(true);
			expect(() => assertRefusesAdversarial(mutant.createCanonicalWalker), "the adversarial suite catches the mutant").toThrow();
		} finally {
			rmSync(mutantPath, { force: true });
		}
	});
});
