import {encodeCanonical} from "@ts-drp/canonical";
import {observeCanonicalCalls} from "@ts-drp/canonical/instrumentation";
import {afterEach, describe, expect, it} from "vitest";
import {
	CREATOR_MAINTENANCE_PROOF_MAX_BYTES,
	createCreatorFinishingWidthCompiler,
} from "../src/internal/creator-closed-rollback-data.js";

// The finishing width compiler must emit exactly the program, return values and refusals of the
// compiler as of 3d630ead (REFERENCE below, copied verbatim with its private helpers), while
// encoding less: scalar leaf widths are measured once per distinct scalar per compile, and BYTES
// leaf widths are arithmetic (tag + varuint length + payload) rather than an encode of the bytes.

const CLOSED_RETIREMENT_BYTES = Object.freeze({maxBytes: 786_432, maxItems: 65_536, maxDepth: 128});
const closedRetirementBytes = (value: unknown): Uint8Array => encodeCanonical(value, CLOSED_RETIREMENT_BYTES);
// The private width-atom symbol, read off an atom the compiler itself mints.
const atomSymbol = Object.getOwnPropertySymbols(createCreatorFinishingWidthCompiler().encodedBytes(1))[0]!;
type Atom = Readonly<{expanded?: Readonly<{items: number; maxDepth: number}>}> & Record<symbol, number>;
const atom = (width: number, expanded?: Readonly<{items: number; maxDepth: number}>): Atom =>
	Object.freeze({[atomSymbol]: width, ...(expanded === undefined ? {} : {expanded: Object.freeze({...expanded})})}) as Atom;

// ---- REFERENCE: createCreatorFinishingWidthCompiler and the helpers it uses, as of 3d630ead ----
function maintenanceVarUintWidth(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("creator maintenance count is invalid");
	let width = 1;
	while (value >= 128) { value = Math.floor(value / 128); width++; }
	return width;
}
function maintenanceWidthSum(values: readonly number[], owner = "carrier"): number {
	let total = 0;
	for (const value of values) {
		if (!Number.isSafeInteger(value) || value < 0)
			throw new TypeError("creator maintenance carrier exceeds its original proof bound");
		if (value > CREATOR_MAINTENANCE_PROOF_MAX_BYTES - total) {
			const complete = values.every((width) => Number.isSafeInteger(width) && width >= 0)
				? values.reduce((sum, width) => sum + width, 0) : undefined;
			const largest = values.filter(Number.isSafeInteger).sort((a, b) => b - a).slice(0, 8);
			throw new TypeError(`creator maintenance carrier exceeds its original proof bound:${owner}:` +
				`${Number.isSafeInteger(complete) ? complete : "invalid"}/${CREATOR_MAINTENANCE_PROOF_MAX_BYTES};` +
				`carriers=${values.length};largest=${largest.join(",")}`);
		}
		total += value;
	}
	return total;
}
function maintenanceEncodedWidth(value: number | undefined, expanded?: Readonly<{items: number; maxDepth: number}>,
	maximumBytes?: number): Atom {
	if (maximumBytes !== undefined) throw new TypeError("reference: test atoms carry no native entitlement");
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > CLOSED_RETIREMENT_BYTES.maxBytes)
		throw new TypeError("creator maintenance encoded width is invalid");
	if (expanded !== undefined && (!Number.isSafeInteger(expanded.items) || expanded.items < 1 ||
		expanded.items > 65_536 || !Number.isSafeInteger(expanded.maxDepth) || expanded.maxDepth < 0 || expanded.maxDepth > 128))
		throw new TypeError("creator maintenance encoded container shape is invalid");
	return atom(value, expanded);
}
function maintenanceCanonicalWidth(value: unknown,
	primitiveWidth: (node: unknown) => number = node => closedRetirementBytes(node).byteLength): number {
	let items = 0;
	let decodedItems = 0;
	let expandedContainer = false;
	const measure = (node: unknown, depth: number): number => {
		decodedItems++;
		if (++items > 65_536 || (expandedContainer && decodedItems > 65_536) || depth > 128)
			throw new TypeError("creator maintenance carrier nesting is invalid");
		if (node !== null && typeof node === "object" && atomSymbol in node) {
			const checked = maintenanceEncodedWidth((node as Atom)[atomSymbol], (node as Atom).expanded);
			items += (checked.expanded?.items ?? 1) - 1;
			decodedItems += (checked.expanded?.items ?? 1) - 1;
			expandedContainer ||= checked.expanded !== undefined;
			if (items > 65_536 || (expandedContainer && decodedItems > 65_536) ||
				depth + (checked.expanded?.maxDepth ?? 0) > 128)
				throw new TypeError("creator maintenance encoded container nesting is invalid");
			return checked[atomSymbol]!;
		}
		if (Array.isArray(node)) {
			decodedItems += node.length;
			const widths = [1, maintenanceVarUintWidth(node.length)];
			for (const child of node.map((child) => measure(child, depth + 1))) widths.push(child);
			return maintenanceWidthSum(widths);
		}
		if (node !== null && typeof node === "object" && !(node instanceof Uint8Array)) {
			const pairs = Object.entries(node);
			decodedItems += pairs.length * 2;
			const widths = [1, maintenanceVarUintWidth(pairs.length)];
			for (const [key, child] of pairs) widths.push(measure(key, depth + 1), measure(child, depth + 1));
			return maintenanceWidthSum(widths);
		}
		return primitiveWidth(node);
	};
	return measure(value, 0);
}
function maintenanceCanonicalCapacityWidth(value: unknown): number {
	const integerWidth = closedRetirementBytes(Number.MAX_SAFE_INTEGER).byteLength;
	return maintenanceCanonicalWidth(value, node => typeof node === "number" && Number.isSafeInteger(node)
		? integerWidth : closedRetirementBytes(node).byteLength);
}
type ReferenceNode =
	| Readonly<{ kind: "constant"; value: number }>
	| Readonly<{ kind: "parameter"; key: string }>
	| Readonly<{ kind: "sum" | "maximum"; children: readonly number[] }>
	| Readonly<{ kind: "bytes" | "array-count"; child: number }>
	| Readonly<{ kind: "product"; left: number; right: number }>;
function createReferenceCompiler() {
	const nodes: ReferenceNode[] = [];
	const values: number[] = [];
	const alternatives = new Map<number, {root: number; represented: Set<number>}>();
	const byteParameters = new WeakMap<Uint8Array, number>();
	const arrayParameters = new WeakMap<object, Readonly<{ count: number; child: number; childItems: number; childDepth: number }>>();
	const parameters = new Map<string, number>();
	const shapes: Readonly<{ items: number; depth: number }>[] = [];
	const results: Readonly<{ unknown: number; envelopes: readonly number[] }>[] = [];
	const native: Readonly<{ width: number; maximum: number }>[] = [];
	const counterMaximums = new Map<string, number>();
	const interned = new Map<string, number>();
	const append = (node: ReferenceNode, value: number): number => {
		let key: string;
		switch (node.kind) {
			case "constant": key = `c:${node.value}`; break;
			case "parameter": key = `p:${node.key}`; break;
			case "sum": case "maximum": key = `${node.kind}:${node.children.join(",")}`; break;
			case "product": key = `x:${node.left},${node.right}`; break;
			case "bytes": case "array-count": key = `${node.kind}:${node.child}`; break;
		}
		const existing = interned.get(key);
		if (existing !== undefined) {
			if (values[existing] !== value) throw new TypeError("ORDINARY_FINISHING_TEMPLATE_NODE_DRIFT");
			return existing;
		}
		if (nodes.length >= 65_536 || !Number.isSafeInteger(value) || value < 0)
			throw new TypeError("ORDINARY_FINISHING_TEMPLATE_COMPLEXITY");
		const index = nodes.length;
		nodes.push(Object.freeze(node)); values.push(value);
		interned.set(key, index);
		return index;
	};
	const constant = (value: number): number => append({kind: "constant", value}, value);
	const combine = (kind: "sum" | "maximum", children: readonly number[]): number => {
		if (children.length === 0) return constant(0);
		if (children.length === 1) return children[0]!;
		const unique = kind === "maximum" ? [...new Set(children)] : children;
		return append({kind, children: Object.freeze([...unique])}, kind === "sum"
			? maintenanceWidthSum(unique.map(index => values[index]!))
			: Math.max(...unique.map(index => values[index]!)));
	};
	const lookup = (value: number): number => alternatives.get(value)?.root ?? constant(value);
	const register = (value: number, expression: number): number => {
		if (values[expression]! < value) throw new TypeError("ORDINARY_FINISHING_TEMPLATE_WIDTH_DRIFT");
		const previous = alternatives.get(value);
		if (previous === undefined) alternatives.set(value, {root: expression, represented: new Set([expression])});
		else if (!previous.represented.has(expression)) {
			previous.represented.add(expression);
			previous.root = combine("maximum", [previous.root, expression]);
			previous.represented.add(previous.root);
		}
		return value;
	};
	const parameter = (key: string, value: number): number => {
		const previous = parameters.get(key);
		if (previous !== undefined) {
			if (values[previous] !== value) throw new TypeError("ORDINARY_FINISHING_TEMPLATE_PARAMETER_DRIFT");
			return previous;
		}
		const expression = append({kind: "parameter", key}, value);
		parameters.set(key, expression); register(value, expression);
		return expression;
	};
	const bytes = (child: number): number => append({kind: "bytes", child}, 1 + maintenanceVarUintWidth(values[child]!) + values[child]!);
	const arrayCount = (child: number): number => append({kind: "array-count", child}, 1 + maintenanceVarUintWidth(values[child]!));
	const product = (left: number, right: number): number => append({kind: "product", left, right}, values[left]! * values[right]!);
	const counter = (node: Readonly<Record<string, unknown>>): void => {
		if (typeof node.kind !== "string") return;
		for (const field of ["revision", "sequence"] as const) {
			const value = node[field];
			if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
				const key = `${node.kind}:${field}`;
				counterMaximums.set(key, Math.max(value, counterMaximums.get(key) ?? 0));
			}
		}
	};
	const tree = (value: unknown): Readonly<{ width: number; items: number; depth: number }> => {
		if (value !== null && typeof value === "object" && atomSymbol in value) {
			const a = value as Atom;
			return {width: lookup(a[atomSymbol]!), items: lookup(a.expanded?.items ?? 1), depth: constant(a.expanded?.maxDepth ?? 0)};
		}
		if (value instanceof Uint8Array) {
			const child = byteParameters.get(value);
			return {width: child === undefined ? constant(closedRetirementBytes(value).byteLength) : bytes(child),
				items: constant(1), depth: constant(0)};
		}
		const array = Array.isArray(value);
		if (array) {
			const repeated = arrayParameters.get(value);
			if (repeated !== undefined) return {
				width: combine("sum", [arrayCount(repeated.count), product(repeated.count, repeated.child)]),
				items: combine("sum", [constant(1), product(repeated.count, combine("sum", [constant(1), repeated.childItems]))]),
				depth: repeated.childDepth,
			};
		}
		if (array || (value !== null && typeof value === "object")) {
			if (!array) counter(value as Readonly<Record<string, unknown>>);
			const children = array ? (value as unknown[]).map(tree) :
				Object.entries(value as Readonly<Record<string, unknown>>).flatMap(([key, child]) => [tree(key), tree(child)]);
			const count = array ? children.length : children.length / 2;
			return {width: combine("sum", [constant(1 + maintenanceVarUintWidth(count)), ...children.map(child => child.width)]),
				items: combine("sum", [constant(1 + children.length), ...children.map(child => child.items)]),
				depth: children.length === 0 ? constant(0) : combine("sum", [constant(1), combine("maximum", children.map(child => child.depth))])};
		}
		return {width: constant(typeof value === "number" && Number.isSafeInteger(value)
			? closedRetirementBytes(Number.MAX_SAFE_INTEGER).byteLength : closedRetirementBytes(value).byteLength),
			items: constant(1), depth: constant(0)};
	};
	return Object.freeze({
		bind: (key: string, value: number): number => { parameter(key, value); return value; },
		dominate: (value: number, key: string, bound: number): void => { register(value, parameter(key, bound)); },
		material: (value: number): void => {
			const bound = parameters.get("material.whole");
			if (bound === undefined) throw new TypeError("ORDINARY_FINISHING_TEMPLATE_MATERIAL_UNAVAILABLE");
			register(value, bound);
		},
		maximum: (widths: readonly number[]): number => {
			const width = Math.max(...widths), expression = combine("maximum", widths.map(lookup));
			return register(width, expression);
		},
		bindBytes: (key: string, value: Uint8Array): void => { byteParameters.set(value, parameter(key, value.byteLength)); },
		encodedBytes: (length: number): Atom => {
			const expression = bytes(lookup(length)); register(values[expression]!, expression);
			return maintenanceEncodedWidth(values[expression]!);
		},
		sum: (widths: readonly number[], owner?: string): number => {
			const width = maintenanceWidthSum(widths, owner), expression = combine("sum", widths.map(lookup));
			return register(width, expression);
		},
		measure: (value: unknown): number => {
			const actual = maintenanceCanonicalCapacityWidth(value), compiled = tree(value);
			if (values[compiled.width]! < actual) throw new TypeError("ORDINARY_FINISHING_TEMPLATE_FIELD_DRIFT");
			shapes.push(Object.freeze({items: compiled.items, depth: compiled.depth}));
			return register(values[compiled.width]!, compiled.width);
		},
		runtimeShape: (runtime: Readonly<{items: number; maxDepth: number}>, nativeValue: unknown): void => {
			const child = tree(nativeValue);
			shapes.push(Object.freeze({items: combine("sum", [lookup(runtime.items), child.items]),
				depth: combine("maximum", [lookup(runtime.maxDepth), combine("sum", [constant(1), child.depth])])}));
		},
		bindArray: (value: readonly unknown[], key: string, count: number, completeChild: unknown): void => {
			const child = tree(completeChild), countExpression = parameter(key, count);
			arrayParameters.set(value, Object.freeze({count: countExpression, child: child.width,
				childItems: child.items, childDepth: combine("sum", [constant(1), child.depth])}));
		},
		copyFields: (original: object, copied: object): void => {
			const repeated = arrayParameters.get(original);
			if (repeated !== undefined) arrayParameters.set(copied, repeated);
			if (original instanceof Uint8Array && copied instanceof Uint8Array) {
				const p = byteParameters.get(original);
				if (p !== undefined) byteParameters.set(copied, p);
			}
		},
		result: (result: Readonly<{ unknownEncodedLengths: readonly number[]; fullFutureProofEnvelopeByteLengths: readonly number[] }>): void => {
			results.push(Object.freeze({unknown: combine("sum", result.unknownEncodedLengths.map(lookup)),
				envelopes: Object.freeze(result.fullFutureProofEnvelopeByteLengths.map(lookup))}));
		},
		native: (width: number, maximum: number): void => { native.push(Object.freeze({width: lookup(width), maximum})); },
		finish: () => {
			const unknown = combine("maximum", results.map(result => result.unknown));
			return Object.freeze({nodes: Object.freeze(nodes.slice()), unknown,
				envelopes: Object.freeze(results.flatMap(result => result.envelopes)),
				shapes: Object.freeze(shapes.slice()), native: Object.freeze(native.slice()),
				counterMaximums: Object.freeze([...counterMaximums].map(([key, maximum]) => Object.freeze({key, maximum}))),
				parameterKeys: Object.freeze([...parameters.keys()])});
		},
	});
}
// ---- end REFERENCE ----

type Compiler = ReturnType<typeof createReferenceCompiler>;
type Outcome = {ok: true; value: unknown} | {ok: false; name: string; message: string};
const run = (call: () => unknown): Outcome => {
	try { return {ok: true, value: call()}; }
	catch (error) { return {ok: false, name: (error as Error).name, message: (error as Error).message}; }
};
/** Drives the reference and the product compiler with the same calls on the same objects. */
function pair() {
	const reference = createReferenceCompiler(), product = createCreatorFinishingWidthCompiler() as unknown as Compiler;
	let calls = 0;
	const both = <K extends keyof Compiler>(method: K, ...args: Parameters<Compiler[K]>): Outcome => {
		calls++;
		const expected = run(() => (reference[method] as (...a: unknown[]) => unknown)(...args));
		const actual = run(() => (product[method] as (...a: unknown[]) => unknown)(...args));
		// Atoms are compared by their width and shape, not identity.
		const normalize = (outcome: Outcome): unknown => outcome.ok && outcome.value !== null && typeof outcome.value === "object" &&
			atomSymbol in outcome.value ? {ok: true, atom: (outcome.value as Atom)[atomSymbol], expanded: (outcome.value as Atom).expanded} : outcome;
		expect(normalize(actual), `${String(method)} #${calls}`).toEqual(normalize(expected));
		return expected;
	};
	return {both, reference, product, calls: () => calls};
}

/** Deterministic PRNG. */
function random(seed: number) {
	let state = seed >>> 0;
	return () => { state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0; return state / 2 ** 32; };
}
const SCALARS: readonly unknown[] = [null, true, false, 0, -0, 1, 127, 128, Number.MAX_SAFE_INTEGER, -1, -128,
	0.5, -2.25, 1e300, "", "a", "kind", "revision", "sequence", "x".repeat(127), "y".repeat(128), "é", "€", "😀", "a😀b",
	"0123456789abcdef".repeat(4), "drp-anchor-trust-state", "v3-issuance-retirement-control-1", "snapshot-retirement-control-1"];
const BYTE_LENGTHS = [0, 1, 32, 64, 127, 128, 255, 16_383, 16_384, 70_000];

function generator(seed: number, compilerPair: ReturnType<typeof pair>) {
	const next = random(seed);
	const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
	const boundBytes: Uint8Array[] = [], boundArrays: unknown[][] = [];
	const sharedRows: unknown[] = [];
	let keyIndex = 0;
	const value = (depth: number): unknown => {
		const roll = next();
		if (depth > 5 || roll < 0.3) return pick(SCALARS);
		if (roll < 0.4) return new Uint8Array(pick(BYTE_LENGTHS));
		if (roll < 0.45 && boundBytes.length > 0) return pick(boundBytes);
		if (roll < 0.5) return compilerPair.both("encodedBytes", pick([1, 10, 16, 127, 128])).ok
			? atom(pick([1, 10, 127, 128, 300])) : null;
		if (roll < 0.55) return atom(pick([2, 50, 129]), {items: pick([1, 3, 7]), maxDepth: pick([0, 1, 2])});
		if (roll < 0.6 && boundArrays.length > 0) return pick(boundArrays);
		if (roll < 0.65 && sharedRows.length > 0) return pick(sharedRows);
		if (roll < 0.8) return Array.from({length: Math.floor(next() * 4)}, () => value(depth + 1));
		const record: Record<string, unknown> = {};
		if (next() < 0.3) { record.kind = pick(["v3-issuance-retirement-control-1", "snapshot-retirement-control-1", "other"]);
			record.revision = pick([0, 3, 9, 128]); record.sequence = pick([1, 2, 300]); }
		for (let index = Math.floor(next() * 4); index > 0; index--)
			record[pick(["digest", "objectId", "epoch", "rows", "control", "anchor", `field${index}`])] = value(depth + 1);
		if (next() < 0.2) sharedRows.push(record);
		return record;
	};
	const widths: number[] = [];
	return {
		step: () => {
			const roll = next(), both = compilerPair.both;
			if (roll < 0.08) {
				const bytes = new Uint8Array(pick(BYTE_LENGTHS));
				both("bindBytes", `leaf.${keyIndex++}`, bytes); boundBytes.push(bytes);
			} else if (roll < 0.14) both("bind", pick(["material.whole", `input.${keyIndex++}`, "runtime.items"]), pick([10, 127, 128, 5000]));
			else if (roll < 0.2) {
				const child = value(2), rows = Array.from({length: pick([0, 1, 3, 127, 128])}, () => child);
				both("bindArray", rows, `rows.${keyIndex++}`, rows.length, child); boundArrays.push(rows);
			} else if (roll < 0.24 && boundArrays.length > 0) {
				const original = pick(boundArrays), copied = original.slice(); both("copyFields", original, copied); boundArrays.push(copied);
			} else if (roll < 0.27 && boundBytes.length > 0) {
				const original = pick(boundBytes), copied = original.slice(); both("copyFields", original, copied); boundBytes.push(copied);
			} else if (roll < 0.6) {
				const outcome = both("measure", value(0));
				if (outcome.ok) widths.push(outcome.value as number);
			} else if (roll < 0.68 && widths.length > 1) {
				const outcome = both("sum", [pick(widths), pick(widths), pick([0, 1, 9])], "carrier");
				if (outcome.ok) widths.push(outcome.value as number);
			} else if (roll < 0.76 && widths.length > 1) {
				const outcome = both("maximum", [pick(widths), pick(widths), pick([1, 100])]);
				if (outcome.ok) widths.push(outcome.value as number);
			} else if (roll < 0.8 && widths.length > 0) both("dominate", pick(widths), `dominate.${keyIndex++}`, pick(widths) + pick([0, 7]));
			else if (roll < 0.83 && widths.length > 0) both("material", pick(widths));
			else if (roll < 0.87) both("runtimeShape", {items: pick([1, 40, 1000]), maxDepth: pick([0, 3, 9])}, value(1));
			else if (roll < 0.9 && widths.length > 0) both("native", pick(widths), pick([1, 786_432, 4_194_304]));
			else if (widths.length > 0) both("result", {unknownEncodedLengths: [pick(widths), pick(widths)],
				fullFutureProofEnvelopeByteLengths: [pick(widths)]});
		},
	};
}

describe("finishing width compiler equivalence with the 3d630ead compiler", () => {
	afterEach(() => observeCanonicalCalls(undefined));

	it("emits the same values, refusals and program for random call sequences over many field shapes", () => {
		let calls = 0;
		for (let seed = 1; seed <= 400; seed++) {
			const compilers = pair(), steps = generator(seed, compilers);
			for (let index = 0; index < 60; index++) steps.step();
			compilers.both("finish");
			calls += compilers.calls();
		}
		expect(calls).toBeGreaterThan(20_000);
	});

	it("agrees on every scalar leaf, including unicode, -0, floats and refused scalars", () => {
		const refused: unknown[] = ["\ud800", "a\udc00", Number.NaN, Number.POSITIVE_INFINITY, undefined, Symbol("s"), () => 1,
			"z".repeat(786_430), "z".repeat(786_431), new Float32Array(2), new Map()];
		for (const scalar of [...SCALARS, ...refused]) {
			const {both} = pair();
			both("measure", {scalar});
			both("measure", [scalar, scalar, {[String(scalar).slice(0, 8)]: scalar}]);
			both("finish");
		}
	});

	it("agrees on unbound BYTES across varuint boundaries and the closed-retirement byte limit", () => {
		const max = CLOSED_RETIREMENT_BYTES.maxBytes;
		const lengths = [0, 127, 128, 16_383, 16_384, max - 1 - 3, max - 3, max - 3 + 1, max];
		for (const length of lengths) {
			const {both} = pair();
			both("measure", new Uint8Array(length));
			both("measure", {payload: new Uint8Array(length)});
			both("finish");
		}
		// A Uint8Array view, a subclass and an own byteLength property encode as the encoder sees them.
		const {both} = pair();
		const backing = new Uint8Array(300);
		class Sub extends Uint8Array {}
		const shadowed = new Uint8Array(5);
		Object.defineProperty(shadowed, "byteLength", {value: 9000});
		for (const bytes of [backing.subarray(10, 140), new Sub(130), shadowed]) both("measure", {bytes});
		both("finish");
	});

	it("measures each distinct scalar once and never encodes a BYTES leaf to size it", () => {
		const digest = "ab".repeat(32), payload = new Uint8Array(4096);
		const row = (index: number) => ({kind: "v3-issuance-retirement-control-1", objectId: "room", digest, revision: index,
			author: `writer-${index % 4}`, bytes: payload});
		const value = Array.from({length: 256}, (_, index) => row(index));
		const compiler = createCreatorFinishingWidthCompiler();
		let encodes = 0;
		observeCanonicalCalls((kind) => { if (kind === "encode") encodes++; });
		compiler.measure(value);
		compiler.measure(value);
		observeCanonicalCalls(undefined);
		// Distinct scalars: the key strings kind/objectId/digest/revision/author/bytes, the values
		// "v3-issuance-retirement-control-1", "room", digest, writer-0..3, and the integer width.
		expect(encodes).toBeLessThanOrEqual(6 + 3 + 4 + 1);
	});
});
